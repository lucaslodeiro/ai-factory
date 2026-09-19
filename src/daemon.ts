import fs from "node:fs";
import { doctor } from "./doctor.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { Store } from "./storage.js";
import { Orchestrator } from "./orchestrator.js";
import { ExecutionManager } from "./execution-manager.js";
import { CodexAdapter } from "./adapters/codex.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { retry } from "./retry.js";
import { pausedMarkdown, cancelledMarkdown } from "./presentation.js";
import { daemonLog, type LogLevel } from "./logger.js";
export { retry } from "./retry.js";
export function acquireLock(store: Store) {
 fs.mkdirSync(config.dataDir, { recursive: true });
 const file = path.join(config.dataDir, "daemon.lock"), token = randomUUID();
 store.db.exec("CREATE TABLE IF NOT EXISTS daemon_lock(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,token TEXT NOT NULL)");
 store.db.transaction(() => {
  const row = store.db.prepare("SELECT pid FROM daemon_lock WHERE id=1").get() as { pid: number } | undefined;
  if (row) {
   let alive = true;
   try { process.kill(row.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
   if (alive) throw new Error(`Daemon already running (PID ${row.pid})`);
  }
  store.db.prepare("INSERT OR REPLACE INTO daemon_lock(id,pid,token) VALUES(1,?,?)").run(process.pid, token);
 }).immediate();
 try { fs.writeFileSync(file, String(process.pid)); }
 catch (e) { store.db.prepare("DELETE FROM daemon_lock WHERE token=?").run(token); throw e; }
 return () => {
  store.db.transaction(() => {
   if (store.db.prepare("SELECT id FROM daemon_lock WHERE token=?").get(token)) {
    fs.rmSync(file, { force: true }); store.db.prepare("DELETE FROM daemon_lock WHERE token=?").run(token);
   }
  }).immediate();
 };
}
export async function startDaemon(store = new Store()) {
 if (!config.repo || !config.approvers.length) throw new Error("Configure GITHUB_REPOSITORY and FACTORY_APPROVERS first");
 if (!doctor()) throw new Error("Preflight failed; fix doctor checks before starting");
 daemonLog("info","daemon.starting",{repo:config.repo,pollMs:config.pollMs,dataDir:config.dataDir});
 const release = acquireLock(store), executions = new ExecutionManager(store);
 const codex = new CodexAdapter(executions), claude = new ClaudeAdapter(executions);
 const adapters = { codex,claude };
 const o = new Orchestrator(store, {
  "product-architect":adapters[config.roles["product-architect"].provider],
  developer:adapters[config.roles.developer.provider],
  qa:adapters[config.roles.qa.provider],
  reviewer:adapters[config.roles.reviewer.provider],
 });
 let stopping = false,stopReason="unknown";
 const stop = (reason="control") => {
  if (stopping) return;
  stopping = true;
  stopReason=reason;
  daemonLog("info","daemon.stop_requested",{reason,activeItems:store.items().filter(w=>["SPEC","DEVELOPMENT","QA","REVIEW"].includes(w.state)).length});
  for (const w of store.items()) if (["SPEC", "DEVELOPMENT", "QA", "REVIEW"].includes(w.state)) {
   const active=Boolean(store.db.prepare("SELECT id FROM executions WHERE work_item_id=? AND status='running'").get(w.id));
   w.context.resume = w.state; store.transition(w, "PAUSED"); store.post(w.issue_number,pausedMarkdown(w,"The daemon received a stop request",active));
  }
  executions.cancelAll();
 };
 let auditCursor=(store.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM events").get() as {id:number}).id;
 const audit = () => {
  const rows=store.db.prepare("SELECT id,ts,work_item_id,run_id,type,payload FROM events WHERE id>? ORDER BY id").all(auditCursor) as Array<{id:number;ts:string;work_item_id:string|null;run_id:string|null;type:string;payload:string}>;
  for (const row of rows) {
   auditCursor=row.id;
   let data: Record<string,unknown>={}; try { data=JSON.parse(row.payload); } catch {}
   let level:LogLevel="info",fields:Record<string,string|number|boolean|null|undefined>={workItemId:row.work_item_id,runId:row.run_id};
   if (row.type === "state.changed") fields={...fields,from:String(data.from),to:String(data.to)};
   else if (row.type === "execution.started") { const selected=(data.selection ?? {}) as Record<string,unknown>; fields={...fields,role:String(data.role),provider:selected.provider ? String(selected.provider) : undefined,model:selected.model ? String(selected.model) : undefined}; }
   else if (row.type === "execution.finished") { const status=String(data.status); level=status === "succeeded" ? "info" : "warn"; fields={...fields,status,exitCode:typeof data.code === "number" ? data.code : null}; }
   else if (row.type === "agent.result") { const result=(data.result ?? {}) as Record<string,unknown>; fields={...fields,role:String(data.role),outcome:result.outcome ? String(result.outcome) : undefined}; }
   else if (row.type === "control.applied") fields={...fields,controlId:Number(data.id),kind:String(data.kind),target:data.target ? String(data.target) : undefined};
   else if (row.type === "control.failed") { level="warn"; fields={...fields,controlId:Number(data.id),kind:String(data.kind),error:String(data.error)}; }
   else if (row.type === "workflow.error") { level="error"; fields={...fields,error:String(data.error)}; }
   else if (row.type.endsWith("_failed") || row.type.endsWith(".failed")) { level="warn"; fields={...fields,error:data.error ? String(data.error) : undefined}; }
   else if (!["work_item.created","retry.comment_accepted","spec.approved","pull_request.reconciled","execution.interrupted","stage.interrupted"].includes(row.type)) continue;
   daemonLog(level,row.type.replaceAll(".","_"),fields,row.ts);
  }
 };
 const controls = () => {
  const rows = store.db.prepare("SELECT * FROM controls WHERE handled=0 ORDER BY id").all() as { id: number; kind: string; target: string }[];
  for (const r of rows) {
   try {
    let result: unknown;
    if (r.kind === "stop") stop();
    else if (r.kind === "retry") retry(store, r.target);
    else if (r.kind === "start-issue") result = o.startIssue(r.target);
    else if (r.kind === "refresh-list") result = o.refreshIssueList();
    else if (r.kind === "cancel") {
     const run = store.db.prepare("SELECT id,work_item_id FROM executions WHERE (id=? OR work_item_id=?) AND status='running'").get(r.target, r.target) as { id: string; work_item_id: string } | undefined;
     const w = store.get(run?.work_item_id ?? r.target);
     if (!w) throw new Error("Unknown work item or run");
     if (w.state !== "CANCELLED") { w.context.resume = w.state; store.transition(w, "CANCELLED"); store.post(w.issue_number,cancelledMarkdown(w,Boolean(run))); }
     if (run) executions.cancel(run.id);
    } else throw new Error(`Unknown control: ${r.kind}`);
    store.event("control.applied",{id:r.id,kind:r.kind,target:r.target,result});
   } catch (e) { store.event("control.failed",{id:r.id,kind:r.kind,target:r.target,error:String(e)}); }
   store.db.prepare("UPDATE controls SET handled=1 WHERE id=?").run(r.id);
  }
  audit();
 };
 const sigint=()=>stop("SIGINT"),sigterm=()=>stop("SIGTERM");
 process.on("SIGINT",sigint); process.on("SIGTERM",sigterm);
 let timer: NodeJS.Timeout | undefined;
 try {
  const recovered=executions.recover(); store.repairCommentCursors(); audit(); controls(); timer = setInterval(controls, 200);
  daemonLog("info","daemon.ready",{items:store.items().length,recoveredExecutions:recovered});
  while (!stopping) {
   try { await o.tick(); audit(); } catch (e) { daemonLog("error","daemon.tick_failed",{error:String(e)}); }
   const until = Date.now() + config.pollMs;
   while (!stopping && Date.now() < until) await new Promise(r => setTimeout(r, 100));
  }
 } finally {
  if (timer) clearInterval(timer); process.off("SIGINT",sigint); process.off("SIGTERM",sigterm);
  try { await o.flush(); audit(); } catch (e) { daemonLog("error","daemon.final_sync_failed",{error:String(e)}); }
  release();
  daemonLog("info","daemon.stopped",{reason:stopReason});
 }
}

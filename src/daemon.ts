import fs from "node:fs";
import { doctor } from "./doctor.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { Store } from "./storage.js";
import { Orchestrator } from "./orchestrator.js";
import { ExecutionManager, assertRetrySafe } from "./execution-manager.js";
import { CodexAdapter } from "./adapters/codex.js";
import { ClaudeAdapter } from "./adapters/claude.js";
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
export function retry(store: Store, id: string) {
 const w = store.get(id); if (!w) throw new Error("Unknown work item");
 if (!["FAILED", "CANCELLED", "PAUSED"].includes(w.state)) throw new Error("Only failed, cancelled or paused items can retry");
 assertRetrySafe(store, id);
 const to = w.context.resume ?? "SPEC";
 store.transition(w, to); store.event("retry.requested", { to }, id);
}
export async function startDaemon(store = new Store()) {
 if (!config.repo || !config.approvers.length) throw new Error("Configure GITHUB_REPOSITORY and FACTORY_APPROVERS first");
 if (!doctor()) throw new Error("Preflight failed; fix doctor checks before starting");
 const release = acquireLock(store), executions = new ExecutionManager(store);
 const codex = new CodexAdapter(executions), claude = new ClaudeAdapter(executions);
 const o = new Orchestrator(store, { "product-architect": claude, developer: codex, qa: codex, reviewer: claude });
 let stopping = false;
 const stop = () => {
  stopping = true;
  for (const w of store.items()) if (["SPEC", "DEVELOPMENT", "QA", "REVIEW"].includes(w.state)) {
   w.context.resume = w.state; store.transition(w, "PAUSED");
  }
  executions.cancelAll();
 };
 const controls = () => {
  const rows = store.db.prepare("SELECT * FROM controls WHERE handled=0 ORDER BY id").all() as { id: number; kind: string; target: string }[];
  for (const r of rows) {
   try {
    if (r.kind === "stop") stop();
    else if (r.kind === "retry") retry(store, r.target);
    else if (r.kind === "cancel") {
     const run = store.db.prepare("SELECT id,work_item_id FROM executions WHERE (id=? OR work_item_id=?) AND status='running'").get(r.target, r.target) as { id: string; work_item_id: string } | undefined;
     const w = store.get(run?.work_item_id ?? r.target);
     if (!w) throw new Error("Unknown work item or run");
     if (w.state !== "CANCELLED") { w.context.resume = w.state; store.transition(w, "CANCELLED"); }
     if (run) executions.cancel(run.id);
    }
    store.event("control.applied", r);
   } catch (e) { store.event("control.failed", { ...r, error: String(e) }); }
   store.db.prepare("UPDATE controls SET handled=1 WHERE id=?").run(r.id);
  }
 };
 process.on("SIGINT", stop); process.on("SIGTERM", stop);
 let timer: NodeJS.Timeout | undefined;
 try {
  executions.recover(); controls(); timer = setInterval(controls, 200);
  console.log("AI Factory running; Ctrl-C or factory stop to pause.");
  while (!stopping) {
   try { await o.tick(); } catch (e) { console.error(e); }
   const until = Date.now() + config.pollMs;
   while (!stopping && Date.now() < until) await new Promise(r => setTimeout(r, 100));
  }
 } finally {
  if (timer) clearInterval(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); release();
 }
}

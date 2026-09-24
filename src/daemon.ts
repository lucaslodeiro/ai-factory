import {backgroundGitHub} from "./github-runtime.js";
import {applyWorkControl} from "./workflow-controls.js";
import {reconcileUpdateMaintenanceFile} from "./update-maintenance.js";
import {factoryHome} from "./home.js";
import fs from "node:fs";
import {StartupError} from "./startup-error.js";
import {prepareRepository} from "./repository-setup.js";
import { doctor } from "./doctor.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { Store } from "./storage.js";
import { ExecutionManager,streamFacts } from "./execution-manager.js";
import { reapStrayProcesses } from "./process-reaper.js";
import type { ModelSelection } from "./types.js";
import { CodexAdapter } from "./adapters/codex.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CursorAdapter } from "./adapters/cursor.js";
import { daemonLog, type LogLevel } from "./logger.js";
import { roleShortName } from "./names.js";
import { GitHubAdapter } from "./adapters/github.js";
import { SlackAdapter } from "./adapters/slack.js";
import { Workspaces } from "./worktrees.js";
import { WorkflowRunner } from "./workflow-runner.js";
import { WorkflowOrchestrator } from "./workflow-orchestrator.js";
import { WorkflowCommands } from "./workflow-commands.js";
import { WorkflowMaintenance } from "./workflow-maintenance.js";
import { WorkflowScheduler } from "./workflow-scheduler.js";
import {applyInterruptRetryControl,applyMessageControl} from "./workflow-chat.js";
import {verifyRepositoryIdentity} from "./repository-identity.js";
import {LocalRuntimeManager} from "./local-runtime.js";
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
export function recoverAbandonedExecutions(store:Store){const scheduler=new WorkflowScheduler(store),abandoned=store.db.prepare("SELECT id,work_item_id FROM executions WHERE status='running'").all() as Array<{id:string;work_item_id:string}>;for(const run of abandoned){
  // The run's own stream still says which provider session it was in and what it had reported, so
  // the next run can continue that session and the budget counts what was spent.
  const started=store.db.prepare("SELECT payload FROM events WHERE run_id=? AND type='execution.started' ORDER BY id LIMIT 1").get(run.id) as {payload:string}|undefined;
  const start=started?JSON.parse(started.payload) as {selection?:{provider?:ModelSelection["provider"]};resumedSession?:string}:{};
  const facts=streamFacts(store,path.join(config.dataDir,"runs",run.id,"stdout.log"),start.selection?.provider,start.resumedSession);
  store.db.prepare("UPDATE executions SET status='interrupted',recovery_pending=1,finished_at=?,interruption_reason='unexpected-shutdown',total_tokens=coalesce(total_tokens,?) WHERE id=?").run(new Date().toISOString(),facts.usage?.totalTokens??null,run.id);
  store.event("execution.finished",{status:"interrupted",usage:facts.usage?{...facts.usage,partial:true}:null,sessionUsage:facts.sessionUsage,interruptionReason:"unexpected-shutdown",sessionId:facts.sessionId,recovered:true},run.work_item_id,run.id);scheduler.fail(run.work_item_id,run.id,new Error("Agent execution was interrupted by an unexpected daemon shutdown"),"recovery");store.event("execution.interrupted",{reason:"unexpected-shutdown"},run.work_item_id,run.id);}return abandoned.length;}
export async function startDaemon(store = new Store(),github=new GitHubAdapter()) {
 try {
  if (!config.repoDir) throw new Error("FACTORY_REPO_DIR is required");
  if (!config.repo || !config.approvers.length) throw new Error("Configure GITHUB_REPOSITORY and FACTORY_APPROVERS first");
  const factoryLogin=github.authenticatedLogin();if(!factoryLogin)throw new Error("GitHub authentication did not return an account login");store.setMetadata("runtime:factory-account",factoryLogin);
  verifyRepositoryIdentity(store,github);
  prepareRepository(config);
  if (!doctor(store,github)) throw new Error("Preflight failed; fix doctor checks before starting");
 } catch(error) {throw new StartupError(error instanceof Error?error.message:String(error));}
 daemonLog("info","daemon.starting",{repo:config.repo,pollMs:config.pollMs,dataDir:config.dataDir});
 const release = acquireLock(store), executions = new ExecutionManager(store);
 const codex = new CodexAdapter(executions), claude = new ClaudeAdapter(executions), cursor = new CursorAdapter(executions);
 const adapters = { codex,claude,cursor };
 const agents = {
  "product-architect":adapters[config.roles["product-architect"].provider],
  designer:adapters[config.roles.designer.provider],
  developer:adapters[config.roles.developer.provider],
  qa:adapters[config.roles.qa.provider],
  reviewer:adapters[config.roles.reviewer.provider],
 };
 const remote=backgroundGitHub(),localRuntime=new LocalRuntimeManager();
 const runner=new WorkflowRunner(store,agents,new Workspaces(),remote.github,localRuntime),o=new WorkflowOrchestrator(store,remote.github,runner,new SlackAdapter(),executions);
 const commands=new WorkflowCommands(store),maintenance=new WorkflowMaintenance(store,executions);
 const recoveredSignalMaintenance=maintenance.reconcileSignalsAfterRestart();
 let stopping = false,stopRequested=false,stopReason="unknown",stopPromise:Promise<unknown>|undefined;
 const stop = async (reason="control") => {
  if (stopping||stopRequested) return;
  stopRequested=true;
  stopReason=reason;
  daemonLog("info","daemon.stop_requested",{reason,activeItems:maintenance.affected().length});
  stopPromise=maintenance.pauseForSignal(reason).then(()=>{stopping=true;}).catch(error=>{stopRequested=false;daemonLog("error","maintenance_signal_failed",{reason,error:String(error)});throw error;});
  return stopPromise;
 };
 let auditCursor=(store.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM events").get() as {id:number}).id;
 const audit = () => {
  const rows=store.db.prepare("SELECT id,ts,work_item_id,run_id,type,payload FROM events WHERE id>? ORDER BY id").all(auditCursor) as Array<{id:number;ts:string;work_item_id:string|null;run_id:string|null;type:string;payload:string}>;
  for (const row of rows) {
   auditCursor=row.id;
   let data: Record<string,unknown>={}; try { data=JSON.parse(row.payload); } catch {}
   let level:LogLevel="info",fields:Record<string,string|number|boolean|null|undefined>={workItemId:row.work_item_id,runId:row.run_id};
   if (row.type === "workflow.transition") {const from=(data.from??{}) as Record<string,unknown>,to=(data.to??{}) as Record<string,unknown>;fields={...fields,from:`${from.stage}/${from.status}`,to:`${to.stage}/${to.status}`,revision:typeof to.revision==="number"?to.revision:undefined};}
   else if (row.type === "execution.started") { const selected=(data.selection ?? {}) as Record<string,unknown>; fields={...fields,role:roleShortName(String(data.role)),provider:selected.provider ? String(selected.provider) : undefined,model:selected.model ? String(selected.model) : undefined}; }
   else if (row.type === "execution.finished") { const status=String(data.status),usage=(data.usage ?? {}) as Record<string,unknown>; level=status === "succeeded" ? "info" : "warn"; fields={...fields,status,exitCode:typeof data.code === "number" ? data.code : null,totalTokens:typeof usage.totalTokens === "number" ? usage.totalTokens : undefined}; }
   else if (row.type === "agent.result") { const result=(data.result ?? {}) as Record<string,unknown>; fields={...fields,role:roleShortName(String(data.role)),outcome:result.outcome ? String(result.outcome) : undefined}; }
   else if (row.type === "control.applied") fields={...fields,controlId:Number(data.id),kind:String(data.kind),target:data.target ? String(data.target) : undefined};
   else if (row.type === "control.failed") { level="warn"; fields={...fields,controlId:Number(data.id),kind:String(data.kind),error:String(data.error)}; }
   else if (row.type === "workflow.error") { level="error"; fields={...fields,error:String(data.error)}; }
   else if (row.type.endsWith("_failed") || row.type.endsWith(".failed")) { level="warn"; fields={...fields,error:data.error ? String(data.error) : undefined}; }
   else if (!["work_item.created","retry.comment_accepted","spec.approved","pull_request.reconciled","execution.interrupted","stage.interrupted"].includes(row.type)) continue;
   daemonLog(level,row.type.replaceAll(".","_"),fields,row.ts);
  }
 };
 const remoteControlIds=new Set<number>();
 let controlsBusy=false;
 const controls = async () => {
  if(controlsBusy)return;controlsBusy=true;
  try {
  reconcileUpdateMaintenanceFile(store,path.join(factoryHome(),"data","update-state.json"));
  const rows = store.db.prepare("SELECT * FROM controls WHERE handled=0 ORDER BY id").all() as { id: number; kind: string; target: string }[];
  for (const r of rows) {
   if(remoteControlIds.has(r.id)||["start-issue","claim-issue","continue-issue","refresh-list"].includes(r.kind))continue;
   try {
    let result: unknown;
    if (r.kind === "stop") result=await stop();
    else if(r.kind==="maintenance-confirm")result=await maintenance.confirm(r.target);
    else if (["pause","resume","retry","cancel"].includes(r.kind)) result=applyWorkControl(store,commands,executions,r);
    else if(r.kind==="message") {const login=store.metadata<string>("runtime:factory-account");if(!login||!config.approvers.includes(login))throw new Error("The authenticated GitHub operator is not an authorized approver");const action=(JSON.parse(r.target) as {action?:string}).action;result=action==="interrupt-retry"?await applyInterruptRetryControl(store,remote.github,executions,runner,r,login):await applyMessageControl(store,remote.github,r,login);}
    else if(r.kind==="maintenance-resume")result=maintenance.resume(r.target);
    else throw new Error(`Unknown control: ${r.kind}`);
    store.event("control.applied",{id:r.id,kind:r.kind,target:r.target,result});
   } catch (e) { store.event("control.failed",{id:r.id,kind:r.kind,target:r.target,error:String(e)}); }
   store.db.prepare("UPDATE controls SET handled=1 WHERE id=?").run(r.id);
  }
  audit();
  } finally {controlsBusy=false;}
 };
 const sigint=()=>void stop("SIGINT").catch(()=>{}),sigterm=()=>void stop("SIGTERM").catch(()=>{});
 process.on("SIGINT",sigint); process.on("SIGTERM",sigterm);
 let timer: NodeJS.Timeout | undefined;
 try {
  const recovered=recoverAbandonedExecutions(store);
  // Servers a previous daemon or its agents left running in the worktrees; nothing is running now.
  const reaped=await reapStrayProcesses();
  store.setMetadata("runtime:local-work",null);
  audit(); await controls(); timer = setInterval(()=>void controls(), 200);
  daemonLog("info","daemon.ready",{items:(store.db.prepare("SELECT COUNT(*) count FROM work_items WHERE archived_at IS NULL").get() as {count:number}).count,recoveredExecutions:recovered,reapedProcesses:reaped.length,recoveredSignalMaintenance});
  let localTask:Promise<void>|undefined,remoteTask:Promise<void>|undefined,nextRemote=0;
  // nextAt is written when a cycle ends; local work that finishes earlier can pull the next cycle forward, never push it back.
  const mark=(state:string,error?:string)=>store.setMetadata("runtime:github-sync",{state,at:new Date().toISOString(),...(error?{error}:{} )});
  while(!stopping){
   await localRuntime.reconcile(new Set((store.db.prepare("SELECT id FROM work_items WHERE archived_at IS NULL AND status NOT IN ('COMPLETED','CANCELLED')").all() as Array<{id:string}>).map(row=>row.id)));
   if(!stopRequested){
    if(!localTask)localTask=o.runLocal().then(worked=>{if(worked)nextRemote=0;}).catch(error=>daemonLog("error","daemon.local_failed",{error:String(error)})).finally(()=>{audit();localTask=undefined;});
    if(!remoteTask&&(Date.now()>=nextRemote||store.db.prepare("SELECT 1 FROM controls WHERE handled=0 AND kind IN ('start-issue','claim-issue','continue-issue','refresh-list') LIMIT 1").get())){mark("syncing");remoteTask=(async()=>{
      for(const r of store.db.prepare("SELECT id,kind,target FROM controls WHERE handled=0 AND kind IN ('start-issue','claim-issue','continue-issue','refresh-list') ORDER BY id").all() as Array<{id:number;kind:string;target:string}>){if((store.db.prepare("SELECT handled FROM controls WHERE id=?").get(r.id) as {handled:number}).handled)continue;remoteControlIds.add(r.id);try{const result=r.kind==='start-issue'?await o.startIssue(r.target):r.kind==='claim-issue'?await o.claimIssue(r.target):r.kind==='continue-issue'?await o.continueIssue(r.target):await o.refreshIssueList();store.event('control.applied',{id:r.id,kind:r.kind,target:r.target,result});}catch(error){store.event('control.failed',{id:r.id,kind:r.kind,error:String(error)});}store.db.prepare('UPDATE controls SET handled=1 WHERE id=?').run(r.id);remoteControlIds.delete(r.id);}
      await o.syncRemote();
     })().then(()=>mark("idle")).catch(error=>{mark("failed",String(error));daemonLog("error","daemon.sync_failed",{error:String(error)});}).finally(()=>{audit();nextRemote=Date.now()+config.pollMs;const sync=store.metadata<Record<string,unknown>>("runtime:github-sync")??{};store.setMetadata("runtime:github-sync",{...sync,nextAt:new Date(nextRemote).toISOString()});remoteTask=undefined;});}
   }
   await new Promise(resolve=>setTimeout(resolve,200));
  }
  await localTask;
  // Stop the external lane before final synchronization; never leave an orphan worker.
  await remoteTask;

 } finally {
  if (timer) clearInterval(timer); process.off("SIGINT",sigint); process.off("SIGTERM",sigterm);if(stopPromise)await stopPromise;
  try { await o.flush(); audit(); } catch (e) { daemonLog("error","daemon.final_sync_failed",{error:String(e)}); }
  await localRuntime.close();
  await remote.close();
  release();
  daemonLog("info","daemon.stopped",{reason:stopReason});
 }
}

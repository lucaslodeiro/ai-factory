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
import { ExecutionManager } from "./execution-manager.js";
import { CodexAdapter } from "./adapters/codex.js";
import { ClaudeAdapter } from "./adapters/claude.js";
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
import {verifyRepositoryIdentity} from "./repository-identity.js";
import {ControllerLease,CONTROLLER_HEARTBEAT_MS,type LeaseObservation} from "./controller-lease.js";
import {applyControllerLoss,type ControllerFence} from "./controller-fence.js";
import {controllerMayMutate,controllerModeAfterVerificationFailure,type ControllerMode} from "./controller-runtime.js";
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
export function recoverAbandonedExecutions(store:Store){const scheduler=new WorkflowScheduler(store),abandoned=store.db.prepare("SELECT id,work_item_id FROM executions WHERE status='running'").all() as Array<{id:string;work_item_id:string}>;for(const run of abandoned){store.db.prepare("UPDATE executions SET status='interrupted',recovery_pending=1,finished_at=?,interruption_reason='unexpected-shutdown' WHERE id=?").run(new Date().toISOString(),run.id);scheduler.fail(run.work_item_id,run.id,new Error("Agent execution was interrupted by an unexpected daemon shutdown"),"recovery");store.event("execution.interrupted",{reason:"unexpected-shutdown"},run.work_item_id,run.id);}return abandoned.length;}
export async function runControllerCycle(controller:LeaseObservation,orchestrator:Pick<WorkflowOrchestrator,"tick">){if(controller.state!=="active")return false;await orchestrator.tick();return true;}
export async function startDaemon(store = new Store(),github=new GitHubAdapter(),options:{controller?:ControllerLease}={}) {
 let repository:ReturnType<GitHubAdapter["repository"]>;
 try {
  if (!config.repo || !config.approvers.length) throw new Error("Configure GITHUB_REPOSITORY and FACTORY_APPROVERS first");
  repository=verifyRepositoryIdentity(store,github);
  prepareRepository(config);
  if (!doctor(store,github)) throw new Error("Preflight failed; fix doctor checks before starting");
 } catch(error) {throw new StartupError(error instanceof Error?error.message:String(error));}
 const controller=options.controller??new ControllerLease(repository,store),initialController=controller.acquire();
 let controllerState:LeaseObservation=initialController,controllerMode:ControllerMode=initialController.state==="active"?"active":"standby",lastControllerSuccess=performance.now(),generation=initialController.state==="absent"?0:initialController.record.generation;
 const fence:ControllerFence={assertController(){if(!controllerMayMutate(controllerMode))throw new Error(`Repository controller is ${controllerMode}`);controllerState=controller.assertController(generation);},resultDisposition(){return controllerMode==="uncertain"?"hold":controllerMode==="fenced"||controllerMode==="standby"?"discard":"apply";}};
 daemonLog("info","daemon.starting",{repo:config.repo,pollMs:config.pollMs,dataDir:config.dataDir});
 const release = acquireLock(store), executions = new ExecutionManager(store);
 const codex = new CodexAdapter(executions), claude = new ClaudeAdapter(executions);
 const adapters = { codex,claude };
 const agents = {
  "product-architect":adapters[config.roles["product-architect"].provider],
  developer:adapters[config.roles.developer.provider],
  qa:adapters[config.roles.qa.provider],
  reviewer:adapters[config.roles.reviewer.provider],
 };
 const runner=new WorkflowRunner(store,agents,new Workspaces(),github,fence),o=new WorkflowOrchestrator(store,github,runner,new SlackAdapter(),executions,fence);
 const commands=new WorkflowCommands(store,fence),maintenance=new WorkflowMaintenance(store,executions);
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
 let controlsBusy=false;
 const controls = async () => {
  if(controlsBusy)return;controlsBusy=true;
  try {
  reconcileUpdateMaintenanceFile(store,path.join(factoryHome(),"data","update-state.json"));
  const rows = store.db.prepare("SELECT * FROM controls WHERE handled=0 ORDER BY id").all() as { id: number; kind: string; target: string }[];
  for (const r of rows) {
   try {
    let result: unknown;
    if (r.kind === "stop") result=await stop();
    else if(controllerState.state!=="active")throw new Error("This installation is in controller standby; workflow controls are read-only");
    else if (["pause","resume","retry","cancel"].includes(r.kind)) result=applyWorkControl(store,commands,executions,r);
    else if (r.kind === "start-issue") result = o.startIssue(r.target);
    else if (r.kind === "refresh-list") result = o.refreshIssueList();
    else if(r.kind==="maintenance-confirm")result=await maintenance.confirm(r.target);
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
 let timer: NodeJS.Timeout | undefined,controllerTimer:NodeJS.Timeout|undefined;
 try {
  const recovered=controllerState.state==="active"?recoverAbandonedExecutions(store):0;
  const loseController=()=>{if(controllerMode==="standby"||controllerMode==="fenced")return;controllerMode="fenced";controller.markLocalState("fenced","Ownership changed");applyControllerLoss(store,executions,runner,generation);controllerMode="standby";controller.markLocalState("standby");};
  let renewalBusy=false;const renewController=()=>{if(renewalBusy)return;renewalBusy=true;try{if(controllerMode==="active"||controllerMode==="uncertain"){const verified=controller.assertController(generation);controllerState=controller.renew(verified);lastControllerSuccess=performance.now();if(controllerMode==="uncertain"){controllerMode="active";runner.applyHeld();store.event("controller.renewed",{generation});store.event("controller.ownership_restored",{generation});}}else{controllerState=controller.readLease();if(controllerState.state==="active"){generation=controllerState.record.generation;controllerMode="active";lastControllerSuccess=performance.now();store.event("controller.acquired",{repository:repository.fullName,displayName:controller.instance.displayName,generation});}}}catch{try{const observed=controller.readLease();if(observed.state==="absent"||observed.record.instanceId!==controller.instance.instanceId||observed.record.generation!==generation){loseController();return;}}catch{}const nextMode=controllerModeAfterVerificationFailure(controllerMode,lastControllerSuccess,performance.now());if(nextMode==="uncertain"&&controllerMode!=="uncertain"){controllerMode=nextMode;controller.markLocalState("uncertain","Renewal could not be verified");store.event("controller.ownership_uncertain",{generation});}}finally{renewalBusy=false;}};
  audit(); await controls(); timer = setInterval(()=>void controls(), 200);controllerTimer=setInterval(renewController,CONTROLLER_HEARTBEAT_MS);
  daemonLog("info","daemon.ready",{items:(store.db.prepare("SELECT COUNT(*) count FROM work_items WHERE archived_at IS NULL").get() as {count:number}).count,recoveredExecutions:recovered,recoveredSignalMaintenance,controller:controllerState.state});
  while (!stopping) {
   try {if(controllerMode==="active"&&await runControllerCycle(controllerState,o))audit();} catch (e) { daemonLog("error","daemon.tick_failed",{error:String(e)}); }
   const until = Date.now() + config.pollMs;
   while (!stopping && Date.now() < until) await new Promise(r => setTimeout(r, 100));
  }
 } finally {
  if (timer) clearInterval(timer);if(controllerTimer)clearInterval(controllerTimer); process.off("SIGINT",sigint); process.off("SIGTERM",sigterm);if(stopPromise)await stopPromise;
  if(controllerState.state==="active")try { await o.flush(); audit(); } catch (e) { daemonLog("error","daemon.final_sync_failed",{error:String(e)}); }
  release();
  daemonLog("info","daemon.stopped",{reason:stopReason});
 }
}

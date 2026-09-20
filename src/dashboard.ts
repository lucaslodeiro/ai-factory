import {reconcileUpdateMaintenance} from "./update-maintenance.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { Store } from "./storage.js";
import { readDashboardSetting, readDashboardSettings, saveDashboardSettings, validateDashboardSettings } from "./dashboard-settings.js";
import { factoryHome } from "./home.js";
import { connectCredential, credentialStatuses, type CredentialProvider } from "./dashboard-credentials.js";
import { SlackAdapter } from "./adapters/slack.js";
import { publicNaming, roleShortName, stateName } from "./names.js";
import {WorkflowMaintenance,type MaintenanceOperation} from "./workflow-maintenance.js";
import type {ExecutionManager} from "./execution-manager.js";
import {RepositoryMaintenance} from "./repository-maintenance.js";
import {GitHubAdapter} from "./adapters/github.js";
import {verifyRepositoryIdentity} from "./repository-identity.js";
import {cachedControllerState,ControllerLease} from "./controller-lease.js";
import {publishTakeoverNotices} from "./workflow-github.js";

const assets = fileURLToPath(new URL("../dashboard/", import.meta.url));
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function daemonState(store: Store) {
  const lockTable = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='daemon_lock'").get();
  const lock = lockTable ? store.db.prepare("SELECT pid FROM daemon_lock WHERE id=1").get() as { pid: number } | undefined : undefined;
  return { running:Boolean(lock && alive(lock.pid)), pid:lock?.pid ?? null };
}
function maintenanceCoordinator(store:Store){const executionView={isRunning:(id:string)=>Boolean(store.db.prepare("SELECT 1 FROM executions WHERE id=? AND status='running'").get(id))} as ExecutionManager;return new WorkflowMaintenance(store,executionView);}
function maintenanceOperation(store:Store,id:string){const operation=store.db.prepare("SELECT id,operation,actor,status,requested_at,confirmed_at,finished_at,error FROM maintenance_operations WHERE id=?").get(id) as any;if(!operation)throw new Error("Unknown maintenance operation");const affected=store.db.prepare(`SELECT mi.work_item_id,mi.confirmed_revision,mi.paused_at,mi.resumed_at,w.issue_number,w.stage,w.status,w.context FROM maintenance_items mi JOIN work_items w ON w.id=mi.work_item_id WHERE mi.maintenance_id=? ORDER BY w.issue_number`).all(id) as any[];return{...operation,affected:affected.map(item=>{let context:any={};try{context=JSON.parse(item.context||"{}");}catch{}return{...item,title:context.title??`Issue #${item.issue_number}`};})};}
function requireMaintenance(store:Store,id:string|undefined,operations:string[]){const active=(store.db.prepare("SELECT COUNT(*) count FROM work_items WHERE archived_at IS NULL AND status IN ('QUEUED','RUNNING')").get() as {count:number}).count;if(!active&&!id)return;if(!id)throw Object.assign(new Error(`${active} active task${active===1?"":"s"} must be paused before this operation.`),{maintenanceRequired:true});const operation=maintenanceOperation(store,id);if(!operations.includes(operation.operation)||operation.status!=="ready")throw new Error("Maintenance confirmation is missing, expired, or not ready");}
function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function details(payload: string) {
  try {
    const value = JSON.parse(payload);
    if (!value || typeof value !== "object") return String(value ?? "");
    const parts: string[] = [];
    for (const [key,item] of Object.entries(value)) {
      if (item === null || item === undefined || item === "") continue;
      if (key === "result" && typeof item === "object") {
        const result = item as { outcome?: string; summary?: string };
        if (result.outcome) parts.push(`outcome: ${result.outcome}`);
        if (result.summary) parts.push(result.summary);
      } else if (Array.isArray(item)) parts.push(`${key}: ${item.length} item${item.length === 1 ? "" : "s"}`);
      else if (typeof item === "object") {
        const summary = Object.entries(item).filter(([,nested]) => ["string","number","boolean"].includes(typeof nested)).slice(0,3).map(([nestedKey,nested]) => `${nestedKey}: ${nested}`).join(", ");
        parts.push(`${key}: ${summary || "details recorded"}`);
      } else parts.push(`${key}: ${String(item)}`);
    }
    const text = parts.join(" · ");
    return text.length > 420 ? `${text.slice(0,417)}…` : text;
  } catch { return payload; }
}
const roleLabel = (role?: string) => role ? roleShortName(role) : "Agent";
const stateLabel = (state?: string) => state ? stateName(state) : "unknown state";
function eventPresentation(type: string, payload: string, runRole?: string) {
  try {
    const value = JSON.parse(payload) as any;
    const role=roleLabel(value.role ?? runRole);
    if(type==="workflow.transition"){const from=value.from,to=value.to;return{title:`Workflow moved to ${stateLabel(to?.stage)} · ${stateLabel(to?.status)}`,details:from?`Previous: ${stateLabel(from.stage)} · ${stateLabel(from.status)}. ${value.reason?.summary??""}`:`${value.reason?.summary??"Work started"}.`,severity:to?.status==="FAILED"?"error":["WAITING","PAUSED","CANCELLED"].includes(to?.status)?"warning":["COMPLETED"].includes(to?.status)?"success":"info",category:"Workflow"};}
    if (type === "execution.started") {
      const selection=value.selection;
      return { title:`${role} execution started`,details:selection ? `${selection.model} · ${selection.profile} profile` : "The agent process is running.",severity:"info",category:"Agent",brand:selection?.provider };
    }
    if (type === "execution.finished") { const result=value.code === null || value.code === undefined ? "The process finished without an exit code." : `Process exit code: ${value.code}.`;const usage=value.usage?.totalTokens === null || value.usage?.totalTokens === undefined ? " Token usage was not reported." : ` Tokens reported: ${Number(value.usage.totalTokens).toLocaleString("en-US")}.`;return { title:`${role} execution ${value.status ?? "finished"}`,details:result+usage,severity:value.status === "succeeded" ? "success" : value.status === "cancelled" ? "warning" : "error",category:"Agent" };}
    if (type === "execution.interrupted") return { title:`${role} execution interrupted`,details:value.reason ?? "The daemon stopped before this stage was recorded as complete.",severity:"error",category:"Agent" };
    if (type === "agent.result") {
      const result=value.result ?? {},coverage=Array.isArray(result.coverage) ? result.coverage : [];
      const passed=coverage.filter((item:any)=>item.status === "passed").length;
      const evidence=coverage.length ? ` Acceptance criteria: ${passed}/${coverage.length} passed.` : "";
      const outcome=({pass:"Passed",spec:"Specification ready",resolved:"Resolved",changes:"Changes requested",questions:"Input required",decision:"Decision required"} as Record<string,string>)[result.outcome] ?? "Completed";
      return { title:`${role}: ${outcome}`,details:`${result.summary ?? "Agent result recorded."}${evidence}`,severity:["pass","spec","resolved"].includes(result.outcome) ? "success" : ["changes","questions","decision"].includes(result.outcome) ? "warning" : "info",category:"Result" };
    }
    if (type === "model.selected") return { title:`Model selected for ${role}`,details:`${value.selection?.model ?? "Automatic model"}${value.selection?.reason ? ` — ${value.selection.reason}` : ""}`,severity:"info",category:"Routing",brand:value.selection?.provider };
    if (type === "start.command_rejected") return { title:"Factory start command rejected",details:`Issue #${value.issueNumber ?? "?"}: ${value.reason ?? "The command was not authorized"}.`,severity:"warning",category:"Issue" };
    if (type === "github.issue_list_refreshed") return { title:"Issue list refreshed",details:`Found ${value.found ?? 0}; added ${value.added ?? 0}; updated ${value.updated ?? 0}.`,severity:"success",category:"GitHub" };
    if (["github.issue_state_failed","github.projection_failed","github.pr_poll_failed"].includes(type)) return { title:"GitHub synchronization failed",details:value.error ?? "The operation will be retried.",severity:"error",category:"GitHub" };
    if (type === "slack.delivery_failed") return { title:"Slack notification delayed",details:"Delivery failed and was scheduled for another attempt.",severity:"warning",category:"Notification",brand:"slack" };
    if(type.startsWith("maintenance.")){const action=type.split(".")[1],titles:Record<string,string>={requested:"Maintenance requested",confirmed:"Maintenance confirmed",task_paused:"Task paused for maintenance",ready:"Tasks safely paused",started:"Maintenance started",completed:"Maintenance completed",failed:"Maintenance failed",tasks_resumed:"Paused tasks resumed"};return{title:titles[action]??"Maintenance update",details:value.error??`${value.operation??"Service operation"}${value.affected?.length!==undefined?` · ${value.affected.length} task${value.affected.length===1?"":"s"}`:""}`,severity:action==="failed"?"error":["completed","tasks_resumed"].includes(action)?"success":"warning",category:"Maintenance"};}
    if (type === "control.failed") return { title:`${value.kind === "refresh-list" ? "Issue list refresh" : value.kind === "refresh" ? "Issue refresh" : value.kind ?? "Control"} failed`,details:value.error ?? "Unknown error",severity:"error",category:"Control" };
    if (type === "control.applied") {
      if (value.kind === "refresh-list") return { title:"Issue list refresh completed",details:value.result ? `${value.result.found ?? 0} found · ${value.result.added ?? 0} added · ${value.result.updated ?? 0} updated` : "GitHub issues are synchronized.",severity:"success",category:"Control" };
      if (value.kind === "start-issue") return { title:value.result?.created ? `Issue #${value.result.issue} started` : `Issue #${value.result?.issue ?? "?"} already tracked`,details:value.result?.created ? `Work item ${value.result.id} was created and Architect will begin Design.` : `Existing work item ${value.result?.id ?? "unknown"} remains ${stateLabel(value.result?.stage)} · ${stateLabel(value.result?.status)}.`,severity:"success",category:"Control" };
      if (value.kind === "retry") return { title:"Retry started",details:"The workflow resumed from its saved stage.",severity:"success",category:"Control" };
      if (value.kind === "cancel") return { title:"Cancellation completed",details:"The active workflow was stopped and can be retried later.",severity:"warning",category:"Control" };
      if (value.kind === "stop") return { title:"Daemon stop completed",details:"Active work was paused safely.",severity:"warning",category:"Control" };
    }
  } catch {}
  const title=type.split(/[._]/).filter(Boolean).map(word=>word[0]?.toUpperCase()+word.slice(1)).join(" ");
  return { title,details:details(payload),severity:"info",category:"System" };
}
function snapshot(store: Store) {
  const storedItems=(store.db.prepare("SELECT id,issue_number,repo,stage,status,attempt,revision,branch,updated_at,archived_at,context FROM work_items ORDER BY created_at").all() as any[]).map(item=>({...item,context:JSON.parse(item.context||"{}")}));
  const itemById=new Map(storedItems.map(item=>[item.id,item]));
  const visibleItems=storedItems.filter(item=>!item.archived_at);
  const items = visibleItems.slice().reverse().map(item => ({
    id:item.id,issue:item.issue_number,repo:item.repo,stage:item.stage,status:item.status,attempt:item.attempt,revision:item.revision,title:item.context.title,
    url:item.context.url,pr:item.context.pr??null,updatedAt:item.updated_at,
  }));
  const executionRows=(store.db.prepare("SELECT id,work_item_id,role,stage,status,pid,started_at,finished_at,exit_code,input_tokens,output_tokens,cached_tokens,total_tokens,interruption_reason,maintenance_id FROM executions ORDER BY started_at DESC LIMIT 30").all() as any[]).filter(run=>!itemById.get(run.work_item_id)?.archived_at);
  const runMetadata=new Map((store.db.prepare("SELECT e.run_id,e.payload FROM events e JOIN executions x ON x.id=e.run_id WHERE e.type='execution.started' ORDER BY e.id DESC LIMIT 30").all() as Array<{run_id:string;payload:string}>).map(row=>{
    try { return [row.run_id,JSON.parse(row.payload)] as const; } catch { return [row.run_id,{}] as const; }
  }));
  const runRoles=new Map(executionRows.map(run=>[run.id,run.role]));
  const executions = executionRows.map(run=>{
    const item=itemById.get(run.work_item_id),selection=runMetadata.get(run.id)?.selection;
    const end=run.finished_at ? new Date(run.finished_at).getTime() : Date.now(),start=new Date(run.started_at).getTime();
    return { id:run.id,workItemId:run.work_item_id,role:run.role,workflowState:run.stage,status:run.status,pid:run.pid,startedAt:run.started_at,finishedAt:run.finished_at,exitCode:run.exit_code,durationMs:Number.isFinite(start) ? Math.max(0,end-start) : null,
      inputTokens:run.input_tokens,outputTokens:run.output_tokens,cachedTokens:run.cached_tokens,totalTokens:run.total_tokens,interruptionReason:run.interruption_reason,maintenanceId:run.maintenance_id,
      issue:item?.issue_number ?? null,title:item?.context.title ?? "Unknown issue",url:item?.context.url ?? null,provider:selection?.provider ?? null,model:selection?.model ?? null,profile:selection?.profile ?? null };
  });
  const usageRows=(store.db.prepare("SELECT work_item_id,role,stage,status,started_at,finished_at,input_tokens,output_tokens,cached_tokens,total_tokens FROM executions ORDER BY started_at").all() as any[]).filter(run=>!itemById.get(run.work_item_id)?.archived_at);
  const usageMap=new Map<string,{workItemId:string;runs:number;durationMs:number;inputTokens:number;outputTokens:number;cachedTokens:number;totalTokens:number;unreportedTokenRuns:number;stages:Map<string,any>}>();
  const add=(target:any,run:any,durationMs:number)=>{target.runs++;target.durationMs+=durationMs;for(const [source,key] of [["input_tokens","inputTokens"],["output_tokens","outputTokens"],["cached_tokens","cachedTokens"],["total_tokens","totalTokens"]] as const) target[key]+=run[source] ?? 0;if(run.total_tokens === null || run.total_tokens === undefined) target.unreportedTokenRuns++;};
  for (const run of usageRows) {
    const start=new Date(run.started_at).getTime(),end=run.finished_at ? new Date(run.finished_at).getTime() : Date.now(),elapsed=Number.isFinite(start) ? Math.max(0,end-start) : 0;
    let item=usageMap.get(run.work_item_id);
    if(!item){item={workItemId:run.work_item_id,runs:0,durationMs:0,inputTokens:0,outputTokens:0,cachedTokens:0,totalTokens:0,unreportedTokenRuns:0,stages:new Map()};usageMap.set(run.work_item_id,item);}
    add(item,run,elapsed);
    const state=run.stage ?? ({"product-architect":"DESIGN",developer:"BUILD",qa:"TEST",reviewer:"REVIEW"} as Record<string,string>)[run.role] ?? "UNKNOWN",key=`${state}:${run.role}`;
    let stage=item.stages.get(key);if(!stage){stage={state,role:run.role,runs:0,durationMs:0,inputTokens:0,outputTokens:0,cachedTokens:0,totalTokens:0,unreportedTokenRuns:0};item.stages.set(key,stage);}add(stage,run,elapsed);
  }
  const normalize=(value:any)=>({...value,totalTokens:value.unreportedTokenRuns===value.runs ? null : value.totalTokens});
  const usage=[...usageMap.values()].map(total=>{const item=itemById.get(total.workItemId);return {...normalize(total),stages:[...total.stages.values()].map(normalize),issue:item?.issue_number ?? null,title:item?.context.title ?? "Unknown issue",url:item?.context.url ?? null};}).sort((a,b)=>(b.issue ?? 0)-(a.issue ?? 0));
  const events = (store.db.prepare("SELECT id,ts,work_item_id,run_id,type,payload FROM events ORDER BY id DESC LIMIT 60").all() as any[])
    .filter(event=>!event.work_item_id||!itemById.get(event.work_item_id)?.archived_at)
    .map(event => { const item=itemById.get(event.work_item_id),presentation=eventPresentation(event.type,event.payload,runRoles.get(event.run_id)); const description=String(presentation.details ?? ""); return {
      id:event.id,ts:event.ts,workItemId:event.work_item_id,runId:event.run_id,type:event.type,...presentation,details:description.length>500 ? `${description.slice(0,497)}…` : description,
      issue:item?.issue_number ?? null,issueTitle:item?.context.title ?? null,issueUrl:item?.context.url ?? null,
    }; });
  const lastRefresh = store.db.prepare("SELECT id,handled FROM controls WHERE kind='refresh-list' ORDER BY id DESC LIMIT 1").get() as { id:number; handled:number } | undefined;
  let issueRefresh: { status:"queued" | "completed" | "failed"; message:string } | null = null;
  if (lastRefresh) {
    if (!lastRefresh.handled) issueRefresh={status:"queued",message:"Waiting for the daemon to refresh GitHub issues…"};
    else {
      const outcome = (store.db.prepare("SELECT type,payload FROM events WHERE type IN ('control.applied','control.failed') ORDER BY id DESC").all() as Array<{type:string;payload:string}>).map(event => {
        try { return {...event,data:JSON.parse(event.payload) as { id?:number; error?:string; result?:{found?:number;added?:number;updated?:number} }}; } catch { return null; }
      }).find(event => event?.data.id === lastRefresh.id);
      if (outcome?.type === "control.failed") issueRefresh={status:"failed",message:outcome.data.error ?? "GitHub issue refresh failed."};
      else if (outcome?.type === "control.applied") {
        const result=outcome.data.result;
        issueRefresh={status:"completed",message:result ? `Found ${result.found ?? 0} factory issue${result.found === 1 ? "" : "s"}; added ${result.added ?? 0}, updated ${result.updated ?? 0}.` : "GitHub issue refresh completed."};
      }
    }
  }
  const maintenance=(store.db.prepare("SELECT id,operation,actor,status,requested_at,confirmed_at,finished_at,error FROM maintenance_operations ORDER BY requested_at DESC LIMIT 10").all() as any[]).map(operation=>({...operation,affected:(store.db.prepare("SELECT work_item_id,paused_at,resumed_at FROM maintenance_items WHERE maintenance_id=?").all(operation.id) as any[])}));
  return { generatedAt:new Date().toISOString(), naming:publicNaming, repository:config.repo, branch:config.defaultBranch, daemon:daemonState(store), controller:cachedControllerState(store), issueRefresh, items, executions, usage, events,maintenance };
}
function controllerView(store:Store){
 if(!config.repo)return{state:"unconfigured",issues:[]};
 const github=new GitHubAdapter(),repository=verifyRepositoryIdentity(store,github,false),lease=new ControllerLease(repository,store),observation=lease.readLease(),owner=observation.state==="absent"?null:observation.record;
 const tracked=new Set((store.db.prepare("SELECT issue_id FROM work_items WHERE archived_at IS NULL AND issue_id IS NOT NULL").all() as Array<{issue_id:number}>).map(row=>row.issue_id));
 const issues=github.listManaged().map(issue=>{const labels=(issue.labels??[]).map(label=>label.name),stage=labels.find(label=>["factory:design","factory:build","factory:test","factory:review","factory:delivery","factory:done"].includes(label)),status=labels.find(label=>["factory:waiting","factory:failed","factory:paused","factory:cancelled"].includes(label));return{id:issue.id,number:issue.number,title:issue.title,url:issue.url,stage:stage?.slice(8)??"unknown",status:status?.slice(8)??"active",processedBy:owner?.displayName??"No controller",trackedHere:tracked.has(issue.id)};});
 return{...observation,repository:repository.fullName,issues};
}
async function readBody(req: http.IncomingMessage) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 32768) throw new Error("Request body is too large");
  }
  return JSON.parse(body || "{}");
}
function asset(res: http.ServerResponse, name: string) {
  const file = path.join(assets, name);
  try {
    const content = fs.readFileSync(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(content);
  } catch { res.writeHead(404).end("Not found"); }
}
type LogSource = "output" | "errors";
function tailLog(file: string, lines: number) {
  if (!fs.existsSync(file)) return { exists:false,content:"",updatedAt:null,truncated:false };
  const stat = fs.statSync(file);
  const maxBytes = 512 * 1024;
  const offset = Math.max(0,stat.size-maxBytes);
  const length = stat.size-offset;
  const handle = fs.openSync(file,"r");
  try {
    const buffer=Buffer.alloc(length);
    if (length) fs.readSync(handle,buffer,0,length,offset);
    let content=buffer.toString("utf8");
    if (offset>0) content=content.slice(Math.max(0,content.indexOf("\n")+1));
    const allLines=content.split(/\r?\n/);
    if (allLines.at(-1)==="") allLines.pop();
    const selected=allLines.slice(-lines);
    return { exists:true,content:selected.join("\n"),updatedAt:stat.mtime.toISOString(),truncated:offset>0||allLines.length>lines };
  } finally { fs.closeSync(handle); }
}
function daemonLogs(root: string, requestedLines: string | null) {
  const parsed=Number.parseInt(requestedLines ?? "200",10);
  const lines=Number.isFinite(parsed) ? Math.min(1000,Math.max(50,parsed)) : 200;
  const directory=path.join(factoryHome(root),"data","service-logs");
  const files: Array<{source:LogSource;filename:string}> = [
    {source:"output",filename:"daemon.log"},
    {source:"errors",filename:"daemon.error.log"},
  ];
  return {
    generatedAt:new Date().toISOString(),lines,
    logs:files.map(({source,filename})=>({source,path:`data/service-logs/${filename}`,...tailLog(path.join(directory,filename),lines)})),
  };
}
function serviceStatus(root: string, service: "daemon" | "dashboard") {
  const result = spawnSync("bash",[path.join(root,"scripts/services.sh"),"status",service],{cwd:root,encoding:"utf8",timeout:10000});
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { service, loaded:result.status === 0 && output.includes(`${service}: loaded`), running:/state = (running|active)/.test(output), detail:output.trim() };
}
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
function waitUntil(check: () => boolean, timeoutMs: number, intervalMs = 100) {
  const deadline=Date.now()+timeoutMs;
  while (Date.now()<deadline) {
    if (check()) return true;
    Atomics.wait(waitBuffer,0,0,intervalMs);
  }
  return check();
}
function configuredDaemonLock(root: string) {
  const configured=readDashboardSetting(root,"FACTORY_DATA_DIR");
  const directory=path.resolve(factoryHome(root),configured || "data"),file=path.join(directory,"factory.db");
  if (!fs.existsSync(file)) return null;
  try {
    const db=new Database(file,{readonly:true,fileMustExist:true});
    try {
      const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='daemon_lock'").get();
      const lock=table ? db.prepare("SELECT pid FROM daemon_lock WHERE id=1").get() as {pid:number} | undefined : undefined;
      return Boolean(lock && alive(lock.pid));
    } finally { db.close(); }
  } catch { return false; }
}
function waitForDaemonStopped(root: string, previousPid: number | null) {
  return waitUntil(()=>!serviceStatus(root,"daemon").loaded && (!previousPid || !alive(previousPid)),15000);
}
function waitForDaemonStarted(root: string) {
  const started=Date.now();
  return waitUntil(()=>{
    const service=serviceStatus(root,"daemon"),lock=configuredDaemonLock(root);
    return service.running && (lock === true || (lock === null && Date.now()-started>=1500));
  },75000,200);
}
function restoreEnvironment(root: string, original: string | null) {
  const file=path.join(factoryHome(root),".env"),temporary=`${file}.rollback-${process.pid}`;
  if (original === null) { fs.rmSync(file,{force:true}); return; }
  fs.writeFileSync(temporary,original,{mode:0o600});
  fs.renameSync(temporary,file);
}
type UpdateState = { status: "idle" | "updating" | "completed" | "failed"; phase?: string; pid?: number; startedAt?: string; updatedAt?: string; finishedAt?: string; restoreDaemon?: boolean; restoreDashboard?: boolean;maintenanceId?:string };
type VersionInfo = { number: string; revision: string; branch: string; display: string };
const updateStateFile = (root: string) => path.join(factoryHome(root),"data","update-state.json");
function git(root: string, args: string[], timeout = 10000) {
  const result = spawnSync(config.gitCommand,args,{cwd:root,encoding:"utf8",timeout});
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  return result.stdout.trim();
}
function versionInfo(root: string): VersionInfo {
  const manifest = JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8")) as { version?: string };
  const revision = git(root,["rev-parse","--short","HEAD"]);
  const branch = git(root,["symbolic-ref","--quiet","--short","HEAD"]);
  const number = manifest.version ?? "0.0.0";
  return { number,revision,branch,display:`v${number} · ${revision}` };
}
function checkUpdate(root: string) {
  const current = versionInfo(root);
  const currentFull = git(root,["rev-parse","HEAD"]);
  git(root,["fetch","origin",`refs/heads/${current.branch}`],30000);
  const latestFull = git(root,["rev-parse","FETCH_HEAD"]);
  const latest = git(root,["rev-parse","--short","FETCH_HEAD"]);
  if (latestFull !== currentFull) git(root,["merge-base","--is-ancestor",currentFull,latestFull]);
  return { current,latest,available:latestFull !== currentFull,checkedAt:new Date().toISOString() };
}
function writeUpdateState(root: string, state: UpdateState) {
  const file = updateStateFile(root);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(state,null,2),{mode:0o600});
  fs.renameSync(temporary,file);
}
function processAlive(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid,0);
    const command = spawnSync("ps",["-p",String(pid),"-o","command="],{encoding:"utf8",timeout:3000});
    return command.status === 0 && /(?:scripts\/update(?:-job)?\.sh|factory-dashboard-update)/.test(command.stdout);
  } catch { return false; }
}
function updateState(root: string): UpdateState {
  const file = updateStateFile(root);
  if (!fs.existsSync(file)) return { status:"idle" };
  try {
    const state = JSON.parse(fs.readFileSync(file,"utf8")) as UpdateState;
    const awaitingPid = state.status === "updating" && !state.pid && Date.now()-new Date(state.startedAt ?? 0).getTime() < 30000;
    if (state.status === "updating" && !awaitingPid && !processAlive(state.pid)) {
      const failed = { ...state,status:"failed" as const,phase:"Update process stopped unexpectedly. Inspect update.log.",finishedAt:new Date().toISOString() };
      writeUpdateState(root,failed); return failed;
    }
    return state;
  } catch { return { status:"failed",phase:"Update status could not be read. Inspect update.log." }; }
}
function runService(root: string, service: "daemon" | "dashboard", action: "start" | "stop" | "restart") {
  const script = path.join(root,"scripts/services.sh");
  if (service === "dashboard" && ["stop","restart"].includes(action)) {
    const child = spawn("/bin/bash",["-c",'sleep 0.5; exec bash "$1" "$2" dashboard',"factory-dashboard-control",script,action],{cwd:root,detached:true,stdio:"ignore"});
    child.unref();
    return { accepted:true, message:`Dashboard ${action} scheduled; this page may reconnect.` };
  }
  const result = spawnSync("bash",[script,action,service],{cwd:root,encoding:"utf8",timeout:30000});
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${service} ${action} failed`).trim());
  return { accepted:true, message:`${service} ${action} completed.` };
}
function runUpdate(root: string,maintenanceId?:string) {
  const current = updateState(root);
  if (current.status === "updating") throw new Error("A factory update is already running");
  const logs = path.join(factoryHome(root),"data","service-logs");
  fs.mkdirSync(logs,{recursive:true});
  const logFile = path.join(logs,"update.log");
  const stateFile = updateStateFile(root);
  // Capture service intent while both services still have their original state.
  // The detached job starts later and must not infer intent after stopping one.
  const daemonBefore=serviceStatus(root,"daemon"),dashboardBefore=serviceStatus(root,"dashboard");
  const intent={restoreDaemon:daemonBefore.loaded,restoreDashboard:dashboardBefore.loaded,maintenanceId};
  writeUpdateState(root,{status:"updating",phase:"Preparing update…",startedAt:new Date().toISOString(),...intent});
  if (process.platform === "darwin" && dashboardBefore.loaded) {
    const label = `com.ai-factory.update.${Date.now()}`;
    const submitted = spawnSync("launchctl",["submit","-l",label,"-o",logFile,"-e",logFile,"--","/bin/bash",path.join(root,"scripts/update-job.sh"),stateFile,path.join(root,"scripts/update.sh"),label],{cwd:root,encoding:"utf8",timeout:10000});
    if (submitted.status !== 0) {
      writeUpdateState(root,{status:"failed",phase:"Could not start the independent update job.",finishedAt:new Date().toISOString(),...intent});
      throw new Error((submitted.stderr || submitted.stdout || "Could not start the independent update job").trim());
    }
  } else {
    const output = fs.openSync(logFile,"a");
    const child = spawn("/bin/bash",["-c",'sleep 0.75; exec bash "$1" --restart-services',"factory-dashboard-update",path.join(root,"scripts/update.sh")],{
      cwd:root,detached:true,stdio:["ignore",output,output],env:{...process.env,AI_FACTORY_UPDATE_STATE_FILE:stateFile}
    });
    fs.closeSync(output);
    writeUpdateState(root,{status:"updating",phase:"Preparing update…",pid:child.pid,startedAt:new Date().toISOString(),...intent});
    child.unref();
  }
  return { accepted:true,message:"Factory update started. Services will stop, update, and reconnect when ready.",update:updateState(root) };
}
function slackStatus(root: string, store: Store) {
  const configured = Boolean(readDashboardSetting(root,"SLACK_WEBHOOK_URL"));
  const counts = store.db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN sent=0 THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN sent=0 AND attempts>0 THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN sent=1 THEN 1 ELSE 0 END) AS sent FROM notifications").get() as { total:number; pending:number | null; failed:number | null; sent:number | null };
  const last = store.db.prepare("SELECT last_error FROM notifications WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 1").get() as { last_error:string } | undefined;
  return { configured,pending:counts.pending ?? 0,failed:counts.failed ?? 0,sent:counts.sent ?? 0,lastError:last?.last_error ?? null };
}
type SetupRequirement = { id: string; label: string; group: "credentials" | "project" | "access" };
function normalizedRepository(value: string) {
  return value.trim().replace(/^https?:\/\/github\.com\//,"https://github.com/").replace(/^git@github\.com:/,"https://github.com/").replace(/\.git$/i,"").replace(/\/$/,"").toLowerCase();
}
function setupReadiness(root: string, credentials: ReturnType<typeof credentialStatuses>) {
  const missing: SetupRequirement[] = [];
  const require = (condition: boolean, requirement: SetupRequirement) => { if (!condition) missing.push(requirement); };
  const repository = readDashboardSetting(root,"GITHUB_REPOSITORY").trim();
  const repoDirValue = readDashboardSetting(root,"FACTORY_REPO_DIR").trim();
  const repoDir = repoDirValue ? path.resolve(factoryHome(root),repoDirValue) : "";
  const approvers = readDashboardSetting(root,"FACTORY_APPROVERS").split(",").map(item => item.trim()).filter(Boolean);
  const gitCommand = readDashboardSetting(root,"GIT_COMMAND").trim() || config.gitCommand;
  const credential = (id: CredentialProvider) => credentials.credentials.find(item => item.id === id);
  const github = credential("github");

  require(Boolean(github?.installed && github.connected),{
    id:"github-credential",label:github?.installed ? "Connect GitHub." : "Install the GitHub CLI and connect GitHub.",group:"credentials",
  });
  const selectedProviders = new Set(["PRODUCT_ARCHITECT","DEVELOPER","QA","REVIEWER"].map(role => readDashboardSetting(root,`${role}_PROVIDER`) as CredentialProvider));
  for (const provider of ["claude","codex"] as const) {
    if (!selectedProviders.has(provider)) continue;
    const status = credential(provider), label = provider === "claude" ? "Claude" : "Codex";
    require(Boolean(status?.installed && status.connected),{
      id:`${provider}-credential`,label:status?.installed ? `Connect ${label}; at least one agent role uses it.` : `Install and connect ${label}; at least one agent role uses it.`,group:"credentials",
    });
  }

  require(/^[\w.-]+\/[\w.-]+$/.test(repository),{id:"repository",label:"Choose the GitHub repository to process.",group:"project"});
  require(Boolean(approvers.length),{id:"approvers",label:"Add at least one authorized approver.",group:"access"});
  const checkoutExists = Boolean(repoDir && fs.existsSync(repoDir) && fs.statSync(repoDir).isDirectory());
  if (!repoDir || (fs.existsSync(repoDir) && !checkoutExists)) {
    require(false,{id:"checkout",label:"Choose a local checkout path; a missing checkout will be cloned at startup.",group:"project"});
  } else if (checkoutExists && fs.readdirSync(repoDir).length) {
    const runGit = (args: string[]) => spawnSync(gitCommand,args,{cwd:repoDir,encoding:"utf8",timeout:5000});
    const inside = runGit(["rev-parse","--is-inside-work-tree"]);
    if (inside.status !== 0 || inside.stdout.trim() !== "true") {
      require(false,{id:"checkout-git",label:"Use a target checkout that is a Git working tree.",group:"project"});
    } else {
      if (/^[\w.-]+\/[\w.-]+$/.test(repository)) {
        const origin = runGit(["remote","get-url","origin"]), expected = `https://github.com/${repository}`;
        require(origin.status === 0 && normalizedRepository(origin.stdout) === normalizedRepository(expected),{
          id:"origin",label:`Point the target checkout origin to ${repository}.`,group:"project",
        });
      }
    }
  }
  return { ready:missing.length === 0,missing };
}
function dashboardSettings(root: string) {
  const credentials = credentialStatuses(root);
  const github = credentials.credentials.find(item => item.id === "github");
  const login = github?.connected ? github.account : undefined;
  const settings = readDashboardSettings(root,login ? {
    GITHUB_REPOSITORY:`${login}/ai-factory-demo`,
    FACTORY_REPO_DIR:path.join(factoryHome(root),"repos","ai-factory-demo"),
    FACTORY_APPROVERS:login,
  } : {});
  const providers=["PRODUCT_ARCHITECT","DEVELOPER","QA","REVIEWER"].map(role=>readDashboardSetting(root,`${role}_PROVIDER`));
  const setupProvider=providers.every(value=>value===providers[0])?providers[0]:"codex";
  settings.fields.push({key:"AGENT_PROVIDER",label:"Agent provider",description:"Use one provider for all four roles during first-time setup.",group:"credentials",type:"select",options:[{value:"codex",label:"Codex"},{value:"claude",label:"Claude"}],value:setupProvider,required:true,restart:"daemon",setup:true,setupOnly:true} as any);
  return {...settings,readiness:setupReadiness(root,credentials)};
}
function expandSetupProvider(values:Record<string,unknown>){const result={...values};if("AGENT_PROVIDER" in result){const provider=result.AGENT_PROVIDER;if(provider!=="codex"&&provider!=="claude")throw new Error("AGENT_PROVIDER: choose codex or claude");for(const role of["PRODUCT_ARCHITECT","DEVELOPER","QA","REVIEWER"])result[`${role}_PROVIDER`]=provider;delete result.AGENT_PROVIDER;}return result;}
function saveConfiguration(store: Store, root: string, values: Record<string,unknown>, clearSecrets: string[] = [],maintenanceId?:string,startDaemonWhenReady=false) {
  const candidate=expandSetupProvider(values);
  const currentRepository=readDashboardSetting(root,"GITHUB_REPOSITORY").trim(),nextRepository=typeof candidate.GITHUB_REPOSITORY==="string"?candidate.GITHUB_REPOSITORY.trim():currentRepository;
  if(nextRepository&&nextRepository!==currentRepository){
    const github=credentialStatuses(root).credentials.find(item=>item.id==="github");
    if(github?.connected)candidate.GITHUB_DEFAULT_BRANCH=new GitHubAdapter(undefined,nextRepository).repository().defaultBranch;
  }
  values=candidate;
  const plan = validateDashboardSettings(root,values,clearSecrets);
  const requestedRepository=typeof values.GITHUB_REPOSITORY==="string"?values.GITHUB_REPOSITORY.trim():readDashboardSetting(root,"GITHUB_REPOSITORY").trim();
  if(requestedRepository)verifyRepositoryIdentity(store,new GitHubAdapter(undefined,requestedRepository),false);
  const daemon = serviceStatus(root,"daemon"), dashboard = serviceStatus(root,"dashboard");
  const before=daemonState(store),daemonActive = before.running || daemon.running;
  const restartDaemon = plan.restartServices.includes("daemon") && daemonActive;
  const restartDashboard = plan.restartServices.includes("dashboard") && dashboard.running;
  if (plan.restartServices.includes("daemon") && daemonActive && !daemon.loaded) throw new Error("The daemon is running outside the service manager. Stop it, then save again.");
  if(restartDaemon)requireMaintenance(store,maintenanceId,["configuration-apply"]);
  const environmentFile=path.join(factoryHome(root),".env"),originalEnvironment=fs.existsSync(environmentFile) ? fs.readFileSync(environmentFile,"utf8") : null;
  let daemonStopped = false,saved = false,initialDaemonStartAttempted=false,initialDaemonStarted=false,initialDaemonStartError:string|undefined;
  try {
    if(maintenanceId)maintenanceCoordinator(store).markStarted(maintenanceId);
    if (restartDaemon) {
      runService(root,"daemon","stop"); daemonStopped=true;
      if (!waitForDaemonStopped(root,before.pid)) throw new Error("The daemon did not stop completely before applying configuration.");
    }
    if(plan.changedKeys.length){saveDashboardSettings(root,values,clearSecrets);saved=true;}
    if (restartDaemon) {
      runService(root,"daemon","start");
      if (!waitForDaemonStarted(root)) {
        const error=tailLog(path.join(factoryHome(root),"data","service-logs","daemon.error.log"),25).content;
        throw new Error(`The daemon did not become ready after restart.${error ? ` Last error: ${error.split(/\r?\n/).at(-1)}` : ""}`);
      }
    }
    const ready=dashboardSettings(root).readiness.ready;
    if(startDaemonWhenReady&&!daemonActive&&ready){
      initialDaemonStartAttempted=true;
      try {
        runService(root,"daemon","start");
        if(!waitForDaemonStarted(root))throw new Error("The daemon did not become ready after initial setup");
        initialDaemonStarted=true;
      } catch(error) {
        const currentError=error instanceof Error?error.message:String(error),logged=tailLog(path.join(factoryHome(root),"data","service-logs","daemon.error.log"),25).content.split(/\r?\n/).filter(Boolean).at(-1),message=currentError==="The daemon did not become ready after initial setup"&&logged?logged:currentError;
        initialDaemonStartError=message.replace(/[.\s]+$/g,"")||"Unknown daemon start failure";
        try{if(serviceStatus(root,"daemon").loaded)runService(root,"daemon","stop");}catch(stopError){initialDaemonStartError+=`; failed to stop the daemon service: ${stopError instanceof Error?stopError.message:String(stopError)}`;}
        if(maintenanceId){store.db.prepare("UPDATE maintenance_operations SET status='failed',finished_at=?,error=? WHERE id=?").run(new Date().toISOString(),initialDaemonStartError,maintenanceId);store.event("maintenance.failed",{maintenanceId,operation:"configuration-apply",error:initialDaemonStartError});}
      }
    }
    if(maintenanceId&&!initialDaemonStartError)maintenanceCoordinator(store).complete(maintenanceId);
  } catch (error) {
    if(maintenanceId){store.db.prepare("UPDATE maintenance_operations SET status='failed',finished_at=?,error=? WHERE id=?").run(new Date().toISOString(),String(error),maintenanceId);store.event("maintenance.failed",{maintenanceId,operation:"configuration-apply",error:String(error)});}
    let recovery="";
    if(initialDaemonStartAttempted)try{if(serviceStatus(root,"daemon").loaded)runService(root,"daemon","stop");}catch(stopError){recovery+=` The failed initial daemon could not be stopped: ${String(stopError)}`;}
    if (saved) try { restoreEnvironment(root,originalEnvironment); } catch (rollbackError) { recovery=` Configuration rollback failed: ${String(rollbackError)}`; }
    if (daemonStopped) try {
      if (serviceStatus(root,"daemon").loaded) runService(root,"daemon","stop");
      runService(root,"daemon","start");
      if (!waitForDaemonStarted(root)) recovery+=` The previous daemon configuration could not be restored automatically.`;
    } catch (restartError) { recovery+=` The previous daemon configuration could not be restored: ${String(restartError)}`; }
    throw new Error(`${saved ? "Configuration was rolled back" : "Configuration was not saved"}: ${error instanceof Error ? error.message : String(error)}${recovery}`);
  }
  const restartedServices: string[] = [];
  if (restartDaemon) restartedServices.push("daemon");
  if (restartDashboard) { runService(root,"dashboard","restart"); restartedServices.push("dashboard"); }
  const message = initialDaemonStarted
    ? "Configuration saved. Daemon started and verified."
    : initialDaemonStartError
    ? `Configuration saved. The daemon did not start: ${initialDaemonStartError}. Fix the cause and start it from the Services panel.`
    : restartedServices.length
    ? `Configuration saved. ${restartDaemon ? "Daemon restarted and verified." : ""}${restartDashboard ? `${restartDaemon ? " " : ""}Dashboard restart scheduled.` : ""}`
    : plan.changedKeys.length ? "Configuration saved. Stopped services were left stopped." : "Configuration is already up to date.";
  return {...dashboardSettings(root),daemonRunning:daemonState(store).running,restartedServices,startedServices:initialDaemonStarted?["daemon"]:[],dashboardRestarting:restartDashboard,message,...(initialDaemonStartError?{daemonStartError:initialDaemonStartError}:{})};
}

export function createDashboardServer(store: Store, settingsRoot = process.cwd()) {
  const runtimeVersion = versionInfo(settingsRoot);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/api/snapshot") return json(res,200,snapshot(store));
      if (req.method === "GET" && url.pathname === "/api/stream") {
        res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform","connection":"keep-alive"});
        const send = () => { if (!res.destroyed) res.write(`data: ${JSON.stringify(snapshot(store))}\n\n`); };
        send();
        const timer = setInterval(send,2000);
        timer.unref();
        req.on("close",() => clearInterval(timer));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/settings") return json(res,200,{...dashboardSettings(settingsRoot),daemonRunning:daemonState(store).running});
      if (req.method === "GET" && url.pathname === "/api/credentials") return json(res,200,credentialStatuses(settingsRoot));
      if (req.method === "GET" && url.pathname === "/api/slack") return json(res,200,slackStatus(settingsRoot,store));
      if (req.method === "GET" && url.pathname === "/api/services") {const update=updateState(settingsRoot);reconcileUpdateMaintenance(store,update);const resumable=store.db.prepare(`SELECT mo.id FROM maintenance_operations mo WHERE mo.status IN ('ready','running','completed','failed') AND EXISTS(SELECT 1 FROM maintenance_items mi JOIN work_items w ON w.id=mi.work_item_id WHERE mi.maintenance_id=mo.id AND mi.resumed_at IS NULL AND w.status='PAUSED') ORDER BY mo.requested_at DESC LIMIT 1`).get() as {id:string}|undefined;return json(res,200,{services:[serviceStatus(settingsRoot,"daemon"),serviceStatus(settingsRoot,"dashboard")],controller:cachedControllerState(store),update,version:runtimeVersion,maintenance:resumable?maintenanceOperation(store,resumable.id):null});}
      if(req.method==="GET"&&url.pathname==="/api/controller")return json(res,200,controllerView(store));
      if(req.method==="POST"&&url.pathname==="/api/controller"){
        const body=await readBody(req) as {action?:string;force?:boolean;confirmation?:string};if(!config.repo)return json(res,409,{error:"Configure a repository first"});
        const github=new GitHubAdapter(),repository=verifyRepositoryIdentity(store,github,false),lease=new ControllerLease(repository,store);let result;
        if(body.action==="refresh")result=lease.readLease();else if(body.action==="release")result=lease.release(false);else if(body.action==="takeover"){if(body.force&&body.confirmation!==repository.fullName)return json(res,400,{error:`Type ${repository.fullName} to confirm force takeover`});const previous=lease.readLease();result=lease.takeover(Boolean(body.force),previous);publishTakeoverNotices(store,github,previous,result);}else return json(res,400,{error:"Unknown controller action"});
        return json(res,200,{...result,repository:repository.fullName});
      }
      if(req.method==="GET"&&url.pathname.startsWith("/api/maintenance/"))return json(res,200,maintenanceOperation(store,url.pathname.split("/").at(-1)!));
      if(req.method==="POST"&&url.pathname==="/api/maintenance"){
        const body=await readBody(req) as {operation?:MaintenanceOperation};const allowed:MaintenanceOperation[]=["update","daemon-stop","daemon-restart","uninstall","configuration-apply","user-pause"];
        if(!body.operation||!allowed.includes(body.operation))return json(res,400,{error:"Unknown maintenance operation"});return json(res,200,maintenanceCoordinator(store).request(body.operation,"dashboard"));
      }
      if(req.method==="POST"&&url.pathname.match(/^\/api\/maintenance\/[^/]+\/(confirm|resume)$/)){
        const [, , ,id,action]=url.pathname.split("/");store.request(action==="confirm"?"maintenance-confirm":"maintenance-resume",id);return json(res,202,{ok:true,id,status:"queued"});
      }
      if (req.method === "GET" && url.pathname === "/api/logs/daemon") return json(res,200,daemonLogs(settingsRoot,url.searchParams.get("lines")));
      if(req.method==="POST"&&url.pathname.match(/^\/api\/executions\/[^/]+\/prompt$/)){const id=url.pathname.split("/")[3],body=await readBody(req) as {acknowledgeSensitive?:boolean};if(body.acknowledgeSensitive!==true)return json(res,400,{error:"Acknowledge that prompts may contain sensitive source and issue context"});if(!store.db.prepare("SELECT 1 FROM executions WHERE id=?").get(id))return json(res,404,{error:"Unknown execution"});const file=path.join(config.dataDir,"runs",id,"prompt.md");if(!fs.existsSync(file))return json(res,410,{error:"Exact prompt content was pruned by retention or is unavailable"});const stat=fs.statSync(file);if(stat.size>2_000_000)return json(res,413,{error:"Prompt is too large to reveal in the dashboard"});return json(res,200,{id,warning:"Sensitive execution context. Do not share without review.",prompt:fs.readFileSync(file,"utf8")});}
      if(req.method==="GET"&&url.pathname==="/api/repository")return json(res,200,new RepositoryMaintenance(store).check());
      if(req.method==="POST"&&url.pathname==="/api/repository") {const body=await readBody(req) as {action?:string;workItemId?:string;confirmPath?:string;repeatPath?:string;maintenanceId?:string},repository=new RepositoryMaintenance(store);if(body.action==="check")return json(res,200,repository.check());if(body.action==="sync")return json(res,200,repository.sync("dashboard"));if(body.action==="publish"&&body.workItemId)return json(res,200,repository.publish(body.workItemId,"dashboard"));if(body.action==="clear"){requireMaintenance(store,body.maintenanceId,["user-pause"]);if(body.maintenanceId)maintenanceCoordinator(store).markStarted(body.maintenanceId);const result=repository.clear(body.confirmPath??"",body.repeatPath??"","dashboard");if(body.maintenanceId)maintenanceCoordinator(store).complete(body.maintenanceId);return json(res,200,result);}if(body.action==="restore")return json(res,200,repository.restore("dashboard"));return json(res,400,{error:"Unknown or incomplete repository action"});}
      if (req.method === "POST" && url.pathname === "/api/update/check") return json(res,200,checkUpdate(settingsRoot));
      if (req.method === "GET" && url.pathname === "/healthz") return json(res,200,{ok:true});
      if (req.method === "PUT" && url.pathname === "/api/settings") {
        const body = await readBody(req) as { values?: Record<string,unknown>; clearSecrets?: string[];maintenanceId?:string;startDaemonWhenReady?:boolean };
        if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) return json(res,400,{error:"Settings are required"});
        return json(res,200,saveConfiguration(store,settingsRoot,body.values,Array.isArray(body.clearSecrets) ? body.clearSecrets : [],body.maintenanceId,body.startDaemonWhenReady===true));
      }
      if(req.method==="POST"&&url.pathname==="/api/settings/validate") {const body=await readBody(req) as {values?:Record<string,unknown>;clearSecrets?:string[]};if(!body.values||typeof body.values!=="object"||Array.isArray(body.values))return json(res,400,{error:"Settings are required"});const plan=validateDashboardSettings(settingsRoot,expandSetupProvider(body.values),Array.isArray(body.clearSecrets)?body.clearSecrets:[]),daemon=serviceStatus(settingsRoot,"daemon"),active=daemonState(store).running||daemon.running;return json(res,200,{changedKeys:plan.changedKeys,restartServices:plan.restartServices,requiresDaemonRestart:active&&plan.restartServices.includes("daemon")});}
      if (req.method === "POST" && url.pathname === "/api/control") {
        const body = await readBody(req) as { kind?: string; target?: string };
        if (!["stop","cancel","retry","refresh-list","start-issue"].includes(body.kind ?? "")) return json(res,400,{error:"Unknown control"});
        if (!["stop","refresh-list"].includes(body.kind ?? "") && !body.target) return json(res,400,{error:body.kind === "start-issue" ? "An issue number or URL is required" : "A work item or run id is required"});
        if (["refresh-list","start-issue"].includes(body.kind ?? "") && !daemonState(store).running) return json(res,409,{error:"Start the daemon before synchronizing GitHub issues."});
        store.request(body.kind!,body.target ?? "");
        return json(res,202,{ok:true,message:body.kind === "refresh-list" ? "GitHub issue refresh queued." : body.kind === "start-issue" ? "Issue start queued." : `${body.kind} queued`});
      }
      if (req.method === "POST" && url.pathname === "/api/services") {
        const body = await readBody(req) as { service?: string; action?: string;maintenanceId?:string };
        if (!['daemon','dashboard'].includes(body.service ?? "") || !['start','stop','restart'].includes(body.action ?? "")) return json(res,400,{error:"Unknown service action"});
        if(body.service==="daemon"&&["stop","restart"].includes(body.action!))requireMaintenance(store,body.maintenanceId,[body.action==="stop"?"daemon-stop":"daemon-restart"]);
        const result=runService(settingsRoot,body.service as "daemon" | "dashboard",body.action as "start" | "stop" | "restart");if(body.maintenanceId){const coordinator=maintenanceCoordinator(store);coordinator.markStarted(body.maintenanceId);coordinator.complete(body.maintenanceId);}return json(res,202,result);
      }
      if (req.method === "POST" && url.pathname === "/api/credentials/connect") {
        const body = await readBody(req) as { provider?: string };
        if (!['github','claude','codex'].includes(body.provider ?? "")) return json(res,400,{error:"Unknown credential provider"});
        return json(res,202,connectCredential(settingsRoot,body.provider as CredentialProvider));
      }
      if (req.method === "PUT" && url.pathname === "/api/slack") {
        const body = await readBody(req) as { webhook?: unknown; clear?: unknown };
        if (typeof body.webhook !== "string" || typeof body.clear !== "boolean") return json(res,400,{error:"Webhook and clear flag are required"});
        const saved = saveConfiguration(store,settingsRoot,{SLACK_WEBHOOK_URL:body.clear ? "" : body.webhook},body.clear ? ["SLACK_WEBHOOK_URL"] : []);
        return json(res,200,{...slackStatus(settingsRoot,store),message:body.clear ? `Slack connection removed. ${saved.message}` : `Slack webhook saved. ${saved.message}`});
      }
      if (req.method === "POST" && url.pathname === "/api/slack/test") {
        const webhook = readDashboardSetting(settingsRoot,"SLACK_WEBHOOK_URL");
        if (!webhook) return json(res,409,{error:"Configure and save a Slack webhook first"});
        await new SlackAdapter(webhook).notify("🧪 AI Factory connection test\n\nSlack test notification from the dashboard was delivered successfully. No action is required. Workflow decisions remain in GitHub.");
        return json(res,200,{...slackStatus(settingsRoot,store),message:"Slack test notification delivered."});
      }
      if (req.method === "POST" && url.pathname === "/api/update") {
        const body=await readBody(req) as {maintenanceId?:string};requireMaintenance(store,body.maintenanceId,["update"]);
        const check = checkUpdate(settingsRoot);
        if (!check.available) return json(res,409,{error:`${check.current.display} is already up to date`,check});
        if(body.maintenanceId)maintenanceCoordinator(store).markStarted(body.maintenanceId);
        return json(res,202,{...runUpdate(settingsRoot,body.maintenanceId),check});
      }
      if (req.method !== "GET") return json(res,405,{error:"Method not allowed"});
      const files: Record<string,string> = {
        "/":"index.html", "/index.html":"index.html", "/app.js":"app.js", "/styles.css":"styles.css",
        "/assets/brands/github.svg":"assets/brands/github.svg", "/assets/brands/claude.svg":"assets/brands/claude.svg",
        "/assets/brands/openai.svg":"assets/brands/openai.svg", "/assets/brands/git.svg":"assets/brands/git.svg",
        "/assets/brands/slack.svg":"assets/brands/slack.svg",
      };
      return files[url.pathname] ? asset(res,files[url.pathname]) : json(res,404,{error:"Not found"});
    } catch (error) { return json(res,400,{error:error instanceof Error ? error.message : String(error)}); }
  });
}

export async function startDashboard(store: Store, host = config.dashboardHost, port = config.dashboardPort, settingsRoot = process.cwd()) {
  const server = createDashboardServer(store,settingsRoot);
  await new Promise<void>((resolve,reject) => { server.once("error",reject); server.listen(port,host,resolve); });
  const address = server.address() as AddressInfo;
  const displayHost = address.address === "::1" ? "[::1]" : address.address;
  console.log(`AI Factory dashboard: http://${displayHost}:${address.port}`);
  return server;
}

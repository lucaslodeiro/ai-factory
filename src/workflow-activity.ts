import type {Store} from './storage.js';
import {diagnoseWorkItem} from './failure-diagnostics.js';
import {progressKey,progressWarning,type ExecutionProgress} from './execution-progress.js';
import {budgetState,liveBudget,formatTokens} from './budget.js';
export function workflowActivity(store:Store,id:string,status:string,now=Date.now()){
 const run=store.db.prepare('SELECT e.id,e.status,e.started_at,e.finished_at FROM executions e JOIN work_items w ON w.active_run_id=e.id WHERE w.id=?').get(id) as {id:string;status:string;started_at:string;finished_at:string|null}|undefined;
 const failure=store.db.prepare('SELECT message FROM failures WHERE work_item_id=? AND resolved_at IS NULL').get(id) as {message:string}|undefined;
 if(status==='QUEUED'){
  const local=store.metadata<{id:string;stage:string;since:string}>("runtime:local-work");
  if(local?.id===id)return{label:local.stage==='DELIVERY'?'Publishing delivery':'Preparing execution',detail:local.stage==='DELIVERY'?'Publishing the branch and preparing the pull request.':'Preparing the workspace and agent context.',since:local.since,stalled:false};
  const maintenance=store.db.prepare("SELECT 1 FROM maintenance_operations WHERE status IN ('confirmed','pausing','ready','running') LIMIT 1").get();
  if(maintenance)return{label:'Waiting for maintenance',detail:'New executions will wait until maintenance finishes.',stalled:false};
  const busy=store.db.prepare("SELECT 1 FROM work_items WHERE status='RUNNING' AND archived_at IS NULL LIMIT 1").get();
  return{label:busy?'Waiting for capacity':'Queued',detail:busy?'Another task is using the execution slot. This task will start when it becomes available.':'Waiting for the local scheduler and active repository control.',stalled:false};
 }
 if(status==='RUNNING'){
  if(!run)return {label:'Needs recovery',detail:'No execution is associated with this running task.',stalled:true};
  if(run.status!=='running'){
   const stale=!run.finished_at||now-Date.parse(run.finished_at)>30000;
   return {label:stale?'Needs recovery':'Processing result',detail:stale?'The agent has finished, but the workflow has not advanced.':`Agent finished (${run.status}); applying its result.`,since:run.finished_at,stalled:stale};
  }
  const progress=store.metadata<ExecutionProgress>(progressKey(run.id)),warning=progressWarning(progress,run.started_at,now);
  const budget=budgetState(store,id),live=liveBudget(budget.granted,budget.consumed,progress?.usageTokens??null);
  if(live.alert)return{label:'Token budget reached',detail:`${formatTokens(live.consumed!)} of ${formatTokens(budget.granted)} tokens used. You can pause this execution now; otherwise it may finish within the 25% grace and Factory stops it at 125%.`,since:run.started_at,lastProgressAt:progress?.lastProgressAt??null,progressEvents:progress?.events??0,warning:true,stalled:false};
  const activity=progress?.tool?`${progress.tool} is running`:progress?.lastTool?`Last tool: ${progress.lastTool}`:progress?.events?`${progress.events} provider events recorded`:'No provider activity recorded yet';
  const warningText=warning?.reason==="repeated-action"?`${activity}. The same action was attempted ${warning.repeated} times; review it before interrupting.`:warning?`${activity}. No observable progress for ${Math.floor(warning.idleMs/60000)} minutes; this does not prove the agent is stuck.`:activity;
  return {label:warning?'Check agent progress':'Agent running',detail:warningText,since:run.started_at,lastProgressAt:progress?.lastProgressAt??null,progressEvents:progress?.events??0,warning:Boolean(warning),stalled:false};
 }
 if(failure){const diagnosis=diagnoseWorkItem(store,id);return {label:'Failed',detail:failure.message,diagnosis:{summary:diagnosis.summary,evidence:diagnosis.evidence,nextAction:diagnosis.nextAction},stalled:false};}
 const last=store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='workflow.transition' ORDER BY id DESC LIMIT 1").get(id) as {payload:string}|undefined;
 let reason='';try{reason=JSON.parse(last?.payload??'{}').reason?.summary??'';}catch{}
 const findings=status==='PAUSED'?store.db.prepare("SELECT payload FROM records WHERE work_item_id=? AND kind='finding' AND status='open' ORDER BY sequence DESC LIMIT 3").all(id) as {payload:string}[]:[];
 const details=findings.map(row=>{try{return JSON.parse(row.payload).evidence as string;}catch{return '';}}).filter(Boolean);
 return {label:status==='PAUSED'?'Paused':status==='WAITING'?'Waiting for you':status,detail:reason,blockers:details,stalled:false};
}

import type {Store} from './storage.js';
import {diagnoseWorkItem} from './failure-diagnostics.js';
export function workflowActivity(store:Store,id:string,status:string,now=Date.now()){
 const run=store.db.prepare('SELECT e.status,e.started_at,e.finished_at FROM executions e JOIN work_items w ON w.active_run_id=e.id WHERE w.id=?').get(id) as {status:string;started_at:string;finished_at:string|null}|undefined;
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
  return {label:'Agent running',detail:'Agent execution is in progress.',since:run.started_at,stalled:false};
 }
 if(failure){const diagnosis=diagnoseWorkItem(store,id);return {label:'Failed',detail:failure.message,diagnosis:{summary:diagnosis.summary,evidence:diagnosis.evidence,nextAction:diagnosis.nextAction},stalled:false};}
 const last=store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='workflow.transition' ORDER BY id DESC LIMIT 1").get(id) as {payload:string}|undefined;
 let reason='';try{reason=JSON.parse(last?.payload??'{}').reason?.summary??'';}catch{}
 const findings=status==='PAUSED'?store.db.prepare("SELECT payload FROM records WHERE work_item_id=? AND kind='finding' AND status='open' ORDER BY sequence DESC LIMIT 3").all(id) as {payload:string}[]:[];
 const details=findings.map(row=>{try{return JSON.parse(row.payload).evidence as string;}catch{return '';}}).filter(Boolean);
 return {label:status==='PAUSED'?'Paused':status==='WAITING'?'Waiting for you':status,detail:reason,blockers:details,stalled:false};
}

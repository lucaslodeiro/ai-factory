import type {Store} from "./storage.js";
import {progressKey,progressWarning,type ExecutionProgress} from "./execution-progress.js";
import {WorkflowProjections} from "./workflow-projection.js";

// The status comment on GitHub is only rewritten when the workflow's presentation changes, so a
// long run read as frozen there: "The current agent is running" for half an hour with nothing
// else. A heartbeat republishes it while an agent runs, rate-limited so it stays one edit every
// few minutes, and at once when the run starts or stops looking stuck.
export const heartbeatIntervalMs=5*60_000;
export interface Heartbeat {runId:string;at:number;events:number;warning:string|null}

/** Whether the running agent's status should be republished now. */
export function heartbeatDue(previous:Heartbeat|undefined,current:Omit<Heartbeat,"at">,startedAt:string,now:number,intervalMs=heartbeatIntervalMs){
 const last=previous?.runId===current.runId?previous:{runId:current.runId,at:Date.parse(startedAt),events:0,warning:null};
 if(current.warning!==last.warning)return true;
 return now-last.at>=intervalMs&&current.events!==last.events;
}

export function publishHeartbeats(store:Store,now=Date.now()){
 const projections=new WorkflowProjections(store);let published=0;
 const running=store.db.prepare("SELECT w.id,w.revision,e.id run_id,e.started_at FROM work_items w JOIN executions e ON e.id=w.active_run_id WHERE w.status='RUNNING' AND w.archived_at IS NULL AND e.status='running'").all() as Array<{id:string;revision:number;run_id:string;started_at:string}>;
 for(const item of running){
  const progress=store.metadata<ExecutionProgress>(progressKey(item.run_id)),key=`progress-heartbeat:${item.id}`;
  const current={runId:item.run_id,events:progress?.events??0,warning:progressWarning(progress,item.started_at,now)?.reason??null};
  if(!heartbeatDue(store.metadata<Heartbeat>(key),current,item.started_at,now))continue;
  try{projections.present({workItemId:item.id,expectedRevision:item.revision,actor:{type:"orchestrator",id:"heartbeat"},source:{executionId:item.run_id},
   reason:{code:"progress",summary:current.warning==="inactivity"?"No observable agent progress for five minutes":current.warning==="repeated-action"?"The agent is repeating the same action":"Agent progress updated"}});}
  catch{continue;} // The workflow moved on in between; its own transition publishes the new state.
  store.setMetadata(key,{...current,at:now} satisfies Heartbeat);published++;
 }
 return published;
}

import type {Store} from "./storage.js";
import {WorkflowProjections} from "./workflow-projection.js";

export interface ControllerFence {
 assertController():void;
 resultDisposition():"apply"|"hold"|"discard";
}

export function applyControllerLoss(store:Store,executions:{interrupt(runId:string,reason:string):unknown},runner:{discardHeld():void},generation:number){
 runner.discardHeld();
 const projections=new WorkflowProjections(store);
 for(const row of store.db.prepare("SELECT id,active_run_id FROM work_items WHERE archived_at IS NULL AND status='RUNNING'").all() as Array<{id:string;active_run_id:string}>){
  executions.interrupt(row.active_run_id,"controller-lost");const current=projections.get(row.id);
  projections.transition({workItemId:row.id,expectedRevision:current.revision,stage:current.stage,status:"PAUSED",actor:{type:"orchestrator",id:"controller"},source:{executionId:row.active_run_id},reason:{code:"controller-lost",summary:"Repository control moved to another installation"}});
 }
 store.event("controller.lost",{generation});
}

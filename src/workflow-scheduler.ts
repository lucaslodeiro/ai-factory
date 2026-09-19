import { randomUUID } from "node:crypto";
import type { Store } from "./storage.js";
import type { AgentRole } from "./types.js";
import { WorkflowFailures,type FailureClass } from "./workflow-failures.js";
import { WorkflowProjections } from "./workflow-projection.js";
import type { V3Stage } from "./workflow-records.js";

const roles:Record<V3Stage,AgentRole>={DESIGN:"product-architect",BUILD:"developer",TEST:"qa",REVIEW:"reviewer",DELIVERY:"reviewer"};

export class WorkflowScheduler {
 private projections:WorkflowProjections;private failures:WorkflowFailures;
 constructor(private store:Store){this.projections=new WorkflowProjections(store);this.failures=new WorkflowFailures(store);}
 role(workItemId:string){const stage=this.projections.get(workItemId).stage;if(stage==="DELIVERY")throw new Error("Delivery has no agent scheduler role");return roles[stage];}
 begin(workItemId:string) {
  const current=this.projections.get(workItemId);if(current.status!=="QUEUED")throw new Error(`Cannot schedule workflow while it is ${current.status}`);
  const role=this.role(workItemId);
  if(current.stage!=="DESIGN"){
   const spec=this.store.db.prepare("SELECT approved_by FROM specs WHERE work_item_id=? ORDER BY version DESC LIMIT 1").get(workItemId) as {approved_by:string|null}|undefined;
   if(!spec?.approved_by)throw new Error("Cannot schedule delivery without an approved current specification");
  }
  const blocked=this.store.db.prepare(`SELECT 1 FROM maintenance_items mi JOIN maintenance_operations mo ON mo.id=mi.maintenance_id
   WHERE mi.work_item_id=? AND mi.resumed_at IS NULL AND mo.status IN ('confirmed','pausing','ready','running')`).get(workItemId);
  if(blocked)throw new Error("Confirmed maintenance prevents new agent execution");
  const id=randomUUID(),startedAt=new Date().toISOString();
  const projection=this.projections.transition({workItemId,expectedRevision:current.revision,stage:current.stage,status:"RUNNING",activeRunId:id,actor:{type:"orchestrator",id:"scheduler"},source:{executionId:id},reason:{code:"execution-started",summary:`${role} execution started`}},()=>{
   this.store.db.prepare("INSERT INTO executions(id,work_item_id,role,workflow_state,status,started_at) VALUES(?,?,?,?,?,?)").run(id,workItemId,role,current.stage,"running",startedAt);
  });
  return {executionId:id,role,projection};
 }
 fail(workItemId:string,executionId:string,error:unknown,failureClass:FailureClass="execution") {
  const current=this.projections.get(workItemId);
  if(current.status!=="RUNNING"||current.activeRunId!==executionId){this.store.event("execution.discarded",{executionId,reason:"Workflow changed before execution failure was applied"},workItemId,executionId);return {discarded:true,projection:current};}
  let failureId="";const message=error instanceof Error?error.message:String(error);
  const projection=this.projections.transition({workItemId,expectedRevision:current.revision,stage:current.stage,status:"FAILED",actor:{type:"orchestrator",id:"runner"},source:{executionId},reason:{code:`${failureClass}-failure`,summary:message}},()=>{failureId=this.failures.open({workItemId,executionId,class:failureClass,message,stage:current.stage,attempt:current.attempt}).id;});
  return {discarded:false,projection,failureId};
 }
}

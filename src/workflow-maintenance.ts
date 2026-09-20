import {randomUUID} from "node:crypto";
import type {Store} from "./storage.js";
import type {ExecutionManager} from "./execution-manager.js";
import {WorkflowProjections,type V3Status} from "./workflow-projection.js";

export type MaintenanceOperation="update"|"daemon-stop"|"daemon-restart"|"uninstall"|"configuration-apply"|"signal"|"user-pause";
export interface AffectedWork {id:string;issueNumber:number;title:string;stage:string;status:"QUEUED"|"RUNNING";revision:number;role:string;elapsedMs:number;activeRunId?:string;processActive:boolean;}
const roles:Record<string,string>={DESIGN:"Architect",BUILD:"Builder",TEST:"Tester",REVIEW:"Reviewer",DELIVERY:"Delivery"};

export class WorkflowMaintenance {
 private projections:WorkflowProjections;
 constructor(private store:Store,private executions:ExecutionManager){this.projections=new WorkflowProjections(store);}
 request(operation:MaintenanceOperation,actor:string,ttlMs=300_000){
  const id=randomUUID(),requestedAt=new Date().toISOString(),affected=this.affected();
  this.store.db.transaction(()=>{
   this.store.db.prepare("INSERT INTO maintenance_operations(id,operation,actor,status,requested_at,error) VALUES(?,?,?,?,?,?)").run(id,operation,actor,"requested",requestedAt,JSON.stringify({expiresAt:new Date(Date.now()+ttlMs).toISOString()}));
   for(const item of affected)this.store.db.prepare("INSERT INTO maintenance_items(maintenance_id,work_item_id,confirmed_revision) VALUES(?,?,?)").run(id,item.id,item.revision);
   this.store.event("maintenance.requested",{maintenanceId:id,operation,actor,affected:affected.map(item=>item.id)});
  }).immediate();
  return {id,operation,actor,requestedAt,expiresAt:new Date(Date.now()+ttlMs).toISOString(),affected,confirmationRequired:affected.length>0};
 }
 async confirm(id:string,timeoutMs=30_000){
  const operation=this.operation(id);if(operation.status!=="requested")throw new Error(`Maintenance ${id} is ${operation.status}`);
  const meta=this.metadata(operation.error);if(meta.expiresAt&&Date.parse(meta.expiresAt)<Date.now())return this.fail(id,"Confirmation expired");
  const expected=this.items(id),actual=this.affected();
  if(expected.length!==actual.length||expected.some(item=>!actual.some(current=>current.id===item.work_item_id&&current.revision===item.confirmed_revision)))return this.fail(id,"Active work changed; run preflight again");
  const blocking=this.store.db.transaction(()=>{
   const active=this.store.db.prepare("SELECT id FROM maintenance_operations WHERE id<>? AND status IN ('confirmed','pausing','ready','running') LIMIT 1").get(id) as {id:string}|undefined;
   // Shutdown signals must still be able to stop a daemon during an update.
   if(active&&operation.operation!=="signal")return active.id;
   this.store.db.prepare("UPDATE maintenance_operations SET status='confirmed',confirmed_at=?,error=NULL WHERE id=?").run(new Date().toISOString(),id);
  }).immediate();
  if(blocking)return this.fail(id,`Maintenance ${blocking} is already active`);
  this.store.event("maintenance.confirmed",{maintenanceId:id,operation:operation.operation,actor:operation.actor,affected:expected.map(item=>item.work_item_id)});
  this.store.db.prepare("UPDATE maintenance_operations SET status='pausing' WHERE id=?").run(id);
  for(const item of expected){
   const current=this.projections.get(item.work_item_id),run=current.activeRunId;
   this.projections.transition({workItemId:item.work_item_id,expectedRevision:current.revision,stage:current.stage,status:"PAUSED",actor:{type:"orchestrator",id:"maintenance"},source:{executionId:run},reason:{code:"planned-maintenance",summary:`Paused for ${operation.operation}`}},()=>{
    this.store.db.prepare("UPDATE maintenance_items SET paused_at=? WHERE maintenance_id=? AND work_item_id=?").run(new Date().toISOString(),id,item.work_item_id);
    if(run)this.store.db.prepare("UPDATE executions SET maintenance_id=?,interruption_reason=? WHERE id=?").run(id,"planned-maintenance",run);
   });
   if(run)this.executions.interrupt(run,"planned-maintenance");
   this.store.event("maintenance.task_paused",{maintenanceId:id,operation:operation.operation,workItemId:item.work_item_id,executionId:run??null},item.work_item_id,run);
  }
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){if(this.ready(id)){this.store.db.prepare("UPDATE maintenance_operations SET status='ready' WHERE id=?").run(id);this.store.event("maintenance.ready",{maintenanceId:id,operation:operation.operation,affected:expected.map(item=>item.work_item_id)});return {id,status:"ready" as const};}await new Promise(resolve=>setTimeout(resolve,25));}
  return this.fail(id,"Timed out waiting for interrupted executions to exit");
 }
 markStarted(id:string){const operation=this.operation(id);if(operation.status!=="ready")throw new Error(`Maintenance ${id} is not ready`);this.store.db.prepare("UPDATE maintenance_operations SET status='running' WHERE id=?").run(id);this.store.event("maintenance.started",{maintenanceId:id,operation:operation.operation});}
 complete(id:string){const operation=this.operation(id);if(!["ready","running"].includes(operation.status))throw new Error(`Maintenance ${id} cannot complete from ${operation.status}`);this.store.db.prepare("UPDATE maintenance_operations SET status='completed',finished_at=? WHERE id=?").run(new Date().toISOString(),id);this.store.event("maintenance.completed",{maintenanceId:id,operation:operation.operation});}
 resume(id:string){const operation=this.operation(id);if(!["ready","running","completed","failed"].includes(operation.status))throw new Error(`Maintenance ${id} cannot resume tasks from ${operation.status}`);const resumed:string[]=[];
  for(const item of this.items(id)){if(item.resumed_at)continue;const current=this.projections.get(item.work_item_id);if(current.status!=="PAUSED")continue;const status=this.projections.resumeStatus(item.work_item_id);this.projections.transition({workItemId:item.work_item_id,expectedRevision:current.revision,stage:current.stage,status,attemptDelta:status==="QUEUED"?1:0,actor:{type:"human",id:operation.actor},source:{},reason:{code:"maintenance-resumed",summary:`Resumed after ${operation.operation}`}},()=>this.store.db.prepare("UPDATE maintenance_items SET resumed_at=? WHERE maintenance_id=? AND work_item_id=?").run(new Date().toISOString(),id,item.work_item_id));resumed.push(item.work_item_id);}
  this.store.event("maintenance.tasks_resumed",{maintenanceId:id,operation:operation.operation,affected:resumed});return resumed;
 }
 async pauseForSignal(signal:string){const request=this.request("signal",`os:${signal}`);await this.confirm(request.id);this.complete(request.id);return {id:request.id,status:"completed" as const};}
 reconcileSignalsAfterRestart(){
  const rows=this.store.db.prepare("SELECT id,status FROM maintenance_operations WHERE operation='signal' AND status IN ('confirmed','pausing','ready','running')").all() as Array<{id:string;status:string}>;
  for(const row of rows){this.store.db.prepare("UPDATE maintenance_operations SET status='completed',finished_at=? WHERE id=?").run(new Date().toISOString(),row.id);this.store.event("maintenance.completed",{maintenanceId:row.id,operation:"signal",recoveredFrom:row.status});}
  return rows.length;
 }
 affected():AffectedWork[]{const now=Date.now();return (this.store.db.prepare(`SELECT w.id,w.issue_number,w.stage,w.status,w.revision,w.active_run_id,w.context,e.started_at FROM work_items w LEFT JOIN executions e ON e.id=w.active_run_id WHERE w.archived_at IS NULL AND w.status IN ('QUEUED','RUNNING') ORDER BY w.issue_number`).all() as any[]).map(row=>{let context:any={};try{context=JSON.parse(row.context||"{}");}catch{}return{id:row.id,issueNumber:row.issue_number,title:context.title??`Issue #${row.issue_number}`,stage:row.stage,status:row.status,revision:row.revision,role:roles[row.stage]??row.stage,elapsedMs:row.started_at?Math.max(0,now-Date.parse(row.started_at)):0,activeRunId:row.active_run_id??undefined,processActive:row.active_run_id?this.executions.isRunning(row.active_run_id):false};});}
 private ready(id:string){return this.items(id).every(item=>{const projection=this.projections.get(item.work_item_id);if(projection.status!=="PAUSED")return false;const row=this.store.db.prepare("SELECT id,status FROM executions WHERE maintenance_id=? AND work_item_id=? ORDER BY started_at DESC LIMIT 1").get(id,item.work_item_id) as {id:string;status:string}|undefined;return !row||(row.status!=="running"&&!this.executions.isRunning(row.id));});}
 private fail(id:string,error:string){const operation=this.operation(id);this.store.db.prepare("UPDATE maintenance_operations SET status='failed',finished_at=?,error=? WHERE id=?").run(new Date().toISOString(),error,id);this.store.event("maintenance.failed",{maintenanceId:id,operation:operation.operation,error});throw new Error(error);}
 private operation(id:string){const row=this.store.db.prepare("SELECT * FROM maintenance_operations WHERE id=?").get(id) as any;if(!row)throw new Error("Unknown maintenance operation");return row;}
 private items(id:string){return this.store.db.prepare("SELECT * FROM maintenance_items WHERE maintenance_id=? ORDER BY work_item_id").all(id) as Array<{work_item_id:string;confirmed_revision:number;paused_at:string|null;resumed_at:string|null}>;}
 private metadata(error:string|null){try{return JSON.parse(error??"{}") as {expiresAt?:string};}catch{return {};}}
}

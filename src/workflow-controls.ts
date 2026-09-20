import type {Store} from './storage.js';
import type {WorkflowCommands} from './workflow-commands.js';
import type {ExecutionManager} from './execution-manager.js';

export type WorkControl='pause'|'resume'|'retry'|'cancel';
export function workActions(status:string):WorkControl[]{
 switch(status){
  case 'QUEUED':case 'RUNNING':case 'WAITING':return ['pause','cancel'];
  case 'PAUSED':return ['resume','cancel'];
  case 'FAILED':return ['retry','cancel'];
  case 'CANCELLED':return ['retry'];
  default:return [];
 }
}
export function validateWorkControl(store:Store,kind:string,target:string){
 const run=kind==='cancel'?store.db.prepare("SELECT work_item_id FROM executions WHERE id=? AND status='running'").get(target) as {work_item_id:string}|undefined:undefined;
 const id=run?.work_item_id??target;
 const item=store.db.prepare('SELECT status,archived_at FROM work_items WHERE id=?').get(id) as {status:string;archived_at:string|null}|undefined;
 if(!item||item.archived_at)throw new Error('Unknown work item');
 if(!workActions(item.status).includes(kind as WorkControl))throw new Error(`Cannot ${kind} while workflow is ${item.status}`);
 return id;
}
export function applyWorkControl(store:Store,commands:WorkflowCommands,executions:ExecutionManager,control:{id:number;kind:string;target:string}){
 // Revalidate here: the workflow may have changed since the dashboard request.
 const workItemId=validateWorkControl(store,control.kind,control.target);
 const specVersion=(store.db.prepare('SELECT COALESCE(MAX(version),0) version FROM specs WHERE work_item_id=?').get(workItemId) as {version:number}).version;
 const command=control.kind==='resume'||control.kind==='retry'?{kind:'retry' as const,guidance:'',scope:'spec' as const,appliesTo:[]}:{kind:control.kind as 'pause'|'cancel',reason:''};
 const result=commands.apply(command,{workItemId,login:'dashboard',commentId:control.id,specVersion});
 if(result.executionAction?.kind==='interrupt')executions.interrupt(result.executionAction.runId,result.executionAction.reason);
 if(result.executionAction?.kind==='cancel')executions.cancel(result.executionAction.runId);
 return result;
}

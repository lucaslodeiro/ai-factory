import type {Store} from './storage.js';
import {WorkflowProjections} from './workflow-projection.js';
import {WorkflowFailures} from './workflow-failures.js';
// Only repair pauses created by the old broad defer rule. Human and maintenance
// pauses, including a later intentional pause, must remain untouched.
export function recoverLegacyResultPauses(store:Store){
 const items=store.db.prepare("SELECT id FROM work_items WHERE status='PAUSED' AND archived_at IS NULL").all() as {id:string}[];
 for(const item of items){
  const row=store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='workflow.transition' ORDER BY id DESC LIMIT 1").get(item.id) as {payload:string}|undefined;
  let event:any;try{event=JSON.parse(row?.payload??'{}');}catch{continue;}
  if(event.reason?.code!=='tactical-resolved'||event.reason?.summary!=='Architect reported unresolved prerequisites; work paused for review'||event.actor?.id!=='product-architect')continue;
  const findings=store.db.prepare("SELECT payload FROM records WHERE work_item_id=? AND kind='finding' AND status='open' ORDER BY sequence DESC LIMIT 3").all(item.id) as {payload:string}[];
  const evidence=findings.map(row=>{try{return JSON.parse(row.payload).evidence as string;}catch{return '';}}).filter(Boolean).join('\n');
  const message=`The previous result reported unresolved prerequisites and was incorrectly paused. Review the reported cause before Retry.${evidence?'\n'+evidence:''}`;
  const projections=new WorkflowProjections(store),current=projections.get(item.id);
  projections.transition({workItemId:item.id,expectedRevision:current.revision,stage:current.stage,status:'FAILED',actor:{type:'orchestrator',id:'recovery'},source:{},reason:{code:'legacy-result-failure',summary:message}},()=>new WorkflowFailures(store).open({workItemId:item.id,class:'recovery',message,stage:current.stage,attempt:current.attempt}));
 }
}

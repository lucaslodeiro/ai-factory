import type {Store} from './storage.js';
import {WorkflowRecords} from './workflow-records.js';
export function workflowNextStep(store:Store,id:string,status:string,pr?:string){
 if(status!=='WAITING')return null;
 const request=new WorkflowRecords(store).activeRequest(id);
 if(request?.payload.kind!=='request'||request.payload.owner!=='human')return null;
 const type=request.payload.type;
 // Links are read-only navigation. A merge always happens explicitly on GitHub.
 const prUrl=pr&&/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(pr)?pr:null;
 if(type==='merge')return {title:request.payload.prClosed?'Pull request closed without merge':'Pull request ready for your review',url:prUrl,respondLabel:'Request changes',command:'/factory answer <changes>',needsAttention:!prUrl};
 if(type==='budget')return request.payload.budget==='unknown'?{title:'Unmeasured runs need acknowledgement',url:null,respondLabel:'Acknowledge',command:'/factory budget +0'}:{title:'Token budget reached',url:null,respondLabel:'Extend budget',command:'/factory budget +<tokens> [reason]'};
 if(type==='spec-approval')return {title:'Specification brief waiting for your approval',url:null,respondLabel:'Approve or request changes',command:`/factory approve v${request.specVersion}`};
 return {title:type==='correction-limit'?'Your guidance is needed to continue':'Waiting for your answer',url:null,respondLabel:type==='correction-limit'?'Give guidance':'Answer',command:'/factory answer <guidance>'};
}

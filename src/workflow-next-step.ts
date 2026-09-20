import type {Store} from './storage.js';
import {WorkflowRecords} from './workflow-records.js';
export function workflowNextStep(store:Store,id:string,status:string,pr?:string){
 if(status!=='WAITING')return null;
 const request=new WorkflowRecords(store).activeRequest(id);
 if(request?.payload.kind!=='request'||request.payload.owner!=='human')return null;
 const type=request.payload.type;
 // Links are read-only navigation. A merge always happens explicitly on GitHub.
 const prUrl=pr&&/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(pr)?pr:null;
 if(type==='merge')return {title:request.payload.prClosed?'Pull request closed without merge':'Pull request ready for your review',description:request.payload.prClosed?'Reopen and review the pull request, or request changes in the issue.':'The branch was published. Review the pull request and merge it on GitHub, or request changes in the issue.',url:prUrl,linkLabel:'Open pull request',command:'/factory answer <changes>',commandHelp:'To request changes, post this command in the issue:',needsAttention:!prUrl};
 if(type==='spec-approval')return {title:'Specification waiting for your approval',description:'Review the proposed specification in the issue, then approve it or reply with changes.',url:null,linkLabel:'',command:`/factory approve v${request.specVersion}`,commandHelp:'To approve, post this command in the issue:'};
 return {title:type==='correction-limit'?'Your guidance is needed to continue':'Waiting for your answer',description:type==='correction-limit'?'Automatic corrections reached their limit. Review the findings in the issue and provide guidance.':'Review the questions in the issue and reply with the missing information.',url:null,linkLabel:'',command:'/factory answer <guidance>',commandHelp:'Post your reply in the issue:'};
}

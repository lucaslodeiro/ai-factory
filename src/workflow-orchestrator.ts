import type {RuntimeGitHub} from "./github-runtime.js";
import { config } from "./config.js";
import type { Issue } from "./adapters/github.js";
import type { Store } from "./storage.js";
import { WorkflowIntake,WorkflowInbox,type ExecutionControl } from "./workflow-inbox.js";
import { WorkflowGitHubPublisher } from "./workflow-github.js";
import { WorkflowRunner } from "./workflow-runner.js";
import { WorkflowProjections } from "./workflow-projection.js";
import { WorkflowRecords } from "./workflow-records.js";
import { deliverNotifications,type NotificationPort } from "./notifications.js";
import {pruneExecutionArtifacts} from "./artifact-retention.js";

type GitHub=RuntimeGitHub;
type ItemRow={id:string;issue_number:number;issue_id:number|null;repo:string;stage:string;status:string;revision:number;archived_at:string|null;context:string};

export class WorkflowOrchestrator {
 private intake:WorkflowIntake;private inbox:WorkflowInbox;private publisher:WorkflowGitHubPublisher;private projections:WorkflowProjections;private records:WorkflowRecords;private assigned:Issue[]=[];
 constructor(readonly store:Store,private github:GitHub,private runner:WorkflowRunner,private notifications:NotificationPort,private executions?:ExecutionControl){this.intake=new WorkflowIntake(store);this.inbox=new WorkflowInbox(store,{comments:()=>{throw new Error("Remote comments must be fetched asynchronously");}},config.approvers,executions);this.publisher=new WorkflowGitHubPublisher(store,github);this.projections=new WorkflowProjections(store);this.records=new WorkflowRecords(store);}
 async tick(){await this.syncRemote();await this.runLocal();await this.flush();}
 async syncRemote(){
  const since=(this.store.db.prepare("SELECT COALESCE(MAX(id),0) id FROM events").get() as {id:number}).id;
  const login=this.store.metadata<string>("runtime:factory-account")??await this.github.authenticatedLogin();this.assigned=await this.github.assignedIssues(login);
  await this.reconcileAssignments(login);await this.reconcileIssueVisibility();await this.reconcilePullRequests();
  for(const item of this.rows())if(!item.archived_at){const comments=await this.github.comments(item.issue_number);if(!this.row(item.id).archived_at)this.inbox.poll(item.id,comments);}
  await this.flush();
  if(this.store.db.prepare("SELECT 1 FROM events WHERE id>? AND type IN ('github.pr_poll_failed','github.issue_state_failed') LIMIT 1").get(since))throw new Error("Some GitHub checks failed; inspect daemon logs. Local processing remains independent.");
 }
 async runLocal(){
  this.runner.reconcileFinished();
  if(this.store.db.prepare("SELECT 1 FROM maintenance_operations WHERE status IN ('confirmed','pausing','ready','running') LIMIT 1").get())return;
  // One execution at a time, with the oldest queued item first. Each completion
  // releases the local lane immediately; remote polling never owns this lane.
  const item=this.rows().find(item=>!item.archived_at&&item.status==="QUEUED");
  if(item){this.store.setMetadata("runtime:local-work",{id:item.id,stage:item.stage,since:new Date().toISOString()});try{await this.runner.run(item.id);}finally{this.store.setMetadata("runtime:local-work",null);}}
  const last=this.store.metadata<number>("artifact-retention:last")??0;if(Date.now()-last>3_600_000){pruneExecutionArtifacts(this.store);this.store.setMetadata("artifact-retention:last",Date.now());}
  return Boolean(item);
 }
 async startIssue(reference:string){const number=this.issueNumber(reference),issue=await this.github.issue(number),login=this.store.metadata<string>("runtime:factory-account")??await this.github.authenticatedLogin();if(issue.state!=="OPEN"||issue.pullRequest)throw new Error(`#${number} is not an open issue`);const own=`factory-instance:${config.instanceName}`;await this.github.ensureLabel(own,"0969da",`AI Factory instance ${config.instanceName}`);await this.github.assign(number,[login]);await this.github.replaceInstanceLabel(number,own);return{issue:number,claimed:true,instance:config.instanceName};}
 async claimIssue(reference:string){const number=this.issueNumber(reference),own=`factory-instance:${config.instanceName}`;await this.github.ensureLabel(own,"0969da",`AI Factory instance ${config.instanceName}`);await this.github.replaceInstanceLabel(number,own);return{issue:number,claimed:true,instance:config.instanceName};}
 private async reconcileAssignments(login:string){
  const own=`factory-instance:${config.instanceName}`,view:Array<Record<string,unknown>>=[];
  await this.github.ensureLabel(own,"0969da",`AI Factory instance ${config.instanceName}`);
  const assignedIds=new Set(this.assigned.map(issue=>issue.id));
  for(const issue of this.assigned){
   const labels=(issue.labels??[]).map(label=>label.name),instances=labels.filter(label=>label.startsWith("factory-instance:")),local=this.rows().find(item=>item.issue_id===issue.id);
   if(local){
    if(local.archived_at){view.push({issue:issue.number,state:"worked-here",instances});continue;}
    if(["COMPLETED","CANCELLED"].includes(local.status)){await this.github.unassign(local.issue_number,[login]);await this.github.removeLabel(local.issue_number,own);view.push({issue:issue.number,state:"released",instances:[]});continue;}
    if(!instances.length){await this.github.addLabel(issue.number,own);this.store.event("issue.claimed",{issue:issue.number,instance:config.instanceName},local.id);view.push({issue:issue.number,state:"claiming",instances:[own]});continue;}
    if(instances.length===1&&instances[0]===own){if(local.status==="PAUSED"&&["unassigned","moved"].includes(this.lastReason(local.id))){const current=this.projections.get(local.id),status=this.projections.resumeStatus(local.id);this.projections.transition({workItemId:local.id,expectedRevision:current.revision,stage:current.stage,status,attemptDelta:status==="QUEUED"?1:0,actor:{type:"github",id:login},source:{},reason:{code:"reassigned",summary:"Issue reassigned to this Factory instance"}});}view.push({issue:issue.number,state:"worked-here",instances});continue;}
    await this.pauseOwned(local,instances.includes(own)?"moved":"moved");view.push({issue:issue.number,state:instances.includes(own)?"claim-conflict":"other-instance",instances});continue;
   }
   if(!instances.length){await this.github.addLabel(issue.number,own);this.store.event("issue.claimed",{issue:issue.number,instance:config.instanceName});view.push({issue:issue.number,state:"claiming",instances:[own]});continue;}
   if(instances.includes(own)&&instances.length===1){
    const comments=await this.github.comments(issue.number),foreign=comments.some(comment=>comment.body.includes("<!-- ai-factory:workflow-status"));
    if(foreign){this.eventOnce(`continuation:${issue.id}`,"issue.continuation_pending",{issue:issue.number,instance:config.instanceName});view.push({issue:issue.number,state:"continuation-pending",instances});continue;}
    const cursor=Math.max(0,...comments.map(comment=>comment.id));this.intake.start(issue,{actor:login,initialCursor:cursor,source:"assignment"});view.push({issue:issue.number,state:"worked-here",instances});continue;
   }
   if(instances.includes(own)){const key=`conflict:${issue.id}:${[...instances].sort().join(",")}`;this.eventOnce(key,"issue.claim_conflict",{issue:issue.number,instances:[...instances].sort()});view.push({issue:issue.number,state:"claim-conflict",instances});}
   else view.push({issue:issue.number,state:"other-instance",instances});
  }
  for(const local of this.rows().filter(item=>!item.archived_at&&!assignedIds.has(item.issue_id??-1))){
   if(["COMPLETED","CANCELLED"].includes(local.status)){await this.github.unassign(local.issue_number,[login]);await this.github.removeLabel(local.issue_number,own);continue;}
   const remote=await this.github.issue(local.issue_number);if(remote.state!=="OPEN")continue;await this.pauseOwned(local,"unassigned");await this.github.removeLabel(local.issue_number,own);view.push({issue:local.issue_number,state:"unassigned",instances:[]});
  }
  this.store.setMetadata("runtime:assigned-issues",view);
 }
 private async pauseOwned(item:ItemRow,reason:"unassigned"|"moved"){
  const current=this.projections.get(item.id);if(current.status==="PAUSED"&&this.lastReason(item.id)===reason)return;
  if(["COMPLETED","CANCELLED","PAUSED"].includes(current.status))return;
  this.projections.transition({workItemId:item.id,expectedRevision:current.revision,stage:current.stage,status:"PAUSED",actor:{type:"github",id:"assignment"},source:{executionId:current.activeRunId},reason:{code:reason,summary:reason==="unassigned"?"Issue unassigned from the Factory account":"Issue moved to another Factory instance"}});
  if(current.activeRunId){this.executions?.interrupt(current.activeRunId,reason);const deadline=Date.now()+30_000;while(Date.now()<deadline){const row=this.store.db.prepare("SELECT status FROM executions WHERE id=?").get(current.activeRunId) as {status:string}|undefined;if(!row||row.status!=="running")break;await new Promise(resolve=>setTimeout(resolve,25));}}
  try{await this.runner.preserve(item.id);}catch(error){this.store.event("workflow.preserve_failed",{reason,error:String(error)},item.id,current.activeRunId);}
 }
 private lastReason(id:string){const row=this.store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='workflow.transition' ORDER BY id DESC LIMIT 1").get(id) as {payload:string}|undefined;return row?(JSON.parse(row.payload) as {reason?:{code?:string}}).reason?.code??"":"";}
 private eventOnce(key:string,type:string,payload:Record<string,unknown>){const metadata=`ownership:${config.repo}:${key}`;if(this.store.metadata(metadata))return;this.store.event(type,payload);this.store.setMetadata(metadata,true);}
 async refreshIssueList(){
  let updated=0;for(const item of this.rows()){let remote:Issue;try{remote=await this.github.issue(item.issue_number);}catch(error){this.store.event("github.issue_state_failed",{issue:item.issue_number,error:String(error)},item.id);continue;}await this.reconcileIssue(item,remote);if(remote.state==="OPEN"&&!this.row(item.id).archived_at){this.inbox.poll(item.id,await this.github.comments(item.issue_number));updated++;}}
  const found=this.rows().filter(item=>!item.archived_at).length;this.store.event("github.issue_list_refreshed",{found,added:0,updated});return {found,added:0,updated};
 }
 async reconcilePullRequests(){
  for(const item of this.rows()){
   if(item.archived_at||item.stage!=="DELIVERY"||item.status!=="WAITING")continue;const context=JSON.parse(item.context||"{}") as {pr?:string;merge?:unknown};if(!context.pr)continue;
   try{const remote=await this.github.pullRequestState(context.pr);const latest=this.row(item.id);if(latest.archived_at||latest.stage!=="DELIVERY"||latest.status!=="WAITING")continue;item.revision=latest.revision;const request=this.records.activeRequest(item.id);if(!request||request.payload.kind!=="request"||request.payload.type!=="merge")continue;
    if(remote.state==="MERGED")this.projections.transition({workItemId:item.id,expectedRevision:item.revision,stage:"DELIVERY",status:"COMPLETED",actor:{type:"github",id:"pull-request"},source:{},reason:{code:"pr-merged",summary:"Pull request merged"},recordIds:[request.id]},()=>{this.records.resolveRequest(request.id);this.updateContext(item.id,{merge:{at:remote.mergedAt,commit:remote.mergeCommit?.oid??null}});});
    else if(Boolean(request.payload.prClosed)!==(remote.state==="CLOSED"))this.projections.present({workItemId:item.id,expectedRevision:item.revision,actor:{type:"github",id:"pull-request"},source:{},reason:{code:remote.state==="CLOSED"?"pr-closed":"pr-reopened",summary:remote.state==="CLOSED"?"Pull request closed without merge":"Pull request reopened"},recordIds:[request.id]},()=>{this.records.updateRequest(request.id,{prClosed:remote.state==="CLOSED"});});
   }catch(error){this.store.event("github.pr_poll_failed",{error:String(error),url:context.pr},item.id);}
  }
 }
 async flush(){

  try{await this.publisher.publishHelp();await this.publisher.publishResults();await this.publisher.publishChanged();}catch(error){this.store.event("github.projection_failed",{error:String(error)});throw error;}
  await deliverNotifications(this.store,this.notifications);
 }
 private async reconcileIssueVisibility(){for(const item of this.rows())try{await this.reconcileIssue(item,await this.github.issue(item.issue_number));}catch(error){this.store.event("github.issue_state_failed",{issue:item.issue_number,error:String(error)},item.id);}}
 private async reconcileIssue(item:ItemRow,remote:Issue){
  item=this.row(item.id);
  if(this.replaced(item,remote)){const current=this.projections.get(item.id);this.store.db.transaction(()=>{if(!["PAUSED","COMPLETED","CANCELLED"].includes(current.status))this.projections.transition({workItemId:item.id,expectedRevision:current.revision,stage:current.stage,status:"PAUSED",actor:{type:"github",id:"issue"},source:{},reason:{code:"issue-replaced",summary:"GitHub issue was deleted and recreated"}});this.store.db.prepare("UPDATE work_items SET archived_at=? WHERE id=?").run(new Date().toISOString(),item.id);this.store.db.prepare("UPDATE notifications SET sent=1,last_error=? WHERE work_item_id=? AND sent=0").run("Suppressed because the GitHub issue was replaced",item.id);this.store.event("github.issue_replaced",{issue:item.issue_number,previousIssueId:item.issue_id,currentIssueId:remote.id},item.id);}).immediate();return;}
  if(remote.state==="CLOSED"&&!item.archived_at){const current=this.projections.get(item.id);this.store.db.transaction(()=>{if(!["PAUSED","COMPLETED","CANCELLED"].includes(current.status))this.projections.transition({workItemId:item.id,expectedRevision:current.revision,stage:current.stage,status:"PAUSED",actor:{type:"github",id:"issue"},source:{},reason:{code:"issue-closed",summary:"GitHub issue closed manually"}});this.store.db.prepare("UPDATE work_items SET archived_at=? WHERE id=?").run(new Date().toISOString(),item.id);this.store.db.prepare("UPDATE notifications SET sent=1,last_error=? WHERE work_item_id=? AND sent=0").run("Suppressed because the GitHub issue is closed",item.id);this.store.event("github.issue_closed",{issue:item.issue_number,visibility:"archived"},item.id);}).immediate();return;}
  if(remote.state==="OPEN"&&item.archived_at){const current=this.projections.get(item.id),comments=(await this.github.comments(item.issue_number)),cursor=Math.max(this.cursor(item),...comments.map(comment=>comment.id),0);this.store.db.transaction(()=>{this.updateContext(item.id,{cursor});this.store.db.prepare("UPDATE work_items SET archived_at=NULL WHERE id=?").run(item.id);this.projections.present({workItemId:item.id,expectedRevision:current.revision,actor:{type:"github",id:"issue"},source:{},reason:{code:"issue-reopened",summary:"GitHub issue reopened; explicit retry required"}});this.store.event("github.issue_reopened",{issue:item.issue_number,status:"PAUSED"},item.id);}).immediate();}
  if(remote.state==="OPEN")this.updateIssueContext(item.id,remote);
 }
 private replaced(item:ItemRow,remote:Issue){if(!Number.isSafeInteger(item.issue_id)||!item.issue_id)throw new Error("Stored work item is missing its GitHub issue identity; unsupported workflow data");return item.issue_id!==remote.id;}
 private updateIssueContext(id:string,issue:Issue){const row=this.row(id),context=JSON.parse(row.context||"{}") as {title?:string;body?:string;url?:string};if(context.title===issue.title&&context.body===issue.body&&context.url===issue.url)return;if(context.title!==issue.title){const current=this.projections.get(id);this.projections.present({workItemId:id,expectedRevision:current.revision,actor:{type:"github",id:"issue"},source:{},reason:{code:"issue-title-updated",summary:"GitHub issue title updated"}},()=>this.updateContext(id,{title:issue.title,body:issue.body,url:issue.url}));}else this.updateContext(id,{title:issue.title,body:issue.body,url:issue.url});}
 private updateContext(id:string,values:Record<string,unknown>){const item=this.row(id),context=JSON.parse(item.context||"{}");this.store.db.prepare("UPDATE work_items SET context=?,updated_at=? WHERE id=?").run(JSON.stringify({...context,...values}),new Date().toISOString(),id);}
 private cursor(item:ItemRow){return (JSON.parse(item.context||"{}") as {cursor?:number}).cursor??0;}
 private rows(){return this.store.db.prepare("SELECT id,issue_number,issue_id,repo,stage,status,revision,archived_at,context FROM work_items ORDER BY created_at").all() as ItemRow[];}
 private row(id:string){const row=this.store.db.prepare("SELECT id,issue_number,issue_id,repo,stage,status,revision,archived_at,context FROM work_items WHERE id=?").get(id) as ItemRow|undefined;if(!row)throw new Error("Unknown work item");return row;}
 private issueNumber(reference:string){const value=reference.trim(),direct=value.match(/^#?(\d+)$/)?.[1];if(direct)return Number(direct);const escaped=config.repo.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),url=value.match(new RegExp(`^https://github\\.com/${escaped}/issues/(\\d+)/?`));if(url)return Number(url[1]);throw new Error(`Use an issue number or a URL from ${config.repo}`);}
}

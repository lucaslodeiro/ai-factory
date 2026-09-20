import { config } from "./config.js";
import type { Comment,GitHubPort,Issue,RepositoryComment,WorkflowGitHubPort } from "./adapters/github.js";
import type { Store } from "./storage.js";
import { parseFactoryCommand } from "./factory-command.js";
import { WorkflowIntake,WorkflowInbox,type ExecutionControl } from "./workflow-inbox.js";
import { WorkflowGitHubPublisher } from "./workflow-github.js";
import { WorkflowRunner } from "./workflow-runner.js";
import { WorkflowProjections } from "./workflow-projection.js";
import { WorkflowRecords } from "./workflow-records.js";
import { deliverNotifications,type NotificationPort } from "./notifications.js";
import {pruneExecutionArtifacts} from "./artifact-retention.js";

type GitHub=GitHubPort&WorkflowGitHubPort;
type ItemRow={id:string;issue_number:number;repo:string;stage:string;status:string;revision:number;archived_at:string|null;context:string};

export class WorkflowOrchestrator {
 private intake:WorkflowIntake;private inbox:WorkflowInbox;private publisher:WorkflowGitHubPublisher;private projections:WorkflowProjections;private records:WorkflowRecords;
 constructor(readonly store:Store,private github:GitHub,private runner:WorkflowRunner,private notifications:NotificationPort,executions?:ExecutionControl){this.intake=new WorkflowIntake(store);this.inbox=new WorkflowInbox(store,github,config.approvers,executions);this.publisher=new WorkflowGitHubPublisher(store,github);this.projections=new WorkflowProjections(store);this.records=new WorkflowRecords(store);}
 async tick(){
  this.discoverStartCommands();this.reconcileIssueVisibility();this.reconcilePullRequests();
  for(const item of this.rows())if(!item.archived_at)this.inbox.poll(item.id);
  await this.flush();
  for(const item of this.rows())if(!item.archived_at&&item.status==="QUEUED")await this.runner.run(item.id);
  await this.flush();
  const last=this.store.metadata<number>("artifact-retention:last")??0;if(Date.now()-last>3_600_000){pruneExecutionArtifacts(this.store);this.store.setMetadata("artifact-retention:last",Date.now());}
 }
 startIssue(reference:string,requestedBy="Dashboard or CLI",origin?:{source:"comment";commentId:number;login:string;guidance?:string}){
  const number=this.issueNumber(reference),existing=this.rows().find(item=>item.repo===config.repo&&item.issue_number===number);
  if(existing)return {issue:number,id:existing.id,created:false,stage:existing.stage,status:existing.status};
  const issue=this.github.issue(number),initialCursor=origin?.commentId??Math.max(0,...this.github.comments(number).map(comment=>comment.id)),started=this.intake.start(issue,{actor:origin?.login??requestedBy,commentId:origin?.commentId,initialCursor,guidance:origin?.guidance,source:origin?"github-comment":"control"});
  return {issue:number,...started,stage:"DESIGN",status:"QUEUED"};
 }
 refreshIssueList(){
  let updated=0;for(const item of this.rows()){let remote:Issue;try{remote=this.github.issue(item.issue_number);}catch(error){this.store.event("github.issue_state_failed",{issue:item.issue_number,error:String(error)},item.id);continue;}this.reconcileIssue(item,remote);if(remote.state==="OPEN"&&!this.row(item.id).archived_at){this.updateIssueContext(item.id,remote);this.inbox.poll(item.id);updated++;}}
  const found=this.rows().filter(item=>!item.archived_at).length;this.store.event("github.issue_list_refreshed",{found,added:0,updated});return {found,added:0,updated};
 }
 reconcilePullRequests(){
  for(const item of this.rows()){
   if(item.archived_at||item.stage!=="DELIVERY"||item.status!=="WAITING")continue;const context=JSON.parse(item.context||"{}") as {pr?:string;merge?:unknown};if(!context.pr)continue;
   try{const remote=this.github.pullRequestState(context.pr),request=this.records.activeRequest(item.id);if(!request||request.payload.kind!=="request"||request.payload.type!=="merge")continue;
    if(remote.state==="MERGED")this.projections.transition({workItemId:item.id,expectedRevision:item.revision,stage:"DELIVERY",status:"COMPLETED",actor:{type:"github",id:"pull-request"},source:{},reason:{code:"pr-merged",summary:"Pull request merged"},recordIds:[request.id]},()=>{this.records.resolveRequest(request.id);this.updateContext(item.id,{merge:{at:remote.mergedAt,commit:remote.mergeCommit?.oid??null}});});
    else if(Boolean(request.payload.prClosed)!==(remote.state==="CLOSED"))this.projections.present({workItemId:item.id,expectedRevision:item.revision,actor:{type:"github",id:"pull-request"},source:{},reason:{code:remote.state==="CLOSED"?"pr-closed":"pr-reopened",summary:remote.state==="CLOSED"?"Pull request closed without merge":"Pull request reopened"},recordIds:[request.id]},()=>{this.records.updateRequest(request.id,{prClosed:remote.state==="CLOSED"});});
   }catch(error){this.store.event("github.pr_poll_failed",{error:String(error),url:context.pr},item.id);}
  }
 }
 async flush(){
  try{this.publisher.publishHelp();this.publisher.publishResults();this.publisher.publishChanged();}catch(error){this.store.event("github.projection_failed",{error:String(error)});}
  await deliverNotifications(this.store,this.notifications);
 }
 private discoverStartCommands(){
  if(!this.github.repositoryComments)return;const key=`github.start-comments:${config.repo}`,now=Date.now(),checkpoint=this.store.metadata<{since:string;id:number}>(key)??{since:new Date(now-300000).toISOString(),id:0};let high=checkpoint.id;
  for(const comment of this.github.repositoryComments(checkpoint.since).slice().sort((a,b)=>a.id-b.id)){if(comment.id<=checkpoint.id)continue;this.startComment(comment);high=Math.max(high,comment.id);}
  this.store.setMetadata(key,{since:new Date(now-5000).toISOString(),id:high});
 }
 private startComment(comment:RepositoryComment){let command;try{command=parseFactoryCommand(comment.body);}catch(error){this.store.event("command.rejected",{commentId:comment.id,login:comment.user.login,error:String(error)});return;}if(command?.kind!=="start")return;const issue=Number(comment.issue_url.split("/").at(-1));if(comment.created_at!==comment.updated_at||comment.user.type!=="User"||!config.approvers.includes(comment.user.login)||!Number.isSafeInteger(issue)){this.store.event("start.command_rejected",{commentId:comment.id,issueNumber:issue,login:comment.user.login,reason:"Only a new standalone comment from an authorized human can start work"});return;}try{this.startIssue(String(issue),comment.user.login,{source:"comment",commentId:comment.id,login:comment.user.login,guidance:command.guidance});}catch(error){this.store.event("start.command_rejected",{commentId:comment.id,issueNumber:issue,login:comment.user.login,reason:String(error)});}}
 private reconcileIssueVisibility(){for(const item of this.rows())try{this.reconcileIssue(item,this.github.issue(item.issue_number));}catch(error){this.store.event("github.issue_state_failed",{issue:item.issue_number,error:String(error)},item.id);}}
 private reconcileIssue(item:ItemRow,remote:Issue){
  if(remote.state==="CLOSED"&&!item.archived_at){const current=this.projections.get(item.id);this.store.db.transaction(()=>{if(!["PAUSED","COMPLETED","CANCELLED"].includes(current.status))this.projections.transition({workItemId:item.id,expectedRevision:current.revision,stage:current.stage,status:"PAUSED",actor:{type:"github",id:"issue"},source:{},reason:{code:"issue-closed",summary:"GitHub issue closed manually"}});this.store.db.prepare("UPDATE work_items SET archived_at=? WHERE id=?").run(new Date().toISOString(),item.id);this.store.db.prepare("UPDATE notifications SET sent=1,last_error=? WHERE work_item_id=? AND sent=0").run("Suppressed because the GitHub issue is closed",item.id);this.store.event("github.issue_closed",{issue:item.issue_number,visibility:"archived"},item.id);}).immediate();return;}
  if(remote.state==="OPEN"&&item.archived_at){const current=this.projections.get(item.id),comments=this.github.comments(item.issue_number),cursor=Math.max(this.cursor(item),...comments.map(comment=>comment.id),0);this.store.db.transaction(()=>{this.updateContext(item.id,{cursor});this.store.db.prepare("UPDATE work_items SET archived_at=NULL WHERE id=?").run(item.id);this.projections.present({workItemId:item.id,expectedRevision:current.revision,actor:{type:"github",id:"issue"},source:{},reason:{code:"issue-reopened",summary:"GitHub issue reopened; explicit retry required"}});this.store.event("github.issue_reopened",{issue:item.issue_number,status:"PAUSED"},item.id);}).immediate();}
 }
 private updateIssueContext(id:string,issue:Issue){this.updateContext(id,{title:issue.title,body:issue.body,url:issue.url});}
 private updateContext(id:string,values:Record<string,unknown>){const item=this.row(id),context=JSON.parse(item.context||"{}");this.store.db.prepare("UPDATE work_items SET context=?,updated_at=? WHERE id=?").run(JSON.stringify({...context,...values}),new Date().toISOString(),id);}
 private cursor(item:ItemRow){return (JSON.parse(item.context||"{}") as {cursor?:number}).cursor??0;}
 private rows(){return this.store.db.prepare("SELECT id,issue_number,repo,stage,status,revision,archived_at,context FROM work_items ORDER BY created_at").all() as ItemRow[];}
 private row(id:string){const row=this.store.db.prepare("SELECT id,issue_number,repo,stage,status,revision,archived_at,context FROM work_items WHERE id=?").get(id) as ItemRow|undefined;if(!row)throw new Error("Unknown work item");return row;}
 private issueNumber(reference:string){const value=reference.trim(),direct=value.match(/^#?(\d+)$/)?.[1];if(direct)return Number(direct);const escaped=config.repo.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),url=value.match(new RegExp(`^https://github\\.com/${escaped}/issues/(\\d+)/?`));if(url)return Number(url[1]);throw new Error(`Use an issue number or a URL from ${config.repo}`);}
}

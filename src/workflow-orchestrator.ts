import type {RuntimeGitHub} from "./github-runtime.js";
import { config } from "./config.js";
import type { Comment,GitHubPort,Issue,RepositoryComment,WorkflowGitHubPort } from "./adapters/github.js";
import type { Store } from "./storage.js";
import { factoryCommandTypo,parseFactoryCommand } from "./factory-command.js";
import { WorkflowIntake,WorkflowInbox,type ExecutionControl } from "./workflow-inbox.js";
import { WorkflowGitHubPublisher } from "./workflow-github.js";
import { WorkflowRunner } from "./workflow-runner.js";
import { WorkflowProjections } from "./workflow-projection.js";
import { WorkflowRecords } from "./workflow-records.js";
import { deliverNotifications,type NotificationPort } from "./notifications.js";
import {pruneExecutionArtifacts} from "./artifact-retention.js";
import {createHash} from "node:crypto";
import type {ControllerFence} from "./controller-fence.js";

type GitHub=RuntimeGitHub;
type ItemRow={id:string;issue_number:number;issue_id:number|null;issue_created_at:string|null;repo:string;stage:string;status:string;revision:number;archived_at:string|null;context:string};

export class WorkflowOrchestrator {
 private intake:WorkflowIntake;private inbox:WorkflowInbox;private publisher:WorkflowGitHubPublisher;private projections:WorkflowProjections;private records:WorkflowRecords;
 constructor(readonly store:Store,private github:GitHub,private runner:WorkflowRunner,private notifications:NotificationPort,executions?:ExecutionControl,private fence?:ControllerFence){this.intake=new WorkflowIntake(store);this.inbox=new WorkflowInbox(store,{comments:()=>{throw new Error("Remote comments must be fetched asynchronously");}},config.approvers,executions,fence);this.publisher=new WorkflowGitHubPublisher(store,github);this.projections=new WorkflowProjections(store);this.records=new WorkflowRecords(store);}
 async tick(){await this.syncRemote();await this.runLocal();await this.flush();}
 async syncRemote(){
  const since=(this.store.db.prepare("SELECT COALESCE(MAX(id),0) id FROM events").get() as {id:number}).id;
  this.fence?.assertController();
  await this.discoverStartIssues();await this.discoverStartCommands();await this.reconcileIssueVisibility();await this.reconcilePullRequests();
  for(const item of this.rows())if(!item.archived_at){const comments=await this.github.comments(item.issue_number);this.fence?.assertController();if(!this.row(item.id).archived_at)this.inbox.poll(item.id,comments);}
  await this.flush();
  if(this.store.db.prepare("SELECT 1 FROM events WHERE id>? AND type IN ('github.pr_poll_failed','github.issue_state_failed') LIMIT 1").get(since))throw new Error("Some GitHub checks failed; inspect daemon logs. Local processing remains independent.");
 }
 async runLocal(){
  this.fence?.assertController();this.runner.reconcileFinished();
  if(this.store.db.prepare("SELECT 1 FROM maintenance_operations WHERE status IN ('confirmed','pausing','ready','running') LIMIT 1").get())return;
  // One execution at a time, with the oldest queued item first. Each completion
  // releases the local lane immediately; remote polling never owns this lane.
  const item=this.rows().find(item=>!item.archived_at&&item.status==="QUEUED");
  if(item){this.fence?.assertController();this.store.setMetadata("runtime:local-work",{id:item.id,stage:item.stage,since:new Date().toISOString()});try{await this.runner.run(item.id);}finally{this.store.setMetadata("runtime:local-work",null);}}
  const last=this.store.metadata<number>("artifact-retention:last")??0;if(Date.now()-last>3_600_000){pruneExecutionArtifacts(this.store);this.store.setMetadata("artifact-retention:last",Date.now());}
  return Boolean(item);
 }
 async startIssue(reference:string,requestedBy="Dashboard or CLI",origin?:{source:"comment"|"description";commentId?:number;login:string;guidance?:string},knownIssue?:Issue){
  const number=this.issueNumber(reference),issue=knownIssue??await this.github.issue(number),candidate=this.rows().find(item=>item.repo===config.repo&&item.issue_number===number&&!item.archived_at);
  if(candidate&&this.replaced(candidate,issue))await this.reconcileIssue(candidate,issue);
  const existing=this.rows().find(item=>item.repo===config.repo&&item.issue_number===number&&!item.archived_at&&item.issue_id===issue.id);
  if(existing)return {issue:number,id:existing.id,created:false,stage:existing.stage,status:existing.status};
  const initialCursor=origin?.commentId??Math.max(0,...(await this.github.comments(number)).map(comment=>comment.id));this.fence?.assertController();const started=this.intake.start(issue,{actor:origin?.login??requestedBy,commentId:origin?.commentId,initialCursor,guidance:origin?.guidance,source:origin?.source==="comment"?"github-comment":origin?.source==="description"?"github-description":"control"});
  return {issue:number,...started,stage:"DESIGN",status:"QUEUED"};
 }
 async refreshIssueList(){
  let updated=0;for(const item of this.rows()){let remote:Issue;try{remote=await this.github.issue(item.issue_number);}catch(error){this.store.event("github.issue_state_failed",{issue:item.issue_number,error:String(error)},item.id);continue;}await this.reconcileIssue(item,remote);if(remote.state==="OPEN"&&!this.row(item.id).archived_at){this.inbox.poll(item.id,await this.github.comments(item.issue_number));updated++;}}
  const found=this.rows().filter(item=>!item.archived_at).length;this.store.event("github.issue_list_refreshed",{found,added:0,updated});return {found,added:0,updated};
 }
 async reconcilePullRequests(){
  for(const item of this.rows()){
   if(item.archived_at||item.stage!=="DELIVERY"||item.status!=="WAITING")continue;const context=JSON.parse(item.context||"{}") as {pr?:string;merge?:unknown};if(!context.pr)continue;
   try{const remote=await this.github.pullRequestState(context.pr);this.fence?.assertController();const latest=this.row(item.id);if(latest.archived_at||latest.stage!=="DELIVERY"||latest.status!=="WAITING")continue;item.revision=latest.revision;const request=this.records.activeRequest(item.id);if(!request||request.payload.kind!=="request"||request.payload.type!=="merge")continue;
    if(remote.state==="MERGED")this.projections.transition({workItemId:item.id,expectedRevision:item.revision,stage:"DELIVERY",status:"COMPLETED",actor:{type:"github",id:"pull-request"},source:{},reason:{code:"pr-merged",summary:"Pull request merged"},recordIds:[request.id]},()=>{this.records.resolveRequest(request.id);this.updateContext(item.id,{merge:{at:remote.mergedAt,commit:remote.mergeCommit?.oid??null}});});
    else if(Boolean(request.payload.prClosed)!==(remote.state==="CLOSED"))this.projections.present({workItemId:item.id,expectedRevision:item.revision,actor:{type:"github",id:"pull-request"},source:{},reason:{code:remote.state==="CLOSED"?"pr-closed":"pr-reopened",summary:remote.state==="CLOSED"?"Pull request closed without merge":"Pull request reopened"},recordIds:[request.id]},()=>{this.records.updateRequest(request.id,{prClosed:remote.state==="CLOSED"});});
   }catch(error){this.store.event("github.pr_poll_failed",{error:String(error),url:context.pr},item.id);}
  }
 }
 async flush(){
  this.fence?.assertController();
  try{await this.publisher.publishHelp();await this.publisher.publishResults();await this.publisher.publishChanged();}catch(error){this.store.event("github.projection_failed",{error:String(error)});throw error;}
  await deliverNotifications(this.store,this.notifications);
 }
 private async discoverStartCommands(){
  if(!this.github.repositoryComments)return;const key=`github.start-comments:v2:${config.repo}`,now=Date.now(),saved=this.store.metadata<{since:string;evaluated:Record<string,string>}>(key),historical=!saved,checkpoint=saved??{since:new Date(0).toISOString(),evaluated:{}};const evaluated={...checkpoint.evaluated};
  const issues=new Map<number,Issue>();for(const comment of (await this.github.repositoryComments(checkpoint.since)).slice().sort((a,b)=>a.id-b.id)){const issueNumber=Number(comment.issueUrl.split("/").at(-1));if(!Number.isSafeInteger(issueNumber))continue;let issue=issues.get(issueNumber);if(!issue){issue=await this.github.issue(issueNumber);issues.set(issueNumber,issue);}if(this.tracked(issue))continue;if(evaluated[String(comment.id)]===comment.updatedAt)continue;evaluated[String(comment.id)]=comment.updatedAt;await this.startComment(comment,issue,historical&&this.processedByController(issue));}
  const cutoff=now-300000;for(const [id,updatedAt] of Object.entries(evaluated))if(Date.parse(updatedAt)<cutoff)delete evaluated[id];this.store.setMetadata(key,{since:new Date(now-5000).toISOString(),evaluated});
 }
 private async discoverStartIssues(){
  if(!this.github.repositoryIssues)return;const key=`github.start-issues:v2:${config.repo}`,now=Date.now(),checkpoint=this.store.metadata<{since:string;evaluated:Record<string,string>}>(key)??{since:new Date(0).toISOString(),evaluated:{}};const evaluated={...checkpoint.evaluated};
  for(const issue of (await this.github.repositoryIssues(checkpoint.since)).slice().sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)||a.id-b.id)){if(issue.pullRequest||issue.state!=="OPEN"||evaluated[String(issue.id)]===issue.updatedAt)continue;evaluated[String(issue.id)]=issue.updatedAt;if(this.tracked(issue))continue;let command;try{command=parseFactoryCommand(issue.body);}catch(error){this.store.event("command.rejected",{issueId:issue.id,issueNumber:issue.number,login:issue.author.login,error:String(error)});continue;}if(command?.kind!=="start"){if(!command&&issue.author.type==="User"&&config.approvers.includes(issue.author.login)){const typo=factoryCommandTypo(issue.body),reason=typo?`Unrecognized command \`${typo.attempt}\` — did you mean \`${typo.suggestion}\`? Edit the issue description or post a new comment.`:this.misplacedStart(issue.body)?this.startPlacementHint():null;if(reason){this.store.event("command.rejected",{issueId:issue.id,issueNumber:issue.number,login:issue.author.login,command:typo?.attempt??"start",error:reason});await this.publishStartHint(issue.number,`body-${issue.id}-${createHash("sha256").update(issue.body).digest("hex").slice(0,16)}`,reason);}}continue;}if(this.processedByController(issue)){this.store.event("command.rejected",{issueId:issue.id,issueNumber:issue.number,login:issue.author.login,command:"start",reason:"already processed by a controller"});continue;}if(issue.author.type!=="User"||!config.approvers.includes(issue.author.login)){this.store.event("command.rejected",{issueId:issue.id,issueNumber:issue.number,login:issue.author.login,command:"start",error:"Only an authorized human issue author can start work"});continue;}try{await this.startIssue(String(issue.number),issue.author.login,{source:"description",login:issue.author.login,guidance:command.guidance});}catch(error){this.store.event("command.rejected",{issueId:issue.id,issueNumber:issue.number,login:issue.author.login,command:"start",error:String(error)});}}
  const cutoff=now-300000;for(const [id,updatedAt] of Object.entries(evaluated))if(Date.parse(updatedAt)<cutoff)delete evaluated[id];this.store.setMetadata(key,{since:new Date(now-5000).toISOString(),evaluated});
 }
 private async startComment(comment:RepositoryComment,issue?:Issue,processed=false){if(comment.body.includes("<!-- ai-factory:"))return;let command;try{command=parseFactoryCommand(comment.body);}catch(error){this.store.event("command.rejected",{commentId:comment.id,login:comment.user.login,error:String(error)});return;}const issueNumber=Number(comment.issueUrl.split("/").at(-1));if(command?.kind!=="start"){if(!command&&comment.user.type==="User"&&config.approvers.includes(comment.user.login)&&Number.isSafeInteger(issueNumber)){const typo=factoryCommandTypo(comment.body),reason=typo?`Unrecognized command \`${typo.attempt}\` — did you mean \`${typo.suggestion}\`? Edit this comment or post a new one.`:this.misplacedStart(comment.body)?this.startPlacementHint():null;if(reason){this.store.event("command.rejected",{commentId:comment.id,issueNumber,login:comment.user.login,command:typo?.attempt??"start",error:reason});await this.publishStartHint(issueNumber,`comment-${comment.id}-${comment.updatedAt}`,reason);}}return;}if(processed){this.store.event("command.rejected",{commentId:comment.id,issueNumber,login:comment.user.login,command:"start",reason:"already processed by a controller"});return;}if(comment.user.type!=="User"||!config.approvers.includes(comment.user.login)||!Number.isSafeInteger(issueNumber)){this.store.event("start.command_rejected",{commentId:comment.id,issueNumber,login:comment.user.login,reason:"Only an authorized human can start work"});return;}try{await this.startIssue(String(issueNumber),comment.user.login,{source:"comment",commentId:comment.id,login:comment.user.login,guidance:command.guidance},issue);}catch(error){this.store.event("start.command_rejected",{commentId:comment.id,issueNumber,login:comment.user.login,reason:String(error)});}}
 private misplacedStart(body:string){return body.split(/\r?\n/).some(line=>/^>?\s*\/factory start(?:\s|$)/.test(line.trim()));}
 private startPlacementHint(){return "AI Factory did not start: put `/factory start` on the first or the last line of the issue description or of a new comment.";}
 private async publishStartHint(issue:number,key:string,body:string){const metadata=`github:start-hint:${config.repo}:${key}`;if(this.store.metadata(metadata))return;await this.github.publishWorkflowComment(issue,`start-hint-${key}`,body);this.store.setMetadata(metadata,true);}
 private tracked(issue:Issue){return Boolean(this.rows().find(item=>!item.archived_at&&item.repo===config.repo&&item.issue_number===issue.number&&item.issue_id===issue.id));}
 private processedByController(issue:Issue){return Boolean(issue.labels?.some(label=>label.name.startsWith("factory:")));}
 private async reconcileIssueVisibility(){for(const item of this.rows())try{await this.reconcileIssue(item,await this.github.issue(item.issue_number));}catch(error){this.store.event("github.issue_state_failed",{issue:item.issue_number,error:String(error)},item.id);}}
 private async reconcileIssue(item:ItemRow,remote:Issue){
  this.fence?.assertController();item=this.row(item.id);
  if(this.replaced(item,remote)){const current=this.projections.get(item.id);this.store.db.transaction(()=>{if(!["PAUSED","COMPLETED","CANCELLED"].includes(current.status))this.projections.transition({workItemId:item.id,expectedRevision:current.revision,stage:current.stage,status:"PAUSED",actor:{type:"github",id:"issue"},source:{},reason:{code:"issue-replaced",summary:"GitHub issue was deleted and recreated"}});this.store.db.prepare("UPDATE work_items SET archived_at=? WHERE id=?").run(new Date().toISOString(),item.id);this.store.db.prepare("UPDATE notifications SET sent=1,last_error=? WHERE work_item_id=? AND sent=0").run("Suppressed because the GitHub issue was replaced",item.id);this.store.event("github.issue_replaced",{issue:item.issue_number,previousIssueId:item.issue_id,currentIssueId:remote.id},item.id);}).immediate();return;}
  if(remote.state==="CLOSED"&&!item.archived_at){const current=this.projections.get(item.id);this.store.db.transaction(()=>{if(!["PAUSED","COMPLETED","CANCELLED"].includes(current.status))this.projections.transition({workItemId:item.id,expectedRevision:current.revision,stage:current.stage,status:"PAUSED",actor:{type:"github",id:"issue"},source:{},reason:{code:"issue-closed",summary:"GitHub issue closed manually"}});this.store.db.prepare("UPDATE work_items SET archived_at=? WHERE id=?").run(new Date().toISOString(),item.id);this.store.db.prepare("UPDATE notifications SET sent=1,last_error=? WHERE work_item_id=? AND sent=0").run("Suppressed because the GitHub issue is closed",item.id);this.store.event("github.issue_closed",{issue:item.issue_number,visibility:"archived"},item.id);}).immediate();return;}
  if(remote.state==="OPEN"&&item.archived_at){const current=this.projections.get(item.id),comments=(await this.github.comments(item.issue_number)),cursor=Math.max(this.cursor(item),...comments.map(comment=>comment.id),0);this.store.db.transaction(()=>{this.updateContext(item.id,{cursor});this.store.db.prepare("UPDATE work_items SET archived_at=NULL WHERE id=?").run(item.id);this.projections.present({workItemId:item.id,expectedRevision:current.revision,actor:{type:"github",id:"issue"},source:{},reason:{code:"issue-reopened",summary:"GitHub issue reopened; explicit retry required"}});this.store.event("github.issue_reopened",{issue:item.issue_number,status:"PAUSED"},item.id);}).immediate();}
  if(remote.state==="OPEN")this.updateIssueContext(item.id,remote);
 }
 private replaced(item:ItemRow,remote:Issue){return item.issue_id!==null?item.issue_id!==remote.id:Boolean(item.issue_created_at&&Date.parse(remote.createdAt)>Date.parse(item.issue_created_at));}
 private updateIssueContext(id:string,issue:Issue){const row=this.row(id),context=JSON.parse(row.context||"{}") as {title?:string;body?:string;url?:string};if(context.title===issue.title&&context.body===issue.body&&context.url===issue.url)return;if(context.title!==issue.title){const current=this.projections.get(id);this.projections.present({workItemId:id,expectedRevision:current.revision,actor:{type:"github",id:"issue"},source:{},reason:{code:"issue-title-updated",summary:"GitHub issue title updated"}},()=>this.updateContext(id,{title:issue.title,body:issue.body,url:issue.url}));}else this.updateContext(id,{title:issue.title,body:issue.body,url:issue.url});}
 private updateContext(id:string,values:Record<string,unknown>){const item=this.row(id),context=JSON.parse(item.context||"{}");this.store.db.prepare("UPDATE work_items SET context=?,updated_at=? WHERE id=?").run(JSON.stringify({...context,...values}),new Date().toISOString(),id);}
 private cursor(item:ItemRow){return (JSON.parse(item.context||"{}") as {cursor?:number}).cursor??0;}
 private rows(){return this.store.db.prepare("SELECT id,issue_number,issue_id,issue_created_at,repo,stage,status,revision,archived_at,context FROM work_items ORDER BY created_at").all() as ItemRow[];}
 private row(id:string){const row=this.store.db.prepare("SELECT id,issue_number,issue_id,issue_created_at,repo,stage,status,revision,archived_at,context FROM work_items WHERE id=?").get(id) as ItemRow|undefined;if(!row)throw new Error("Unknown work item");return row;}
 private issueNumber(reference:string){const value=reference.trim(),direct=value.match(/^#?(\d+)$/)?.[1];if(direct)return Number(direct);const escaped=config.repo.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),url=value.match(new RegExp(`^https://github\\.com/${escaped}/issues/(\\d+)/?`));if(url)return Number(url[1]);throw new Error(`Use an issue number or a URL from ${config.repo}`);}
}

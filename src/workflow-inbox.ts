import { randomUUID } from "node:crypto";
import type { Comment,Issue } from "./adapters/github.js";
import { factoryCommandTypo,parseFactoryCommand } from "./factory-command.js";
import type { Store } from "./storage.js";
import { WorkflowCommands } from "./workflow-commands.js";
import { WorkflowProjections } from "./workflow-projection.js";
import {workflowNotificationText} from "./notifications.js";
import { ExecutionNotStoppedError } from "./execution-manager.js";
import { WorkflowRecords } from "./workflow-records.js";
const RETRY_DEFERRAL_MS=30*60*1000;

export interface LastCommandOutcome {commentId:number;login:string;kind:string;outcome:"applied"|"rejected"|"stale"|"deferred"|"expired"|"unrecognized";reason?:string;at:string;}
export interface ObservedComment {id:number;updatedAt:string}

export interface CommentPort { comments(issue:number):Comment[]; }
export interface ExecutionControl { cancel(id:string):boolean; interrupt(id:string,reason:string):boolean; }
export interface StartOrigin { actor:string;commentId?:number;initialCursor?:number;guidance?:string;source:"github-comment"|"github-description"|"control"; }

export class WorkflowIntake {
 constructor(private store:Store) {}
 start(issue:Issue,origin:StartOrigin) {
  if(issue.pullRequest)throw new Error(`#${issue.number} is a pull request`);
  if(issue.state==="CLOSED")throw new Error(`#${issue.number} is closed`);
  const existing=this.store.db.prepare("SELECT id FROM work_items WHERE repo=? AND issue_number=? AND archived_at IS NULL AND issue_id=?").get(issue.url.match(/github\.com\/([^/]+\/[^/]+)/)?.[1]??"",issue.number,issue.id) as {id:string}|undefined;
  if(existing)return {id:existing.id,created:false};
  const id=randomUUID(),now=new Date().toISOString(),repo=issue.url.match(/github\.com\/([^/]+\/[^/]+)/)?.[1];
  if(!repo)throw new Error("Issue URL does not identify a GitHub repository");
  const eventId=randomUUID(),context={title:issue.title,body:issue.body,url:issue.url,cursor:origin.initialCursor??origin.commentId??0,
   ...(origin.source==="github-comment"&&origin.commentId?{lastCommand:{commentId:origin.commentId,login:origin.actor,kind:"start",outcome:"applied",at:now} satisfies LastCommandOutcome}:{})};
  const run=this.store.db.transaction(()=>{
   this.store.db.prepare(`INSERT INTO work_items(id,issue_number,issue_id,issue_node_id,issue_created_at,repo,branch,created_at,updated_at,context,stage,status,attempt,revision,presentation_revision,correction_cycles)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,issue.number,issue.id,issue.nodeId,issue.createdAt,repo,`factory/issue-${issue.number}-${id.slice(0,8)}`,now,now,JSON.stringify(context),"DESIGN","QUEUED",0,0,0,0);
   const recordIds:string[]=[];if(origin.guidance)recordIds.push(new WorkflowRecords(this.store).create({workItemId:id,specVersion:0,scope:"issue",payload:{kind:"instruction",text:origin.guidance},sourceType:origin.source==="control"?"orchestrator":"github-comment",sourceId:String(origin.commentId??"issue-description"),actor:origin.actor}).id);
   const initial=new WorkflowProjections(this.store).get(id),reason={code:"work-started",summary:"Issue accepted into the factory"};this.store.event("workflow.transition",{schemaVersion:1,eventId,type:"workflow.transition",workItemId:id,occurredAt:now,actor:{type:origin.source.startsWith("github-")?"human":"orchestrator",id:origin.actor},source:{commentId:origin.commentId},from:null,to:initial,reason,recordIds,specVersion:0},id);this.store.db.prepare("INSERT INTO notifications(body,work_item_id) VALUES(?,?)").run(workflowNotificationText(this.store,id,initial,reason),id);
   return {id,created:true};
  });
  return run.immediate();
 }
}

export class WorkflowInbox {
 private commands:WorkflowCommands;private projections:WorkflowProjections;
 constructor(private store:Store,private github:CommentPort,private approvers:string[],private executions?:ExecutionControl){this.commands=new WorkflowCommands(store);this.projections=new WorkflowProjections(store);}
 poll(workItemId:string,providedComments?:Comment[]) {
  const item=this.row(workItemId),fetched=(providedComments??this.github.comments(item.issue_number)).slice().sort((a,b)=>a.id-b.id),observedById=new Map(item.context.observedComments.map(comment=>[comment.id,comment.updatedAt])),changed=fetched.filter(comment=>observedById.has(comment.id)&&observedById.get(comment.id)!==comment.updatedAt),fresh=fetched.filter(comment=>comment.id>item.cursor),comments=[...changed,...fresh.filter(comment=>!changed.some(candidate=>candidate.id===comment.id))],rechecks=new Set(changed.map(comment=>comment.id));
  let applied=0,rejected=0,observed=0,deferredRetry:{commentId:number;login:string}|undefined,blockedAfterRetry=0;
  for(const comment of comments) {
   const outcome=this.store.db.transaction(()=>{
    const latest=this.row(workItemId),recheck=rechecks.has(comment.id);if(!recheck&&comment.id<=latest.cursor)return "duplicate";
    if(deferredRetry){
     if(comment.user.type!=="User"||!this.approvers.includes(comment.user.login))return "blocked";
     let bypass;try{bypass=parseFactoryCommand(comment.body);}catch{return "blocked";}
     if(bypass?.kind!=="cancel")return "blocked";
     const specVersion=(this.store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number|null}).version??0;
     const cancelled=this.commands.apply(bypass,{workItemId,login:comment.user.login,commentId:comment.id,specVersion});
     this.setCursor(workItemId,comment.id);this.clearObserved(workItemId);this.setLastCommand(workItemId,comment,this.commandLabel(bypass),"applied");
     if(!this.store.db.prepare("SELECT 1 FROM events WHERE work_item_id=? AND type='command.superseded' AND json_extract(payload,'$.commentId')=?").get(workItemId,deferredRetry.commentId))this.store.event("command.superseded",{commentId:deferredRetry.commentId,login:deferredRetry.login,supersededBy:comment.id},workItemId);
     return {result:"applied",executionAction:"executionAction" in cancelled?cancelled.executionAction:undefined,supersededDeferred:true};
    }
    if(!recheck)this.setCursor(workItemId,comment.id);
    if(comment.user.type!=="User"||!this.approvers.includes(comment.user.login))return "observed";
    if(comment.body.includes("<!-- ai-factory:"))return "observed";
    let command;
    try{command=parseFactoryCommand(comment.body);}catch(error){const parserReason=this.errorMessage(error).replace(/[.\s]+$/g,"")||"Unknown or malformed /factory command",reason=`${parserReason}. Post a new comment; edits to this one are not re-read.`;this.store.event("command.rejected",{commentId:comment.id,login:comment.user.login,error:reason},workItemId);this.setLastCommand(workItemId,comment,"unparsed","rejected",reason,true);return "rejected";}
    if(command?.kind==="start") {const reason="Issue is already in the factory";this.store.event("command.rejected",{commentId:comment.id,login:comment.user.login,command:"start",error:reason},workItemId);this.setLastCommand(workItemId,comment,"start","rejected",reason,true);return "rejected";}
    if(!command) {
     this.observe(workItemId,comment);
     const typo=factoryCommandTypo(comment.body);if(typo){const reason=`Unrecognized command \`${typo.attempt}\` — did you mean \`${typo.suggestion}\`? Edit this comment or post a new one.`;this.store.event("command.unrecognized",{commentId:comment.id,login:comment.user.login,command:typo.attempt,suggestion:typo.suggestion},workItemId);this.setLastCommand(workItemId,comment,typo.attempt,"unrecognized",reason,true);return "observed";}
     if(!recheck){const current=this.projections.get(workItemId);this.projections.present({workItemId,expectedRevision:current.revision,actor:{type:"human",id:comment.user.login},source:{commentId:comment.id},reason:{code:"comment-observed",summary:"Authorized comment observed"}});}
     return "observed";
    }
    const specVersion=(this.store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number|null}).version??0;
    try{const applied=this.commands.apply(command,{workItemId,login:comment.user.login,commentId:comment.id,specVersion});this.clearObserved(workItemId);this.setLastCommand(workItemId,comment,this.commandLabel(command),"applied");return {result:"applied",executionAction:"executionAction" in applied?applied.executionAction:undefined};}
    catch(error){
     if(error instanceof ExecutionNotStoppedError){
      const prior=this.store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='command.deferred' AND json_extract(payload,'$.commentId')=? ORDER BY id LIMIT 1").get(workItemId,comment.id) as {payload:string}|undefined;
      let deferredAt:string;if(prior)deferredAt=(JSON.parse(prior.payload) as {deferredAt:string}).deferredAt;else{deferredAt=new Date().toISOString();this.store.event("command.deferred",{commentId:comment.id,login:comment.user.login,command:command.kind,error:error.message,deferredAt},workItemId);this.setLastCommand(workItemId,comment,this.commandLabel(command),"deferred","waiting for the interrupted execution to exit",true);}
      if(Date.now()-Date.parse(deferredAt)<RETRY_DEFERRAL_MS){this.setCursorExact(workItemId,latest.cursor);return "deferred";}
      const reason=`Retry deferral exceeded ${RETRY_DEFERRAL_MS}ms while waiting for the execution to stop`;this.store.event("command.rejected",{commentId:comment.id,login:comment.user.login,command:command.kind,error:reason},workItemId);this.setLastCommand(workItemId,comment,this.commandLabel(command),"expired",reason,true);return "rejected";
     }
     const reason=this.errorMessage(error),stale=/stale/i.test(reason);this.store.event(stale?"command.stale":"command.rejected",{commentId:comment.id,login:comment.user.login,command:command.kind,error:reason},workItemId);this.setLastCommand(workItemId,comment,this.commandLabel(command),stale?"stale":"rejected",reason,true);return "rejected";
    }
   }).immediate(),result=typeof outcome==="string"?outcome:outcome.result;
   if(typeof outcome!=="string"&&outcome.executionAction?.kind==="cancel")this.executions?.cancel(outcome.executionAction.runId);
   if(typeof outcome!=="string"&&outcome.executionAction?.kind==="interrupt")this.executions?.interrupt(outcome.executionAction.runId,outcome.executionAction.reason);
   if(result==="applied")applied++;else if(result==="rejected")rejected++;else if(result==="observed")observed++;
   if(result==="deferred"){deferredRetry={commentId:comment.id,login:comment.user.login};continue;}
   if(result==="blocked"){blockedAfterRetry++;continue;}
   if(typeof outcome!=="string"&&outcome.supersededDeferred){observed+=blockedAfterRetry;blockedAfterRetry=0;deferredRetry=undefined;}
  }
  return {seen:comments.length,applied,rejected,observed,cursor:this.row(workItemId).cursor};
 }
 private row(workItemId:string) {
  const row=this.store.db.prepare("SELECT issue_number,context FROM work_items WHERE id=? AND archived_at IS NULL").get(workItemId) as {issue_number:number;context:string}|undefined;
  if(!row)throw new Error("Unknown or archived work item");
  const context=JSON.parse(row.context||"{}") as {cursor?:number;observedComments?:ObservedComment[];lastCommand?:LastCommandOutcome};return {...row,cursor:context.cursor??0,context:{...context,observedComments:context.observedComments??[]}};
 }
 private setCursor(workItemId:string,cursor:number) {
  const row=this.row(workItemId);this.store.db.prepare("UPDATE work_items SET context=?,updated_at=? WHERE id=?").run(JSON.stringify({...row.context,cursor:Math.max(row.cursor,cursor)}),new Date().toISOString(),workItemId);
 }
 private setCursorExact(workItemId:string,cursor:number){const row=this.row(workItemId);this.store.db.prepare("UPDATE work_items SET context=?,updated_at=? WHERE id=?").run(JSON.stringify({...row.context,cursor}),new Date().toISOString(),workItemId);}
 private observe(workItemId:string,comment:Comment){const row=this.row(workItemId),observedComments=[...row.context.observedComments.filter(candidate=>candidate.id!==comment.id),{id:comment.id,updatedAt:comment.updatedAt}].sort((a,b)=>a.id-b.id);this.store.db.prepare("UPDATE work_items SET context=?,updated_at=? WHERE id=?").run(JSON.stringify({...row.context,observedComments}),new Date().toISOString(),workItemId);}
 private clearObserved(workItemId:string){const row=this.row(workItemId);this.store.db.prepare("UPDATE work_items SET context=?,updated_at=? WHERE id=?").run(JSON.stringify({...row.context,observedComments:[]}),new Date().toISOString(),workItemId);}
 private setLastCommand(workItemId:string,comment:Comment,kind:string,outcome:LastCommandOutcome["outcome"],reason?:string,present=false) {
  const row=this.row(workItemId),lastCommand:LastCommandOutcome={commentId:comment.id,login:comment.user.login,kind,outcome,...(reason?{reason}:{}),at:new Date().toISOString()};
  this.store.db.prepare("UPDATE work_items SET context=?,updated_at=? WHERE id=?").run(JSON.stringify({...row.context,lastCommand}),lastCommand.at,workItemId);
  if(present){const current=this.projections.get(workItemId);this.projections.present({workItemId,expectedRevision:current.revision,actor:{type:"human",id:comment.user.login},source:{commentId:comment.id},reason:{code:`command-${outcome}`,summary:`Human command ${outcome}`}});}
 }
 private commandLabel(command:ReturnType<typeof parseFactoryCommand>) {
  if(!command)return "unparsed";
  if(command.kind==="approve")return `approve v${command.version}`;
  if(command.kind==="replace"||command.kind==="revoke")return `${command.kind} ${command.recordId}`;
  return command.kind;
 }
 private errorMessage(error:unknown){return error instanceof Error?error.message:String(error);}
}

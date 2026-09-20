import { randomUUID } from "node:crypto";
import type { Comment,Issue } from "./adapters/github.js";
import { parseFactoryCommand } from "./factory-command.js";
import type { Store } from "./storage.js";
import { WorkflowCommands } from "./workflow-commands.js";
import { WorkflowProjections } from "./workflow-projection.js";
import {workflowNotificationText} from "./notifications.js";

export interface CommentPort { comments(issue:number):Comment[]; }
export interface ExecutionControl { cancel(id:string):boolean; interrupt(id:string,reason:string):boolean; }
export interface StartOrigin { actor:string;commentId?:number;initialCursor?:number;source:"github-comment"|"control"; }

export class WorkflowIntake {
 constructor(private store:Store) {}
 start(issue:Issue,origin:StartOrigin) {
  if(issue.pullRequest)throw new Error(`#${issue.number} is a pull request`);
  if(issue.state==="CLOSED")throw new Error(`#${issue.number} is closed`);
  const existing=this.store.db.prepare("SELECT id FROM work_items WHERE repo=? AND issue_number=?").get(issue.url.match(/github\.com\/([^/]+\/[^/]+)/)?.[1]??"",issue.number) as {id:string}|undefined;
  if(existing)return {id:existing.id,created:false};
  const id=randomUUID(),now=new Date().toISOString(),repo=issue.url.match(/github\.com\/([^/]+\/[^/]+)/)?.[1];
  if(!repo)throw new Error("Issue URL does not identify a GitHub repository");
  const eventId=randomUUID(),context={title:issue.title,body:issue.body,url:issue.url,cursor:origin.initialCursor??origin.commentId??0};
  const run=this.store.db.transaction(()=>{
   this.store.db.prepare(`INSERT INTO work_items(id,issue_number,repo,branch,created_at,updated_at,context,stage,status,attempt,revision,presentation_revision,correction_cycles)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,issue.number,repo,`factory/issue-${issue.number}-${id.slice(0,8)}`,now,now,JSON.stringify(context),"DESIGN","QUEUED",0,0,0,0);
   const initial=new WorkflowProjections(this.store).get(id),reason={code:"work-started",summary:"Issue accepted into the factory"};this.store.event("workflow.transition",{schemaVersion:1,eventId,type:"workflow.transition",workItemId:id,occurredAt:now,actor:{type:origin.source==="github-comment"?"human":"orchestrator",id:origin.actor},source:{commentId:origin.commentId},from:null,to:initial,reason,recordIds:[],specVersion:0},id);this.store.db.prepare("INSERT INTO notifications(body,work_item_id) VALUES(?,?)").run(workflowNotificationText(this.store,id,initial,reason),id);
   return {id,created:true};
  });
  return run.immediate();
 }
}

export class WorkflowInbox {
 private commands:WorkflowCommands;private projections:WorkflowProjections;
 constructor(private store:Store,private github:CommentPort,private approvers:string[],private executions?:ExecutionControl){this.commands=new WorkflowCommands(store);this.projections=new WorkflowProjections(store);}
 poll(workItemId:string) {
  const item=this.row(workItemId),comments=this.github.comments(item.issue_number).slice().sort((a,b)=>a.id-b.id).filter(comment=>comment.id>item.cursor);
  let applied=0,rejected=0,observed=0;
  for(const comment of comments) {
   const outcome=this.store.db.transaction(()=>{
    const latest=this.row(workItemId);if(comment.id<=latest.cursor)return "duplicate";
    this.setCursor(workItemId,comment.id);
    if(comment.user.type!=="User"||!this.approvers.includes(comment.user.login))return "observed";
    let command;
    try{command=parseFactoryCommand(comment.body);}catch(error){this.store.event("command.rejected",{commentId:comment.id,login:comment.user.login,error:String(error)},workItemId);return "rejected";}
    if(!command||command.kind==="start") {
     const current=this.projections.get(workItemId);
     this.projections.present({workItemId,expectedRevision:current.revision,actor:{type:"human",id:comment.user.login},source:{commentId:comment.id},reason:{code:"comment-observed",summary:"Authorized comment observed"}});
     return "observed";
    }
    const specVersion=(this.store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number|null}).version??0;
    try{const applied=this.commands.apply(command,{workItemId,login:comment.user.login,commentId:comment.id,specVersion});return {result:"applied",executionAction:"executionAction" in applied?applied.executionAction:undefined};}
    catch(error){const stale=/stale/i.test(String(error));this.store.event(stale?"command.stale":"command.rejected",{commentId:comment.id,login:comment.user.login,command:command.kind,error:String(error)},workItemId);return "rejected";}
   }).immediate(),result=typeof outcome==="string"?outcome:outcome.result;
   if(typeof outcome!=="string"&&outcome.executionAction?.kind==="cancel")this.executions?.cancel(outcome.executionAction.runId);
   if(result==="applied")applied++;else if(result==="rejected")rejected++;else if(result==="observed")observed++;
  }
  return {seen:comments.length,applied,rejected,observed,cursor:this.row(workItemId).cursor};
 }
 private row(workItemId:string) {
  const row=this.store.db.prepare("SELECT issue_number,context FROM work_items WHERE id=? AND archived_at IS NULL").get(workItemId) as {issue_number:number;context:string}|undefined;
  if(!row)throw new Error("Unknown or archived work item");
  const context=JSON.parse(row.context||"{}") as {cursor?:number};return {...row,cursor:context.cursor??0,context};
 }
 private setCursor(workItemId:string,cursor:number) {
  const row=this.row(workItemId);this.store.db.prepare("UPDATE work_items SET context=?,updated_at=? WHERE id=?").run(JSON.stringify({...row.context,cursor}),new Date().toISOString(),workItemId);
 }
}

import type { Store } from "./storage.js";
import type { FactoryCommand } from "./factory-command.js";
import { WorkflowFailures } from "./workflow-failures.js";
import { WorkflowProjections } from "./workflow-projection.js";
import { WorkflowRecords } from "./workflow-records.js";
import {assertExecutionStopped} from "./execution-manager.js";
import {budgetState,formatTokens} from "./budget.js";

export interface CommandContext { workItemId:string;login:string;commentId:number;specVersion:number; }

export class WorkflowCommands {
 private records:WorkflowRecords;private failures:WorkflowFailures;private projections:WorkflowProjections;
 constructor(private store:Store){this.records=new WorkflowRecords(store);this.failures=new WorkflowFailures(store);this.projections=new WorkflowProjections(store);}
 apply(command:FactoryCommand,context:CommandContext) {
  const current=this.projections.get(context.workItemId),source={commentId:context.commentId},actor={type:"human" as const,id:context.login};
  if(command.kind==="help") {
   const result=this.projections.present({workItemId:context.workItemId,expectedRevision:current.revision,actor,source,reason:{code:"help",summary:"Command reference requested"}});
   this.store.event("command.help",{commentId:context.commentId,login:context.login},context.workItemId);
   return {projection:result,recordIds:[]};
  }
  if(command.kind==="note"||command.kind==="replace") {
   this.requireMutable(current.status,command.kind);
   const ids:string[]=[];
   const result=this.projections.present({workItemId:context.workItemId,expectedRevision:current.revision,actor,source,reason:{code:command.kind,summary:command.kind==="note"?"Human instruction added":"Human instruction replaced"},recordIds:ids},()=>{
    const target=command.kind==="replace"?this.recordId(context.workItemId,command.recordId):undefined;
    if(target?.payload.kind==="decision")ids.push(this.records.create({workItemId:context.workItemId,specVersion:context.specVersion,scope:command.scope,payload:{kind:"decision",category:"human",decision:command.text,rationale:`Replacement from @${context.login}`,supersedes:[target.id]},sourceType:"github-comment",sourceId:String(context.commentId),actor:context.login}).id);
    else ids.push(this.records.create({workItemId:context.workItemId,specVersion:context.specVersion,scope:command.scope,appliesTo:command.appliesTo,payload:{kind:"instruction",text:command.text,supersedes:target?[target.id]:undefined},sourceType:"github-comment",sourceId:String(context.commentId),actor:context.login}).id);
   });
   return {projection:result,recordIds:ids};
  }
  if(command.kind==="revoke") {
   this.requireMutable(current.status,command.kind);
   const id=this.recordId(context.workItemId,command.recordId).id;
   const result=this.projections.present({workItemId:context.workItemId,expectedRevision:current.revision,actor,source,reason:{code:"revoke",summary:"Human guidance revoked"},recordIds:[id]},()=>{this.records.revokeHumanGuidance(id);});
   return {projection:result,recordIds:[id]};
  }
  if(command.kind==="approve") {
   const request=this.requireHumanRequest(context,"spec-approval");
   if(command.version!==context.specVersion)throw new Error(`Approval is for v${command.version}; active specification is v${context.specVersion}`);
   const spec=this.store.db.prepare("SELECT 1 FROM specs WHERE work_item_id=? AND version=?").get(context.workItemId,context.specVersion);
   if(!spec)throw new Error(`SPEC v${context.specVersion} is unavailable`);
   const ids=[request.id];
   const result=this.projections.transition({workItemId:context.workItemId,expectedRevision:current.revision,stage:"BUILD",status:"QUEUED",actor,source,reason:{code:"spec-approved",summary:`SPEC v${command.version} approved`},recordIds:ids},()=>{
    this.records.resolveRequest(request.id);
    this.store.db.prepare("UPDATE specs SET approved_by=?,approval_comment_id=?,approved_at=? WHERE work_item_id=? AND version=?").run(context.login,context.commentId,new Date().toISOString(),context.workItemId,context.specVersion);
    if(command.guidance)ids.push(this.records.create({workItemId:context.workItemId,specVersion:context.specVersion,scope:"spec",payload:{kind:"instruction",text:command.guidance},sourceType:"github-comment",sourceId:String(context.commentId),actor:context.login}).id);
   });
   return {projection:result,recordIds:ids};
  }
  if(command.kind==="answer") {
   const failure=this.failures.active(context.workItemId);
   if(current.status==="FAILED"&&failure?.class==="invalid-result") {
    assertExecutionStopped(this.store,context.workItemId);
    const ids:string[]=[];
    const result=this.projections.transition({workItemId:context.workItemId,expectedRevision:current.revision,stage:"DESIGN",status:"QUEUED",attemptDelta:1,actor,source,reason:{code:"spec-revision-requested",summary:"Human requested specification revision"},recordIds:ids},()=>{
     ids.push(this.records.create({workItemId:context.workItemId,specVersion:context.specVersion,scope:"spec",payload:{kind:"decision",category:"human",decision:command.text,rationale:`Specification revision from @${context.login}`,supersedes:[]},sourceType:"github-comment",sourceId:String(context.commentId),actor:context.login}).id);
     this.failures.resolve(failure.id,`comment:${context.commentId}`);
    });
    return {projection:result,recordIds:ids};
   }
   const request=this.requireHumanRequest(context);
   if(request.payload.kind==="request"&&request.payload.type==="spec-approval"){
    const ids:string[]=[request.id];
    const result=this.projections.transition({workItemId:context.workItemId,expectedRevision:current.revision,stage:"DESIGN",status:"QUEUED",actor,source,reason:{code:"spec-feedback",summary:"Human requested specification changes"},recordIds:ids},()=>{
     this.records.resolveRequest(request.id);
     ids.push(this.records.create({workItemId:context.workItemId,specVersion:context.specVersion,scope:"spec",payload:{kind:"decision",category:"human",decision:command.text,rationale:`Specification feedback from @${context.login}`,supersedes:[]},sourceType:"github-comment",sourceId:String(context.commentId),actor:context.login}).id);
    });
    return {projection:result,recordIds:ids};
   }
   if(request.payload.kind==="request"&&request.payload.type==="merge") {
    const ids:string[]=[request.id];
    const result=this.projections.transition({workItemId:context.workItemId,expectedRevision:current.revision,stage:"BUILD",status:"QUEUED",actor,source,reason:{code:"merge-feedback",summary:"Human requested pull request changes"},recordIds:ids},()=>{
     this.records.resolveRequest(request.id);
     ids.push(this.records.create({workItemId:context.workItemId,specVersion:context.specVersion,scope:"spec",payload:{kind:"finding",classification:"auto-fix",originRole:"reviewer",evidence:command.text},sourceType:"github-comment",sourceId:String(context.commentId),actor:context.login}).id);
    });
    return {projection:result,recordIds:ids};
   }
   if(request.payload.kind==="request"&&request.payload.type==="budget")throw new Error("This issue is waiting for a token budget extension; use /factory budget +<tokens>");
   if(!["clarification","correction-limit"].includes(request.payload.kind==="request"?request.payload.type:""))throw new Error(`Request ${request.id} cannot be answered with /factory answer`);
   const ids:string[]=[request.id];
   const result=this.projections.transition({workItemId:context.workItemId,expectedRevision:current.revision,stage:"DESIGN",status:"QUEUED",actor,source,reason:{code:"human-answer",summary:"Human guidance recorded"},recordIds:ids,correctionCycles:0},()=>{
    ids.push(this.records.create({workItemId:context.workItemId,specVersion:context.specVersion,scope:"spec",payload:{kind:"decision",category:"human",decision:command.text,rationale:`Answer from @${context.login}`,supersedes:[]},sourceType:"github-comment",sourceId:String(context.commentId),actor:context.login}).id);
    this.records.resolveRequest(request.id);
    if(request.payload.kind==="request"&&request.payload.type==="correction-limit")ids.push(this.records.create({workItemId:context.workItemId,specVersion:context.specVersion,scope:"spec",payload:{kind:"request",type:"tactical-decision",owner:"architect",originatingStage:request.payload.originatingStage,allowedReturnStages:this.returnStages(request.payload.originatingStage),openedAfterCommentId:context.commentId,findingIds:request.payload.findingIds},sourceType:"orchestrator",sourceId:`answer:${context.commentId}`,actor:"orchestrator"}).id);
   });
   return {projection:result,recordIds:ids};
  }
  if(command.kind==="retry") {
   if(!["FAILED","PAUSED","CANCELLED"].includes(current.status))throw new Error(`Cannot retry while workflow is ${current.status}`);
   assertExecutionStopped(this.store,context.workItemId);
   const ids:string[]=[];
   const next=this.projections.resumeStatus(context.workItemId),failure=this.failures.active(context.workItemId);
   const result=this.projections.transition({workItemId:context.workItemId,expectedRevision:current.revision,stage:current.stage,status:next,attemptDelta:next==="QUEUED"?1:0,actor,source,reason:{code:"retry",summary:"Human requested retry"},recordIds:ids},()=>{
    if(command.guidance)ids.push(this.records.create({workItemId:context.workItemId,specVersion:context.specVersion,scope:command.scope,appliesTo:command.appliesTo,payload:{kind:"instruction",text:command.guidance},sourceType:"github-comment",sourceId:String(context.commentId),actor:context.login}).id);
    if(failure)this.failures.resolve(failure.id,`comment:${context.commentId}`);
   });
   return {projection:result,recordIds:ids};
  }
  if(command.kind==="budget") {
   this.requireMutable(current.status,command.kind);
   const before=budgetState(this.store,context.workItemId),request=this.records.activeRequest(context.workItemId);
   const waiting=request?.payload.kind==="request"&&request.payload.type==="budget"&&request.payload.owner==="human";
   // Resuming only to pause again on the next tick helps nobody: say how much is still missing.
   if(waiting&&before.consumed>=before.granted+command.tokens)throw new Error(`The extension is not enough: ${formatTokens(before.consumed)} of ${formatTokens(before.granted)} tokens are consumed, so extend by more than ${formatTokens(before.consumed-before.granted)}`);
   const ids:string[]=[],create=()=>{ids.push(this.records.create({workItemId:context.workItemId,specVersion:context.specVersion,scope:"issue",payload:{kind:"budget",tokens:command.tokens,reason:command.reason,acknowledges:before.unknownRuns},sourceType:"github-comment",sourceId:String(context.commentId),actor:context.login}).id);};
   const summary=`Token budget extended by ${formatTokens(command.tokens)} to ${formatTokens(before.granted+command.tokens)}${before.unknownRuns.length?`; ${before.unknownRuns.length} run${before.unknownRuns.length===1?"":"s"} without reported usage acknowledged`:""}`;
   if(waiting&&current.status==="WAITING"){
    ids.push(request.id);
    const result=this.projections.transition({workItemId:context.workItemId,expectedRevision:current.revision,stage:current.stage,status:"QUEUED",actor,source,reason:{code:"budget-extended",summary},recordIds:ids},()=>{create();this.records.resolveRequest(request.id);});
    return {projection:result,recordIds:ids};
   }
   const result=this.projections.present({workItemId:context.workItemId,expectedRevision:current.revision,actor,source,reason:{code:"budget-extended",summary},recordIds:ids},()=>{create();if(waiting)this.records.resolveRequest(request.id);});
   return {projection:result,recordIds:ids};
  }
  if(command.kind==="pause") {
   if(!["QUEUED","RUNNING","WAITING"].includes(current.status))throw new Error(`Cannot pause while workflow is ${current.status}`);
   const result=this.projections.transition({workItemId:context.workItemId,expectedRevision:current.revision,stage:current.stage,status:"PAUSED",actor,source,reason:{code:"user-pause",summary:command.reason?`Human paused work: ${command.reason}`:"Human paused work"}});
   return {projection:result,recordIds:[],executionAction:current.activeRunId?{kind:"interrupt" as const,runId:current.activeRunId,reason:"user-pause"}:undefined};
  }
  if(command.kind==="cancel") {
   if(["COMPLETED","CANCELLED"].includes(current.status))throw new Error(`Cannot cancel while workflow is ${current.status}`);
   const ids=this.records.openRequests(context.workItemId).map(record=>record.id).reverse();
   const failure=this.failures.active(context.workItemId);
   const result=this.projections.transition({workItemId:context.workItemId,expectedRevision:current.revision,stage:current.stage,status:"CANCELLED",actor,source,reason:{code:"cancel",summary:command.reason?`Human cancelled work: ${command.reason}`:"Human cancelled work"},recordIds:ids},()=>{
    for(const id of ids)this.records.cancelRequest(id);
    if(failure)this.failures.resolve(failure.id,`comment:${context.commentId}`);
   });
   const running=current.activeRunId??(this.store.db.prepare("SELECT id FROM executions WHERE work_item_id=? AND status='running' ORDER BY started_at DESC LIMIT 1").get(context.workItemId) as {id:string}|undefined)?.id;
   return {projection:result,recordIds:ids,executionAction:running?{kind:"cancel" as const,runId:running}:undefined};
  }
  throw new Error(`Unsupported command ${(command as FactoryCommand).kind}`);
 }
 private requireHumanRequest(context:CommandContext,type?:string) {
  const request=this.records.activeRequest(context.workItemId);
  if(!request||request.payload.kind!=="request"||request.payload.owner!=="human")throw new Error("No active human request");
  if(type&&request.payload.type!==type)throw new Error(`Active request is ${request.payload.type}, not ${type}`);
  if(context.commentId<=request.payload.openedAfterCommentId)throw new Error(`Command is stale; request opened after comment ${request.payload.openedAfterCommentId}`);
  return request;
 }
 private recordId(workItemId:string,prefix:string) {
  if(prefix.startsWith("#")){
   const ordinal=Number(prefix.slice(1)),record=this.records.humanGuidance(workItemId,false)[ordinal-1];
   if(!record)throw new Error(`no guidance entry ${prefix}`);
   if(record.status!=="active")throw new Error(`Guidance entry ${prefix} is not active`);
   return record;
  }
  const matches=(this.store.db.prepare("SELECT id FROM records WHERE work_item_id=? AND id LIKE ? ORDER BY sequence").all(workItemId,`${prefix}%`) as Array<{id:string}>).map(row=>this.records.get(row.id)!);
  const rows=matches.filter(record=>record.status==="active"&&(record.payload.kind==="instruction"||(record.payload.kind==="decision"&&record.payload.category==="human")));
  if(rows.length!==1){if(rows.length)throw new Error(`Record prefix ${prefix} is ambiguous`);if(matches.length)throw new Error(`Record ${prefix} is not active human guidance; only instructions and human decisions may be changed`);throw new Error(`Active human guidance ${prefix} was not found`);}return rows[0];
 }
 private requireMutable(status:string,command:string) {if(["COMPLETED","CANCELLED"].includes(status))throw new Error(`Cannot ${command} while workflow is ${status}`);}
 private returnStages(stage:"DESIGN"|"BUILD"|"TEST"|"REVIEW"|"DELIVERY") {return stage==="BUILD"?["BUILD" as const]:stage==="TEST"?["BUILD" as const,"TEST" as const]:stage==="REVIEW"?["BUILD" as const,"TEST" as const,"REVIEW" as const]:[stage];}
}

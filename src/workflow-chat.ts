import fs from "node:fs";
import path from "node:path";
import {config} from "./config.js";
import type {Store} from "./storage.js";
import type {AgentResult,AgentRole} from "./types.js";
import {resultMarkdown,isMilestoneResult,publicationOf,resultPublicationKey,failurePublicationKey,statusPublicationKey,PUBLICATION_ATTENTION_ATTEMPTS,type WorkflowPublication} from "./workflow-github.js";
import {WorkflowFailures} from "./workflow-failures.js";
import {workflowFailureEvidence} from "./failure-report.js";
import type {WorkflowProjection} from "./workflow-projection.js";
import {WorkflowRecords,type WorkflowRecord} from "./workflow-records.js";
import {WorkflowCommands} from "./workflow-commands.js";
import type {FactoryCommand} from "./factory-command.js";
import type {RuntimeGitHub} from "./github-runtime.js";
import {WorkflowProjections} from "./workflow-projection.js";
import type {ExecutionManager} from "./execution-manager.js";
import type {WorkflowRunner} from "./workflow-runner.js";
import {diagnoseWorkItem} from "./failure-diagnostics.js";
import {executionOutcomeText,workflowExecutionSummary} from "./execution-presentation.js";
import {progressKey,progressWarning,type ExecutionProgress} from "./execution-progress.js";
import {budgetState,budgetWarningThresholds} from "./budget.js";

export type WorkflowThreadTurn={id:number;at:string;kind:"execution"|"event"|"human";executionId?:string;[key:string]:unknown};
export type MessageAction="answer"|"approve"|"retry"|"note"|"interrupt-retry"|"budget";
type ActiveRequest=WorkflowRecord<Extract<WorkflowRecord["payload"],{kind:"request"}>>|undefined;

// Extending the budget is offered where it matters: when the issue waits for it, and once a budget
// warning has been announced. It stays available as a GitHub command at any other time.
export function messageActions(projection:Pick<WorkflowProjection,"status">,request?:ActiveRequest,canReviseSpecification=false,budgetWarned=false):MessageAction[]{
 const actions=baseMessageActions(projection,request,canReviseSpecification);
 return budgetWarned&&!actions.includes("budget")&&!["COMPLETED","CANCELLED"].includes(projection.status)?[...actions,"budget"]:actions;
}
function baseMessageActions(projection:Pick<WorkflowProjection,"status">,request?:ActiveRequest,canReviseSpecification=false):MessageAction[]{
 if(projection.status==="WAITING"&&request?.payload.kind==="request"){
  if(request.payload.type==="budget")return["budget"];
  if(["clarification","correction-limit","merge"].includes(request.payload.type))return["answer"];
  if(request.payload.type==="spec-approval")return["approve","answer"];
 }
 if(projection.status==="FAILED")return canReviseSpecification?["answer","retry","note"]:["retry","note"];
 if(["PAUSED","CANCELLED"].includes(projection.status))return["retry","note"];
 if(projection.status==="RUNNING")return["note","interrupt-retry"];
 if(projection.status==="QUEUED")return["note"];
 return[];
}

export function availableMessageActions(store:Store,workItemId:string){const row=store.db.prepare("SELECT status FROM work_items WHERE id=? AND archived_at IS NULL").get(workItemId) as {status:WorkflowProjection["status"]}|undefined;if(!row)throw Object.assign(new Error("Unknown work item"),{statusCode:404});return messageActions(row,new WorkflowRecords(store).activeRequest(workItemId) as ActiveRequest,new WorkflowFailures(store).active(workItemId)?.class==="invalid-result",budgetState(store,workItemId).percent>=budgetWarningThresholds[0]);}

function budgetMessage(text:string){const match=text.match(/^\+?\s*(\d+)(?:\s+([\s\S]*))?$/);if(!match||!Number.isSafeInteger(Number(match[1])))throw new Error("Enter the tokens to add, for example +250000, optionally followed by a reason");return{tokens:Number(match[1]),reason:(match[2]??"").trim()};}
function messageCommand(action:Exclude<MessageAction,"interrupt-retry">,text:string,specVersion:number):FactoryCommand{
 if(action==="budget")return{kind:"budget",...budgetMessage(text)};
 if(action==="answer")return{kind:"answer",text};
 if(action==="approve")return{kind:"approve",version:specVersion,guidance:text};
 if(action==="retry")return{kind:"retry",guidance:text,scope:"spec",appliesTo:[]};
 return{kind:"note",text,scope:"spec",appliesTo:[]};
}
function commandBody(action:Exclude<MessageAction,"interrupt-retry">,text:string,specVersion:number,login:string){if(action==="budget"){const budget=budgetMessage(text);return `/factory budget +${budget.tokens}${budget.reason?`\n\n${budget.reason}`:""}\n\nby @${login} from ${config.instanceName}`;}const line=action==="approve"?`/factory approve v${specVersion}`:`/factory ${action}`;return `${line}${text?`\n\n${text}`:""}\n\nby @${login} from ${config.instanceName}`;}

export async function applyMessageControl(store:Store,github:RuntimeGitHub,control:{id:number;target:string},login:string){
 const input=JSON.parse(control.target) as {workItemId?:string;text?:string;action?:MessageAction},workItemId=String(input.workItemId??""),text=String(input.text??"").trim(),action=input.action;
 if(!workItemId||!action||action==="interrupt-retry")throw new Error("Invalid message control");
 if(!availableMessageActions(store,workItemId).includes(action))throw new Error(`Cannot ${action} in the current workflow state`);
 if(["answer","note"].includes(action)&&!text)throw new Error(`${action} requires message text`);
 const issue=(store.db.prepare("SELECT issue_number FROM work_items WHERE id=?").get(workItemId) as {issue_number:number}|undefined)?.issue_number;if(!issue)throw new Error("Unknown work item");
 const specVersion=(store.db.prepare("SELECT COALESCE(MAX(version),0) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number}).version,key=`message-${control.id}`,body=commandBody(action,text,specVersion,login),commentId=Number(await github.publishWorkflowComment(issue,key,body));
 if(!Number.isSafeInteger(commentId)||commentId<=0)throw new Error("GitHub did not return the published message id");
 try{
  const result=new WorkflowCommands(store).apply(messageCommand(action,text,specVersion),{workItemId,login,commentId,specVersion});
  if(result.recordIds.length)store.db.prepare(`UPDATE records SET source_type='dashboard' WHERE work_item_id=? AND source_id=?`).run(workItemId,String(commentId));
  store.event("command.applied",{commentId,login,command:action,text,source:"dashboard"},workItemId);
  return{...result,commentId};
 }catch(error){const reason=error instanceof Error?error.message:String(error),marker=`<!-- ai-factory:workflow-comment:${config.repo}:${issue}:${key} -->`;if(!github.editComment)throw new Error(`${reason}; the published GitHub comment could not be marked rejected`);await github.editComment(commentId,`${body}\n\nRejected: ${reason}\n\n${marker}`);throw error;}
}

export async function applyInterruptRetryControl(store:Store,github:RuntimeGitHub,executions:ExecutionManager,runner:WorkflowRunner,control:{id:number;target:string},login:string,waitMs=30_000){
 const input=JSON.parse(control.target) as {workItemId?:string;text?:string;action?:MessageAction},workItemId=String(input.workItemId??""),text=String(input.text??"").trim();
 if(!workItemId||input.action!=="interrupt-retry"||!text)throw new Error("Interrupt and retry requires guidance text");
 const records=new WorkflowRecords(store),projection=new WorkflowProjections(store),current=projection.get(workItemId);
 if(!messageActions(current,records.activeRequest(workItemId) as ActiveRequest).includes("interrupt-retry")||!current.activeRunId)throw new Error("Cannot interrupt and retry in the current workflow state");
 const issue=(store.db.prepare("SELECT issue_number FROM work_items WHERE id=?").get(workItemId) as {issue_number:number}|undefined)?.issue_number;if(!issue)throw new Error("Unknown work item");
 const specVersion=(store.db.prepare("SELECT COALESCE(MAX(version),0) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number}).version,key=`message-${control.id}`,body=commandBody("retry",text,specVersion,login),commentId=Number(await github.publishWorkflowComment(issue,key,body));
 if(!Number.isSafeInteger(commentId)||commentId<=0)throw new Error("GitHub did not return the published message id");
 try{
  const interruptedAt=new Date().toISOString();
  executions.interrupt(current.activeRunId,"interrupted-for-guidance");
  const deadline=Date.now()+waitMs;while(Date.now()<deadline){const execution=store.db.prepare("SELECT status FROM executions WHERE id=?").get(current.activeRunId) as {status:string}|undefined;if(!execution||execution.status!=="running")break;await new Promise(resolve=>setTimeout(resolve,Math.min(25,waitMs)));}
  const execution=store.db.prepare("SELECT status FROM executions WHERE id=?").get(current.activeRunId) as {status:string}|undefined;if(execution?.status==="running")throw new Error(`The active process did not stop within ${Math.round(waitMs/1000)} seconds`);
  projection.transition({workItemId,expectedRevision:current.revision,stage:current.stage,status:"PAUSED",actor:{type:"human",id:login},source:{commentId,executionId:current.activeRunId},reason:{code:"interrupted-for-guidance",summary:"Human interrupted the active attempt with new guidance"}});
  await runner.preserve(workItemId);
  const result=new WorkflowCommands(store).apply(messageCommand("retry",text,specVersion),{workItemId,login,commentId,specVersion});
  if(result.recordIds.length)store.db.prepare(`UPDATE records SET source_type='dashboard' WHERE work_item_id=? AND source_id=?`).run(workItemId,String(commentId));
  runner.recordPreviousAttempt(workItemId,current.activeRunId,interruptedAt,"interrupted-for-guidance",result.recordIds.at(-1));
  store.event("command.applied",{commentId,login,command:"interrupt-retry",text,source:"dashboard"},workItemId);return{...result,commentId};
 }catch(error){const reason=error instanceof Error?error.message:String(error),marker=`<!-- ai-factory:workflow-comment:${config.repo}:${issue}:${key} -->`;if(github.editComment)await github.editComment(commentId,`${body}\n\nRejected: ${reason}\n\n${marker}`);throw error;}
}
const safeJson=(file:string)=>{try{return JSON.parse(fs.readFileSync(file,"utf8")) as Record<string,unknown>;}catch{return{};}};
export function promptArtifact(executionId:string){const root=path.join(config.dataDir,"runs",path.basename(executionId)),file=path.join(root,"prompt.md");if(path.basename(executionId)!==executionId||!fs.existsSync(file))return{available:false};const bytes=fs.readFileSync(file),limit=512*1024;return{available:true,prompt:bytes.subarray(0,limit).toString("utf8"),truncated:bytes.length>limit};}

export type ThreadPublication={status:"pending"}|{status:"published";commentId:number|null;url:string|null;publishedAt:string}|{status:"failed";attempts:number;error:string;failedAt:string;needsAttention:boolean};
/** Publication state of one milestone as the dashboard shows it: pending until GitHub confirmed the comment, then published with its link, or failed with the stored attempt count. */
export function threadPublication(store:Store,key:string):ThreadPublication{
 const value=publicationOf(store,key);
 if(value?.status==="published")return{status:"published",commentId:value.commentId,url:value.url,publishedAt:value.publishedAt};
 if(value?.status==="failed")return{status:"failed",attempts:value.attempts,error:value.error,failedAt:value.failedAt,needsAttention:value.attempts>=PUBLICATION_ATTENTION_ATTEMPTS};
 return{status:"pending"};
}
export type StatusPublication={revision:number;publishedRevision:number|null;behind:boolean;url:string|null;publishedAt:string|null;error:string|null;attempts:number;needsAttention:boolean};
/** State of the editable issue status comment relative to the local presentation revision. */
export function statusPublication(store:Store,workItemId:string):StatusPublication{
 const row=store.db.prepare("SELECT presentation_revision,published_presentation_revision FROM work_items WHERE id=?").get(workItemId) as {presentation_revision:number;published_presentation_revision:number|null}|undefined;
 if(!row)throw Object.assign(new Error("Unknown work item"),{statusCode:404});
 const value:WorkflowPublication|undefined=publicationOf(store,statusPublicationKey(workItemId)),failed=value?.status==="failed"?value:undefined,published=value?.status==="published"?value:undefined;
 return{revision:row.presentation_revision,publishedRevision:row.published_presentation_revision,behind:row.presentation_revision>(row.published_presentation_revision??-1),url:published?.url??null,publishedAt:published?.publishedAt??null,error:failed?.error??null,attempts:failed?.attempts??0,needsAttention:(failed?.attempts??0)>=PUBLICATION_ATTENTION_ATTEMPTS};
}

export type WorkflowContinuation={at:string;instance:string;revision:number|null;publishedAt:string|null;earlierTurns:boolean};
/** Every time this installation adopted the item from another one, oldest first; earlierTurns says whether local history predates it. */
export function workflowContinuations(store:Store,workItemId:string):WorkflowContinuation[]{
 const rows=store.db.prepare("SELECT id,ts,payload FROM events WHERE work_item_id=? AND type='workflow.transition' ORDER BY id").all(workItemId) as Array<{id:number;ts:string;payload:string}>;
 const firstTurn=(store.db.prepare("SELECT MIN(id) id FROM events WHERE work_item_id=? AND type IN ('execution.started','agent.result','command.applied','command.rejected','command.deferred','command.expired') ").get(workItemId) as {id:number|null}).id;
 const result:WorkflowContinuation[]=[];let ordinary:number|null=null;
 for(const row of rows){let value:any={};try{value=JSON.parse(row.payload);}catch{}
  if(value.reason?.code!=="continued"){ordinary??=row.id;continue;}
  const earliest=Math.min(ordinary??Infinity,firstTurn??Infinity);
  result.push({at:row.ts,instance:String(value.reason.instance??value.reason.summary?.match(/^Continued from (.+) at revision/)?.[1]??"another instance"),revision:Number.isSafeInteger(value.reason.revision)?value.reason.revision:null,publishedAt:value.reason.publishedAt??null,earlierTurns:earliest<row.id});
 }
 return result;
}

export function workflowThread(store:Store,workItemId:string):WorkflowThreadTurn[]{
 if(!store.db.prepare("SELECT 1 FROM work_items WHERE id=?").get(workItemId))throw Object.assign(new Error("Unknown work item"),{statusCode:404});
 const rows=store.db.prepare("SELECT id,ts,run_id,type,payload FROM events WHERE work_item_id=? ORDER BY id").all(workItemId) as Array<{id:number;ts:string;run_id:string|null;type:string;payload:string}>;
 const turns:WorkflowThreadTurn[]=[],executions=new Map<string,WorkflowThreadTurn>();
 // One turn per agent execution: the prompt manifest, the result and the outcome of the same run share it, so a reader sees start, duration and output together.
 const executionTurn=(runId:string,row:{id:number;ts:string})=>{let turn=executions.get(runId);if(turn)return turn;const manifest=safeJson(path.join(config.dataDir,"runs",path.basename(runId),"prompt.json"));turn={id:row.id,at:row.ts,kind:"execution",executionId:runId,role:manifest.role??null,provider:manifest.provider??null,model:manifest.model??null,manifest:{sections:manifest.sectionBytes??{},budgetBytes:manifest.budgetBytes??null,budgetSource:manifest.budgetSource??null,includedRecordIds:manifest.includedRecordIds??[],activeRequestId:manifest.activeRequestId??null,promptBytes:manifest.promptBytes??null},available:promptArtifact(runId).available,startedAt:null,finishedAt:null,durationMs:null,status:null};executions.set(runId,turn);turns.push(turn);return turn;};
 for(const row of rows){let value:any={};try{value=JSON.parse(row.payload);}catch{}
  if(row.type==="execution.started"&&row.run_id){const turn=executionTurn(row.run_id,row);Object.assign(turn,{role:value.role??turn.role,provider:value.selection?.provider??turn.provider,model:value.selection?.model??turn.model,startedAt:row.ts});continue;}
  if(row.type==="agent.result"&&row.run_id){const role=value.role as AgentRole,result=value.result as AgentResult;const turn=executionTurn(row.run_id,row);const publication=result&&isMilestoneResult(store,{work_item_id:workItemId,run_id:row.run_id},{role,result})?threadPublication(store,resultPublicationKey(row.id)):undefined;Object.assign(turn,{at:row.ts,resultEventId:row.id,role:role??turn.role,outcome:result?.outcome,markdown:result?resultMarkdown(role,result,value.specVersion??0):"Result unavailable",result,...(publication?{publication}:{})});continue;}
  if(row.type==="execution.finished"&&row.run_id){const turn=value.status!=="succeeded"?executionTurn(row.run_id,row):executions.get(row.run_id);if(!turn)continue;turn.finishedAt=row.ts;if(value.status!=="succeeded"){Object.assign(turn,{at:row.ts,status:value.status,reason:typeof value.providerError==="string"?value.providerError:executionOutcomeText(value.status,value.interruptionReason,value.role??turn.role)??`Execution ${value.status}`});}continue;}
  if(row.type==="execution.invalid_result"&&row.run_id){const turn=executionTurn(row.run_id,row);Object.assign(turn,{at:row.ts,rejection:String(value.message??"Result rejected by the validator")});continue;}
  if(row.type==="workflow.transition"&&value.reason?.code==="continued")continue;
  if(row.type==="workflow.transition"){const transition={stage:value.to?.stage,status:value.to?.status,reason:workflowExecutionSummary(value.reason?.summary??"Workflow changed",value.to?.stage),actor:value.actor??null};const turn:WorkflowThreadTurn={id:row.id,at:row.ts,kind:"event",...transition,milestone:value.reason?.code==="invalid-result-retry"||["WAITING","FAILED","PAUSED","CANCELLED","COMPLETED"].includes(value.to?.status)&&value.reason?.code!=="continued"};if(value.to?.status==="FAILED"){const failure=new WorkflowFailures(store).active(workItemId);if(failure){turn.failure=workflowFailureEvidence(store,failure);turn.diagnosis=diagnoseWorkItem(store,workItemId);turn.publication=threadPublication(store,failurePublicationKey(failure.id));}}turns.push(turn);continue;}
  if(row.type.startsWith("command.")){const records=(store.db.prepare("SELECT id,payload,source_type FROM records WHERE work_item_id=? AND source_id=? ORDER BY sequence").all(workItemId,String(value.commentId??"")) as Array<{id:string;payload:string;source_type:string}>).map(record=>({id:record.id,...JSON.parse(record.payload)}));const transition=rows.slice(0,rows.indexOf(row)+1).reverse().find(candidate=>candidate.type==="workflow.transition"&&(()=>{try{return JSON.parse(candidate.payload).source?.commentId===value.commentId;}catch{return false;}})());let actor:any;try{actor=transition?JSON.parse(transition.payload).actor:null;}catch{}turns.push({id:row.id,at:row.ts,kind:"human",milestone:true,login:value.login??actor?.id??"unknown",command:value.command??row.type.slice(8),text:records.map(record=>(record as any).text??(record as any).decision??(record as any).evidence).filter(Boolean).join("\n")||value.text||"",source:value.source??(records.some(record=>record.source_type==="dashboard")?"dashboard":"comment"),outcome:row.type.slice(8),records});}
 }
 const timing=store.db.prepare("SELECT status,started_at,finished_at FROM executions WHERE id=? AND work_item_id=?");
 const rejected=new Map((store.db.prepare("SELECT execution_id,message,created_at FROM failures WHERE work_item_id=? AND class='invalid-result' AND execution_id IS NOT NULL").all(workItemId) as Array<{execution_id:string;message:string;created_at:string}>).map(row=>[row.execution_id,row]));
 for(const turn of executions.values()){
  const run=timing.get(turn.executionId,workItemId) as {status:string;started_at:string;finished_at:string|null}|undefined;
  const startedAt=run?.started_at??(turn.startedAt as string|null)??null,finishedAt=run?.finished_at??(turn.finishedAt as string|null)??(turn.result?String(turn.at):null);
  const started=startedAt?Date.parse(startedAt):NaN,finished=finishedAt?Date.parse(finishedAt):NaN;
  const rejectedFailure=rejected.get(String(turn.executionId));if(rejectedFailure&&!turn.rejection)Object.assign(turn,{at:rejectedFailure.created_at,rejection:rejectedFailure.message});
  const status=turn.rejection?"rejected":turn.status??(run?run.status==="running"&&run.finished_at?"failed":run.status:turn.result?"succeeded":finishedAt?"succeeded":"running");
  if(status==="running"&&startedAt){const progress=store.metadata<ExecutionProgress>(progressKey(String(turn.executionId)));const warning=progressWarning(progress,startedAt);turn.progress={events:progress?.events??0,lastProgressAt:progress?.lastProgressAt??null,tool:progress?.tool??null,toolStartedAt:progress?.toolStartedAt??null,warning:warning?.reason??null};}
  // A milestone execution is one whose result GitHub gets as a permanent comment, or one whose process did not finish cleanly.
  Object.assign(turn,{startedAt,finishedAt,durationMs:Number.isFinite(started)&&Number.isFinite(finished)&&finished>=started?finished-started:null,status,reason:turn.rejection?`Result rejected: ${turn.rejection}`:turn.reason,milestone:Boolean(turn.publication)||!["running","succeeded"].includes(String(status))});
 }
 return turns;
}

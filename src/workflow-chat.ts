import fs from "node:fs";
import path from "node:path";
import {config} from "./config.js";
import type {Store} from "./storage.js";
import type {AgentResult,AgentRole} from "./types.js";
import {resultMarkdown} from "./workflow-github.js";
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

export type WorkflowThreadTurn={id:number;at:string;kind:"prompt"|"result"|"event"|"human";executionId?:string;[key:string]:unknown};
export type MessageAction="answer"|"approve"|"retry"|"note"|"interrupt-retry";
type ActiveRequest=WorkflowRecord<Extract<WorkflowRecord["payload"],{kind:"request"}>>|undefined;

export function messageActions(projection:Pick<WorkflowProjection,"status">,request?:ActiveRequest,canReviseSpecification=false):MessageAction[]{
 if(projection.status==="WAITING"&&request?.payload.kind==="request"){
  if(["clarification","correction-limit","merge"].includes(request.payload.type))return["answer"];
  if(request.payload.type==="spec-approval")return["approve","answer"];
 }
 if(projection.status==="FAILED")return canReviseSpecification?["answer","retry","note"]:["retry","note"];
 if(["PAUSED","CANCELLED"].includes(projection.status))return["retry","note"];
 if(projection.status==="RUNNING")return["note","interrupt-retry"];
 if(projection.status==="QUEUED")return["note"];
 return[];
}

export function availableMessageActions(store:Store,workItemId:string){const row=store.db.prepare("SELECT status FROM work_items WHERE id=? AND archived_at IS NULL").get(workItemId) as {status:WorkflowProjection["status"]}|undefined;if(!row)throw Object.assign(new Error("Unknown work item"),{statusCode:404});return messageActions(row,new WorkflowRecords(store).activeRequest(workItemId) as ActiveRequest,new WorkflowFailures(store).active(workItemId)?.class==="invalid-result");}

function messageCommand(action:Exclude<MessageAction,"interrupt-retry">,text:string,specVersion:number):FactoryCommand{
 if(action==="answer")return{kind:"answer",text};
 if(action==="approve")return{kind:"approve",version:specVersion,guidance:text};
 if(action==="retry")return{kind:"retry",guidance:text,scope:"spec",appliesTo:[]};
 return{kind:"note",text,scope:"spec",appliesTo:[]};
}
function commandBody(action:Exclude<MessageAction,"interrupt-retry">,text:string,specVersion:number,login:string){const line=action==="approve"?`/factory approve v${specVersion}`:`/factory ${action}`;return `${line}${text?`\n\n${text}`:""}\n\nby @${login} from ${config.instanceName}`;}

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

export function workflowThread(store:Store,workItemId:string):WorkflowThreadTurn[]{
 if(!store.db.prepare("SELECT 1 FROM work_items WHERE id=?").get(workItemId))throw Object.assign(new Error("Unknown work item"),{statusCode:404});
 const rows=store.db.prepare("SELECT id,ts,run_id,type,payload FROM events WHERE work_item_id=? ORDER BY id").all(workItemId) as Array<{id:number;ts:string;run_id:string|null;type:string;payload:string}>;
 const turns:WorkflowThreadTurn[]=[];
 for(const row of rows){let value:any={};try{value=JSON.parse(row.payload);}catch{}
  if(row.type==="execution.started"&&row.run_id){const manifest=safeJson(path.join(config.dataDir,"runs",path.basename(row.run_id),"prompt.json"));turns.push({id:row.id,at:row.ts,kind:"prompt",executionId:row.run_id,role:value.role,provider:value.selection?.provider??manifest.provider??null,model:value.selection?.model??manifest.model??null,manifest:{sections:manifest.sectionBytes??{},budgetBytes:manifest.budgetBytes??null,budgetSource:manifest.budgetSource??null,includedRecordIds:manifest.includedRecordIds??[],activeRequestId:manifest.activeRequestId??null,promptBytes:manifest.promptBytes??null},available:promptArtifact(row.run_id).available});continue;}
  if(row.type==="agent.result"&&row.run_id){const role=value.role as AgentRole,result=value.result as AgentResult;turns.push({id:row.id,at:row.ts,kind:"result",executionId:row.run_id,role,outcome:result?.outcome,markdown:result?resultMarkdown(role,result,value.specVersion??0):"Result unavailable",result});continue;}
  if(row.type==="workflow.transition"){const transition={stage:value.to?.stage,status:value.to?.status,reason:workflowExecutionSummary(value.reason?.summary??"Workflow changed",value.to?.stage),actor:value.actor??null};const turn:WorkflowThreadTurn={id:row.id,at:row.ts,kind:"event",...transition};if(value.to?.status==="FAILED"){const failure=new WorkflowFailures(store).active(workItemId);if(failure){turn.failure=workflowFailureEvidence(store,failure);turn.diagnosis=diagnoseWorkItem(store,workItemId);}}turns.push(turn);continue;}
  if(row.type==="execution.finished"&&value.status!=="succeeded"){turns.push({id:row.id,at:row.ts,kind:"event",executionId:row.run_id??undefined,status:value.status,reason:executionOutcomeText(value.status,value.interruptionReason,value.role)??`Execution ${value.status}`});continue;}
  if(row.type.startsWith("command.")){const records=(store.db.prepare("SELECT id,payload,source_type FROM records WHERE work_item_id=? AND source_id=? ORDER BY sequence").all(workItemId,String(value.commentId??"")) as Array<{id:string;payload:string;source_type:string}>).map(record=>({id:record.id,...JSON.parse(record.payload)}));const transition=rows.slice(0,rows.indexOf(row)+1).reverse().find(candidate=>candidate.type==="workflow.transition"&&(()=>{try{return JSON.parse(candidate.payload).source?.commentId===value.commentId;}catch{return false;}})());let actor:any;try{actor=transition?JSON.parse(transition.payload).actor:null;}catch{}turns.push({id:row.id,at:row.ts,kind:"human",login:value.login??actor?.id??"unknown",command:value.command??row.type.slice(8),text:records.map(record=>(record as any).text??(record as any).decision??(record as any).evidence).filter(Boolean).join("\n")||value.text||"",source:value.source??(records.some(record=>record.source_type==="dashboard")?"dashboard":"comment"),outcome:row.type.slice(8),records});}
 }
 return turns;
}

import fs from "node:fs";
import path from "node:path";
import {config} from "./config.js";
import type {Store} from "./storage.js";
import type {AgentResult,AgentRole} from "./types.js";
import {resultMarkdown} from "./workflow-github.js";
import {WorkflowFailures} from "./workflow-failures.js";
import {workflowFailureEvidence} from "./failure-report.js";

export type WorkflowThreadTurn={id:number;at:string;kind:"prompt"|"result"|"event"|"human";executionId?:string;[key:string]:unknown};
const safeJson=(file:string)=>{try{return JSON.parse(fs.readFileSync(file,"utf8")) as Record<string,unknown>;}catch{return{};}};
export function promptArtifact(executionId:string){const root=path.join(config.dataDir,"runs",path.basename(executionId)),file=path.join(root,"prompt.md");if(path.basename(executionId)!==executionId||!fs.existsSync(file))return{available:false};const bytes=fs.readFileSync(file),limit=512*1024;return{available:true,prompt:bytes.subarray(0,limit).toString("utf8"),truncated:bytes.length>limit};}

export function workflowThread(store:Store,workItemId:string):WorkflowThreadTurn[]{
 if(!store.db.prepare("SELECT 1 FROM work_items WHERE id=?").get(workItemId))throw Object.assign(new Error("Unknown work item"),{statusCode:404});
 const rows=store.db.prepare("SELECT id,ts,run_id,type,payload FROM events WHERE work_item_id=? ORDER BY id").all(workItemId) as Array<{id:number;ts:string;run_id:string|null;type:string;payload:string}>;
 const turns:WorkflowThreadTurn[]=[];
 for(const row of rows){let value:any={};try{value=JSON.parse(row.payload);}catch{}
  if(row.type==="execution.started"&&row.run_id){const manifest=safeJson(path.join(config.dataDir,"runs",path.basename(row.run_id),"prompt.json"));turns.push({id:row.id,at:row.ts,kind:"prompt",executionId:row.run_id,role:value.role,provider:value.selection?.provider??manifest.provider??null,model:value.selection?.model??manifest.model??null,manifest:{sections:manifest.sectionBytes??{},budgetBytes:manifest.budgetBytes??null,budgetSource:manifest.budgetSource??null,includedRecordIds:manifest.includedRecordIds??[],activeRequestId:manifest.activeRequestId??null,promptBytes:manifest.promptBytes??null},available:promptArtifact(row.run_id).available});continue;}
  if(row.type==="agent.result"&&row.run_id){const role=value.role as AgentRole,result=value.result as AgentResult;turns.push({id:row.id,at:row.ts,kind:"result",executionId:row.run_id,role,outcome:result?.outcome,markdown:result?resultMarkdown(role,result,value.specVersion??0):"Result unavailable",result});continue;}
  if(row.type==="workflow.transition"){const transition={stage:value.to?.stage,status:value.to?.status,reason:value.reason?.summary??"Workflow changed",actor:value.actor??null};const turn:WorkflowThreadTurn={id:row.id,at:row.ts,kind:"event",...transition};if(value.to?.status==="FAILED"){const failure=new WorkflowFailures(store).active(workItemId);if(failure)turn.failure=workflowFailureEvidence(store,failure);}turns.push(turn);continue;}
  if(row.type==="execution.finished"&&value.status!=="succeeded"){turns.push({id:row.id,at:row.ts,kind:"event",executionId:row.run_id??undefined,status:value.status,reason:value.interruptionReason??`Execution ${value.status}`});continue;}
  if(row.type.startsWith("command.")){const records=(store.db.prepare("SELECT id,payload,source_type FROM records WHERE work_item_id=? AND source_id=? ORDER BY sequence").all(workItemId,String(value.commentId??"")) as Array<{id:string;payload:string;source_type:string}>).map(record=>({id:record.id,...JSON.parse(record.payload)}));const transition=rows.slice(0,rows.indexOf(row)+1).reverse().find(candidate=>candidate.type==="workflow.transition"&&(()=>{try{return JSON.parse(candidate.payload).source?.commentId===value.commentId;}catch{return false;}})());let actor:any;try{actor=transition?JSON.parse(transition.payload).actor:null;}catch{}turns.push({id:row.id,at:row.ts,kind:"human",login:value.login??actor?.id??"unknown",command:value.command??row.type.slice(8),text:records.map(record=>(record as any).text??(record as any).decision??(record as any).evidence).filter(Boolean).join("\n"),source:records.some(record=>record.source_type==="dashboard")?"dashboard":"comment",outcome:row.type.slice(8),records});}
 }
 return turns;
}

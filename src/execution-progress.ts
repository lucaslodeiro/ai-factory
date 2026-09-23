import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import type {AgentProvider} from "./types.js";
import {tokenUsageReducer} from "./token-usage.js";
import {sanitizeFailureEvidence} from "./failure-report.js";

/** Bounded, content-free progress derived from a provider's NDJSON stream. */
export interface ExecutionProgress {
 provider:AgentProvider|null;
 events:number;
 lastEventAt:string|null;
 lastProgressAt:string|null;
 tool:string|null;
 toolStartedAt:string|null;
 lastTool:string|null;
 repeatedToolCalls:number;
 usageTokens:number|null;
 validationAttempts:number;
 lastValidationError:string|null;
}

const maxLine=10_000_000;
const label=(value:unknown)=>typeof value==="string"&&value.length?value.slice(0,80):"Tool";

export function progressMonitor(logDir:string,provider:AgentProvider|null){
 const file=path.join(logDir,"stdout.log");
 let offset=0,pending=Buffer.alloc(0),oversized=false;
 let lastSignature="";
 const active=new Map<string,{name:string;at:string}>();
 let usage=tokenUsageReducer(provider??undefined);
 const progress:ExecutionProgress={provider,events:0,lastEventAt:null,lastProgressAt:null,tool:null,toolStartedAt:null,lastTool:null,repeatedToolCalls:0,usageTokens:null,validationAttempts:0,lastValidationError:null};
 const start=(id:string,name:unknown,at:string,input?:unknown)=>{const tool=label(name);active.set(id,{name:tool,at});progress.lastTool=tool;
  const signature=input===undefined?"":createHash("sha256").update(`${tool}:${JSON.stringify(input)}`).digest("hex");
  progress.repeatedToolCalls=signature&&signature===lastSignature?progress.repeatedToolCalls+1:1;lastSignature=signature;
 };
 const end=(id:string)=>{const tool=active.get(id);if(tool)progress.lastTool=tool.name;active.delete(id);};
 const event=(value:Record<string,unknown>,at:string)=>{
  progress.events++;progress.lastEventAt=at;
  usage.add(value);progress.usageTokens=usage.result()?.totalTokens??null;
  const type=value.type;
  if(type!=="system"&&type!=="rate_limit_event"&&type!=="autocompact_state"&&type!=="active_goal")progress.lastProgressAt=at;
  if(provider==="codex"){
   const item=value.item as Record<string,unknown>|undefined;
   if(type==="item.started"&&item)start(String(item.id??progress.events),item.type,at,item.command);
   if(type==="item.completed"&&item)end(String(item.id??progress.events));
  }else if(provider==="cursor"){
   if(type==="tool_call"){
    const call=value.tool_call as Record<string,unknown>|undefined;
    const name=call?Object.keys(call)[0]:undefined,id=String(value.call_id??progress.events);
    if(value.subtype==="started")start(id,name,at,(call?.[name??""] as Record<string,unknown>|undefined)?.args);
    if(value.subtype==="completed")end(id);
   }
  }else if(provider==="claude"){
   const message=value.message as Record<string,unknown>|undefined;
   const content=Array.isArray(message?.content)?message.content:[];
   for(const part of content){if(!part||typeof part!=="object")continue;const block=part as Record<string,unknown>;
    if(block.type==="tool_use")start(String(block.id??progress.events),block.name,at,block.input);
    if(block.type==="tool_result"){
     end(String(block.tool_use_id??""));
     if(block.is_error&&typeof block.content==="string"&&/required schema|structured output/i.test(block.content)){progress.validationAttempts++;progress.lastValidationError=sanitizeFailureEvidence(block.content,300);}
    }
   }
  }
  const latest=[...active.values()].at(-1);progress.tool=latest?.name??null;progress.toolStartedAt=latest?.at??null;
 };
 const line=(bytes:Buffer,at:string)=>{if(oversized||pending.length+bytes.length>maxLine){pending=Buffer.alloc(0);oversized=false;return;}
  const combined=pending.length?Buffer.concat([pending,bytes]):bytes;pending=Buffer.alloc(0);
  try{const value=JSON.parse(combined.toString("utf8"));if(value&&typeof value==="object"&&!Array.isArray(value))event(value,at);}catch{}
 };
 return {poll():ExecutionProgress{
  let fd:number;try{fd=fs.openSync(file,"r");}catch{return {...progress};}
  try{const stat=fs.fstatSync(fd);if(stat.size<offset){offset=0;pending=Buffer.alloc(0);oversized=false;active.clear();lastSignature="";usage=tokenUsageReducer(provider??undefined);Object.assign(progress,{events:0,lastEventAt:null,lastProgressAt:null,tool:null,toolStartedAt:null,lastTool:null,repeatedToolCalls:0,usageTokens:null,validationAttempts:0,lastValidationError:null});}
   const at=stat.mtime.toISOString(),chunk=Buffer.alloc(65536);
   while(offset<stat.size){const count=fs.readSync(fd,chunk,0,Math.min(chunk.length,stat.size-offset),offset);if(!count)break;offset+=count;let from=0;
    for(let i=0;i<count;i++)if(chunk[i]===10){line(chunk.subarray(from,i),at);from=i+1;}
    if(from<count&&!oversized){const rest=Buffer.from(chunk.subarray(from,count));if(pending.length+rest.length>maxLine){pending=Buffer.alloc(0);oversized=true;}else pending=Buffer.concat([pending,rest]);}
    if(from<count&&oversized)pending=Buffer.alloc(0);
    if(from===count)oversized=false;
   }
  }finally{fs.closeSync(fd);}
  return {...progress};
 }};
}

export function progressKey(runId:string){return `execution-progress:${runId}`;}
export function progressWarning(progress:ExecutionProgress|undefined,startedAt:string,now=Date.now()){
 const last=Date.parse(progress?.lastProgressAt??startedAt),idle=now-last;
 if(progress?.repeatedToolCalls&&progress.repeatedToolCalls>=4)return{reason:"repeated-action" as const,idleMs:idle,tool:progress.tool??null,repeated:progress.repeatedToolCalls};
 return Number.isFinite(idle)&&idle>=5*60_000?{reason:"inactivity" as const,idleMs:idle,tool:progress?.tool??null,repeated:0}:null;
}

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tokenUsageReducer } from "../src/token-usage.js";
import { eachJsonLine, jsonLines } from "../src/provider-stream.js";
import type { AgentProvider } from "../src/types.js";

const usageOf=(provider:AgentProvider,stdout:string)=>{const reducer=tokenUsageReducer(provider);for(const event of jsonLines(stdout))reducer.add(event);return reducer.result();};
const usageOfFixture=(provider:AgentProvider,name:string)=>{const reducer=tokenUsageReducer(provider);eachJsonLine(path.join("test","fixtures","providers",name),event=>reducer.add(event));return reducer.result();};

test("real Codex and Claude streams yield the usage they report, cached input counted once",()=>{
 // codex exec --json against a local model server: turn.completed reports cached input inside input_tokens.
 assert.deepEqual(usageOfFixture("codex","codex-complete.jsonl"),{inputTokens:180,outputTokens:60,cachedTokens:120,cacheReadTokens:120,cacheWriteTokens:0,totalTokens:360});
 // claude -p stream-json: the result envelope states the run's usage with the cache apart from input.
 assert.deepEqual(usageOfFixture("claude","claude-stream.jsonl"),{inputTokens:4,outputTokens:307,cachedTokens:22382,cacheReadTokens:11057,cacheWriteTokens:11325,totalTokens:22693});
 // An interrupted Codex run never reached turn.completed: unknown, not zero.
 assert.equal(usageOfFixture("codex","codex-interrupted.jsonl"),null);
 // An interrupted Claude run keeps what its assistant events reported, the repeated response counted
 // once, and says it is partial.
 assert.deepEqual(usageOfFixture("claude","claude-interrupted.jsonl"),{inputTokens:2,outputTokens:8,cachedTokens:10083,cacheReadTokens:8865,cacheWriteTokens:1218,totalTokens:10093,partial:true});
});

test("a Claude run cut before its result counts each API response once and leaves subagents out",()=>{
 const step={input_tokens:5,cache_read_input_tokens:1000,cache_creation_input_tokens:200,output_tokens:1};
 const stdout=[{type:"system",subtype:"init"},{type:"assistant",message:{id:"m1",usage:step}},{type:"assistant",message:{id:"m1",usage:step}},
  {type:"assistant",message:{id:"m2",usage:{...step,cache_read_input_tokens:1200}}},{type:"assistant",parent_tool_use_id:"t1",message:{id:"s1",usage:step}}].map(value=>JSON.stringify(value)).join("\n");
 assert.deepEqual(usageOf("claude",stdout),{inputTokens:10,outputTokens:2,cachedTokens:2600,cacheReadTokens:2200,cacheWriteTokens:400,totalTokens:2612,partial:true});
 assert.equal(usageOf("claude",JSON.stringify({type:"system",subtype:"init"})),null,"no reported response is unknown, not zero");
});

test("a Codex run with several turns is the sum of its turns",()=>{
 const turn=(input:number,cached:number,output:number)=>JSON.stringify({type:"turn.completed",usage:{input_tokens:input,cached_input_tokens:cached,cache_write_input_tokens:0,output_tokens:output,reasoning_output_tokens:0}});
 assert.deepEqual(usageOf("codex",[turn(100,40,10),turn(200,150,20)].join("\n")),{inputTokens:110,outputTokens:30,cachedTokens:190,cacheReadTokens:190,cacheWriteTokens:0,totalTokens:330});
});

test("extracts reported Claude token usage without estimating missing fields", () => {
 assert.deepEqual(usageOf("claude",JSON.stringify({usage:{input_tokens:100,output_tokens:25,cache_creation_input_tokens:10,cache_read_input_tokens:15}})),
  {inputTokens:100,outputTokens:25,cachedTokens:25,cacheReadTokens:15,cacheWriteTokens:10,totalTokens:150});
 assert.equal(usageOf("codex","no usage"),null);
});

test("Cursor reports no token usage today and is read generically if its envelope ever carries one", () => {
 assert.equal(usageOf("cursor",JSON.stringify({type:"result",subtype:"success",is_error:false,duration_ms:12,result:"{}"})),null);
 assert.deepEqual(usageOf("cursor",JSON.stringify({type:"result",result:"{}",usage:{input_tokens:7,output_tokens:3}})),{inputTokens:7,outputTokens:3,cachedTokens:null,cacheReadTokens:null,cacheWriteTokens:null,totalTokens:10});
});

test("a cache hit and a cache write are recorded apart so an improvement is distinguishable", () => {
 const hit=usageOf("claude",JSON.stringify({usage:{input_tokens:5,output_tokens:2,cache_read_input_tokens:9000,cache_creation_input_tokens:0}}));
 const miss=usageOf("claude",JSON.stringify({usage:{input_tokens:5,output_tokens:2,cache_creation_input_tokens:9000,cache_read_input_tokens:0}}));
 assert.equal(hit!.cachedTokens,miss!.cachedTokens,"the historical column cannot tell them apart");
 assert.deepEqual([hit!.cacheReadTokens,hit!.cacheWriteTokens],[9000,0]);
 assert.deepEqual([miss!.cacheReadTokens,miss!.cacheWriteTokens],[0,9000]);
});

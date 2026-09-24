import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { providerActivityReducer } from "../src/provider-activity.js";
import { eachJsonLine, jsonLines } from "../src/provider-stream.js";

const extractProviderActivity=(stdout:string)=>{const reducer=providerActivityReducer();for(const event of jsonLines(stdout))reducer.add(event);return reducer.result();};
const fixtureActivity=(name:string)=>{const reducer=providerActivityReducer();eachJsonLine(path.join("test","fixtures","providers",name),event=>reducer.add(event));return reducer.result()!;};

test("real Codex and Claude streams are counted per event, with what the provider states about the run",()=>{
 const codex=fixtureActivity("codex-complete.jsonl");
 assert.equal(codex.events,9);
 assert.deepEqual(codex.eventTypes,{"thread.started":1,"item.completed":4,"turn.started":1,"item.started":2,"turn.completed":1});
 assert.equal(codex.turns,null,"Codex does not state a turn count");
 const claude=fixtureActivity("claude-stream.jsonl");
 assert.equal(claude.events,17);
 assert.equal(claude.turns,4);
 assert.equal(claude.eventTypes.assistant,5);
 // An interrupted Claude run never wrote its result envelope, so it states no turns.
 const interrupted=fixtureActivity("claude-interrupted.jsonl");
 assert.equal(interrupted.turns,null);
});

test("a streaming provider is counted per event and grouped by whatever type it reports",()=>{
 const stdout=[{type:"item.completed",item:{type:"command_execution"}},{type:"item.completed",item:{type:"command_execution"}},
  {type:"item.completed",item:{type:"file_change"}},{msg:{type:"agent_message"}},{unlabelled:true}]
  .map(value=>JSON.stringify(value)).join("\n");
 const activity=extractProviderActivity(stdout)!;
 assert.equal(activity.events,5);
 // The outer type wins when present, so a provider renaming an inner field cannot silently drop a count.
 assert.deepEqual(activity.eventTypes,{"item.completed":3,agent_message:1,untyped:1});
 assert.equal(activity.turns,null);
});

test("a single result envelope contributes the turns and durations it states, and no dollar estimate",()=>{
 // Field names taken from a real Claude Code result envelope, not from documentation.
 const activity=extractProviderActivity(JSON.stringify({type:"result",subtype:"success",is_error:false,num_turns:37,duration_api_ms:41234,duration_ms:52000,total_cost_usd:0.734,result:"{}"}))!;
 assert.equal(activity.events,1);
 assert.equal(activity.turns,37);
 assert.equal(activity.apiDurationMs,41234);
 assert.equal(activity.durationMs,52000);
 assert.equal("costUsd" in activity,false,"consumption is measured in the tokens the provider reports, not in its dollar estimate");
 assert.deepEqual(activity.eventTypes,{result:1});
});

test("a provider that reports no duration leaves it unknown instead of zero",()=>{
 const activity=extractProviderActivity(JSON.stringify({type:"progress"}))!;
 assert.equal(activity.durationMs,null);
 // A duration really reported as zero is kept, because zero is a measurement and null is not.
 assert.equal(extractProviderActivity(JSON.stringify({type:"result",duration_ms:0}))!.durationMs,0);
});

test("output that carries no JSON object records no activity rather than a fabricated zero",()=>{
 assert.equal(extractProviderActivity(""),null);
 assert.equal(extractProviderActivity("plain text\nnot json"),null);
 assert.equal(extractProviderActivity("[1,2,3]"),null);
});

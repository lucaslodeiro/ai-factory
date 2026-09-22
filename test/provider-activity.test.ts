import test from "node:test";
import assert from "node:assert/strict";
import { extractProviderActivity } from "../src/provider-activity.js";

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

test("a single result envelope contributes the turns, durations and cost it states",()=>{
 // Field names taken from a real Claude Code result envelope, not from documentation.
 const activity=extractProviderActivity(JSON.stringify({type:"result",subtype:"success",is_error:false,num_turns:37,duration_api_ms:41234,duration_ms:52000,total_cost_usd:0.734,result:"{}"}))!;
 assert.equal(activity.events,1);
 assert.equal(activity.turns,37);
 assert.equal(activity.apiDurationMs,41234);
 assert.equal(activity.durationMs,52000);
 assert.equal(activity.costUsd,0.734);
 assert.deepEqual(activity.eventTypes,{result:1});
});

test("a provider that reports no cost leaves it unknown instead of zero",()=>{
 const activity=extractProviderActivity(JSON.stringify({type:"progress"}))!;
 assert.equal(activity.costUsd,null);
 assert.equal(activity.durationMs,null);
 // A free run really reported as zero is kept, because zero is a measurement and null is not.
 assert.equal(extractProviderActivity(JSON.stringify({type:"result",total_cost_usd:0}))!.costUsd,0);
});

test("output that carries no JSON object records no activity rather than a fabricated zero",()=>{
 assert.equal(extractProviderActivity(""),null);
 assert.equal(extractProviderActivity("plain text\nnot json"),null);
 assert.equal(extractProviderActivity("[1,2,3]"),null);
});

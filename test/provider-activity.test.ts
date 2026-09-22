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

test("a single result envelope contributes the turn count and API duration it states",()=>{
 const activity=extractProviderActivity(JSON.stringify({type:"result",subtype:"success",is_error:false,num_turns:37,duration_api_ms:41234,result:"{}"}))!;
 assert.equal(activity.events,1);
 assert.equal(activity.turns,37);
 assert.equal(activity.apiDurationMs,41234);
 assert.deepEqual(activity.eventTypes,{result:1});
});

test("output that carries no JSON object records no activity rather than a fabricated zero",()=>{
 assert.equal(extractProviderActivity(""),null);
 assert.equal(extractProviderActivity("plain text\nnot json"),null);
 assert.equal(extractProviderActivity("[1,2,3]"),null);
});

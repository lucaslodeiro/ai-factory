import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { Store } from "../src/storage.js";
import { WorkflowGitHubPublisher,payloadOf,withPayload } from "../src/workflow-github.js";
import { WorkflowProjections } from "../src/workflow-projection.js";
import { WorkflowRecords } from "../src/workflow-records.js";
import { workflowLabels,workflowStatusMarkdown } from "../src/workflow-status.js";
import { WorkflowFailures } from "../src/workflow-failures.js";
import { result } from "./fixtures.js";
import { WorkflowInbox } from "../src/workflow-inbox.js";
import {issueStateIndex} from "../src/workflow-state.js";

const stagesForTest={DESIGN:"Design",BUILD:"Build",TEST:"Test",REVIEW:"Review",DELIVERY:"Delivery"} as const;
const statusesForTest={QUEUED:"Queued",RUNNING:"Running",WAITING:"Waiting for you",FAILED:"Failed",PAUSED:"Paused",CANCELLED:"Cancelled",COMPLETED:"Completed"} as const;
const nextAction=(body:string)=>body.match(/^## Next action\n\n([\s\S]*?)(?=\n\n<details><summary>All commands<\/summary>)/m)?.[0]??"";
const stableState=(value:any)=>{const copy=structuredClone(value);delete copy.publishedAt;return copy;};

function setup() {
 const store=new Store(":memory:");
 store.setMetadata("repository_identity",{id:1,nodeId:"R_1",fullName:"owner/demo"});
 store.db.prepare("INSERT INTO work_items(id,issue_number,issue_id,repo,branch,created_at,updated_at,context) VALUES('work-1',7,700,'owner/demo','factory/issue-7','now','now',?)").run(JSON.stringify({title:"Readable workflow",issueNodeId:"I_700"}));
 store.db.prepare("INSERT INTO specs(work_item_id,version,body) VALUES('work-1',2,'SPEC')").run();
 return {store,records:new WorkflowRecords(store),projections:new WorkflowProjections(store)};
}

test("hidden workflow payloads round trip text that could close an HTML comment",()=>{
 const value={summary:"keep --> literal"},body=withPayload("Readable",value);assert.match(body,/keep -\\u002d> literal/);assert.deepEqual(payloadOf(body),value);
});

test("status projection has one current CTA and derives it from the active request",async()=>{
 const s=setup();
 try {
  s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:10},sourceType:"agent-result",sourceId:"run",actor:"product-architect"});
  s.records.create({workItemId:"work-1",specVersion:2,scope:"issue",payload:{kind:"instruction",text:"Keep it lightweight"},sourceType:"github-comment",sourceId:"9",actor:"owner"});
  s.projections.initialize("work-1","DESIGN","WAITING");
  const body=workflowStatusMarkdown(s.store,"work-1");
  assert.equal(body.match(/^## Next action$/gm)?.length,1);
  assert.match(body,/Current actor \| Human/);
  assert.match(body,/\/factory approve v2/);
  assert.match(body,/Active human guidance[\s\S]*Keep it lightweight/);
  assert.deepEqual(workflowLabels(s.store,"work-1").map(label=>label.name),["factory:design","factory:waiting"]);
 } finally {s.store.db.close();}
});

test("Architect-owned requests never render a human command",async()=>{
 const s=setup();
 try {
  s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"request",type:"tactical-decision",owner:"architect",originatingStage:"TEST",allowedReturnStages:["BUILD","TEST"],openedAfterCommentId:20},sourceType:"agent-result",sourceId:"run",actor:"qa"});
  s.projections.initialize("work-1","DESIGN","QUEUED");
  const body=workflowStatusMarkdown(s.store,"work-1");
  const action=body.split("<details><summary>All commands</summary>")[0];assert.match(action,/Architect is next/);assert.doesNotMatch(action,/\/factory answer|\/factory retry/);
 } finally {s.store.db.close();}
});

test("failed status explains the cause, identifies the execution and keeps one safe CTA",async()=>{
 const s=setup();
 try {
  s.store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at,finished_at,exit_code) VALUES('run-1','work-1','qa','TEST','failed','now','now',2)").run();
  new WorkflowFailures(s.store).open({workItemId:"work-1",executionId:"run-1",class:"execution",message:`Bearer ghp_fake failed at ${os.homedir()}/private/project`,stage:"TEST",attempt:3});
  s.projections.initialize("work-1","TEST","FAILED");
  const body=workflowStatusMarkdown(s.store,"work-1");
  assert.match(body,/### Failure details/);
  assert.match(body,/Failure class:\*\* execution/);
  assert.match(body,/Execution:\*\* `run-1`/);
  assert.match(body,/Agent subprocess failed|workflow rejected/i);
  assert.doesNotMatch(body,/ghp_fake/);
  assert.match(body,/~\/private\/project/);
  assert.equal(body.match(/^## Next action$/gm)?.length,1);
  assert.match(body,/\/factory retry/);
 } finally {s.store.db.close();}
});

test("every public workflow status has readable state, labels and one authoritative CTA",async()=>{
 const cases=[
  {stage:"DESIGN",status:"QUEUED",actor:"Architect",labels:["factory:design"],action:/next agent is queued/i},
  {stage:"DESIGN",status:"RUNNING",actor:"Architect",labels:["factory:design"],action:/current agent is running/i},
  {stage:"BUILD",status:"PAUSED",actor:"Human",labels:["factory:build","factory:paused"],action:/\/factory retry/},
  {stage:"TEST",status:"CANCELLED",actor:"Human",labels:["factory:test","factory:cancelled"],action:/\/factory retry/},
  {stage:"DELIVERY",status:"COMPLETED",actor:"None",labels:["factory:done"],action:/Delivery is complete/},
 ] as const;
 for(const entry of cases){
  const s=setup();
  try {
   s.projections.initialize("work-1",entry.stage,entry.status==="RUNNING"?"QUEUED":entry.status);
   if(entry.status==="RUNNING")s.projections.transition({workItemId:"work-1",expectedRevision:0,stage:entry.stage,status:"RUNNING",activeRunId:"run-public",actor:{type:"orchestrator",id:"test"},source:{executionId:"run-public"},reason:{code:"start",summary:"Agent started"}});
   const body=workflowStatusMarkdown(s.store,"work-1");
   assert.match(body,new RegExp(`Stage \\| ${stagesForTest[entry.stage]}`));
   assert.match(body,new RegExp(`Status \\| ${statusesForTest[entry.status]}`));
   assert.match(body,new RegExp(`Current actor \\| ${entry.actor}`));
   assert.match(body,entry.action);
   assert.equal(body.match(/^## Next action$/gm)?.length,1);
   assert.deepEqual(workflowLabels(s.store,"work-1").map(label=>label.name),entry.labels);
  } finally {s.store.db.close();}
 }
});

test("publisher writes only changed presentation revisions and retries after delivery failure",async()=>{
 const s=setup();
 try {
  s.projections.initialize("work-1","BUILD","QUEUED");
  const calls:Array<{issue:number;labels:string[];body:string}>=[];
  const publisher=new WorkflowGitHubPublisher(s.store,{syncWorkflow(issue,labels,body){calls.push({issue,labels:labels.map(label=>label.name),body});},publishWorkflowComment(){},assignees(){return[];},assign(){},unassign(){}});
  assert.equal(await publisher.publishChanged(),1);assert.equal(await publisher.publishChanged(),0);assert.equal(calls.length,1);
  assert.deepEqual(stableState(payloadOf(calls[0].body)),stableState(issueStateIndex(s.store,"work-1")));assert.equal("cwd" in ((payloadOf(calls[0].body) as any).context),false);
  assert.match(calls[0].body,/workflow-rev:0 · presentation-rev:0/);
  assert.match(calls[0].body,/Instance \|/);assert.match(calls[0].body,/<sub>instance:/);
  s.projections.present({workItemId:"work-1",expectedRevision:0,actor:{type:"orchestrator",id:"observer"},source:{},reason:{code:"evidence",summary:"Evidence changed"}});
  assert.equal(await publisher.publishChanged(),1);assert.equal(calls.length,2);assert.match(calls[1].body,/presentation-rev:1/);assert.deepEqual(stableState(payloadOf(calls[1].body)),stableState(issueStateIndex(s.store,"work-1")));

  s.projections.transition({workItemId:"work-1",expectedRevision:0,stage:"BUILD",status:"RUNNING",activeRunId:"run",actor:{type:"orchestrator",id:"scheduler"},source:{executionId:"run"},reason:{code:"start",summary:"Builder started"}});
  const failing=new WorkflowGitHubPublisher(s.store,{syncWorkflow(){throw new Error("GitHub unavailable");},publishWorkflowComment(){throw new Error("GitHub unavailable");},assignees(){return[];},assign(){},unassign(){}});
  await assert.rejects(async()=>await failing.publishChanged(),/GitHub unavailable/);
  assert.equal(s.projections.get("work-1").publishedPresentationRevision,1);
  assert.equal(await publisher.publishChanged(),1);assert.match(calls.at(-1)!.body,/event:[0-9a-f-]{36}/);
 } finally {s.store.db.close();}
});

test("an oversized state index is omitted and reported once",async()=>{
 const s=setup();try{s.projections.initialize("work-1","BUILD","QUEUED");s.records.create({workItemId:"work-1",specVersion:2,scope:"issue",payload:{kind:"instruction",text:"x".repeat(61_000)},sourceType:"github-comment",sourceId:"1",actor:"owner"});let body="";const publisher=new WorkflowGitHubPublisher(s.store,{syncWorkflow(_issue,_labels,value){body=value;},publishWorkflowComment(){return 1;}});await publisher.publishChanged();assert.equal(payloadOf(body),null);assert.equal((s.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='github.state_too_large'").get() as {n:number}).n,1);}finally{s.store.db.close();}
});

test("publisher keeps intermediate delivery results in status and publishes only milestone comments",async()=>{
 const s=setup();
 try {
  s.projections.initialize("work-1","DESIGN","QUEUED");
  s.store.event("agent.result",{role:"developer",result:result("pass",{summary:"Builder completed implementation"}),specVersion:2},"work-1","run-builder");
  s.store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment) VALUES(?,?,?,?,?)").run("work-1",3,"Stored specification",JSON.stringify([{id:"AC-1",description:"Works"}]),JSON.stringify({complexity:"medium",risk:"low",rationale:"Bounded"}));
  s.store.event("agent.result",{role:"product-architect",result:result("spec",{summary:"Specification is ready"}),specVersion:3},"work-1","run-architect");
  const comments:Array<{key:string;body:string}>=[];
  const publisher=new WorkflowGitHubPublisher(s.store,{syncWorkflow(){},publishWorkflowComment(_issue,key,body){comments.push({key,body});},assignees(){return[];},assign(){},unassign(){}});
  assert.equal(await publisher.publishResults(),1);
  assert.deepEqual(comments.map(comment=>comment.key),["result-run-architect"]);
  assert.equal(await publisher.publishResults(),0);
  assert.deepEqual(payloadOf(comments[0].body),{kind:"spec",version:3,body:"Stored specification",criteria:[{id:"AC-1",description:"Works"}],assessment:{complexity:"medium",risk:"low",rationale:"Bounded"}});
  assert.match(workflowStatusMarkdown(s.store,"work-1"),/Latest delivery summary[\s\S]*Builder completed implementation/);
 } finally {s.store.db.close();}
});

test("status clips a verbose delivery summary and preserves one authoritative next action",async()=>{
 const s=setup();
 try {
  s.projections.initialize("work-1","BUILD","QUEUED");
  s.store.event("agent.result",{role:"developer",result:result("pass",{summary:"x".repeat(10_000)}),specVersion:2},"work-1","run-verbose");
  const body=workflowStatusMarkdown(s.store,"work-1"),section=body.match(/### Latest delivery summary([\s\S]*?)(?:\n\n<details>|\n\n## Next action)/)?.[0]??"";
  assert.ok(section.length<=1600,`summary section was ${section.length} characters`);
  assert.match(section,/…/);assert.match(section,/execution `run-verbose` in the dashboard/);
  assert.equal(body.match(/^## Next action$/gm)?.length,1);
 } finally {s.store.db.close();}
});

test("help publishes one immutable reference and status keeps the same collapsed list",async()=>{
 const s=setup(),comments=[{id:11,body:"/factory help",user:{login:"owner",type:"User"},updatedAt:"2026-09-20T00:00:11Z"}];
 try {
  s.projections.initialize("work-1","BUILD","QUEUED");
  const inbox=new WorkflowInbox(s.store,{comments:()=>comments},["owner"]);assert.equal(inbox.poll("work-1").applied,1);
  const published:Array<{key:string;body:string}>=[];
  const publisher=new WorkflowGitHubPublisher(s.store,{syncWorkflow(){},publishWorkflowComment(_issue,key,body){published.push({key,body});},assignees(){return[];},assign(){},unassign(){}});
  assert.equal(await publisher.publishHelp(),1);assert.equal(published[0].key,"help");assert.match(published[0].body,/\/factory replace/);
  comments.push({id:12,body:"/factory help",user:{login:"owner",type:"User"},updatedAt:"2026-09-20T00:00:12Z"});assert.equal(inbox.poll("work-1").applied,1);
  assert.equal(await publisher.publishHelp(),0);assert.equal(published.length,1);
  const status=workflowStatusMarkdown(s.store,"work-1");assert.match(status,/<details><summary>All commands<\/summary>/);assert.match(status,/\/factory cancel/);assert.equal(status.match(/^## Next action$/gm)?.length,1);
 } finally {s.store.db.close();}
});

test("every workflow CTA shows the exact valid commands and text semantics",async()=>{
 const requestCase=(type:"spec-approval"|"clarification"|"correction-limit"|"merge")=>{const s=setup();s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"request",type,owner:"human",originatingStage:type==="merge"?"DELIVERY":"DESIGN",allowedReturnStages:type==="merge"?["DELIVERY"]:["DESIGN","BUILD"],openedAfterCommentId:10},sourceType:"orchestrator",sourceId:type,actor:"orchestrator"});s.projections.initialize("work-1",type==="merge"?"DELIVERY":"DESIGN","WAITING");return s;};
 for(const [type,patterns] of [
  ["spec-approval",[/\/factory approve v2 \[guidance\]/,/\/factory answer <feedback>/,/spec-scoped instruction/,/human decision/]],
  ["clarification",[/\/factory answer <guidance>/,/human decision/]],
  ["correction-limit",[/\/factory answer <guidance>/,/human decision/]],
  ["merge",[/Merge.*GitHub/s,/\/factory answer <changes>/,/auto-fix finding for Builder/]],
 ] as const){const s=requestCase(type);try{const action=nextAction(workflowStatusMarkdown(s.store,"work-1"));for(const pattern of patterns)assert.match(action,pattern);assert.equal(action.match(/^## Next action$/gm)?.length,1);}finally{s.store.db.close();}}
 for(const status of ["FAILED","PAUSED","CANCELLED"] as const){const s=setup();try{if(status==="FAILED")new WorkflowFailures(s.store).open({workItemId:"work-1",class:"execution",message:"failed",stage:"TEST",attempt:0});s.projections.initialize("work-1",status==="FAILED"?"TEST":"BUILD",status);const action=nextAction(workflowStatusMarkdown(s.store,"work-1"));assert.match(action,/\/factory retry \[--issue\] \[--for <roles>\] \[guidance\]/);assert.match(action,/current SPEC/);assert.equal(action.match(/^## Next action$/gm)?.length,1);}finally{s.store.db.close();}}
 for(const status of ["QUEUED","RUNNING"] as const){const s=setup();try{s.projections.initialize("work-1","BUILD","QUEUED");if(status==="RUNNING")s.projections.transition({workItemId:"work-1",expectedRevision:0,stage:"BUILD",status:"RUNNING",activeRunId:"run",actor:{type:"orchestrator",id:"scheduler"},source:{executionId:"run"},reason:{code:"start",summary:"Started"}});const action=nextAction(workflowStatusMarkdown(s.store,"work-1"));assert.match(action,/No human action is required/);assert.match(action,/\/factory pause \[reason\]/);assert.match(action,/\/factory cancel \[reason\]/);assert.equal(action.match(/^## Next action$/gm)?.length,1);}finally{s.store.db.close();}}
});

test("correction limit CTA names the findings that need human guidance",async()=>{
 const s=setup();try{const finding=s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"finding",classification:"auto-fix",originRole:"qa",evidence:"The standings table still sorts oldest first"},sourceType:"agent-result",sourceId:"run-q",actor:"qa"});s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"request",type:"correction-limit",owner:"human",originatingStage:"TEST",allowedReturnStages:["BUILD","TEST"],openedAfterCommentId:10,findingIds:[finding.id]},sourceType:"orchestrator",sourceId:"limit",actor:"orchestrator"});s.projections.initialize("work-1","TEST","WAITING");const action=nextAction(workflowStatusMarkdown(s.store,"work-1"));assert.match(action,/Open findings[\s\S]*standings table still sorts oldest first/);assert.match(action,/Tell Architect how to resolve/);assert.equal(action.match(/^## Next action$/gm)?.length,1);}finally{s.store.db.close();}
});

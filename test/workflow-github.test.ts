import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { Store } from "../src/storage.js";
import { WorkflowGitHubPublisher } from "../src/workflow-github.js";
import { WorkflowProjections } from "../src/workflow-projection.js";
import { WorkflowRecords } from "../src/workflow-records.js";
import { workflowLabels,workflowStatusMarkdown } from "../src/workflow-status.js";
import { WorkflowFailures } from "../src/workflow-failures.js";
import { result } from "./fixtures.js";

const stagesForTest={DESIGN:"Design",BUILD:"Build",TEST:"Test",REVIEW:"Review",DELIVERY:"Delivery"} as const;
const statusesForTest={QUEUED:"Queued",RUNNING:"Running",WAITING:"Waiting for you",FAILED:"Failed",PAUSED:"Paused",CANCELLED:"Cancelled",COMPLETED:"Completed"} as const;

function setup() {
 const store=new Store(":memory:");
 store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context) VALUES('work-1',7,'owner/demo','now','now',?)").run(JSON.stringify({title:"Readable workflow"}));
 store.db.prepare("INSERT INTO specs(work_item_id,version,body) VALUES('work-1',2,'SPEC')").run();
 return {store,records:new WorkflowRecords(store),projections:new WorkflowProjections(store)};
}

test("status projection has one current CTA and derives it from the active request",()=>{
 const s=setup();
 try {
  s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:10},sourceType:"agent-result",sourceId:"run",actor:"product-architect"});
  s.records.create({workItemId:"work-1",specVersion:2,scope:"issue",payload:{kind:"instruction",text:"Keep it lightweight"},sourceType:"github-comment",sourceId:"9",actor:"owner"});
  s.projections.initialize("work-1","DESIGN","WAITING");
  const body=workflowStatusMarkdown(s.store,"work-1");
  assert.equal(body.match(/^## Next action$/gm)?.length,1);
  assert.match(body,/Current actor \| Human/);
  assert.match(body,/\/factory approve v2/);
  assert.match(body,/Active human instructions[\s\S]*Keep it lightweight/);
  assert.deepEqual(workflowLabels(s.store,"work-1").map(label=>label.name),["factory:design","factory:waiting"]);
 } finally {s.store.db.close();}
});

test("Architect-owned requests never render a human command",()=>{
 const s=setup();
 try {
  s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"request",type:"tactical-decision",owner:"architect",originatingStage:"TEST",allowedReturnStages:["BUILD","TEST"],openedAfterCommentId:20},sourceType:"agent-result",sourceId:"run",actor:"qa"});
  s.projections.initialize("work-1","DESIGN","QUEUED");
  const body=workflowStatusMarkdown(s.store,"work-1");
  assert.match(body,/Architect is next/);assert.doesNotMatch(body,/\/factory answer|\/factory retry/);
 } finally {s.store.db.close();}
});

test("failed status explains the cause, identifies the execution and keeps one safe CTA",()=>{
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

test("every public workflow status has readable state, labels and one authoritative CTA",()=>{
 const cases=[
  {stage:"DESIGN",status:"QUEUED",actor:"Architect",labels:["factory:design"],action:/next agent is queued/i},
  {stage:"DESIGN",status:"RUNNING",actor:"Architect",labels:["factory:design"],action:/current agent is running/i},
  {stage:"BUILD",status:"PAUSED",actor:"None",labels:["factory:build","factory:paused"],action:/\/factory retry/},
  {stage:"TEST",status:"CANCELLED",actor:"None",labels:["factory:test","factory:cancelled"],action:/\/factory retry/},
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

test("publisher writes only changed presentation revisions and retries after delivery failure",()=>{
 const s=setup();
 try {
  s.projections.initialize("work-1","BUILD","QUEUED");
  const calls:Array<{issue:number;labels:string[];body:string}>=[];
  const publisher=new WorkflowGitHubPublisher(s.store,{syncWorkflow(issue,labels,body){calls.push({issue,labels:labels.map(label=>label.name),body});},publishWorkflowComment(){}});
  assert.equal(publisher.publishChanged(),1);assert.equal(publisher.publishChanged(),0);assert.equal(calls.length,1);
  assert.match(calls[0].body,/workflow-rev:0 · presentation-rev:0/);
  s.projections.present({workItemId:"work-1",expectedRevision:0,actor:{type:"orchestrator",id:"observer"},source:{},reason:{code:"evidence",summary:"Evidence changed"}});
  assert.equal(publisher.publishChanged(),1);assert.equal(calls.length,2);assert.match(calls[1].body,/presentation-rev:1/);

  s.projections.transition({workItemId:"work-1",expectedRevision:0,stage:"BUILD",status:"RUNNING",activeRunId:"run",actor:{type:"orchestrator",id:"scheduler"},source:{executionId:"run"},reason:{code:"start",summary:"Builder started"}});
  const failing=new WorkflowGitHubPublisher(s.store,{syncWorkflow(){throw new Error("GitHub unavailable");},publishWorkflowComment(){throw new Error("GitHub unavailable");}});
  assert.throws(()=>failing.publishChanged(),/GitHub unavailable/);
  assert.equal(s.projections.get("work-1").publishedPresentationRevision,1);
  assert.equal(publisher.publishChanged(),1);assert.match(calls.at(-1)!.body,/event:[0-9a-f-]{36}/);
 } finally {s.store.db.close();}
});

test("publisher keeps intermediate delivery results in status and publishes only milestone comments",()=>{
 const s=setup();
 try {
  s.projections.initialize("work-1","DESIGN","QUEUED");
  s.store.event("agent.result",{role:"developer",result:result("pass",{summary:"Builder completed implementation"}),specVersion:2},"work-1","run-builder");
  s.store.event("agent.result",{role:"product-architect",result:result("spec",{summary:"Specification is ready"}),specVersion:3},"work-1","run-architect");
  const comments:Array<{key:string;body:string}>=[];
  const publisher=new WorkflowGitHubPublisher(s.store,{syncWorkflow(){},publishWorkflowComment(_issue,key,body){comments.push({key,body});}});
  assert.equal(publisher.publishResults(),1);
  assert.deepEqual(comments.map(comment=>comment.key),["result-run-architect"]);
  assert.equal(publisher.publishResults(),0);
  assert.match(workflowStatusMarkdown(s.store,"work-1"),/Latest delivery summary[\s\S]*Builder completed implementation/);
 } finally {s.store.db.close();}
});

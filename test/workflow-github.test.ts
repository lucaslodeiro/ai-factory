import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { WorkflowGitHubPublisher } from "../src/workflow-github.js";
import { WorkflowProjections } from "../src/workflow-projection.js";
import { WorkflowRecords } from "../src/workflow-records.js";
import { workflowLabels,workflowStatusMarkdown } from "../src/workflow-status.js";

function setup() {
 const store=new Store(":memory:");
 store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,created_at,updated_at,context) VALUES('work-1',7,'owner/demo','SPEC','now','now',?)").run(JSON.stringify({title:"Readable workflow"}));
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

test("publisher writes only changed presentation revisions and retries after delivery failure",()=>{
 const s=setup();
 try {
  s.projections.initialize("work-1","BUILD","QUEUED");
  const calls:Array<{issue:number;labels:string[];body:string}>=[];
  const publisher=new WorkflowGitHubPublisher(s.store,{syncWorkflow(issue,labels,body){calls.push({issue,labels:labels.map(label=>label.name),body});}});
  assert.equal(publisher.publishChanged(),1);assert.equal(publisher.publishChanged(),0);assert.equal(calls.length,1);
  assert.match(calls[0].body,/workflow-rev:0 · presentation-rev:0/);
  s.projections.present({workItemId:"work-1",expectedRevision:0,actor:{type:"orchestrator",id:"observer"},source:{},reason:{code:"evidence",summary:"Evidence changed"}});
  assert.equal(publisher.publishChanged(),1);assert.equal(calls.length,2);assert.match(calls[1].body,/presentation-rev:1/);

  s.projections.transition({workItemId:"work-1",expectedRevision:0,stage:"BUILD",status:"RUNNING",activeRunId:"run",actor:{type:"orchestrator",id:"scheduler"},source:{executionId:"run"},reason:{code:"start",summary:"Builder started"}});
  const failing=new WorkflowGitHubPublisher(s.store,{syncWorkflow(){throw new Error("GitHub unavailable");}});
  assert.throws(()=>failing.publishChanged(),/GitHub unavailable/);
  assert.equal(s.projections.get("work-1").publishedPresentationRevision,1);
  assert.equal(publisher.publishChanged(),1);assert.match(calls.at(-1)!.body,/event:[0-9a-f-]{36}/);
 } finally {s.store.db.close();}
});

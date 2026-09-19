import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { WorkflowRecords } from "../src/workflow-records.js";
import { WorkflowProjections } from "../src/workflow-projection.js";

function setup() {
 const store=new Store(":memory:");
 store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,created_at,updated_at,context) VALUES('work-1',1,'owner/demo','SPEC','now','now','{}')").run();
 return {store,records:new WorkflowRecords(store),projections:new WorkflowProjections(store)};
}

test("projection derives human request ownership and writes one transition event", () => {
 const {store,records,projections}=setup();
 try {
  const request=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:10},sourceType:"agent-result",sourceId:"run-1",actor:"architect"});
  assert.equal(projections.initialize("work-1","DESIGN","WAITING").activeRequestId,request.id);
  records.resolveRequest(request.id);
  const next=projections.transition({workItemId:"work-1",expectedRevision:0,stage:"BUILD",status:"QUEUED",actor:{type:"human",id:"owner"},source:{commentId:11},reason:{code:"spec-approval",summary:"SPEC v1 approved"},recordIds:[request.id]});
  assert.deepEqual({stage:next.stage,status:next.status,revision:next.revision,presentationRevision:next.presentationRevision,activeRequestId:next.activeRequestId},{stage:"BUILD",status:"QUEUED",revision:1,presentationRevision:1,activeRequestId:undefined});
  const events=store.db.prepare("SELECT payload FROM events WHERE type='workflow.transition'").all() as Array<{payload:string}>;
  assert.equal(events.length,1);const payload=JSON.parse(events[0].payload);assert.equal(payload.reason.code,"spec-approval");assert.equal(payload.from.status,"WAITING");assert.equal(payload.to.status,"QUEUED");
 } finally { store.db.close(); }
});

test("projection rejects invalid derived state and stale revision", () => {
 const {store,records,projections}=setup();
 try {
  records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"request",type:"clarification",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["DESIGN"],openedAfterCommentId:1},sourceType:"agent-result",sourceId:"run",actor:"architect"});
  assert.throws(()=>projections.initialize("work-1","DESIGN","QUEUED"),/WAITING requires/);
  projections.initialize("work-1","DESIGN","WAITING");
  assert.throws(()=>projections.transition({workItemId:"work-1",expectedRevision:2,stage:"DESIGN",status:"WAITING",actor:{type:"orchestrator",id:"test"},source:{},reason:{code:"test",summary:"stale"}}),/revision changed/);
 } finally { store.db.close(); }
});

test("transition rolls back projection and event when a transactional side effect fails", () => {
 const {store,projections}=setup();
 try {
  projections.initialize("work-1","DESIGN","QUEUED");
  assert.throws(()=>projections.transition({workItemId:"work-1",expectedRevision:0,stage:"DESIGN",status:"RUNNING",activeRunId:"run-1",actor:{type:"orchestrator",id:"scheduler"},source:{executionId:"run-1"},reason:{code:"execution-started",summary:"Architect started"}},()=>{throw new Error("outbox failed");}),/outbox failed/);
  assert.deepEqual({status:projections.get("work-1").status,revision:projections.get("work-1").revision},{status:"QUEUED",revision:0});
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='workflow.transition'").get() as {count:number}).count,0);
 } finally { store.db.close(); }
});

test("resume status preserves human gates and queues Architect-owned work", () => {
 const human=setup();
 try {
  human.records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:1},sourceType:"agent-result",sourceId:"run",actor:"architect"});
  assert.equal(human.projections.resumeStatus("work-1"),"WAITING");
 } finally { human.store.db.close(); }
 const architect=setup();
 try {
  architect.records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"request",type:"tactical-decision",owner:"architect",originatingStage:"TEST",allowedReturnStages:["BUILD","TEST"],openedAfterCommentId:1},sourceType:"agent-result",sourceId:"run",actor:"tester"});
  assert.equal(architect.projections.resumeStatus("work-1"),"QUEUED");
 } finally { architect.store.db.close(); }
});

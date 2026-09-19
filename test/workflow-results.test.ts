import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { WorkflowCommands } from "../src/workflow-commands.js";
import { WorkflowProjections } from "../src/workflow-projection.js";
import { WorkflowRecords } from "../src/workflow-records.js";
import { WorkflowResults } from "../src/workflow-results.js";
import { config } from "../src/config.js";
import { result } from "./fixtures.js";
import type { AgentRole } from "../src/types.js";
import type { V3Stage } from "../src/workflow-records.js";

function setup(stage:V3Stage="DESIGN",approved=false) {
 const store=new Store(":memory:");
 store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,created_at,updated_at,context) VALUES('work-1',1,'owner/demo','SPEC','now','now',?)").run(JSON.stringify({title:"Demo",body:"Build it",cursor:5}));
 if(approved)store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment,approved_by,approval_comment_id,approved_at) VALUES('work-1',1,'SPEC',?,?, 'owner',4,'now')").run(JSON.stringify([{id:"AC1",description:"Returns 42"}]),JSON.stringify({complexity:"medium",risk:"low",rationale:"standard"}));
 const projections=new WorkflowProjections(store);projections.initialize("work-1",stage,"QUEUED");
 return {store,projections,records:new WorkflowRecords(store),results:new WorkflowResults(store)};
}

function running(s:ReturnType<typeof setup>,role:AgentRole,id:string) {
 s.store.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at) VALUES(?,?,?,?,?)").run(id,"work-1",role,"succeeded","now");
 const current=s.projections.get("work-1");s.projections.transition({workItemId:"work-1",expectedRevision:current.revision,stage:current.stage,status:"RUNNING",activeRunId:id,actor:{type:"orchestrator",id:"scheduler"},source:{executionId:id},reason:{code:"execution-started",summary:`${role} started`}});
}

test("Architect specification creates a versioned approval request",()=>{
 const s=setup();
 try {
  running(s,"product-architect","run-a");
  const applied=s.results.apply({workItemId:"work-1",executionId:"run-a",role:"product-architect",result:result("spec")});
  assert.equal(applied.discarded,false);assert.deepEqual({stage:applied.projection.stage,status:applied.projection.status},{stage:"DESIGN",status:"WAITING"});
  assert.equal((s.store.db.prepare("SELECT body FROM specs WHERE work_item_id='work-1' AND version=1").get() as {body:string}).body,"# Specification\nAC1: returns 42");
  const request=s.records.activeRequest("work-1");assert.equal(request?.payload.kind==="request"&&request.payload.type,"spec-approval");
 } finally {s.store.db.close();}
});

test("delivery pass advances the stored stage and accepts role-owned deferred findings",()=>{
 const s=setup("BUILD",true);
 try {
  const deferred=s.records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"finding",classification:"defer",originRole:"developer",evidence:"Optional cleanup"},sourceType:"agent-result",sourceId:"old",actor:"developer"});
  running(s,"developer","run-b");
  const applied=s.results.apply({workItemId:"work-1",executionId:"run-b",role:"developer",result:result("pass")});
  assert.deepEqual({stage:applied.projection.stage,status:applied.projection.status},{stage:"TEST",status:"QUEUED"});assert.equal(s.records.get(deferred.id)?.status,"accepted-defer");
 } finally {s.store.db.close();}
});

test("a delivery decision routes through Architect and returns only to an allowed stage",()=>{
 const s=setup("TEST",true);
 try {
  running(s,"qa","run-q");
  const decision=s.results.apply({workItemId:"work-1",executionId:"run-q",role:"qa",result:result("decision")});
  assert.deepEqual({stage:decision.projection.stage,status:decision.projection.status},{stage:"DESIGN",status:"QUEUED"});
  const request=s.records.activeRequest("work-1");assert.equal(request?.payload.kind==="request"&&request.payload.type,"tactical-decision");
  running(s,"product-architect","run-a");
  const resolved=s.results.apply({workItemId:"work-1",executionId:"run-a",role:"product-architect",result:result("resolved",{decisions:[{kind:"tactical",decision:"Keep the fixture",rationale:"Within SPEC",conflictsWithHuman:false}],nextRole:"qa"})});
  assert.deepEqual({stage:resolved.projection.stage,status:resolved.projection.status},{stage:"TEST",status:"QUEUED"});assert.equal(s.records.get(request!.id)?.status,"resolved");
  assert.equal(s.records.active("work-1",1,"qa").some(record=>record.payload.kind==="decision"&&record.payload.category==="tactical"),true);
 } finally {s.store.db.close();}
});

test("correction cycles count changes, stop at the limit and preserve the tactical route after human guidance",()=>{
 const previous=config.maxCycles;config.maxCycles=2;
 const s=setup("TEST",true);
 try {
  running(s,"qa","run-1");
  const first=s.results.apply({workItemId:"work-1",executionId:"run-1",role:"qa",result:result("changes",{coverage:[{criterionId:"AC1",status:"failed",evidence:"Mismatch"}],findings:[{classification:"auto-fix",evidence:"Fix it"}]})});
  assert.deepEqual({stage:first.projection.stage,status:first.projection.status,cycles:first.projection.correctionCycles},{stage:"BUILD",status:"QUEUED",cycles:1});
  running(s,"developer","run-2");
  const second=s.results.apply({workItemId:"work-1",executionId:"run-2",role:"developer",result:result("changes",{coverage:[{criterionId:"AC1",status:"failed",evidence:"Still wrong"}],findings:[{classification:"auto-fix",evidence:"Try again"}]})});
  assert.deepEqual({stage:second.projection.stage,status:second.projection.status,cycles:second.projection.correctionCycles},{stage:"BUILD",status:"WAITING",cycles:2});
  const limit=s.records.activeRequest("work-1");assert.equal(limit?.payload.kind==="request"&&limit.payload.type,"correction-limit");
  const answered=new WorkflowCommands(s.store).apply({kind:"answer",text:"Use deterministic data"},{workItemId:"work-1",login:"owner",commentId:6,specVersion:1});
  assert.deepEqual({stage:answered.projection.stage,status:answered.projection.status,cycles:answered.projection.correctionCycles},{stage:"DESIGN",status:"QUEUED",cycles:0});
  const tactical=s.records.activeRequest("work-1");assert.equal(tactical?.payload.kind==="request"&&tactical.payload.originatingStage,"BUILD");
 } finally {config.maxCycles=previous;s.store.db.close();}
});

test("late agent results are discarded after a concurrent workflow change",()=>{
 const s=setup("BUILD",true);
 try {
  running(s,"developer","run-b");
  new WorkflowCommands(s.store).apply({kind:"cancel"},{workItemId:"work-1",login:"owner",commentId:9,specVersion:1});
  const applied=s.results.apply({workItemId:"work-1",executionId:"run-b",role:"developer",result:result("pass")});
  assert.equal(applied.discarded,true);assert.equal(s.projections.get("work-1").status,"CANCELLED");
  assert.equal((s.store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='execution.discarded'").get() as {count:number}).count,1);
 } finally {s.store.db.close();}
});

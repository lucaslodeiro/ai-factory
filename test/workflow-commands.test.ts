import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { WorkflowCommands } from "../src/workflow-commands.js";
import { WorkflowFailures } from "../src/workflow-failures.js";
import { WorkflowProjections } from "../src/workflow-projection.js";
import { WorkflowRecords } from "../src/workflow-records.js";
import { ContextAssembler } from "../src/context-assembly.js";

function setup(stage:"DESIGN"|"BUILD"|"TEST"|"DELIVERY"="DESIGN",status:"QUEUED"|"WAITING"|"FAILED"|"PAUSED"|"CANCELLED"|"COMPLETED"="QUEUED") {
 const store=new Store(":memory:");
 store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context) VALUES('work-1',1,'owner/demo','now','now','{}')").run();
 store.db.prepare("INSERT INTO specs(work_item_id,version,body) VALUES('work-1',1,'SPEC v1')").run();
 const records=new WorkflowRecords(store),failures=new WorkflowFailures(store),projections=new WorkflowProjections(store);
 return {store,records,failures,projections,commands:new WorkflowCommands(store),initialize:()=>projections.initialize("work-1",stage,status)};
}

const context=(commentId=20)=>({workItemId:"work-1",login:"owner",commentId,specVersion:1});

test("note, replace and revoke update presentation without advancing workflow revision",()=>{
 const s=setup();
 try {
  s.initialize();
  const noted=s.commands.apply({kind:"note",text:"Do not use Chromium",scope:"spec",appliesTo:["qa"]},context());
  assert.deepEqual({revision:noted.projection.revision,presentation:noted.projection.presentationRevision},{revision:0,presentation:1});
  const first=noted.recordIds[0];
  const replaced=s.commands.apply({kind:"replace",recordId:first.slice(0,8),text:"Use WebKit",scope:"issue",appliesTo:["qa"]},context(21));
  assert.equal(s.records.get(first)?.status,"superseded");
  assert.equal(replaced.projection.presentationRevision,2);
  const replacement=replaced.recordIds[0];
  s.commands.apply({kind:"revoke",recordId:replacement.slice(0,8)},context(22));
  assert.equal(s.records.get(replacement)?.status,"revoked");
  assert.equal(s.projections.get("work-1").revision,0);
  assert.equal((s.store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='workflow.presentation'").get() as {count:number}).count,3);
 } finally {s.store.db.close();}
});

test("approval rejects stale comments and atomically opens build",()=>{
 const s=setup("DESIGN","WAITING");
 try {
  const request=s.records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:10},sourceType:"agent-result",sourceId:"run-1",actor:"product-architect"});
  s.initialize();
  assert.throws(()=>s.commands.apply({kind:"approve",version:1},context(10)),/stale/);
  const result=s.commands.apply({kind:"approve",version:1},context(11));
  assert.deepEqual({stage:result.projection.stage,status:result.projection.status,active:result.projection.activeRequestId},{stage:"BUILD",status:"QUEUED",active:undefined});
  assert.equal(s.records.get(request.id)?.status,"resolved");
  assert.deepEqual(s.store.db.prepare("SELECT approved_by,approval_comment_id FROM specs WHERE work_item_id='work-1' AND version=1").get(),{approved_by:"owner",approval_comment_id:11});
 } finally {s.store.db.close();}
});

test("answer resolves the human child, preserves the Architect parent and records guidance",()=>{
 const s=setup("DESIGN","WAITING");
 try {
  const parent=s.records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"request",type:"tactical-decision",owner:"architect",originatingStage:"TEST",allowedReturnStages:["BUILD","TEST"],openedAfterCommentId:5},sourceType:"agent-result",sourceId:"run-1",actor:"qa"});
  const child=s.records.create({workItemId:"work-1",specVersion:1,scope:"spec",parentId:parent.id,payload:{kind:"request",type:"clarification",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["DESIGN"],openedAfterCommentId:10},sourceType:"agent-result",sourceId:"run-2",actor:"product-architect"});
  s.initialize();
  const result=s.commands.apply({kind:"answer",text:"Use the public API"},context(11));
  assert.deepEqual({stage:result.projection.stage,status:result.projection.status,active:result.projection.activeRequestId},{stage:"DESIGN",status:"QUEUED",active:parent.id});
  assert.equal(s.records.get(child.id)?.status,"resolved");
  assert.equal(s.records.active("work-1",1,"product-architect").some(record=>record.kind==="decision"),true);
  const event=JSON.parse((s.store.db.prepare("SELECT payload FROM events WHERE type='workflow.transition'").get() as {payload:string}).payload);
  assert.equal(event.recordIds.includes(child.id),true);
 } finally {s.store.db.close();}
});

test("retry resolves failure, records optional guidance and advances attempt only when queued",()=>{
 const s=setup("TEST","FAILED");
 try {
  const failure=s.failures.open({workItemId:"work-1",class:"execution",message:"Tests failed",stage:"TEST",attempt:0});
  s.initialize();
  const result=s.commands.apply({kind:"retry",guidance:"Skip Chromium"},context());
  assert.deepEqual({stage:result.projection.stage,status:result.projection.status,attempt:result.projection.attempt},{stage:"TEST",status:"QUEUED",attempt:1});
  assert.equal(s.failures.get(failure.id)?.resolvedBy,"comment:20");
  assert.equal(s.records.active("work-1",1,"qa").some(record=>record.kind==="instruction"),true);
 } finally {s.store.db.close();}

 const paused=setup("DESIGN","PAUSED");
 try {
  paused.records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"request",type:"clarification",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["DESIGN"],openedAfterCommentId:1},sourceType:"agent-result",sourceId:"run",actor:"product-architect"});
  paused.initialize();
  const result=paused.commands.apply({kind:"retry",guidance:""},context());
  assert.deepEqual({status:result.projection.status,attempt:result.projection.attempt},{status:"WAITING",attempt:0});
 } finally {paused.store.db.close();}
});

test("cancel closes request chain and failure, while terminal workflows stay immutable",()=>{
 const s=setup("BUILD","PAUSED");
 try {
  const parent=s.records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"request",type:"tactical-decision",owner:"architect",originatingStage:"BUILD",allowedReturnStages:["BUILD"],openedAfterCommentId:1},sourceType:"agent-result",sourceId:"run-1",actor:"developer"});
  const child=s.records.create({workItemId:"work-1",specVersion:1,scope:"spec",parentId:parent.id,payload:{kind:"request",type:"clarification",owner:"human",originatingStage:"BUILD",allowedReturnStages:["BUILD"],openedAfterCommentId:2},sourceType:"agent-result",sourceId:"run-2",actor:"product-architect"});
  const failure=s.failures.open({workItemId:"work-1",class:"recovery",message:"Interrupted",stage:"BUILD",attempt:1});
  s.initialize();
  const result=s.commands.apply({kind:"cancel"},context());
  assert.equal(result.projection.status,"CANCELLED");
  assert.equal(s.records.get(parent.id)?.status,"cancelled");
  assert.equal(s.records.get(child.id)?.status,"cancelled");
  assert.equal(s.failures.get(failure.id)?.resolvedBy,"comment:20");
 } finally {s.store.db.close();}

 const terminal=setup("DELIVERY","COMPLETED");
 try {
  terminal.initialize();
  assert.throws(()=>terminal.commands.apply({kind:"cancel"},context()),/Cannot cancel/);
  assert.throws(()=>terminal.commands.apply({kind:"note",text:"change",scope:"spec",appliesTo:[]},context()),/Cannot note/);
 } finally {terminal.store.db.close();}
});

test("answering a correction limit queues Architect with the preserved return route",()=>{
 const s=setup("TEST","WAITING");
 try {
  const limit=s.records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"request",type:"correction-limit",owner:"human",originatingStage:"TEST",allowedReturnStages:["BUILD","TEST"],openedAfterCommentId:8,findingIds:[]},sourceType:"agent-result",sourceId:"run",actor:"qa"});
  s.initialize();
  const result=s.commands.apply({kind:"answer",text:"Use the API fixture"},context(9));
  const active=s.records.activeRequest("work-1");
  assert.equal(s.records.get(limit.id)?.status,"resolved");assert.equal(active?.payload.kind==="request"&&active.payload.type,"tactical-decision");
  assert.deepEqual(active?.payload.kind==="request"&&active.payload.allowedReturnStages,["BUILD","TEST"]);
  assert.deepEqual({stage:result.projection.stage,status:result.projection.status,active:result.projection.activeRequestId},{stage:"DESIGN",status:"QUEUED",active:active?.id});
 } finally {s.store.db.close();}
});

test("merge feedback returns delivery to Builder as an open human auto-fix finding",()=>{
 const s=setup("DELIVERY","WAITING");
 try {
  const request=s.records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"request",type:"merge",owner:"human",originatingStage:"DELIVERY",allowedReturnStages:["DELIVERY"],openedAfterCommentId:10},sourceType:"orchestrator",sourceId:"pr",actor:"orchestrator"});
  s.initialize();
  const result=s.commands.apply({kind:"answer",text:"Fix the flaky test"},context(11));
  assert.deepEqual({stage:result.projection.stage,status:result.projection.status,cycles:result.projection.correctionCycles},{stage:"BUILD",status:"QUEUED",cycles:0});
  assert.equal(s.records.get(request.id)?.status,"resolved");
  const finding=s.records.active("work-1",1,"developer").find(record=>record.payload.kind==="finding");
  assert.equal(finding?.payload.kind==="finding"&&finding.payload.classification,"auto-fix");
  assert.equal(finding?.payload.kind==="finding"&&finding.payload.evidence,"Fix the flaky test");
  assert.equal(finding?.sourceType,"github-comment");assert.equal(finding?.actor,"owner");
  const prompt=new ContextAssembler(s.store).assemble({workItemId:"work-1",role:"developer",specVersion:1,budgetBytes:100_000,budgetSource:"default",issue:{title:"Issue",body:"Body"}});
  assert.match(prompt.markdown,/Fix the flaky test/);
 } finally {s.store.db.close();}
});

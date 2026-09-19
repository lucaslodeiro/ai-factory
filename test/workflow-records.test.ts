import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { WorkflowRecords } from "../src/workflow-records.js";
import { WorkflowFailures } from "../src/workflow-failures.js";

function setup() {
 const store=new Store(":memory:");
 store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,created_at,updated_at,context) VALUES('work-1',1,'owner/demo','SPEC','now','now','{}')").run();
 return {store,records:new WorkflowRecords(store),failures:new WorkflowFailures(store)};
}

test("records receive stable sequence and role-filtered active context", () => {
 const {store,records}=setup();
 try {
  const general=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"instruction",text:"All roles"},sourceType:"github-comment",sourceId:"1",actor:"owner"});
  const builder=records.create({workItemId:"work-1",specVersion:1,scope:"spec",appliesTo:["developer"],payload:{kind:"instruction",text:"Builder only"},sourceType:"github-comment",sourceId:"2",actor:"owner"});
  const issue=records.create({workItemId:"work-1",specVersion:0,scope:"issue",payload:{kind:"decision",category:"human",decision:"Keep it public",rationale:"Product choice",supersedes:[]},sourceType:"github-comment",sourceId:"3",actor:"owner"});
  assert.deepEqual([general.sequence,builder.sequence,issue.sequence],[1,2,3]);
  assert.deepEqual(records.active("work-1",1,"developer").map(record=>record.id),[general.id,builder.id,issue.id]);
  assert.deepEqual(records.active("work-1",1,"qa").map(record=>record.id),[general.id,issue.id]);
 } finally { store.db.close(); }
});

test("open requests form one chain and resolving a child restores its parent", () => {
 const {store,records}=setup();
 try {
  const parent=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"request",type:"tactical-decision",owner:"architect",originatingStage:"BUILD",allowedReturnStages:["BUILD"],openedAfterCommentId:10},sourceType:"agent-result",sourceId:"run-1",actor:"builder"});
  const child=records.create({workItemId:"work-1",specVersion:1,scope:"spec",parentId:parent.id,payload:{kind:"request",type:"clarification",owner:"human",originatingStage:"BUILD",allowedReturnStages:["BUILD"],openedAfterCommentId:12,questions:["Does it look right?"]},sourceType:"agent-result",sourceId:"run-2",actor:"architect"});
  assert.equal(records.activeRequest("work-1")?.id,child.id);
  assert.throws(()=>records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"request",type:"merge",owner:"human",originatingStage:"DELIVERY",allowedReturnStages:["DELIVERY"],openedAfterCommentId:13},sourceType:"orchestrator",sourceId:"event-1",actor:"orchestrator"}),/extend the existing request chain/);
  assert.throws(()=>records.create({workItemId:"work-1",specVersion:1,scope:"spec",parentId:parent.id,payload:{kind:"request",type:"clarification",owner:"human",originatingStage:"BUILD",allowedReturnStages:["BUILD"],openedAfterCommentId:13},sourceType:"agent-result",sourceId:"run-3",actor:"architect"}),/only one open child/);
  assert.equal(records.resolveRequest(child.id)?.id,parent.id);
 } finally { store.db.close(); }
});

test("failure lifecycle exposes exactly one active failure", () => {
 const {store,failures}=setup();
 try {
  const first=failures.open({workItemId:"work-1",class:"execution",message:"Provider exited",stage:"BUILD",attempt:1});
  assert.equal(failures.active("work-1")?.id,first.id);
  assert.throws(()=>failures.open({workItemId:"work-1",class:"recovery",message:"Restarted",stage:"BUILD",attempt:1}),/UNIQUE/);
  failures.resolve(first.id,"retry-comment-20");
  const second=failures.open({workItemId:"work-1",class:"recovery",message:"Restarted",stage:"BUILD",attempt:2});
  assert.equal(failures.active("work-1")?.id,second.id);
 } finally { store.db.close(); }
});

test("instruction replacement and revocation are explicit",()=>{
 const {store,records}=setup();
 try {
  const first=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"instruction",text:"Use Chromium"},sourceType:"github-comment",sourceId:"1",actor:"owner"});
  const unrelated=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"instruction",text:"Keep the UI light"},sourceType:"github-comment",sourceId:"2",actor:"owner"});
  const replacement=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"instruction",text:"Do not use Chromium",supersedes:[first.id]},sourceType:"github-comment",sourceId:"3",actor:"owner"});
  assert.deepEqual({status:records.get(first.id)?.status,supersededBy:records.get(first.id)?.supersededBy},{status:"superseded",supersededBy:replacement.id});
  assert.equal(records.get(unrelated.id)?.status,"active");
  assert.equal(records.revokeInstruction(unrelated.id).status,"revoked");
 } finally {store.db.close();}
});

test("agent decisions cannot supersede human decisions",()=>{
 const {store,records}=setup();
 try {
  const human=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"decision",category:"human",decision:"No authentication",rationale:"Public MVP",supersedes:[]},sourceType:"github-comment",sourceId:"1",actor:"owner"});
  assert.throws(()=>records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"decision",category:"tactical",decision:"Add login",rationale:"Convenient",supersedes:[human.id]},sourceType:"agent-result",sourceId:"run-1",actor:"product-architect"}),/cannot supersede a human decision/);
  assert.equal(records.get(human.id)?.status,"active");
  const changed=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"decision",category:"human",decision:"Require login",rationale:"Owner changed scope",supersedes:[human.id]},sourceType:"github-comment",sourceId:"2",actor:"owner"});
  assert.equal(records.get(human.id)?.supersededBy,changed.id);
 } finally {store.db.close();}
});

test("new spec supersedes spec-scoped records but preserves issue scope",()=>{
 const {store,records}=setup();
 try {
  const scoped=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"instruction",text:"Retry the failing test"},sourceType:"github-comment",sourceId:"1",actor:"owner"});
  const durable=records.create({workItemId:"work-1",specVersion:1,scope:"issue",payload:{kind:"instruction",text:"Never expose credentials"},sourceType:"github-comment",sourceId:"2",actor:"owner"});
  assert.equal(records.supersedeSpec("work-1",1),1);
  assert.equal(records.get(scoped.id)?.status,"superseded");
  assert.equal(records.get(durable.id)?.status,"active");
 } finally {store.db.close();}
});

test("finding settlement records the execution and enforces defer semantics",()=>{
 const {store,records}=setup();
 try {
  store.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at) VALUES('run-2','work-1','qa','succeeded','now')").run();
  const fix=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"finding",classification:"auto-fix",originRole:"qa",evidence:"Missing coverage"},sourceType:"agent-result",sourceId:"run-1",actor:"qa"});
  const deferred=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"finding",classification:"defer",originRole:"developer",evidence:"Optional cleanup"},sourceType:"agent-result",sourceId:"run-1",actor:"developer"});
  assert.equal(records.settleFindings([fix.id],"resolved","run-2")[0].resolvedBy,"run-2");
  assert.equal(records.settleFindings([deferred.id],"accepted-defer","run-2")[0].status,"accepted-defer");
 } finally {store.db.close();}
});

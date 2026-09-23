import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { WorkflowCommands } from "../src/workflow-commands.js";
import { WorkflowProjections } from "../src/workflow-projection.js";
import { WorkflowRecords } from "../src/workflow-records.js";
import { WorkflowResults } from "../src/workflow-results.js";
import { config } from "../src/config.js";
import { InvalidResultError } from "../src/results.js";
import { result } from "./fixtures.js";
import type { AgentRole } from "../src/types.js";
import type { V3Stage } from "../src/workflow-records.js";

function setup(stage:V3Stage="DESIGN",approved=false) {
 const store=new Store(":memory:");
 store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context) VALUES('work-1',1,'owner/demo','now','now',?)").run(JSON.stringify({title:"Demo",body:"Build it",cursor:5}));
 if(approved)store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment,approved_by,approval_comment_id,approved_at) VALUES('work-1',1,'SPEC',?,?, 'owner',4,'now')").run(JSON.stringify([{id:"AC1",description:"Returns 42"}]),JSON.stringify({complexity:"medium",risk:"low",verificationDepth:"thorough",rationale:"standard"}));
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
  const applied=s.results.apply({head:"head",workItemId:"work-1",executionId:"run-a",role:"product-architect",result:result("spec")});
  assert.equal(applied.discarded,false);assert.deepEqual({stage:applied.projection.stage,status:applied.projection.status},{stage:"DESIGN",status:"WAITING"});
  assert.equal((s.store.db.prepare("SELECT body FROM specs WHERE work_item_id='work-1' AND version=1").get() as {body:string}).body,"## Decisions for you\nNone.\n\n## Solution\nReturn 42.\n\n---\n\n# Specification\nAC1: returns 42");
  const request=s.records.activeRequest("work-1");assert.equal(request?.payload.kind==="request"&&request.payload.type,"spec-approval");
 } finally {s.store.db.close();}
});

test("delivery pass advances the stored stage and accepts role-owned deferred findings",()=>{
 const s=setup("BUILD",true);
 try {
  const deferred=s.records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"finding",classification:"defer",severity:"minor",originRole:"developer",evidence:"Optional cleanup"},sourceType:"agent-result",sourceId:"old",actor:"developer"});
  running(s,"developer","run-b");
  const applied=s.results.apply({head:"head",workItemId:"work-1",executionId:"run-b",role:"developer",result:result("pass")});
  assert.deepEqual({stage:applied.projection.stage,status:applied.projection.status},{stage:"TEST",status:"QUEUED"});assert.equal(s.records.get(deferred.id)?.status,"accepted-defer");
 } finally {s.store.db.close();}
});

test("Tester and Reviewer passes record the exact verified heads",()=>{
 const qa=setup("TEST",true);try{running(qa,"qa","run-q");qa.results.apply({head:"test-head",workItemId:"work-1",executionId:"run-q",role:"qa",result:result("pass")});assert.equal((JSON.parse((qa.store.db.prepare("SELECT context FROM work_items WHERE id='work-1'").get() as {context:string}).context) as {verifiedHeads:Record<string,string>}).verifiedHeads.TEST,"test-head");}finally{qa.store.db.close();}
 const review=setup("REVIEW",true);try{running(review,"reviewer","run-r");review.results.apply({head:"review-head",workItemId:"work-1",executionId:"run-r",role:"reviewer",result:result("pass")});assert.equal((JSON.parse((review.store.db.prepare("SELECT context FROM work_items WHERE id='work-1'").get() as {context:string}).context) as {verifiedHeads:Record<string,string>}).verifiedHeads.REVIEW,"review-head");}finally{review.store.db.close();}
});

test("a delivery decision routes through Architect and returns only to an allowed stage",()=>{
 const s=setup("TEST",true);
 try {
  const prior=s.records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"decision",category:"tactical",decision:"Use fixture v1",rationale:"Initial tactic",supersedes:[]},sourceType:"agent-result",sourceId:"old",actor:"product-architect"});
  running(s,"qa","run-q");
  const decision=s.results.apply({head:"head",workItemId:"work-1",executionId:"run-q",role:"qa",result:result("decision")});
  assert.deepEqual({stage:decision.projection.stage,status:decision.projection.status},{stage:"DESIGN",status:"QUEUED"});
  const request=s.records.activeRequest("work-1");assert.equal(request?.payload.kind==="request"&&request.payload.type,"tactical-decision");
  running(s,"product-architect","run-a");
  const resolved=s.results.apply({head:"head",workItemId:"work-1",executionId:"run-a",role:"product-architect",result:result("resolved",{decisions:[{kind:"tactical",decision:"Keep the fixture",rationale:"Within SPEC",conflictsWithHuman:false,supersedes:[prior.id]}],nextRole:"qa"})});
  assert.deepEqual({stage:resolved.projection.stage,status:resolved.projection.status},{stage:"TEST",status:"QUEUED"});assert.equal(s.records.get(request!.id)?.status,"resolved");
  assert.equal(s.records.active("work-1",1,"qa").some(record=>record.payload.kind==="decision"&&record.payload.category==="tactical"),true);
  assert.equal(s.records.get(prior.id)?.status,"superseded");
 } finally {s.store.db.close();}
});

test("Architect supersedes only active decision record ids",()=>{
 const s=setup("DESIGN",true);try{
  const prior=s.records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"decision",category:"tactical",decision:"Keep fixture v1",rationale:"Initial tactic",supersedes:[]},sourceType:"agent-result",sourceId:"old",actor:"product-architect"});
  running(s,"product-architect","run-a");
  assert.throws(()=>s.results.apply({head:"head",workItemId:"work-1",executionId:"run-a",role:"product-architect",result:result("resolved",{nextRole:"qa",decisions:[{kind:"tactical",decision:"Use fixture v2",rationale:"Replaces the prior decision",conflictsWithHuman:false,supersedes:["Spec Out of Scope note excluding the add test fix"]}]})}),error=>error instanceof InvalidResultError&&error.message==='decisions[0].supersedes contains "Spec Out of Scope note excluding the add test fix", which is not an active decision id. Use the ids listed under "Active tactical decisions" and "Active human decisions", or leave supersedes empty.');
  assert.equal(s.records.get(prior.id)?.status,"active");
 }finally{s.store.db.close();}
});

test("the correction limit is the number of automatic Builder corrections, and human guidance keeps the tactical route",()=>{
 // One automatic correction: the first change request goes back to Builder, the second waits for a person.
 const previous=config.maxCycles;config.maxCycles=1;
 const s=setup("TEST",true);
 try {
  running(s,"qa","run-1");
  const first=s.results.apply({head:"head",workItemId:"work-1",executionId:"run-1",role:"qa",result:result("changes",{coverage:[{criterionId:"AC1",status:"failed",evidence:"Mismatch"}],findings:[{classification:"auto-fix",severity:"major",evidence:"Fix it"}]})});
  assert.deepEqual({stage:first.projection.stage,status:first.projection.status,cycles:first.projection.correctionCycles},{stage:"BUILD",status:"QUEUED",cycles:1});
  running(s,"developer","run-2");
  const second=s.results.apply({head:"head",workItemId:"work-1",executionId:"run-2",role:"developer",result:result("changes",{coverage:[{criterionId:"AC1",status:"failed",evidence:"Still wrong"}],findings:[{classification:"auto-fix",severity:"major",evidence:"Try again"}]})});
  assert.deepEqual({stage:second.projection.stage,status:second.projection.status,cycles:second.projection.correctionCycles},{stage:"BUILD",status:"WAITING",cycles:2});
  const limit=s.records.activeRequest("work-1");assert.equal(limit?.payload.kind==="request"&&limit.payload.type,"correction-limit");
  const answered=new WorkflowCommands(s.store).apply({kind:"answer",text:"Use deterministic data"},{workItemId:"work-1",login:"owner",commentId:6,specVersion:1});
  assert.deepEqual({stage:answered.projection.stage,status:answered.projection.status,cycles:answered.projection.correctionCycles},{stage:"DESIGN",status:"QUEUED",cycles:0});
  const tactical=s.records.activeRequest("work-1");assert.equal(tactical?.payload.kind==="request"&&tactical.payload.originatingStage,"BUILD");
 } finally {config.maxCycles=previous;s.store.db.close();}
});

test("a Builder pass with no files after a correction request waits for human guidance",()=>{
 const s=setup("TEST",true);try{
  running(s,"qa","run-q");s.results.apply({head:"head",workItemId:"work-1",executionId:"run-q",role:"qa",result:result("changes",{coverage:[{criterionId:"AC1",status:"failed",evidence:"Mismatch"}],findings:[{classification:"auto-fix",severity:"major",evidence:"Fix it"}]})});
  running(s,"developer","run-empty");const empty=s.results.apply({head:"head",workItemId:"work-1",executionId:"run-empty",role:"developer",result:result("pass"),changedPaths:[]});
  assert.deepEqual({stage:empty.projection.stage,status:empty.projection.status},{stage:"BUILD",status:"WAITING"});const request=s.records.activeRequest("work-1");assert.equal(request?.payload.kind==="request"&&request.payload.type,"correction-limit");
 }finally{s.store.db.close();}
 const changed=setup("TEST",true);try{
  running(changed,"qa","run-q");changed.results.apply({head:"head",workItemId:"work-1",executionId:"run-q",role:"qa",result:result("changes",{coverage:[{criterionId:"AC1",status:"failed",evidence:"Mismatch"}],findings:[{classification:"auto-fix",severity:"major",evidence:"Fix it"}]})});
  running(changed,"developer","run-changed");const applied=changed.results.apply({head:"head",workItemId:"work-1",executionId:"run-changed",role:"developer",result:result("pass"),changedPaths:["src/app.ts"]});assert.deepEqual({stage:applied.projection.stage,status:applied.projection.status},{stage:"TEST",status:"QUEUED"});
 }finally{changed.store.db.close();}
});

test("late agent results are discarded after a concurrent workflow change",()=>{
 const s=setup("BUILD",true);
 try {
  running(s,"developer","run-b");
  new WorkflowCommands(s.store).apply({kind:"cancel",reason:""},{workItemId:"work-1",login:"owner",commentId:9,specVersion:1});
  const applied=s.results.apply({head:"head",workItemId:"work-1",executionId:"run-b",role:"developer",result:result("pass")});
  assert.equal(applied.discarded,true);assert.equal(s.projections.get("work-1").status,"CANCELLED");
  assert.equal((s.store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='execution.discarded'").get() as {count:number}).count,1);
 } finally {s.store.db.close();}
});

test('optional deferred findings do not pause a tactical resolution',()=>{
 const s=setup('BUILD',true);try{
  running(s,'developer','builder');s.results.apply({head:"head",workItemId:'work-1',executionId:'builder',role:'developer',result:result('decision',{findings:[{classification:'decision-required',severity:'major',evidence:'Chrome cannot start'},{classification:'defer',severity:'minor',evidence:'Preview cleanup pending'}]})});
  const request=s.records.activeRequest('work-1')!;const deferred=s.records.active('work-1',1,'product-architect').find(row=>row.payload.kind==='finding'&&row.payload.classification==='defer')!;
  running(s,'product-architect','architect');const applied=s.results.apply({head:"head",workItemId:'work-1',executionId:'architect',role:'product-architect',result:result('resolved',{nextRole:'developer',findings:[{classification:'defer',severity:'minor',evidence:'Optional documentation cleanup can follow later'}]})});
  assert.equal(applied.projection.status,'QUEUED');assert.equal(applied.projection.stage,'BUILD');assert.equal(s.records.get(request.id)?.status,'resolved');assert.equal(s.records.get(deferred.id)?.status,'open');
 }finally{s.store.db.close();}
});

test('environment blocker fails Build directly without sending another Architect consultation',()=>{
 const s=setup('BUILD',true);try{running(s,'developer','blocked-builder');const applied=s.results.apply({head:"head",workItemId:'work-1',executionId:'blocked-builder',role:'developer',result:result('decision',{findings:[{classification:'environment-blocked',severity:'major',evidence:'Chrome cannot start. Fix the browser runtime before Retry.'}]})});assert.equal(applied.projection.status,'FAILED');assert.equal(applied.projection.stage,'BUILD');assert.equal(s.records.activeRequest('work-1'),undefined);assert.equal((s.store.db.prepare("SELECT class FROM failures WHERE work_item_id='work-1'").get() as any).class,'environment');}finally{s.store.db.close();}
});

test('initial Architect environment blocker becomes an environment failure with its result preserved',()=>{
 const s=setup();try{running(s,'product-architect','blocked-architect');const applied=s.results.apply({head:"head",workItemId:'work-1',executionId:'blocked-architect',role:'product-architect',result:result('questions',{summary:'Visual inspection is required before the specification can be completed',questions:['Can browser access be restored?'],findings:[{classification:'environment-blocked',severity:'major',evidence:'No browser is available to inspect the required rendered interface'}]})});assert.equal(applied.projection.status,'FAILED');assert.equal(applied.projection.stage,'DESIGN');assert.equal(s.records.activeRequest('work-1'),undefined);assert.equal((s.store.db.prepare("SELECT class FROM failures WHERE work_item_id='work-1'").get() as any).class,'environment');const event=s.store.db.prepare("SELECT payload FROM events WHERE work_item_id='work-1' AND type='agent.result'").get() as {payload:string};assert.match(event.payload,/Visual inspection is required/);}finally{s.store.db.close();}
});

test("every Tester result records what it considered, kept and discarded against the approved depth",()=>{
 const s=setup("TEST",true);
 try {
  running(s,"qa","run-q");
  s.results.apply({head:"h",workItemId:"work-1",executionId:"run-q",role:"qa",result:result("pass",{testCandidates:[{name:"happy",covers:["AC1"],value:"essential",kept:true,reason:"only criterion"},{name:"edge",covers:["AC1"],value:"valuable",kept:false,reason:"thorough does not need it"},{name:"dup",covers:["AC1"],value:"redundant",kept:false,reason:"same as happy"}]})});
  const event=JSON.parse((s.store.db.prepare("SELECT payload FROM events WHERE work_item_id='work-1' AND type='verification.selection' AND run_id='run-q'").get() as {payload:string}).payload);
  assert.deepEqual(event,{outcome:"pass",verificationDepth:"thorough",candidates:3,kept:1,essential:1,valuable:1,redundant:1,valuableDiscarded:1,commands:1});
 } finally {s.store.db.close();}
});

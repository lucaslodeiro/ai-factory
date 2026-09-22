import {runVerification} from "../src/verification.js";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { WorkflowIntake } from "../src/workflow-inbox.js";
import { commitSummary,WorkflowRunner } from "../src/workflow-runner.js";
import { WorkflowProjections } from "../src/workflow-projection.js";
import { WorkflowCommands } from "../src/workflow-commands.js";
import { WorkflowFailures } from "../src/workflow-failures.js";
import { config } from "../src/config.js";
import { result } from "./fixtures.js";
import type { AgentAdapter,AgentRunRequest } from "../src/adapters/agent.js";
import { SyncConflictError,type WorkspacePort } from "../src/worktrees.js";
import { InvalidResultError } from "../src/results.js";
import {adoptIssueState,issueStateIndex} from "../src/workflow-state.js";

class Workspace implements WorkspacePort {
 commits:string[]=[];cleanupCalls=0;publishCalls=0;pushError:Error|undefined;syncError:Error|undefined;syncSkipped:string|undefined;currentHead="abc";ensure(){return "/tmp/factory-work";}assertBranch(){}sync(){if(this.syncError)throw this.syncError;return{before:this.currentHead,after:this.currentHead,merged:[],skipped:this.syncSkipped};}head(){return this.currentHead;}diff(){return "";}check(){}commit(_cwd:string,message:string){this.commits.push(message);}publish(){this.publishCalls++;}
 async publishAsync(){this.publishCalls++;if(this.pushError)throw this.pushError;}
 changeSummary(){return{files:[],stat:""};}prepareReviewerContext(){return{path:"/tmp/factory-work/.factory-context/review.diff",files:[],stat:""};}cleanupReviewerContext(){this.cleanupCalls++;}
}

test("commit summaries cut long subjects at a word boundary",()=>{
 const summary="Implement the requested export behavior with validation, integration coverage, and documentation for all affected callers today";
 assert.ok(summary.length>100);const subject=commitSummary(summary);
 assert.match(subject,/integration…$/);assert.ok(subject.length<=73);
});
const runnerIssue={id:100,nodeId:"I_100",number:1,title:"Runner",body:"Build it",url:"https://github.com/owner/demo/issues/1",state:"OPEN" as const,createdAt:"2026-09-20T00:00:00Z",updatedAt:"2026-09-20T00:00:00Z",author:{login:"owner",type:"User"}};

test("runner assembles bounded context and drives Architect then Builder through V3",async()=>{
 const store=new Store(":memory:"),started=new WorkflowIntake(store).start(runnerIssue,{actor:"dashboard",source:"control"});
 const requests:AgentRunRequest[]=[],workspace=new Workspace();
 const adapter=(value:ReturnType<typeof result>):AgentAdapter=>({async run(request){requests.push(request);store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);return value;}});
 const delivery={ensurePR(){return "https://github.com/owner/demo/pull/2";}};
 try {
  const architect=new WorkflowRunner(store,{"product-architect":adapter(result("spec"))},workspace,delivery);assert.equal(await architect.run(started.id),true);
  assert.equal(new WorkflowProjections(store).get(started.id).status,"WAITING");assert.match(requests[0].instructions,/AI Factory worker rules/);assert.match(requests[0].instructions,/## Issue/);assert.equal(requests[0].promptMetadata?.budgetBytes,config.contextBudget.defaultBytes);
  new WorkflowCommands(store).apply({kind:"approve",version:1,guidance:""},{workItemId:started.id,login:"owner",commentId:1,specVersion:1});
  const builder=new WorkflowRunner(store,{developer:adapter(result("pass"))},workspace,delivery);assert.equal(await builder.run(started.id),true);
  assert.deepEqual({stage:new WorkflowProjections(store).get(started.id).stage,status:new WorkflowProjections(store).get(started.id).status},{stage:"TEST",status:"QUEUED"});assert.equal(workspace.commits.length,1);assert.equal(workspace.publishCalls,3);
  assert.equal(requests[1].promptMetadata?.includedRecordIds?.length,0);assert.match(requests[1].instructions,/Approved specification/);
 } finally {store.db.close();}
});

test("runner publishes the deterministic work branch before the initial Design execution",async()=>{
 const store=new Store(":memory:"),started=new WorkflowIntake(store).start(runnerIssue,{actor:"dashboard",source:"control"}),workspace=new Workspace();
 try{
  const runner=new WorkflowRunner(store,{"product-architect":{async run(request){store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);return result("questions");}}},workspace,{ensurePR(){return "unused";}});
  await runner.run(started.id);assert.equal(workspace.commits.length,0);assert.equal(workspace.publishCalls,1);
 }finally{store.db.close();}
});

test("previous attempt context is consumed once by only its matching stage and attempt",async()=>{
 const run=async(previous:{stage:string;attempt:number})=>{const store=new Store(":memory:"),workspace=new Workspace(),instructions:string[]=[];try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,branch,created_at,updated_at,context,stage,status,attempt) VALUES('previous',1,'owner/demo','factory/issue-1','now','now',?,'BUILD','QUEUED',2)").run(JSON.stringify({title:"Retry",body:"Continue",cwd:"/tmp/factory-work",previousAttempt:{...previous,reason:"interrupted-for-guidance",files:["src/partial.ts"]}}));
  store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment,approved_by,approved_at) VALUES('previous',1,'SPEC',?,?,'owner','now')").run(JSON.stringify([{id:"AC1",description:"Works"}]),JSON.stringify({complexity:"medium",risk:"low",rationale:"standard"}));
  const adapter:AgentAdapter={async run(request){instructions.push(request.instructions);store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);return result("pass");}};
  const runner=new WorkflowRunner(store,{developer:adapter,qa:adapter},workspace,{ensurePR(){return"unused";}});await runner.run("previous");const afterFirst=JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id='previous'").get() as {context:string}).context);assert.equal("previousAttempt" in afterFirst,false);const state=new WorkflowProjections(store).get("previous");assert.deepEqual({stage:state.stage,status:state.status},{stage:"TEST",status:"QUEUED"},new WorkflowFailures(store).active("previous")?.message);await runner.run("previous");return instructions;
 }finally{store.db.close();}};
 const matching=await run({stage:"BUILD",attempt:2});assert.equal(matching.length,2);assert.match(matching[0],/## Previous attempt/);assert.doesNotMatch(matching[1],/## Previous attempt/);
 const otherStage=await run({stage:"TEST",attempt:2});assert.equal(otherStage.length,2);assert.doesNotMatch(otherStage[0],/## Previous attempt/);assert.doesNotMatch(otherStage[1],/## Previous attempt/);
});

test("a rejected post-commit push preserves the applied result and records sanitized evidence",async()=>{
 const store=new Store(":memory:"),started=new WorkflowIntake(store).start(runnerIssue,{actor:"dashboard",source:"control"}),workspace=new Workspace();
 const adapter=(value:ReturnType<typeof result>):AgentAdapter=>({async run(request){store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);return value;}});
 try {
  const runner=new WorkflowRunner(store,{"product-architect":adapter(result("spec")),developer:adapter(result("pass"))},workspace,{ensurePR(){return "unused";}});
  await runner.run(started.id);new WorkflowCommands(store).apply({kind:"approve",version:1,guidance:""},{workItemId:started.id,login:"owner",commentId:1,specVersion:1});
  workspace.pushError=new Error("push rejected https://operator:super-secret@example.test/repo token=hidden-value");
  assert.equal(await runner.run(started.id),true);assert.deepEqual({stage:new WorkflowProjections(store).get(started.id).stage,status:new WorkflowProjections(store).get(started.id).status},{stage:"TEST",status:"QUEUED"});
  const event=store.db.prepare("SELECT payload FROM events WHERE type='workflow.push_failed'").get() as {payload:string};assert.match(event.payload,/\[REDACTED\]/);assert.doesNotMatch(event.payload,/super-secret|hidden-value/);
 } finally {store.db.close();}
});

test("a synchronization conflict fails as integration before execution and retry prepares again",async()=>{
 const store=new Store(":memory:"),started=new WorkflowIntake(store).start(runnerIssue,{actor:"dashboard",source:"control"}),workspace=new Workspace();let calls=0;
 try{
  workspace.syncError=new SyncConflictError(["src/app.ts"],"origin/factory/issue-1");const runner=new WorkflowRunner(store,{"product-architect":{async run(){calls++;return result("spec");}}},workspace,{ensurePR(){return "unused";}});
  assert.equal(await runner.run(started.id),true);assert.equal(calls,0);assert.equal(new WorkflowFailures(store).active(started.id)?.class,"integration");assert.match(new WorkflowFailures(store).active(started.id)?.message??"",/src\/app\.ts/);
  new WorkflowCommands(store).apply({kind:"retry",guidance:"resolved merge",scope:"issue",appliesTo:[]},{workItemId:started.id,login:"owner",commentId:2,specVersion:0});workspace.syncError=undefined;
  assert.equal(await runner.run(started.id),true);assert.equal(calls,1);assert.equal(new WorkflowProjections(store).get(started.id).status,"WAITING");
 }finally{store.db.close();}
});

test("a fetch failure skips remote synchronization without failing the execution",async()=>{
 const store=new Store(":memory:"),started=new WorkflowIntake(store).start(runnerIssue,{actor:"dashboard",source:"control"}),workspace=new Workspace();workspace.syncSkipped="fatal: unable to access https://operator:secret@example.test/repo";let calls=0;
 try{const runner=new WorkflowRunner(store,{"product-architect":{async run(request){calls++;store.db.prepare("UPDATE executions SET status=\'succeeded\',finished_at=\'now\' WHERE id=?").run(request.executionId);return result("spec");}}},workspace,{ensurePR(){return "unused";}});assert.equal(await runner.run(started.id),true);assert.equal(calls,1);assert.equal(new WorkflowProjections(store).get(started.id).status,"WAITING");const event=store.db.prepare("SELECT payload FROM events WHERE type=\'workflow.sync_skipped\'").get() as {payload:string};assert.match(event.payload,/\[REDACTED\]/);assert.doesNotMatch(event.payload,/secret/);}finally{store.db.close();}
});

test("protected context overflow fails before invoking a provider",async()=>{
 const store=new Store(":memory:"),started=new WorkflowIntake(store).start(runnerIssue,{actor:"dashboard",source:"control"}),workspace=new Workspace();
 let invoked=false;const previous=config.contextBudget.defaultBytes;config.contextBudget.defaultBytes=10;
 try {
  const runner=new WorkflowRunner(store,{"product-architect":{async run(){invoked=true;return result("spec");}}},workspace,{ensurePR(){throw new Error("unused");}});
  assert.equal(await runner.run(started.id),true);assert.equal(invoked,false);assert.equal(new WorkflowProjections(store).get(started.id).status,"FAILED");assert.equal(new WorkflowFailures(store).active(started.id)?.class,"invalid-context");
 } finally {config.contextBudget.defaultBytes=previous;store.db.close();}
});

test("runner classifies failures by typed result errors rather than message text",async()=>{
 const run=async(error:Error)=>{const store=new Store(":memory:"),started=new WorkflowIntake(store).start(runnerIssue,{actor:"dashboard",source:"control"});try{const runner=new WorkflowRunner(store,{"product-architect":{async run(){throw error;}}},new Workspace(),{ensurePR(){throw new Error("unused");}});await runner.run(started.id);if(error instanceof InvalidResultError)await runner.run(started.id);return new WorkflowFailures(store).active(started.id)?.class;}finally{store.db.close();}};
 assert.equal(await run(new Error("provider result channel disconnected")),"execution");
 assert.equal(await run(new InvalidResultError("invalid structured output")),"invalid-result");
});

test("runner retries one invalid result with the validator message and then fails the second",async()=>{
 const run=async(failures:number)=>{const store=new Store(":memory:"),started=new WorkflowIntake(store).start(runnerIssue,{actor:"dashboard",source:"control"}),prompts:string[]=[];let calls=0;try{
  const runner=new WorkflowRunner(store,{"product-architect":{async run(request){prompts.push(request.instructions);store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);if(calls++<failures)throw new InvalidResultError("result.summary: invalid text length");return result("spec");}}},new Workspace(),{ensurePR(){return "unused";}});
  await runner.run(started.id);if(failures===1){assert.deepEqual({stage:new WorkflowProjections(store).get(started.id).stage,status:new WorkflowProjections(store).get(started.id).status},{stage:"DESIGN",status:"QUEUED"});assert.equal((store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='execution.invalid_result'").get() as {count:number}).count,1);await runner.run(started.id);assert.equal(new WorkflowProjections(store).get(started.id).status,"WAITING");assert.match(prompts[1],/## Rejected previous result/);assert.match(prompts[1],/result.summary: invalid text length/);assert.equal("invalidResultRetry" in JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id=?").get(started.id) as {context:string}).context),false);const transition=store.db.prepare("SELECT payload FROM events WHERE type='workflow.transition' AND payload LIKE '%invalid-result-retry%'").get() as {payload:string};assert.ok(transition);}else{await runner.run(started.id);assert.equal(new WorkflowFailures(store).active(started.id)?.class,"invalid-result");} 
 }finally{store.db.close();}};
 await run(1);await run(2);
});

test("reviewer context is cleaned when maintenance blocks scheduler begin",async()=>{
 const store=new Store(":memory:"),workspace=new Workspace();
 try {
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,branch,created_at,updated_at,context) VALUES('work-review',1,'owner/demo','factory/review','now','now',?)").run(JSON.stringify({title:"Review",body:"Check it",cwd:"/tmp/factory-work",verifiedHeads:{TEST:"abc"}}));
  store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment,approved_by) VALUES('work-review',1,'SPEC',?,?, 'owner')").run(JSON.stringify([{id:"AC1",description:"Works"}]),JSON.stringify({complexity:"medium",risk:"low",rationale:"standard"}));
  new WorkflowProjections(store).initialize("work-review","REVIEW","QUEUED");
  store.db.prepare("INSERT INTO maintenance_operations(id,operation,actor,status,requested_at,confirmed_at) VALUES('maintenance','update','owner','confirmed','now','now')").run();
  const runner=new WorkflowRunner(store,{reviewer:{async run(){return result("pass");}}},workspace,{ensurePR(){return "unused";}});
  await assert.rejects(()=>runner.run("work-review"),/maintenance/);
  assert.equal(workspace.cleanupCalls,1);assert.equal(new WorkflowProjections(store).get("work-review").status,"QUEUED");
 } finally {store.db.close();}
});

test("review succeeds before deterministic Delivery publication and retry does not rerun Reviewer",async()=>{
 const store=new Store(":memory:"),workspace=new Workspace();let reviewerRuns=0,prAttempts=0,failPublication=true;
 try {
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,branch,created_at,updated_at,context) VALUES('work-review',1,'owner/demo','factory/review','now','now',?)").run(JSON.stringify({title:"Review",body:"Check it",cwd:"/tmp/factory-work",verifiedHeads:{TEST:"abc"}}));
  store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment,approved_by) VALUES('work-review',1,'SPEC',?,?, 'owner')").run(JSON.stringify([{id:"AC1",description:"Works"}]),JSON.stringify({complexity:"medium",risk:"low",rationale:"standard"}));
  new WorkflowProjections(store).initialize("work-review","REVIEW","QUEUED");
  const runner=new WorkflowRunner(store,{reviewer:{async run(request){reviewerRuns++;store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);return result("pass");}}},workspace,{ensurePR(){prAttempts++;if(failPublication)throw new Error("Pull request create failed: Base ref must be a branch");return "https://github.com/owner/demo/pull/1";}});
  assert.equal(await runner.run("work-review"),true);assert.deepEqual({stage:new WorkflowProjections(store).get("work-review").stage,status:new WorkflowProjections(store).get("work-review").status},{stage:"DELIVERY",status:"QUEUED"});assert.equal(reviewerRuns,1);assert.equal(workspace.publishCalls,1);
  assert.equal(await runner.run("work-review"),true);assert.equal(new WorkflowProjections(store).get("work-review").status,"FAILED");assert.equal(new WorkflowFailures(store).active("work-review")?.class,"integration");assert.equal(reviewerRuns,1);assert.equal(prAttempts,1);
  new WorkflowCommands(store).apply({kind:"retry",guidance:"",scope:"spec",appliesTo:[]},{workItemId:"work-review",login:"owner",commentId:9,specVersion:1});failPublication=false;
  assert.equal(await runner.run("work-review"),true);assert.deepEqual({stage:new WorkflowProjections(store).get("work-review").stage,status:new WorkflowProjections(store).get("work-review").status},{stage:"DELIVERY",status:"WAITING"});assert.equal(reviewerRuns,1);assert.equal(prAttempts,2);assert.equal(workspace.publishCalls,3);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM executions WHERE work_item_id='work-review'").get() as {count:number}).count,1);
 } finally {store.db.close();}
});

test("code changed after Tester verification returns Review to Test exactly once",async()=>{
 const store=new Store(":memory:"),workspace=new Workspace();workspace.currentHead="new-head";let testerRuns=0,reviewerRuns=0;
 try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,branch,created_at,updated_at,context) VALUES('work-changed',1,'owner/demo','factory/issue-1','now','now',?)").run(JSON.stringify({title:"Review",body:"Check it",cwd:"/tmp/factory-work",verifiedHeads:{TEST:"old-head"}}));
  store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment,approved_by) VALUES('work-changed',1,'SPEC',?,?, 'owner')").run(JSON.stringify([{id:"AC1",description:"Works"}]),JSON.stringify({complexity:"medium",risk:"low",rationale:"standard"}));new WorkflowProjections(store).initialize("work-changed","REVIEW","QUEUED");
  const complete=(role:"qa"|"reviewer")=>({async run(request:AgentRunRequest){if(role==="qa")testerRuns++;else reviewerRuns++;store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);return result("pass");}});
  const runner=new WorkflowRunner(store,{qa:complete("qa"),reviewer:complete("reviewer")},workspace,{ensurePR(){return "unused";}});
  assert.equal(await runner.run("work-changed"),true);assert.deepEqual({stage:new WorkflowProjections(store).get("work-changed").stage,status:new WorkflowProjections(store).get("work-changed").status},{stage:"TEST",status:"QUEUED"});assert.equal(reviewerRuns,0);
  assert.equal(await runner.run("work-changed"),true);assert.equal(testerRuns,1);assert.equal((JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id='work-changed'").get() as {context:string}).context) as {verifiedHeads:Record<string,string>}).verifiedHeads.TEST,"new-head");
  assert.equal(await runner.run("work-changed"),true);assert.equal(reviewerRuns,1);assert.equal(new WorkflowProjections(store).get("work-changed").stage,"DELIVERY");
 }finally{store.db.close();}
});

test('review preparation errors fail the preserved stage once instead of remaining queued forever',async()=>{
 for(const step of ['changeSummary','prepareReviewerContext'] as const){
  const store=new Store(':memory:'),item=new WorkflowIntake(store).start(runnerIssue,{actor:'dashboard',source:'control'}),workspace=new Workspace();
  const adapter=(value:ReturnType<typeof result>):AgentAdapter=>({async run(request){store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);return value;}});
  let reviewerCalls=0;
  const runner=new WorkflowRunner(store,{'product-architect':adapter(result('spec')),developer:adapter(result('pass')),qa:adapter(result('pass')),reviewer:{async run(){reviewerCalls++;return result('pass')}}},workspace,{ensurePR(){return ''}});
  try{
   await runner.run(item.id);new WorkflowCommands(store).apply({kind:'approve',version:1,guidance:''},{workItemId:item.id,login:'owner',commentId:1,specVersion:1});await runner.run(item.id);await runner.run(item.id);
   assert.equal(new WorkflowProjections(store).get(item.id).stage,'REVIEW');
   workspace[step]=()=>{throw new Error('spawnSync git ENOBUFS')};
   assert.equal(await runner.run(item.id),true);const state=new WorkflowProjections(store).get(item.id);assert.equal(state.stage,'REVIEW');assert.equal(state.status,'FAILED');assert.equal(reviewerCalls,0);
   const event=store.db.prepare("SELECT payload FROM events WHERE type='workflow.transition' ORDER BY id DESC LIMIT 1").get() as {payload:string};assert.match(event.payload,/Could not prepare workflow execution: spawnSync git ENOBUFS/);
   assert.equal(await runner.run(item.id),false);
  }finally{store.db.close();}
 }
});

function continuedStore(stage:"REVIEW"|"DELIVERY",status:"QUEUED"|"FAILED",results:Array<{role:"qa"|"reviewer";summary:string}>){
 const source=new Store(":memory:"),target=new Store(":memory:"),identity={id:1,nodeId:"R_1",fullName:"owner/demo"};for(const store of [source,target])store.setMetadata("repository_identity",identity);const item=new WorkflowIntake(source).start(runnerIssue,{actor:"factory",source:"assignment"});source.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment,approved_by) VALUES(?,?,?,?,?,?)").run(item.id,1,"SPEC",JSON.stringify([{id:"AC1",description:"Works"}]),JSON.stringify({complexity:"medium",risk:"low",rationale:"standard"}),"owner");source.db.prepare("UPDATE work_items SET stage=?,status=?,revision=4,context=json_set(context,'$.verifiedHeads.TEST','abc','$.specMarkers.1','result-run-spec') WHERE id=?").run(stage,status,item.id);for(const entry of results)source.event("agent.result",{role:entry.role,result:result("pass",{summary:entry.summary})},item.id,`run-${entry.role}`);if(status==="FAILED"){const failure=new WorkflowFailures(source).open({workItemId:item.id,class:"integration",message:"temporary delivery failure",stage,attempt:0});source.db.prepare("UPDATE work_items SET active_failure_id=? WHERE id=?").run(failure.id,item.id);}const index=issueStateIndex(source,item.id);adoptIssueState(target,{index,specs:[{kind:"spec",version:1,body:"SPEC",criteria:[{id:"AC1",description:"Works"}],assessment:{complexity:"medium",risk:"low",rationale:"standard"}}]},{issue:runnerIssue});source.db.close();return{store:target,id:item.id,index};
}

test("continued Delivery retry uses published Reviewer evidence and reaches pull request creation",async()=>{
 const continued=continuedStore("DELIVERY","FAILED",[{role:"qa",summary:"Tester passed remotely"},{role:"reviewer",summary:"Reviewer passed remotely"}]),workspace=new Workspace();let pullRequests=0;
 try{new WorkflowCommands(continued.store).apply({kind:"retry",guidance:"",scope:"spec",appliesTo:[]},{workItemId:continued.id,login:"owner",commentId:9,specVersion:1});const runner=new WorkflowRunner(continued.store,{},workspace,{ensurePR(){pullRequests++;return"https://github.com/owner/demo/pull/1";}});assert.equal(await runner.run(continued.id),true);assert.equal(pullRequests,1,JSON.stringify({projection:new WorkflowProjections(continued.store).get(continued.id),failure:new WorkflowFailures(continued.store).active(continued.id),context:JSON.parse((continued.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(continued.id) as {context:string}).context)}));assert.equal(new WorkflowProjections(continued.store).get(continued.id).status,"WAITING");}finally{continued.store.db.close();}
});

test("continued Review includes published Tester evidence in the Reviewer prompt",async()=>{
 const continued=continuedStore("REVIEW","QUEUED",[{role:"qa",summary:"Remote Tester evidence"}]),workspace=new Workspace();let instructions="";
 try{new WorkflowCommands(continued.store).apply({kind:"retry",guidance:"",scope:"spec",appliesTo:[]},{workItemId:continued.id,login:"owner",commentId:9,specVersion:1});const runner=new WorkflowRunner(continued.store,{reviewer:{async run(request){instructions=request.instructions;continued.store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);return result("pass");}}},workspace,{ensurePR(){return"unused";}});await runner.run(continued.id);assert.match(instructions,/Tester execution evidence/);assert.match(instructions,/Remote Tester evidence/);}finally{continued.store.db.close();}
});

test("local agent result takes precedence over adopted evidence for the same role",async()=>{
 const continued=continuedStore("REVIEW","QUEUED",[{role:"qa",summary:"Adopted Tester evidence"}]),workspace=new Workspace();let instructions="";
 try{continued.store.event("agent.result",{role:"qa",result:result("pass",{summary:"Local Tester evidence"})},continued.id,"local-qa");new WorkflowCommands(continued.store).apply({kind:"retry",guidance:"",scope:"spec",appliesTo:[]},{workItemId:continued.id,login:"owner",commentId:9,specVersion:1});const runner=new WorkflowRunner(continued.store,{reviewer:{async run(request){instructions=request.instructions;continued.store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);return result("pass");}}},workspace,{ensurePR(){return"unused";}});await runner.run(continued.id);assert.match(instructions,/Local Tester evidence/);assert.doesNotMatch(instructions,/Adopted Tester evidence/);}finally{continued.store.db.close();}
});

for(const code of [3,0])test(`factory verification exit ${code} controls the Tester pass path`,{skip:spawnSync("sh",["-c","exit 0"]).status!==0},async()=>{
 const store=new Store(":memory:"),item=new WorkflowIntake(store).start(runnerIssue,{actor:"dashboard",source:"control"}),workspace=new Workspace(),previous=config.verifyCommand;
 workspace.ensure=()=>process.cwd();config.verifyCommand=`exit ${code}`;
 const adapter=(value:ReturnType<typeof result>):AgentAdapter=>({async run(request){store.db.prepare("UPDATE executions SET status='succeeded' WHERE id=?").run(request.executionId);return value;}});
 try{
  const runner=new WorkflowRunner(store,{"product-architect":adapter(result("spec")),developer:adapter(result("pass")),qa:adapter(result("pass",{findings:[{classification:"defer",evidence:"Optional follow-up"}]}))},workspace,{ensurePR(){return "unused";}});
  await runner.run(item.id);new WorkflowCommands(store).apply({kind:"approve",version:1,guidance:""},{workItemId:item.id,login:"owner",commentId:1,specVersion:1});await runner.run(item.id);await runner.run(item.id);
  const projection=new WorkflowProjections(store).get(item.id);assert.equal(projection.stage,code?"BUILD":"REVIEW");assert.equal(projection.status,"QUEUED");
  const event=store.db.prepare("SELECT payload,run_id FROM events WHERE type='verification.completed'").get() as {payload:string;run_id:string};assert.equal(JSON.parse(event.payload).exitCode,code);assert.ok(event.run_id);
  const applied=JSON.parse((store.db.prepare("SELECT payload FROM events WHERE type='agent.result' ORDER BY id DESC LIMIT 1").get() as {payload:string}).payload).result;
  assert.equal(applied.outcome,code?"changes":"pass");if(code){assert.equal(applied.findings.length,2);assert.deepEqual(applied.findings[0],{classification:"defer",evidence:"Optional follow-up"});assert.equal(applied.findings[1].classification,"auto-fix");assert.match(applied.findings[1].evidence,/`exit 3` exited 3/);}
  const context=JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id=?").get(item.id) as {context:string}).context);assert.deepEqual(context.verification,{head:"abc",command:`exit ${code}`,exitCode:code});
 }finally{config.verifyCommand=previous;store.db.close();}
});

test("factory verification bounds combined output and times out asynchronously",{skip:spawnSync("sh",["-c","exit 0"]).status!==0},async()=>{
 let ticks=0;const timer=setInterval(()=>ticks++,5);
 try{const evidence=await runVerification({cwd:process.cwd(),command:"printf '%05000d' 0; printf 'error evidence' >&2; sleep 10",timeoutMs:100});assert.equal(evidence.exitCode,null);assert.equal(evidence.outputTail.length,4000);assert.match(evidence.outputTail,/error evidence/);assert.ok(evidence.durationMs>=90);assert.ok(ticks>0);}finally{clearInterval(timer);}
});

test("delivery body summarizes tests and verification while commits describe the change",{skip:spawnSync("sh",["-c","exit 0"]).status!==0},async()=>{
 const previous=config.verifyCommand;
 try{for(const command of [undefined,"exit 0"]){
  config.verifyCommand=command;const store=new Store(":memory:"),item=new WorkflowIntake(store).start(runnerIssue,{actor:"dashboard",source:"control"}),workspace=new Workspace();workspace.ensure=()=>process.cwd();let body="";
  const adapter=(value:ReturnType<typeof result>):AgentAdapter=>({async run(request){store.db.prepare("UPDATE executions SET status='succeeded' WHERE id=?").run(request.executionId);return value;}});
  try{
   const runner=new WorkflowRunner(store,{"product-architect":adapter(result("spec")),developer:adapter(result("pass",{summary:"  Implement the requested behavior\nFurther details"})),qa:adapter(result("pass",{changedFiles:["src/app.ts"]})),reviewer:adapter(result("pass",{summary:"Review confirms the criteria",findings:[{classification:"defer",evidence:"Optional polish"}]}))},workspace,{ensurePR(_branch,_title,value){body=value;return "https://github.com/owner/demo/pull/2";}});
   await runner.run(item.id);new WorkflowCommands(store).apply({kind:"approve",version:1,guidance:""},{workItemId:item.id,login:"owner",commentId:1,specVersion:1});for(let stage=0;stage<4;stage++)await runner.run(item.id);
   assert.equal(new WorkflowProjections(store).get(item.id).stage,"DELIVERY");assert.equal(new WorkflowProjections(store).get(item.id).status,"WAITING");
   assert.equal(workspace.commits[0],"factory(Builder): Implement the requested behavior (#1)");assert.ok(workspace.commits[1].startsWith("factory(Tester):"));
   assert.match(body,/Closes #1/);assert.match(body,/Approved SPEC v1 by owner/);assert.equal(body.match(/^## Summary$/gm)?.length,1);assert.equal(body.match(/^## Tester summary$/gm)?.length,1);assert.match(body,/## Tests[\s\S]*node --test[\s\S]*0/);assert.match(body,/## Acceptance evidence/);assert.match(body,/src\/app.ts/);assert.match(body,/## Deferred findings\n\n- Optional polish/);
   assert.ok(body.includes(command?"Factory verification: `exit 0` exited 0.":"Factory verification: not configured"));assert.ok(!body.includes(result("spec").spec));assert.doesNotMatch(body,/# Verification Engineer.*report|## Next action/);
  }finally{store.db.close();}
 }}finally{config.verifyCommand=previous;}
});

test("Builder receives its changed files only when returning for automatic correction",async()=>{
 const store=new Store(":memory:"),item=new WorkflowIntake(store).start(runnerIssue,{actor:"dashboard",source:"control"}),workspace:WorkspacePort=new Workspace(),prompts:string[]=[];
 const previousVerify=config.verifyCommand,previousMaxCycles=config.maxCycles;config.verifyCommand=undefined;config.maxCycles=3;
 workspace.changeSummary=()=>({files:["src/a.ts"],stat:"1 file changed"});
 const adapter=(value:ReturnType<typeof result>):AgentAdapter=>({async run(request){if(request.role==="developer")prompts.push(request.instructions);store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);return value;}});
 try{
  const runner=new WorkflowRunner(store,{"product-architect":adapter(result("spec")),developer:adapter(result("pass")),qa:adapter(result("changes",{findings:[{classification:"auto-fix",evidence:"Correct the acceptance behavior"}]}))},workspace,{ensurePR(){return "unused";}});
  await runner.run(item.id);new WorkflowCommands(store).apply({kind:"approve",version:1,guidance:""},{workItemId:item.id,login:"owner",commentId:1,specVersion:1});await runner.run(item.id);await runner.run(item.id);
  const projection=new WorkflowProjections(store).get(item.id);assert.equal(projection.stage,"BUILD");assert.equal(projection.status,"QUEUED");assert.equal(projection.attempt,0);assert.equal(projection.correctionCycles,1);
  await runner.run(item.id);assert.equal(prompts.length,2);assert.doesNotMatch(prompts[0],/src\/a\.ts|1 file changed/);assert.match(prompts[1],/src\/a\.ts/);assert.match(prompts[1],/1 file changed/);
 }finally{config.verifyCommand=previousVerify;config.maxCycles=previousMaxCycles;store.db.close();}
});

test("first human Builder retry includes changed files with attempt one",async()=>{
 const store=new Store(":memory:"),item=new WorkflowIntake(store).start(runnerIssue,{actor:"dashboard",source:"control"}),workspace:WorkspacePort=new Workspace(),prompts:string[]=[];
 workspace.changeSummary=()=>({files:["src/a.ts"],stat:"1 file changed"});
 const adapter=(value:ReturnType<typeof result>):AgentAdapter=>({async run(request){if(request.role==="developer")prompts.push(request.instructions);store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);return value;}});
 try{
  const runner=new WorkflowRunner(store,{"product-architect":adapter(result("spec")),developer:adapter(result("pass"))},workspace,{ensurePR(){return "unused";}}),commands=new WorkflowCommands(store),projections=new WorkflowProjections(store);
  await runner.run(item.id);commands.apply({kind:"approve",version:1,guidance:""},{workItemId:item.id,login:"owner",commentId:1,specVersion:1});await runner.run(item.id);
  // Exercise retry from a paused Builder with existing changes and no automatic corrections.
  projections.transition({workItemId:item.id,expectedRevision:projections.get(item.id).revision,stage:"BUILD",status:"PAUSED",actor:{type:"human",id:"owner"},source:{},reason:{code:"test-paused-build",summary:"Paused Builder fixture"}});
  commands.apply({kind:"retry",guidance:"",scope:"spec",appliesTo:[]},{workItemId:item.id,login:"owner",commentId:2,specVersion:1});
  const retried=projections.get(item.id);assert.equal(retried.stage,"BUILD");assert.equal(retried.status,"QUEUED");assert.equal(retried.attempt,1);assert.equal(retried.correctionCycles,0);
  await runner.run(item.id);assert.equal(prompts.length,2);assert.doesNotMatch(prompts[0],/src\/a\.ts/);assert.match(prompts[1],/src\/a\.ts/);assert.match(prompts[1],/1 file changed/);
 }finally{store.db.close();}
});

import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { WorkflowIntake } from "../src/workflow-inbox.js";
import { WorkflowRunner } from "../src/workflow-runner.js";
import { WorkflowProjections } from "../src/workflow-projection.js";
import { WorkflowCommands } from "../src/workflow-commands.js";
import { WorkflowFailures } from "../src/workflow-failures.js";
import { config } from "../src/config.js";
import { result } from "./fixtures.js";
import type { AgentAdapter,AgentRunRequest } from "../src/adapters/agent.js";
import { SyncConflictError,type WorkspacePort } from "../src/worktrees.js";
import { InvalidResultError } from "../src/results.js";

class Workspace implements WorkspacePort {
 commits:string[]=[];cleanupCalls=0;publishCalls=0;pushError:Error|undefined;syncError:Error|undefined;ensure(){return "/tmp/factory-work";}assertBranch(){}sync(){if(this.syncError)throw this.syncError;return{before:"abc",after:"abc",merged:[]};}head(){return "abc";}diff(){return "";}check(){}commit(_cwd:string,message:string){this.commits.push(message);}publish(){this.publishCalls++;}
 async publishAsync(){this.publishCalls++;if(this.pushError)throw this.pushError;}
 changeSummary(){return{files:[],stat:""};}prepareReviewerContext(){return{path:"/tmp/factory-work/.factory-context/review.diff",files:[],stat:""};}cleanupReviewerContext(){this.cleanupCalls++;}
}
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
  assert.deepEqual({stage:new WorkflowProjections(store).get(started.id).stage,status:new WorkflowProjections(store).get(started.id).status},{stage:"TEST",status:"QUEUED"});assert.equal(workspace.commits.length,1);assert.equal(workspace.publishCalls,1);
  assert.equal(requests[1].promptMetadata?.includedRecordIds?.length,0);assert.match(requests[1].instructions,/Approved specification/);
 } finally {store.db.close();}
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

test("protected context overflow fails before invoking a provider",async()=>{
 const store=new Store(":memory:"),started=new WorkflowIntake(store).start(runnerIssue,{actor:"dashboard",source:"control"}),workspace=new Workspace();
 let invoked=false;const previous=config.contextBudget.defaultBytes;config.contextBudget.defaultBytes=10;
 try {
  const runner=new WorkflowRunner(store,{"product-architect":{async run(){invoked=true;return result("spec");}}},workspace,{ensurePR(){throw new Error("unused");}});
  assert.equal(await runner.run(started.id),true);assert.equal(invoked,false);assert.equal(new WorkflowProjections(store).get(started.id).status,"FAILED");assert.equal(new WorkflowFailures(store).active(started.id)?.class,"invalid-context");
 } finally {config.contextBudget.defaultBytes=previous;store.db.close();}
});

test("runner classifies failures by typed result errors rather than message text",async()=>{
 const run=async(error:Error)=>{const store=new Store(":memory:"),started=new WorkflowIntake(store).start(runnerIssue,{actor:"dashboard",source:"control"});try{const runner=new WorkflowRunner(store,{"product-architect":{async run(){throw error;}}},new Workspace(),{ensurePR(){throw new Error("unused");}});await runner.run(started.id);return new WorkflowFailures(store).active(started.id)?.class;}finally{store.db.close();}};
 assert.equal(await run(new Error("provider result channel disconnected")),"execution");
 assert.equal(await run(new InvalidResultError("invalid structured output")),"invalid-result");
});

test("reviewer context is cleaned when maintenance blocks scheduler begin",async()=>{
 const store=new Store(":memory:"),workspace=new Workspace();
 try {
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,branch,created_at,updated_at,context) VALUES('work-review',1,'owner/demo','factory/review','now','now',?)").run(JSON.stringify({title:"Review",body:"Check it",cwd:"/tmp/factory-work"}));
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
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,branch,created_at,updated_at,context) VALUES('work-review',1,'owner/demo','factory/review','now','now',?)").run(JSON.stringify({title:"Review",body:"Check it",cwd:"/tmp/factory-work"}));
  store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment,approved_by) VALUES('work-review',1,'SPEC',?,?, 'owner')").run(JSON.stringify([{id:"AC1",description:"Works"}]),JSON.stringify({complexity:"medium",risk:"low",rationale:"standard"}));
  new WorkflowProjections(store).initialize("work-review","REVIEW","QUEUED");
  const runner=new WorkflowRunner(store,{reviewer:{async run(request){reviewerRuns++;store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);return result("pass");}}},workspace,{ensurePR(){prAttempts++;if(failPublication)throw new Error("Pull request create failed: Base ref must be a branch");return "https://github.com/owner/demo/pull/1";}});
  assert.equal(await runner.run("work-review"),true);assert.deepEqual({stage:new WorkflowProjections(store).get("work-review").stage,status:new WorkflowProjections(store).get("work-review").status},{stage:"DELIVERY",status:"QUEUED"});assert.equal(reviewerRuns,1);assert.equal(workspace.publishCalls,0);
  assert.equal(await runner.run("work-review"),true);assert.equal(new WorkflowProjections(store).get("work-review").status,"FAILED");assert.equal(new WorkflowFailures(store).active("work-review")?.class,"integration");assert.equal(reviewerRuns,1);assert.equal(prAttempts,1);
  new WorkflowCommands(store).apply({kind:"retry",guidance:"",scope:"spec",appliesTo:[]},{workItemId:"work-review",login:"owner",commentId:9,specVersion:1});failPublication=false;
  assert.equal(await runner.run("work-review"),true);assert.deepEqual({stage:new WorkflowProjections(store).get("work-review").stage,status:new WorkflowProjections(store).get("work-review").status},{stage:"DELIVERY",status:"WAITING"});assert.equal(reviewerRuns,1);assert.equal(prAttempts,2);assert.equal(workspace.publishCalls,2);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM executions WHERE work_item_id='work-review'").get() as {count:number}).count,1);
 } finally {store.db.close();}
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

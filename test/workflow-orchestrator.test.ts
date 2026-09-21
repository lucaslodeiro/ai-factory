import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { WorkflowOrchestrator } from "../src/workflow-orchestrator.js";
import { WorkflowRunner } from "../src/workflow-runner.js";
import { WorkflowProjections } from "../src/workflow-projection.js";
import { config } from "../src/config.js";
import { result } from "./fixtures.js";
import type { AgentAdapter } from "../src/adapters/agent.js";
import type { WorkspacePort } from "../src/worktrees.js";
import type { Comment,Issue,PullRequestState } from "../src/adapters/github.js";

class Workspace implements WorkspacePort {ensure(){return "/tmp/v3-work";}assertBranch(){}sync(){return{before:"head",after:"head",merged:[]};}head(){return "head";}diff(){return "";}check(){}commit(){}publish(){}changeSummary(){return{files:[],stat:""};}prepareReviewerContext(){return{path:"/tmp/v3-work/.factory-context/review.diff",files:[],stat:""};}cleanupReviewerContext(){}}
class GitHub {
 commentsByIssue=new Map<number,Comment[]>();statusBodies:string[]=[];resultBodies:string[]=[];labels:string[][]=[];issueLabels:Array<{name:string}>=[];assigned=true;labelEdits:string[]=[];lastPrBody="";state:"OPEN"|"CLOSED"="OPEN";issueId=100;issueCalls=0;title="Ship V3";body="Complete the workflow";updatedAt="2026-09-20T00:00:00Z";author={login:"owner",type:"User"};discoverIssues=false;pr:PullRequestState={state:"OPEN",mergedAt:null,mergeCommit:null};
 issue(n:number):Issue{this.issueCalls++;return {id:this.issueId,nodeId:`I_${this.issueId}`,number:n,title:this.title,body:this.body,url:`https://github.com/owner/demo/issues/${n}`,state:this.state,labels:this.issueLabels,createdAt:"2026-09-20T00:00:00Z",updatedAt:this.updatedAt,author:this.author};}
 comments(n:number){return this.commentsByIssue.get(n)??[];}authenticatedLogin(){return "factory";}assignedIssues(){return this.assigned?[this.issue(1)]:[];}ensureLabel(){}addLabel(_n:number,name:string){this.labelEdits.push(name);this.issueLabels.push({name});}removeLabel(_n:number,name:string){this.issueLabels=this.issueLabels.filter(label=>label.name!==name);}replaceInstanceLabel(){}
 commentOnce(){}syncState(){}ensurePR(_branch:string,_title:string,body:string){this.lastPrBody=body;return "https://github.com/owner/demo/pull/1";}pullRequestState(){return this.pr;}
 repository(){return{id:1,nodeId:"R_1",fullName:"owner/demo",defaultBranch:"main"};}
 assignees(){return [];}assign(){}unassign(){}
 syncWorkflow(_issue:number,labels:Array<{name:string}>,body:string){this.labels.push(labels.map(label=>label.name));this.statusBodies.push(body);this.advanceIssueUpdatedAt();}
 publishWorkflowComment(_issue:number,_key:string,body:string){this.resultBodies.push(body);this.advanceIssueUpdatedAt();}
 reply(id:number,body:string){const rows=this.commentsByIssue.get(1)??[];rows.push({id,body,user:{login:"owner",type:"User"},updatedAt:`2026-09-20T00:00:${String(id).padStart(2,"0")}Z`});this.commentsByIssue.set(1,rows);}
 private advanceIssueUpdatedAt(){this.updatedAt=new Date(Date.parse(this.updatedAt)+1000).toISOString();}
}

test("V3 orchestrator completes Design, Build, Test, Review and merge with one authoritative CTA",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");
 const store=new Store(":memory:"),github=new GitHub(),workspace=new Workspace();
 const adapter=(role:string):AgentAdapter=>({async run(request){store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);return role==="architect"?result("spec"):result("pass");}});
 const runner=new WorkflowRunner(store,{"product-architect":adapter("architect"),developer:adapter("builder"),qa:adapter("tester"),reviewer:adapter("reviewer")},workspace,github);
 const orchestrator=new WorkflowOrchestrator(store,github,runner,{enabled:false,async notify(){}});
 try {
  const started=await orchestrator.startIssue("1","Dashboard");assert.equal(started.created,true);
  await orchestrator.tick();let projection=new WorkflowProjections(store).get(started.id);assert.deepEqual({stage:projection.stage,status:projection.status},{stage:"DESIGN",status:"WAITING"});assert.match(github.resultBodies.at(-1)!,/^# Specification v1/m);assert.match(github.resultBodies.at(-1)!,/## Next action/);
  assert.equal(github.statusBodies.at(-1)?.match(/^## Next action$/gm)?.length,1);assert.match(github.statusBodies.at(-1)!,/\/factory approve v1/);
  github.reply(1,"/factory approve v1");await orchestrator.tick();projection=new WorkflowProjections(store).get(started.id);assert.deepEqual({stage:projection.stage,status:projection.status},{stage:"TEST",status:"QUEUED"});
  await orchestrator.tick();assert.equal(new WorkflowProjections(store).get(started.id).stage,"REVIEW");
  await orchestrator.runLocal();await orchestrator.runLocal();await orchestrator.flush();projection=new WorkflowProjections(store).get(started.id);assert.deepEqual({stage:projection.stage,status:projection.status},{stage:"DELIVERY",status:"WAITING"});assert.match(github.statusBodies.at(-1)!,/Review and merge/);assert.deepEqual(github.labels.at(-1),["factory:delivery","factory:waiting"]);assert.match(github.lastPrBody,/^Closes #1$/m);
  github.pr={state:"MERGED",mergedAt:"2026-09-19T20:00:00Z",mergeCommit:{oid:"abc"}};await orchestrator.tick();projection=new WorkflowProjections(store).get(started.id);assert.equal(projection.status,"COMPLETED");assert.deepEqual(github.labels.at(-1),["factory:done"]);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM executions WHERE status='succeeded'").get() as {count:number}).count,4);
 } finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

test("closed issues disappear operationally and reopen paused past closed-period comments",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");
 const store=new Store(":memory:"),github=new GitHub(),runner=new WorkflowRunner(store,{},new Workspace(),github),orchestrator=new WorkflowOrchestrator(store,github,runner,{enabled:false,async notify(){}});
 try {
  const started=await orchestrator.startIssue("1");github.state="CLOSED";await orchestrator.tick();let row=store.db.prepare("SELECT archived_at,status FROM work_items WHERE id=?").get(started.id) as {archived_at:string|null;status:string};assert.ok(row.archived_at);assert.equal(row.status,"PAUSED");
  github.reply(20,"/factory retry");github.state="OPEN";await orchestrator.tick();row=store.db.prepare("SELECT archived_at,status FROM work_items WHERE id=?").get(started.id) as {archived_at:string|null;status:string};assert.equal(row.archived_at,null);assert.equal(row.status,"PAUSED");
  const context=JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id=?").get(started.id) as {context:string}).context);assert.equal(context.cursor,20);assert.equal(github.statusBodies.at(-1)?.match(/^## Next action$/gm)?.length,1);
 } finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

test("dashboard start snapshots historical comments instead of replaying commands",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");
 const store=new Store(":memory:"),github=new GitHub(),runner=new WorkflowRunner(store,{},new Workspace(),github),orchestrator=new WorkflowOrchestrator(store,github,runner,{enabled:false,async notify(){}});
 try {
  github.reply(1,"/factory cancel");
  const started=await orchestrator.startIssue("1","Dashboard");
  await assert.rejects(orchestrator.tick(),/No adapter configured/);
  const projection=new WorkflowProjections(store).get(started.id);
  assert.deepEqual({stage:projection.stage,status:projection.status},{stage:"DESIGN",status:"QUEUED"});
 } finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

test("a replaced GitHub issue archives stale work without publishing and can start a distinct item",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");
 const store=new Store(":memory:"),github=new GitHub(),runner=new WorkflowRunner(store,{},new Workspace(),github),orchestrator=new WorkflowOrchestrator(store,github,runner,{enabled:false,async notify(){}});
 try {
  const old=await orchestrator.startIssue("1");github.issueId=200;
  const refreshed=await orchestrator.refreshIssueList(),stale=store.db.prepare("SELECT archived_at,status FROM work_items WHERE id=?").get(old.id) as {archived_at:string|null;status:string};
  assert.ok(stale.archived_at);assert.equal(stale.status,"PAUSED");assert.deepEqual(refreshed,{found:0,added:0,updated:0});assert.equal(github.statusBodies.length,0);assert.equal(github.resultBodies.length,0);
  const event=JSON.parse((store.db.prepare("SELECT payload FROM events WHERE type='github.issue_replaced'").get() as {payload:string}).payload);assert.deepEqual(event,{issue:1,previousIssueId:100,currentIssueId:200});
  const replacement=await orchestrator.startIssue("1");assert.equal(replacement.created,true);assert.notEqual(replacement.id,old.id);
  assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items WHERE issue_number=1").get() as {count:number}).count,2);
 } finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

test("visibility reconciliation refreshes issue content and presents only title changes",async()=>{
 const previousRepo=config.repo;config.repo="owner/demo";const store=new Store(":memory:"),github=new GitHub(),orchestrator=new WorkflowOrchestrator(store,github,new WorkflowRunner(store,{},new Workspace(),github),{enabled:false,async notify(){}});
 try {
  const started=await orchestrator.startIssue("1"),before=new WorkflowProjections(store).get(started.id).presentationRevision;
  github.body="Updated body";await orchestrator.refreshIssueList();let context=JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id=?").get(started.id) as {context:string}).context);assert.equal(context.body,"Updated body");assert.equal(new WorkflowProjections(store).get(started.id).presentationRevision,before);
  github.title="Updated title";await orchestrator.refreshIssueList();context=JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id=?").get(started.id) as {context:string}).context);assert.equal(context.title,"Updated title");assert.equal(new WorkflowProjections(store).get(started.id).presentationRevision,before+1);
  const writes=(store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='workflow.presentation'").get() as {count:number}).count;await orchestrator.refreshIssueList();assert.equal((store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='workflow.presentation'").get() as {count:number}).count,writes);
 } finally {store.db.close();config.repo=previousRepo;}
});

test("assignment claim waits one poll, then starts; conflicts and foreign status wait",async()=>{
 const previousRepo=config.repo,previousInstance=config.instanceName;config.repo="owner/demo";config.instanceName="local";
 const store=new Store(":memory:"),github=new GitHub(),orchestrator=new WorkflowOrchestrator(store,github,new WorkflowRunner(store,{},new Workspace(),github),{enabled:false,async notify(){}});store.setMetadata("runtime:factory-account","factory");
 try{
  await orchestrator.syncRemote();assert.deepEqual(github.labelEdits,["factory-instance:local"]);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,0);
  await orchestrator.syncRemote();assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,1);
  const conflictStore=new Store(":memory:"),conflictGitHub=new GitHub();conflictGitHub.issueLabels=[{name:"factory-instance:local"},{name:"factory-instance:other"}];conflictStore.setMetadata("runtime:factory-account","factory");const conflict=new WorkflowOrchestrator(conflictStore,conflictGitHub,new WorkflowRunner(conflictStore,{},new Workspace(),conflictGitHub),{enabled:false,async notify(){}});await conflict.syncRemote();await conflict.syncRemote();assert.equal((conflictStore.db.prepare("SELECT COUNT(*) count FROM events WHERE type='issue.claim_conflict'").get() as {count:number}).count,1);assert.equal((conflictStore.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,0);conflictStore.db.close();
  const pendingStore=new Store(":memory:"),pendingGitHub=new GitHub();pendingGitHub.issueLabels=[{name:"factory-instance:local"}];pendingGitHub.reply(4,"status\n<!-- ai-factory:workflow-status:owner/demo:1 -->");pendingStore.setMetadata("runtime:factory-account","factory");const pending=new WorkflowOrchestrator(pendingStore,pendingGitHub,new WorkflowRunner(pendingStore,{},new Workspace(),pendingGitHub),{enabled:false,async notify(){}});await pending.syncRemote();await pending.syncRemote();assert.equal((pendingStore.db.prepare("SELECT COUNT(*) count FROM events WHERE type='issue.continuation_pending'").get() as {count:number}).count,1);assert.equal((pendingStore.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,0);pendingStore.db.close();
 }finally{store.db.close();config.repo=previousRepo;config.instanceName=previousInstance;}
});

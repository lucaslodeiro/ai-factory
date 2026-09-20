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
import type { Comment,Issue,PullRequestState,RepositoryComment } from "../src/adapters/github.js";

class Workspace implements WorkspacePort {ensure(){return "/tmp/v3-work";}assertBranch(){}head(){return "head";}diff(){return "";}check(){}commit(){}publish(){}changeSummary(){return{files:[],stat:""};}prepareReviewerContext(){return{path:"/tmp/v3-work/.factory-context/review.diff",files:[],stat:""};}cleanupReviewerContext(){}}
class GitHub {
 commentsByIssue=new Map<number,Comment[]>();statusBodies:string[]=[];resultBodies:string[]=[];labels:string[][]=[];lastPrBody="";state:"OPEN"|"CLOSED"="OPEN";issueId=100;title="Ship V3";body="Complete the workflow";updatedAt="2026-09-20T00:00:00Z";author={login:"owner",type:"User"};discoverIssues=false;pr:PullRequestState={state:"OPEN",mergedAt:null,mergeCommit:null};
 issue(n:number):Issue{return {id:this.issueId,nodeId:`I_${this.issueId}`,number:n,title:this.title,body:this.body,url:`https://github.com/owner/demo/issues/${n}`,state:this.state,createdAt:"2026-09-20T00:00:00Z",updatedAt:this.updatedAt,author:this.author};}
 repositoryCommentRows:RepositoryComment[]=[];comments(n:number){return this.commentsByIssue.get(n)??[];}repositoryComments(_since:string):RepositoryComment[]{return this.repositoryCommentRows;}
 repositoryIssues(_since:string){return this.discoverIssues?[this.issue(1)]:[];}
 listManaged(){return [];}commentOnce(){}syncState(){}ensurePR(_branch:string,_title:string,body:string){this.lastPrBody=body;return "https://github.com/owner/demo/pull/1";}pullRequestState(){return this.pr;}
 repository(){return{id:1,nodeId:"R_1",fullName:"owner/demo",defaultBranch:"main"};}
 syncWorkflow(_issue:number,labels:Array<{name:string}>,body:string){this.labels.push(labels.map(label=>label.name));this.statusBodies.push(body);}
 publishWorkflowComment(_issue:number,_key:string,body:string){this.resultBodies.push(body);}
 reply(id:number,body:string){const rows=this.commentsByIssue.get(1)??[];rows.push({id,body,user:{login:"owner",type:"User"},updatedAt:`2026-09-20T00:00:${String(id).padStart(2,"0")}Z`});this.commentsByIssue.set(1,rows);}
}

test("V3 orchestrator completes Design, Build, Test, Review and merge with one authoritative CTA",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");
 const store=new Store(":memory:"),github=new GitHub(),workspace=new Workspace();
 const adapter=(role:string):AgentAdapter=>({async run(request){store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now' WHERE id=?").run(request.executionId);return role==="architect"?result("spec"):result("pass");}});
 const runner=new WorkflowRunner(store,{"product-architect":adapter("architect"),developer:adapter("builder"),qa:adapter("tester"),reviewer:adapter("reviewer")},workspace,github);
 const orchestrator=new WorkflowOrchestrator(store,github,runner,{enabled:false,async notify(){}});
 try {
  const started=orchestrator.startIssue("1","Dashboard");assert.equal(started.created,true);
  await orchestrator.tick();let projection=new WorkflowProjections(store).get(started.id);assert.deepEqual({stage:projection.stage,status:projection.status},{stage:"DESIGN",status:"WAITING"});assert.match(github.resultBodies.at(-1)!,/^# Specification v1/m);assert.match(github.resultBodies.at(-1)!,/## Next action/);
  assert.equal(github.statusBodies.at(-1)?.match(/^## Next action$/gm)?.length,1);assert.match(github.statusBodies.at(-1)!,/\/factory approve v1/);
  github.reply(1,"/factory approve v1");await orchestrator.tick();projection=new WorkflowProjections(store).get(started.id);assert.deepEqual({stage:projection.stage,status:projection.status},{stage:"TEST",status:"QUEUED"});
  await orchestrator.tick();assert.equal(new WorkflowProjections(store).get(started.id).stage,"REVIEW");
  await orchestrator.tick();projection=new WorkflowProjections(store).get(started.id);assert.deepEqual({stage:projection.stage,status:projection.status},{stage:"DELIVERY",status:"WAITING"});assert.match(github.statusBodies.at(-1)!,/Review and merge/);assert.deepEqual(github.labels.at(-1),["factory:delivery","factory:waiting"]);assert.match(github.lastPrBody,/^Closes #1$/m);
  github.pr={state:"MERGED",mergedAt:"2026-09-19T20:00:00Z",mergeCommit:{oid:"abc"}};await orchestrator.tick();projection=new WorkflowProjections(store).get(started.id);assert.equal(projection.status,"COMPLETED");assert.deepEqual(github.labels.at(-1),["factory:done"]);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM executions WHERE status='succeeded'").get() as {count:number}).count,4);
 } finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

test("closed issues disappear operationally and reopen paused past closed-period comments",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");
 const store=new Store(":memory:"),github=new GitHub(),runner=new WorkflowRunner(store,{},new Workspace(),github),orchestrator=new WorkflowOrchestrator(store,github,runner,{enabled:false,async notify(){}});
 try {
  const started=orchestrator.startIssue("1");github.state="CLOSED";await orchestrator.tick();let row=store.db.prepare("SELECT archived_at,status FROM work_items WHERE id=?").get(started.id) as {archived_at:string|null;status:string};assert.ok(row.archived_at);assert.equal(row.status,"PAUSED");
  github.reply(20,"/factory retry");github.state="OPEN";await orchestrator.tick();row=store.db.prepare("SELECT archived_at,status FROM work_items WHERE id=?").get(started.id) as {archived_at:string|null;status:string};assert.equal(row.archived_at,null);assert.equal(row.status,"PAUSED");
  const context=JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id=?").get(started.id) as {context:string}).context);assert.equal(context.cursor,20);assert.equal(github.statusBodies.at(-1)?.match(/^## Next action$/gm)?.length,1);
 } finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

test("dashboard start snapshots historical comments instead of replaying commands",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");
 const store=new Store(":memory:"),github=new GitHub(),runner=new WorkflowRunner(store,{},new Workspace(),github),orchestrator=new WorkflowOrchestrator(store,github,runner,{enabled:false,async notify(){}});
 try {
  github.reply(1,"/factory cancel");
  const started=orchestrator.startIssue("1","Dashboard");
  await assert.rejects(orchestrator.tick(),/No adapter configured/);
  const projection=new WorkflowProjections(store).get(started.id);
  assert.deepEqual({stage:projection.stage,status:projection.status},{stage:"DESIGN",status:"QUEUED"});
 } finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

test("a replaced GitHub issue archives stale work without publishing and can start a distinct item",()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");
 const store=new Store(":memory:"),github=new GitHub(),runner=new WorkflowRunner(store,{},new Workspace(),github),orchestrator=new WorkflowOrchestrator(store,github,runner,{enabled:false,async notify(){}});
 try {
  const old=orchestrator.startIssue("1");github.issueId=200;
  const refreshed=orchestrator.refreshIssueList(),stale=store.db.prepare("SELECT archived_at,status FROM work_items WHERE id=?").get(old.id) as {archived_at:string|null;status:string};
  assert.ok(stale.archived_at);assert.equal(stale.status,"PAUSED");assert.deepEqual(refreshed,{found:0,added:0,updated:0});assert.equal(github.statusBodies.length,0);assert.equal(github.resultBodies.length,0);
  const event=JSON.parse((store.db.prepare("SELECT payload FROM events WHERE type='github.issue_replaced'").get() as {payload:string}).payload);assert.deepEqual(event,{issue:1,previousIssueId:100,currentIssueId:200});
  const replacement=orchestrator.startIssue("1");assert.equal(replacement.created,true);assert.notEqual(replacement.id,old.id);
  assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items WHERE issue_number=1").get() as {count:number}).count,2);
 } finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

test("visibility reconciliation refreshes issue content and presents only title changes",()=>{
 const previousRepo=config.repo;config.repo="owner/demo";const store=new Store(":memory:"),github=new GitHub(),orchestrator=new WorkflowOrchestrator(store,github,new WorkflowRunner(store,{},new Workspace(),github),{enabled:false,async notify(){}});
 try {
  const started=orchestrator.startIssue("1"),before=new WorkflowProjections(store).get(started.id).presentationRevision;
  github.body="Updated body";orchestrator.refreshIssueList();let context=JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id=?").get(started.id) as {context:string}).context);assert.equal(context.body,"Updated body");assert.equal(new WorkflowProjections(store).get(started.id).presentationRevision,before);
  github.title="Updated title";orchestrator.refreshIssueList();context=JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id=?").get(started.id) as {context:string}).context);assert.equal(context.title,"Updated title");assert.equal(new WorkflowProjections(store).get(started.id).presentationRevision,before+1);
  const writes=(store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='workflow.presentation'").get() as {count:number}).count;orchestrator.refreshIssueList();assert.equal((store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='workflow.presentation'").get() as {count:number}).count,writes);
 } finally {store.db.close();config.repo=previousRepo;}
});

test("an approver-authored description start is discovered once with guidance and a comment snapshot",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");const store=new Store(":memory:"),github=new GitHub();github.discoverIssues=true;github.body="Keep dependencies small\n/factory start";github.reply(9,"historical");const orchestrator=new WorkflowOrchestrator(store,github,new WorkflowRunner(store,{},new Workspace(),github),{enabled:false,async notify(){}});
 try {await assert.rejects(orchestrator.tick(),/No adapter configured/);const row=store.db.prepare("SELECT id,context FROM work_items").get() as {id:string;context:string},context=JSON.parse(row.context);assert.equal(context.cursor,9);assert.equal((store.db.prepare("SELECT json_extract(payload,'$.text') text FROM records WHERE kind='instruction'").get() as {text:string}).text,"Keep dependencies small");await assert.rejects(orchestrator.tick(),/No adapter configured/);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,1);}
 finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

test("description discovery audits non-approvers without public feedback and picks up a valid edit",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");const store=new Store(":memory:"),github=new GitHub();github.discoverIssues=true;github.author={login:"outsider",type:"User"};github.body="/factory start";const orchestrator=new WorkflowOrchestrator(store,github,new WorkflowRunner(store,{},new Workspace(),github),{enabled:false,async notify(){}});
 try {await orchestrator.tick();assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,0);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='command.rejected'").get() as {count:number}).count,1);assert.equal(github.resultBodies.length,0);github.author={login:"owner",type:"User"};github.updatedAt="2026-09-20T00:01:00Z";await assert.rejects(orchestrator.tick(),/No adapter configured/);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,1);}
 finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

test("misplaced approver starts in comments and descriptions receive one idempotent hint",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");const store=new Store(":memory:"),github=new GitHub();github.discoverIssues=true;github.body="Please start\n/factory start\nThanks";github.repositoryCommentRows=[{id:33,body:"> /factory start",user:{login:"owner",type:"User"},updatedAt:"2026-09-20T00:00:33Z",issueUrl:"https://api.github.com/repos/owner/demo/issues/1",createdAt:"2026-09-20T00:00:33Z",issue_url:"https://api.github.com/repos/owner/demo/issues/1",created_at:"2026-09-20T00:00:33Z",updated_at:"2026-09-20T00:00:33Z"}];const orchestrator=new WorkflowOrchestrator(store,github,new WorkflowRunner(store,{},new Workspace(),github),{enabled:false,async notify(){}});
 try {await orchestrator.tick();assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,0);assert.equal(github.resultBodies.length,2);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='command.rejected'").get() as {count:number}).count,2);await orchestrator.tick();assert.equal(github.resultBodies.length,2);github.body="Please start\n/factory start";github.updatedAt="2026-09-20T00:01:00Z";await assert.rejects(orchestrator.tick(),/No adapter configured/);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,1);assert.equal(github.resultBodies.length,2);}
 finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

test("an untracked typo comment can be edited into start exactly once",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");const store=new Store(":memory:"),github=new GitHub(),row={id:44,body:"/fatcory start",user:{login:"owner",type:"User"},updatedAt:"2026-09-20T00:00:44Z",issueUrl:"https://api.github.com/repos/owner/demo/issues/1",createdAt:"2026-09-20T00:00:44Z",issue_url:"https://api.github.com/repos/owner/demo/issues/1",created_at:"2026-09-20T00:00:44Z",updated_at:"2026-09-20T00:00:44Z"};github.repositoryCommentRows=[row];const orchestrator=new WorkflowOrchestrator(store,github,new WorkflowRunner(store,{},new Workspace(),github),{enabled:false,async notify(){}});
 try {await orchestrator.tick();assert.equal(github.resultBodies.length,1);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,0);row.body="/factory start";row.updatedAt=row.updated_at="2026-09-20T00:01:44Z";await assert.rejects(orchestrator.tick(),/No adapter configured/);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,1);row.updatedAt=row.updated_at="2026-09-20T00:02:44Z";await assert.rejects(orchestrator.tick(),/No adapter configured/);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,1);}
 finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

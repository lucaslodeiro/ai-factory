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

class Workspace implements WorkspacePort {integrations:string[]=[];integrate(_cwd:string,branch:string,storyBranch:string){this.integrations.push(`${storyBranch}->${branch}`);return `merge-${this.integrations.length}`;}ensure(){return "/tmp/v3-work";}assertBranch(){}sync(){return{before:"head",after:"head",merged:[]};}head(){return "head";}diff(){return "";}check(){}commit(){}publish(){}changeSummary(){return{files:[],stat:""};}prepareReviewerContext(){return{path:"/tmp/v3-work/.factory-context/review.diff",files:[],stat:""};}cleanupReviewerContext(){}}
class GitHub {
 // Story relationships: sub-issues of an epic and the issues a story is blocked by, kept as ids.
 issues=new Map<number,Issue>();subIssuesByParent=new Map<number,number[]>();blockedByIssue=new Map<number,number[]>();closed:Array<{number:number;reason:string}>=[];nextIssueNumber=10;nextIssueId=1000;
 createIssue(input:{title:string;body:string;parentIssueId:number}):Issue{const number=this.nextIssueNumber++,id=this.nextIssueId++,issue:Issue={id,nodeId:`I_${id}`,number,title:input.title,body:input.body,url:`https://github.com/owner/demo/issues/${number}`,state:"OPEN",stateReason:null,labels:[],createdAt:"2026-09-23T00:00:00Z",updatedAt:"2026-09-23T00:00:00Z",author:{login:"factory",type:"User"}};this.issues.set(number,issue);const parent=[...this.issues.values()].find(candidate=>candidate.id===input.parentIssueId)?.number??1;this.subIssuesByParent.set(parent,[...(this.subIssuesByParent.get(parent)??[]),number]);return issue;}
 subIssues(n:number):Issue[]{return (this.subIssuesByParent.get(n)??[]).map(number=>this.issues.get(number)!);}
 blockedBy(n:number):Issue[]{return (this.blockedByIssue.get(n)??[]).map(id=>[...this.issues.values()].find(issue=>issue.id===id)!);}
 addBlockedBy(n:number,issueId:number){this.blockedByIssue.set(n,[...(this.blockedByIssue.get(n)??[]),issueId]);}
 closeIssue(n:number,reason:"completed"|"not planned"){this.closed.push({number:n,reason});const issue=this.issues.get(n);if(issue){issue.state="CLOSED";issue.stateReason=reason==="completed"?"completed":"not_planned";}}
 commentsByIssue=new Map<number,Comment[]>();statusBodies:string[]=[];resultBodies:string[]=[];labels:string[][]=[];issueLabels:Array<{name:string}>=[{name:`factory-instance:${config.instanceName}`}];assigned=true;deleted=false;labelEdits:string[]=[];removedLabels:string[]=[];unassigned:string[]=[];lastPrBody="";state:"OPEN"|"CLOSED"="OPEN";issueId=100;issueCalls=0;title="Ship V3";body="Complete the workflow";updatedAt="2026-09-20T00:00:00Z";author={login:"owner",type:"User"};discoverIssues=false;pr:PullRequestState={state:"OPEN",mergedAt:null,mergeCommit:null};
 issue(n:number):Issue{this.issueCalls++;if(this.deleted)throw new Error("HTTP 410: Gone");const story=this.issues.get(n);if(story)return story;return {id:this.issueId,nodeId:`I_${this.issueId}`,number:n,title:this.title,body:this.body,url:`https://github.com/owner/demo/issues/${n}`,state:this.state,labels:this.issueLabels,createdAt:"2026-09-20T00:00:00Z",updatedAt:this.updatedAt,author:this.author};}
 comments(n:number){if(this.deleted)throw new Error("HTTP 410: Gone");return this.commentsByIssue.get(n)??[];}authenticatedLogin(){return "factory";}assignedIssues(){return this.assigned&&this.state==="OPEN"&&!this.deleted?[this.issue(1)]:[];}ensureLabel(){}addLabel(_n:number,name:string){this.labelEdits.push(name);this.issueLabels.push({name});}removeLabel(_n:number,name:string){this.removedLabels.push(name);this.issueLabels=this.issueLabels.filter(label=>label.name!==name);}replaceInstanceLabel(_n:number,name:string){this.issueLabels=this.issueLabels.filter(label=>!label.name.startsWith("factory-instance:"));this.issueLabels.push({name});}
 commentOnce(){}syncState(){}ensurePR(_branch:string,_title:string,body:string){this.lastPrBody=body;return "https://github.com/owner/demo/pull/1";}pullRequestState(){return this.pr;}
 repository(){return{id:1,nodeId:"R_1",fullName:"owner/demo",defaultBranch:"main"};}
 assignees(){return [];}assign(){}unassign(_n:number,logins:string[]){if(this.deleted)throw new Error("GraphQL: Could not resolve to an issue or pull request with the number of 1. (repository.issue)");this.unassigned.push(...logins);}
 statusByIssue=new Map<number,string>();
 syncWorkflow(issue:number,labels:Array<{name:string}>,body:string){this.labels.push(labels.map(label=>label.name));this.statusBodies.push(body);this.statusByIssue.set(issue,body);this.advanceIssueUpdatedAt();}
 publishWorkflowComment(_issue:number,_key:string,body:string){this.resultBodies.push(body);this.advanceIssueUpdatedAt();}
 reply(id:number,body:string){const rows=this.commentsByIssue.get(1)??[];rows.push({id,body,user:{login:"owner",type:"User"},updatedAt:`2026-09-20T00:00:${String(id).padStart(2,"0")}Z`});this.commentsByIssue.set(1,rows);}
 private advanceIssueUpdatedAt(){this.updatedAt=new Date(Date.parse(this.updatedAt)+1000).toISOString();}
}

async function startAssigned(orchestrator:WorkflowOrchestrator,store:Store){store.setMetadata("repository_identity",{id:1,nodeId:"R_1",fullName:"owner/demo"});await orchestrator.startIssue("1");await orchestrator.syncRemote();const row=store.db.prepare("SELECT id,stage,status FROM work_items WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT 1").get() as {id:string;stage:string;status:string};return{issue:1,id:row.id,created:true,stage:row.stage,status:row.status};}

test("V3 orchestrator completes Design, Build, Test, Review and merge with one authoritative CTA",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");
 const store=new Store(":memory:"),github=new GitHub(),workspace=new Workspace();
 const adapter=(role:string):AgentAdapter=>({async run(request){store.db.prepare("UPDATE executions SET status='succeeded',total_tokens=1000,finished_at='now' WHERE id=?").run(request.executionId);return role==="architect"?result("spec"):result("pass");}});
 const runner=new WorkflowRunner(store,{"product-architect":adapter("architect"),developer:adapter("builder"),qa:adapter("tester"),reviewer:adapter("reviewer")},workspace,github);
 const orchestrator=new WorkflowOrchestrator(store,github,runner,{enabled:false,async notify(){}});
 try {
  const started=await startAssigned(orchestrator,store);assert.equal(started.created,true);
  await orchestrator.tick();let projection=new WorkflowProjections(store).get(started.id);assert.deepEqual({stage:projection.stage,status:projection.status},{stage:"DESIGN",status:"WAITING"});assert.match(github.resultBodies.at(-1)!,/^# Brief v1/m);assert.match(github.resultBodies.at(-1)!,/## Next action/);
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
  const started=await startAssigned(orchestrator,store);github.state="CLOSED";await orchestrator.tick();let row=store.db.prepare("SELECT archived_at,status FROM work_items WHERE id=?").get(started.id) as {archived_at:string|null;status:string};assert.ok(row.archived_at);assert.equal(row.status,"PAUSED");
  github.reply(20,"/factory retry");github.state="OPEN";await orchestrator.tick();row=store.db.prepare("SELECT archived_at,status FROM work_items WHERE id=?").get(started.id) as {archived_at:string|null;status:string};assert.equal(row.archived_at,null);assert.equal(row.status,"PAUSED");
  const context=JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id=?").get(started.id) as {context:string}).context);assert.equal(context.cursor,20);assert.equal(github.statusBodies.at(-1)?.match(/^## Next action$/gm)?.length,1);
 } finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

test("deleted issues are archived locally without turning GitHub polling into a failure",async()=>{
 const previousRepo=config.repo;config.repo="owner/demo";
 const store=new Store(":memory:"),github=new GitHub(),orchestrator=new WorkflowOrchestrator(store,github,new WorkflowRunner(store,{},new Workspace(),github),{enabled:false,async notify(){}});
 try {
  const started=await startAssigned(orchestrator,store);github.deleted=true;await orchestrator.syncRemote();
  const row=store.db.prepare("SELECT archived_at,status FROM work_items WHERE id=?").get(started.id) as {archived_at:string|null;status:string};assert.ok(row.archived_at);assert.equal(row.status,"PAUSED");assert.equal((store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='github.issue_deleted' AND work_item_id=?").get(started.id) as {count:number}).count,1);
  await orchestrator.syncRemote();assert.equal((store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='github.issue_deleted' AND work_item_id=?").get(started.id) as {count:number}).count,1);
 } finally {store.db.close();config.repo=previousRepo;}
});

test("a deleted terminal issue archives when GitHub rejects release operations",async()=>{
 const previousRepo=config.repo;config.repo="owner/demo";
 const store=new Store(":memory:"),github=new GitHub(),orchestrator=new WorkflowOrchestrator(store,github,new WorkflowRunner(store,{},new Workspace(),github),{enabled:false,async notify(){}});
 try {
  const started=await startAssigned(orchestrator,store),projections=new WorkflowProjections(store),current=projections.get(started.id);
  projections.transition({workItemId:started.id,expectedRevision:current.revision,stage:current.stage,status:"CANCELLED",actor:{type:"human",id:"owner"},source:{},reason:{code:"cancel",summary:"Cancelled"}});
  github.deleted=true;await orchestrator.syncRemote();
  const row=store.db.prepare("SELECT archived_at FROM work_items WHERE id=?").get(started.id) as {archived_at:string|null};assert.ok(row.archived_at);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='github.issue_deleted' AND work_item_id=?").get(started.id) as {count:number}).count,1);
 } finally {store.db.close();config.repo=previousRepo;}
});

test("dashboard start snapshots historical comments instead of replaying commands",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");
 const store=new Store(":memory:"),github=new GitHub(),runner=new WorkflowRunner(store,{},new Workspace(),github),orchestrator=new WorkflowOrchestrator(store,github,runner,{enabled:false,async notify(){}});
 try {
  github.reply(1,"/factory cancel");
  const started=await startAssigned(orchestrator,store);
  await assert.rejects(orchestrator.tick(),/No adapter configured/);
  const projection=new WorkflowProjections(store).get(started.id);
  assert.deepEqual({stage:projection.stage,status:projection.status},{stage:"DESIGN",status:"QUEUED"});
 } finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

test("a replaced GitHub issue archives stale work without publishing and can start a distinct item",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");
 const store=new Store(":memory:"),github=new GitHub(),runner=new WorkflowRunner(store,{},new Workspace(),github),orchestrator=new WorkflowOrchestrator(store,github,runner,{enabled:false,async notify(){}});
 try {
  const old=await startAssigned(orchestrator,store);github.statusBodies.length=0;github.resultBodies.length=0;github.issueId=200;
  const refreshed=await orchestrator.refreshIssueList(),stale=store.db.prepare("SELECT archived_at,status FROM work_items WHERE id=?").get(old.id) as {archived_at:string|null;status:string};
  assert.ok(stale.archived_at);assert.equal(stale.status,"PAUSED");assert.deepEqual(refreshed,{found:0,added:0,updated:0});assert.equal(github.statusBodies.length,0);assert.equal(github.resultBodies.length,0);
  const event=JSON.parse((store.db.prepare("SELECT payload FROM events WHERE type='github.issue_replaced'").get() as {payload:string}).payload);assert.deepEqual(event,{issue:1,previousIssueId:100,currentIssueId:200});
  const replacement=await startAssigned(orchestrator,store);assert.equal(replacement.created,true);assert.notEqual(replacement.id,old.id);
  assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items WHERE issue_number=1").get() as {count:number}).count,2);
 } finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

test("visibility reconciliation refreshes issue content and presents only title changes",async()=>{
 const previousRepo=config.repo;config.repo="owner/demo";const store=new Store(":memory:"),github=new GitHub(),orchestrator=new WorkflowOrchestrator(store,github,new WorkflowRunner(store,{},new Workspace(),github),{enabled:false,async notify(){}});
 try {
  const started=await startAssigned(orchestrator,store),before=new WorkflowProjections(store).get(started.id).presentationRevision;
  github.body="Updated body";await orchestrator.refreshIssueList();let context=JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id=?").get(started.id) as {context:string}).context);assert.equal(context.body,"Updated body");assert.equal(new WorkflowProjections(store).get(started.id).presentationRevision,before);
  github.title="Updated title";await orchestrator.refreshIssueList();context=JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id=?").get(started.id) as {context:string}).context);assert.equal(context.title,"Updated title");assert.equal(new WorkflowProjections(store).get(started.id).presentationRevision,before+1);
  const writes=(store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='workflow.presentation'").get() as {count:number}).count;await orchestrator.refreshIssueList();assert.equal((store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='workflow.presentation'").get() as {count:number}).count,writes);
 } finally {store.db.close();config.repo=previousRepo;}
});

test("assignment claim waits one poll, then starts; conflicts and foreign status wait",async()=>{
 const previousRepo=config.repo,previousInstance=config.instanceName;config.repo="owner/demo";config.instanceName="local";
 const store=new Store(":memory:"),github=new GitHub();github.issueLabels=[];const orchestrator=new WorkflowOrchestrator(store,github,new WorkflowRunner(store,{},new Workspace(),github),{enabled:false,async notify(){}});store.setMetadata("runtime:factory-account","factory");store.setMetadata("repository_identity",{id:1,nodeId:"R_1",fullName:"owner/demo"});
 try{
  await orchestrator.syncRemote();assert.deepEqual(github.labelEdits,["factory-instance:local"]);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,0);
  await orchestrator.syncRemote();assert.equal((store.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,1);
  const conflictStore=new Store(":memory:"),conflictGitHub=new GitHub();conflictGitHub.issueLabels=[{name:"factory-instance:local"},{name:"factory-instance:other"}];conflictStore.setMetadata("runtime:factory-account","factory");const conflict=new WorkflowOrchestrator(conflictStore,conflictGitHub,new WorkflowRunner(conflictStore,{},new Workspace(),conflictGitHub),{enabled:false,async notify(){}});await conflict.syncRemote();await conflict.syncRemote();assert.equal((conflictStore.db.prepare("SELECT COUNT(*) count FROM events WHERE type='issue.claim_conflict'").get() as {count:number}).count,1);assert.equal((conflictStore.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,0);conflictStore.db.close();
  const pendingStore=new Store(":memory:"),pendingGitHub=new GitHub();pendingGitHub.issueLabels=[{name:"factory-instance:local"}];pendingGitHub.reply(4,"status\n<!-- ai-factory:workflow-status:owner/demo:1 -->");pendingStore.setMetadata("runtime:factory-account","factory");const pending=new WorkflowOrchestrator(pendingStore,pendingGitHub,new WorkflowRunner(pendingStore,{},new Workspace(),pendingGitHub),{enabled:false,async notify(){}});await pending.syncRemote();await pending.syncRemote();assert.equal((pendingStore.db.prepare("SELECT COUNT(*) count FROM events WHERE type='issue.continuation_pending'").get() as {count:number}).count,1);assert.equal((pendingStore.db.prepare("SELECT COUNT(*) count FROM work_items").get() as {count:number}).count,0);pendingStore.db.close();
 }finally{store.db.close();config.repo=previousRepo;config.instanceName=previousInstance;}
});

test("unassignment pauses and preserves local work; reassignment resumes; terminal work releases ownership",async()=>{
 const previousRepo=config.repo,previousInstance=config.instanceName;config.repo="owner/demo";config.instanceName="local";
 const store=new Store(":memory:"),github=new GitHub();github.issueLabels=[{name:"factory-instance:local"}];store.setMetadata("runtime:factory-account","factory");store.setMetadata("repository_identity",{id:1,nodeId:"R_1",fullName:"owner/demo"});let preserved=0;const runner={reconcileFinished(){},async preserve(){preserved++;},async run(){return false;}} as any;const orchestrator=new WorkflowOrchestrator(store,github,runner,{enabled:false,async notify(){}});
 try{
  await orchestrator.syncRemote();const row=store.db.prepare("SELECT id FROM work_items").get() as {id:string};github.assigned=false;await orchestrator.syncRemote();let projection=new WorkflowProjections(store).get(row.id);assert.equal(projection.status,"PAUSED");assert.equal(preserved,1);assert.deepEqual(github.removedLabels,["factory-instance:local"]);
  github.assigned=true;github.issueLabels=[{name:"factory-instance:local"}];await orchestrator.syncRemote();projection=new WorkflowProjections(store).get(row.id);assert.equal(projection.status,"QUEUED");assert.equal(projection.attempt,1);
  new WorkflowProjections(store).transition({workItemId:row.id,expectedRevision:projection.revision,stage:projection.stage,status:"CANCELLED",actor:{type:"human",id:"owner"},source:{},reason:{code:"cancel",summary:"Cancelled"}});await orchestrator.syncRemote();assert.deepEqual(github.unassigned,["factory"]);assert.equal(github.removedLabels.at(-1),"factory-instance:local");
 }finally{store.db.close();config.repo=previousRepo;config.instanceName=previousInstance;}
});

test("flush still updates the issue status when a milestone comment cannot be published, and publishes it once GitHub recovers",async()=>{
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");
 const store=new Store(":memory:"),github=new GitHub(),workspace=new Workspace();
 const adapter:AgentAdapter={async run(request){store.db.prepare("UPDATE executions SET status='succeeded',total_tokens=1000,finished_at='now' WHERE id=?").run(request.executionId);return result("spec");}};
 const runner=new WorkflowRunner(store,{"product-architect":adapter,developer:adapter,qa:adapter,reviewer:adapter},workspace,github);
 const orchestrator=new WorkflowOrchestrator(store,github,runner,{enabled:false,async notify(){}});
 const publishComment=github.publishWorkflowComment.bind(github);
 try {
  const started=await startAssigned(orchestrator,store);
  github.publishWorkflowComment=()=>{throw new Error("GitHub unavailable");};
  await orchestrator.runLocal();await orchestrator.runLocal();
  const statusesBefore=github.statusBodies.length;
  await assert.rejects(async()=>await orchestrator.flush(),/GitHub unavailable/);
  assert.equal(github.resultBodies.length,0);
  assert.equal(github.statusBodies.length,statusesBefore+1,"the status comment is published although the milestone comment failed");
  assert.match(github.statusBodies.at(-1)!,/\/factory approve v1/);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='github.publish_failed' AND work_item_id=?").get(started.id) as {n:number}).n,1);
  github.publishWorkflowComment=publishComment;
  await orchestrator.flush();
  assert.equal(github.resultBodies.length,1);assert.match(github.resultBodies[0],/^# Brief v1/m);
  await orchestrator.flush();assert.equal(github.resultBodies.length,1,"a recovered milestone is published exactly once");
 } finally {store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);}
});

// An epic: the Architect splits the issue, the human approves brief and split together, stories
// become sub-issues blocked by each other, each runs Builder and Tester on its own branch from the
// epic branch and integrates into it, and the epic resumes with Test, Review and one pull request.
function epicFixture(){
 const previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");
 const store=new Store(":memory:"),github=new GitHub(),workspace=new Workspace();
 const criteria=[{id:"AC1",description:"Tokens"},{id:"AC2",description:"Hero"},{id:"AC3",description:"Whole page"}];
 const stories=[{key:"S1",title:"Design tokens",scope:"Palette and spacing",criteria:["AC1"],dependsOn:[],assessment:{complexity:"low" as const,risk:"low" as const,verificationDepth:"minimal" as const}},{key:"S2",title:"Hero",scope:"First screen",criteria:["AC2"],dependsOn:["S1"],assessment:{complexity:"medium" as const,risk:"low" as const,verificationDepth:"standard" as const}}];
 const succeed=(executionId:string)=>store.db.prepare("UPDATE executions SET status='succeeded',total_tokens=1000,finished_at='now' WHERE id=?").run(executionId);
 const architect:AgentAdapter={async run(request){succeed(request.executionId!);return result("spec",{acceptanceCriteria:criteria,spec:"# Spec\nAC1 AC2 AC3",stories});}};
 // Delivery roles cover exactly the criteria of the work item they run on: a story's slice, or the epic's whole.
 const delivery:AgentAdapter={async run(request){succeed(request.executionId!);const spec=store.db.prepare("SELECT criteria FROM specs WHERE work_item_id=? ORDER BY version DESC LIMIT 1").get(request.workItemId) as {criteria:string};return result("pass",{coverage:(JSON.parse(spec.criteria) as Array<{id:string}>).map(criterion=>({criterionId:criterion.id,status:"passed" as const,evidence:"Verified"}))});}};
 const runner=new WorkflowRunner(store,{"product-architect":architect,developer:delivery,qa:delivery,reviewer:delivery},workspace,github);
 const orchestrator=new WorkflowOrchestrator(store,github,runner,{enabled:false,async notify(){}});
 const item=(id:string)=>store.db.prepare("SELECT stage,status,base_branch,epic_work_item_id FROM work_items WHERE id=?").get(id) as {stage:string;status:string;base_branch:string;epic_work_item_id:string|null};
 const storyRows=()=>store.db.prepare("SELECT key,issue_number,issue_id,dependencies_declared,work_item_id FROM stories ORDER BY key").all() as Array<{key:string;issue_number:number|null;issue_id:number|null;dependencies_declared:number;work_item_id:string|null}>;
 const restore=()=>{store.db.close();config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);};
 return {store,github,workspace,orchestrator,item,storyRows,restore};
}

test("an approved split creates sub-issues with dependencies, runs each story from the epic branch and resumes the epic once every story is integrated",async()=>{
 const f=epicFixture();
 try {
  const epic=await startAssigned(f.orchestrator,f.store);await f.orchestrator.tick();
  assert.match(f.github.resultBodies.at(-1)!,/## Stories/);
  // Approval plans the stories in the same poll; the tick then already ran S1's Builder.
  f.github.reply(1,"/factory approve v1");await f.orchestrator.tick();
  assert.deepEqual(f.item(epic.id),{stage:"BUILD",status:"WAITING",base_branch:"main",epic_work_item_id:null});
  assert.match(f.github.statusByIssue.get(1)!,/stories of this epic are being delivered/);
  // Both stories exist as sub-issues of the epic; S2 is blocked by S1; only S1 started.
  const rows=f.storyRows();assert.deepEqual(rows.map(row=>[row.key,row.dependencies_declared,Boolean(row.work_item_id)]),[["S1",1,true],["S2",1,false]]);
  assert.equal(f.github.subIssuesByParent.get(1)?.length,2);
  const s1=rows[0],s2=rows[1];assert.deepEqual(f.github.blockedByIssue.get(s2.issue_number!),[s1.issue_id]);assert.equal(f.github.blockedByIssue.get(s1.issue_number!),undefined);
  assert.deepEqual(f.item(s1.work_item_id!),{stage:"TEST",status:"QUEUED",base_branch:"factory/issue-1",epic_work_item_id:epic.id});
  const s1Spec=f.store.db.prepare("SELECT criteria,approved_by,stories,assessment FROM specs WHERE work_item_id=?").get(s1.work_item_id) as {criteria:string;approved_by:string;stories:string;assessment:string};
  assert.deepEqual({criteria:JSON.parse(s1Spec.criteria).map((c:{id:string})=>c.id),approved_by:s1Spec.approved_by,stories:s1Spec.stories,depth:JSON.parse(s1Spec.assessment).verificationDepth,ux:JSON.parse(s1Spec.assessment).uxImpact},{criteria:["AC1"],approved_by:"owner",stories:"[]",depth:"minimal",ux:"none"},"the story runs at its own depth with the epic UX impact");
  // S1: Tester, then integration into the epic branch instead of Review.
  await f.orchestrator.runLocal();assert.deepEqual(f.item(s1.work_item_id!),{stage:"DELIVERY",status:"QUEUED",base_branch:"factory/issue-1",epic_work_item_id:epic.id});
  await f.orchestrator.runLocal();assert.equal(f.item(s1.work_item_id!).status,"COMPLETED");assert.deepEqual(f.workspace.integrations,[`factory/issue-${s1.issue_number}->factory/issue-1`]);assert.deepEqual(f.github.closed,[{number:s1.issue_number,reason:"completed"}]);
  assert.equal(f.item(epic.id).status,"WAITING","the epic waits until every story is in");
  // Another poll creates nothing twice, and S2 starts only now that its blocker is closed as completed.
  await f.orchestrator.tick();assert.equal(f.github.issues.size,2);assert.deepEqual(f.github.blockedByIssue.get(s2.issue_number!),[s1.issue_id]);
  const s2Item=f.storyRows()[1].work_item_id!;assert.equal(f.item(s2Item).stage,"TEST");
  await f.orchestrator.runLocal();await f.orchestrator.runLocal();assert.equal(f.item(s2Item).status,"COMPLETED");assert.equal(f.workspace.integrations.length,2);
  // Every story integrated: the epic resumes at Review, which the runner sends through Test first.
  await f.orchestrator.syncRemote();assert.deepEqual(f.item(epic.id),{stage:"REVIEW",status:"QUEUED",base_branch:"main",epic_work_item_id:null});
  await f.orchestrator.runLocal();assert.equal(f.item(epic.id).stage,"TEST");
  await f.orchestrator.runLocal();assert.equal(f.item(epic.id).stage,"REVIEW");
  await f.orchestrator.runLocal();await f.orchestrator.runLocal();await f.orchestrator.flush();
  assert.deepEqual(f.item(epic.id),{stage:"DELIVERY",status:"WAITING",base_branch:"main",epic_work_item_id:null});assert.match(f.github.lastPrBody,/^Closes #1$/m);
 } finally {f.restore();}
});

test("a story issue that already exists is adopted, and a blocker closed as not planned does not unblock",async()=>{
 const f=epicFixture();
 try {
  const epic=await startAssigned(f.orchestrator,f.store);await f.orchestrator.tick();
  // A crash after GitHub created S1 but before the local ledger recorded it.
  f.github.createIssue({title:"Design tokens",body:"created before the crash",parentIssueId:100});
  f.github.reply(1,"/factory approve v1");await f.orchestrator.tick();
  assert.equal(f.github.issues.size,2,"S1 was adopted, S2 created");assert.deepEqual(f.storyRows().map(row=>row.issue_number),[10,11]);
  assert.equal((f.store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='story.issue_adopted'").get() as {count:number}).count,1);
  // Someone closes S1 as not planned: S2 stays blocked and the epic keeps waiting.
  f.github.closeIssue(10,"not planned");await f.orchestrator.tick();
  assert.equal(f.storyRows()[1].work_item_id,null);assert.equal(f.item(epic.id).status,"WAITING");
 } finally {f.restore();}
});

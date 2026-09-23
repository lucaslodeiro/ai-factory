import test from "node:test";
import assert from "node:assert/strict";
import {Store} from "../src/storage.js";
import {WorkflowIntake,WorkflowInbox} from "../src/workflow-inbox.js";
import {WorkflowScheduler} from "../src/workflow-scheduler.js";
import {WorkflowResults} from "../src/workflow-results.js";
import {WorkflowGitHubPublisher} from "../src/workflow-github.js";
import {WorkflowProjections} from "../src/workflow-projection.js";
import {WorkflowFailures} from "../src/workflow-failures.js";
import {result} from "./fixtures.js";
import type {AgentResult,AgentRole} from "../src/types.js";
import type {Comment,Issue} from "../src/adapters/github.js";
import {config} from "../src/config.js";
import {GitHubAdapter} from "../src/adapters/github.js";
import {workflowActivity} from "../src/workflow-activity.js";

const issue:Issue={id:100,nodeId:"I_100",number:1,title:"Issue content audit",body:"Build the requested feature",url:"https://github.com/owner/demo/issues/1",state:"OPEN",createdAt:"2026-09-20T00:00:00Z",updatedAt:"2026-09-20T00:00:00Z",author:{login:"owner",type:"User"}};

class IssuePort {
 commentsByIssue=new Map<number,Comment[]>();statuses:Array<{labels:string[];body:string}>=[];publishedComments:Array<{key:string;body:string}>=[];assigned=new Set<string>();assignmentCalls:Array<{action:"assign"|"unassign";logins:string[]}>=[];
 comments(issueNumber:number){return this.commentsByIssue.get(issueNumber)??[];}
 syncWorkflow(_issue:number,labels:Array<{name:string}>,body:string){this.statuses.push({labels:labels.map(label=>label.name),body});}
 publishWorkflowComment(_issue:number,key:string,body:string){this.publishedComments.push({key,body});}
 assignees(){return [...this.assigned];}
 assign(_issue:number,logins:string[]){this.assignmentCalls.push({action:"assign",logins});for(const login of logins)this.assigned.add(login);}
 unassign(_issue:number,logins:string[]){this.assignmentCalls.push({action:"unassign",logins});for(const login of logins)this.assigned.delete(login);}
 reply(id:number,body:string){const comments=this.commentsByIssue.get(1)??[];comments.push({id,body,user:{login:"owner",type:"User"},updatedAt:`2026-09-20T00:00:${String(id).padStart(2,"0")}Z`});this.commentsByIssue.set(1,comments);}
}

function oneNextAction(body:string){assert.equal(body.match(/^## Next action$/gm)?.length,1,body);}

async function lifecycle() {
 const store=new Store(":memory:");store.setMetadata("repository_identity",{id:1,nodeId:"R_1",fullName:"owner/demo"});const port=new IssuePort(),intake=new WorkflowIntake(store),inbox=new WorkflowInbox(store,port,["owner"]),scheduler=new WorkflowScheduler(store),results=new WorkflowResults(store),publisher=new WorkflowGitHubPublisher(store,port);
 const started=intake.start(issue,{actor:"dashboard",source:"control"}),workItemId=started.id;
 const statuses=new Map<string,string>(),milestones=new Map<string,string>(),assignments=new Map<string,string[]>();
 const publish=async(name:string)=>{const before=port.publishedComments.length;await publisher.publishResults();await publisher.publishChanged();const status=port.statuses.at(-1)?.body??"";statuses.set(name,status);assignments.set(name,[...port.assigned]);oneNextAction(status);for(const comment of port.publishedComments.slice(before))milestones.set(name,comment.body);};
 const run=(role:AgentRole,agentResult:AgentResult)=>{const execution=scheduler.begin(workItemId);store.db.prepare("UPDATE executions SET status='succeeded',finished_at='2026-09-20T01:00:00Z',exit_code=0 WHERE id=?").run(execution.executionId);return results.apply({head:"head",workItemId,executionId:execution.executionId,role,result:agentResult});};
 await publish("start");
 run("product-architect",result("questions",{summary:"I need two product choices",questions:["Which audience is primary?","Should results be cached?"]}));await publish("questions");
 port.reply(1,"/factory answer\n1. Support fans.\n2. Cache for five minutes.");inbox.poll(workItemId);await publish("answer");
 run("product-architect",result("spec",{summary:"A small read-only football dashboard",spec:"# Football dashboard\n\n## AC1\nShows current standings.",acceptanceCriteria:[{id:"AC1",description:"Shows current standings"}]}));await publish("spec");
 port.reply(2,"/factory approve v1");inbox.poll(workItemId);await publish("approved");
 run("developer",result("pass",{summary:"Implemented the dashboard"}));await publish("builder-pass-1");
 run("qa",result("changes",{summary:"Standings need a deterministic sort",coverage:[{criterionId:"AC1",status:"failed",evidence:"Oldest row appears first"}],findings:[{classification:"auto-fix",severity:"major",evidence:"Sort standings newest first"}]}));await publish("tester-changes");
 run("developer",result("pass",{summary:"Corrected standings ordering"}));await publish("builder-pass-2");
 run("qa",result("decision",{summary:"The provider leaves postponed matches ambiguous",coverage:[{criterionId:"AC1",status:"not-run",evidence:"Decision blocks final verification"}],findings:[{classification:"decision-required",severity:"major",evidence:"Choose whether postponed matches appear"}]}));await publish("tester-decision");
 run("product-architect",result("resolved",{summary:"Show postponed matches with a status badge",decisions:[{kind:"tactical",decision:"Keep postponed matches visible",rationale:"Preserves schedule completeness",conflictsWithHuman:false,supersedes:[]}],nextRole:"qa"}));await publish("architect-resolved");
 run("qa",result("pass",{summary:"All acceptance checks now pass"}));await publish("tester-pass");
 run("reviewer",result("pass",{summary:"Delivery is ready for human review"}));results.published({workItemId,pullRequestUrl:"https://github.com/owner/demo/pull/7"});await publish("delivery-waiting");
 port.reply(3,"/factory pause lunch");inbox.poll(workItemId);await publish("delivery-paused");
 port.reply(4,"/factory cancel superseded");inbox.poll(workItemId);await publish("cancelled");
 return {store,port,workItemId,statuses,milestones,assignments};
}

async function failedItem(){
 const store=new Store(":memory:");store.setMetadata("repository_identity",{id:1,nodeId:"R_1",fullName:"owner/demo"});store.db.prepare("INSERT INTO work_items(id,issue_number,issue_id,repo,branch,base_branch,created_at,updated_at,context) VALUES('failed-work',2,200,'owner/demo','factory/failed','main','2026-09-20T00:00:00Z','2026-09-20T00:00:00Z',?)").run(JSON.stringify({title:"Timed out work",body:"Run it",issueNodeId:"I_200",cursor:0}));new WorkflowProjections(store).initialize("failed-work","DESIGN","QUEUED");const scheduler=new WorkflowScheduler(store),execution=scheduler.begin("failed-work");store.db.prepare("UPDATE executions SET status='timed_out',finished_at='2026-09-20T02:00:00Z',exit_code=NULL WHERE id=?").run(execution.executionId);scheduler.fail("failed-work",execution.executionId,new Error("Provider stopped before returning a result"),"execution");const port=new IssuePort(),publisher=new WorkflowGitHubPublisher(store,port);assert.equal(await publisher.publishResults(),1);assert.equal(await publisher.publishResults(),0);await publisher.publishChanged();const body=port.statuses.at(-1)?.body??"",comment=port.publishedComments.at(-1)?.body??"";oneNextAction(body);return{store,body,comment,port};
}

async function environmentBlockedItem(){
 const store=new Store(":memory:");store.setMetadata("repository_identity",{id:1,nodeId:"R_1",fullName:"owner/demo"});const port=new IssuePort(),intake=new WorkflowIntake(store),scheduler=new WorkflowScheduler(store),results=new WorkflowResults(store),publisher=new WorkflowGitHubPublisher(store,port);const workItemId=intake.start({...issue,id:300,nodeId:"I_300",number:3,title:"Design needs browser evidence",url:"https://github.com/owner/demo/issues/3"},{actor:"dashboard",source:"control"}).id;const execution=scheduler.begin(workItemId);store.db.prepare("UPDATE executions SET status='succeeded',finished_at='2026-09-20T01:00:00Z',exit_code=0 WHERE id=?").run(execution.executionId);results.apply({head:"head",workItemId,executionId:execution.executionId,role:"product-architect",result:result("questions",{summary:"Rendered UI evidence is required before completing the specification",questions:["Can browser access be restored?"],findings:[{classification:"environment-blocked",severity:"major",evidence:"No browser is available for the required rendered UI inspection"}]})});await publisher.publishResults();await publisher.publishChanged();const body=port.statuses.at(-1)?.body??"",comment=port.publishedComments.find(value=>value.key.startsWith("result-"))?.body??"";oneNextAction(body);oneNextAction(comment);return{store,body,comment,workItemId};
}

test("issue content lifecycle publishes actionable human-facing messages",async()=>{
 const previousApprovers=[...config.approvers];config.approvers.splice(0,config.approvers.length,"owner");const h=await lifecycle(),failed=await failedItem(),blocked=await environmentBlockedItem();
 try {
  const questions=h.milestones.get("questions")??"";assert.match(questions,/^# Architect — questions/m);assert.match(questions,/1\. Which audience is primary\?/);assert.match(questions,/\/factory answer\n1\. <answer 1>\n2\. <answer 2>/);assert.doesNotMatch(questions,/specification/i);
  const spec=h.milestones.get("spec")??"";assert.match(spec,/^# Brief v1 — awaiting approval/m);assert.match(spec,/^## Football dashboard/m);assert.match(spec,/## Acceptance criteria[\s\S]*\| AC1 \| Shows current standings \|/);assert.match(spec,/`\/factory approve v1 \[guidance\]`/);assert.match(spec,/`\/factory answer <feedback>`/);assert.match(spec,/Feedback becomes a human decision for Architect/);assert.doesNotMatch(spec,/use the command shown in the AI Factory status comment/);oneNextAction(spec);
  const decision=h.milestones.get("tester-decision")??"";assert.match(decision,/Architect will resolve this decision; no human action is required/);assert.doesNotMatch(decision,/next workflow stage is queued/);
  const resolved=h.milestones.get("architect-resolved")??"";assert.match(resolved,/^# Architect — tactical decision/m);assert.match(resolved,/No human action is required; Tester continues/);assert.doesNotMatch(resolved,/Review the specification/);assert.match(h.statuses.get("architect-resolved")??"",/Latest delivery summary[\s\S]*Architect:\*\* Show postponed matches with a status badge/);
  const delivery=h.milestones.get("delivery-waiting")??"";assert.match(delivery,/Review and merge the pull request \(https:\/\/github\.com\/owner\/demo\/pull\/7\) when it is ready/);
  assert.match(h.statuses.get("questions")??"",/Open request \| Waiting for your answer/);assert.match(h.statuses.get("spec")??"",/Open request \| Waiting for approval of the SPEC v1 brief/);assert.match(h.statuses.get("tester-decision")??"",/Open request \| Architect is deciding/);assert.match(h.statuses.get("delivery-waiting")??"",/Open request \| Waiting for merge/);assert.doesNotMatch(Array.from(h.statuses.values()).join("\n"),/Open request \| (?:clarification|spec-approval|tactical-decision|merge)/);
  const paused=h.statuses.get("delivery-paused")??"";assert.match(paused,/Paused by @owner — Human paused work: lunch\. Post `\/factory retry` to resume/);assert.match(paused,/Preserved request after resuming[\s\S]*Review and merge the pull request/);const cancelled=h.statuses.get("cancelled")??"";assert.match(cancelled,/Current actor \| Human/);assert.match(cancelled,/Cancelled by @owner — Human cancelled work: superseded\. Post `\/factory retry` to restore the preserved work/);assert.doesNotMatch(cancelled,/Resume the preserved work when ready/);assert.match(failed.body,/Current actor \| Human/);
  const transitions=(h.statuses.get("delivery-paused")??"").replace(/<!-- ai-factory:payload:v1 [\s\S]*? -->/,"");assert.doesNotMatch(transitions,/product-architect|developer passed|qa requested|\/Running:/);assert.match(transitions,/Builder passed/);assert.match(transitions,/Tester requested an architectural decision/);assert.match(transitions,/\d{4}-\d\d-\d\d \d\d:\d\d UTC/);assert.doesNotMatch(transitions,/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  assert.match(failed.body,/agent execution exceeded its configured time limit/i);assert.match(failed.body,/Process result:\*\* timed_out/);assert.doesNotMatch(failed.body,/rejected the stage result after the agent process returned/);
  assert.match(failed.comment,/^# Design failed/m);assert.match(failed.comment,/agent execution exceeded its configured time limit/i);assert.match(failed.comment,/\/factory retry/);assert.equal(failed.port.publishedComments.filter(comment=>comment.key.startsWith("failure-")).length,1);
  assert.match(blocked.comment,/^# Architect — blocked/m);assert.match(blocked.comment,/Can browser access be restored/);assert.match(blocked.comment,/^\/factory retry$/m);assert.doesNotMatch(blocked.comment,/\/factory answer/);assert.match(blocked.body,/A required capability was unavailable/);assert.match(blocked.body,/No browser is available for the required rendered UI inspection/);assert.match(blocked.body,/Last agent report[\s\S]*Architect:\*\* Rendered UI evidence is required/);assert.match(blocked.body,/Failure class:\*\* environment/);const activity=workflowActivity(blocked.store,blocked.workItemId,"FAILED");assert.match(activity.diagnosis?.summary??"",/required to complete this stage/);assert.match(activity.diagnosis?.evidence??"",/No browser is available/);assert.match(activity.diagnosis?.nextAction??"",/retry the saved stage/);
  assert.match(h.statuses.get("spec")??"",/Instance \|/);assert.match(h.statuses.get("spec")??"",/<sub>instance:/);assert.match(h.milestones.get("spec")??"",/<sub>instance:/);
  assert.deepEqual(h.assignments.get("questions"),[]);assert.deepEqual(h.assignments.get("approved"),[]);assert.deepEqual(h.assignments.get("spec"),[]);assert.deepEqual(h.assignments.get("delivery-waiting"),[]);assert.deepEqual(h.assignments.get("delivery-paused"),[]);assert.deepEqual(failed.port.assignees(),[]);
  if(process.env.ISSUE_CONTENT_PRINT==="1")for(const [name,body] of [["DESIGN_WAITING_SPEC_STATUS",h.statuses.get("spec")],["DESIGN_WAITING_SPEC_COMMENT",h.milestones.get("spec")],["DESIGN_QUEUED_TACTICAL_STATUS",h.statuses.get("architect-resolved")],["DELIVERY_WAITING_STATUS",h.statuses.get("delivery-waiting")],["DELIVERY_PAUSED_STATUS",h.statuses.get("delivery-paused")],["DESIGN_FAILED_STATUS",failed.body],["ARCHITECT_QUESTIONS_COMMENT",h.milestones.get("questions")]] as const)process.stdout.write(`\n===== ${name} =====\n${(body??"").replace(/^> $/gm,">")}\n===== END ${name} =====\n`);
  const malformedStore=new Store(":memory:"),malformedPort=new IssuePort(),malformedId=new WorkflowIntake(malformedStore).start({...issue,id:200,nodeId:"I_200",number:2,url:"https://github.com/owner/demo/issues/2"},{actor:"dashboard",source:"control"}).id;malformedPort.commentsByIssue.set(2,[{id:9,body:"/factory answer",user:{login:"owner",type:"User"},updatedAt:"2026-09-20T00:00:09Z"}]);new WorkflowInbox(malformedStore,malformedPort,["owner"]).poll(malformedId);const rejected=JSON.parse((malformedStore.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='command.rejected'").get(malformedId) as {payload:string}).payload) as {error:string};assert.equal(rejected.error,"/factory answer requires guidance. Post a new comment; edits to this one are not re-read.");malformedStore.db.close();
 } finally {config.approvers.splice(0,config.approvers.length,...previousApprovers);h.store.db.close();failed.store.db.close();blocked.store.db.close();}
});

test("GitHub assignment adapter uses explicit add and remove operations",async()=>{
 const calls:string[][]=[],adapter=new GitHubAdapter(args=>{calls.push(args);return args.includes("--json")?JSON.stringify({assignees:[{login:"owner"}]}):"";},"owner/demo");
 assert.deepEqual(adapter.assignees(1),["owner"]);adapter.assign(1,["owner","reviewer"]);adapter.unassign(1,["owner"]);
 assert.deepEqual(calls[1],["issue","edit","1","--repo","owner/demo","--add-assignee","owner,reviewer"]);assert.deepEqual(calls[2],["issue","edit","1","--repo","owner/demo","--remove-assignee","owner"]);
});

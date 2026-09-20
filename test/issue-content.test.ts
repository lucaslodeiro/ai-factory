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

const issue:Issue={id:100,nodeId:"I_100",number:1,title:"Issue content audit",body:"Build the requested feature",url:"https://github.com/owner/demo/issues/1",state:"OPEN",createdAt:"2026-09-20T00:00:00Z",updatedAt:"2026-09-20T00:00:00Z",author:{login:"owner",type:"User"}};

class IssuePort {
 commentsByIssue=new Map<number,Comment[]>();statuses:Array<{labels:string[];body:string}>=[];publishedComments:Array<{key:string;body:string}>=[];
 comments(issueNumber:number){return this.commentsByIssue.get(issueNumber)??[];}
 syncWorkflow(_issue:number,labels:Array<{name:string}>,body:string){this.statuses.push({labels:labels.map(label=>label.name),body});}
 publishWorkflowComment(_issue:number,key:string,body:string){this.publishedComments.push({key,body});}
 reply(id:number,body:string){const comments=this.commentsByIssue.get(1)??[];comments.push({id,body,user:{login:"owner",type:"User"},updatedAt:`2026-09-20T00:00:${String(id).padStart(2,"0")}Z`});this.commentsByIssue.set(1,comments);}
}

function oneNextAction(body:string){assert.equal(body.match(/^## Next action$/gm)?.length,1,body);}

function lifecycle() {
 const store=new Store(":memory:"),port=new IssuePort(),intake=new WorkflowIntake(store),inbox=new WorkflowInbox(store,port,["owner"]),scheduler=new WorkflowScheduler(store),results=new WorkflowResults(store),publisher=new WorkflowGitHubPublisher(store,port);
 const started=intake.start(issue,{actor:"dashboard",source:"control"}),workItemId=started.id;
 const statuses=new Map<string,string>(),milestones=new Map<string,string>();
 const publish=(name:string)=>{const before=port.publishedComments.length;publisher.publishResults();publisher.publishChanged();const status=port.statuses.at(-1)?.body??"";statuses.set(name,status);oneNextAction(status);for(const comment of port.publishedComments.slice(before))milestones.set(name,comment.body);};
 const run=(role:AgentRole,agentResult:AgentResult)=>{const execution=scheduler.begin(workItemId);store.db.prepare("UPDATE executions SET status='succeeded',finished_at='2026-09-20T01:00:00Z',exit_code=0 WHERE id=?").run(execution.executionId);return results.apply({workItemId,executionId:execution.executionId,role,result:agentResult});};
 publish("start");
 run("product-architect",result("questions",{summary:"I need two product choices",questions:["Which audience is primary?","Should results be cached?"]}));publish("questions");
 port.reply(1,"/factory answer\n1. Support fans.\n2. Cache for five minutes.");inbox.poll(workItemId);publish("answer");
 run("product-architect",result("spec",{summary:"A small read-only football dashboard",spec:"# Football dashboard\n\n## AC1\nShows current standings.",acceptanceCriteria:[{id:"AC1",description:"Shows current standings"}]}));publish("spec");
 port.reply(2,"/factory approve v1");inbox.poll(workItemId);publish("approved");
 run("developer",result("pass",{summary:"Implemented the dashboard"}));publish("builder-pass-1");
 run("qa",result("changes",{summary:"Standings need a deterministic sort",coverage:[{criterionId:"AC1",status:"failed",evidence:"Oldest row appears first"}],findings:[{classification:"auto-fix",evidence:"Sort standings newest first"}]}));publish("tester-changes");
 run("developer",result("pass",{summary:"Corrected standings ordering"}));publish("builder-pass-2");
 run("qa",result("decision",{summary:"The provider leaves postponed matches ambiguous",coverage:[{criterionId:"AC1",status:"not-run",evidence:"Decision blocks final verification"}],findings:[{classification:"decision-required",evidence:"Choose whether postponed matches appear"}]}));publish("tester-decision");
 run("product-architect",result("resolved",{summary:"Show postponed matches with a status badge",decisions:[{kind:"tactical",decision:"Keep postponed matches visible",rationale:"Preserves schedule completeness",conflictsWithHuman:false}],nextRole:"qa"}));publish("architect-resolved");
 run("qa",result("pass",{summary:"All acceptance checks now pass"}));publish("tester-pass");
 run("reviewer",result("pass",{summary:"Delivery is ready for human review"}));results.published({workItemId,pullRequestUrl:"https://github.com/owner/demo/pull/7"});publish("delivery-waiting");
 port.reply(3,"/factory pause lunch");inbox.poll(workItemId);publish("delivery-paused");
 port.reply(4,"/factory cancel superseded");inbox.poll(workItemId);publish("cancelled");
 return {store,port,workItemId,statuses,milestones};
}

function failedItem(){
 const store=new Store(":memory:");store.db.prepare("INSERT INTO work_items(id,issue_number,repo,branch,created_at,updated_at,context) VALUES('failed-work',2,'owner/demo','factory/failed','2026-09-20T00:00:00Z','2026-09-20T00:00:00Z',?)").run(JSON.stringify({title:"Timed out work",body:"Run it",cursor:0}));store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment,approved_by) VALUES('failed-work',1,'SPEC',?,?, 'owner')").run(JSON.stringify([{id:"AC1",description:"Works"}]),JSON.stringify({complexity:"medium",risk:"medium",rationale:"network work"}));new WorkflowProjections(store).initialize("failed-work","TEST","QUEUED");const scheduler=new WorkflowScheduler(store),execution=scheduler.begin("failed-work");store.db.prepare("UPDATE executions SET status='timed_out',finished_at='2026-09-20T02:00:00Z',exit_code=NULL WHERE id=?").run(execution.executionId);scheduler.fail("failed-work",execution.executionId,new Error("Provider stopped before returning a result"),"execution");const port=new IssuePort(),publisher=new WorkflowGitHubPublisher(store,port);publisher.publishChanged();const body=port.statuses.at(-1)?.body??"";oneNextAction(body);return{store,body};
}

test("current main issue content reproduces the actionable audit findings",()=>{
 const h=lifecycle(),failed=failedItem();
 try {
  const questions=h.milestones.get("questions")??"";assert.match(questions,/^# Architect — questions/m);assert.match(questions,/1\. Which audience is primary\?/);assert.match(questions,/\/factory answer\n1\. <answer 1>\n2\. <answer 2>/);assert.doesNotMatch(questions,/specification/i);
  const spec=h.milestones.get("spec")??"";assert.match(spec,/^# Specification v1 — awaiting approval/m);assert.match(spec,/^## Football dashboard/m);assert.match(spec,/## Acceptance criteria[\s\S]*\| AC1 \| Shows current standings \|/);assert.match(spec,/`\/factory approve v1 \[guidance\]`/);assert.match(spec,/`\/factory answer <feedback>`/);assert.doesNotMatch(spec,/use the command shown in the AI Factory status comment/);oneNextAction(spec);
  const decision=h.milestones.get("tester-decision")??"";assert.match(decision,/Architect will resolve this decision; no human action is required/);assert.doesNotMatch(decision,/next workflow stage is queued/);
  const resolved=h.milestones.get("architect-resolved")??"";assert.match(resolved,/^# Architect — tactical decision/m);assert.match(resolved,/No human action is required; Tester continues/);assert.doesNotMatch(resolved,/Review the specification/);assert.match(h.statuses.get("architect-resolved")??"",/Latest delivery summary[\s\S]*Architect:\*\* Show postponed matches with a status badge/);
  const delivery=h.milestones.get("delivery-waiting")??"";assert.match(delivery,/Review and merge the pull request \(https:\/\/github\.com\/owner\/demo\/pull\/7\) when it is ready/);
  assert.match(h.statuses.get("questions")??"",/Open request \| Waiting for your answer/);assert.match(h.statuses.get("spec")??"",/Open request \| Waiting for approval of SPEC v1/);assert.match(h.statuses.get("tester-decision")??"",/Open request \| Architect is deciding/);assert.match(h.statuses.get("delivery-waiting")??"",/Open request \| Waiting for merge/);assert.doesNotMatch(Array.from(h.statuses.values()).join("\n"),/Open request \| (?:clarification|spec-approval|tactical-decision|merge)/);
  assert.match(h.statuses.get("delivery-paused")??"",/Review and merge the pull request/);assert.match(h.statuses.get("cancelled")??"",/Current actor \| Human/);assert.match(h.statuses.get("cancelled")??"",/Resume the preserved work when ready/);assert.match(failed.body,/Current actor \| Human/);
  const transitions=h.statuses.get("delivery-paused")??"";assert.match(transitions,/product-architect execution started|developer passed|qa requested an architectural decision/);assert.match(transitions,/2026-\d\d-\d\dT\d\d:\d\d:\d\d/);
  assert.match(failed.body,/workflow rejected the stage result after the agent process returned/);assert.match(failed.body,/Process result:\*\* timed_out/);
  const malformedStore=new Store(":memory:"),malformedPort=new IssuePort(),malformedId=new WorkflowIntake(malformedStore).start({...issue,id:200,nodeId:"I_200",number:2,url:"https://github.com/owner/demo/issues/2"},{actor:"dashboard",source:"control"}).id;malformedPort.commentsByIssue.set(2,[{id:9,body:"/factory answer",user:{login:"owner",type:"User"},updatedAt:"2026-09-20T00:00:09Z"}]);new WorkflowInbox(malformedStore,malformedPort,["owner"]).poll(malformedId);const rejected=JSON.parse((malformedStore.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='command.rejected'").get(malformedId) as {payload:string}).payload) as {error:string};assert.equal(rejected.error,"Unknown or malformed /factory command. Post a new comment; edits to this one are not re-read.");malformedStore.db.close();
 } finally {h.store.db.close();failed.store.db.close();}
});

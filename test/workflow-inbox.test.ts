import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { WorkflowInbox,WorkflowIntake } from "../src/workflow-inbox.js";
import { WorkflowRecords } from "../src/workflow-records.js";
import { WorkflowProjections } from "../src/workflow-projection.js";
import type { Comment } from "../src/adapters/github.js";
import { workflowStatusMarkdown } from "../src/workflow-status.js";
import { ContextAssembler } from "../src/context-assembly.js";

const issue={id:700,nodeId:"I_700",number:7,title:"Inbox",body:"Build it",url:"https://github.com/owner/demo/issues/7",state:"OPEN" as const,createdAt:"2026-09-20T00:00:00Z",updatedAt:"2026-09-20T00:00:00Z",author:{login:"owner",type:"User"}};
const comment=(id:number,body:string,login="owner",type="User",updatedAt=`2026-09-20T00:00:${String(id).padStart(2,"0")}Z`):Comment=>({id,body,user:{login,type},updatedAt});

test("intake creates one initialized V3 item and audits its initial transition",()=>{
 const store=new Store(":memory:");
 try {
  const intake=new WorkflowIntake(store),first=intake.start(issue,{actor:"owner",commentId:10,source:"github-comment"}),again=intake.start(issue,{actor:"owner",commentId:10,source:"github-comment"});
  assert.equal(first.created,true);assert.deepEqual(again,{id:first.id,created:false});
  const projection=new WorkflowProjections(store).get(first.id);assert.deepEqual({stage:projection.stage,status:projection.status,revision:projection.revision},{stage:"DESIGN",status:"QUEUED",revision:0});
  assert.deepEqual(store.db.prepare("SELECT issue_id FROM work_items WHERE id=?").get(first.id),{issue_id:700});
  const event=JSON.parse((store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='workflow.transition'").get(first.id) as {payload:string}).payload);
  assert.equal(event.from,null);assert.equal(event.reason.code,"work-started");assert.equal(event.source.commentId,10);
 } finally {store.db.close();}
});

test("start guidance exists before the first Architect execution",()=>{
 const store=new Store(":memory:");
 try {
  const started=new WorkflowIntake(store).start(issue,{actor:"owner",commentId:10,guidance:"Keep the design dependency-free",source:"github-comment"});
  const record=new WorkflowRecords(store).active(started.id,0,"product-architect").find(candidate=>candidate.payload.kind==="instruction");
  assert.equal(record?.scope,"issue");assert.equal(record?.payload.kind==="instruction"&&record.payload.text,"Keep the design dependency-free");
  const prompt=new ContextAssembler(store).assemble({workItemId:started.id,role:"product-architect",specVersion:0,budgetBytes:100_000,budgetSource:"default",issue:{title:issue.title,body:issue.body}});
  assert.match(prompt.markdown,/Keep the design dependency-free/);
 } finally {store.db.close();}
});

test("a tracked issue rejects a last-line start as a command instead of observing prose",()=>{
 const store=new Store(":memory:");
 try {const started=new WorkflowIntake(store).start(issue,{actor:"dashboard",source:"control"}),result=new WorkflowInbox(store,{comments:()=>[comment(1,"Please begin\n/factory start")]},["owner"]).poll(started.id);assert.deepEqual({rejected:result.rejected,observed:result.observed},{rejected:1,observed:0});assert.equal((store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='command.rejected'").get() as {count:number}).count,1);}
 finally {store.db.close();}
});

test("inbox consumes commands once and records explicit human guidance",()=>{
 const store=new Store(":memory:");
 try {
  const started=new WorkflowIntake(store).start(issue,{actor:"dashboard",source:"control"}),comments=[comment(1,"Looks good"),comment(2,"/factory note --for tester Do not use Chromium"),comment(3,"/factory note ignored","stranger"),comment(4,"/factory bogus")];
  const inbox=new WorkflowInbox(store,{comments:()=>comments},["owner"]),result=inbox.poll(started.id);
  assert.deepEqual(result,{seen:4,applied:1,rejected:1,observed:2,cursor:4});
  const instruction=new WorkflowRecords(store).active(started.id,0,"qa").find(record=>record.kind==="instruction");assert.equal(instruction?.payload.kind==="instruction"&&instruction.payload.text,"Do not use Chromium");
  assert.equal(new WorkflowProjections(store).get(started.id).presentationRevision,3);
  assert.deepEqual(inbox.poll(started.id),{seen:0,applied:0,rejected:0,observed:0,cursor:4});
 } finally {store.db.close();}
});

test("stale approval is ignored durably and cannot cross its request boundary",()=>{
 const store=new Store(":memory:");
 try {
  const started=new WorkflowIntake(store).start(issue,{actor:"dashboard",source:"control"}),records=new WorkflowRecords(store),projections=new WorkflowProjections(store);
  store.db.prepare("INSERT INTO specs(work_item_id,version,body) VALUES(?,?,?)").run(started.id,1,"SPEC");
  records.create({workItemId:started.id,specVersion:1,scope:"spec",payload:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:10},sourceType:"agent-result",sourceId:"run",actor:"product-architect"});
  projections.transition({workItemId:started.id,expectedRevision:0,stage:"DESIGN",status:"WAITING",actor:{type:"agent",id:"product-architect"},source:{executionId:"run"},reason:{code:"spec",summary:"SPEC proposed"}});
  const inbox=new WorkflowInbox(store,{comments:()=>[comment(9,"/factory approve v1")]},["owner"]),result=inbox.poll(started.id);
  assert.equal(result.rejected,1);assert.equal(projections.get(started.id).status,"WAITING");
  assert.equal((store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='command.stale'").get() as {count:number}).count,1);
 } finally {store.db.close();}
});

test("GitHub cancel stops the active execution after cancelling the workflow",()=>{
 const store=new Store(":memory:");
 try {
  const started=new WorkflowIntake(store).start(issue,{actor:"owner",commentId:1,source:"github-comment"}),projections=new WorkflowProjections(store);
  store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at) VALUES('run-cancel',?,'product-architect','DESIGN','running','now')").run(started.id);
  projections.transition({workItemId:started.id,expectedRevision:0,stage:"DESIGN",status:"RUNNING",activeRunId:"run-cancel",actor:{type:"orchestrator",id:"scheduler"},source:{executionId:"run-cancel"},reason:{code:"start",summary:"Architect started"}});
  let cancelled=false;
  const executions={cancel(id:string){cancelled=id==="run-cancel";store.db.prepare("UPDATE executions SET status='cancelled' WHERE id=?").run(id);return true;}};
  const inbox=new (WorkflowInbox as any)(store,{comments:()=>[comment(2,"/factory cancel")]},["owner"],executions);
  inbox.poll(started.id);
  assert.equal(cancelled,true);
  assert.equal(projections.get(started.id).status,"CANCELLED");
  assert.equal((store.db.prepare("SELECT status FROM executions WHERE id='run-cancel'").get() as {status:string}).status,"cancelled");
 } finally {store.db.close();}
});

test("factory comments do not revise presentation while approver observations are counted",()=>{
 const store=new Store(":memory:");
 try {
  const started=new WorkflowIntake(store).start(issue,{actor:"owner",commentId:1,source:"github-comment"}),projections=new WorkflowProjections(store);
  const inbox=new WorkflowInbox(store,{comments:()=>[
   comment(2,"<!-- ai-factory:workflow-status:7 -->\nFactory status"),
   comment(3,"This may matter later"),
  ]},["owner"]);
  assert.deepEqual(inbox.poll(started.id),{seen:2,applied:0,rejected:0,observed:2,cursor:3});
  assert.equal(projections.get(started.id).presentationRevision,1);
  const context=JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id=?").get(started.id) as {context:string}).context);
  assert.deepEqual(context.observedComments,[{id:3,updatedAt:"2026-09-20T00:00:03Z"}]);
 } finally {store.db.close();}
});

test("an observed typo can be edited into a command on the same comment id",()=>{
 const store=new Store(":memory:"),comments=[comment(2,"/fatcory note use WebKit")];
 try {const started=new WorkflowIntake(store).start(issue,{actor:"owner",commentId:1,source:"github-comment"}),inbox=new WorkflowInbox(store,{comments:()=>comments},["owner"]);let result=inbox.poll(started.id);assert.deepEqual({observed:result.observed,applied:result.applied},{observed:1,applied:0});assert.match(workflowStatusMarkdown(store,started.id),/Unrecognized command `\/fatcory note`.*did you mean `\/factory note`/);comments[0]=comment(2,"/factory note use WebKit","owner","User","2026-09-20T00:01:00Z");result=inbox.poll(started.id);assert.equal(result.applied,1);assert.equal((store.db.prepare("SELECT json_extract(payload,'$.text') text FROM records WHERE kind='instruction'").get() as {text:string}).text,"use WebKit");assert.match(workflowStatusMarkdown(store,started.id),/`note` by @owner — applied/);}
 finally {store.db.close();}
});

test("an applied command is frozen when its comment is edited",()=>{
 const store=new Store(":memory:"),comments=[comment(11,"/factory approve v1")];
 try {const started=new WorkflowIntake(store).start(issue,{actor:"dashboard",source:"control"}),records=new WorkflowRecords(store),projections=new WorkflowProjections(store);store.db.prepare("INSERT INTO specs(work_item_id,version,body) VALUES(?,?,?)").run(started.id,1,"SPEC");records.create({workItemId:started.id,specVersion:1,scope:"spec",payload:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:1},sourceType:"agent-result",sourceId:"run",actor:"product-architect"});projections.transition({workItemId:started.id,expectedRevision:0,stage:"DESIGN",status:"WAITING",actor:{type:"agent",id:"product-architect"},source:{executionId:"run"},reason:{code:"spec",summary:"SPEC proposed"}});const inbox=new WorkflowInbox(store,{comments:()=>comments},["owner"]);assert.equal(inbox.poll(started.id).applied,1);comments[0]=comment(11,"/factory cancel","owner","User","2026-09-20T00:02:00Z");assert.equal(inbox.poll(started.id).seen,0);assert.equal(projections.get(started.id).status,"QUEUED");}
 finally {store.db.close();}
});

test("a later applied command freezes earlier observed prose edits",()=>{
 const store=new Store(":memory:"),comments=[comment(2,"Maybe use WebKit")];
 try {const started=new WorkflowIntake(store).start(issue,{actor:"owner",commentId:1,source:"github-comment"}),inbox=new WorkflowInbox(store,{comments:()=>comments},["owner"]);inbox.poll(started.id);comments.push(comment(3,"/factory note Confirm WebKit"));assert.equal(inbox.poll(started.id).applied,1);comments[0]=comment(2,"/factory cancel","owner","User","2026-09-20T00:03:00Z");assert.equal(inbox.poll(started.id).seen,0);assert.notEqual(new WorkflowProjections(store).get(started.id).status,"CANCELLED");}
 finally {store.db.close();}
});

test("pause preserves a waiting request and retry restores the human gate without a new attempt",()=>{
 const store=new Store(":memory:");
 try {
  const started=new WorkflowIntake(store).start(issue,{actor:"owner",commentId:1,source:"github-comment"}),records=new WorkflowRecords(store),projections=new WorkflowProjections(store);
  records.create({workItemId:started.id,specVersion:0,scope:"spec",payload:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:1},sourceType:"agent-result",sourceId:"run",actor:"product-architect"});
  projections.transition({workItemId:started.id,expectedRevision:0,stage:"DESIGN",status:"WAITING",actor:{type:"agent",id:"product-architect"},source:{executionId:"run"},reason:{code:"spec",summary:"SPEC proposed"}});
  const comments=[comment(2,"/factory pause")],inbox=new WorkflowInbox(store,{comments:()=>comments},["owner"]);
  inbox.poll(started.id);assert.equal(projections.get(started.id).status,"PAUSED");assert.equal(records.activeRequest(started.id)?.payload.kind,"request");
  comments.push(comment(3,"/factory retry"));inbox.poll(started.id);
  assert.deepEqual({status:projections.get(started.id).status,attempt:projections.get(started.id).attempt},{status:"WAITING",attempt:0});
 } finally {store.db.close();}
});

test("retry waits for a paused execution to exit without consuming the comment",()=>{
 const store=new Store(":memory:");
 try {
  const started=new WorkflowIntake(store).start(issue,{actor:"owner",commentId:1,source:"github-comment"}),projections=new WorkflowProjections(store),comments=[comment(2,"/factory pause")];
  store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at) VALUES('run-pause',?,'product-architect','DESIGN','running','now')").run(started.id);
  projections.transition({workItemId:started.id,expectedRevision:0,stage:"DESIGN",status:"RUNNING",activeRunId:"run-pause",actor:{type:"orchestrator",id:"scheduler"},source:{executionId:"run-pause"},reason:{code:"start",summary:"Architect started"}});
  const inbox=new WorkflowInbox(store,{comments:()=>comments},["owner"],{cancel(){return false;},interrupt(){return true;}});
  inbox.poll(started.id);assert.equal(projections.get(started.id).status,"PAUSED");
  comments.push(comment(3,"/factory retry"));
  const deferred=inbox.poll(started.id);
  assert.equal(deferred.cursor,2);assert.equal(deferred.rejected,0);assert.equal(projections.get(started.id).status,"PAUSED");
  assert.equal((store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='command.deferred'").get() as {count:number}).count,1);
  store.db.prepare("UPDATE executions SET status='interrupted',finished_at='now' WHERE id='run-pause'").run();
  const applied=inbox.poll(started.id);
  assert.deepEqual({cursor:applied.cursor,applied:applied.applied},{cursor:3,applied:1});
  assert.deepEqual({status:projections.get(started.id).status,attempt:projections.get(started.id).attempt},{status:"QUEUED",attempt:1});
 } finally {store.db.close();}
});

test("retry deferral expires after its fixed internal window",()=>{
 const store=new Store(":memory:");
 try {
  const started=new WorkflowIntake(store).start(issue,{actor:"owner",commentId:1,source:"github-comment"}),projections=new WorkflowProjections(store);
  store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at) VALUES('run-stuck',?,'product-architect','DESIGN','running','now')").run(started.id);
  projections.transition({workItemId:started.id,expectedRevision:0,stage:"DESIGN",status:"PAUSED",actor:{type:"human",id:"owner"},source:{commentId:1},reason:{code:"pause",summary:"Paused"}});
  store.event("command.deferred",{commentId:2,login:"owner",command:"retry",error:"still running",deferredAt:"2000-01-01T00:00:00.000Z"},started.id);
  const result=new WorkflowInbox(store,{comments:()=>[comment(2,"/factory retry")]},["owner"]).poll(started.id);
  assert.deepEqual({cursor:result.cursor,rejected:result.rejected,status:projections.get(started.id).status},{cursor:2,rejected:1,status:"PAUSED"});
  const rejection=JSON.parse((store.db.prepare("SELECT payload FROM events WHERE type='command.rejected' ORDER BY id DESC LIMIT 1").get() as {payload:string}).payload);
  assert.match(rejection.error,/deferral exceeded 1800000ms/);
 } finally {store.db.close();}
});

function pausedRunningScenario(followups:Comment[]) {
 const store=new Store(":memory:"),started=new WorkflowIntake(store).start(issue,{actor:"owner",commentId:1,source:"github-comment"}),projections=new WorkflowProjections(store),comments=[comment(2,"/factory pause")];
 store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at) VALUES('run-bypass',?,'product-architect','DESIGN','running','now')").run(started.id);
 projections.transition({workItemId:started.id,expectedRevision:0,stage:"DESIGN",status:"RUNNING",activeRunId:"run-bypass",actor:{type:"orchestrator",id:"scheduler"},source:{executionId:"run-bypass"},reason:{code:"start",summary:"Architect started"}});
 let cancelled:string|undefined;
 const inbox=new WorkflowInbox(store,{comments:()=>comments},["owner"],{cancel(id){cancelled=id;return true;},interrupt(){return true;}});
 inbox.poll(started.id);comments.push(...followups);
 return {store,started,projections,inbox,cancelled:()=>cancelled};
}

test("cancel bypasses a deferred retry and supersedes it atomically",()=>{
 const s=pausedRunningScenario([comment(3,"/factory retry"),comment(4,"/factory cancel")]);
 try {
  const result=s.inbox.poll(s.started.id);
  assert.equal(s.projections.get(s.started.id).status,"CANCELLED");assert.equal(s.cancelled(),"run-bypass");assert.equal(result.cursor,4);
  assert.equal((s.store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='command.deferred'").get() as {count:number}).count,1);
  const superseded=JSON.parse((s.store.db.prepare("SELECT payload FROM events WHERE type='command.superseded'").get() as {payload:string}).payload);
  assert.deepEqual({commentId:superseded.commentId,login:superseded.login,supersededBy:superseded.supersededBy},{commentId:3,login:"owner",supersededBy:4});
  assert.equal((s.store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='command.rejected'").get() as {count:number}).count,0);
 } finally {s.store.db.close();}
});

test("comments between deferred retry and cancel are consumed only as observed",()=>{
 const s=pausedRunningScenario([comment(3,"/factory retry"),comment(4,"/factory note Do not persist"),comment(5,"/factory cancel")]);
 try {
  const result=s.inbox.poll(s.started.id);
  assert.deepEqual({status:s.projections.get(s.started.id).status,cursor:result.cursor,observed:result.observed,cancelled:s.cancelled()},{status:"CANCELLED",cursor:5,observed:1,cancelled:"run-bypass"});
  assert.equal((s.store.db.prepare("SELECT COUNT(*) count FROM records WHERE kind='instruction'").get() as {count:number}).count,0);
 } finally {s.store.db.close();}
});

test("non-cancel commands remain blocked behind a deferred retry",()=>{
 const s=pausedRunningScenario([comment(3,"/factory retry"),comment(4,"/factory approve v1")]);
 try {
  const result=s.inbox.poll(s.started.id);
  assert.deepEqual({status:s.projections.get(s.started.id).status,cursor:result.cursor,applied:result.applied,rejected:result.rejected},{status:"PAUSED",cursor:2,applied:0,rejected:0});
  assert.equal(s.cancelled(),undefined);
 } finally {s.store.db.close();}
});

test("command outcomes are persisted and visible in the status comment",()=>{
 const store=new Store(":memory:");
 try {
  const started=new WorkflowIntake(store).start(issue,{actor:"dashboard",source:"control"}),records=new WorkflowRecords(store),projections=new WorkflowProjections(store),comments:Comment[]=[];
  store.db.prepare("INSERT INTO specs(work_item_id,version,body) VALUES(?,?,?)").run(started.id,2,"SPEC");
  records.create({workItemId:started.id,specVersion:2,scope:"spec",payload:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:10},sourceType:"agent-result",sourceId:"run",actor:"product-architect"});
  projections.transition({workItemId:started.id,expectedRevision:0,stage:"DESIGN",status:"WAITING",actor:{type:"agent",id:"product-architect"},source:{executionId:"run"},reason:{code:"spec",summary:"SPEC proposed"}});
  const inbox=new WorkflowInbox(store,{comments:()=>comments},["owner"]),before=projections.get(started.id).presentationRevision;
  comments.push(comment(11,"/factory approve v1"));inbox.poll(started.id);
  assert.equal(projections.get(started.id).presentationRevision,before+1);
  assert.match(workflowStatusMarkdown(store,started.id),/Last command \| `approve v1` by @owner — rejected: Approval is for v1; active specification is v2/);
  comments.push(comment(12,"/factory answer"));inbox.poll(started.id);
  assert.match(workflowStatusMarkdown(store,started.id),/Last command \| `unparsed` by @owner — rejected: \/factory answer requires guidance\. Post a new comment; edits to this one are not re-read\./);
  assert.equal(JSON.parse((store.db.prepare("SELECT payload FROM events WHERE type='command.rejected' ORDER BY id DESC LIMIT 1").get() as {payload:string}).payload).error,"/factory answer requires guidance. Post a new comment; edits to this one are not re-read.");
  comments.push(comment(13,"/factory revoke"));inbox.poll(started.id);
  assert.match(workflowStatusMarkdown(store,started.id),/Last command \| `unparsed` by @owner — rejected/);
  comments.push(comment(14,"/factory replace missing replacement"));inbox.poll(started.id);
  assert.match(workflowStatusMarkdown(store,started.id),/Last command \| `replace missing` by @owner — rejected: Active human guidance missing was not found/);
 } finally {store.db.close();}
});

test("applied answers and stale commands render their outcome",()=>{
 const store=new Store(":memory:");
 try {
  const started=new WorkflowIntake(store).start(issue,{actor:"dashboard",source:"control"}),records=new WorkflowRecords(store),projections=new WorkflowProjections(store),comments:Comment[]=[];
  records.create({workItemId:started.id,specVersion:0,scope:"spec",payload:{kind:"request",type:"clarification",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["DESIGN"],openedAfterCommentId:5},sourceType:"agent-result",sourceId:"run",actor:"product-architect"});
  projections.transition({workItemId:started.id,expectedRevision:0,stage:"DESIGN",status:"WAITING",actor:{type:"agent",id:"product-architect"},source:{executionId:"run"},reason:{code:"question",summary:"Question asked"}});
  const inbox=new WorkflowInbox(store,{comments:()=>comments},["owner"]);
  comments.push(comment(5,"/factory answer Too early"));inbox.poll(started.id);
  assert.match(workflowStatusMarkdown(store,started.id),/Last command \| `answer` by @owner — stale:/);
  comments.push(comment(6,"/factory answer Use SQLite"));inbox.poll(started.id);
  assert.match(workflowStatusMarkdown(store,started.id),/Last command \| `answer` by @owner — applied/);
 } finally {store.db.close();}
});

test("tactical decisions cannot be revoked and the rejection is visible",()=>{
 const store=new Store(":memory:");
 try {
  const started=new WorkflowIntake(store).start(issue,{actor:"dashboard",source:"control"}),records=new WorkflowRecords(store),tactical=records.create({workItemId:started.id,specVersion:0,scope:"spec",payload:{kind:"decision",category:"tactical",decision:"Use queues",rationale:"Architecture",supersedes:[]},sourceType:"agent-result",sourceId:"run",actor:"product-architect"});
  const result=new WorkflowInbox(store,{comments:()=>[comment(1,`/factory revoke ${tactical.id.slice(0,8)}`)]},["owner"]).poll(started.id);
  assert.equal(result.rejected,1);assert.match(workflowStatusMarkdown(store,started.id),/rejected: Record .* is not active human guidance; only instructions and human decisions may be changed/);
 } finally {store.db.close();}
});

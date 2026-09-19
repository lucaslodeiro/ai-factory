import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { WorkflowInbox,WorkflowIntake } from "../src/workflow-inbox.js";
import { WorkflowRecords } from "../src/workflow-records.js";
import { WorkflowProjections } from "../src/workflow-projection.js";
import type { Comment } from "../src/adapters/github.js";

const issue={number:7,title:"Inbox",body:"Build it",url:"https://github.com/owner/demo/issues/7",state:"OPEN" as const};
const comment=(id:number,body:string,login="owner",type="User"):Comment=>({id,body,user:{login,type}});

test("intake creates one initialized V3 item and audits its initial transition",()=>{
 const store=new Store(":memory:");
 try {
  const intake=new WorkflowIntake(store),first=intake.start(issue,{actor:"owner",commentId:10,source:"github-comment"}),again=intake.start(issue,{actor:"owner",commentId:10,source:"github-comment"});
  assert.equal(first.created,true);assert.deepEqual(again,{id:first.id,created:false});
  const projection=new WorkflowProjections(store).get(first.id);assert.deepEqual({stage:projection.stage,status:projection.status,revision:projection.revision},{stage:"DESIGN",status:"QUEUED",revision:0});
  const event=JSON.parse((store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='workflow.transition'").get(first.id) as {payload:string}).payload);
  assert.equal(event.from,null);assert.equal(event.reason.code,"work-started");assert.equal(event.source.commentId,10);
 } finally {store.db.close();}
});

test("inbox consumes commands once and records explicit human guidance",()=>{
 const store=new Store(":memory:");
 try {
  const started=new WorkflowIntake(store).start(issue,{actor:"dashboard",source:"control"}),comments=[comment(1,"Looks good"),comment(2,"/factory note --for tester Do not use Chromium"),comment(3,"/factory note ignored","stranger"),comment(4,"/factory bogus")];
  const inbox=new WorkflowInbox(store,{comments:()=>comments},["owner"]),result=inbox.poll(started.id);
  assert.deepEqual(result,{seen:4,applied:1,rejected:1,observed:2,cursor:4});
  const instruction=new WorkflowRecords(store).active(started.id,0,"qa").find(record=>record.kind==="instruction");assert.equal(instruction?.payload.kind==="instruction"&&instruction.payload.text,"Do not use Chromium");
  assert.equal(new WorkflowProjections(store).get(started.id).presentationRevision,2);
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

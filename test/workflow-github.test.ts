import {config} from "../src/config.js";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { Store } from "../src/storage.js";
import { WorkflowGitHubPublisher,payloadOf,withPayload,resultMarkdown,readIssueState,publishedText,publicationOf,resultPublicationKey,statusPublicationKey } from "../src/workflow-github.js";
import { WorkflowProjections } from "../src/workflow-projection.js";
import { WorkflowRecords } from "../src/workflow-records.js";
import { workflowLabels,workflowStatusMarkdown } from "../src/workflow-status.js";
import { WorkflowFailures } from "../src/workflow-failures.js";
import { result } from "./fixtures.js";
import { WorkflowInbox } from "../src/workflow-inbox.js";
import {issueStateIndex} from "../src/workflow-state.js";

const stagesForTest={DESIGN:"Design",BUILD:"Build",TEST:"Test",REVIEW:"Review",DELIVERY:"Delivery"} as const;
const statusesForTest={QUEUED:"Queued",RUNNING:"Running",WAITING:"Waiting for you",FAILED:"Failed",PAUSED:"Paused",CANCELLED:"Cancelled",COMPLETED:"Completed"} as const;
const nextAction=(body:string)=>body.match(/^## Next action\n\n([\s\S]*?)(?=\n\n<details><summary>All commands<\/summary>)/m)?.[0]??"";
const stableState=(value:any)=>{const copy=structuredClone(value);delete copy.publishedAt;return copy;};

function setup() {
 const store=new Store(":memory:");
 store.setMetadata("repository_identity",{id:1,nodeId:"R_1",fullName:"owner/demo"});
 store.db.prepare("INSERT INTO work_items(id,issue_number,issue_id,repo,branch,base_branch,created_at,updated_at,context) VALUES('work-1',7,700,'owner/demo','factory/issue-7','main','now','now',?)").run(JSON.stringify({title:"Readable workflow",issueNodeId:"I_700",specMarkers:{"2":"result-spec-fixture"}}));
 store.db.prepare("INSERT INTO specs(work_item_id,version,body) VALUES('work-1',2,'SPEC')").run();
 return {store,records:new WorkflowRecords(store),projections:new WorkflowProjections(store)};
}

test("hidden workflow payloads round trip text that could close an HTML comment",()=>{
 const value={summary:"keep --> literal"},body=withPayload("Readable",value);assert.match(body,/keep -\\u002d> literal/);assert.deepEqual(payloadOf(body),value);
});

test("continued work identifies its source instance and revision in the status comment",()=>{
 const s=setup();try{s.store.db.prepare("UPDATE work_items SET context=json_set(context,'$.continuedFrom.instance','old-mac','$.continuedFrom.revision',12) WHERE id='work-1'").run();s.projections.initialize("work-1","BUILD","PAUSED");assert.match(workflowStatusMarkdown(s.store,"work-1"),/Continuity \| Continued from old-mac at revision 12/);}finally{s.store.db.close();}
});

test("status projection has one current CTA and derives it from the active request",async()=>{
 const s=setup();
 try {
  s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:10},sourceType:"agent-result",sourceId:"run",actor:"product-architect"});
  s.records.create({workItemId:"work-1",specVersion:2,scope:"issue",payload:{kind:"instruction",text:"Keep it lightweight"},sourceType:"github-comment",sourceId:"9",actor:"owner"});
  s.projections.initialize("work-1","DESIGN","WAITING");
  const body=workflowStatusMarkdown(s.store,"work-1");
  assert.equal(body.match(/^## Next action$/gm)?.length,1);
  assert.match(body,/Current actor \| Human/);
  assert.match(body,/\/factory approve v2/);
  assert.match(body,/Active human guidance[\s\S]*Keep it lightweight/);
  assert.deepEqual(workflowLabels(s.store,"work-1").map(label=>label.name),["factory:design","factory:waiting"]);
 } finally {s.store.db.close();}
});

test("Architect-owned requests never render a human command",async()=>{
 const s=setup();
 try {
  s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"request",type:"tactical-decision",owner:"architect",originatingStage:"TEST",allowedReturnStages:["BUILD","TEST"],openedAfterCommentId:20},sourceType:"agent-result",sourceId:"run",actor:"qa"});
  s.projections.initialize("work-1","DESIGN","QUEUED");
  const body=workflowStatusMarkdown(s.store,"work-1");
  const action=body.split("<details><summary>All commands</summary>")[0];assert.match(action,/Architect is next/);assert.doesNotMatch(action,/\/factory answer|\/factory retry/);
 } finally {s.store.db.close();}
});

test("failed status explains the cause, identifies the execution and keeps one safe CTA",async()=>{
 const s=setup();
 try {
  s.store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at,finished_at,exit_code) VALUES('run-1','work-1','qa','TEST','failed','now','now',2)").run();
  new WorkflowFailures(s.store).open({workItemId:"work-1",executionId:"run-1",class:"execution",message:`Bearer ghp_fake failed at ${os.homedir()}/private/project`,stage:"TEST",attempt:3});
  s.projections.initialize("work-1","TEST","FAILED");
  const body=workflowStatusMarkdown(s.store,"work-1");
  assert.match(body,/### Failure details/);
  assert.match(body,/Failure class:\*\* execution/);
  assert.match(body,/Execution:\*\* `run-1`/);
  assert.match(body,/Agent subprocess failed|workflow rejected/i);
  assert.doesNotMatch(body,/ghp_fake/);
  assert.match(body,/~\/private\/project/);
  assert.equal(body.match(/^## Next action$/gm)?.length,1);
  assert.match(body,/\/factory retry/);
 } finally {s.store.db.close();}
});

test("every public workflow status has readable state, labels and one authoritative CTA",async()=>{
 const cases=[
  {stage:"DESIGN",status:"QUEUED",actor:"Architect",labels:["factory:design"],action:/next agent is queued/i},
  {stage:"DESIGN",status:"RUNNING",actor:"Architect",labels:["factory:design"],action:/current agent is running/i},
  {stage:"BUILD",status:"PAUSED",actor:"Human",labels:["factory:build","factory:paused"],action:/\/factory retry/},
  {stage:"TEST",status:"CANCELLED",actor:"Human",labels:["factory:test","factory:cancelled"],action:/\/factory retry/},
  {stage:"DELIVERY",status:"COMPLETED",actor:"None",labels:["factory:done"],action:/Delivery is complete/},
 ] as const;
 for(const entry of cases){
  const s=setup();
  try {
   s.projections.initialize("work-1",entry.stage,entry.status==="RUNNING"?"QUEUED":entry.status);
   if(entry.status==="RUNNING")s.projections.transition({workItemId:"work-1",expectedRevision:0,stage:entry.stage,status:"RUNNING",activeRunId:"run-public",actor:{type:"orchestrator",id:"test"},source:{executionId:"run-public"},reason:{code:"start",summary:"Agent started"}});
   const body=workflowStatusMarkdown(s.store,"work-1");
   assert.match(body,new RegExp(`Stage \\| ${stagesForTest[entry.stage]}`));
   assert.match(body,new RegExp(`Status \\| ${statusesForTest[entry.status]}`));
   assert.match(body,new RegExp(`Current actor \\| ${entry.actor}`));
   assert.match(body,entry.action);
   assert.equal(body.match(/^## Next action$/gm)?.length,1);
   assert.deepEqual(workflowLabels(s.store,"work-1").map(label=>label.name),entry.labels);
  } finally {s.store.db.close();}
 }
});

test("publisher writes only changed presentation revisions and retries after delivery failure",async()=>{
 const s=setup();
 try {
  s.projections.initialize("work-1","BUILD","QUEUED");
  const calls:Array<{issue:number;labels:string[];body:string}>=[];
  const publisher=new WorkflowGitHubPublisher(s.store,{syncWorkflow(issue,labels,body){calls.push({issue,labels:labels.map(label=>label.name),body});},publishWorkflowComment(){},assignees(){return[];},assign(){},unassign(){}});
  assert.equal(await publisher.publishChanged(),1);assert.equal(await publisher.publishChanged(),0);assert.equal(calls.length,1);
  assert.deepEqual(stableState(payloadOf(calls[0].body)),stableState(issueStateIndex(s.store,"work-1")));assert.equal("cwd" in ((payloadOf(calls[0].body) as any).context),false);
  assert.match(calls[0].body,/workflow-rev:0 · presentation-rev:0/);
  assert.match(calls[0].body,/Instance \|/);assert.match(calls[0].body,/<sub>instance:/);
  s.projections.present({workItemId:"work-1",expectedRevision:0,actor:{type:"orchestrator",id:"observer"},source:{},reason:{code:"evidence",summary:"Evidence changed"}});
  assert.equal(await publisher.publishChanged(),1);assert.equal(calls.length,2);assert.match(calls[1].body,/presentation-rev:1/);assert.deepEqual(stableState(payloadOf(calls[1].body)),stableState(issueStateIndex(s.store,"work-1")));

  s.projections.transition({workItemId:"work-1",expectedRevision:0,stage:"BUILD",status:"RUNNING",activeRunId:"run",actor:{type:"orchestrator",id:"scheduler"},source:{executionId:"run"},reason:{code:"start",summary:"Builder started"}});
  const failing=new WorkflowGitHubPublisher(s.store,{syncWorkflow(){throw new Error("GitHub unavailable");},publishWorkflowComment(){throw new Error("GitHub unavailable");},assignees(){return[];},assign(){},unassign(){}});
  await assert.rejects(async()=>await failing.publishChanged(),/GitHub unavailable/);
  assert.equal(s.projections.get("work-1").publishedPresentationRevision,1);
  assert.equal(await publisher.publishChanged(),1);assert.match(calls.at(-1)!.body,/event:[0-9a-f-]{36}/);
 } finally {s.store.db.close();}
});

test("an oversized state index is omitted and reported once",async()=>{
 const s=setup();try{s.projections.initialize("work-1","BUILD","QUEUED");s.records.create({workItemId:"work-1",specVersion:2,scope:"issue",payload:{kind:"instruction",text:"x".repeat(61_000)},sourceType:"github-comment",sourceId:"1",actor:"owner"});let body="";const publisher=new WorkflowGitHubPublisher(s.store,{syncWorkflow(_issue,_labels,value){body=value;},publishWorkflowComment(){return 1;}});await publisher.publishChanged();assert.equal(payloadOf(body),null);assert.equal((s.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='github.state_too_large'").get() as {n:number}).n,1);}finally{s.store.db.close();}
});

test("a state with an unpublished specification is omitted and reported once",async()=>{
 const s=setup();try{s.projections.initialize("work-1","DESIGN","QUEUED");s.store.db.prepare("UPDATE work_items SET context=json_remove(context,'$.specMarkers') WHERE id='work-1'").run();let body="";const publisher=new WorkflowGitHubPublisher(s.store,{syncWorkflow(_issue,_labels,value){body=value;},publishWorkflowComment(){return 1;}});await publisher.publishChanged();assert.equal(payloadOf(body),null);assert.equal((s.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='github.state_incomplete'").get() as {n:number}).n,1);s.store.db.prepare("UPDATE work_items SET published_presentation_revision=NULL WHERE id='work-1'").run();await publisher.publishChanged();assert.equal((s.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='github.state_incomplete'").get() as {n:number}).n,1);}finally{s.store.db.close();}
});

test("publisher keeps intermediate delivery results in status and publishes only milestone comments",async()=>{
 const s=setup();
 try {
  s.projections.initialize("work-1","DESIGN","QUEUED");
  s.store.event("agent.result",{role:"developer",result:result("pass",{summary:"Builder completed implementation"}),specVersion:2},"work-1","run-builder");
  s.store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment) VALUES(?,?,?,?,?)").run("work-1",3,"Stored specification",JSON.stringify([{id:"AC-1",description:"Works"}]),JSON.stringify({complexity:"medium",risk:"low",verificationDepth:"thorough",rationale:"Bounded"}));
  s.store.event("agent.result",{role:"product-architect",result:result("spec",{summary:"Specification is ready"}),specVersion:3},"work-1","run-architect");
  const comments:Array<{key:string;body:string}>=[];
  const publisher=new WorkflowGitHubPublisher(s.store,{syncWorkflow(){},publishWorkflowComment(_issue,key,body){comments.push({key,body});},assignees(){return[];},assign(){},unassign(){}});
  assert.equal(await publisher.publishResults(),1);
  assert.deepEqual(comments.map(comment=>comment.key),["result-run-architect"]);
  assert.equal(await publisher.publishResults(),0);
  assert.deepEqual(payloadOf(comments[0].body),{kind:"spec",version:3,body:"Stored specification",criteria:[{id:"AC-1",description:"Works"}],stories:[],assessment:{complexity:"medium",risk:"low",verificationDepth:"thorough",rationale:"Bounded"}});
  assert.equal(JSON.parse((s.store.db.prepare("SELECT context FROM work_items WHERE id='work-1'").get() as {context:string}).context).specMarkers["3"],"result-run-architect");
  assert.match(workflowStatusMarkdown(s.store,"work-1"),/Latest delivery summary[\s\S]*Builder completed implementation/);
 } finally {s.store.db.close();}
});

test("status clips a verbose delivery summary and preserves one authoritative next action",async()=>{
 const s=setup();
 try {
  s.projections.initialize("work-1","BUILD","QUEUED");
  s.store.event("agent.result",{role:"developer",result:result("pass",{summary:"x".repeat(10_000)}),specVersion:2},"work-1","run-verbose");
  const body=workflowStatusMarkdown(s.store,"work-1"),section=body.match(/### Latest delivery summary([\s\S]*?)(?:\n\n<details>|\n\n## Next action)/)?.[0]??"";
  assert.ok(section.length<=1600,`summary section was ${section.length} characters`);
  assert.match(section,/…/);assert.match(section,/execution `run-verbose` in the dashboard/);
  assert.equal(body.match(/^## Next action$/gm)?.length,1);
 } finally {s.store.db.close();}
});

test("help publishes one immutable reference and status keeps the same collapsed list",async()=>{
 const s=setup(),comments=[{id:11,body:"/factory help",user:{login:"owner",type:"User"},updatedAt:"2026-09-20T00:00:11Z"}];
 try {
  s.projections.initialize("work-1","BUILD","QUEUED");
  const inbox=new WorkflowInbox(s.store,{comments:()=>comments},["owner"]);assert.equal(inbox.poll("work-1").applied,1);
  const published:Array<{key:string;body:string}>=[];
  const publisher=new WorkflowGitHubPublisher(s.store,{syncWorkflow(){},publishWorkflowComment(_issue,key,body){published.push({key,body});},assignees(){return[];},assign(){},unassign(){}});
  assert.equal(await publisher.publishHelp(),1);assert.equal(published[0].key,"help");assert.match(published[0].body,/\/factory replace/);
  comments.push({id:12,body:"/factory help",user:{login:"owner",type:"User"},updatedAt:"2026-09-20T00:00:12Z"});assert.equal(inbox.poll("work-1").applied,1);
  assert.equal(await publisher.publishHelp(),0);assert.equal(published.length,1);
  const status=workflowStatusMarkdown(s.store,"work-1");assert.match(status,/<details><summary>All commands<\/summary>/);assert.match(status,/\/factory cancel/);assert.equal(status.match(/^## Next action$/gm)?.length,1);
 } finally {s.store.db.close();}
});

test("every workflow CTA shows the exact valid commands and text semantics",async()=>{
 const requestCase=(type:"spec-approval"|"clarification"|"correction-limit"|"merge")=>{const s=setup();s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"request",type,owner:"human",originatingStage:type==="merge"?"DELIVERY":"DESIGN",allowedReturnStages:type==="merge"?["DELIVERY"]:["DESIGN","BUILD"],openedAfterCommentId:10},sourceType:"orchestrator",sourceId:type,actor:"orchestrator"});s.projections.initialize("work-1",type==="merge"?"DELIVERY":"DESIGN","WAITING");return s;};
 for(const [type,patterns] of [
  ["spec-approval",[/\/factory approve v2 \[guidance\]/,/\/factory answer <feedback>/,/spec-scoped instruction/,/human decision/]],
  ["clarification",[/\/factory answer <guidance>/,/human decision/]],
  ["correction-limit",[/\/factory answer <guidance>/,/human decision/]],
  ["merge",[/Merge.*GitHub/s,/\/factory answer <changes>/,/auto-fix finding for Builder/]],
 ] as const){const s=requestCase(type);try{const action=nextAction(workflowStatusMarkdown(s.store,"work-1"));for(const pattern of patterns)assert.match(action,pattern);assert.equal(action.match(/^## Next action$/gm)?.length,1);}finally{s.store.db.close();}}
 for(const status of ["FAILED","PAUSED","CANCELLED"] as const){const s=setup();try{if(status==="FAILED")new WorkflowFailures(s.store).open({workItemId:"work-1",class:"execution",message:"failed",stage:"TEST",attempt:0});s.projections.initialize("work-1",status==="FAILED"?"TEST":"BUILD",status);const action=nextAction(workflowStatusMarkdown(s.store,"work-1"));assert.match(action,/\/factory retry \[--issue\] \[--for <roles>\] \[guidance\]/);assert.match(action,/current SPEC/);assert.equal(action.match(/^## Next action$/gm)?.length,1);}finally{s.store.db.close();}}
 for(const status of ["QUEUED","RUNNING"] as const){const s=setup();try{s.projections.initialize("work-1","BUILD","QUEUED");if(status==="RUNNING")s.projections.transition({workItemId:"work-1",expectedRevision:0,stage:"BUILD",status:"RUNNING",activeRunId:"run",actor:{type:"orchestrator",id:"scheduler"},source:{executionId:"run"},reason:{code:"start",summary:"Started"}});const action=nextAction(workflowStatusMarkdown(s.store,"work-1"));assert.match(action,/No human action is required/);assert.match(action,/\/factory pause \[reason\]/);assert.match(action,/\/factory cancel \[reason\]/);assert.equal(action.match(/^## Next action$/gm)?.length,1);}finally{s.store.db.close();}}
});

test("correction limit CTA names the findings that need human guidance",async()=>{
 const s=setup();try{const finding=s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"finding",classification:"auto-fix",severity:"major",originRole:"qa",evidence:"The standings table still sorts oldest first"},sourceType:"agent-result",sourceId:"run-q",actor:"qa"});s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"request",type:"correction-limit",owner:"human",originatingStage:"TEST",allowedReturnStages:["BUILD","TEST"],openedAfterCommentId:10,findingIds:[finding.id]},sourceType:"orchestrator",sourceId:"limit",actor:"orchestrator"});s.projections.initialize("work-1","TEST","WAITING");const action=nextAction(workflowStatusMarkdown(s.store,"work-1"));assert.match(action,/Open findings[\s\S]*standings table still sorts oldest first/);assert.match(action,/Tell Architect how to resolve/);assert.equal(action.match(/^## Next action$/gm)?.length,1);}finally{s.store.db.close();}
});

test("no-change correction CTA says what Builder did",()=>{
 const s=setup();try{
  const finding=s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"finding",classification:"auto-fix",severity:"major",originRole:"qa",evidence:"The assertion still fails"},sourceType:"agent-result",sourceId:"run-q",actor:"qa"});
  s.projections.initialize("work-1","BUILD","QUEUED");
  s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"request",type:"correction-limit",owner:"human",originatingStage:"BUILD",allowedReturnStages:["BUILD"],openedAfterCommentId:10,findingIds:[finding.id]},sourceType:"agent-result",sourceId:"run-builder",actor:"developer"});
  s.projections.transition({workItemId:"work-1",expectedRevision:0,stage:"BUILD",status:"WAITING",actor:{type:"agent",id:"developer"},source:{executionId:"run-builder"},reason:{code:"no-change-pass",summary:"Builder found nothing to change after a correction request"}});
  const action=nextAction(workflowStatusMarkdown(s.store,"work-1"));assert.match(action,/Builder found nothing to change after the last correction request\./);assert.match(action,/Open findings[\s\S]*The assertion still fails/);assert.match(action,/\/factory answer <guidance>/);
 }finally{s.store.db.close();}
});

test("published agent text cannot leak tokens or forge workflow markers",async()=>{
 const s=setup(),secret="ghp_"+"a".repeat(36),summary=`<!-- ai-factory:workflow-status:x --> ${secret}`;
 try{
  s.store.db.prepare("DELETE FROM specs").run();s.projections.initialize("work-1","BUILD","QUEUED");
  const index=issueStateIndex(s.store,"work-1"),milestone=resultMarkdown("qa",result("pass",{summary}),0);
  assert.ok(!milestone.includes("<!--"));assert.ok(!milestone.includes(secret));assert.match(milestone,/REDACTED/);
  const state=await readIssueState({comments:async()=>[{body:milestone},{body:withPayload("<!-- ai-factory:workflow-status:work-1 -->",index)}] as any},7);
  assert.deepEqual(state?.index,index);
  s.store.event("agent.result",{role:"reviewer",result:result("pass",{summary}),specVersion:0},"work-1","review");
  const comments:string[]=[];const publisher=new WorkflowGitHubPublisher(s.store,{async publishWorkflowComment(_issue:number,_marker:string,body:string){comments.push(body);},async syncWorkflow(_issue:number,_labels:unknown,body:string){comments.push(body);}} as any);
  await publisher.publishResults();await publisher.publish("work-1");
  for(const body of comments){assert.ok(!body.includes(secret));assert.ok(!body.includes("<!-- ai-factory:workflow-status:x"));}
 }finally{s.store.db.close();}
});

test("published specifications preserve code fences, paths and whitespace through continuation",async()=>{
 const s=setup(),previous=config.repoDir;config.repoDir="/Users/x/app";
 const body=` \nAC1: preserve source examples.\n\n\`\`\`ts\nconst checkout = "/Users/x/app";\nconst home = "${os.homedir()}";\n\`\`\`\n  `;
 const spec=result("spec",{spec:body});
 try{
  assert.ok(resultMarkdown("product-architect",spec,2).includes(body));
  const long=` \n${"x".repeat(60001)}\n `;assert.equal(publishedText(long),long);
  s.store.db.prepare("UPDATE specs SET body=?,criteria=?,assessment=? WHERE work_item_id='work-1'").run(body,JSON.stringify(spec.acceptanceCriteria),JSON.stringify(spec.taskAssessment));
  s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:0},sourceType:"agent-result",sourceId:"spec-fixture",actor:"product-architect"});
  s.projections.initialize("work-1","DESIGN","WAITING");s.store.event("agent.result",{role:"product-architect",result:spec,specVersion:2},"work-1","spec-fixture");
  const comments:Array<{body:string}>=[];
  const publisher=new WorkflowGitHubPublisher(s.store,{async publishWorkflowComment(_issue:number,marker:string,text:string){comments.push({body:`${text}\n<!-- ai-factory:workflow-comment:${marker} -->`});},async syncWorkflow(_issue:number,_labels:unknown,text:string){comments.push({body:`${text}\n<!-- ai-factory:workflow-status:work-1 -->`});}} as any);
  await publisher.publishResults();await publisher.publish("work-1");
  assert.ok(comments[0].body.includes(body));
  const state=await readIssueState({comments:async()=>comments as any},7);assert.equal(state?.specs[0].body,body);
 }finally{config.repoDir=previous;s.store.db.close();}
});

test("a milestone that cannot be published keeps its attempts, never blocks other work items and publishes once after recovery",async()=>{
 const s=setup();
 try {
  s.store.db.prepare("INSERT INTO work_items(id,issue_number,issue_id,repo,branch,base_branch,created_at,updated_at,context) VALUES('work-2',8,800,'owner/demo','factory/issue-8','main','now','now',?)").run(JSON.stringify({title:"Second item",issueNodeId:"I_800",specMarkers:{}}));
  s.projections.initialize("work-1","DESIGN","QUEUED");s.projections.initialize("work-2","DESIGN","QUEUED");
  s.store.event("agent.result",{role:"product-architect",result:result("questions",{questions:["Which database?"]}),specVersion:2},"work-1","run-1");
  s.store.event("agent.result",{role:"product-architect",result:result("questions",{questions:["Which queue?"]}),specVersion:0},"work-2","run-2");
  const eventId=(item:string)=>(s.store.db.prepare("SELECT id FROM events WHERE type='agent.result' AND work_item_id=?").get(item) as {id:number}).id;
  const count=(type:string,item:string)=>(s.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type=? AND work_item_id=?").get(type,item) as {n:number}).n;
  const published:string[]=[];let issue7Down=true;
  const publisher=new WorkflowGitHubPublisher(s.store,{syncWorkflow(issue){if(issue===7&&issue7Down)throw new Error("GitHub unavailable");return issue*10;},publishWorkflowComment(issue,key){if(issue===7&&issue7Down)throw new Error("GitHub unavailable");published.push(`${issue}:${key}`);return issue*100;},assignees(){return[];},assign(){},unassign(){}});
  await assert.rejects(async()=>await publisher.publishResults(),/GitHub unavailable/);
  assert.deepEqual(published,["8:result-run-2"]);
  assert.deepEqual(publicationOf(s.store,resultPublicationKey(eventId("work-2"))),{status:"published",commentId:800,url:"https://github.com/owner/demo/issues/8#issuecomment-800",publishedAt:(publicationOf(s.store,resultPublicationKey(eventId("work-2"))) as any).publishedAt});
  const failed=publicationOf(s.store,resultPublicationKey(eventId("work-1")));
  assert.equal(failed?.status,"failed");assert.equal((failed as any).attempts,1);assert.equal((failed as any).error,"GitHub unavailable");
  assert.equal(count("github.publish_failed","work-1"),1);assert.equal(count("github.publish_failed","work-2"),0);
  assert.equal(count("github.published","work-2"),1);assert.equal(count("github.published","work-1"),0);
  assert.deepEqual(JSON.parse((s.store.db.prepare("SELECT payload FROM events WHERE type='github.published' AND work_item_id='work-2'").get() as {payload:string}).payload),{issue:8,key:resultPublicationKey(eventId("work-2")),kind:"result",commentId:800,url:"https://github.com/owner/demo/issues/8#issuecomment-800"});
  await assert.rejects(async()=>await publisher.publishResults(),/GitHub unavailable/);await assert.rejects(async()=>await publisher.publishResults(),/GitHub unavailable/);
  assert.equal((publicationOf(s.store,resultPublicationKey(eventId("work-1"))) as any).attempts,3);
  assert.equal(count("github.publish_failed","work-1"),1);assert.equal(count("github.publish_stalled","work-1"),1);
  assert.deepEqual(published,["8:result-run-2"]);
  await assert.rejects(async()=>await publisher.publishChanged(),/GitHub unavailable/);
  assert.equal(s.projections.get("work-2").publishedPresentationRevision,0);assert.equal(s.projections.get("work-1").publishedPresentationRevision,undefined);
  assert.equal(publicationOf(s.store,statusPublicationKey("work-2"))?.status,"published");assert.equal(publicationOf(s.store,statusPublicationKey("work-1"))?.status,"failed");
  issue7Down=false;
  assert.equal(await publisher.publishResults(),1);assert.deepEqual(published,["8:result-run-2","7:result-run-1"]);
  assert.equal(publicationOf(s.store,resultPublicationKey(eventId("work-1")))?.status,"published");assert.equal((publicationOf(s.store,resultPublicationKey(eventId("work-1"))) as any).url,"https://github.com/owner/demo/issues/7#issuecomment-700");
  assert.equal(await publisher.publishResults(),0);assert.equal(published.length,2);
  assert.equal(await publisher.publishChanged(),1);assert.equal(s.projections.get("work-1").publishedPresentationRevision,0);
  assert.equal(count("github.published","work-1"),2,"one confirmation for the milestone and one for the status comment");
  assert.deepEqual(publicationOf(s.store,statusPublicationKey("work-1")),{status:"published",commentId:70,url:"https://github.com/owner/demo/issues/7#issuecomment-70",publishedAt:(publicationOf(s.store,statusPublicationKey("work-1")) as any).publishedAt});
 } finally {s.store.db.close();}
});

test("a brief comment carries the decisions and the approval command, and no criteria or SPEC",()=>{
 const body=resultMarkdown("product-architect",result("brief",{brief:"## Decisions for you\n**D1. Keep v1 clients?** Recommended: yes."}),3);
 assert.match(body,/^# Brief v3 — awaiting approval/m);
 const brief=body.indexOf("### Decisions for you"),action=body.indexOf("## Next action");
 assert.ok(brief>0&&brief<action,"the brief comes before the approval command");
 assert.doesNotMatch(body,/## Acceptance criteria|<details>/);
 assert.match(body,/Approving accepts every recommendation above\. Architect then writes the detailed specification/);
 assert.match(body,/`\/factory approve v3 \[guidance\]`/);
 assert.equal((body.match(/## Next action/g)??[]).length,1);
});

test("a spec comment lists its criteria, says what starts next and folds the full SPEC away without asking for approval",()=>{
 const body=resultMarkdown("product-architect",result("spec",{spec:"# Specification\n## Technical Design\nAC1: returns 42"}),3);
 assert.match(body,/^# Specification v3 — delivery started/m);
 const criteria=body.indexOf("## Acceptance criteria"),action=body.indexOf("## Next action"),folded=body.indexOf("<details>\n<summary>Full technical specification v3");
 assert.ok(criteria>0&&criteria<action&&action<folded);
 assert.match(body.slice(folded),/### Technical Design/);
 assert.match(body,/The Builder starts from this specification/);
 assert.doesNotMatch(body,/\/factory approve/);
});

test("a significant UX change sends the spec to a prototype, whose screenshots link to the approved commit",()=>{
 const spec=resultMarkdown("product-architect",result("spec"),2,undefined,{prototypeFollows:true});
 assert.match(spec,/^# Specification v2 — prototype in progress/m);assert.doesNotMatch(spec,/\/factory approve/);
 const prototype=resultMarkdown("designer",result("pass",{tests:[],coverage:[],changedFiles:[".factory/prototype/01-main flow.png",".factory/prototype/README.md"],summary:"Look at the empty state first."}),2,undefined,{prototype:{repo:"owner/demo",head:"abc123"}});
 assert.match(prototype,/^# Prototype for SPEC v2 — awaiting approval/m);
 assert.match(prototype,/!\[01-main flow\.png\]\(https:\/\/github\.com\/owner\/demo\/blob\/abc123\/\.factory\/prototype\/01-main%20flow\.png\?raw=true\)/);
 assert.match(prototype,/\[\.factory\/prototype\/README\.md\]\(https:\/\/github\.com\/owner\/demo\/blob\/abc123\/\.factory\/prototype\/README\.md\)/);
 assert.match(prototype,/\*\*Approve the prototype and SPEC v2\*\*/);
 assert.match(prototype,/`\/factory approve v2 \[guidance\]`/);
 assert.equal((prototype.match(/## Next action/g)??[]).length,1);
});

test("a Designer-owned prototype request tells the human to wait without a command",()=>{
 const s=setup();
 try {
  s.records.create({workItemId:"work-1",specVersion:2,scope:"spec",payload:{kind:"request",type:"prototype",owner:"designer",originatingStage:"DESIGN",allowedReturnStages:["DESIGN"],openedAfterCommentId:20},sourceType:"agent-result",sourceId:"run",actor:"product-architect"});
  s.projections.initialize("work-1","DESIGN","QUEUED");
  const action=workflowStatusMarkdown(s.store,"work-1").split("<details><summary>All commands</summary>")[0];
  assert.match(action,/Designer is preparing a prototype/);assert.doesNotMatch(action,/\/factory (answer|approve|retry)/);
 } finally {s.store.db.close();}
});

test("a split specification shows every story, its criteria and what it waits for next to the approval",()=>{
 const body=resultMarkdown("product-architect",result("spec",{acceptanceCriteria:[{id:"AC1",description:"Tokens"},{id:"AC2",description:"Hero | banner"},{id:"AC3",description:"Whole page"}],spec:"# Spec\nAC1 AC2 AC3",stories:[{key:"S1",title:"Design tokens",scope:"Palette and spacing",criteria:["AC1"],dependsOn:[],assessment:{complexity:"low",risk:"low",verificationDepth:"minimal"}},{key:"S2",title:"Hero",scope:"First screen",criteria:["AC2"],dependsOn:["S1"],assessment:{complexity:"medium",risk:"low",verificationDepth:"standard"}}]}),2);
 const stories=body.indexOf("## Stories"),criteria=body.indexOf("## Acceptance criteria"),action=body.indexOf("## Next action");
 assert.ok(criteria<stories&&stories<action,"stories sit between the criteria and the approval command");
 assert.match(body,/\| \*\*S2\*\* Hero \| First screen \| AC2 \| S1 \| low · standard \|/);
 assert.match(body,/\| \*\*S1\*\* Design tokens \| Palette and spacing \| AC1 \| — \| low · minimal \|/);
 assert.match(body,/Verified on the whole, after every story: AC3\./);
 assert.doesNotMatch(resultMarkdown("product-architect",result("spec"),1),/## Stories/);
});

test("a Tester report shows the kept tests and folds the discarded candidates with their reasons",()=>{
 const body=resultMarkdown("qa",result("pass",{testCandidates:[{name:"happy",covers:["AC1"],value:"essential",kept:true,reason:"only criterion"},{name:"dup | alias",covers:["AC1"],value:"redundant",kept:false,reason:"same as happy"}]}),1);
 assert.match(body,/## Test selection\n\n1 of 2 candidates kept\./);assert.match(body,/\| happy \| AC1 \| essential \| only criterion \|/);
 assert.match(body,/<summary>Discarded \(1\)<\/summary>/);assert.match(body,/\*\*dup \\\| alias\*\* \(redundant, covers AC1\) — same as happy/);
 assert.doesNotMatch(resultMarkdown("developer",result("pass",{testCandidates:[]}),1),/## Test selection/);
});

test("the status names the Designer while it prepares the prototype, and a person once the item has failed",()=>{
 const store=new Store(":memory:");
 try {
  store.setMetadata("repository_identity",{id:1,nodeId:"R_1",fullName:"owner/demo"});
  store.db.prepare("INSERT INTO work_items(id,issue_number,issue_id,repo,branch,base_branch,created_at,updated_at,context) VALUES('w',9,900,'owner/demo','factory/issue-9','main','now','now',?)").run(JSON.stringify({title:"Prototype",issueNodeId:"I_9"}));
  const projections=new WorkflowProjections(store);projections.initialize("w","DESIGN","QUEUED");
  new WorkflowRecords(store).create({workItemId:"w",specVersion:1,scope:"spec",payload:{kind:"request",type:"prototype",owner:"designer",originatingStage:"DESIGN",allowedReturnStages:["DESIGN"],openedAfterCommentId:0},sourceType:"agent-result",sourceId:"x",actor:"product-architect"});
  assert.match(workflowStatusMarkdown(store,"w"),/Current actor \| Designer/);
  const current=projections.get("w");projections.transition({workItemId:"w",expectedRevision:current.revision,stage:"DESIGN",status:"FAILED",actor:{type:"orchestrator",id:"runner"},source:{},reason:{code:"invalid-result",summary:"x"}},()=>{new WorkflowFailures(store).open({workItemId:"w",class:"invalid-result",message:"x",stage:"DESIGN",attempt:0});});
  assert.match(workflowStatusMarkdown(store,"w"),/Current actor \| Human/);
 } finally {store.db.close();}
});

test("a brief is published without a Decisions section repeating its assumptions, while a spec keeps it",()=>{
 const decisions=[{kind:"tactical" as const,decision:"Use a native details element for the language menu",rationale:"Works without JS",conflictsWithHuman:false,supersedes:[]}];
 const brief=resultMarkdown("product-architect",{...result("brief"),decisions},1);
 assert.match(brief,/^# Brief v1 — awaiting approval/m);assert.doesNotMatch(brief,/^## Decisions$|native details element/m);
 const spec=resultMarkdown("product-architect",{...result("spec"),decisions},1);
 assert.match(spec,/## Decisions\n\n- \*\*tactical\*\* — Use a native details element/);
});

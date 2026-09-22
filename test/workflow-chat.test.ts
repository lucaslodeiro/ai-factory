import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {Store} from "../src/storage.js";
import {config} from "../src/config.js";
import {workflowThread,promptArtifact,messageActions,applyMessageControl,applyInterruptRetryControl,statusPublication} from "../src/workflow-chat.js";
import {resultPublicationKey,failurePublicationKey,statusPublicationKey} from "../src/workflow-github.js";
import {WorkflowFailures} from "../src/workflow-failures.js";
import {result} from "./fixtures.js";
import {WorkflowRecords} from "../src/workflow-records.js";
import {WorkflowRunner} from "../src/workflow-runner.js";
import {ContextAssembler} from "../src/context-assembly.js";
import {WorkflowProjections} from "../src/workflow-projection.js";

test("workflow thread orders prompts, results, transitions, failures and human interventions without paths",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"workflow-chat-")),previous=config.dataDir;config.dataDir=root;const store=new Store(":memory:");try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',1,'owner/demo','now','now','{}','TEST','FAILED')").run();
  store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at,finished_at) VALUES('run','w','qa','TEST','failed','now','now')").run();
  const runDir=path.join(root,"runs","run");fs.mkdirSync(runDir,{recursive:true});fs.writeFileSync(path.join(runDir,"prompt.md"),"secret prompt");fs.writeFileSync(path.join(runDir,"prompt.json"),JSON.stringify({sectionBytes:{Issue:20},budgetBytes:1000,includedRecordIds:["r1"],cwd:"/private/path",logDir:"/private/log"}));
  store.event("execution.started",{role:"qa",selection:{provider:"codex",model:"auto"},cwd:"/private/path",logDir:"/private/log"},"w","run");store.event("agent.result",{role:"qa",result:result("changes"),specVersion:1},"w","run");store.event("workflow.transition",{to:{stage:"TEST",status:"FAILED"},reason:{summary:"Tests failed"},actor:{type:"orchestrator",id:"runner"}},"w","run");store.event("command.rejected",{commentId:7,login:"owner",command:"retry",error:"still running"},"w");
  const turns=workflowThread(store,"w");assert.deepEqual(turns.map(turn=>turn.kind),["prompt","result","event","human"]);assert.equal(turns[0].available,true);assert.deepEqual((turns[0].manifest as any).sections,{Issue:20});assert.equal(JSON.stringify(turns).includes("/private/"),false);assert.match(String(turns[1].markdown),/Verification Engineer report/);assert.equal(turns[3].login,"owner");
  fs.unlinkSync(path.join(runDir,"prompt.md"));assert.equal(workflowThread(store,"w")[0].available,false);
 }finally{store.db.close();config.dataDir=previous;fs.rmSync(root,{recursive:true,force:true});}
});

test("workflow thread explains timeouts without execution identifiers or cancellation reasons",()=>{
 const store=new Store(":memory:");try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',1,'owner/demo','now','now','{}','BUILD','FAILED')").run();
  store.event("workflow.transition",{to:{stage:"BUILD",status:"FAILED"},reason:{summary:"Execution 8a639fd5-3622-4f4f-9794-aa0620de626b timed_out"},actor:{type:"orchestrator",id:"runner"}},"w","run");
  store.event("execution.finished",{status:"timed_out",interruptionReason:"user-cancel"},"w","run");
  const rendered=workflowThread(store,"w").map(turn=>String(turn.reason)).join("\n");
  assert.match(rendered,/Builder execution exceeded its time limit/);assert.doesNotMatch(rendered,/8a639fd5|user-cancel|timed_out/);
 }finally{store.db.close();}
});

test("prompt artifact caps full text at 512 KiB and reports pruning",()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),"workflow-prompt-")),previous=config.dataDir;config.dataDir=root;try{const dir=path.join(root,"runs","run");fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,"prompt.md"),"x".repeat(600*1024));const artifact=promptArtifact("run");assert.equal(artifact.available,true);assert.equal(artifact.truncated,true);assert.equal(Buffer.byteLength(artifact.prompt!),512*1024);assert.equal("logDir" in artifact,false);fs.unlinkSync(path.join(dir,"prompt.md"));assert.deepEqual(promptArtifact("run"),{available:false});}finally{config.dataDir=previous;fs.rmSync(root,{recursive:true,force:true});}});

test("message actions are derived only from workflow state and active request",()=>{
 const request=(type:string)=>({payload:{kind:"request",type}}) as any;
 assert.deepEqual(messageActions({status:"WAITING"},request("clarification")),["answer"]);
 assert.deepEqual(messageActions({status:"WAITING"},request("correction-limit")),["answer"]);
 assert.deepEqual(messageActions({status:"WAITING"},request("spec-approval")),["approve","answer"]);
 assert.deepEqual(messageActions({status:"WAITING"},request("merge")),["answer"]);
 assert.deepEqual(messageActions({status:"FAILED"}),["retry","note"]);assert.deepEqual(messageActions({status:"FAILED"},undefined,true),["answer","retry","note"]);for(const status of ["PAUSED","CANCELLED"] as const)assert.deepEqual(messageActions({status}),["retry","note"]);
 assert.deepEqual(messageActions({status:"RUNNING"}),["note","interrupt-retry"]);assert.deepEqual(messageActions({status:"QUEUED"}),["note"]);assert.deepEqual(messageActions({status:"COMPLETED"}),[]);
});

function chatItem(status:string="WAITING",requestType?:"clarification"|"spec-approval"|"merge"){
 const store=new Store(":memory:");store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',7,'owner/demo','now','now','{}','DESIGN',?)").run(status);store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria) VALUES('w',1,'spec','[]')").run();
 if(requestType)new WorkflowRecords(store).create({workItemId:"w",specVersion:1,scope:"spec",payload:{kind:"request",type:requestType,owner:"human",originatingStage:"DESIGN",allowedReturnStages:["DESIGN"],openedAfterCommentId:10},sourceType:"orchestrator",sourceId:"request",actor:"orchestrator"});return store;
}
class ChatGitHub {published:Array<{key:string;body:string}>=[];edited:Array<{id:number;body:string}>=[];constructor(private commentId=20){}publishWorkflowComment(_issue:number,key:string,body:string){this.published.push({key,body:`${body}\n\n<!-- ai-factory:workflow-comment:owner/demo:7:${key} -->`});return this.commentId;}editComment(id:number,body:string){this.edited.push({id,body});}}

test("dashboard messages publish first and apply answer, approve, retry and note with the operator identity",async()=>{
 const previousRepo=config.repo,previousInstance=config.instanceName;config.repo="owner/demo";config.instanceName="mac";try{
  for(const sample of [{status:"WAITING",request:"clarification",action:"answer"},{status:"WAITING",request:"spec-approval",action:"approve"},{status:"FAILED",action:"retry"},{status:"QUEUED",action:"note"}] as const){
   const store=chatItem(sample.status,sample.request as any),github=new ChatGitHub();if(sample.status==="FAILED")store.db.prepare("INSERT INTO failures(id,work_item_id,class,message,stage,attempt,created_at) VALUES('f','w','execution','failed','DESIGN',1,'now')").run();
   const applied=await applyMessageControl(store,github as any,{id:31,target:JSON.stringify({workItemId:"w",action:sample.action,text:"human guidance"})},"owner");assert.equal(applied.commentId,20);assert.equal(github.published.length,1);assert.match(github.published[0].body,/by @owner from mac/);assert.match(github.published[0].body,/<!-- ai-factory:/);const event=store.db.prepare("SELECT payload FROM events WHERE type='command.applied'").get() as {payload:string};assert.equal(JSON.parse(event.payload).login,"owner");const turn=workflowThread(store,"w").find(candidate=>candidate.kind==="human"&&candidate.outcome==="applied");assert.equal(turn?.source,"dashboard");const record=store.db.prepare("SELECT source_type,actor FROM records WHERE source_id='20' ORDER BY sequence DESC LIMIT 1").get() as {source_type:string;actor:string}|undefined;if(sample.action!=="approve"||sample.status!=="WAITING")assert.equal(record?.source_type,"dashboard");assert.equal(record?.actor,"owner");store.db.close();
  }
 }finally{config.repo=previousRepo;config.instanceName=previousInstance;}
});

test("a stale dashboard approval edits the published comment and invalid actions publish nothing",async()=>{const previous=config.repo;config.repo="owner/demo";try{const stale=chatItem("WAITING","spec-approval"),github=new ChatGitHub(5);await assert.rejects(applyMessageControl(stale,github as any,{id:1,target:JSON.stringify({workItemId:"w",action:"approve",text:""})},"owner"),/stale/);assert.equal(github.edited.length,1);assert.match(github.edited[0].body,/Rejected: Command is stale/);assert.match(github.edited[0].body,/<!-- ai-factory:/);stale.db.close();const queued=chatItem("QUEUED"),none=new ChatGitHub();await assert.rejects(applyMessageControl(queued,none as any,{id:2,target:JSON.stringify({workItemId:"w",action:"approve",text:""})},"owner"),/Cannot approve/);assert.equal(none.published.length,0);queued.db.close();}finally{config.repo=previous;}});

test("interrupt and retry preserves partial work and adds the previous attempt to the next context",async()=>{
 const previousRepo=config.repo;config.repo="owner/demo";const store=new Store(":memory:");try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,branch,created_at,updated_at,context,stage,status,attempt,correction_cycles,active_run_id) VALUES('w',7,'owner/demo','factory/issue-7','now','now',?,'BUILD','RUNNING',1,2,'run')").run(JSON.stringify({cwd:"/work",attemptStart:{executionId:"run",head:"abc",stage:"BUILD",startedAt:"before"}}));store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,approved_by,approved_at) VALUES('w',1,'spec','[]','owner','now')").run();store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at) VALUES('run','w','developer','BUILD','running','now')").run();
  const calls:string[]=[];const workspaces={sync(){calls.push("sync");return{before:"abc",after:"def",merged:[]};},publish(){calls.push("publish");},head(){return"def";},changeSummary(){return{files:["src/partial.ts"],stat:"1 file changed"};},changeSummarySince(_cwd:string,base:string){assert.equal(base,"abc");return{files:["src/partial.ts"],stat:"1 file changed"};}};const runner=new WorkflowRunner(store,{},workspaces as any,{ensurePR(){return"";}}),executions={interrupt(id:string,reason:string){assert.equal(id,"run");assert.equal(reason,"interrupted-for-guidance");store.db.prepare("UPDATE executions SET status='interrupted',finished_at='now' WHERE id=?").run(id);return true;}};
  const result=await applyInterruptRetryControl(store,new ChatGitHub() as any,executions as any,runner,{id:40,target:JSON.stringify({workItemId:"w",action:"interrupt-retry",text:"keep the partial implementation"})},"owner");assert.equal(result.projection.status,"QUEUED");assert.equal(result.projection.attempt,2);assert.equal(result.projection.correctionCycles,2);assert.deepEqual(calls,["sync","publish"]);const instruction=store.db.prepare("SELECT id,source_type,payload FROM records WHERE source_id='20'").get() as {id:string;source_type:string;payload:string};assert.equal(instruction.source_type,"dashboard");assert.match(instruction.payload,/keep the partial implementation/);const context=JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id='w'").get() as {context:string}).context);assert.deepEqual(context.previousAttempt.files,["src/partial.ts"]);assert.equal(context.previousAttempt.stage,"BUILD");assert.equal(context.previousAttempt.attempt,2);assert.equal(context.previousAttempt.guidanceRecordId,instruction.id);const assembled=new ContextAssembler(store).assemble({workItemId:"w",role:"developer",specVersion:1,budgetBytes:100000,budgetSource:"test",issue:{title:"Issue",body:"Body"},previousAttempt:context.previousAttempt,changedFiles:context.previousAttempt.files,diffStat:context.previousAttempt.diffStat});assert.match(assembled.markdown,/## Previous attempt/);assert.match(assembled.markdown,/src\/partial.ts/);assert.match(assembled.markdown,/guidanceRecordId/);
 }finally{store.db.close();config.repo=previousRepo;}
});

test("interrupt retry rejects before changing workflow state when the process does not stop",async()=>{
 const previousRepo=config.repo;config.repo="owner/demo";const store=new Store(":memory:"),github=new ChatGitHub();try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,branch,created_at,updated_at,context,stage,status,active_run_id) VALUES('w',7,'owner/demo','factory/issue-7','now','now','{}','BUILD','RUNNING','run')").run();store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at) VALUES('run','w','developer','BUILD','running','now')").run();
  const executions={interrupt(){return true;}},runner={preserve(){throw new Error("must not preserve");},recordPreviousAttempt(){throw new Error("must not record");}};
  await assert.rejects(applyInterruptRetryControl(store,github as any,executions as any,runner as any,{id:41,target:JSON.stringify({workItemId:"w",action:"interrupt-retry",text:"try another path"})},"owner",5),/did not stop/);assert.equal(new WorkflowProjections(store).get("w").status,"RUNNING");assert.equal(github.edited.length,1);assert.match(github.edited[0].body,/Rejected: The active process did not stop/);
 }finally{store.db.close();config.repo=previousRepo;}
});

test("workflow thread shows each publishable milestone as pending, published with its link or failed, and the status comment lag",()=>{
 const store=new Store(":memory:");try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status,presentation_revision,published_presentation_revision) VALUES('w',1,'owner/demo','now','now','{}','DESIGN','WAITING',2,1)").run();
  store.event("agent.result",{role:"developer",result:result("pass"),specVersion:1},"w","run-build");
  store.event("agent.result",{role:"product-architect",result:result("questions",{questions:["Which database?"]}),specVersion:1},"w","run-design");
  const key=resultPublicationKey((store.db.prepare("SELECT MAX(id) id FROM events").get() as {id:number}).id);
  let turns=workflowThread(store,"w");
  assert.equal("publication" in turns[0],false);
  assert.deepEqual(turns[1].publication,{status:"pending"});
  store.setMetadata(key,{status:"failed",attempts:3,error:"GitHub unavailable",failedAt:"now"});
  assert.deepEqual(workflowThread(store,"w")[1].publication,{status:"failed",attempts:3,error:"GitHub unavailable",failedAt:"now",needsAttention:true});
  store.setMetadata(key,{status:"published",commentId:42,url:"https://github.com/owner/demo/issues/1#issuecomment-42",publishedAt:"now"});
  assert.deepEqual(workflowThread(store,"w")[1].publication,{status:"published",commentId:42,url:"https://github.com/owner/demo/issues/1#issuecomment-42",publishedAt:"now"});
  const failure=new WorkflowFailures(store).open({workItemId:"w",class:"execution",message:"process exited 1",stage:"DESIGN",attempt:1});
  store.db.prepare("UPDATE work_items SET status='FAILED',active_failure_id=? WHERE id='w'").run(failure.id);
  store.event("workflow.transition",{to:{stage:"DESIGN",status:"FAILED"},reason:{summary:"Design failed"},actor:{type:"orchestrator",id:"runner"}},"w","run-design");
  turns=workflowThread(store,"w");assert.deepEqual(turns.at(-1)!.publication,{status:"pending"});
  store.setMetadata(failurePublicationKey(failure.id),{status:"failed",attempts:1,error:"GitHub unavailable",failedAt:"now"});
  assert.deepEqual(workflowThread(store,"w").at(-1)!.publication,{status:"failed",attempts:1,error:"GitHub unavailable",failedAt:"now",needsAttention:false});
  let status=statusPublication(store,"w");assert.deepEqual({revision:status.revision,publishedRevision:status.publishedRevision,behind:status.behind,error:status.error},{revision:2,publishedRevision:1,behind:true,error:null});
  store.setMetadata(statusPublicationKey("w"),{status:"failed",attempts:3,error:"GitHub unavailable",failedAt:"now"});
  status=statusPublication(store,"w");assert.equal(status.error,"GitHub unavailable");assert.equal(status.attempts,3);assert.equal(status.needsAttention,true);
  store.db.prepare("UPDATE work_items SET published_presentation_revision=2 WHERE id='w'").run();store.setMetadata(statusPublicationKey("w"),{status:"published",commentId:5,url:"https://github.com/owner/demo/issues/1#issuecomment-5",publishedAt:"now"});
  status=statusPublication(store,"w");assert.deepEqual({behind:status.behind,url:status.url,error:status.error},{behind:false,url:"https://github.com/owner/demo/issues/1#issuecomment-5",error:null});
 }finally{store.db.close();}
});

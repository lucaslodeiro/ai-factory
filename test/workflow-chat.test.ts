import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {Store} from "../src/storage.js";
import {config} from "../src/config.js";
import {workflowThread,promptArtifact,messageActions,applyMessageControl} from "../src/workflow-chat.js";
import {result} from "./fixtures.js";
import {WorkflowRecords} from "../src/workflow-records.js";

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

test("prompt artifact caps full text at 512 KiB and reports pruning",()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),"workflow-prompt-")),previous=config.dataDir;config.dataDir=root;try{const dir=path.join(root,"runs","run");fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,"prompt.md"),"x".repeat(600*1024));const artifact=promptArtifact("run");assert.equal(artifact.available,true);assert.equal(artifact.truncated,true);assert.equal(Buffer.byteLength(artifact.prompt!),512*1024);assert.equal("logDir" in artifact,false);fs.unlinkSync(path.join(dir,"prompt.md"));assert.deepEqual(promptArtifact("run"),{available:false});}finally{config.dataDir=previous;fs.rmSync(root,{recursive:true,force:true});}});

test("message actions are derived only from workflow state and active request",()=>{
 const request=(type:string)=>({payload:{kind:"request",type}}) as any;
 assert.deepEqual(messageActions({status:"WAITING"},request("clarification")),["answer"]);
 assert.deepEqual(messageActions({status:"WAITING"},request("correction-limit")),["answer"]);
 assert.deepEqual(messageActions({status:"WAITING"},request("spec-approval")),["approve","answer"]);
 assert.deepEqual(messageActions({status:"WAITING"},request("merge")),["answer"]);
 for(const status of ["FAILED","PAUSED","CANCELLED"] as const)assert.deepEqual(messageActions({status}),["retry","note"]);
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
   const applied=await applyMessageControl(store,github as any,{id:31,target:JSON.stringify({workItemId:"w",action:sample.action,text:"human guidance"})},"owner");assert.equal(applied.commentId,20);assert.equal(github.published.length,1);assert.match(github.published[0].body,/by @owner from mac/);assert.match(github.published[0].body,/<!-- ai-factory:/);const event=store.db.prepare("SELECT payload FROM events WHERE type='command.applied'").get() as {payload:string};assert.equal(JSON.parse(event.payload).login,"owner");const record=store.db.prepare("SELECT source_type,actor FROM records WHERE source_id='20' ORDER BY sequence DESC LIMIT 1").get() as {source_type:string;actor:string}|undefined;if(sample.action!=="approve"||sample.status!=="WAITING")assert.equal(record?.source_type,"dashboard");assert.equal(record?.actor,"owner");store.db.close();
  }
 }finally{config.repo=previousRepo;config.instanceName=previousInstance;}
});

test("a stale dashboard approval edits the published comment and invalid actions publish nothing",async()=>{const previous=config.repo;config.repo="owner/demo";try{const stale=chatItem("WAITING","spec-approval"),github=new ChatGitHub(5);await assert.rejects(applyMessageControl(stale,github as any,{id:1,target:JSON.stringify({workItemId:"w",action:"approve",text:""})},"owner"),/stale/);assert.equal(github.edited.length,1);assert.match(github.edited[0].body,/Rejected: Command is stale/);assert.match(github.edited[0].body,/<!-- ai-factory:/);stale.db.close();const queued=chatItem("QUEUED"),none=new ChatGitHub();await assert.rejects(applyMessageControl(queued,none as any,{id:2,target:JSON.stringify({workItemId:"w",action:"approve",text:""})},"owner"),/Cannot approve/);assert.equal(none.published.length,0);queued.db.close();}finally{config.repo=previous;}});

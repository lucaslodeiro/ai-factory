import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {Store} from "../src/storage.js";
import {config} from "../src/config.js";
import {workflowThread,promptArtifact} from "../src/workflow-chat.js";
import {result} from "./fixtures.js";

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

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {progressMonitor,progressWarning} from "../src/execution-progress.js";
import {progressKey} from "../src/execution-progress.js";
import {Store} from "../src/storage.js";
import {workflowActivity} from "../src/workflow-activity.js";
import {config} from "../src/config.js";

function fixture(provider:"codex"|"claude"|"cursor",start:object,end:object){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"factory-progress-")),file=path.join(dir,"stdout.log"),monitor=progressMonitor(dir,provider);
 try{
  fs.writeFileSync(file,JSON.stringify(start).slice(0,12));assert.equal(monitor.poll().events,0,"a partial event is not progress");
  fs.appendFileSync(file,JSON.stringify(start).slice(12)+"\n");const open=monitor.poll();assert.equal(open.events,1);assert.ok(open.tool);assert.equal(monitor.poll().events,1,"an unchanged file is not counted twice");
  assert.ok(progressWarning(open,new Date(Date.now()-600_000).toISOString(),Date.now()+300_001));
  fs.appendFileSync(file,JSON.stringify(end)+"\n");const closed=monitor.poll();assert.equal(closed.events,2);assert.equal(closed.tool,null);assert.ok(closed.lastTool);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}

test("Codex, Claude and Cursor streams expose a bounded active tool and completion",()=>{
 fixture("codex",{type:"item.started",item:{id:"one",type:"command_execution",command:"secret command"}},{type:"item.completed",item:{id:"one",type:"command_execution"}});
 fixture("claude",{type:"assistant",message:{content:[{type:"tool_use",id:"one",name:"Bash",input:{command:"secret command"}}]}},{type:"user",message:{content:[{type:"tool_result",tool_use_id:"one",content:"secret output"}]}});
 fixture("cursor",{type:"tool_call",subtype:"started",call_id:"one",tool_call:{readToolCall:{args:{path:"secret.txt"}}}},{type:"tool_call",subtype:"completed",call_id:"one",tool_call:{readToolCall:{result:{success:{content:"secret output"}}}}});
});

test("progress warnings report uncertainty and never include tool inputs or outputs",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"factory-progress-"));try{
  fs.writeFileSync(path.join(dir,"stdout.log"),JSON.stringify({type:"item.started",item:{id:"one",type:"command_execution",command:"GITHUB_TOKEN=secret"}})+"\n");
  const progress=progressMonitor(dir,"codex").poll();assert.equal(progress.tool,"command_execution");assert.doesNotMatch(JSON.stringify(progress),/GITHUB_TOKEN|secret/);
  assert.equal(progressWarning(progress,new Date().toISOString(),Date.parse(progress.lastProgressAt!)+1000),null);
  assert.ok(progressWarning(progress,new Date().toISOString(),Date.parse(progress.lastProgressAt!)+300_001));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("four identical tool calls are flagged as possible repetition without exposing their arguments",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"factory-progress-"));try{
  const file=path.join(dir,"stdout.log"),monitor=progressMonitor(dir,"cursor");
  for(let i=0;i<4;i++)fs.appendFileSync(file,JSON.stringify({type:"tool_call",subtype:"started",call_id:String(i),tool_call:{readToolCall:{args:{path:"private.txt"}}}})+"\n");
  const progress=monitor.poll();assert.equal(progress.repeatedToolCalls,4);assert.equal(progressWarning(progress,new Date().toISOString())?.reason,"repeated-action");assert.doesNotMatch(JSON.stringify(progress),/private.txt/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("Claude progress exposes partial token usage and a bounded schema error",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"factory-progress-"));try{
  const file=path.join(dir,"stdout.log"),monitor=progressMonitor(dir,"claude");
  fs.writeFileSync(file,JSON.stringify({type:"assistant",message:{id:"m1",usage:{input_tokens:2,cache_read_input_tokens:100,cache_creation_input_tokens:20,output_tokens:3},content:[]}})+"\n");
  fs.appendFileSync(file,JSON.stringify({type:"user",message:{content:[{type:"tool_result",tool_use_id:"one",is_error:true,content:"Output does not match required schema: /brief is too long"}]}})+"\n");
  const progress=monitor.poll();assert.equal(progress.usageTokens,67);assert.equal(progress.validationAttempts,1);assert.match(progress.lastValidationError!,/brief is too long/);
  assert.doesNotMatch(JSON.stringify(progress),/secret prompt/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("running work shows a warning and preserves manual intervention after five minutes without progress",()=>{
 const store=new Store(":memory:"),start="2026-09-22T12:00:00.000Z";
 try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status,active_run_id) VALUES('w',1,'owner/repo',?,?, '{}','TEST','RUNNING','run')").run(start,start);
  store.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at) VALUES('run','w','qa','running',?)").run(start);
  store.setMetadata(progressKey("run"),{provider:"cursor",events:2,lastEventAt:start,lastProgressAt:start,tool:"readToolCall",toolStartedAt:start,lastTool:"readToolCall",repeatedToolCalls:1});
  const activity=workflowActivity(store,"w","RUNNING",Date.parse(start)+300_001);
  assert.equal(activity.label,"Check agent progress");assert.match(activity.detail,/No observable progress for 5 minutes/);assert.equal(activity.stalled,false);
 }finally{store.db.close();}
});

test("running work announces the token-budget grace in the issue list",()=>{
 const store=new Store(":memory:"),at=new Date().toISOString();try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status,active_run_id) VALUES('w',1,'owner/repo',?,?, '{}','DESIGN','RUNNING','run')").run(at,at);
  store.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at) VALUES('run','w','product-architect','running',?)").run(at);
  store.setMetadata(progressKey("run"),{provider:"claude",events:1,lastEventAt:at,lastProgressAt:at,tool:null,toolStartedAt:null,lastTool:null,repeatedToolCalls:0,usageTokens:config.issueBudgetTokens,validationAttempts:0,lastValidationError:null});
  const activity=workflowActivity(store,"w","RUNNING");assert.equal(activity.label,"Token budget reached");assert.match(activity.detail,/25% grace/);
 }finally{store.db.close();}
});

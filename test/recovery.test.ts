import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {pathToFileURL} from "node:url";
import {Store} from "../src/storage.js";
import {assertExecutionStopped,ExecutionManager} from "../src/execution-manager.js";
import {config} from "../src/config.js";
import {recoverAbandonedExecutions} from "../src/daemon.js";
import {WorkflowCommands} from "../src/workflow-commands.js";
import {WorkflowProjections} from "../src/workflow-projection.js";

test("V3 retry rejects a live recovered process group without signalling it",async()=>{
 const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"}),exited=new Promise<void>(resolve=>child.on("exit",()=>resolve())),store=new Store(":memory:");
 try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',1,'a/b','now','now','{}','TEST','FAILED')").run();
  store.db.prepare("INSERT INTO executions(id,work_item_id,role,status,pid,started_at,recovery_pending) VALUES('run','w','qa','interrupted',?,'now',1)").run(child.pid!);
  assert.throws(()=>assertExecutionStopped(store,"w"),/live process group/);assert.doesNotThrow(()=>process.kill(child.pid!,0));process.kill(-child.pid!,"SIGKILL");await exited;assert.doesNotThrow(()=>assertExecutionStopped(store,"w"));assert.equal((store.db.prepare("SELECT recovery_pending FROM executions").get() as any).recovery_pending,0);
 }finally{if(child.exitCode===null&&child.signalCode===null){process.kill(-child.pid!,"SIGKILL");await exited;}store.db.close();}
});

test("supervisor kills TERM-resistant workers after daemon SIGKILL and V3 recovery preserves the stage",{timeout:15000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-crash-")),filename=path.join(root,"factory.db"),marker=path.join(root,"worker.json"),storeUrl=pathToFileURL(path.resolve("src/storage.ts")).href,managerUrl=pathToFileURL(path.resolve("src/execution-manager.ts")).href;
 const worker=`const fs=require('node:fs');const cp=require('node:child_process');process.on('SIGTERM',()=>{});const nested=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,nested:nested.pid}));setInterval(()=>{},1000);`;
 const script=`import {Store} from ${JSON.stringify(storeUrl)};import {ExecutionManager} from ${JSON.stringify(managerUrl)};const s=new Store();s.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',1,'a/b','now','now','{}','BUILD','QUEUED')").run();await new ExecutionManager(s).run('w','developer',process.execPath,['-e',${JSON.stringify(worker)}],${JSON.stringify(root)});`;
 const log=fs.openSync(path.join(root,"owner.log"),"w"),owner=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script],{env:{...process.env,FACTORY_DATA_DIR:root},stdio:["ignore",log,log]});fs.closeSync(log);const ownerExited=new Promise<void>(resolve=>owner.on("exit",()=>resolve()));let store:Store|undefined,group:number|undefined;
 const wait=async(condition:()=>boolean)=>{const end=Date.now()+7000;while(!condition()){if(Date.now()>end)throw new Error("Timed out waiting for supervisor: "+fs.readFileSync(path.join(root,"owner.log"),"utf8"));await new Promise(r=>setTimeout(r,30));}};
 const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")return false;if((error as NodeJS.ErrnoException).code==="EPERM")return true;throw error;}};
 try{
  await wait(()=>fs.existsSync(marker));store=new Store(filename);const run=store.db.prepare("SELECT id,pid FROM executions").get() as {id:string;pid:number};group=run.pid;store.db.prepare("UPDATE work_items SET status='RUNNING',active_run_id=? WHERE id='w'").run(run.id);const pids=JSON.parse(fs.readFileSync(marker,"utf8"));owner.kill("SIGKILL");await ownerExited;await wait(()=>!alive(pids.pid)&&!alive(pids.nested)&&!alive(-run.pid));const completion=JSON.parse(fs.readFileSync(path.join(root,"runs",run.id,"completion.json"),"utf8"));assert.equal(completion.status,"interrupted");assert.equal(recoverAbandonedExecutions(store),1);assert.equal(new WorkflowProjections(store).get("w").status,"FAILED");new WorkflowCommands(store).apply({kind:"retry",guidance:"",scope:"spec",appliesTo:[]},{workItemId:"w",login:"owner",commentId:1,specVersion:0});assert.equal(new WorkflowProjections(store).get("w").status,"QUEUED");
 }finally{if(owner.exitCode===null&&owner.signalCode===null){owner.kill("SIGKILL");await ownerExited;}if(group){try{process.kill(-group,"SIGKILL");}catch{}}store?.db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("retry refuses an agent that outlived its killed supervisor until its own process group is gone",{timeout:15000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-orphan-")),previous=config.dataDir,marker=path.join(root,"agent.pid"),store=new Store(":memory:");config.dataDir=root;let agent:number|undefined;
 const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")return false;throw error;}};
 const wait=async(condition:()=>boolean)=>{const end=Date.now()+7000;while(!condition()){if(Date.now()>end)throw new Error("Timed out waiting for the agent");await new Promise(r=>setTimeout(r,30));}};
 try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',1,'a/b','now','now','{}','TEST','QUEUED')").run();
  const worker=`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const running=new ExecutionManager(store).run("w","qa",process.execPath,["-e",worker],root).then(()=>"succeeded",error=>String(error));
  await wait(()=>fs.existsSync(marker));agent=Number(fs.readFileSync(marker,"utf8"));
  const run=store.db.prepare("SELECT id,pid FROM executions").get() as {id:string;pid:number};
  // Only the supervisor dies, as under the OOM killer; the agent leads its own group and survives.
  process.kill(run.pid,"SIGKILL");assert.match(await running,/failed/);assert.ok(alive(agent));
  assert.equal((store.db.prepare("SELECT recovery_pending FROM executions").get() as any).recovery_pending,1);
  assert.throws(()=>assertExecutionStopped(store,"w"),/left its agent process group \d+ running without a supervisor/);
  assert.ok(alive(agent),"the check must not signal the agent");
  process.kill(-agent,"SIGKILL");await wait(()=>!alive(agent!));
  assert.doesNotThrow(()=>assertExecutionStopped(store,"w"));
  assert.equal((store.db.prepare("SELECT recovery_pending FROM executions").get() as any).recovery_pending,0);
 }finally{if(agent){try{process.kill(-agent,"SIGKILL");}catch{}}config.dataDir=previous;store.db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("retry refuses an unreadable agent process record instead of assuming the agent stopped",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-record-")),previous=config.dataDir,store=new Store(":memory:");config.dataDir=root;
 try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',1,'a/b','now','now','{}','TEST','FAILED')").run();
  store.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at,recovery_pending) VALUES('run','w','qa','failed','now',1)").run();
  fs.mkdirSync(path.join(root,"runs","run"),{recursive:true});fs.writeFileSync(path.join(root,"runs","run","worker.json"),JSON.stringify({runId:"other",pid:4242}));
  assert.throws(()=>assertExecutionStopped(store,"w"),/record of interrupted run run is invalid/);
  assert.equal((store.db.prepare("SELECT recovery_pending FROM executions").get() as any).recovery_pending,1);
 }finally{config.dataDir=previous;store.db.close();fs.rmSync(root,{recursive:true,force:true});}
});

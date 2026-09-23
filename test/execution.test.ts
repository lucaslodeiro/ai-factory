import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock, recoverAbandonedExecutions } from "../src/daemon.js";
import {WorkflowProjections} from "../src/workflow-projection.js";
import { Store } from "../src/storage.js";
import { ExecutionManager } from "../src/execution-manager.js";
import { config } from "../src/config.js";
import {progressKey,type ExecutionProgress} from "../src/execution-progress.js";
config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-execution-"));
test.after(() => fs.rmSync(config.dataDir, { recursive: true, force: true }));
test("captures output, spawn errors, nonzero exit and timeout", async () => {
 const s = new Store(":memory:"), m = new ExecutionManager(s);
 const succeeded=await m.run("w", "developer", process.execPath, ["-e", "console.log('done')"], os.tmpdir(),"exact prompt");
 assert.equal(succeeded.readStdout().trim(), "done");assert.equal(succeeded.finalEvent,undefined);
 const runDir=path.join(config.dataDir,"runs",succeeded.id),manifest=JSON.parse(fs.readFileSync(path.join(runDir,"prompt.json"),"utf8"));
 assert.equal(fs.readFileSync(path.join(runDir,"prompt.md"),"utf8"),"exact prompt");
 assert.equal(manifest.promptBytes,12); assert.equal(manifest.sectionBytes.rawPrompt,12); assert.deepEqual(manifest.includedRecordIds,[]);
 assert.equal(manifest.promptSha256,(s.db.prepare("SELECT prompt_sha256 FROM executions WHERE id=?").get(succeeded.id) as any).prompt_sha256);
 assert.equal(fs.statSync(path.join(runDir,"prompt.md")).mode&0o777,0o600); assert.equal(fs.statSync(path.join(runDir,"prompt.json")).mode&0o777,0o600);
 await assert.rejects(m.run("w", "qa", "/nonexistent-factory-command", [], os.tmpdir()), /failed/);
 await assert.rejects(m.run("w", "qa", process.execPath, ["-e", "process.exit(4)"], os.tmpdir()), /failed/);
 assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM executions WHERE exit_code=4").get() as any).n, 1);
 await assert.rejects(m.run("w", "qa", process.execPath, ["-e", "setInterval(()=>{},100)"], os.tmpdir(), "", 50), /timed_out/);
 const timeout=s.db.prepare("SELECT status,interruption_reason FROM executions WHERE status='timed_out'").get() as any;
 assert.deepEqual(timeout,{status:"timed_out",interruption_reason:"execution-timeout"});
 assert.equal(s.db.prepare("SELECT COUNT(*) as n FROM executions WHERE status='running'").get() && (s.db.prepare("SELECT COUNT(*) as n FROM executions WHERE status='running'").get() as any).n, 0); s.db.close();
});
test("host signals are interruptions rather than user cancellations", async () => {
 const s=new Store(":memory:"),m=new ExecutionManager(s);
 const pending=m.run("w","developer",process.execPath,["-e","console.log('ready');setInterval(()=>{},100)"],os.tmpdir());
 const id=(s.db.prepare("SELECT id FROM executions").get() as any).id,pid=(s.db.prepare("SELECT pid FROM executions WHERE id=?").get(id) as any).pid,output=path.join(config.dataDir,"runs",id,"stdout.log"),deadline=Date.now()+3000;
 while((!fs.existsSync(output)||!fs.readFileSync(output,"utf8").includes("ready"))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
 assert.match(fs.readFileSync(output,"utf8"),/ready/);
 process.kill(-pid,"SIGTERM");await assert.rejects(pending,/interrupted/);
 assert.deepEqual(s.db.prepare("SELECT status,interruption_reason FROM executions WHERE id=?").get(id),{status:"interrupted",interruption_reason:"host-interrupted"});s.db.close();
});
test("cancellation terminates active process and records cancelled", async () => {
 const s = new Store(":memory:"), m = new ExecutionManager(s);
 const pending = m.run("w", "developer", process.execPath, ["-e", "setInterval(()=>{},100)"], os.tmpdir());
 const id = (s.db.prepare("SELECT id FROM executions").get() as any).id;
 assert.equal(m.cancel(id), true); await assert.rejects(pending, /cancelled/);
 assert.equal((s.db.prepare("SELECT status FROM executions").get() as any).status, "cancelled"); s.db.close();
});
test("a running metered agent is stopped after the 25% budget grace",{timeout:10000},async()=>{
 const prior=config.issueBudgetTokens;config.issueBudgetTokens=100;
 const s=new Store(":memory:"),m=new ExecutionManager(s);try{
  const at=new Date().toISOString();s.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('budget-run',1,'owner/repo',?,?,'{}','DESIGN','RUNNING')").run(at,at);
  const script="console.log(JSON.stringify({type:'assistant',message:{id:'m1',usage:{input_tokens:20,cache_read_input_tokens:110,output_tokens:0},content:[]}}));setInterval(()=>{},100)";
  await assert.rejects(m.run("budget-run","product-architect",process.execPath,["-e",script],os.tmpdir(),"",8000,{provider:"claude",model:"auto",policy:"test",reason:"test"}),/cancelled/);
  assert.deepEqual(s.db.prepare("SELECT status,interruption_reason FROM executions WHERE work_item_id='budget-run'").get(),{status:"cancelled",interruption_reason:"token-budget-limit"});
 }finally{config.issueBudgetTokens=prior;s.db.close();}
});
test("planned interruption is distinct from cancellation and preserves its reason", async () => {
 const s = new Store(":memory:"), m = new ExecutionManager(s);
 const pending = m.run("w", "developer", process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},100)"], os.tmpdir());
 const id = (s.db.prepare("SELECT id FROM executions").get() as any).id;
 assert.equal(m.isRunning(id),true);assert.equal(m.interrupt(id,"maintenance:update"), true);
 await assert.rejects(pending, /interrupted/);
 const row=s.db.prepare("SELECT status,interruption_reason FROM executions WHERE id=?").get(id) as any;
 assert.deepEqual(row,{status:"interrupted",interruption_reason:"maintenance:update"});assert.equal(m.isRunning(id),false);s.db.close();
});
test("progress is persisted while an agent runs and survives interruption",{timeout:8000},async()=>{
 const store=new Store(":memory:"),manager=new ExecutionManager(store);
 const pending=manager.run("w","qa",process.execPath,["-e",`console.log(JSON.stringify({type:'item.started',item:{id:'one',type:'command_execution',command:'secret'}}));setInterval(()=>{},100)`],os.tmpdir(),"",5000,{provider:"codex",model:"auto",policy:"test",reason:"test"});
 const id=(store.db.prepare("SELECT id FROM executions LIMIT 1").get() as {id:string}).id,until=Date.now()+4000;
 let progress:ExecutionProgress|undefined;
 while(Date.now()<until){progress=store.metadata<ExecutionProgress>(progressKey(id));if(progress?.events)break;await new Promise(resolve=>setTimeout(resolve,50));}
 assert.equal(progress?.tool,"command_execution");assert.doesNotMatch(JSON.stringify(progress),/secret/);
 manager.interrupt(id,"user-pause");await assert.rejects(pending,/interrupted/);
 assert.equal(store.metadata<ExecutionProgress>(progressKey(id))?.events,1);store.db.close();
});
test("explicit cancellation escalates an in-progress interruption", async () => {
 const s=new Store(":memory:"),m=new ExecutionManager(s);
 const pending=m.run("w","developer",process.execPath,["-e","process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},100)"],os.tmpdir());
 const id=(s.db.prepare("SELECT id FROM executions").get() as any).id;
 const ready=path.join(config.dataDir,"runs",id,"stdout.log"),deadline=Date.now()+3000;
 while((!fs.existsSync(ready)||!fs.readFileSync(ready,"utf8").includes("ready"))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
 assert.match(fs.readFileSync(ready,"utf8"),/ready/);
 assert.equal(m.interrupt(id,"user-pause"),true);
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(m.cancel(id),true);await assert.rejects(pending,/cancelled/);
 assert.deepEqual(s.db.prepare("SELECT status,interruption_reason FROM executions WHERE id=?").get(id),{status:"cancelled",interruption_reason:"user-cancel"});s.db.close();
});
test("only daemon recovery marks abandoned runs failed; database survives reopening", () => {
 const filename = path.join(config.dataDir, "recovery.db"); let s = new Store(filename);
 s.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status,active_run_id) VALUES('w',1,'a/b','now','now','{}','TEST','RUNNING','run')").run();
 s.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at) VALUES('run','w','qa','running','now')").run(); s.db.close();
 s = new Store(filename); assert.equal(new WorkflowProjections(s).get("w").status,"RUNNING");
 assert.equal(recoverAbandonedExecutions(s),1);assert.deepEqual({stage:new WorkflowProjections(s).get("w").stage,status:new WorkflowProjections(s).get("w").status},{stage:"TEST",status:"FAILED"});
 assert.equal((s.db.prepare("SELECT class FROM failures WHERE work_item_id='w'").get() as any).class,"recovery");s.db.close();
});

test("single daemon lock is transactional and can be reacquired after release", () => {
 const s = new Store(":memory:"); const release = acquireLock(s);
 assert.throws(() => acquireLock(s), /already running/); release();
 const again = acquireLock(s); again(); s.db.close();
});

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
config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-execution-"));
test.after(() => fs.rmSync(config.dataDir, { recursive: true, force: true }));
test("captures output, spawn errors, nonzero exit and timeout", async () => {
 const s = new Store(":memory:"), m = new ExecutionManager(s);
 const succeeded=await m.run("w", "developer", process.execPath, ["-e", "console.log('done')"], os.tmpdir(),"exact prompt");
 assert.equal(succeeded.stdout.trim(), "done");
 const runDir=path.join(config.dataDir,"runs",succeeded.id),manifest=JSON.parse(fs.readFileSync(path.join(runDir,"prompt.json"),"utf8"));
 assert.equal(fs.readFileSync(path.join(runDir,"prompt.md"),"utf8"),"exact prompt");
 assert.equal(manifest.promptBytes,12); assert.equal(manifest.sectionBytes.rawPrompt,12); assert.deepEqual(manifest.includedRecordIds,[]);
 assert.equal(manifest.promptSha256,(s.db.prepare("SELECT prompt_sha256 FROM executions WHERE id=?").get(succeeded.id) as any).prompt_sha256);
 assert.equal(fs.statSync(path.join(runDir,"prompt.md")).mode&0o777,0o600); assert.equal(fs.statSync(path.join(runDir,"prompt.json")).mode&0o777,0o600);
 await assert.rejects(m.run("w", "qa", "/nonexistent-factory-command", [], os.tmpdir()), /failed/);
 await assert.rejects(m.run("w", "qa", process.execPath, ["-e", "process.exit(4)"], os.tmpdir()), /failed/);
 assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM executions WHERE exit_code=4").get() as any).n, 1);
 await assert.rejects(m.run("w", "qa", process.execPath, ["-e", "setInterval(()=>{},100)"], os.tmpdir(), "", 50), /timed_out/);
 assert.equal(s.db.prepare("SELECT COUNT(*) as n FROM executions WHERE status='running'").get() && (s.db.prepare("SELECT COUNT(*) as n FROM executions WHERE status='running'").get() as any).n, 0); s.db.close();
});
test("cancellation terminates active process and records cancelled", async () => {
 const s = new Store(":memory:"), m = new ExecutionManager(s);
 const pending = m.run("w", "developer", process.execPath, ["-e", "setInterval(()=>{},100)"], os.tmpdir());
 const id = (s.db.prepare("SELECT id FROM executions").get() as any).id;
 assert.equal(m.cancel(id), true); await assert.rejects(pending, /cancelled/);
 assert.equal((s.db.prepare("SELECT status FROM executions").get() as any).status, "cancelled"); s.db.close();
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
test("explicit cancellation escalates an in-progress interruption", async () => {
 const s=new Store(":memory:"),m=new ExecutionManager(s);
 const pending=m.run("w","developer",process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},100)"],os.tmpdir());
 const id=(s.db.prepare("SELECT id FROM executions").get() as any).id;
 await new Promise(resolve=>setTimeout(resolve,200));
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

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../src/daemon.js";
import { Store } from "../src/storage.js";
import { ExecutionManager } from "../src/execution-manager.js";
import { config } from "../src/config.js";
config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-execution-"));
test.after(() => fs.rmSync(config.dataDir, { recursive: true, force: true }));
test("captures output, spawn errors, nonzero exit and timeout", async () => {
 const s = new Store(":memory:"), m = new ExecutionManager(s);
 assert.equal((await m.run("w", "developer", process.execPath, ["-e", "console.log('done')"], os.tmpdir())).stdout.trim(), "done");
 await assert.rejects(m.run("w", "qa", "/nonexistent-factory-command", [], os.tmpdir()), /failed/);
 await assert.rejects(m.run("w", "qa", process.execPath, ["-e", "process.exit(4)"], os.tmpdir()), /failed/);
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
test("only daemon recovery marks abandoned runs failed; database survives reopening", () => {
 const filename = path.join(config.dataDir, "recovery.db"); let s = new Store(filename);
 s.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,created_at,updated_at,context) VALUES('w',1,'a/b','QA','now','now',?)").run(JSON.stringify({ version: 1 }));
 s.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at) VALUES('run','w','qa','running','now')").run(); s.db.close();
 s = new Store(filename); assert.equal(s.get("w")!.state, "QA");
 assert.equal(new ExecutionManager(s).recover(), 1); assert.equal(s.get("w")!.state, "FAILED");
 assert.equal(s.get("w")!.context.resume, "QA"); s.db.close();
});

test("single daemon lock is transactional and can be reacquired after release", () => {
 const s = new Store(":memory:"); const release = acquireLock(s);
 assert.throws(() => acquireLock(s), /already running/); release();
 const again = acquireLock(s); again(); s.db.close();
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Store } from "../src/storage.js";
import { ExecutionManager, assertRetrySafe } from "../src/execution-manager.js";
import { retry } from "../src/retry.js";
function workItem(s: Store, state = "DEVELOPMENT", pending = true) {
 s.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,created_at,updated_at,context) VALUES('w',1,'a/b',?,'now','now',?)")
  .run(state, JSON.stringify({ title: "Demo", version: 1, feedback: [], cycles: 0, reports: {}, pendingStage: pending ? { stage: "DEVELOPMENT", beforeHead: "abc", startedAt: "now" } : undefined }));
}
test("crash after process success but before workflow commit requires an explicit retry", () => {
 const s = new Store(":memory:"); workItem(s);
 s.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at) VALUES('r','w','developer','succeeded','now')").run();
 new ExecutionManager(s).recover(); assert.equal(s.get("w")!.state, "FAILED");
 assert.match((s.db.prepare("SELECT body FROM outbox ORDER BY id DESC LIMIT 1").get() as any).body,/## Execution failed[\s\S]*daemon restarted[\s\S]*\/factory retry/);
 assert.equal(s.get("w")!.context.resume, "DEVELOPMENT"); retry(s, "w");
 assert.equal(s.get("w")!.state, "DEVELOPMENT"); assert.equal(s.get("w")!.context.pendingStage?.beforeHead, "abc"); s.db.close();
});
test("retry rejects an active interrupted process group without signalling it", async () => {
 const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
 const exited = new Promise<void>(resolve => child.on("exit", () => resolve()));
 const s = new Store(":memory:");
 try {
  s.db.prepare("INSERT INTO executions(id,work_item_id,role,status,pid,started_at,recovery_pending) VALUES('r','w','developer','interrupted',?,'now',1)").run(child.pid!);
  assert.throws(() => assertRetrySafe(s, "w"), /live process group/);
  assert.doesNotThrow(() => process.kill(child.pid!, 0));
  process.kill(-child.pid!, "SIGKILL"); await exited;
  assert.doesNotThrow(() => assertRetrySafe(s, "w"));
  assert.equal((s.db.prepare("SELECT recovery_pending FROM executions").get() as any).recovery_pending, 0);
 } finally { if (child.exitCode === null && child.signalCode === null) { process.kill(-child.pid!, "SIGKILL"); await exited; } s.db.close(); }
});
test("supervisor kills TERM-resistant workers after daemon SIGKILL and preserves recovery evidence", { timeout: 15000 }, async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-crash-"));
 const filename = path.join(root, "factory.db"), marker = path.join(root, "worker.json");
 const storeUrl = pathToFileURL(path.resolve("src/storage.ts")).href, managerUrl = pathToFileURL(path.resolve("src/execution-manager.ts")).href;
 const worker = `const fs=require('node:fs');const cp=require('node:child_process');process.on('SIGTERM',()=>{});const nested=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,nested:nested.pid}));setInterval(()=>{},1000);`;
 const script = `import {Store} from ${JSON.stringify(storeUrl)};import {ExecutionManager} from ${JSON.stringify(managerUrl)};const s=new Store();await new ExecutionManager(s).run('w','developer',process.execPath,['-e',${JSON.stringify(worker)}],${JSON.stringify(root)});`;
 const log = fs.openSync(path.join(root, "owner.log"), "w");
 const owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, FACTORY_DATA_DIR: root }, stdio: ["ignore", log, log] }); fs.closeSync(log);
 const ownerExited = new Promise<void>(resolve => owner.on("exit", () => resolve()));
 let s: Store | undefined; let group: number | undefined;
 const wait = async (condition: () => boolean) => { const end = Date.now() + 7000; while (!condition()) { if (Date.now() > end) throw new Error("Timed out waiting for supervisor: " + fs.readFileSync(path.join(root, "owner.log"), "utf8")); await new Promise(r => setTimeout(r, 30)); } };
 const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;if((e as NodeJS.ErrnoException).code==="EPERM")return true;throw e; } };
 try {
  await wait(() => fs.existsSync(marker)); s = new Store(filename); workItem(s);
  const run = s.db.prepare("SELECT id,pid FROM executions").get() as { id: string; pid: number }; group = run.pid;
  const pids = JSON.parse(fs.readFileSync(marker, "utf8"));
  owner.kill("SIGKILL"); await ownerExited;
  await wait(() => !alive(pids.pid) && !alive(pids.nested) && !alive(-run.pid));
  const completion = JSON.parse(fs.readFileSync(path.join(root, "runs", run.id, "completion.json"), "utf8"));
  assert.equal(completion.status, "interrupted"); assert.equal(completion.runId, run.id);
  new ExecutionManager(s).recover(); assert.equal(s.get("w")!.state, "FAILED");
  assert.doesNotThrow(() => retry(s!, "w")); assert.equal(s.get("w")!.state, "DEVELOPMENT");
 } finally {
  if (owner.exitCode === null && owner.signalCode === null) { owner.kill("SIGKILL"); await ownerExited; }
  if (group) { try { process.kill(-group, "SIGKILL"); } catch {} }
  s?.db.close(); fs.rmSync(root, { recursive: true, force: true });
 }
});

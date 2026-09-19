import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Store } from "../src/storage.js";
test("concurrent CLI processes initialize a new V3 SQLite database exactly once", { timeout: 15000 }, async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-schema-"));
 const gate = path.join(root, "start"), filename = path.join(root, "factory.db");
 const source = pathToFileURL(path.resolve("src/storage.ts")).href;
 const code = `import fs from 'node:fs';import {Store} from ${JSON.stringify(source)};while(!fs.existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,10));const s=new Store(${JSON.stringify(filename)});s.event('opened',{});s.db.close();`;
 const children = Array.from({ length: 4 }, () => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] }));
 const completed = children.map(child => new Promise<void>((resolve, reject) => {
  let error = ""; child.stderr!.on("data", c => error += c); child.on("error", reject);
  child.on("exit", status => status === 0 ? resolve() : reject(new Error(error)));
 }));
 try {
  fs.writeFileSync(gate, "go"); await Promise.all(completed);
  const s = new Store(filename);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='opened'").get() as any).n, 4);
  const executionColumns=(s.db.prepare("PRAGMA table_info(executions)").all() as any[]).map(column=>column.name);
  for(const column of ["recovery_pending","stage","input_tokens","output_tokens","cached_tokens","total_tokens"]) assert.ok(executionColumns.includes(column));
  s.db.close();
 } finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.allSettled(completed); fs.rmSync(root, { recursive: true, force: true });
 }
});

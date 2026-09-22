import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Store } from "../src/storage.js";
test("opening a Store waits for a busy SQLite database", { timeout: 10000 }, async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-busy-")),filename=path.join(root,"factory.db"),initial=new Store(filename),source=pathToFileURL(path.resolve("src/storage.ts")).href;
 initial.db.close();
 const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",`import {Store} from ${JSON.stringify(source)};const store=new Store(${JSON.stringify(filename)});store.db.exec('BEGIN IMMEDIATE');process.stdout.write('locked');setTimeout(()=>{store.db.exec('COMMIT');store.db.close()},300);`],{stdio:["ignore","pipe","pipe"]});
 try {
  await new Promise<void>((resolve,reject)=>{let output="",error="";child.stdout!.on("data",chunk=>{output+=chunk;if(output.includes("locked"))resolve();});child.stderr!.on("data",chunk=>error+=chunk);child.on("error",reject);child.on("exit",status=>{if(!output.includes("locked"))reject(new Error(error||`child exited ${status}`));});});
  const started=Date.now(),second=new Store(filename);assert.ok(Date.now()-started>=200);second.db.close();
 } finally {if(child.exitCode===null){child.kill("SIGKILL");await new Promise(resolve=>child.once("exit",resolve));}fs.rmSync(root,{recursive:true,force:true});}
});
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

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifierInvocation } from "../src/benchmark.js";

const oracle=fileURLToPath(new URL("../scripts/benchmark-verify.mjs",import.meta.url));

// A checkout holding one produced implementation, staged so `git ls-files` can see it.
function checkout(source:string):string {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-oracle-"));
 fs.mkdirSync(path.join(root,"src"));
 fs.writeFileSync(path.join(root,"src/slugify.ts"),source);
 for (const args of [["init","-q"],["add","-A"]]) {
  const run=spawnSync("git",args,{cwd:root,encoding:"utf8"});
  assert.equal(run.status,0,run.stderr);
 }
 return root;
}
const correct=`export function slugify(value: string): string {
 return value.toLowerCase().replace(/\\s+/g,"-").replace(/[^a-z0-9-]/g,"").replace(/-+/g,"-").replace(/^-|-$/g,"");
}
`;

// The verifier is spawned the way the benchmark command spawns it, from a working directory that
// is not the engine: the operator's shell is one, and running there once made a finished run read
// as unresolved because node could not find tsx.
function verify(target:string,from:string) {
 const call=verifierInvocation(oracle,target);
 const run=spawnSync(call.command,call.args,{cwd:call.cwd,encoding:"utf8",timeout:120000,maxBuffer:10_000_000,env:{...process.env,PWD:from}});
 try { return {result:JSON.parse(run.stdout) as {resolved:boolean;module:string|null;failures:number|null;error:string|null},run}; }
 catch { return {result:null,run}; }
}

test("the oracle runs from the engine, not from wherever the operator invoked the command",()=>{
 const target=checkout(correct);
 const foreign=fs.mkdtempSync(path.join(os.tmpdir(),"factory-elsewhere-"));
 try {
  const call=verifierInvocation(oracle,target);
  assert.equal(call.cwd,path.dirname(oracle),"tsx resolves from the working directory, so it has to be the engine's");
  assert.equal(call.args.at(-1),target,"and the checkout has to survive that move as an absolute path");
  const {result,run}=verify(target,foreign);
  assert.ok(result,`the verifier produced no result: ${run.stderr || run.error?.message}`);
  assert.equal(result.error,null);
  assert.equal(result.resolved,true,JSON.stringify(result));
  assert.equal(result.module,"src/slugify.ts");
 } finally { fs.rmSync(target,{recursive:true,force:true}); fs.rmSync(foreign,{recursive:true,force:true}); }
});

test("a relative checkout is resolved before the working directory changes under it",()=>{
 const target=checkout(correct);
 const relative=path.relative(process.cwd(),target);
 assert.equal(verifierInvocation(oracle,relative).args.at(-1),path.resolve(relative));
 fs.rmSync(target,{recursive:true,force:true});
});

test("an implementation that misses a stated behaviour is reported unresolved, not merely quiet",()=>{
 // Lowercases and hyphenates, but keeps punctuation: behaviour 3 of the issue.
 const target=checkout(`export const slugify = (value: string): string => value.toLowerCase().replace(/\\s+/g,"-");\n`);
 try {
  const {result,run}=verify(target,os.tmpdir());
  assert.ok(result,`the verifier produced no result: ${run.stderr || run.error?.message}`);
  assert.equal(result.resolved,false);
  assert.ok((result.failures ?? 0) > 0,"a failing behaviour has to be counted so the run is discarded");
 } finally { fs.rmSync(target,{recursive:true,force:true}); }
});

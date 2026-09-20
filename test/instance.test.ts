import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {readOrCreateInstance,readInstance} from "../src/instance.js";

test("installation identity is created once and preserved",()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),"factory-instance-"));
 try{const first=readOrCreateInstance(home,()=>new Date("2026-09-21T10:00:00.000Z")),second=readOrCreateInstance(home,()=>new Date("2027-01-01T00:00:00.000Z"));assert.deepEqual(second,first);assert.deepEqual(readInstance(home),first);assert.equal(first.schemaVersion,1);assert.match(first.instanceId,/^[0-9a-f-]{36}$/);assert.equal(first.displayName,`Factory ${first.instanceId.replaceAll("-","").slice(0,6)}`);assert.equal(first.createdAt,"2026-09-21T10:00:00.000Z");assert.equal(fs.statSync(path.join(home,"instance.json")).mode&0o777,0o600);}finally{fs.rmSync(home,{recursive:true,force:true});}
});

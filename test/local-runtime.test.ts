import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {LocalRuntimeManager} from "../src/local-runtime.js";

test("daemon-managed local runtime survives a worker boundary and stops on reconciliation",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-runtime-"));
 fs.writeFileSync(path.join(root,"package.json"),JSON.stringify({scripts:{"local:serve":"node server.cjs"}}));
 fs.writeFileSync(path.join(root,"server.cjs"),`const fs=require('node:fs'),http=require('node:http');const server=http.createServer((_,res)=>res.end('ready'));server.listen(0,'127.0.0.1',()=>{const port=server.address().port;fs.mkdirSync('.local',{recursive:true});fs.writeFileSync('.local/url','http://127.0.0.1:'+port+'/');});`);
 const runtimes=new LocalRuntimeManager();
 try{
  const runtime=await runtimes.ensure("work",root);
  assert.equal(runtime?.script,"local:serve");assert.match(runtime?.url??"",/^http:\/\/127\.0\.0\.1:/);
  assert.equal((await fetch(runtime!.url)).status,200);
  await runtimes.reconcile(new Set(["work"]));assert.equal((await fetch(runtime!.url)).status,200);
  await runtimes.reconcile(new Set());
 }finally{await runtimes.close();fs.rmSync(root,{recursive:true,force:true});}
});

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

test("a preview that serves the built site is started after one build when it cannot start before it",async()=>{
 // factory-demo#20: `local:serve` stopped with ENOENT on dist in a fresh worktree.
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-runtime-build-"));
 fs.writeFileSync(path.join(root,"package.json"),JSON.stringify({scripts:{"local:serve":"node server.cjs",build:"node build.cjs"}}));
 fs.writeFileSync(path.join(root,"build.cjs"),`require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/index.html','built');`);
 fs.writeFileSync(path.join(root,"server.cjs"),`const fs=require('node:fs'),http=require('node:http');if(!fs.existsSync('dist')){console.error("ENOENT: no such file or directory, realpath 'dist'");process.exit(1);}const server=http.createServer((_,res)=>res.end(fs.readFileSync('dist/index.html')));server.listen(0,'127.0.0.1',()=>{fs.mkdirSync('.local',{recursive:true});fs.writeFileSync('.local/url','http://127.0.0.1:'+server.address().port);});`);
 const runtimes=new LocalRuntimeManager();
 try{
  const runtime=await runtimes.ensure("work",root);
  assert.equal(await (await fetch(runtime!.url)).text(),"built");
  assert.match(fs.readFileSync(runtime!.log,"utf8"),/ENOENT[\s\S]*build/,"the log keeps the first failure and the build");
 }finally{await runtimes.close();fs.rmSync(root,{recursive:true,force:true});}
 const broken=fs.mkdtempSync(path.join(os.tmpdir(),"factory-runtime-build-"));
 fs.writeFileSync(path.join(broken,"package.json"),JSON.stringify({scripts:{"local:serve":"node -e \"process.exit(1)\"",build:"node -e \"process.exit(2)\""}}));
 try{await assert.rejects(new LocalRuntimeManager().ensure("work",broken),/npm run build` exited 2 before a second start/);}
 finally{fs.rmSync(broken,{recursive:true,force:true});}
});

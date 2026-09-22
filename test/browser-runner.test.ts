import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {browserRequired,browserExecutable,browserInstructions,createBrowserRunner} from '../src/browser-runner.mjs';
test('browser capability only activates for delivery projects using browser tools',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'factory-browser-test-'));
 try{assert.equal(browserRequired(root,'developer'),false);fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({devDependencies:{'@playwright/test':'*'}}));assert.equal(browserRequired(root,'developer'),true);assert.equal(browserRequired(root,'qa'),true);assert.equal(browserRequired(root,'product-architect'),false);assert.equal(browserExecutable('/missing/factory-browser'),undefined)}finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('browser instructions select a transient project preview and prohibit persistent services',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'factory-browser-test-'));
 try{
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{'local:start':'node service.mjs start','local:serve':'node server.mjs'},devDependencies:{playwright:'*'}}));
  const instructions=browserInstructions(root);
  assert.match(instructions,/npm run local:serve/);
  assert.match(instructions,/ephemeral child process/);
  assert.match(instructions,/Never register a system service or use launchctl/);
  assert.doesNotMatch(instructions,/npm run local:start/);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('runner verifies debugging and browser loopback load; cleanup removes only its profile',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'factory-browser-test-')),exe=path.join(root,'chrome'),record=path.join(root,'profile');
 fs.writeFileSync(exe,`#!${process.execPath}
 const fs=require('node:fs'),http=require('node:http');const profile=process.argv.find(a=>a.startsWith('--user-data-dir=')).split('=').slice(1).join('=');fs.writeFileSync(${JSON.stringify(record)},profile);
 const server=http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/json/version')res.end(JSON.stringify({Browser:'Fake Chrome',webSocketDebuggerUrl:'ws://127.0.0.1/browser'}));else if(req.url.startsWith('/json/new?')){await fetch(decodeURIComponent(req.url.split('?')[1]));res.end(JSON.stringify({id:'tab'}))}else res.end('{}')});server.listen(0,'127.0.0.1',()=>fs.writeFileSync(profile+'/DevToolsActivePort',String(server.address().port)+'\\n/browser'));
 `,{mode:0o755});
 const runner=createBrowserRunner(exe,{timeoutMs:10000});
 try{const result=await runner.start();assert.deepEqual(result.checks,['browser-start','debugging-connection','loopback-page']);assert.equal(result.browser,'Fake Chrome');assert.match(result.endpoint,/^http:\/\/127\.0\.0\.1:/);const profile=fs.readFileSync(record,'utf8');assert.ok(fs.existsSync(profile));await runner.close();assert.equal(fs.existsSync(profile),false);await runner.close();assert.ok(fs.existsSync(root))}finally{await runner.close();fs.rmSync(root,{recursive:true,force:true})}
});
test('early Chrome crashes are reported and cleaned up',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'factory-browser-test-')),exe=path.join(root,'chrome');fs.writeFileSync(exe,'#!/bin/sh\necho "SIGABRT probe" >&2\nexit 1\n',{mode:0o755});const runner=createBrowserRunner(exe,{timeoutMs:10000});try{await assert.rejects(runner.start(),/Chrome exited.*SIGABRT/)}finally{await runner.close();fs.rmSync(root,{recursive:true,force:true})}
});

test('supervisor supplies the browser connection and cleans it on cancellation and daemon disconnect',async()=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 for(const action of ['success','cancel','disconnect']){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'factory-browser-supervisor-')),exe=path.join(root,'chrome'),record=path.join(root,'profile'),ready=path.join(root,'ready');
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({devDependencies:{playwright:'*'}}));
 fs.writeFileSync(exe,`#!${process.execPath}
 const fs=require('node:fs'),http=require('node:http');const profile=process.argv.find(a=>a.startsWith('--user-data-dir=')).slice(16);fs.writeFileSync(${JSON.stringify(record)},profile);const server=http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/json/version')res.end(JSON.stringify({Browser:'Fake',webSocketDebuggerUrl:'ws://127.0.0.1/browser'}));else if(req.url.startsWith('/json/new?')){await fetch(decodeURIComponent(req.url.split('?')[1]));res.end(JSON.stringify({id:'tab'}))}else res.end('{}')});server.listen(0,'127.0.0.1',()=>fs.writeFileSync(profile+'/DevToolsActivePort',String(server.address().port)));
 `,{mode:0o755});
 const child=spawn(process.execPath,[fileURLToPath(new URL('../src/worker-supervisor.mjs',import.meta.url)),'test',root],{stdio:['pipe','ignore','pipe','ipc']});let stderr='';child.stderr!.on('data',chunk=>stderr+=chunk);const done=new Promise(resolve=>child.once('exit',resolve));
 try{
 child.stdin!.end(JSON.stringify({command:process.execPath,args:['-e',`if(process.env.FACTORY_BROWSER_STATUS!=='ready'||!process.env.FACTORY_BROWSER_CDP_URL)process.exit(2);require('node:fs').writeFileSync(${JSON.stringify(ready)},'ok');${action==='success'?'process.exit(0)':'setInterval(()=>{},1000)'}`],cwd:root,input:'test',role:'qa',browserExecutable:exe}));
 const deadline=Date.now()+15000;while(!fs.existsSync(ready)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));assert.ok(fs.existsSync(ready),stderr);
 const profile=fs.readFileSync(record,'utf8');if(action!=='success'){assert.ok(fs.existsSync(profile));if(action==='cancel')child.send({type:'cancel'});else child.disconnect();}await done;assert.equal(fs.existsSync(profile),false);const completion=JSON.parse(fs.readFileSync(path.join(root,'completion.json'),'utf8'));assert.equal(completion.status,action==='success'?'succeeded':action==='cancel'?'cancelled':'interrupted');
 }finally{if(child.exitCode===null)child.kill('SIGTERM');await done;fs.rmSync(root,{recursive:true,force:true})}
 }
});

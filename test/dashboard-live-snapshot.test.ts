import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {config} from '../src/config.js';
import {Store} from '../src/storage.js';
import {createDashboardServer} from '../src/dashboard.js';
test('live stream delivers changed work state and log output together and reconnects with current data',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'factory-live-')),previous=process.env.AI_FACTORY_HOME;process.env.AI_FACTORY_HOME=root;
 fs.mkdirSync(path.join(root,'scripts'));fs.writeFileSync(path.join(root,'scripts/services.sh'),'exit 0\n');
 const logs=path.join(root,'data/service-logs');fs.mkdirSync(logs,{recursive:true});fs.writeFileSync(path.join(logs,'daemon.log'),'first entry\n');
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'0.0.0'}));const oldGit=config.gitCommand;const fakeGit=path.join(root,'fake-git');fs.writeFileSync(fakeGit,'#!/bin/sh\necho test\n',{mode:0o755});config.gitCommand=fakeGit;
 const store=new Store(':memory:');const now=new Date().toISOString();store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,status) VALUES('one',1,'owner/repo',?,?,'{}','QUEUED')").run(now,now);
 const server=createDashboardServer(store,root);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;const abort=new AbortController();
 try{
  const response=await fetch(base+'/api/stream?lines=100',{signal:abort.signal});const reader=response.body!.getReader();let buffer='';
  const next=async()=>{while(!buffer.includes('\n\n')){const part=await reader.read();assert.equal(part.done,false);buffer+=new TextDecoder().decode(part.value)}const end=buffer.indexOf('\n\n'),packet=buffer.slice(0,end);buffer=buffer.slice(end+2);return JSON.parse(packet.slice(6))};
  const first=await next();assert.equal(first.items[0].status,'QUEUED');assert.equal(first.logs.lines,100);assert.equal(first.services.services.length,2);
  store.db.prepare("UPDATE work_items SET status='PAUSED' WHERE id='one'").run();fs.appendFileSync(path.join(logs,'daemon.log'),'task paused\n');
  const changed=await next();assert.equal(changed.items[0].status,'PAUSED');assert.ok(changed.logs.entries.some((entry:any)=>entry.text.includes('task paused')));
  abort.abort();const latest=await fetch(base+'/api/snapshot?lines=100').then(r=>r.json()) as any;assert.equal(latest.items[0].status,'PAUSED');assert.ok(latest.logs.entries.some((entry:any)=>entry.text.includes('task paused')));
 }finally{abort.abort();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.db.close();config.gitCommand=oldGit;if(previous===undefined)delete process.env.AI_FACTORY_HOME;else process.env.AI_FACTORY_HOME=previous;fs.rmSync(root,{recursive:true,force:true})}
});

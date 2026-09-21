import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {backgroundGitHub} from '../src/github-runtime.js';
import {Store} from '../src/storage.js';
import {WorkflowOrchestrator} from '../src/workflow-orchestrator.js';
import {workflowActivity} from '../src/workflow-activity.js';

test('GitHub subprocess waits do not block local timers; worker failures reject future calls',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-async-gh-')),previous=process.env.GH_COMMAND;
 const command=path.join(dir,'gh');fs.writeFileSync(command,'#!/bin/sh\nsleep 0.2\nprintf \'{"id":1,"node_id":"r","full_name":"owner/demo","default_branch":"main"}\'\n',{mode:0o755});process.env.GH_COMMAND=command;
 const remote=backgroundGitHub();try{let ticks=0;const timer=setInterval(()=>ticks++,10);try{const repo=await remote.github.repository();assert.equal(repo.id,1);assert.ok(ticks>=5,'main thread remains responsive');}finally{clearInterval(timer)}await remote.close();await assert.rejects(async()=>remote.github.repository(),/stopped/);}finally{await remote.close();if(previous===undefined)delete process.env.GH_COMMAND;else process.env.GH_COMMAND=previous;fs.rmSync(dir,{recursive:true,force:true});}
});

test('slow remote sync does not own the local execution lane',async()=>{
 const store=new Store(':memory:');let release!:(value:any[])=>void;
 store.db.prepare("INSERT INTO work_items(id,issue_number,issue_id,repo,created_at,updated_at,context,stage,status) VALUES('w',2,22,'owner/demo','now','now','{}','BUILD','QUEUED')").run();
 const remote={repositoryIssues:()=>new Promise<any[]>(resolve=>{release=resolve;}),issue:()=>({id:22,number:2,state:'OPEN',title:'Test',body:'',url:'https://github.com/owner/demo/issues/2'}),comments:()=>[],syncWorkflow(){},assignees:()=>[],assign(){},unassign(){}};
 let runs=0;const runner={reconcileFinished(){},async run(){runs++;store.db.prepare("UPDATE work_items SET status='PAUSED'").run();}};
 const o=new WorkflowOrchestrator(store,remote as any,runner as any,{enabled:false,async notify(){}});
 const syncing=o.syncRemote();try{await o.runLocal();assert.equal(runs,1);assert.equal(store.metadata('runtime:local-work'),null);}finally{release([]);await syncing;store.db.close();}
});

test('queue reasons distinguish capacity and active publication',()=>{
 const store=new Store(':memory:');try{store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',1,'owner/demo','now','now','{}','BUILD','RUNNING')").run();assert.equal(workflowActivity(store,'q','QUEUED').label,'Waiting for capacity');store.setMetadata('runtime:local-work',{id:'q',stage:'DELIVERY',since:'now'});assert.equal(workflowActivity(store,'q','QUEUED').label,'Publishing delivery');}finally{store.db.close()}
});

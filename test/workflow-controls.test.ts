import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/storage.js';
import {WorkflowProjections} from '../src/workflow-projection.js';
import {WorkflowScheduler} from '../src/workflow-scheduler.js';
import {WorkflowCommands} from '../src/workflow-commands.js';
import {applyWorkControl,workActions} from '../src/workflow-controls.js';
import {config} from '../src/config.js';

test('dashboard action matrix covers every status and fails closed for unknown states',()=>{
 for(const [status,actions] of Object.entries({QUEUED:['pause','cancel'],RUNNING:['pause','cancel'],WAITING:['pause','cancel'],PAUSED:['resume','cancel'],FAILED:['retry','cancel'],CANCELLED:['retry'],COMPLETED:[],unknown:[]}))assert.deepEqual(workActions(status),actions,status);
});
test('dashboard pause interrupts only its execution; resume waits for exit and retains the stage',()=>{
 const store=new Store(':memory:'),previous=[...config.approvers];config.approvers.splice(0,config.approvers.length,'owner');store.setMetadata('runtime:factory-account','owner');try{
  for(const id of ['one','two']){store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at) VALUES(?,?,'owner/demo','now','now')").run(id,id==='one'?1:2);new WorkflowProjections(store).initialize(id,'DESIGN','QUEUED');}
  const run=new WorkflowScheduler(store).begin('one'),commands=new WorkflowCommands(store),calls:string[]=[];
  const executions={interrupt:(id:string,reason:string)=>{calls.push(id);assert.equal(reason,'user-pause');},cancel:()=>{throw new Error('Pause must not cancel');}} as any;
  const apply=(kind:string)=>applyWorkControl(store,commands,executions,{id:1,kind,target:'one'});
  apply('pause');assert.deepEqual(calls,[run.executionId]);assert.equal(new WorkflowProjections(store).get('one').status,'PAUSED');assert.equal(new WorkflowProjections(store).get('two').status,'QUEUED');
  assert.throws(()=>apply('resume'));assert.throws(()=>apply('retry'),/Cannot retry/);
  store.db.prepare("UPDATE executions SET status='interrupted' WHERE id=?").run(run.executionId);
  assert.equal(apply('resume').projection.status,'QUEUED');assert.equal(new WorkflowProjections(store).get('one').stage,'DESIGN');
  const event=store.db.prepare("SELECT payload FROM events WHERE type='workflow.transition' ORDER BY id DESC LIMIT 1").get() as {payload:string};assert.equal((JSON.parse(event.payload) as any).actor.id,'owner');
  assert.throws(()=>apply('resume'),/Cannot resume/);
  store.setMetadata('runtime:factory-account','reader');const before=new WorkflowProjections(store).get('one');assert.throws(()=>apply('cancel'),/not an authorized approver/);assert.deepEqual(new WorkflowProjections(store).get('one'),before);
 }finally{config.approvers.splice(0,config.approvers.length,...previous);store.db.close();}
});

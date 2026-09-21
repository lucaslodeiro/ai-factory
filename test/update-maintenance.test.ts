import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/storage.js';
import {WorkflowProjections} from '../src/workflow-projection.js';
import {WorkflowScheduler} from '../src/workflow-scheduler.js';
import {reconcileUpdateMaintenance} from '../src/update-maintenance.js';

test('finished update clears abandoned preparations and releases a queued retry without changing paused work',()=>{
 const store=new Store(':memory:');try{
  for(const id of ['retry','paused'])store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context) VALUES(?,?,'owner/repo','now','now','{}')").run(id,id==='retry'?1:2);
  const projections=new WorkflowProjections(store);projections.initialize('retry','DESIGN','QUEUED');projections.initialize('paused','DESIGN','PAUSED');
  for(const [id,status,time] of [['old1','ready','01'],['old2','confirmed','02'],['done','completed','03']])store.db.prepare("INSERT INTO maintenance_operations(id,operation,actor,status,requested_at) VALUES(?,'update','dashboard',?,?)").run(id,status,time);
  const scheduler=new WorkflowScheduler(store);assert.throws(()=>scheduler.begin('retry'),/maintenance prevents/);
  assert.equal(reconcileUpdateMaintenance(store,{maintenanceId:'done',status:'completed'}),2);
  assert.equal(reconcileUpdateMaintenance(store,{maintenanceId:'done',status:'completed'}),0);
  assert.equal(scheduler.begin('retry').projection.status,'RUNNING');assert.equal(projections.get('paused').status,'PAUSED');
 }finally{store.db.close();}
});

test('reconciliation requires a known terminal update and preserves newer, running and unrelated barriers',()=>{
 const store=new Store(':memory:');try{
  for(const [id,op,status,time] of [['old','update','ready','01'],['running','update','running','01'],['other','daemon-stop','ready','01'],['done','update','running','02'],['new','update','ready','03']])store.db.prepare('INSERT INTO maintenance_operations(id,operation,actor,status,requested_at) VALUES(?,?,\'dashboard\',?,?)').run(id,op,status,time);
  assert.equal(reconcileUpdateMaintenance(store,{maintenanceId:'unknown',status:'completed'}),0);
  assert.equal(reconcileUpdateMaintenance(store,{maintenanceId:'done',status:'updating'}),0);
  assert.equal(reconcileUpdateMaintenance(store,{maintenanceId:'done',status:'failed',phase:'build failed'}),2);
  for(const id of ['running','other','new'])assert.notEqual((store.db.prepare('SELECT status FROM maintenance_operations WHERE id=?').get(id) as any).status,'failed');
 }finally{store.db.close();}
});

test('a terminal update state clears only an empty running update barrier created during that update',()=>{
 const store=new Store(':memory:');try{
  const startedAt='2026-09-21T23:52:00.000Z',finishedAt='2026-09-21T23:53:00.000Z';
  for(const [id,status,requestedAt] of [['orphan','running','2026-09-21T23:52:14.000Z'],['before','running','2026-09-21T23:51:59.000Z'],['after','running','2026-09-21T23:53:01.000Z'],['other','running','2026-09-21T23:52:14.000Z']])store.db.prepare("INSERT INTO maintenance_operations(id,operation,actor,status,requested_at) VALUES(?,?, 'dashboard',?,?)").run(id,id==='other'?'daemon-stop':'update',status,requestedAt);
  assert.equal(reconcileUpdateMaintenance(store,{status:'completed',startedAt,finishedAt}),1);
  assert.equal((store.db.prepare("SELECT status FROM maintenance_operations WHERE id='orphan'").get() as any).status,'completed');
  for(const id of ['before','after','other'])assert.equal((store.db.prepare('SELECT status FROM maintenance_operations WHERE id=?').get(id) as any).status,'running');
 }finally{store.db.close();}
});

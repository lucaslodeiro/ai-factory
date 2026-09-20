import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/storage.js';
import {WorkflowFailures} from '../src/workflow-failures.js';
import {diagnoseOperation,diagnoseWorkItem} from '../src/failure-diagnostics.js';

test('transport diagnosis separates observations from causes and redacts evidence',()=>{
 const d=diagnoseOperation('Delivery','RPC failed; HTTP 400 curl 22\nAuthorization: Bearer secret-value-123456');
 assert.match(d.summary,/transfer/);assert.match(d.evidence,/does not prove invalid credentials/);assert.match(d.limitations,/No live/);assert.doesNotMatch(JSON.stringify(d),/secret-value/);
 assert.match(diagnoseOperation('Push','Permission denied (publickey)').summary,/authentication/);
 assert.match(diagnoseOperation('Review','spawnSync git ENOBUFS').summary,/buffer/);
 assert.match(diagnoseOperation('Update','Something unexpected').summary,/does not identify/);
});
test('work item diagnosis preserves state and rejects stale or missing failures',()=>{
 const store=new Store(':memory:');try{
 store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',2,'owner/demo','now','now','{}','DELIVERY','FAILED')").run();
 const f=new WorkflowFailures(store).open({workItemId:'w',class:'integration',message:'RPC failed; HTTP 400',stage:'DELIVERY',attempt:14});
 store.db.prepare('UPDATE work_items SET active_failure_id=? WHERE id=?').run(f.id,'w');
 const before=store.db.prepare('SELECT * FROM work_items').all();
 const d=diagnoseWorkItem(store,'w');assert.equal(d.failureId,f.id);assert.match(d.resume,/does not rerun/);assert.deepEqual(store.db.prepare('SELECT * FROM work_items').all(),before);assert.equal(store.db.prepare('SELECT * FROM controls').all().length,0);
 store.db.prepare("UPDATE work_items SET status='QUEUED'").run();assert.throws(()=>diagnoseWorkItem(store,'w'),/no longer/);assert.throws(()=>diagnoseWorkItem(store,'missing'),/Unknown/);
 }finally{store.db.close()}
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Store, schemaVersion } from "../src/storage.js";

function insertItem(store: Store,id="work-1") {
 store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context) VALUES(?,?,?,?,?,?)")
  .run(id,1,"owner/demo","now","now",JSON.stringify({title:"Demo",body:"",url:""}));
}

test("a fresh completed-V3 database enables foreign keys and creates only projection storage", () => {
 const store=new Store(":memory:");
 try {
  assert.equal(store.db.pragma("foreign_keys",{simple:true}),1);
  assert.equal(store.metadata<number>("schema_version"),schemaVersion);
  for (const table of ["records","failures","maintenance_operations","maintenance_items","repository_controller"]) {
   assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }
  const columns=new Set((store.db.prepare("PRAGMA table_info(work_items)").all() as Array<{name:string}>).map(column=>column.name));
  assert.equal(columns.has("state"),false);
  for (const column of ["issue_id","issue_node_id","issue_created_at","stage","status","attempt","revision","presentation_revision","published_presentation_revision","active_run_id","active_request_id","active_failure_id","correction_cycles","archived_at"]) assert.ok(columns.has(column),column);
  const identity=store.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='issue_identity'").get() as {sql:string};
  assert.match(identity.sql,/WHERE archived_at IS NULL/i);
  const executionColumns=new Set((store.db.prepare("PRAGMA table_info(executions)").all() as Array<{name:string}>).map(column=>column.name));
  for (const column of ["prompt_bytes","prompt_sha256","interruption_reason","maintenance_id"]) assert.ok(executionColumns.has(column),column);
 } finally { store.db.close(); }
});

test("v3 records enforce work-item identity and per-item sequence", () => {
 const store=new Store(":memory:");
 const insert=store.db.prepare(`INSERT INTO records(id,work_item_id,sequence,kind,spec_version,scope,status,payload,source_type,source_id,actor,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
 try {
  assert.throws(()=>insert.run("record-missing","missing",1,"instruction",1,"spec","active","{}","github-comment","1","owner","now","now"),/FOREIGN KEY/);
  insertItem(store);
  insert.run("record-1","work-1",1,"instruction",1,"spec","active","{}","github-comment","1","owner","now","now");
  assert.throws(()=>insert.run("record-2","work-1",1,"decision",1,"spec","active","{}","agent-result","run","architect","now","now"),/UNIQUE/);
 } finally { store.db.close(); }
});

test("v3 failures permit only one unresolved failure per work item", () => {
 const store=new Store(":memory:");
 const insert=store.db.prepare("INSERT INTO failures(id,work_item_id,class,message,stage,attempt,created_at,resolved_at) VALUES(?,?,?,?,?,?,?,?)");
 try {
  insertItem(store);
  insert.run("failure-1","work-1","execution","first","BUILD",1,"now",null);
  assert.throws(()=>insert.run("failure-2","work-1","recovery","second","BUILD",1,"now",null),/UNIQUE/);
  store.db.prepare("UPDATE failures SET resolved_at='later' WHERE id='failure-1'").run();
  insert.run("failure-2","work-1","recovery","second","BUILD",2,"later",null);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM failures").get() as {count:number}).count,2);
 } finally { store.db.close(); }
});

test("an unversioned existing database is rejected without mutation",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-unsupported-")),file=path.join(root,"factory.db");
 const unsupported=new Database(file);
 unsupported.exec("CREATE TABLE work_items(id TEXT PRIMARY KEY, payload TEXT); INSERT INTO work_items VALUES('old','preserve me')");
 unsupported.close();
 assert.throws(()=>new Store(file),/completed V3 runtime requires a fresh data directory/);
 const inspected=new Database(file,{readonly:true});
 try {
  assert.deepEqual(inspected.prepare("SELECT * FROM work_items").all(),[{id:"old",payload:"preserve me"}]);
  assert.equal(inspected.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").get(),undefined);
  assert.equal(inspected.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get(),undefined);
 } finally {inspected.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('schema 5 upgrades atomically, preserves all existing rows and reopens idempotently',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'factory-v5-')),file=path.join(root,'factory.db');
 try{
  const old=new Database(file);old.exec(fs.readFileSync(new URL('./fixtures/schema-v5.sql',import.meta.url),'utf8'));
  old.exec("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,stage,status,attempt,revision) VALUES('queued',1,'owner/demo','now','now','DESIGN','PAUSED',2,6); INSERT INTO maintenance_operations(id,operation,actor,status,requested_at) VALUES('update','update','dashboard','failed','now'); INSERT INTO maintenance_items VALUES('update','queued',6,'now',NULL); INSERT INTO metadata VALUES('cursor','123');");
  const tables=(old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(row=>row.name);
  const before=new Map(tables.map(name=>[name,old.prepare(`SELECT * FROM ${name}`).all()]));old.close();
  for(let attempt=0;attempt<2;attempt++){
   const store=new Store(file);try{
    assert.equal(store.metadata('schema_version'),6);
    for(const name of tables){const rows=store.db.prepare(`SELECT * FROM ${name}`).all();assert.deepEqual(name==='metadata'?rows.filter((r:any)=>r.key!=='schema_version'):rows,name==='metadata'?before.get(name)!.filter((r:any)=>r.key!=='schema_version'):before.get(name));}
    assert.deepEqual(store.db.prepare('SELECT * FROM repository_controller').all(),[]);
   }finally{store.db.close();}
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('failed schema 5 migration rolls back both schema and version marker',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'factory-v5-rollback-')),file=path.join(root,'factory.db');
 try{
  const old=new Database(file);old.exec(fs.readFileSync(new URL('./fixtures/schema-v5.sql',import.meta.url),'utf8'));old.exec("CREATE TRIGGER fail_version BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT,'injected migration failure'); END;");old.close();
  assert.throws(()=>new Store(file),/injected migration failure/);
  const inspected=new Database(file);try{assert.deepEqual(inspected.prepare("SELECT value FROM metadata WHERE key='schema_version'").get(),{value:'5'});assert.equal(inspected.prepare("SELECT name FROM sqlite_master WHERE name='repository_controller'").get(),undefined);}finally{inspected.close();}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

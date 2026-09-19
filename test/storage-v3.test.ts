import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";

function insertItem(store: Store,id="work-1") {
 store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,created_at,updated_at,context) VALUES(?,?,?,?,?,?,?)")
  .run(id,1,"owner/demo","SPEC","now","now",JSON.stringify({title:"Demo",body:"",url:"",version:0,cursor:0,feedback:[],cycles:0,reports:{}}));
}

test("v3 foundation enables foreign keys and creates projection storage additively", () => {
 const store=new Store(":memory:");
 try {
  assert.equal(store.db.pragma("foreign_keys",{simple:true}),1);
  for (const table of ["records","failures","maintenance_operations","maintenance_items"]) {
   assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }
  const columns=new Set((store.db.prepare("PRAGMA table_info(work_items)").all() as Array<{name:string}>).map(column=>column.name));
  for (const column of ["stage","status","attempt","revision","presentation_revision","published_presentation_revision","active_run_id","active_request_id","active_failure_id","correction_cycles","archived_at"]) assert.ok(columns.has(column),column);
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

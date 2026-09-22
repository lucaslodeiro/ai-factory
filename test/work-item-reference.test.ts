import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { resolveWorkItem } from "../src/work-item-reference.js";

function setup() {
 const store=new Store(":memory:");
 const add=(id:string,issue:number,createdAt:string)=>store.db
  .prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context) VALUES(?,?,?,?,?,'{}')")
  .run(id,issue,"owner/demo",createdAt,createdAt);
 add("a4a6af44-564b-4400-918d-0d0966ebe3d3",9,"2026-09-22T01:00:00Z");
 add("c5882827-6ad5-4fb0-858b-4beeff2e594d",8,"2026-09-22T00:00:00Z");
 return {store,add};
}

test("a work item id resolves to itself",()=>{
 const {store}=setup();
 try { assert.deepEqual(resolveWorkItem(store,"a4a6af44-564b-4400-918d-0d0966ebe3d3"),{id:"a4a6af44-564b-4400-918d-0d0966ebe3d3"}); }
 finally { store.db.close(); }
});

test("an issue number resolves too, with or without a hash",()=>{
 const {store}=setup();
 try {
  assert.deepEqual(resolveWorkItem(store,"9"),{id:"a4a6af44-564b-4400-918d-0d0966ebe3d3"});
  assert.deepEqual(resolveWorkItem(store,"#8"),{id:"c5882827-6ad5-4fb0-858b-4beeff2e594d"});
  assert.deepEqual(resolveWorkItem(store," 9 "),{id:"a4a6af44-564b-4400-918d-0d0966ebe3d3"});
 } finally { store.db.close(); }
});

test("an issue the daemon has not taken says so instead of reporting an empty run",()=>{
 const {store}=setup();
 try {
  // The shape that made `activity 10` answer "No finished executions recorded", which reads as a
  // work item that ran nothing rather than an argument that names nothing.
  const found=resolveWorkItem(store,"10");
  assert.ok("error" in found);
  assert.match(found.error,/No work item for issue #10/);
  assert.match(found.error,/factory status/);
 } finally { store.db.close(); }
});

test("an unknown identifier is named as unknown rather than guessed at",()=>{
 const {store}=setup();
 try {
  for (const reference of ["nope","","  ","00000000-0000-0000-0000-000000000000"]) {
   const found=resolveWorkItem(store,reference);
   assert.ok("error" in found,`${reference} must not resolve`);
  }
 } finally { store.db.close(); }
});

test("an id copied short of its last character still resolves",()=>{
 const {store}=setup();
 try {
  // A UUID pasted out of a terminal table loses characters; this one is missing its last one.
  assert.deepEqual(resolveWorkItem(store,"a4a6af44-564b-4400-918d-0d0966ebe3d"),{id:"a4a6af44-564b-4400-918d-0d0966ebe3d3"});
  assert.deepEqual(resolveWorkItem(store,"a4a6af44"),{id:"a4a6af44-564b-4400-918d-0d0966ebe3d3"});
 } finally { store.db.close(); }
});

test("an ambiguous or too-short prefix is refused instead of picking one",()=>{
 const {store,add}=setup();
 try {
  add("a4a6af44-0000-0000-0000-000000000000",11,"2026-09-22T02:00:00Z");
  const many=resolveWorkItem(store,"a4a6af44");
  assert.ok("error" in many);
  assert.match(many.error,/matches 2 work items/);
  assert.ok("error" in resolveWorkItem(store,"a4a6"),"a prefix under eight characters is not a prefix");
 } finally { store.db.close(); }
});

test("wildcards in a reference match literally rather than as a pattern",()=>{
 const {store}=setup();
 try { for (const reference of ["%%%%%%%%","________","a4a6af4%"]) assert.ok("error" in resolveWorkItem(store,reference),`${reference} must not match`); }
 finally { store.db.close(); }
});

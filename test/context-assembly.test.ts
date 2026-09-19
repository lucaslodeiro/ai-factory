import test from "node:test";
import assert from "node:assert/strict";
import { ContextAssembler, InvalidContextError } from "../src/context-assembly.js";
import { Store } from "../src/storage.js";
import { WorkflowRecords } from "../src/workflow-records.js";

function setup() {
  const store=new Store(":memory:");
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,created_at,updated_at,context) VALUES('work-1',1,'owner/demo','QA','now','now',?)").run(JSON.stringify({title:"Issue",body:"Body",url:"https://example.test/1",version:1,cursor:0,feedback:[],cycles:0,reports:{}}));
  store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment) VALUES('work-1',1,'Build it',?,?)").run(JSON.stringify([{id:"AC-1",description:"works"}]),JSON.stringify({complexity:"low",risk:"low",rationale:"small"}));
  return {store,records:new WorkflowRecords(store),assembler:new ContextAssembler(store)};
}

function addRecords(records:WorkflowRecords) {
  const instruction=records.create({workItemId:"work-1",specVersion:1,scope:"spec",appliesTo:["qa"],payload:{kind:"instruction",text:"Do not use Chromium"},sourceType:"github-comment",sourceId:"10",actor:"owner"});
  const decision=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"decision",category:"human",decision:"Use SQLite",rationale:"MVP",supersedes:[]},sourceType:"github-comment",sourceId:"11",actor:"owner"});
  const finding=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"finding",classification:"auto-fix",originRole:"qa",criterionId:"AC-1",evidence:"Missing test"},sourceType:"agent-result",sourceId:"run-1",actor:"qa"});
  return {instruction,decision,finding};
}

test("context assembly filters role records and preserves stable record order",()=>{
  const {store,records,assembler}=setup();
  try {
    const created=addRecords(records);
    const tester=assembler.assemble({workItemId:"work-1",role:"qa",specVersion:1,budgetBytes:100_000,budgetSource:"default",issue:{title:"Issue",body:"x".repeat(3000)},diffStat:"1 file changed"});
    assert.deepEqual(tester.manifest.includedRecordIds,[created.instruction.id,created.decision.id]);
    assert.match(tester.markdown,/Do not use Chromium/);
    assert.doesNotMatch(tester.markdown,/Missing test/);
    assert.match(tester.markdown,/bodyTruncated/);
    const builder=assembler.assemble({workItemId:"work-1",role:"developer",specVersion:1,budgetBytes:100_000,budgetSource:"role:developer",issue:{title:"Issue",body:"Body"}});
    assert.deepEqual(builder.manifest.includedRecordIds,[created.decision.id,created.finding.id]);
    assert.doesNotMatch(builder.markdown,/Do not use Chromium/);
    assert.match(builder.markdown,/Missing test/);
  } finally { store.db.close(); }
});

test("optional sections are omitted deterministically when the budget is exhausted",()=>{
  const {store,assembler}=setup();
  try {
    const baseline=assembler.assemble({workItemId:"work-1",role:"reviewer",specVersion:1,budgetBytes:100_000,budgetSource:"default",issue:{title:"Issue",body:"Body"}});
    const result=assembler.assemble({workItemId:"work-1",role:"reviewer",specVersion:1,budgetBytes:Buffer.byteLength(baseline.markdown)+20,budgetSource:"provider/model",issue:{title:"Issue",body:"Body"},previousAttempt:{summary:"x".repeat(200)},diffStat:"large",qaEvidence:{tests:["large"]},recovery:"resume"});
    assert.deepEqual(result.manifest.excludedSections,["Previous attempt","Changed files","Tester execution evidence","Recovery note"]);
    assert.equal(result.manifest.budgetSource,"provider/model");
    assert.ok(Buffer.byteLength(result.markdown)<=result.manifest.budgetBytes);
  } finally { store.db.close(); }
});

test("protected context over budget fails before provider invocation",()=>{
  const {store,records,assembler}=setup();
  try {
    addRecords(records);
    assert.throws(()=>assembler.assemble({workItemId:"work-1",role:"developer",specVersion:1,budgetBytes:50,budgetSource:"default",issue:{title:"Issue",body:"Body"}}),error=>error instanceof InvalidContextError && error.failureClass === "invalid-context");
  } finally { store.db.close(); }
});

test("delivery context requires an approved stored specification",()=>{
  const {store,assembler}=setup();
  try {
    store.db.prepare("DELETE FROM specs").run();
    assert.throws(()=>assembler.assemble({workItemId:"work-1",role:"qa",specVersion:1,budgetBytes:10_000,budgetSource:"default",issue:{title:"Issue",body:"Body"}}),/Approved SPEC v1 is unavailable/);
  } finally { store.db.close(); }
});

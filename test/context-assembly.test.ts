import test from "node:test";
import assert from "node:assert/strict";
import { ContextAssembler, InvalidContextError } from "../src/context-assembly.js";
import { Store } from "../src/storage.js";
import { WorkflowRecords } from "../src/workflow-records.js";

function setup() {
  const store=new Store(":memory:");
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context) VALUES('work-1',1,'owner/demo','now','now',?)").run(JSON.stringify({title:"Issue",body:"Body",url:"https://example.test/1",version:1,cursor:0,feedback:[],cycles:0,reports:{}}));
  store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment) VALUES('work-1',1,'Build it',?,?)").run(JSON.stringify([{id:"AC-1",description:"works"}]),JSON.stringify({complexity:"low",risk:"low",verificationDepth:"thorough",rationale:"small"}));
  return {store,records:new WorkflowRecords(store),assembler:new ContextAssembler(store)};
}

function addRecords(records:WorkflowRecords) {
  const instruction=records.create({workItemId:"work-1",specVersion:1,scope:"spec",appliesTo:["qa"],payload:{kind:"instruction",text:"Do not use Chromium"},sourceType:"github-comment",sourceId:"10",actor:"owner"});
  const decision=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"decision",category:"human",decision:"Use SQLite",rationale:"MVP",supersedes:[]},sourceType:"github-comment",sourceId:"11",actor:"owner"});
  const finding=records.create({workItemId:"work-1",specVersion:1,scope:"spec",payload:{kind:"finding",classification:"auto-fix",severity:"major",originRole:"qa",criterionId:"AC-1",evidence:"Missing test"},sourceType:"agent-result",sourceId:"run-1",actor:"qa"});
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
    const result=assembler.assemble({workItemId:"work-1",role:"reviewer",specVersion:1,budgetBytes:Buffer.byteLength(baseline.markdown)+20,budgetSource:"provider/model",issue:{title:"Issue",body:"Body"},diffStat:"large",previousAttempt:{stage:"REVIEW",reason:"interrupted"}});
    assert.deepEqual(result.manifest.excludedSections,["Previous attempt","Changed files"]);
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

const testerResult={outcome:"pass",summary:"I concluded the implementation is solid and well factored.",spec:"",questions:[],
 findings:[{classification:"defer",severity:"minor",evidence:"Tester opinion about style"}],acceptanceCriteria:[],
 coverage:[{criterionId:"AC-1",status:"passed",evidence:"greet returns Hello world"}],
 tests:[{command:"node --test",exitCode:0,evidence:"1 passing"}],
 dependencies:[{name:"left-pad",change:"added",rationale:"padding"}],changedFiles:["test/greet.test.mjs"],
 decisions:[{kind:"tactical",decision:"Used node:test",rationale:"no new dependency",conflictsWithHuman:false,supersedes:[]}],
 nextRole:null,reviewChecks:[],taskAssessment:null};

test("Reviewer receives the Tester's executed evidence without its conclusions or opinions",()=>{
  const {store,assembler}=setup();
  try {
    const result=assembler.assemble({workItemId:"work-1",role:"reviewer",specVersion:1,budgetBytes:100_000,budgetSource:"default",issue:{title:"Issue",body:"Body"},qaEvidence:testerResult});
    assert.match(result.markdown,/greet returns Hello world/);
    assert.match(result.markdown,/node --test/);
    assert.doesNotMatch(result.markdown,/solid and well factored/);
    assert.doesNotMatch(result.markdown,/Tester opinion about style/);
    assert.doesNotMatch(result.markdown,/no new dependency/);
    assert.doesNotMatch(result.markdown,/left-pad/);
  } finally { store.db.close(); }
});

test("Reviewer evidence outranks optional context and never disappears silently",()=>{
  const {store,assembler}=setup();
  try {
    const full=assembler.assemble({workItemId:"work-1",role:"reviewer",specVersion:1,budgetBytes:100_000,budgetSource:"default",issue:{title:"Issue",body:"Body"},qaEvidence:testerResult});
    const tight=assembler.assemble({workItemId:"work-1",role:"reviewer",specVersion:1,budgetBytes:Buffer.byteLength(full.markdown),budgetSource:"default",issue:{title:"Issue",body:"Body"},qaEvidence:testerResult,
      changedFiles:["a.ts","b.ts"],diffStat:"2 files changed",previousAttempt:{stage:"REVIEW",reason:"interrupted"}});
    assert.match(tight.markdown,/greet returns Hello world/);
    assert.ok(!tight.manifest.excludedSections.includes("Tester execution evidence"));
    assert.ok(tight.manifest.excludedSections.length>0);
    assert.throws(()=>assembler.assemble({workItemId:"work-1",role:"reviewer",specVersion:1,budgetBytes:400,budgetSource:"default",issue:{title:"Issue",body:"Body"},qaEvidence:testerResult}),
      error=>error instanceof InvalidContextError);
  } finally { store.db.close(); }
});

test("only the Builder receives the repository map, and it never displaces protected context",()=>{
  const {store,assembler}=setup();
  const repositoryMap={legend:"directory, tracked files, most common extensions",files:2,rootFiles:["package.json"],directories:["src 1 .ts"],truncated:false};
  try {
    const builder=assembler.assemble({workItemId:"work-1",role:"developer",specVersion:1,budgetBytes:100_000,budgetSource:"default",issue:{title:"Issue",body:"Body"},repositoryMap});
    assert.match(builder.markdown,/Repository map/);
    assert.match(builder.markdown,/src 1 \.ts/);
    for (const role of ["qa","reviewer","product-architect"] as const) {
      assert.doesNotMatch(assembler.assemble({workItemId:"work-1",role,specVersion:1,budgetBytes:100_000,budgetSource:"default",issue:{title:"Issue",body:"Body"},repositoryMap}).markdown,/Repository map/);
    }
    const baseline=assembler.assemble({workItemId:"work-1",role:"developer",specVersion:1,budgetBytes:100_000,budgetSource:"default",issue:{title:"Issue",body:"Body"}});
    const tight=assembler.assemble({workItemId:"work-1",role:"developer",specVersion:1,budgetBytes:Buffer.byteLength(baseline.markdown)+10,budgetSource:"default",issue:{title:"Issue",body:"Body"},repositoryMap});
    assert.deepEqual(tight.manifest.excludedSections,["Repository map"]);
    assert.match(tight.markdown,/Approved specification/);
  } finally { store.db.close(); }
});

test("an epic Tester and Reviewer receive what the stories verified as a protected section; a plain issue does not",()=>{
  const {store,assembler}=setup();
  try {
    const stories=[{key:"S1",issue:2,criteria:["AC-1"],verificationDepth:"minimal",coverage:[]}];
    for(const role of ["qa","reviewer"] as const){const context=assembler.assemble({workItemId:"work-1",role,specVersion:1,budgetBytes:100_000,budgetSource:"default",issue:{title:"Issue",body:"Body"},storyEvidence:stories});assert.match(context.markdown,/## Verified by stories/);assert.match(context.markdown,/Do not repeat their tests/);assert.ok(context.manifest.sectionBytes["Verified by stories"]>0);}
    const builder=assembler.assemble({workItemId:"work-1",role:"developer",specVersion:1,budgetBytes:100_000,budgetSource:"default",issue:{title:"Issue",body:"Body"},storyEvidence:stories});
    assert.doesNotMatch(builder.markdown,/Verified by stories/);
    assert.doesNotMatch(assembler.assemble({workItemId:"work-1",role:"qa",specVersion:1,budgetBytes:100_000,budgetSource:"default",issue:{title:"Issue",body:"Body"},storyEvidence:[]}).markdown,/Verified by stories/);
  } finally {store.db.close();}
});

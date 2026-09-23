import test from "node:test";
import assert from "node:assert/strict";
import { compactIssueState, stateTextBudgets, validateIssueState, type IssueStateIndex } from "../src/workflow-state.js";

const long=(n:number)=>"x".repeat(n);
const index=(size:number):IssueStateIndex=>validateIssueState({
 kind:"state",schemaVersion:1,repository:{id:1,nodeId:"R_1",fullName:"owner/demo"},
 issue:{id:9,nodeId:"I_9",number:6},workflowId:"w1",instance:"test",publishedAt:"2026-09-22T00:00:00Z",branch:"factory/issue-6",base:"main",
 projection:{stage:"BUILD",status:"QUEUED",attempt:7,revision:52,correctionCycles:0},
 context:{cursor:5,pr:"https://github.com/owner/demo/pull/7"},
 specs:[{version:1,marker:"result-run-spec",approvedBy:"owner",approvalCommentId:12,approvedAt:"2026-09-22T00:00:00Z"}],
 latestResults:[{role:"developer",executionId:"e1",outcome:"pass",summary:long(size),
  coverage:[{criterionId:"AC-1",status:"passed",evidence:long(size)}],
  tests:[{command:long(size),exitCode:0,evidence:long(size)}],changedFiles:["src/a.ts","src/b.ts"],
  findings:[{classification:"defer",severity:"minor",evidence:long(size)}],
  decisions:[{kind:"tactical",decision:long(size),rationale:long(size),conflictsWithHuman:false,supersedes:[]}]}],
 records:[{id:"r1",work_item_id:"w1",sequence:1,kind:"finding",spec_version:1,scope:"spec",status:"open",applies_to:[],
  payload:{kind:"finding",classification:"defer",severity:"minor",evidence:long(size)},source_type:"agent-result",source_id:"e1",
  actor:"developer",parent_id:null,superseded_by:null,resolved_by:null,created_at:"t",updated_at:"t"}],
 failure:null});

const fitsWithin=(limit:number)=>(candidate:IssueStateIndex)=>JSON.stringify(candidate).length<=limit;

test("an index that already fits is published untouched",()=>{
 const small=index(50);
 const result=compactIssueState(small,fitsWithin(100_000))!;
 assert.equal(result.clippedTo,null);
 assert.deepEqual(result.index,small);
});

test("an oversized index sheds narrative text instead of being dropped whole",()=>{
 const huge=index(20_000);
 const limit=12_000;
 const result=compactIssueState(huge,fitsWithin(limit))!;
 assert.notEqual(result.clippedTo,null,"it had to clip");
 assert.ok(JSON.stringify(result.index).length<=limit);
 // Recovery reads identifiers, versions and markers. None of them may be touched.
 assert.equal(result.index.workflowId,"w1");
 assert.equal(result.index.branch,"factory/issue-6");
 assert.deepEqual(result.index.projection,huge.projection);
 assert.deepEqual(result.index.specs,huge.specs);
 assert.equal(result.index.records[0].id,"r1");
 assert.equal(result.index.records[0].status,"open");
 assert.equal(result.index.latestResults[0].coverage[0].criterionId,"AC-1");
 assert.equal(result.index.latestResults[0].coverage[0].status,"passed");
 assert.equal(result.index.latestResults[0].findings[0].classification,"defer");
 assert.deepEqual(result.index.latestResults[0].changedFiles,["src/a.ts","src/b.ts"],"file paths are structure, not prose");
 assert.ok(result.index.latestResults[0].summary.length<huge.latestResults[0].summary.length);
});

test("the smallest form is still a valid, adoptable index",()=>{
 const result=compactIssueState(index(20_000),fitsWithin(1_500))!;
 assert.equal(result.clippedTo,stateTextBudgets.at(-1));
 assert.equal(result.index.latestResults[0].summary,"");
 assert.doesNotThrow(()=>validateIssueState(result.index));
 assert.equal(result.index.specs[0].marker,"result-run-spec","the spec marker is how recovery finds the specification");
});

test("only a limit no shape can meet reports the index as unpublishable",()=>{
 // 1,301 bytes is the floor for this shape: identifiers, versions, markers and statuses.
 assert.equal(compactIssueState(index(20_000),fitsWithin(1_300)),null);
 assert.equal(compactIssueState(index(20_000),fitsWithin(200)),null);
});

test("clipping is progressive: it keeps as much text as the limit allows",()=>{
 const huge=index(20_000);
 const generous=compactIssueState(huge,fitsWithin(30_000))!;
 const tight=compactIssueState(huge,fitsWithin(4_000))!;
 assert.ok(generous.clippedTo! > tight.clippedTo!);
 assert.ok(generous.index.latestResults[0].summary.length > tight.index.latestResults[0].summary.length);
});

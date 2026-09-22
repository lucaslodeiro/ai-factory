import test from "node:test";
import assert from "node:assert/strict";
import { activityRow, summarizeActivity, progression } from "../src/execution-activity.js";

test("a finished execution event becomes one activity row without inventing missing numbers",()=>{
 const row=activityRow({usage:{outputTokens:120,cacheReadTokens:9000,cacheWriteTokens:300},activity:{events:42,eventTypes:{"item.completed":40,result:2},turns:null}},"developer","BUILD","t1");
 assert.deepEqual([row.events,row.turns,row.cacheReadTokens,row.cacheWriteTokens,row.outputTokens],[42,null,9000,300,120]);
 const bare=activityRow({},"qa","TEST",null);
 assert.deepEqual([bare.events,bare.turns,bare.cacheReadTokens,bare.outputTokens,bare.eventTypes],[null,null,null,null,{}]);
});

test("roles are compared on events per run, which is the Builder-versus-Tester question",()=>{
 const rows=[
  activityRow({activity:{events:300,eventTypes:{command:250,file_change:50}},usage:{cacheReadTokens:1000,cacheWriteTokens:100,outputTokens:10}},"developer","BUILD","t1"),
  activityRow({activity:{events:100,eventTypes:{command:90,file_change:10}},usage:{cacheReadTokens:500,cacheWriteTokens:50,outputTokens:5}},"developer","BUILD","t2"),
  activityRow({activity:{events:120,eventTypes:{command:120}},usage:{cacheReadTokens:400,cacheWriteTokens:40,outputTokens:8}},"qa","TEST","t3"),
 ];
 const summary=summarizeActivity(rows);
 assert.deepEqual(summary.map(entry=>entry.role),["developer","qa"]);
 const builder=summary[0];
 assert.deepEqual([builder.runs,builder.events,builder.eventsPerRun],[2,400,200]);
 assert.deepEqual([builder.cacheReadTokens,builder.cacheWriteTokens,builder.outputTokens],[1500,150,15]);
 assert.equal(builder.topTypes,"command:340 file_change:60");
 assert.equal(summary[1].eventsPerRun,120);
});

test("a role whose provider reports nothing stays null instead of reading as zero activity",()=>{
 const summary=summarizeActivity([activityRow({usage:{outputTokens:7}},"reviewer","REVIEW","t1")]);
 assert.deepEqual([summary[0].events,summary[0].eventsPerRun,summary[0].cacheReadTokens],[null,null,null]);
 assert.equal(summary[0].outputTokens,7);
 assert.equal(summary[0].topTypes,"");
});

const run=(role:string,startedAt:string,over:Record<string,unknown>={})=>
 activityRow({activity:{events:100,turns:40,costUsd:1,durationMs:60000,eventTypes:{result:1},...over},
  usage:{totalTokens:1000000,...(over.usage as object ?? {})}},role,"BUILD",startedAt);

test("each role's runs are ordered in time and compared against its own first run",()=>{
 const rows=[run("developer","t3",{costUsd:0.4,turns:20}),run("developer","t1",{costUsd:2,turns:90}),run("qa","t2")];
 const sequence=progression(rows);
 // qa ran once, so it contributes nothing: there is no second run to compare.
 assert.deepEqual(sequence.map(entry=>[entry.role,entry.run]),[["developer",1],["developer",2]]);
 assert.equal(sequence[0].costUsd,2,"the earliest run is run 1 regardless of query order");
 assert.equal(sequence[0].vsFirstPercent,null,"a first run has nothing to compare against");
 assert.equal(sequence[1].vsFirstPercent,-80);
});

test("a second run that is more expensive is reported as such, not hidden by the role total",()=>{
 const sequence=progression([run("developer","t1",{costUsd:0.5}),run("developer","t2",{costUsd:4.9})]);
 assert.equal(sequence[1].vsFirstPercent,880,"the Builder starting over each cycle has to be visible");
});

test("a provider that reports no cost is compared on tokens, and on neither it stays unknown",()=>{
 const tokens=progression([run("qa","t1",{costUsd:null,usage:{totalTokens:2000000}}),run("qa","t2",{costUsd:null,usage:{totalTokens:1000000}})]);
 assert.equal(tokens[1].vsFirstPercent,-50);
 const nothing=progression([run("qa","t1",{costUsd:null,usage:{totalTokens:null}}),run("qa","t2",{costUsd:null,usage:{totalTokens:null}})]);
 assert.equal(nothing[1].vsFirstPercent,null);
});

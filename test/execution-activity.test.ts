import test from "node:test";
import assert from "node:assert/strict";
import { activityRow, summarizeActivity } from "../src/execution-activity.js";

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

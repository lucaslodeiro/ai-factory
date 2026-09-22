import test from "node:test";
import assert from "node:assert/strict";
import { buildBenchmarkReport, compareBenchmarks, type ExecutionSample } from "../src/benchmark.js";

const sample=(role:string,over:Partial<ExecutionSample>={}):ExecutionSample=>({
 role,stage:"BUILD",status:"succeeded",startedAt:"t1",finishedAt:"t2",promptBytes:20000,
 inputTokens:100,outputTokens:1000,cacheReadTokens:500000,cacheWriteTokens:20000,totalTokens:521100,
 turns:40,events:1,eventTypes:{result:1},costUsd:0.5,durationMs:60000,...over});

const input=(over:Partial<Parameters<typeof buildBenchmarkReport>[0]>={})=>buildBenchmarkReport({
 workItemId:"w1",issueNumber:9,stage:"DELIVERY",status:"COMPLETED",attempt:0,correctionCycles:1,specVersions:1,
 executions:[sample("developer"),sample("developer",{turns:20,costUsd:0.25,totalTokens:260000}),sample("qa",{stage:"TEST",turns:30,costUsd:0.3,totalTokens:300000})],
 transitions:[{from:"DESIGN/RUNNING",to:"BUILD/QUEUED",reason:"spec-approved"},{from:"BUILD/QUEUED",to:"TEST/QUEUED",reason:"build-passed"},
  {from:"TEST/QUEUED",to:"BUILD/QUEUED",reason:"changes-requested"},{from:"BUILD/QUEUED",to:"TEST/QUEUED",reason:"build-passed"}],
 outcomes:[{role:"developer",outcome:"changes"},{role:"developer",outcome:"pass"},{role:"qa",outcome:"pass"}],
 eventCounts:{"execution.invalid_result":2,"execution.interrupted":1},...over});

test("a run is summarized per role with the workflow's own totals, outcomes and health",()=>{
 const report=input();
 assert.deepEqual(report.roles.map(role=>role.role),["developer","qa"]);
 const builder=report.roles[0];
 assert.equal(builder.runs,2);
 assert.equal(builder.turns,60);
 assert.equal(builder.costUsd,0.75);
 assert.equal(builder.outcome,"pass","the last outcome of the role, not the first");
 assert.equal(report.totals.runs,3);
 assert.equal(report.totals.costUsd,1.05);
 assert.equal(report.totals.totalTokens,1081100);
 assert.deepEqual(report.health,{failedExecutions:0,invalidResults:2,interruptions:1,discarded:0});
});

test("the transition path collapses repeats and counts why each move happened",()=>{
 const report=input();
 assert.equal(report.transitions.count,4);
 assert.deepEqual(report.transitions.path,["BUILD/QUEUED","TEST/QUEUED","BUILD/QUEUED","TEST/QUEUED"]);
 assert.deepEqual(report.transitions.reasons,{"spec-approved":1,"build-passed":2,"changes-requested":1});
});

test("an unreported metric stays null through the totals instead of counting as zero",()=>{
 const report=input({executions:[sample("developer",{costUsd:null,turns:null}),sample("developer",{costUsd:null,turns:null})]});
 assert.equal(report.roles[0].costUsd,null);
 assert.equal(report.roles[0].turns,null);
 assert.equal(report.roles[0].totalTokens,1042200,"metrics that were reported still add up");
});

test("comparing two runs reports deltas, and never invents one against an unmeasured value",()=>{
 const baseline=input();
 const current=input({executions:[sample("developer",{turns:30,costUsd:0.4,totalTokens:400000}),sample("qa",{stage:"TEST",turns:30,costUsd:0.3,totalTokens:300000,cacheReadTokens:null})]});
 const rows=compareBenchmarks(baseline,current);
 const byMetric=Object.fromEntries(rows.map(row=>[row.metric,row]));
 assert.deepEqual([byMetric.runs.baseline,byMetric.runs.current,byMetric.runs.delta],[3,2,-1]);
 assert.equal(byMetric.costUsd.delta,-0.35);
 assert.equal(byMetric.costUsd.percent,-33.3);
 const builder=Object.fromEntries(compareBenchmarks(baseline,current,"developer").map(row=>[row.metric,row]));
 assert.equal(builder.turns.delta,-30);
 const missing=input({executions:[sample("developer",{costUsd:null})]});
 assert.equal(Object.fromEntries(compareBenchmarks(baseline,missing).map(row=>[row.metric,row])).costUsd.delta,null);
});

test("a role absent from one of the runs compares as unknown rather than as a regression",()=>{
 const rows=compareBenchmarks(input(),input({executions:[sample("developer")]}),"reviewer");
 assert.ok(rows.every(row=>row.delta===null&&row.baseline===null&&row.current===null));
});

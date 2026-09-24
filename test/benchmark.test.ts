import test from "node:test";
import assert from "node:assert/strict";
import { buildBenchmarkReport, compareBenchmarks, comparable, type ExecutionSample, type Verification } from "../src/benchmark.js";

const sample=(role:string,over:Partial<ExecutionSample>={}):ExecutionSample=>({
 role,stage:"BUILD",status:"succeeded",startedAt:"t1",finishedAt:"t2",promptBytes:20000,
 inputTokens:100,outputTokens:1000,cacheReadTokens:500000,cacheWriteTokens:20000,totalTokens:521100,
 turns:40,events:1,eventTypes:{result:1},durationMs:60000,...over});

const input=(over:Partial<Parameters<typeof buildBenchmarkReport>[0]>={})=>buildBenchmarkReport({
 workItemId:"w1",issueNumber:9,stage:"DELIVERY",status:"COMPLETED",attempt:0,correctionCycles:1,specVersions:1,
 executions:[sample("developer"),sample("developer",{turns:20,totalTokens:260000}),sample("qa",{stage:"TEST",turns:30,totalTokens:300000})],
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
 assert.equal(builder.totalTokens,781100);
 assert.equal(builder.outcome,"pass","the last outcome of the role, not the first");
 assert.equal(report.totals.runs,3);
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
 const report=input({executions:[sample("developer",{cacheReadTokens:null,turns:null}),sample("developer",{cacheReadTokens:null,turns:null})]});
 assert.equal(report.roles[0].cacheReadTokens,null);
 assert.equal(report.roles[0].turns,null);
 assert.equal(report.roles[0].totalTokens,1042200,"metrics that were reported still add up");
});

test("comparing two runs reports deltas, and never invents one against an unmeasured value",()=>{
 const baseline=input();
 const current=input({executions:[sample("developer",{turns:30,totalTokens:400000}),sample("qa",{stage:"TEST",turns:30,totalTokens:300000,cacheReadTokens:null})]});
 const rows=compareBenchmarks(baseline,current);
 const byMetric=Object.fromEntries(rows.map(row=>[row.metric,row]));
 assert.deepEqual([byMetric.runs.baseline,byMetric.runs.current,byMetric.runs.delta],[3,2,-1]);
 assert.equal(byMetric.totalTokens.delta,-381100);
 assert.equal(byMetric.totalTokens.percent,-35.3);
 const builder=Object.fromEntries(compareBenchmarks(baseline,current,"developer").map(row=>[row.metric,row]));
 assert.equal(builder.turns.delta,-30);
 const missing=input({executions:[sample("developer",{totalTokens:null})]});
 assert.equal(Object.fromEntries(compareBenchmarks(baseline,missing).map(row=>[row.metric,row])).totalTokens.delta,null);
});

test("a role absent from one of the runs compares as unknown rather than as a regression",()=>{
 const rows=compareBenchmarks(input(),input({executions:[sample("developer")]}),"reviewer");
 assert.ok(rows.every(row=>row.delta===null&&row.baseline===null&&row.current===null));
});

const verified=(resolved:boolean):Verification=>({resolved,module:"src/slugify.ts",failures:resolved?0:3,error:null,
 checks:[{behaviour:1,input:"Hello World",expected:"hello-world",actual:resolved?"hello-world":"Hello World",passed:resolved}]});

test("a run that was never verified is not comparable, because nobody checked it did the work",()=>{
 const unverified=input(),resolvedRun=input({verification:verified(true)} as never);
 assert.equal(resolvedRun.verification?.resolved,true);
 assert.match(comparable(unverified,resolvedRun)!,/baseline run was never verified/);
 assert.match(comparable(resolvedRun,unverified)!,/current run was never verified/);
 assert.equal(comparable(resolvedRun,resolvedRun),null);
});

test("a cheaper run that did not resolve the issue is refused rather than reported as an improvement",()=>{
 const good=input({verification:verified(true)} as never);
 const cheapAndWrong=input({verification:verified(false),executions:[sample("developer",{totalTokens:1000,turns:2})]} as never);
 assert.ok((cheapAndWrong.totals.totalTokens ?? 0) < (good.totals.totalTokens ?? 0),"it really is cheaper");
 assert.match(comparable(good,cheapAndWrong)!,/did not resolve the benchmark issue/);
 // The numbers are still produced; what is refused is calling the difference an improvement.
 assert.equal(compareBenchmarks(good,cheapAndWrong).find(row=>row.metric==="totalTokens")?.delta,-1080100);
});

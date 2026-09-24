import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { epicMetrics } from "../src/epic-metrics.js";

test("epic metrics aggregate cost, test selection, verification scope, findings and interventions over the epic and its stories",()=>{
 const store=new Store(":memory:");
 try {
  const item=(id:string,issue:number,status:string,epic:string|null,cycles=0)=>store.db.prepare("INSERT INTO work_items(id,issue_number,issue_id,repo,branch,base_branch,created_at,updated_at,context,stage,status,correction_cycles,epic_work_item_id) VALUES(?,?,?,'owner/demo',?,?,?,?,'{}','DELIVERY',?,?,?)").run(id,issue,issue*10,`factory/issue-${issue}`,epic?"factory/issue-1":"main","2026-09-23T10:00:00Z","2026-09-23T10:00:00Z",status,cycles,epic);
  item("epic",1,"WAITING",null);item("s1",2,"COMPLETED","epic",1);item("s2",3,"COMPLETED","epic");
  store.db.prepare("INSERT INTO stories(epic_work_item_id,spec_version,key,title,scope,criteria,depends_on,assessment,issue_number,issue_id,dependencies_declared,work_item_id,created_at) VALUES('epic',1,'S1','A','a','[\"AC1\"]','[]','{}',2,20,1,'s1','now'),('epic',1,'S2','B','b','[\"AC2\"]','[\"S1\"]','{}',3,30,1,'s2','now')").run();
  const run=(id:string,item:string,role:string,tokens:number|null)=>store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at,finished_at,total_tokens) VALUES(?,?,?,'BUILD','succeeded','now','now',?)").run(id,item,role,tokens);
  run("e1","epic","product-architect",1000);run("a1","s1","developer",4000);run("a2","s1","qa",2000);run("a3","s1","developer",null);run("b1","s2","developer",3000);run("b2","s2","qa",1500);run("e2","epic","qa",800);run("e3","epic","reviewer",700);
  // Turns, not tokens: the multiplier a contract change (fewer screenshots, one script instead of
  // one call per state) is meant to move, and the number that lets two runs be compared directly.
  store.event("execution.finished",{status:"succeeded",activity:{turns:12}},"s1","a1");
  store.event("execution.finished",{status:"succeeded",activity:{turns:8}},"s1","a2");
  store.event("execution.finished",{status:"succeeded",activity:{}},"s1","a3");
  store.event("execution.finished",{status:"succeeded",activity:{turns:20}},"s2","b1");
  store.event("execution.finished",{status:"succeeded",activity:{turns:6}},"s2","b2");
  store.event("execution.finished",{status:"succeeded",activity:{turns:3}},"epic","e1");
  store.event("execution.finished",{status:"succeeded",activity:{turns:5}},"epic","e2");
  store.event("execution.finished",{status:"succeeded",activity:{turns:4}},"epic","e3");
  store.event("workflow.transition",{to:{stage:"BUILD",status:"QUEUED"},reason:{code:"story-started"}},"s1");
  store.db.prepare("UPDATE events SET ts='2026-09-23T10:05:00Z' WHERE work_item_id='s1'").run();
  store.event("workflow.transition",{to:{stage:"DELIVERY",status:"COMPLETED"},reason:{code:"integrated"}},"s1");
  store.db.prepare("UPDATE events SET ts='2026-09-23T11:05:00Z' WHERE work_item_id='s1' AND json_extract(payload,'$.reason.code')='integrated'").run();
  store.event("workflow.transition",{to:{stage:"BUILD",status:"WAITING"},reason:{code:"no-change-pass"}},"s1");
  store.event("verification.selection",{outcome:"pass",verificationDepth:"minimal",candidates:4,kept:2,essential:2,valuable:1,redundant:1,valuableDiscarded:1,commands:1},"s1","a2");
  store.event("verification.selection",{outcome:"pass",verificationDepth:"standard",candidates:6,kept:4,essential:3,valuable:2,redundant:1,valuableDiscarded:1,commands:2},"s2","b2");
  store.event("epic.verification_scope",{role:"qa",criteria:3,verifiedByStories:2,required:1,covered:1},"epic","e2");
  store.event("command.applied",{command:"approve"},"epic");store.event("command.applied",{command:"budget"},"s2");
  store.db.prepare("INSERT INTO records(id,work_item_id,sequence,kind,spec_version,scope,status,applies_to,payload,source_type,source_id,actor,created_at,updated_at) VALUES('f1','epic',1,'finding',1,'spec','open','[]',?,'agent-result','e3','reviewer','now','now'),('f2','s1',1,'finding',1,'spec','open','[]',?,'agent-result','a2','qa','now','now')").run(JSON.stringify({kind:"finding",classification:"auto-fix",severity:"major",originRole:"reviewer",criterionId:"AC1",evidence:"story slice broke"}),JSON.stringify({kind:"finding",classification:"defer",severity:"minor",originRole:"qa",evidence:"nit"}));
  const report=epicMetrics(store,"s2");
  assert.deepEqual(report.workItem,{id:"epic",issue:1,kind:"epic"},"a story resolves to its epic");
  assert.deepEqual(report.members.map(member=>[member.kind,member.key,member.tokens,member.unmeasuredRuns,member.correctionCycles]),[["epic",null,2500,0,0],["story","S1",6000,1,1],["story","S2",4500,0,0]]);
  assert.deepEqual(report.members[1].executions,{developer:2,qa:1});assert.equal(report.members[1].durationSeconds,3600);
  assert.deepEqual(report.totals,{tokens:13000,executions:8,correctionCycles:1,humanCommands:2,stories:2,storiesCompleted:2,wallSeconds:null,unsuccessfulExecutions:0,unsuccessfulSeconds:null,invalidResults:0,longestTimeoutStreak:{stage:null,runs:0}});
  assert.deepEqual(report.testing,{runs:2,candidates:10,kept:6,essential:5,valuable:3,redundant:2,valuableDiscarded:2,keptRatio:0.6,byDepth:{minimal:{runs:1,candidates:4,kept:2},standard:{runs:1,candidates:6,kept:4}}});
  assert.deepEqual(report.turnsByRole,{
   developer:{runs:3,measuredRuns:2,totalTurns:32,avgTurns:16},
   qa:{runs:3,measuredRuns:3,totalTurns:19,avgTurns:6.3},
   "product-architect":{runs:1,measuredRuns:1,totalTurns:3,avgTurns:3},
   reviewer:{runs:1,measuredRuns:1,totalTurns:4,avgTurns:4},
  },"a run with no reported turns still counts toward runs, never toward avgTurns");
  assert.deepEqual(report.epicVerification,[{role:"qa",criteria:3,verifiedByStories:2,required:1,covered:1}]);
  assert.deepEqual(report.findings,{byRole:{reviewer:{major:1},qa:{minor:1}},reviewerOnStoryCriteria:1,noChangePasses:1});
  assert.deepEqual(report.interventions,{commands:2,byKind:{approve:1,budget:1}});
  assert.equal(epicMetrics(store,"epic").workItem.kind,"epic");
 } finally {store.db.close();}
});

test("a plain issue reports itself as the only member",()=>{
 const store=new Store(":memory:");
 try {
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',5,'owner/demo','now','now','{}','BUILD','QUEUED')").run();
  const report=epicMetrics(store,"w");
  assert.deepEqual([report.workItem.kind,report.members.length,report.members[0].kind,report.testing.keptRatio,report.totals.stories],["issue",1,"issue",null,0]);
  assert.deepEqual(report.turnsByRole,{},"no execution.finished event yet, so no role has turns to report");
 } finally {store.db.close();}
});

test("execution outcomes say how many runs ended without a result, what they cost in time and whether a stage keeps timing out",()=>{
 const store=new Store(":memory:");
 try {
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',7,'owner/demo','now','now','{}','TEST','FAILED')").run();
  const run=(id:string,role:string,stage:string,status:string,start:string,end:string|null,reason:string|null=null)=>store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at,finished_at,interruption_reason) VALUES(?,'w',?,?,?,?,?,?)").run(id,role,stage,status,`2026-09-23T10:${start}Z`,end?`2026-09-23T10:${end}Z`:null,reason);
  run("b1","developer","BUILD","succeeded","00:00","08:00");
  run("t1","qa","TEST","timed_out","10:00","20:00","execution-timeout");
  run("t2","qa","TEST","timed_out","21:00","31:00","execution-timeout");
  run("b2","developer","BUILD","interrupted","32:00","33:30","user-pause");
  run("t3","qa","TEST","timed_out","40:00","50:00","execution-timeout");
  run("t4","qa","TEST","failed","51:00",null);
  run("t5","qa","TEST","running","52:00",null);
  store.event("execution.invalid_result",{message:"rejected"},"w","b1");
  const outcomes=epicMetrics(store,"w").members[0].outcomes;
  assert.deepEqual(outcomes.byRole,{developer:{succeeded:1,"interrupted:user-pause":1},qa:{timed_out:3,failed:1,running:1}});
  assert.equal(outcomes.unsuccessful,5,"a running execution has not ended yet");
  assert.equal(outcomes.unsuccessfulSeconds,1890,"three 10-minute timeouts and a 90-second pause; a run without an end adds no time");
  assert.equal(outcomes.invalidResults,1);
  assert.deepEqual(outcomes.longestTimeoutStreak,{stage:"TEST",runs:2},"the Builder run between the second and third timeout ends the streak");
  const totals=epicMetrics(store,"w").totals;
  assert.deepEqual([totals.unsuccessfulExecutions,totals.unsuccessfulSeconds,totals.invalidResults,totals.longestTimeoutStreak],[5,1890,1,{stage:"TEST",runs:2}]);
 } finally {store.db.close();}
});

test("the Architect's runs are split by pass, with the turns and tokens each cost and the spec runs that resumed the brief's session",()=>{
 const store=new Store(":memory:");
 try {
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',9,'owner/demo','now','now','{}','BUILD','QUEUED')").run();
  const run=(id:string,tokens:number|null,outcome:string|null,turns:number|null,resumed=false)=>{
   store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at,finished_at,total_tokens) VALUES(?,'w','product-architect','DESIGN','succeeded',?,'now',?)").run(id,`2026-09-24T10:0${id.length}:00Z`,tokens);
   store.event("execution.finished",{status:"succeeded",activity:turns===null?null:{turns}},"w",id);
   if(outcome)store.event("agent.result",{role:"product-architect",result:{outcome},specVersion:1},"w",id);
   if(resumed)store.event("architect.session_resumed",{sessionId:"s",specVersion:1},"w",id);
  };
  run("b",120000,"brief",8);run("bb",null,null,null);run("sss",40000,"spec",4,true);run("ssss",90000,"spec",11);
  assert.deepEqual(epicMetrics(store,"w").architectPasses,{
   brief:{runs:1,measuredRuns:1,totalTurns:8,avgTurns:8,tokens:120000,unmeasuredTokenRuns:0,resumed:0},
   "no-result":{runs:1,measuredRuns:0,totalTurns:0,avgTurns:null,tokens:0,unmeasuredTokenRuns:1,resumed:0},
   spec:{runs:2,measuredRuns:2,totalTurns:15,avgTurns:7.5,tokens:130000,unmeasuredTokenRuns:0,resumed:1},
  });
 } finally {store.db.close();}
});

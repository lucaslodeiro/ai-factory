import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { progressKey } from "../src/execution-progress.js";
import { heartbeatDue, publishHeartbeats } from "../src/workflow-heartbeat.js";
import { workflowStatusMarkdown } from "../src/workflow-status.js";

const minute=60_000,start="2026-09-24T12:00:00.000Z",t0=Date.parse(start);

test("the heartbeat waits five minutes and new activity, but a run that starts or stops looking stuck is published at once",()=>{
 const run={runId:"r1",events:10,warning:null};
 assert.equal(heartbeatDue(undefined,run,start,t0+4*minute),false,"too soon after the run started");
 assert.equal(heartbeatDue(undefined,run,start,t0+5*minute),true);
 const last={...run,at:t0+5*minute};
 assert.equal(heartbeatDue(last,run,start,t0+15*minute),false,"nothing happened since the last one, so the comment already says it");
 assert.equal(heartbeatDue(last,{...run,events:11},start,t0+9*minute),false);
 assert.equal(heartbeatDue(last,{...run,events:11},start,t0+10*minute),true);
 assert.equal(heartbeatDue(last,{...run,warning:"inactivity"},start,t0+6*minute),true,"a warning is not held back by the interval");
 assert.equal(heartbeatDue({...last,warning:"inactivity"},run,start,t0+6*minute),true,"nor is its clearing");
 assert.equal(heartbeatDue({...last,runId:"r0"},run,start,t0+4*minute),false,"a previous run's heartbeat is not this run's baseline");
});

test("a running agent's status comment is republished with its progress, without commands, and only when due",()=>{
 const store=new Store(":memory:");
 try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status,active_run_id) VALUES('w',7,'owner/repo',?,?,?,'BUILD','RUNNING','run')").run(start,start,JSON.stringify({title:"Slugify"}));
  store.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at) VALUES('run','w','developer','running',?)").run(start);
  const progress=(events:number,at:string)=>store.setMetadata(progressKey("run"),{provider:"codex",events,lastEventAt:at,lastProgressAt:at,tool:"command_execution",toolStartedAt:at,lastTool:"command_execution",repeatedToolCalls:1,usageTokens:412000,validationAttempts:0,lastValidationError:null});
  const revision=()=>(store.db.prepare("SELECT presentation_revision r FROM work_items WHERE id='w'").get() as {r:number}).r;
  progress(20,"2026-09-24T12:05:30.000Z");
  const before=revision();
  assert.equal(publishHeartbeats(store,t0+6*minute),1);assert.equal(revision(),before+1);
  assert.equal(publishHeartbeats(store,t0+7*minute),0,"not again until five minutes and new activity");
  progress(35,"2026-09-24T12:10:00.000Z");
  assert.equal(publishHeartbeats(store,t0+11*minute),1);
  const status=workflowStatusMarkdown(store,"w");
  assert.match(status,/\| Progress \| .*command_execution is running/);
  assert.match(status,/running since 2026-09-24 12:00 UTC · last activity 2026-09-24 12:10 UTC/);
  assert.match(status,/\| This run \| .*tokens reported so far/);
  // The published run went quiet: the next heartbeat says so at once and offers a way out.
  assert.equal(publishHeartbeats(store,t0+16*minute),1);
  assert.match(workflowStatusMarkdown(store,"w"),/may need a look/);
  store.db.prepare("UPDATE executions SET status='succeeded' WHERE id='run'").run();
  assert.equal(publishHeartbeats(store,t0+30*minute),0,"a finished run has no heartbeat; its transition publishes the result");
 }finally{store.db.close();}
});

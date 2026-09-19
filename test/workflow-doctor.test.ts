import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { WorkflowFailures } from "../src/workflow-failures.js";
import { WorkflowProjections } from "../src/workflow-projection.js";
import { WorkflowRecords } from "../src/workflow-records.js";
import { workflowProjectionProblems } from "../src/workflow-doctor.js";

function setup() {
 const store=new Store(":memory:");
 store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,created_at,updated_at,context) VALUES('work-1',1,'owner/demo','SPEC','now','now','{}')").run();
 return store;
}

test("workflow doctor accepts legacy rows and consistent initialized projections",()=>{
 const store=setup();
 try {
  assert.deepEqual(workflowProjectionProblems(store),[]);
  new WorkflowProjections(store).initialize("work-1","DESIGN","QUEUED");
  assert.deepEqual(workflowProjectionProblems(store),[]);
 } finally {store.db.close();}
});

test("workflow doctor reports pointer, status and execution drift without repairing it",()=>{
 const store=setup();
 try {
  const records=new WorkflowRecords(store),failures=new WorkflowFailures(store),projections=new WorkflowProjections(store);
  projections.initialize("work-1","DESIGN","QUEUED");
  records.create({workItemId:"work-1",specVersion:0,scope:"spec",payload:{kind:"request",type:"clarification",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["DESIGN"],openedAfterCommentId:1},sourceType:"orchestrator",sourceId:"test",actor:"test"});
  failures.open({workItemId:"work-1",class:"recovery",message:"lost route",stage:"DESIGN",attempt:0});
  store.db.prepare("UPDATE work_items SET status='RUNNING',active_run_id='missing' WHERE id='work-1'").run();
  const before=store.db.prepare("SELECT * FROM work_items WHERE id='work-1'").get();
  const problems=workflowProjectionProblems(store);
  assert.ok(problems.some(problem=>problem.includes("activeRequestId")));
  assert.ok(problems.some(problem=>problem.includes("activeFailureId")));
  assert.ok(problems.some(problem=>problem.includes("WAITING")));
  assert.ok(problems.some(problem=>problem.includes("FAILED")));
  assert.ok(problems.some(problem=>problem.includes("activeRunId")));
  assert.deepEqual(store.db.prepare("SELECT * FROM work_items WHERE id='work-1'").get(),before);
 } finally {store.db.close();}
});

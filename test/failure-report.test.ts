import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { failureDiagnosis, workflowFailureEvidence } from "../src/failure-report.js";
import { Store } from "../src/storage.js";
import { WorkflowFailures } from "../src/workflow-failures.js";

test("V3 failure evidence is actionable and redacts local paths, tokens and ANSI output",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-failure-report-")),previous=config.dataDir;config.dataDir=root;
 const store=new Store(":memory:");
 try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',1,'owner/demo','now','now','{}','TEST','RUNNING')").run();
  store.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at,finished_at,exit_code) VALUES('run','w','qa','failed','now','now',2)").run();
  const runDir=path.join(root,"runs","run");fs.mkdirSync(runDir,{recursive:true});fs.writeFileSync(path.join(runDir,"stderr.log"),`Authorization: Bearer secret-value-123456\n\u001b[31mcompilation failed\u001b[0m\n`);
  const failure=new WorkflowFailures(store).open({workItemId:"w",executionId:"run",class:"execution",message:`${os.homedir()}/project failed`,stage:"TEST",attempt:2});
  const markdown=workflowFailureEvidence(store,failure);
  assert.match(markdown,/Failure class:\*\* execution/);assert.match(markdown,/Agent:\*\* Tester/);assert.match(markdown,/exit 2/);
  assert.match(markdown,/agent subprocess failed/i);assert.match(markdown,/compilation failed/);assert.match(markdown,/~\/project failed/);
  assert.doesNotMatch(markdown,/secret-value-123456|\u001b\[31m/);assert.match(markdown,/\[REDACTED\]/);
  assert.match(failureDiagnosis("Changes require actionable findings","Playwright chrome-headless-shell MachPortRendezvous Permission denied"),/Do not repeat the same Chromium validation/);
  assert.match(failureDiagnosis("PASS requires successful executed tests with exit codes",""),/returned PASS/);
 }finally{store.db.close();config.dataDir=previous;fs.rmSync(root,{recursive:true,force:true});}
});

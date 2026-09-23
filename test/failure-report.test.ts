import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { agentOutputExcerpt,failureDiagnosis, workflowFailureEvidence } from "../src/failure-report.js";
import { Store } from "../src/storage.js";
import { WorkflowFailures } from "../src/workflow-failures.js";

test("V3 failure evidence is actionable and redacts local paths, tokens and ANSI output",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-failure-report-")),previous=config.dataDir;config.dataDir=root;
 const store=new Store(":memory:");
 try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',1,'owner/demo','now','now','{}','TEST','RUNNING')").run();
  store.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at,finished_at,exit_code) VALUES('run','w','qa','failed','now','now',2)").run();
  const runDir=path.join(root,"runs","run");fs.mkdirSync(runDir,{recursive:true});fs.writeFileSync(path.join(runDir,"stderr.log"),`Authorization: Bearer secret-value-123456\n\u001b[31mcompilation failed\u001b[0m\n`);
  fs.writeFileSync(path.join(runDir,"stdout.log"),[
   JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"I am checking the build command."},{type:"tool_use",name:"Read",input:{file_path:"/private/secret"}}]}}),
   JSON.stringify({type:"user",message:{content:[{type:"tool_result",content:"private source content"}]}}),
  ].join("\n"));
  const failure=new WorkflowFailures(store).open({workItemId:"w",executionId:"run",class:"execution",message:`${os.homedir()}/project failed`,stage:"TEST",attempt:2});
  const markdown=workflowFailureEvidence(store,failure);
  assert.match(markdown,/Failure class:\*\* execution/);assert.match(markdown,/Agent:\*\* Tester/);assert.match(markdown,/exit 2/);
  assert.match(markdown,/agent subprocess failed/i);assert.match(markdown,/compilation failed/);assert.match(markdown,/~\/project failed/);
  assert.match(markdown,/Last agent output[\s\S]*I am checking the build command[\s\S]*Last tool: Read/);
  assert.doesNotMatch(markdown,/private source content|private\/secret/);
  assert.doesNotMatch(markdown,/secret-value-123456|\u001b\[31m/);assert.match(markdown,/\[REDACTED\]/);
  assert.match(failureDiagnosis("Changes require actionable findings","Playwright chrome-headless-shell MachPortRendezvous Permission denied"),/Do not repeat the same Chromium validation/);
  assert.match(failureDiagnosis("PASS requires successful executed tests with exit codes",""),/returned PASS/);
  const invalid=failureDiagnosis("Coverage entry AC-4 is missing executed evidence","",undefined, "invalid-result");
  assert.match(invalid,/Coverage entry AC-4 is missing executed evidence/);assert.match(invalid,/Correct the stated report requirement/);
  assert.match(failureDiagnosis("[integration] Pull request create failed: Base ref must be a branch",""),/configured base branch is unavailable[\s\S]*reuse the successful review/);
  assert.match(failureDiagnosis("[integration] GraphQL: No commits between main and factory\/issue-1",""),/no commits between[\s\S]*retry Delivery/i);
  assert.match(failureDiagnosis("Execution run failed: You've hit your session limit · resets 7:20pm","",{status:"failed",exit_code:1},"execution"),/session limit[\s\S]*Wait until the provider's reported reset time/);
  assert.match(failureDiagnosis("Failed to provide valid structured output after 5 attempts","",{status:"failed",exit_code:1},"execution"),/exhausted its attempts[\s\S]*schema error/);
  assert.match(failureDiagnosis("Execution 8a639fd5-3622-4f4f-9794-aa0620de626b failed: rate limit exceeded","",{status:"failed",exit_code:1},"execution"),/provider reported an error[\s\S]*rate limit exceeded/);
 }finally{store.db.close();config.dataDir=previous;fs.rmSync(root,{recursive:true,force:true});}
});

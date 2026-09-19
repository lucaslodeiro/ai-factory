import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { failureMarkdown } from "../src/failure-report.js";
import { Store } from "../src/storage.js";

test("failure report provides useful execution evidence and redacts troubleshooting output", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-failure-report-")),previousDataDir=config.dataDir;
  config.dataDir=root;
  const store=new Store(":memory:");
  try {
    const context={title:"Demo",body:"",url:"https://example.test/issues/1",version:1,cursor:0,feedback:[],cycles:0,reports:{},resume:"DEVELOPMENT"};
    store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,created_at,updated_at,context) VALUES(?,?,?,?,?,?,?)").run("work-1",1,"owner/demo","FAILED","now","now",JSON.stringify(context));
    store.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at,finished_at,exit_code) VALUES(?,?,?,?,?,?,?)").run("run-1","work-1","developer","failed","2026-01-01T00:00:00Z","2026-01-01T00:00:03Z",2);
    store.event("execution.started",{role:"developer",selection:{provider:"codex",model:"gpt-test"}},"work-1","run-1");
    const runDir=path.join(root,"runs","run-1"); fs.mkdirSync(runDir,{recursive:true});
    fs.writeFileSync(path.join(runDir,"stderr.log"),`${Array.from({length:34},(_,index)=>`diagnostic ${index}`).join("\n")}\nAuthorization: Bearer secret-value-123456\n\u001b[31mcompilation failed\u001b[0m\n`);
    const markdown=failureMarkdown(store,store.get("work-1")!,new Error(`${config.repoDir}/src/app.ts failed`));
    assert.match(markdown,/\*\*Stage:\*\* Build/); assert.match(markdown,/\*\*Agent:\*\* Builder/);
    assert.match(markdown,/Codex|codex/); assert.match(markdown,/gpt-test/); assert.match(markdown,/exit 2/);
    assert.match(markdown,/Last 30 stderr lines/); assert.match(markdown,/compilation failed/); assert.doesNotMatch(markdown,/diagnostic 0/);
    assert.match(markdown,/### Troubleshooting[\s\S]*#### Diagnosis[\s\S]*agent subprocess failed[\s\S]*exit code 2/i);
    assert.doesNotMatch(markdown,/secret-value-123456|\u001b\[31m/); assert.match(markdown,/\[REDACTED\]/);
    assert.match(markdown,/<target-checkout>\/src\/app\.ts failed/); assert.match(markdown,/\/factory retry/);
    assert.match(markdown,/### Next actions[\s\S]*From this GitHub issue[\s\S]*From the dashboard[\s\S]*From the factory terminal[\s\S]*npm run factory -- retry work-1\n```$/);

    store.db.prepare("UPDATE executions SET status='succeeded',exit_code=0 WHERE id='run-1'").run();
    fs.writeFileSync(path.join(runDir,"stderr.log"),"Playwright launching chrome-headless-shell\nFATAL MachPortRendezvous bootstrap_check_in: Permission denied\n");
    const chromium=failureMarkdown(store,store.get("work-1")!,new Error("Changes require actionable findings"));
    assert.match(chromium,/#### Diagnosis[\s\S]*orchestrator rejected its report[\s\S]*Playwright\/Chromium also failed/i);
    assert.match(chromium,/Do not repeat the same Chromium validation/);
  } finally { store.db.close(); config.dataDir=previousDataDir; fs.rmSync(root,{recursive:true,force:true}); }
});

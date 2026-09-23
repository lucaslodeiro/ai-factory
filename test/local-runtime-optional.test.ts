import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { WorkflowRunner } from "../src/workflow-runner.js";
import { WorkflowIntake } from "../src/workflow-inbox.js";
import { WorkflowCommands } from "../src/workflow-commands.js";
import { result } from "./fixtures.js";
import type { AgentAdapter } from "../src/adapters/agent.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// browserRequired fires on the repository's dependencies, not on what the issue asks for, so a
// repository that happens to contain browser tests starts a preview server for every issue.
const checkout=fs.mkdtempSync(path.join(os.tmpdir(),"factory-browser-repo-"));
fs.writeFileSync(path.join(checkout,"package.json"),JSON.stringify({devDependencies:{"@playwright/test":"1.0.0"},scripts:{"local:serve":"node serve.js"}}));
test.after(()=>fs.rmSync(checkout,{recursive:true,force:true}));

const issue={id:100,nodeId:"I_100",number:9,title:"Benchmark: add a slugify helper",body:"Add a pure slugify function",url:"https://github.com/owner/demo/issues/9",state:"OPEN" as const,createdAt:"2026-09-22T00:00:00Z",updatedAt:"2026-09-22T00:00:00Z",author:{login:"owner",type:"User"}};
class Workspace {
 ensure(){return checkout;} assertBranch(){} head(){return "head";} diff(){return "";} check(){} commit(){} publish(){}
 sync(){return {before:"a",after:"a",merged:[]};} changeSummary(){return {files:[],stat:""};}
 prepareReviewerContext(){return {path:"/dev/null",files:[],stat:""};} cleanupReviewerContext(){}
}

// The Factory starts the target repository's preview server for browser checks. Issue 9 adds a
// pure string function and never asked for a browser, yet a preview server that would not start
// failed the whole stage before a single agent ran.
test("a preview server that will not start does not fail the stage",async()=>{
 const store=new Store(":memory:"),item=new WorkflowIntake(store).start(issue,{actor:"dashboard",source:"control"});
 let instructions="";
 const adapter=(value:ReturnType<typeof result>):AgentAdapter=>({async run(request){
  instructions=request.instructions;
  store.db.prepare("UPDATE executions SET status='succeeded',total_tokens=1000 WHERE id=?").run(request.executionId);
  return value;}});
 const runtime={async ensure(){throw new Error("Factory local runtime did not become ready. See /data/x.log");},
  async stop(){},async reconcile(){},async close(){}};
 try{
  const runner=new WorkflowRunner(store,{"product-architect":adapter(result("spec")),developer:adapter(result("pass"))},
   new Workspace() as never,{ensurePR(){return "unused";}},runtime as never);
  await runner.run(item.id);
  new WorkflowCommands(store).apply({kind:"approve",version:1,guidance:""},{workItemId:item.id,login:"owner",commentId:1,specVersion:1});
  await runner.run(item.id);
  const stage=(store.db.prepare("SELECT stage,status FROM work_items WHERE id=?").get(item.id) as {stage:string;status:string});
  assert.notEqual(stage.status,"FAILED","the stage ran without the preview server");
  const failed=store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='runtime.local_failed'").all(item.id) as Array<{payload:string}>;
  assert.equal(failed.length>0,true,"the operator can still see it happened");
  assert.match(JSON.parse(failed[0].payload).reason,/did not become ready/);
 assert.match(instructions,/tried to start this project's preview server/,"the agent is told, so it does not spend turns rediscovering it");
 assert.match(instructions,/environment-blocked/);
 } finally { store.db.close(); }
});

test("every adapter forwards the supervised runtime, so no agent starts a second preview server",()=>{
 // Issue 6 ended with two runtimes of the same worktree alive at once. An adapter that drops the
 // URL tells its agent to start its own beside the one the Factory already supervises.
 for (const provider of ["codex","claude","cursor"]) {
  const source=fs.readFileSync(new URL(`../src/adapters/${provider}.ts`,import.meta.url),"utf8");
  assert.match(source,/r\.localRuntimeUrl/,`${provider} must pass the supervised runtime through`);
 }
});

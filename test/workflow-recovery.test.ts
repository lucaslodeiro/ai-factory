import test from "node:test";
import assert from "node:assert/strict";
import {Store} from "../src/storage.js";
import {WorkflowProjections} from "../src/workflow-projection.js";
import {WorkflowScheduler} from "../src/workflow-scheduler.js";
import {WorkflowCommands} from "../src/workflow-commands.js";
import {WorkflowFailures} from "../src/workflow-failures.js";
import {recoverAbandonedExecutions} from "../src/daemon.js";

test("unexpected daemon loss fails the same stage and retry preserves its worktree",()=>{const store=new Store(":memory:");try{store.db.prepare("INSERT INTO work_items(id,issue_number,repo,branch,created_at,updated_at,context,stage,status) VALUES('w',1,'owner/repo','factory/issue-1-w','now','now',?,'BUILD','QUEUED')").run(JSON.stringify({cwd:"/tmp/preserved-worktree"}));store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,approved_by) VALUES('w',1,'SPEC','[]','owner')").run();const scheduler=new WorkflowScheduler(store),run=scheduler.begin("w");assert.equal(recoverAbandonedExecutions(store),1);let projection=new WorkflowProjections(store).get("w");assert.deepEqual({stage:projection.stage,status:projection.status},{stage:"BUILD",status:"FAILED"});assert.equal(new WorkflowFailures(store).active("w")?.class,"recovery");assert.deepEqual(store.db.prepare("SELECT status,interruption_reason FROM executions WHERE id=?").get(run.executionId),{status:"interrupted",interruption_reason:"unexpected-shutdown"});new WorkflowCommands(store).apply({kind:"retry",guidance:"continue from preserved work"},{workItemId:"w",login:"owner",commentId:2,specVersion:1});projection=new WorkflowProjections(store).get("w");assert.deepEqual({stage:projection.stage,status:projection.status,attempt:projection.attempt},{stage:"BUILD",status:"QUEUED",attempt:1});assert.equal(JSON.parse((store.db.prepare("SELECT context FROM work_items WHERE id='w'").get() as any).context).cwd,"/tmp/preserved-worktree");}finally{store.db.close();}});

import test from "node:test";
import assert from "node:assert/strict";
import {Store} from "../src/storage.js";
import {WorkflowOrchestrator} from "../src/workflow-orchestrator.js";
import {applyControllerLoss} from "../src/controller-fence.js";
import {WorkflowProjections} from "../src/workflow-projection.js";

test("publisher flush verifies repository control before any GitHub mutation",async()=>{const store=new Store(":memory:");let writes=0;const github={publishWorkflowComment(){writes++;},syncWorkflow(){writes++;},assignees(){return[];},assign(){writes++;},unassign(){writes++;}} as any,runner={} as any,notifications={enabled:false,async notify(){}};try{const orchestrator=new WorkflowOrchestrator(store,github,runner,notifications,undefined,{assertController(){throw new Error("fenced");},resultDisposition(){return"discard";}});await assert.rejects(()=>orchestrator.flush(),/fenced/);assert.equal(writes,0);}finally{store.db.close();}});

test("controller loss interrupts active work and pauses its projection",()=>{const store=new Store(":memory:"),interrupts:Array<[string,string]>=[];let discarded=0;try{store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status,active_run_id) VALUES('work',1,'owner/demo','now','now','{}','BUILD','RUNNING','run')").run();store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at) VALUES('run','work','developer','BUILD','running','now')").run();applyControllerLoss(store,{interrupt(run,reason){interrupts.push([run,reason]);}},{discardHeld(){discarded++;}},7);assert.deepEqual(interrupts,[["run","controller-lost"]]);assert.equal(discarded,1);assert.equal(new WorkflowProjections(store).get("work").status,"PAUSED");assert.equal((store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='controller.lost'").get() as any).count,1);}finally{store.db.close();}});

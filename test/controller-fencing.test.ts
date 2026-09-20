import test from "node:test";
import assert from "node:assert/strict";
import {Store} from "../src/storage.js";
import {WorkflowOrchestrator} from "../src/workflow-orchestrator.js";

test("publisher flush verifies repository control before any GitHub mutation",async()=>{const store=new Store(":memory:");let writes=0;const github={publishWorkflowComment(){writes++;},syncWorkflow(){writes++;},assignees(){return[];},assign(){writes++;},unassign(){writes++;}} as any,runner={} as any,notifications={enabled:false,async notify(){}};try{const orchestrator=new WorkflowOrchestrator(store,github,runner,notifications,undefined,{assertController(){throw new Error("fenced");},resultDisposition(){return"discard";}});await assert.rejects(()=>orchestrator.flush(),/fenced/);assert.equal(writes,0);}finally{store.db.close();}});

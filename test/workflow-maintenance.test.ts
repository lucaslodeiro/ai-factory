import test from "node:test";
import assert from "node:assert/strict";
import {Store} from "../src/storage.js";
import {WorkflowProjections} from "../src/workflow-projection.js";
import {WorkflowMaintenance} from "../src/workflow-maintenance.js";

function fixture(running=false){
 const store=new Store(":memory:");store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,created_at,updated_at,context) VALUES('w',7,'owner/repo','SPEC','now','now',?)").run(JSON.stringify({title:"Safe maintenance"}));
 const projections=new WorkflowProjections(store);projections.initialize("w","DESIGN","QUEUED");
 let active=false,runId:string|undefined;
 if(running){runId="run";projections.transition({workItemId:"w",expectedRevision:0,stage:"DESIGN",status:"RUNNING",activeRunId:runId,actor:{type:"orchestrator",id:"test"},source:{executionId:runId},reason:{code:"test",summary:"running"}},()=>store.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at) VALUES('run','w','product-architect','running',?)").run(new Date().toISOString()));active=true;}
 const executions={isRunning:(id:string)=>active&&id===runId,interrupt:(id:string,reason:string)=>{assert.equal(reason,"planned-maintenance");active=false;store.db.prepare("UPDATE executions SET status='interrupted',interruption_reason=? WHERE id=?").run(reason,id);return true;}} as any;
 return {store,projections,maintenance:new WorkflowMaintenance(store,executions)};
}

test("maintenance binds confirmation to exact revisions, pauses and resumes queued work",async()=>{const f=fixture();try{const request=f.maintenance.request("update","owner");assert.equal(request.confirmationRequired,true);assert.equal(request.affected[0].title,"Safe maintenance");await f.maintenance.confirm(request.id);assert.equal(f.projections.get("w").status,"PAUSED");assert.deepEqual(f.maintenance.resume(request.id),["w"]);assert.equal(f.projections.get("w").status,"QUEUED");assert.equal(f.projections.get("w").attempt,1);}finally{f.store.db.close();}});

test("maintenance interrupts a running execution without recording cancellation or failure",async()=>{const f=fixture(true);try{const request=f.maintenance.request("daemon-restart","owner");await f.maintenance.confirm(request.id);assert.equal(f.projections.get("w").status,"PAUSED");assert.deepEqual(f.store.db.prepare("SELECT status,interruption_reason,maintenance_id FROM executions WHERE id='run'").get(),{status:"interrupted",interruption_reason:"planned-maintenance",maintenance_id:request.id});assert.equal(f.store.db.prepare("SELECT COUNT(*) count FROM failures").get() && (f.store.db.prepare("SELECT COUNT(*) count FROM failures").get() as any).count,0);}finally{f.store.db.close();}});

test("maintenance confirmation expires when affected work revisions change",async()=>{const f=fixture();try{const request=f.maintenance.request("update","owner");const current=f.projections.get("w");f.projections.present({workItemId:"w",expectedRevision:current.revision,actor:{type:"human",id:"owner"},source:{},reason:{code:"changed",summary:"presentation only"}});await f.maintenance.confirm(request.id);assert.equal(f.projections.get("w").status,"PAUSED");
 const second=f.maintenance.request("update","owner");const queued=f.maintenance.resume(request.id);assert.deepEqual(queued,["w"]);await assert.rejects(f.maintenance.confirm(second.id),/Active work changed/);}finally{f.store.db.close();}});

import { randomUUID } from "node:crypto";
import type { Store } from "./storage.js";
import { WorkflowFailures } from "./workflow-failures.js";
import { WorkflowRecords, type V3Stage, type WorkflowRecord } from "./workflow-records.js";
import {workflowNotificationText} from "./notifications.js";

export type V3Status="QUEUED"|"RUNNING"|"WAITING"|"FAILED"|"PAUSED"|"CANCELLED"|"COMPLETED";
export interface WorkflowProjection {
 stage:V3Stage;status:V3Status;attempt:number;revision:number;presentationRevision:number;publishedPresentationRevision?:number;
 activeRunId?:string;activeRequestId?:string;activeFailureId?:string;correctionCycles:number;archivedAt?:string;
}
export interface TransitionActor { type:"human"|"agent"|"orchestrator"|"github";id:string; }
export interface TransitionSource { commentId?:number;executionId?:string;controlId?:number; }
export interface TransitionInput {
 workItemId:string;expectedRevision:number;stage:V3Stage;status:V3Status;actor:TransitionActor;source:TransitionSource;
 reason:{code:string;summary:string};recordIds?:string[];activeRunId?:string;attemptDelta?:number;correctionCycles?:number;
}
export interface PresentationInput { workItemId:string;expectedRevision:number;actor:TransitionActor;source:TransitionSource;reason:{code:string;summary:string};recordIds?:string[]; }
type Row={stage:string|null;status:string|null;attempt:number;revision:number;presentation_revision:number;published_presentation_revision:number|null;active_run_id:string|null;active_request_id:string|null;active_failure_id:string|null;correction_cycles:number;archived_at:string|null};

function projection(row:Row):WorkflowProjection {
 if (!row.stage || !row.status) throw new Error("Workflow projection is not initialized");
 return {stage:row.stage as V3Stage,status:row.status as V3Status,attempt:row.attempt,revision:row.revision,presentationRevision:row.presentation_revision,
  publishedPresentationRevision:row.published_presentation_revision??undefined,activeRunId:row.active_run_id??undefined,activeRequestId:row.active_request_id??undefined,
  activeFailureId:row.active_failure_id??undefined,correctionCycles:row.correction_cycles,archivedAt:row.archived_at??undefined};
}

function requestOwner(record:WorkflowRecord|undefined) {
 return record?.kind === "request" ? (record.payload as Extract<WorkflowRecord["payload"],{kind:"request"}>).owner : undefined;
}

export class WorkflowProjections {
 private records:WorkflowRecords; private failures:WorkflowFailures;
 constructor(private store:Store) { this.records=new WorkflowRecords(store);this.failures=new WorkflowFailures(store); }
 get(workItemId:string) {
  const row=this.store.db.prepare("SELECT stage,status,attempt,revision,presentation_revision,published_presentation_revision,active_run_id,active_request_id,active_failure_id,correction_cycles,archived_at FROM work_items WHERE id=?").get(workItemId) as Row|undefined;
  if (!row) throw new Error("Unknown work item");
  return projection(row);
 }
 initialize(workItemId:string,stage:V3Stage,status:V3Status) {
  const run=this.store.db.transaction(()=>{
   const current=this.store.db.prepare("SELECT stage FROM work_items WHERE id=?").get(workItemId) as {stage:string|null}|undefined;
   if (!current) throw new Error("Unknown work item");
   if (current.stage) throw new Error("Workflow projection is already initialized");
   const activeRequest=this.records.activeRequest(workItemId),activeFailure=this.failures.active(workItemId);
   this.validate(status,activeRequest,activeFailure,undefined);
   this.store.db.prepare("UPDATE work_items SET stage=?,status=?,active_request_id=?,active_failure_id=? WHERE id=?")
    .run(stage,status,activeRequest?.id??null,activeFailure?.id??null,workItemId);
   return this.get(workItemId);
  });
  return run.immediate();
 }
 resumeStatus(workItemId:string):V3Status { return requestOwner(this.records.activeRequest(workItemId)) === "human" ? "WAITING" : "QUEUED"; }
 transition(input:TransitionInput,mutations?:()=>void) {
  const run=this.store.db.transaction(()=>{
   const from=this.get(input.workItemId);
   if (from.revision !== input.expectedRevision) throw new Error(`Workflow revision changed: expected ${input.expectedRevision}, found ${from.revision}`);
   mutations?.();
   const activeRequest=this.records.activeRequest(input.workItemId),activeFailure=this.failures.active(input.workItemId);
   const activeRunId=input.status === "RUNNING" ? input.activeRunId : undefined;
   this.validate(input.status,activeRequest,activeFailure,activeRunId);
   const to:WorkflowProjection={...from,stage:input.stage,status:input.status,attempt:from.attempt+(input.attemptDelta??0),revision:from.revision+1,
    presentationRevision:from.presentationRevision+1,activeRunId,activeRequestId:activeRequest?.id,activeFailureId:activeFailure?.id,
    correctionCycles:input.correctionCycles??from.correctionCycles};
   const updated=this.store.db.prepare(`UPDATE work_items SET stage=?,status=?,attempt=?,revision=?,presentation_revision=?,active_run_id=?,active_request_id=?,active_failure_id=?,correction_cycles=?,updated_at=? WHERE id=? AND revision=?`)
    .run(to.stage,to.status,to.attempt,to.revision,to.presentationRevision,to.activeRunId??null,to.activeRequestId??null,to.activeFailureId??null,to.correctionCycles,new Date().toISOString(),input.workItemId,from.revision);
   if (updated.changes !== 1) throw new Error("Workflow projection changed concurrently");
   const eventId=randomUUID();
   const specVersion=(this.store.db.prepare("SELECT MAX(version) AS version FROM specs WHERE work_item_id=?").get(input.workItemId) as {version:number|null}).version??0;
   this.store.event("workflow.transition",{schemaVersion:1,eventId,type:"workflow.transition",workItemId:input.workItemId,occurredAt:new Date().toISOString(),actor:input.actor,source:input.source,
    from,to,reason:input.reason,recordIds:input.recordIds??[],activeRequestId:to.activeRequestId,activeFailureId:to.activeFailureId,specVersion},input.workItemId,input.source.executionId);
   this.store.db.prepare("INSERT INTO notifications(body,work_item_id) VALUES(?,?)").run(workflowNotificationText(this.store,input.workItemId,to,input.reason),input.workItemId);
   return to;
  });
  return run.immediate();
 }
 present(input:PresentationInput,mutations?:()=>void) {
  const run=this.store.db.transaction(()=>{
   const from=this.get(input.workItemId);
   if (from.revision!==input.expectedRevision) throw new Error(`Workflow revision changed: expected ${input.expectedRevision}, found ${from.revision}`);
   mutations?.();
   const next=from.presentationRevision+1;
   const updated=this.store.db.prepare("UPDATE work_items SET presentation_revision=? WHERE id=? AND revision=? AND presentation_revision=?")
    .run(next,input.workItemId,from.revision,from.presentationRevision);
   if(updated.changes!==1)throw new Error("Workflow presentation changed concurrently");
   this.store.event("workflow.presentation",{schemaVersion:1,workItemId:input.workItemId,occurredAt:new Date().toISOString(),actor:input.actor,source:input.source,reason:input.reason,recordIds:input.recordIds??[],from:from.presentationRevision,to:next},input.workItemId,input.source.executionId);
   return {...from,presentationRevision:next};
  });
  return run.immediate();
 }
 private validate(status:V3Status,activeRequest:WorkflowRecord|undefined,activeFailure:ReturnType<WorkflowFailures["active"]>,activeRunId:string|undefined) {
  const owner=requestOwner(activeRequest);
  if (status === "WAITING" && owner !== "human") throw new Error("WAITING requires exactly one human-owned active request");
  if (owner === "human" && !["WAITING","PAUSED"].includes(status)) throw new Error("A human-owned active request must be waiting or paused");
  if (owner === "architect" && !["QUEUED","RUNNING","PAUSED"].includes(status)) throw new Error("An Architect-owned active request must be queued, running or paused");
  if (status === "FAILED" && !activeFailure) throw new Error("FAILED requires exactly one active failure");
  if (activeFailure && !["FAILED","PAUSED"].includes(status)) throw new Error("An active failure must be failed or paused");
  if ((status === "RUNNING") !== Boolean(activeRunId)) throw new Error("RUNNING requires exactly one active run id");
 }
}

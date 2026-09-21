import { randomUUID } from "node:crypto";
import type { AgentRole, DeliveryStage } from "./types.js";
import type { Store } from "./storage.js";

export type RecordKind = "instruction" | "decision" | "finding" | "request";
export type RecordScope = "spec" | "issue";
export type RecordStatus = "active" | "open" | "resolved" | "accepted-defer" | "superseded" | "revoked" | "cancelled";
export type RequestType = "clarification" | "spec-approval" | "tactical-decision" | "correction-limit" | "merge";
export type V3Stage = "DESIGN" | "BUILD" | "TEST" | "REVIEW" | "DELIVERY";

export type WorkflowRecordPayload =
 | { kind:"instruction"; text:string; supersedes?:string[] }
 | { kind:"decision"; category:"human"|"tactical"; decision:string; rationale:string; supersedes:string[] }
 | { kind:"finding"; classification:"auto-fix"|"decision-required"|"defer"|"environment-blocked"; originRole:AgentRole; criterionId?:string; evidence:string }
 | { kind:"request"; type:RequestType; owner:"human"|"architect"; originatingStage:V3Stage; allowedReturnStages:V3Stage[]; openedAfterCommentId:number; questions?:string[]; findingIds?:string[]; prClosed?:boolean };

export interface WorkflowRecord<T extends WorkflowRecordPayload = WorkflowRecordPayload> {
 id:string; workItemId:string; sequence:number; kind:T["kind"]; specVersion:number; scope:RecordScope; status:RecordStatus;
 appliesTo:AgentRole[]; payload:T; sourceType:"github-comment"|"dashboard"|"agent-result"|"orchestrator"; sourceId:string; actor:string;
 parentId?:string; supersededBy?:string; resolvedBy?:string; createdAt:string; updatedAt:string;
}

export interface CreateWorkflowRecord<T extends WorkflowRecordPayload> {
 workItemId:string; specVersion:number; scope:RecordScope; status?:RecordStatus; appliesTo?:AgentRole[]; payload:T;
 sourceType:WorkflowRecord["sourceType"]; sourceId:string; actor:string; parentId?:string;
}

type Row = { id:string;work_item_id:string;sequence:number;kind:RecordKind;spec_version:number;scope:RecordScope;status:RecordStatus;applies_to:string;payload:string;source_type:WorkflowRecord["sourceType"];source_id:string;actor:string;parent_id:string|null;superseded_by:string|null;resolved_by:string|null;created_at:string;updated_at:string };

function parse(row:Row):WorkflowRecord {
 return {id:row.id,workItemId:row.work_item_id,sequence:row.sequence,kind:row.kind,specVersion:row.spec_version,scope:row.scope,status:row.status,
  appliesTo:JSON.parse(row.applies_to),payload:JSON.parse(row.payload),sourceType:row.source_type,sourceId:row.source_id,actor:row.actor,
  parentId:row.parent_id ?? undefined,supersededBy:row.superseded_by ?? undefined,resolvedBy:row.resolved_by ?? undefined,createdAt:row.created_at,updatedAt:row.updated_at};
}

export class WorkflowRecords {
 constructor(private store:Store) {}
 create<T extends WorkflowRecordPayload>(input:CreateWorkflowRecord<T>):WorkflowRecord<T> {
  const run=this.store.db.transaction(()=>{
   const allowed:Record<RecordKind,RecordStatus[]>={instruction:["active"],decision:["active"],finding:["open"],request:["open"]};
   const initialStatus=input.status ?? (input.payload.kind === "request" || input.payload.kind === "finding" ? "open" : "active");
   if (!allowed[input.payload.kind].includes(initialStatus)) throw new Error(`A new ${input.payload.kind} record cannot start as ${initialStatus}`);
   if (input.payload.kind === "request") {
    if (input.parentId) {
     const parent=this.get(input.parentId);
     if (!parent || parent.workItemId !== input.workItemId || parent.kind !== "request" || parent.status !== "open") throw new Error("Request parent must be an open request on the same work item");
     const sibling=this.store.db.prepare("SELECT id FROM records WHERE parent_id=? AND kind='request' AND status='open'").get(input.parentId);
     if (sibling) throw new Error("An open request may have only one open child");
    } else if (this.store.db.prepare("SELECT id FROM records WHERE work_item_id=? AND kind='request' AND status='open'").get(input.workItemId)) {
     throw new Error("A new open request must extend the existing request chain");
    }
   }
   const supersedes=input.payload.kind === "instruction" || input.payload.kind === "decision" ? input.payload.supersedes??[] : [];
   const targets=supersedes.map(id=>{
    const target=this.get(id);
    if (!target || target.workItemId !== input.workItemId || target.kind !== input.payload.kind || target.status !== "active") throw new Error(`Superseded record ${id} must be an active ${input.payload.kind} on the same work item`);
    if (target.payload.kind === "decision" && target.payload.category === "human" && input.sourceType !== "github-comment") throw new Error("An agent-originated decision cannot supersede a human decision");
    return target;
   });
   const sequence=((this.store.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS value FROM records WHERE work_item_id=?").get(input.workItemId) as {value:number}).value);
   const id=randomUUID(),now=new Date().toISOString(),status=initialStatus;
   this.store.db.prepare(`INSERT INTO records(id,work_item_id,sequence,kind,spec_version,scope,status,applies_to,payload,source_type,source_id,actor,parent_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.workItemId,sequence,input.payload.kind,input.specVersion,input.scope,status,JSON.stringify(input.appliesTo ?? []),JSON.stringify(input.payload),input.sourceType,input.sourceId,input.actor,input.parentId ?? null,now,now);
   const supersede=this.store.db.prepare("UPDATE records SET status='superseded',superseded_by=?,updated_at=? WHERE id=? AND status='active'");
   for (const target of targets) if (supersede.run(id,now,target.id).changes!==1) throw new Error(`Superseded record ${target.id} changed concurrently`);
   return this.get(id)! as WorkflowRecord<T>;
  });
  return run.immediate();
 }
 get(id:string) {
  const row=this.store.db.prepare("SELECT * FROM records WHERE id=?").get(id) as Row|undefined;
  return row ? parse(row) : undefined;
 }
 active(workItemId:string,specVersion:number,role:AgentRole) {
  const rows=this.store.db.prepare(`SELECT * FROM records WHERE work_item_id=?
   AND status IN ('active','open') AND (scope='issue' OR spec_version=?) ORDER BY sequence`).all(workItemId,specVersion) as Row[];
  return rows.map(parse).filter(record=>record.kind !== "instruction" || !record.appliesTo.length || record.appliesTo.includes(role));
 }
 humanGuidance(workItemId:string,activeOnly=true) {
  const rows=this.store.db.prepare(`SELECT * FROM records WHERE work_item_id=? ${activeOnly?"AND status='active'":""} ORDER BY sequence`).all(workItemId) as Row[];
  return rows.map(parse).filter(record=>record.payload.kind==="instruction"||(record.payload.kind==="decision"&&record.payload.category==="human"));
 }
 openRequests(workItemId:string) {
  return (this.store.db.prepare("SELECT * FROM records WHERE work_item_id=? AND kind='request' AND status='open' ORDER BY sequence").all(workItemId) as Row[]).map(parse);
 }
 activeRequest(workItemId:string) {
  const open=this.openRequests(workItemId),parents=new Set(open.map(record=>record.parentId).filter(Boolean));
  const leaves=open.filter(record=>!parents.has(record.id));
  if (leaves.length > 1) throw new Error("Open requests do not form one causal chain");
  return leaves[0];
 }
 requestChain(workItemId:string) {
  const open=this.openRequests(workItemId),byId=new Map(open.map(record=>[record.id,record]));
  const active=this.activeRequest(workItemId),chain:WorkflowRecord[]=[];
  for (let record:WorkflowRecord|undefined=active;record;record=record.parentId ? byId.get(record.parentId) : undefined) chain.unshift(record);
  return chain;
 }
 resolveRequest(id:string,resolvedBy?:string) {
  const record=this.get(id);
  if (!record || record.kind !== "request" || record.status !== "open") throw new Error("Only an open request can be resolved");
  this.store.db.prepare("UPDATE records SET status='resolved',resolved_by=?,updated_at=? WHERE id=?").run(resolvedBy ?? null,new Date().toISOString(),id);
  return this.activeRequest(record.workItemId);
 }
 revokeInstruction(id:string) {
  const record=this.get(id);
  if (!record || record.payload.kind !== "instruction" || record.status !== "active") throw new Error("Only an active instruction can be revoked");
  this.store.db.prepare("UPDATE records SET status='revoked',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
  return this.get(id)!;
 }
 revokeHumanGuidance(id:string) {
  const record=this.get(id),isHumanDecision=record?.payload.kind==="decision"&&record.payload.category==="human";
  if (!record || record.status!=="active" || (record.payload.kind!=="instruction"&&!isHumanDecision)) throw new Error("Only active human guidance can be revoked");
  this.store.db.prepare("UPDATE records SET status='revoked',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
  return this.get(id)!;
 }
 cancelRequest(id:string) {
  const record=this.get(id);
  if (!record || record.payload.kind !== "request" || record.status !== "open") throw new Error("Only an open request can be cancelled");
  if (this.openRequests(record.workItemId).some(candidate=>candidate.parentId===id)) throw new Error("Resolve or cancel the active child request first");
  this.store.db.prepare("UPDATE records SET status='cancelled',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
  return this.activeRequest(record.workItemId);
 }
 updateRequest(id:string,changes:Partial<Extract<WorkflowRecordPayload,{kind:"request"}>>) {
  const record=this.get(id);if(!record||record.payload.kind!=="request"||record.status!=="open")throw new Error("Only an open request can be updated");
  const payload={...record.payload,...changes,kind:"request" as const};
  this.store.db.prepare("UPDATE records SET payload=?,updated_at=? WHERE id=?").run(JSON.stringify(payload),new Date().toISOString(),id);return this.get(id)!;
 }
 supersedeSpec(workItemId:string,specVersion:number) {
  return this.store.db.prepare("UPDATE records SET status='superseded',updated_at=? WHERE work_item_id=? AND scope='spec' AND spec_version=? AND status IN ('active','open')")
   .run(new Date().toISOString(),workItemId,specVersion).changes;
 }
 settleFindings(ids:string[],status:"resolved"|"accepted-defer",resolvedBy:string) {
  if (!ids.length) return [];
  const run=this.store.db.transaction(()=>ids.map(id=>{
   const record=this.get(id);
   if (!record || record.payload.kind !== "finding" || record.status !== "open") throw new Error(`Finding ${id} must be open`);
   if (status === "accepted-defer" && record.payload.classification !== "defer") throw new Error("Only a deferred finding can be accepted-defer");
   if (status === "resolved" && record.payload.classification === "defer") throw new Error("A deferred finding must be accepted-defer");
   this.store.db.prepare("UPDATE records SET status=?,resolved_by=?,updated_at=? WHERE id=?").run(status,resolvedBy,new Date().toISOString(),id);
   return this.get(id)!;
  }));
  return run.immediate();
 }
}

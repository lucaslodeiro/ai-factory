import { config } from "./config.js";
import { validateCoverage } from "./results.js";
import type { Store } from "./storage.js";
import type { AgentResult,AgentRole } from "./types.js";
import { WorkflowProjections } from "./workflow-projection.js";
import { WorkflowRecords,type V3Stage,type WorkflowRecord } from "./workflow-records.js";

const roleStage:Record<AgentRole,V3Stage>={"product-architect":"DESIGN",developer:"BUILD",qa:"TEST",reviewer:"REVIEW"};
const nextRoleStage={developer:"BUILD",qa:"TEST",reviewer:"REVIEW"} as const;

export class WorkflowResults {
 private projections:WorkflowProjections;private records:WorkflowRecords;
 constructor(private store:Store){this.projections=new WorkflowProjections(store);this.records=new WorkflowRecords(store);}
 apply(input:{workItemId:string;executionId:string;role:AgentRole;result:AgentResult;pullRequestUrl?:string}) {
  const current=this.projections.get(input.workItemId);
  if(current.status!=="RUNNING"||current.activeRunId!==input.executionId||current.stage!==roleStage[input.role]) {
   this.store.event("execution.discarded",{executionId:input.executionId,role:input.role,reason:"Workflow changed before the result was applied",projection:current},input.workItemId,input.executionId);return {discarded:true,projection:current};
  }
  const specVersion=this.specVersion(input.workItemId),ids:string[]=[];
  if(input.role==="product-architect")return this.architect(input,current.revision,specVersion,ids);
  const spec=this.store.db.prepare("SELECT criteria,approved_by FROM specs WHERE work_item_id=? AND version=?").get(input.workItemId,specVersion) as {criteria:string;approved_by:string|null}|undefined;
  if(!spec?.approved_by)throw new Error("Delivery result requires an approved current specification");
  validateCoverage(input.result,JSON.parse(spec.criteria));
  return this.delivery(input,current.revision,specVersion,ids);
 }
 private architect(input:{workItemId:string;executionId:string;role:AgentRole;result:AgentResult},revision:number,specVersion:number,ids:string[]) {
  const result=input.result,active=this.records.activeRequest(input.workItemId);
  if(result.outcome==="questions") {
   const parent=active?.payload.kind==="request"&&active.payload.owner==="architect"?active:undefined;
   const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:revision,stage:"DESIGN",status:"WAITING",actor:{type:"agent",id:"product-architect"},source:{executionId:input.executionId},reason:{code:"questions",summary:"Architect needs human input"},recordIds:ids},()=>{this.resultEvent(input);ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",parentId:parent?.id,payload:{kind:"request",type:"clarification",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["DESIGN"],openedAfterCommentId:this.cursor(input.workItemId),questions:result.questions},sourceType:"agent-result",sourceId:input.executionId,actor:"product-architect"}).id);});
   return {discarded:false,projection,recordIds:ids};
  }
  if(result.outcome==="spec") {
   const next=specVersion+1;
   const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:revision,stage:"DESIGN",status:"WAITING",actor:{type:"agent",id:"product-architect"},source:{executionId:input.executionId},reason:{code:"spec-proposed",summary:`SPEC v${next} proposed`},recordIds:ids,correctionCycles:0},()=>{
    this.resultEvent(input,next);
    if(specVersion)this.records.supersedeSpec(input.workItemId,specVersion);
    this.store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment) VALUES(?,?,?,?,?)").run(input.workItemId,next,result.spec,JSON.stringify(result.acceptanceCriteria),JSON.stringify(result.taskAssessment));
    ids.push(this.records.create({workItemId:input.workItemId,specVersion:next,scope:"spec",payload:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:this.cursor(input.workItemId)},sourceType:"agent-result",sourceId:input.executionId,actor:"product-architect"}).id);
   });return {discarded:false,projection,recordIds:ids};
  }
  if(result.outcome!=="resolved"||!active||active.payload.kind!=="request"||active.payload.type!=="tactical-decision"||active.payload.owner!=="architect")throw new Error("Architect resolution requires an active tactical request");
  const requestPayload=active.payload,target=result.nextRole?nextRoleStage[result.nextRole]:undefined;if(!target||!requestPayload.allowedReturnStages.includes(target))throw new Error(`Tactical result cannot return to ${target??"an unknown stage"}`);
  const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:revision,stage:target,status:"QUEUED",actor:{type:"agent",id:"product-architect"},source:{executionId:input.executionId},reason:{code:"tactical-resolved",summary:`Architect resolved the decision for ${target}`},recordIds:ids},()=>{
   this.resultEvent(input);
   for(const decision of result.decisions)ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",payload:{kind:"decision",category:"tactical",decision:decision.decision,rationale:decision.rationale,supersedes:decision.supersedes??[]},sourceType:"agent-result",sourceId:input.executionId,actor:"product-architect"}).id);
   const findingIds=requestPayload.findingIds??[];if(findingIds.length)this.records.settleFindings(findingIds,"resolved",input.executionId);
   this.records.resolveRequest(active.id,input.executionId);ids.push(active.id);
  });return {discarded:false,projection,recordIds:ids};
 }
 private delivery(input:{workItemId:string;executionId:string;role:AgentRole;result:AgentResult;pullRequestUrl?:string},revision:number,specVersion:number,ids:string[]) {
  const result=input.result,stage=roleStage[input.role];
  const createFindings=()=>{for(const finding of result.findings)ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",payload:{kind:"finding",classification:finding.classification,originRole:input.role,criterionId:result.coverage.find(coverage=>coverage.status==="failed")?.criterionId,evidence:finding.evidence},sourceType:"agent-result",sourceId:input.executionId,actor:input.role}).id);};
  if(result.outcome==="decision") {
   const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:revision,stage:"DESIGN",status:"QUEUED",actor:{type:"agent",id:input.role},source:{executionId:input.executionId},reason:{code:"decision-required",summary:`${input.role} requested an architectural decision`},recordIds:ids},()=>{this.resultEvent(input);createFindings();const findingIds=ids.slice();ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",payload:{kind:"request",type:"tactical-decision",owner:"architect",originatingStage:stage,allowedReturnStages:this.returnStages(stage),openedAfterCommentId:this.cursor(input.workItemId),findingIds},sourceType:"agent-result",sourceId:input.executionId,actor:input.role}).id);});
   return {discarded:false,projection,recordIds:ids};
  }
  if(result.outcome==="changes") {
   const current=this.projections.get(input.workItemId),cycles=current.correctionCycles+1,limited=cycles>=config.maxCycles;
   const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:revision,stage:limited?stage:"BUILD",status:limited?"WAITING":"QUEUED",actor:{type:"agent",id:input.role},source:{executionId:input.executionId},reason:{code:limited?"correction-limit":"changes",summary:limited?"Automatic correction limit reached":"Changes requested from Builder"},recordIds:ids,correctionCycles:cycles},()=>{this.resultEvent(input);createFindings();if(limited){const findingIds=ids.slice();ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",payload:{kind:"request",type:"correction-limit",owner:"human",originatingStage:stage,allowedReturnStages:this.returnStages(stage),openedAfterCommentId:this.cursor(input.workItemId),findingIds},sourceType:"agent-result",sourceId:input.executionId,actor:input.role}).id);}});
   return {discarded:false,projection,recordIds:ids};
  }
  if(result.outcome!=="pass")throw new Error(`Unsupported ${input.role} outcome ${result.outcome}`);
  const target=input.role==="developer"?"TEST":input.role==="qa"?"REVIEW":"DELIVERY",status=input.role==="reviewer"?"WAITING":"QUEUED";
  const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:revision,stage:target,status,actor:{type:"agent",id:input.role},source:{executionId:input.executionId},reason:{code:"pass",summary:`${input.role} passed`},recordIds:ids},()=>{
   this.resultEvent(input);
   createFindings();this.settlePass(input.workItemId,input.role,input.executionId);
   if(input.role==="reviewer"){if(!input.pullRequestUrl)throw new Error("Reviewer pass requires a published pull request");this.updateContext(input.workItemId,{pr:input.pullRequestUrl});ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",payload:{kind:"request",type:"merge",owner:"human",originatingStage:"DELIVERY",allowedReturnStages:["DELIVERY"],openedAfterCommentId:this.cursor(input.workItemId)},sourceType:"orchestrator",sourceId:input.executionId,actor:"orchestrator"}).id);}
  });return {discarded:false,projection,recordIds:ids};
 }
 private settlePass(workItemId:string,role:AgentRole,executionId:string) {
  const active=this.records.active(workItemId,this.specVersion(workItemId),role),deferred=active.filter(record=>record.payload.kind==="finding"&&record.payload.classification==="defer"&&record.payload.originRole===role).map(record=>record.id);
  if(deferred.length)this.records.settleFindings(deferred,"accepted-defer",executionId);
  if(role==="qa"){const fixes=active.filter(record=>record.payload.kind==="finding"&&record.payload.classification==="auto-fix"&&record.payload.originRole==="developer").map(record=>record.id);if(fixes.length)this.records.settleFindings(fixes,"resolved",executionId);}
 }
 private specVersion(workItemId:string){return (this.store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number|null}).version??0;}
 private cursor(workItemId:string){const row=this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string};return (JSON.parse(row.context||"{}") as {cursor?:number}).cursor??0;}
 private updateContext(workItemId:string,values:Record<string,unknown>){const row=this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string};this.store.db.prepare("UPDATE work_items SET context=? WHERE id=?").run(JSON.stringify({...JSON.parse(row.context||"{}"),...values}),workItemId);}
 private resultEvent(input:{workItemId:string;executionId:string;role:AgentRole;result:AgentResult},specVersion=this.specVersion(input.workItemId)){this.store.event("agent.result",{role:input.role,result:input.result,specVersion},input.workItemId,input.executionId);}
 private returnStages(stage:V3Stage):V3Stage[]{return stage==="BUILD"?["BUILD"]:stage==="TEST"?["BUILD","TEST"]:stage==="REVIEW"?["BUILD","TEST","REVIEW"]:[stage];}
}

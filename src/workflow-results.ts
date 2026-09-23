import {WorkflowFailures} from "./workflow-failures.js";
import { config } from "./config.js";
import { InvalidResultError,validateCoverage } from "./results.js";
import type { Store } from "./storage.js";
import type { AgentResult,AgentRole } from "./types.js";
import { WorkflowProjections } from "./workflow-projection.js";
import { WorkflowRecords,type V3Stage,type WorkflowRecord } from "./workflow-records.js";
import {roleShortName} from "./names.js";

// The stored body leads with the brief the human approved, so every delivery role and a
// recovered issue see the decisions the human made before the technical detail.
export function specificationBody(result:Pick<AgentResult,"brief"|"spec">){return `${result.brief.trim()}\n\n---\n\n${result.spec.trim()}`;}

const roleStage:Record<AgentRole,V3Stage>={"product-architect":"DESIGN",designer:"DESIGN",developer:"BUILD",qa:"TEST",reviewer:"REVIEW"};
const nextRoleStage={developer:"BUILD",qa:"TEST",reviewer:"REVIEW"} as const;

export class WorkflowResults {
 private projections:WorkflowProjections;private records:WorkflowRecords;
 constructor(private store:Store){this.projections=new WorkflowProjections(store);this.records=new WorkflowRecords(store);}
 apply(input:{workItemId:string;executionId:string;role:AgentRole;result:AgentResult;head:string;changedPaths?:string[]}) {
  const current=this.projections.get(input.workItemId);
  if(current.status!=="RUNNING"||current.activeRunId!==input.executionId||current.stage!==roleStage[input.role]) {
   this.store.event("execution.discarded",{executionId:input.executionId,role:input.role,reason:"Workflow changed before the result was applied",projection:current},input.workItemId,input.executionId);return {discarded:true,projection:current};
  }
  const specVersion=this.specVersion(input.workItemId),ids:string[]=[];
  this.validateSupersedes(input.workItemId,specVersion,input.result);
  const blockers=input.result.findings.filter(finding=>finding.classification==="environment-blocked");
  if(blockers.length){
   const message=blockers.map(finding=>finding.evidence).join("\n");
   const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:current.revision,stage:current.stage,status:"FAILED",actor:{type:"agent",id:input.role},source:{executionId:input.executionId},reason:{code:"environment-failure",summary:message},recordIds:ids},()=>{
    this.resultEvent(input);for(const finding of blockers)ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",payload:{kind:"finding",...finding,originRole:input.role},sourceType:"agent-result",sourceId:input.executionId,actor:input.role}).id);
    new WorkflowFailures(this.store).open({workItemId:input.workItemId,executionId:input.executionId,class:"environment",message,stage:current.stage,attempt:current.attempt});
   });return {discarded:false,projection,recordIds:ids};
  }
  if(input.role==="product-architect")return this.architect(input,current.revision,specVersion,ids);
  if(input.role==="designer")return this.designer(input,current.revision,specVersion,ids);
  const spec=this.store.db.prepare("SELECT criteria,approved_by FROM specs WHERE work_item_id=? AND version=?").get(input.workItemId,specVersion) as {criteria:string;approved_by:string|null}|undefined;
  if(!spec?.approved_by)throw new InvalidResultError("Delivery result requires an approved current specification");
  validateCoverage(input.result,JSON.parse(spec.criteria));
  return this.delivery(input,current.revision,specVersion,ids);
 }
 private architect(input:{workItemId:string;executionId:string;role:AgentRole;result:AgentResult;head:string},revision:number,specVersion:number,ids:string[]) {
  const result=input.result,active=this.records.activeRequest(input.workItemId);
  if(result.outcome==="questions") {
   const parent=active?.payload.kind==="request"&&active.payload.owner==="architect"?active:undefined;
   const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:revision,stage:"DESIGN",status:"WAITING",actor:{type:"agent",id:"product-architect"},source:{executionId:input.executionId},reason:{code:"questions",summary:"Architect needs human input"},recordIds:ids},()=>{this.resultEvent(input);ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",parentId:parent?.id,payload:{kind:"request",type:"clarification",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["DESIGN"],openedAfterCommentId:this.cursor(input.workItemId),questions:result.questions},sourceType:"agent-result",sourceId:input.executionId,actor:"product-architect"}).id);});
   return {discarded:false,projection,recordIds:ids};
  }
  if(result.outcome==="spec") {
   const next=specVersion+1;
   const prototype=result.taskAssessment?.uxImpact==="significant";
   const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:revision,stage:"DESIGN",status:prototype?"QUEUED":"WAITING",actor:{type:"agent",id:"product-architect"},source:{executionId:input.executionId},reason:{code:"spec-proposed",summary:prototype?`SPEC v${next} proposed; Designer prepares a prototype`:`SPEC v${next} proposed`},recordIds:ids,correctionCycles:0},()=>{
    this.resultEvent(input,next);
    if(specVersion)this.records.supersedeSpec(input.workItemId,specVersion);
    this.store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment) VALUES(?,?,?,?,?)").run(input.workItemId,next,specificationBody(result),JSON.stringify(result.acceptanceCriteria),JSON.stringify(result.taskAssessment));
    ids.push(this.records.create({workItemId:input.workItemId,specVersion:next,scope:"spec",payload:prototype?{kind:"request",type:"prototype",owner:"designer",originatingStage:"DESIGN",allowedReturnStages:["DESIGN"],openedAfterCommentId:this.cursor(input.workItemId)}:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:this.cursor(input.workItemId)},sourceType:"agent-result",sourceId:input.executionId,actor:"product-architect"}).id);
   });return {discarded:false,projection,recordIds:ids};
  }
  if(result.outcome!=="resolved"||!active||active.payload.kind!=="request"||active.payload.type!=="tactical-decision"||active.payload.owner!=="architect")throw new InvalidResultError("Architect resolution requires an active tactical request");
  const requestPayload=active.payload,target=result.nextRole?nextRoleStage[result.nextRole]:undefined;if(!target||!requestPayload.allowedReturnStages.includes(target))throw new InvalidResultError(`Tactical result cannot return to ${target??"an unknown stage"}`);
  const continuing=target==="BUILD"?"developer":target==="TEST"?"qa":"reviewer";
  const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:revision,stage:target,status:"QUEUED",actor:{type:"agent",id:"product-architect"},source:{executionId:input.executionId},reason:{code:"tactical-resolved",summary:`Architect resolved the decision; ${roleShortName(continuing)} continues`},recordIds:ids},()=>{
   this.resultEvent(input);
   for(const decision of result.decisions)ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",payload:{kind:"decision",category:"tactical",decision:decision.decision,rationale:decision.rationale,supersedes:decision.supersedes},sourceType:"agent-result",sourceId:input.executionId,actor:"product-architect"}).id);
   const findingIds=(requestPayload.findingIds??[]).filter(id=>{const record=this.records.get(id);return record?.payload.kind==="finding"&&record.payload.classification!=="defer";});if(findingIds.length)this.records.settleFindings(findingIds,"resolved",input.executionId);
   for(const finding of result.findings)ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",payload:{kind:"finding",classification:finding.classification,originRole:"product-architect",evidence:finding.evidence},sourceType:"agent-result",sourceId:input.executionId,actor:"product-architect"}).id);
   this.records.resolveRequest(active.id,input.executionId);ids.push(active.id);
  });return {discarded:false,projection,recordIds:ids};
 }
 // The prototype opens the single human gate: the brief and the prototype are approved together.
 private designer(input:{workItemId:string;executionId:string;role:AgentRole;result:AgentResult;head:string},revision:number,specVersion:number,ids:string[]) {
  const active=this.records.activeRequest(input.workItemId);
  if(input.result.outcome!=="pass")throw new InvalidResultError(`Unsupported designer outcome ${input.result.outcome}`);
  if(active?.payload.kind!=="request"||active.payload.type!=="prototype")throw new InvalidResultError("Designer result requires an open prototype request");
  const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:revision,stage:"DESIGN",status:"WAITING",actor:{type:"agent",id:"designer"},source:{executionId:input.executionId},reason:{code:"prototype-ready",summary:`Prototype for SPEC v${specVersion} ready`},recordIds:ids},()=>{
   this.resultEvent(input,specVersion,{prototypeHead:input.head});
   this.records.resolveRequest(active.id,input.executionId);ids.push(active.id);
   ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",payload:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:this.cursor(input.workItemId)},sourceType:"agent-result",sourceId:input.executionId,actor:"designer"}).id);
  });return {discarded:false,projection,recordIds:ids};
 }
 published(input:{workItemId:string;pullRequestUrl:string}) {
  const current=this.projections.get(input.workItemId);if(current.stage!=="DELIVERY"||current.status!=="QUEUED")throw new Error(`Cannot publish delivery while it is ${current.stage}/${current.status}`);
  const ids:string[]=[];const specVersion=this.specVersion(input.workItemId);
  const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:current.revision,stage:"DELIVERY",status:"WAITING",actor:{type:"orchestrator",id:"delivery"},source:{},reason:{code:"published",summary:"Branch published and pull request ready"},recordIds:ids},()=>{this.updateContext(input.workItemId,{pr:input.pullRequestUrl});ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",payload:{kind:"request",type:"merge",owner:"human",originatingStage:"DELIVERY",allowedReturnStages:["DELIVERY"],openedAfterCommentId:this.cursor(input.workItemId)},sourceType:"orchestrator",sourceId:`delivery:${current.revision}`,actor:"orchestrator"}).id);});
  return {projection,recordIds:ids};
 }
 private delivery(input:{workItemId:string;executionId:string;role:AgentRole;result:AgentResult;head:string;changedPaths?:string[]},revision:number,specVersion:number,ids:string[]) {
  const result=input.result,stage=roleStage[input.role];
  const createFindings=()=>{for(const finding of result.findings)ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",payload:{kind:"finding",classification:finding.classification,originRole:input.role,criterionId:result.coverage.find(coverage=>coverage.status==="failed")?.criterionId,evidence:finding.evidence},sourceType:"agent-result",sourceId:input.executionId,actor:input.role}).id);};
  if(result.outcome==="decision") {
   const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:revision,stage:"DESIGN",status:"QUEUED",actor:{type:"agent",id:input.role},source:{executionId:input.executionId},reason:{code:"decision-required",summary:`${roleShortName(input.role)} requested an architectural decision`},recordIds:ids},()=>{this.resultEvent(input);createFindings();const findingIds=ids.slice();ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",payload:{kind:"request",type:"tactical-decision",owner:"architect",originatingStage:stage,allowedReturnStages:this.returnStages(stage),openedAfterCommentId:this.cursor(input.workItemId),findingIds},sourceType:"agent-result",sourceId:input.executionId,actor:input.role}).id);});
   return {discarded:false,projection,recordIds:ids};
  }
  if(result.outcome==="changes") {
   const current=this.projections.get(input.workItemId),cycles=current.correctionCycles+1,limited=cycles>=config.maxCycles;
   const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:revision,stage:limited?stage:"BUILD",status:limited?"WAITING":"QUEUED",actor:{type:"agent",id:input.role},source:{executionId:input.executionId},reason:{code:limited?"correction-limit":"changes",summary:limited?"Automatic correction limit reached":"Changes requested from Builder"},recordIds:ids,correctionCycles:cycles},()=>{this.resultEvent(input);createFindings();if(limited){const findingIds=ids.slice();ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",payload:{kind:"request",type:"correction-limit",owner:"human",originatingStage:stage,allowedReturnStages:this.returnStages(stage),openedAfterCommentId:this.cursor(input.workItemId),findingIds},sourceType:"agent-result",sourceId:input.executionId,actor:input.role}).id);}});
   return {discarded:false,projection,recordIds:ids};
  }
  if(result.outcome!=="pass")throw new InvalidResultError(`Unsupported ${input.role} outcome ${result.outcome}`);
  const current=this.projections.get(input.workItemId);
  if(input.role==="developer"&&current.correctionCycles>0&&input.changedPaths?.length===0){
   const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:revision,stage:"BUILD",status:"WAITING",actor:{type:"agent",id:input.role},source:{executionId:input.executionId},reason:{code:"no-change-pass",summary:"Builder found nothing to change after a correction request"},recordIds:ids},()=>{
    this.resultEvent(input);createFindings();this.settlePass(input.workItemId,input.role,input.executionId);
    const findingIds=this.records.active(input.workItemId,specVersion,"developer").filter(record=>record.payload.kind==="finding"&&record.payload.classification==="auto-fix").map(record=>record.id);
    ids.push(this.records.create({workItemId:input.workItemId,specVersion,scope:"spec",payload:{kind:"request",type:"correction-limit",owner:"human",originatingStage:"BUILD",allowedReturnStages:this.returnStages("BUILD"),openedAfterCommentId:this.cursor(input.workItemId),findingIds},sourceType:"agent-result",sourceId:input.executionId,actor:input.role}).id);
   });return {discarded:false,projection,recordIds:ids};
  }
  const target=input.role==="developer"?"TEST":input.role==="qa"?"REVIEW":"DELIVERY";
  const projection=this.projections.transition({workItemId:input.workItemId,expectedRevision:revision,stage:target,status:"QUEUED",actor:{type:"agent",id:input.role},source:{executionId:input.executionId},reason:{code:"pass",summary:`${roleShortName(input.role)} passed`},recordIds:ids},()=>{
   this.resultEvent(input);
   createFindings();this.settlePass(input.workItemId,input.role,input.executionId);if(input.role==="qa"||input.role==="reviewer")this.setVerifiedHead(input.workItemId,input.role==="qa"?"TEST":"REVIEW",input.head);
  });return {discarded:false,projection,recordIds:ids};
 }
 private settlePass(workItemId:string,role:AgentRole,executionId:string) {
  const active=this.records.active(workItemId,this.specVersion(workItemId),role),deferred=active.filter(record=>record.payload.kind==="finding"&&record.payload.classification==="defer"&&record.payload.originRole===role).map(record=>record.id);
  if(deferred.length)this.records.settleFindings(deferred,"accepted-defer",executionId);
  if(role==="qa"){const fixes=active.filter(record=>record.payload.kind==="finding"&&record.payload.classification==="auto-fix"&&record.payload.originRole==="developer").map(record=>record.id);if(fixes.length)this.records.settleFindings(fixes,"resolved",executionId);}
 }
 private specVersion(workItemId:string){return (this.store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number|null}).version??0;}
 private validateSupersedes(workItemId:string,specVersion:number,result:AgentResult){
  const active=new Set(this.records.active(workItemId,specVersion,"product-architect").filter(record=>record.payload.kind==="decision").map(record=>record.id));
  for(const [index,decision] of result.decisions.entries())for(const value of decision.supersedes)if(!active.has(value))throw new InvalidResultError(`decisions[${index}].supersedes contains "${value}", which is not an active decision id. Use the ids listed under "Active tactical decisions" and "Active human decisions", or leave supersedes empty.`);
 }
 private cursor(workItemId:string){const row=this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string};return (JSON.parse(row.context||"{}") as {cursor?:number}).cursor??0;}
 private updateContext(workItemId:string,values:Record<string,unknown>){const row=this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string};this.store.db.prepare("UPDATE work_items SET context=? WHERE id=?").run(JSON.stringify({...JSON.parse(row.context||"{}"),...values}),workItemId);}
 private setVerifiedHead(workItemId:string,stage:"TEST"|"REVIEW",head:string){const row=this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string};const context=JSON.parse(row.context||"{}") as {verifiedHeads?:Record<string,string>};this.updateContext(workItemId,{verifiedHeads:{...context.verifiedHeads,[stage]:head}});}
 private resultEvent(input:{workItemId:string;executionId:string;role:AgentRole;result:AgentResult;head:string;changedPaths?:string[]},specVersion=this.specVersion(input.workItemId),extra:Record<string,unknown>={}){this.store.event("agent.result",{role:input.role,result:input.result,specVersion,...extra},input.workItemId,input.executionId);}
 private returnStages(stage:V3Stage):V3Stage[]{return stage==="BUILD"?["BUILD"]:stage==="TEST"?["BUILD","TEST"]:stage==="REVIEW"?["BUILD","TEST","REVIEW"]:[stage];}
}

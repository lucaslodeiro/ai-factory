import { ContextAssembler,InvalidContextError } from "./context-assembly.js";
import { resolveContextBudget } from "./context-budget.js";
import { selectModel } from "./model-policy.js";
import { promptContract } from "./prompts.js";
import type { Store } from "./storage.js";
import type { AgentAdapter } from "./adapters/agent.js";
import type { AgentRole,AgentResult,DeliveryStage,TaskAssessment } from "./types.js";
import type { WorkspacePort } from "./worktrees.js";
import { WorkflowScheduler } from "./workflow-scheduler.js";
import { WorkflowResults } from "./workflow-results.js";
import { WorkflowRecords } from "./workflow-records.js";
import type { TacticalNextRole } from "./tactical-routing.js";
import { InvalidResultError } from "./results.js";

export interface DeliveryPort {ensurePR(branch:string,title:string,body:string):string;}

export class WorkflowRunner {
 private scheduler:WorkflowScheduler;private results:WorkflowResults;private records:WorkflowRecords;private assembler:ContextAssembler;
 constructor(private store:Store,private agents:Partial<Record<AgentRole,AgentAdapter>>,private workspaces:WorkspacePort,private delivery:DeliveryPort){this.scheduler=new WorkflowScheduler(store);this.results=new WorkflowResults(store);this.records=new WorkflowRecords(store);this.assembler=new ContextAssembler(store);}
 async run(workItemId:string) {
  const projection=new (await import("./workflow-projection.js")).WorkflowProjections(this.store).get(workItemId);if(projection.status!=="QUEUED")return false;
  if(projection.stage==="DELIVERY")return this.publish(workItemId);
  const role=this.scheduler.role(workItemId),adapter=this.agents[role];if(!adapter)throw new Error(`No adapter configured for ${role}`);
  const row=this.store.db.prepare("SELECT issue_number,branch,context FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;branch:string;context:string};
  const context=JSON.parse(row.context||"{}") as {title?:string;body?:string;url?:string;cwd?:string};
  const cwd=context.cwd??this.workspaces.ensure(workItemId,row.branch);if(!context.cwd)this.updateContext(workItemId,{cwd});
  this.workspaces.assertBranch(cwd,row.branch);
  const specVersion=this.specVersion(workItemId),assessment=this.assessment(workItemId,specVersion),active=this.records.activeRequest(workItemId);
  const consultation=active?.payload.kind==="request"&&active.payload.owner==="architect";
  const selection=selectModel(role,assessment,projection.correctionCycles,consultation),budget=resolveContextBudget(role,selection);
  const route=consultation&&active?.payload.kind==="request"?this.route(active.payload.originatingStage,active.payload.allowedReturnStages):undefined;
  const contract=promptContract(role,selection.provider,{tacticalRoute:route}),contractBytes=Buffer.byteLength(contract);
  const summary=["qa","reviewer"].includes(role)?this.workspaces.changeSummary(cwd):undefined;
  const reviewerContext=role==="reviewer"?this.workspaces.prepareReviewerContext(cwd,workItemId):undefined;
  let assembled;
  try {
   if(contractBytes+2>=budget.bytes)throw new InvalidContextError(`Protected prompt contract requires ${contractBytes} bytes but the budget is ${budget.bytes}`);
   assembled=this.assembler.assemble({workItemId,role,specVersion,budgetBytes:budget.bytes-contractBytes-2,budgetSource:budget.source,issue:{title:context.title??`Issue #${row.issue_number}`,body:context.body??""},changedFiles:(reviewerContext??summary)?.files,diffStat:(reviewerContext??summary)?.stat,diffPath:reviewerContext?.path,qaEvidence:role==="reviewer"?this.latestResult(workItemId,"qa"):undefined});
  } catch(error){if(reviewerContext)this.workspaces.cleanupReviewerContext(cwd,workItemId);if(error instanceof InvalidContextError){this.scheduler.rejectQueued(workItemId,error,"invalid-context");return true;}throw error;}
  const instructions=`${contract}\n\n${assembled.markdown}`,before=this.workspaces.head(cwd);
  let started:ReturnType<WorkflowScheduler["begin"]>|undefined;
  try {
   started=this.scheduler.begin(workItemId);
   this.store.event("model.selected",{role,specVersion,selection,budget},workItemId,started.executionId);
   const result=await adapter.run({workItemId,role,cwd,instructions,selection,executionId:started.executionId,promptMetadata:{...assembled.manifest,budgetBytes:budget.bytes,budgetSource:budget.source,sectionBytes:{Contract:contractBytes,...assembled.manifest.sectionBytes}},allowedNextRoles:route?.allowedNextRoles,consultationFrom:route?.from});
   const current=new (await import("./workflow-projection.js")).WorkflowProjections(this.store).get(workItemId);if(current.status!=="RUNNING"||current.activeRunId!==started.executionId){this.store.event("execution.discarded",{executionId:started.executionId,reason:"Workflow changed before worktree validation"},workItemId,started.executionId);return true;}
   this.workspaces.check(cwd,role,before,row.branch);
   if(role==="developer"||role==="qa")this.workspaces.commit(cwd,`factory: ${role} for #${row.issue_number}`,row.branch);
   this.results.apply({workItemId,executionId:started.executionId,role,result});return true;
  } catch(error){if(!started)throw error;this.scheduler.fail(workItemId,started.executionId,error,error instanceof InvalidContextError?"invalid-context":error instanceof InvalidResultError?"invalid-result":"execution");return true;}
  finally{if(reviewerContext)this.workspaces.cleanupReviewerContext(cwd,workItemId);}
 }
 private publish(workItemId:string) {
  const row=this.store.db.prepare("SELECT issue_number,branch,context FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;branch:string;context:string};const context=JSON.parse(row.context||"{}") as {title?:string;cwd?:string};
  try {const cwd=context.cwd;if(!cwd)throw new Error("Delivery has no prepared worktree");this.workspaces.assertBranch(cwd,row.branch);const review=this.latestResult(workItemId,"reviewer");if(!review||review.outcome!=="pass")throw new InvalidResultError("Delivery requires a successful Reviewer result");this.workspaces.publish(cwd,row.branch);const pullRequestUrl=this.delivery.ensurePR(row.branch,`#${row.issue_number}: ${context.title??"Factory delivery"}`,this.prBody(workItemId,row.issue_number,review));this.results.published({workItemId,pullRequestUrl});return true;}
  catch(error){this.scheduler.rejectQueued(workItemId,error,"integration");return true;}
 }
 private specVersion(workItemId:string){return (this.store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number|null}).version??0;}
 private assessment(workItemId:string,version:number){const row=this.store.db.prepare("SELECT assessment FROM specs WHERE work_item_id=? AND version=?").get(workItemId,version) as {assessment:string|null}|undefined;if(!row?.assessment)return undefined;return JSON.parse(row.assessment) as TaskAssessment;}
 private latestResult(workItemId:string,role:AgentRole):AgentResult|undefined{for(const row of this.store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='agent.result' ORDER BY id DESC").all(workItemId) as Array<{payload:string}>){const payload=JSON.parse(row.payload) as {role:AgentRole;result:AgentResult};if(payload.role===role)return payload.result;}return undefined;}
 private route(origin:"DESIGN"|"BUILD"|"TEST"|"REVIEW"|"DELIVERY",allowed:Array<"DESIGN"|"BUILD"|"TEST"|"REVIEW"|"DELIVERY">){const roleByStage:{[key:string]:TacticalNextRole}={BUILD:"developer",TEST:"qa",REVIEW:"reviewer"},fromByStage:{[key:string]:DeliveryStage}={BUILD:"BUILD",TEST:"TEST",REVIEW:"REVIEW"};return {from:fromByStage[origin],allowedNextRoles:allowed.map(stage=>roleByStage[stage]).filter(Boolean)};}
 private updateContext(workItemId:string,values:Record<string,unknown>){const row=this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string};this.store.db.prepare("UPDATE work_items SET context=? WHERE id=?").run(JSON.stringify({...JSON.parse(row.context||"{}"),...values}),workItemId);}
 private prBody(workItemId:string,issueNumber:number,result:AgentResult){const spec=this.store.db.prepare("SELECT version,body,approved_by FROM specs WHERE work_item_id=? ORDER BY version DESC LIMIT 1").get(workItemId) as {version:number;body:string;approved_by:string};return `Closes #${issueNumber}\n\nApproved SPEC v${spec.version} by ${spec.approved_by}.\n\n${spec.body}\n\n## Review\n${result.summary}`;}
}

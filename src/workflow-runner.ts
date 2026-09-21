import { ContextAssembler,InvalidContextError } from "./context-assembly.js";
import { resolveContextBudget } from "./context-budget.js";
import { selectModel } from "./model-policy.js";
import { promptContract } from "./prompts.js";
import type { Store } from "./storage.js";
import type { AgentAdapter } from "./adapters/agent.js";
import type { AgentRole,AgentResult,DeliveryStage,TaskAssessment } from "./types.js";
import { SyncConflictError,type WorkspacePort } from "./worktrees.js";
import { WorkflowScheduler } from "./workflow-scheduler.js";
import { WorkflowResults } from "./workflow-results.js";
import { WorkflowRecords } from "./workflow-records.js";
import type { TacticalNextRole } from "./tactical-routing.js";
import { InvalidResultError } from "./results.js";
import { sanitizeFailureEvidence } from "./failure-report.js";
import { config } from "./config.js";
import { WorkflowProjections } from "./workflow-projection.js";

export interface DeliveryPort {ensurePR(branch:string,title:string,body:string):string|Promise<string>;}

export class WorkflowRunner {
 private scheduler:WorkflowScheduler;private results:WorkflowResults;private records:WorkflowRecords;private assembler:ContextAssembler;
 constructor(private store:Store,private agents:Partial<Record<AgentRole,AgentAdapter>>,private workspaces:WorkspacePort,private delivery:DeliveryPort){this.scheduler=new WorkflowScheduler(store);this.results=new WorkflowResults(store);this.records=new WorkflowRecords(store);this.assembler=new ContextAssembler(store);}
 reconcileFinished(){
  const rows=this.store.db.prepare("SELECT w.id,e.id execution_id,e.status FROM work_items w JOIN executions e ON e.id=w.active_run_id WHERE w.archived_at IS NULL AND w.status='RUNNING' AND e.status<>'running'").all() as {id:string;execution_id:string;status:string}[];
  for(const row of rows){this.scheduler.fail(row.id,row.execution_id,new Error(`The agent execution ended (${row.status}), but its result was not applied. Review execution evidence before retrying.`),"recovery");}
 }
 async run(workItemId:string) {
  const projection=new WorkflowProjections(this.store).get(workItemId);if(projection.status!=="QUEUED")return false;
  if(projection.stage==="DELIVERY")return this.publish(workItemId);
  const role=this.scheduler.role(workItemId),adapter=this.agents[role];if(!adapter)throw new Error(`No adapter configured for ${role}`);
  let started:ReturnType<WorkflowScheduler["begin"]>|undefined,preparing=true;
  let reviewerContext:ReturnType<WorkspacePort["prepareReviewerContext"]>|undefined,cwd:string|undefined;
  try {
  const row=this.store.db.prepare("SELECT issue_number,branch,context FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;branch:string;context:string};
  const context=JSON.parse(row.context||"{}") as {title?:string;body?:string;url?:string;cwd?:string};
  cwd=context.cwd??this.workspaces.ensure(workItemId,row.branch);if(!context.cwd)this.updateContext(workItemId,{cwd});
  this.workspaces.assertBranch(cwd,row.branch);
  this.workspaces.sync(cwd,row.branch,config.defaultBranch,role);
  const head=this.workspaces.head(cwd),verified=(JSON.parse((this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string}).context||"{}") as {verifiedHeads?:Record<string,string>}).verifiedHeads;
  if(projection.stage==="REVIEW"&&verified?.TEST!==head){new WorkflowProjections(this.store).transition({workItemId,expectedRevision:projection.revision,stage:"TEST",status:"QUEUED",actor:{type:"orchestrator",id:"sync"},source:{},reason:{code:"code-changed",summary:"Code changed since the last verified test run"}});return true;}
  const specVersion=this.specVersion(workItemId),assessment=this.assessment(workItemId,specVersion),active=this.records.activeRequest(workItemId);
  const consultation=active?.payload.kind==="request"&&active.payload.owner==="architect";
  const selection=selectModel(role,assessment,projection.correctionCycles,consultation),budget=resolveContextBudget(role,selection);
  const route=consultation&&active?.payload.kind==="request"?this.route(active.payload.originatingStage,active.payload.allowedReturnStages):undefined;
  const baseline=this.workspaces.capture?.(cwd);
  const policyText=role==="qa"&&baseline?`\n\nVerification write policy for this execution: ${JSON.stringify(baseline.policy)}. Evidence directories allow regular, non-executable JSON, Markdown, text, CSV and raster images only. Production, dependency, credential and policy changes are forbidden.`:"";
  const contract=promptContract(role,selection.provider,{tacticalRoute:route})+policyText,contractBytes=Buffer.byteLength(contract);
  const summary=["qa","reviewer"].includes(role)?this.workspaces.changeSummary(cwd):undefined;
  reviewerContext=role==="reviewer"?this.workspaces.prepareReviewerContext(cwd,workItemId):undefined;

   if(contractBytes+2>=budget.bytes)throw new InvalidContextError(`Protected prompt contract requires ${contractBytes} bytes but the budget is ${budget.bytes}`);
   const assembled=this.assembler.assemble({workItemId,role,specVersion,budgetBytes:budget.bytes-contractBytes-2,budgetSource:budget.source,issue:{title:context.title??`Issue #${row.issue_number}`,body:context.body??""},changedFiles:(reviewerContext??summary)?.files,diffStat:(reviewerContext??summary)?.stat,diffPath:reviewerContext?.path,qaEvidence:role==="reviewer"?this.latestResult(workItemId,"qa"):undefined});

  const instructions=`${contract}\n\n${assembled.markdown}`,before=baseline?.head??this.workspaces.head(cwd);
   preparing=false;started=this.scheduler.begin(workItemId);
   this.store.event("model.selected",{role,specVersion,selection,budget},workItemId,started.executionId);
   const result=await adapter.run({workItemId,role,cwd,instructions,selection,executionId:started.executionId,promptMetadata:{...assembled.manifest,budgetBytes:budget.bytes,budgetSource:budget.source,sectionBytes:{Contract:contractBytes,...assembled.manifest.sectionBytes}},allowedNextRoles:route?.allowedNextRoles,consultationFrom:route?.from});
   const current=new WorkflowProjections(this.store).get(workItemId);if(current.status!=="RUNNING"||current.activeRunId!==started.executionId){this.store.event("execution.discarded",{executionId:started.executionId,reason:"Workflow changed before worktree validation"},workItemId,started.executionId);return true;}
   const changed=this.workspaces.check(cwd,role,before,row.branch,baseline);
   if(role==="developer"||role==="qa"){
    this.workspaces.commit(cwd,`factory: ${role} for #${row.issue_number}`,row.branch,changed??undefined);
    try {if(this.workspaces.publishAsync)await this.workspaces.publishAsync(cwd,row.branch);else this.workspaces.publish(cwd,row.branch);}
    catch(error){this.store.event("workflow.push_failed",{branch:row.branch,error:sanitizeFailureEvidence(error instanceof Error?error.message:String(error),1600)},workItemId,started.executionId);}
   }
   this.results.apply({workItemId,executionId:started.executionId,role,result,head:this.workspaces.head(cwd)});return true;
  } catch(error){if(!started){if(!preparing)throw error;this.scheduler.rejectQueued(workItemId,new Error(`Could not prepare workflow execution: ${error instanceof Error?error.message:String(error)}`),error instanceof InvalidContextError?"invalid-context":error instanceof SyncConflictError?"integration":"execution");return true;}this.store.event("workflow.result_failed",{error:error instanceof Error?error.message:String(error)},workItemId,started.executionId);this.scheduler.fail(workItemId,started.executionId,error,error instanceof InvalidContextError?"invalid-context":error instanceof InvalidResultError?"invalid-result":"execution");return true;}
  finally{if(reviewerContext&&cwd)try{this.workspaces.cleanupReviewerContext(cwd,workItemId);}catch(error){this.store.event("workflow.context_cleanup_failed",{error:error instanceof Error?error.message:String(error)},workItemId,started?.executionId);}}
 }
 private async publish(workItemId:string) {
  const row=this.store.db.prepare("SELECT issue_number,branch,context,revision FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;branch:string;context:string;revision:number};const context=JSON.parse(row.context||"{}") as {title?:string;cwd?:string};
  try {const cwd=context.cwd;if(!cwd)throw new Error("Delivery has no prepared worktree");this.workspaces.assertBranch(cwd,row.branch);this.workspaces.sync(cwd,row.branch,config.defaultBranch,"reviewer");const head=this.workspaces.head(cwd),verified=(JSON.parse((this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string}).context||"{}") as {verifiedHeads?:Record<string,string>}).verifiedHeads;if(verified?.TEST!==head){new WorkflowProjections(this.store).transition({workItemId,expectedRevision:row.revision,stage:"TEST",status:"QUEUED",actor:{type:"orchestrator",id:"sync"},source:{},reason:{code:"code-changed",summary:"Code changed since the last verified test run"}});return true;}const review=this.latestResult(workItemId,"reviewer");if(!review||review.outcome!=="pass")throw new InvalidResultError("Delivery requires a successful Reviewer result");if(this.workspaces.publishAsync)await this.workspaces.publishAsync(cwd,row.branch);else this.workspaces.publish(cwd,row.branch);if(this.deliveryInterrupted(workItemId,row.revision))return false;const pullRequestUrl=await this.delivery.ensurePR(row.branch,`#${row.issue_number}: ${context.title??"Factory delivery"}`,this.prBody(workItemId,row.issue_number,review));if(this.deliveryInterrupted(workItemId,row.revision))return false;this.results.published({workItemId,pullRequestUrl});return true;}
  catch(error){if(this.deliveryInterrupted(workItemId,row.revision))return false;this.scheduler.rejectQueued(workItemId,error,"integration");return true;}
 }
 private deliveryInterrupted(id:string,revision:number){const row=this.store.db.prepare("SELECT stage,status,archived_at,revision FROM work_items WHERE id=?").get(id) as {stage:string;status:string;archived_at:string|null;revision:number};return row.revision!==revision||row.stage!=="DELIVERY"||row.status!=="QUEUED"||Boolean(row.archived_at);}
 private specVersion(workItemId:string){return (this.store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number|null}).version??0;}
 private assessment(workItemId:string,version:number){const row=this.store.db.prepare("SELECT assessment FROM specs WHERE work_item_id=? AND version=?").get(workItemId,version) as {assessment:string|null}|undefined;if(!row?.assessment)return undefined;return JSON.parse(row.assessment) as TaskAssessment;}
 private latestResult(workItemId:string,role:AgentRole):AgentResult|undefined{for(const row of this.store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='agent.result' ORDER BY id DESC").all(workItemId) as Array<{payload:string}>){const payload=JSON.parse(row.payload) as {role:AgentRole;result:AgentResult};if(payload.role===role)return payload.result;}return undefined;}
 private route(origin:"DESIGN"|"BUILD"|"TEST"|"REVIEW"|"DELIVERY",allowed:Array<"DESIGN"|"BUILD"|"TEST"|"REVIEW"|"DELIVERY">){const roleByStage:{[key:string]:TacticalNextRole}={BUILD:"developer",TEST:"qa",REVIEW:"reviewer"},fromByStage:{[key:string]:DeliveryStage}={BUILD:"BUILD",TEST:"TEST",REVIEW:"REVIEW"};return {from:fromByStage[origin],allowedNextRoles:allowed.map(stage=>roleByStage[stage]).filter(Boolean)};}
 private updateContext(workItemId:string,values:Record<string,unknown>){const row=this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string};this.store.db.prepare("UPDATE work_items SET context=? WHERE id=?").run(JSON.stringify({...JSON.parse(row.context||"{}"),...values}),workItemId);}
 private prBody(workItemId:string,issueNumber:number,result:AgentResult){const spec=this.store.db.prepare("SELECT version,body,approved_by FROM specs WHERE work_item_id=? ORDER BY version DESC LIMIT 1").get(workItemId) as {version:number;body:string;approved_by:string};return `Closes #${issueNumber}\n\nApproved SPEC v${spec.version} by ${spec.approved_by}.\n\n${spec.body}\n\n## Review\n${result.summary}`;}
}

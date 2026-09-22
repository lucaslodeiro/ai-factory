import {publishedText,resultMarkdown} from "./workflow-github.js";
import {roleShortName} from "./names.js";
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
import { runVerification } from "./verification.js";
import { config } from "./config.js";
import { WorkflowProjections } from "./workflow-projection.js";
import type {PublishedLatestResult} from "./workflow-state.js";
import {executionOutcomeText} from "./execution-presentation.js";
import {LocalRuntimeManager} from "./local-runtime.js";
import {browserRequired} from "./browser-runner.mjs";

export interface DeliveryPort {ensurePR(branch:string,title:string,body:string):string|Promise<string>;}

export function commitSummary(summary:string){const line=summary.trim().split(/\r?\n/)[0].trim();if(line.length<=72)return line;const cut=line.lastIndexOf(" ",72);return `${line.slice(0,cut>0?cut:72).trimEnd()}…`;}

export class WorkflowRunner {
 private scheduler:WorkflowScheduler;private results:WorkflowResults;private records:WorkflowRecords;private assembler:ContextAssembler;
 constructor(private store:Store,private agents:Partial<Record<AgentRole,AgentAdapter>>,private workspaces:WorkspacePort,private delivery:DeliveryPort,private localRuntime?:LocalRuntimeManager){this.scheduler=new WorkflowScheduler(store);this.results=new WorkflowResults(store);this.records=new WorkflowRecords(store);this.assembler=new ContextAssembler(store);}
 reconcileFinished(){
  const rows=this.store.db.prepare("SELECT w.id,e.id execution_id,e.status FROM work_items w JOIN executions e ON e.id=w.active_run_id WHERE w.archived_at IS NULL AND w.status='RUNNING' AND e.status<>'running'").all() as {id:string;execution_id:string;status:string}[];
  for(const row of rows){this.scheduler.fail(row.id,row.execution_id,new Error(`The agent execution ended (${row.status}), but its result was not applied. Review execution evidence before retrying.`),"recovery");}
 }
 async preserve(workItemId:string){
  const row=this.store.db.prepare("SELECT issue_number,branch,stage,context FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;branch:string;stage:DeliveryStage;context:string};
  const context=JSON.parse(row.context||"{}") as {cwd?:string};if(!context.cwd)return;
  const role=({DESIGN:"product-architect",BUILD:"developer",TEST:"qa",REVIEW:"reviewer",DELIVERY:"reviewer"} as Record<string,AgentRole>)[row.stage];
  const synchronization=this.workspaces.sync(context.cwd,row.branch,config.defaultBranch,role);if(synchronization.skipped)this.store.event("workflow.sync_skipped",{branch:row.branch,error:sanitizeFailureEvidence(synchronization.skipped,1600)},workItemId);
  try{if(this.workspaces.publishAsync)await this.workspaces.publishAsync(context.cwd,row.branch);else this.workspaces.publish(context.cwd,row.branch);}catch(error){this.store.event("workflow.push_failed",{branch:row.branch,error:sanitizeFailureEvidence(error instanceof Error?error.message:String(error),1600)},workItemId);}
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
  const synchronization=this.workspaces.sync(cwd,row.branch,config.defaultBranch,role);if(synchronization.skipped)this.store.event("workflow.sync_skipped",{branch:row.branch,error:sanitizeFailureEvidence(synchronization.skipped,1600)},workItemId);
  try {if(this.workspaces.publishAsync)await this.workspaces.publishAsync(cwd,row.branch);else this.workspaces.publish(cwd,row.branch);}
  catch(error){this.store.event("workflow.push_failed",{branch:row.branch,error:sanitizeFailureEvidence(error instanceof Error?error.message:String(error),1600)},workItemId);}
  const head=this.workspaces.head(cwd),verified=(JSON.parse((this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string}).context||"{}") as {verifiedHeads?:Record<string,string>}).verifiedHeads;
  if(projection.stage==="REVIEW"&&verified?.TEST!==head){new WorkflowProjections(this.store).transition({workItemId,expectedRevision:projection.revision,stage:"TEST",status:"QUEUED",actor:{type:"orchestrator",id:"sync"},source:{},reason:{code:"code-changed",summary:"Code changed since the last verified test run"}});return true;}
  let localRuntimeUrl:string|undefined;
  if(this.localRuntime&&browserRequired(cwd,role)){const runtime=await this.localRuntime.ensure(workItemId,cwd);if(runtime){localRuntimeUrl=runtime.url;this.store.event("runtime.local_started",{script:runtime.script,url:runtime.url,log:runtime.log},workItemId);}}
  const specVersion=this.specVersion(workItemId),assessment=this.assessment(workItemId,specVersion),active=this.records.activeRequest(workItemId);
  const consultation=active?.payload.kind==="request"&&active.payload.owner==="architect";
  const selection=selectModel(role,assessment,projection.correctionCycles,consultation),budget=resolveContextBudget(role,selection);
  const route=consultation&&active?.payload.kind==="request"?this.route(active.payload.originatingStage,active.payload.allowedReturnStages):undefined;
  const baseline=this.workspaces.capture?.(cwd);
  const policyText=role==="qa"&&baseline?`\n\nVerification write policy for this execution: ${JSON.stringify(baseline.policy)}. Evidence directories allow regular, non-executable JSON, Markdown, text, CSV and raster images only. Production, dependency, credential and policy changes are forbidden.`:"";
  const contract=promptContract(role,selection.provider,{tacticalRoute:route})+policyText,contractBytes=Buffer.byteLength(contract);
  const summary=["qa","reviewer"].includes(role)?this.workspaces.changeSummary(cwd):undefined;
  const retrySummary=role==="developer"&&(projection.attempt>0||projection.correctionCycles>0)?this.workspaces.changeSummary(cwd):undefined;
  reviewerContext=role==="reviewer"?this.workspaces.prepareReviewerContext(cwd,workItemId):undefined;

   if(contractBytes+2>=budget.bytes)throw new InvalidContextError(`Protected prompt contract requires ${contractBytes} bytes but the budget is ${budget.bytes}`);
   const currentContext=JSON.parse((this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string}).context||"{}") as {previousAttempt?:{stage?:DeliveryStage;attempt?:number};invalidResultRetry?:{stage?:DeliveryStage;attempt?:number;executionId?:string;message?:string}};
   const previousAttempt=currentContext.previousAttempt?.stage===projection.stage&&currentContext.previousAttempt.attempt===projection.attempt?currentContext.previousAttempt:undefined;
   const invalidResultRetry=currentContext.invalidResultRetry?.stage===projection.stage&&currentContext.invalidResultRetry.attempt===projection.attempt?currentContext.invalidResultRetry:undefined;
   const assembled=this.assembler.assemble({workItemId,role,specVersion,budgetBytes:budget.bytes-contractBytes-2,budgetSource:budget.source,issue:{title:context.title??`Issue #${row.issue_number}`,body:context.body??""},repositoryMap:role==="developer"?this.workspaces.repositoryMap?.(cwd):undefined,changedFiles:(reviewerContext??summary??retrySummary)?.files,diffStat:(reviewerContext??summary??retrySummary)?.stat,diffPath:reviewerContext?.path,qaEvidence:role==="reviewer"?this.latestResult(workItemId,"qa"):undefined,previousAttempt,rejectedResult:invalidResultRetry?.message?{message:invalidResultRetry.message}:undefined});

  const instructions=`${contract}\n\n${assembled.markdown}`,before=baseline?.head??this.workspaces.head(cwd);
   preparing=false;started=this.scheduler.begin(workItemId);
   this.updateContext(workItemId,{attemptStart:{executionId:started.executionId,head:before,startedAt:new Date().toISOString(),stage:projection.stage}},currentContext.previousAttempt?["previousAttempt"]:[]);
   this.store.event("model.selected",{role,specVersion,selection,budget},workItemId,started.executionId);
   let result=await adapter.run({workItemId,role,cwd,instructions,selection,executionId:started.executionId,promptMetadata:{...assembled.manifest,budgetBytes:budget.bytes,budgetSource:budget.source,sectionBytes:{Contract:contractBytes,...assembled.manifest.sectionBytes}},allowedNextRoles:route?.allowedNextRoles,consultationFrom:route?.from,localRuntimeUrl});
   const current=new WorkflowProjections(this.store).get(workItemId);if(current.status!=="RUNNING"||current.activeRunId!==started.executionId){this.store.event("execution.discarded",{executionId:started.executionId,reason:"Workflow changed before worktree validation"},workItemId,started.executionId);return true;}
   const changed=this.workspaces.check(cwd,role,before,row.branch,baseline);
   if(role==="developer"||role==="qa"){
    const summaryLine=commitSummary(result.summary);
    this.workspaces.commit(cwd,summaryLine?`factory(${roleShortName(role)}): ${summaryLine} (#${row.issue_number})`:`factory: ${role} for #${row.issue_number}`,row.branch,changed??undefined);
    try {if(this.workspaces.publishAsync)await this.workspaces.publishAsync(cwd,row.branch);else this.workspaces.publish(cwd,row.branch);}
    catch(error){this.store.event("workflow.push_failed",{branch:row.branch,error:sanitizeFailureEvidence(error instanceof Error?error.message:String(error),1600)},workItemId,started.executionId);}
   }
   const resultHead=this.workspaces.head(cwd);
   if(role==="qa"&&config.verifyCommand){
    const verification=await runVerification({cwd,command:config.verifyCommand,timeoutMs:config.timeoutMs});
    verification.outputTail=sanitizeFailureEvidence(verification.outputTail);
    this.store.event("verification.completed",verification,workItemId,started.executionId);
    this.updateContext(workItemId,{verification:{head:resultHead,command:verification.command,exitCode:verification.exitCode}});
    if(verification.exitCode!==0&&result.outcome==="pass")result={...result,outcome:"changes",findings:[...result.findings,{classification:"auto-fix",evidence:`Factory verification failed: \`${verification.command}\` exited ${verification.exitCode}.\n\n${verification.outputTail}`}]};
   }
   const applied=this.results.apply({workItemId,executionId:started.executionId,role,result,head:resultHead,changedPaths:changed??[]});if(invalidResultRetry&&!applied.discarded)this.updateContext(workItemId,{},["invalidResultRetry"]);return true;
  } catch(error){if(!started){if(!preparing)throw error;this.scheduler.rejectQueued(workItemId,new Error(`Could not prepare workflow execution: ${error instanceof Error?error.message:String(error)}`),error instanceof InvalidContextError?"invalid-context":error instanceof SyncConflictError?"integration":"execution");return true;}const interrupted=this.store.db.prepare("SELECT status,interruption_reason FROM executions WHERE id=?").get(started.executionId) as {status:string;interruption_reason:string|null}|undefined;if(interrupted?.status==="interrupted"&&interrupted.interruption_reason==="interrupted-for-guidance"){this.store.event("execution.discarded",{executionId:started.executionId,reason:"Human interrupted the attempt with new guidance"},workItemId,started.executionId);return true;}if(error instanceof InvalidResultError){const current=new WorkflowProjections(this.store).get(workItemId),row=this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string},context=JSON.parse(row.context||"{}") as {invalidResultRetry?:{stage?:DeliveryStage;attempt?:number}};if(current.status==="RUNNING"&&current.activeRunId===started.executionId&&!(context.invalidResultRetry?.stage===current.stage&&context.invalidResultRetry.attempt===current.attempt)){const message=sanitizeFailureEvidence(error.message,1600);this.store.event("execution.invalid_result",{message},workItemId,started.executionId);this.updateContext(workItemId,{invalidResultRetry:{stage:current.stage,attempt:current.attempt,executionId:started.executionId,message}});new WorkflowProjections(this.store).transition({workItemId,expectedRevision:current.revision,stage:current.stage,status:"QUEUED",actor:{type:"orchestrator",id:"runner"},source:{executionId:started.executionId},reason:{code:"invalid-result-retry",summary:"Result rejected by the validator; retrying once with the message"}});return true;}}this.store.event("workflow.result_failed",{error:error instanceof Error?error.message:String(error)},workItemId,started.executionId);const summary=executionOutcomeText(interrupted?.status,interrupted?.interruption_reason??undefined,started.role);this.scheduler.fail(workItemId,started.executionId,summary?new Error(summary):error,error instanceof InvalidContextError?"invalid-context":error instanceof InvalidResultError?"invalid-result":"execution");return true;}
  finally{if(reviewerContext&&cwd)try{this.workspaces.cleanupReviewerContext(cwd,workItemId);}catch(error){this.store.event("workflow.context_cleanup_failed",{error:error instanceof Error?error.message:String(error)},workItemId,started?.executionId);}}
 }
 recordPreviousAttempt(workItemId:string,executionId:string,interruptedAt:string,reason:string,guidanceRecordId?:string){const row=this.store.db.prepare("SELECT context,stage,attempt FROM work_items WHERE id=?").get(workItemId) as {context:string;stage:DeliveryStage;attempt:number},context=JSON.parse(row.context||"{}") as {cwd?:string;attemptStart?:{executionId?:string;head?:string;startedAt?:string;stage?:string}};if(!context.cwd)return;const baseline=context.attemptStart?.executionId===executionId?context.attemptStart.head:undefined,summary=baseline&&this.workspaces.changeSummarySince?this.workspaces.changeSummarySince(context.cwd,baseline):this.workspaces.changeSummary(context.cwd),role=({DESIGN:"product-architect",BUILD:"developer",TEST:"qa",REVIEW:"reviewer",DELIVERY:"reviewer"} as Record<string,AgentRole>)[context.attemptStart?.stage??row.stage],lastResult=this.latestResult(workItemId,role);this.updateContext(workItemId,{previousAttempt:{stage:row.stage,attempt:row.attempt,interruptedAt,reason,startingCommit:baseline??null,files:summary.files,diffStat:summary.stat,lastResult:lastResult??null,guidanceRecordId:guidanceRecordId??null}});}
 private async publish(workItemId:string) {
  const row=this.store.db.prepare("SELECT issue_number,branch,context,revision FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;branch:string;context:string;revision:number};const context=JSON.parse(row.context||"{}") as {title?:string;cwd?:string};
  try {const cwd=context.cwd??this.workspaces.ensure(workItemId,row.branch);if(!context.cwd)this.updateContext(workItemId,{cwd});this.workspaces.assertBranch(cwd,row.branch);const synchronization=this.workspaces.sync(cwd,row.branch,config.defaultBranch,"reviewer");if(synchronization.skipped)this.store.event("workflow.sync_skipped",{branch:row.branch,error:sanitizeFailureEvidence(synchronization.skipped,1600)},workItemId);const head=this.workspaces.head(cwd),verified=(JSON.parse((this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string}).context||"{}") as {verifiedHeads?:Record<string,string>}).verifiedHeads;if(verified?.TEST!==head){new WorkflowProjections(this.store).transition({workItemId,expectedRevision:row.revision,stage:"TEST",status:"QUEUED",actor:{type:"orchestrator",id:"sync"},source:{},reason:{code:"code-changed",summary:"Code changed since the last verified test run"}});return true;}const review=this.latestResult(workItemId,"reviewer");if(!review||review.outcome!=="pass")throw new InvalidResultError("Delivery requires a successful Reviewer result");if(this.workspaces.publishAsync)await this.workspaces.publishAsync(cwd,row.branch);else this.workspaces.publish(cwd,row.branch);if(this.deliveryInterrupted(workItemId,row.revision))return false;const pullRequestUrl=await this.delivery.ensurePR(row.branch,`#${row.issue_number}: ${context.title??"Factory delivery"}`,this.prBody(workItemId,row.issue_number,review));if(this.deliveryInterrupted(workItemId,row.revision))return false;this.results.published({workItemId,pullRequestUrl});return true;}
  catch(error){if(this.deliveryInterrupted(workItemId,row.revision))return false;this.scheduler.rejectQueued(workItemId,error,"integration");return true;}
 }
 private deliveryInterrupted(id:string,revision:number){const row=this.store.db.prepare("SELECT stage,status,archived_at,revision FROM work_items WHERE id=?").get(id) as {stage:string;status:string;archived_at:string|null;revision:number};return row.revision!==revision||row.stage!=="DELIVERY"||row.status!=="QUEUED"||Boolean(row.archived_at);}
 private specVersion(workItemId:string){return (this.store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number|null}).version??0;}
 private assessment(workItemId:string,version:number){const row=this.store.db.prepare("SELECT assessment FROM specs WHERE work_item_id=? AND version=?").get(workItemId,version) as {assessment:string|null}|undefined;if(!row?.assessment)return undefined;return JSON.parse(row.assessment) as TaskAssessment;}
 private latestResult(workItemId:string,role:AgentRole):AgentResult|PublishedLatestResult|undefined{for(const row of this.store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='agent.result' ORDER BY id DESC").all(workItemId) as Array<{payload:string}>){const payload=JSON.parse(row.payload) as {role:AgentRole;result:AgentResult};if(payload.role===role)return payload.result;}const row=this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string},adopted=(JSON.parse(row.context||"{}") as {latestResults?:PublishedLatestResult[]}).latestResults;return adopted?.find(result=>result.role===role);}
 private route(origin:"DESIGN"|"BUILD"|"TEST"|"REVIEW"|"DELIVERY",allowed:Array<"DESIGN"|"BUILD"|"TEST"|"REVIEW"|"DELIVERY">){const roleByStage:{[key:string]:TacticalNextRole}={BUILD:"developer",TEST:"qa",REVIEW:"reviewer"},fromByStage:{[key:string]:DeliveryStage}={BUILD:"BUILD",TEST:"TEST",REVIEW:"REVIEW"};return {from:fromByStage[origin],allowedNextRoles:allowed.map(stage=>roleByStage[stage]).filter(Boolean)};}
 private updateContext(workItemId:string,values:Record<string,unknown>,remove:string[]=[]){const row=this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string},context={...JSON.parse(row.context||"{}"),...values};for(const key of remove)delete context[key];this.store.db.prepare("UPDATE work_items SET context=? WHERE id=?").run(JSON.stringify(context),workItemId);}
 private prBody(workItemId:string,issueNumber:number,result:Pick<AgentResult,"summary">){
  const spec=this.store.db.prepare("SELECT version,approved_by FROM specs WHERE work_item_id=? ORDER BY version DESC LIMIT 1").get(workItemId) as {version:number;approved_by:string};
  const row=this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string},context=JSON.parse(row.context||"{}") as {verification?:{head:string;command:string;exitCode:number|null};verifiedHeads?:Record<string,string>};
  const verification=context.verification,verified=verification&&verification.head===context.verifiedHeads?.TEST&&verification.command===config.verifyCommand;
  const sections=[`Closes #${issueNumber}`,`Approved SPEC v${spec.version} by ${spec.approved_by}. Specification v${spec.version} is in the issue.`,`## Summary\n\n${publishedText(result.summary)}`,`## Factory verification\n\n${verified?`Factory verification: \`${publishedText(verification.command)}\` exited ${verification.exitCode}.`:config.verifyCommand?`Factory verification: \`${publishedText(config.verifyCommand)}\` has no recorded result for the tested head.`:"Factory verification: not configured"}`];
  const qa=this.latestResult(workItemId,"qa");
  if(qa)sections.push(resultMarkdown("qa",{spec:"",acceptanceCriteria:[],questions:[],taskAssessment:null,dependencies:[],nextRole:null,reviewChecks:[],...qa},spec.version,undefined,{reportOnly:true}));
  const findings=this.store.db.prepare("SELECT payload FROM records WHERE work_item_id=? AND spec_version=? AND kind='finding' AND json_extract(payload,'$.classification')='defer' ORDER BY sequence").all(workItemId,spec.version) as Array<{payload:string}>;
  if(findings.length)sections.push(`## Deferred findings\n\n${[...new Set(findings.map(row=>publishedText(JSON.parse(row.payload).evidence)))].map(evidence=>`- ${evidence}`).join("\n")}`);
  return sections.join("\n\n");
 }
}

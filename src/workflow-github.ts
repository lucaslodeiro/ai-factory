import {failureDiagnosis,redactSecrets,sanitizeFailureEvidence} from "./failure-report.js";
import type {RuntimeGitHub} from "./github-runtime.js";
import type { Store } from "./storage.js";
import type { WorkflowGitHubPort } from "./adapters/github.js";
import { workflowStatusMarkdown,workflowLabels } from "./workflow-status.js";
import type { AgentResult,AgentRole } from "./types.js";
import { roleFullName,roleShortName } from "./names.js";
import { factoryHelpMarkdown } from "./factory-help.js";
import {config} from "./config.js";
import {IncompleteIssueStateError, issueStateIndex, validateIssueState, validateSpecificationFact, type ReadIssueState, compactIssueState, type IssueStateIndex} from "./workflow-state.js";
import {WorkflowFailures,type WorkflowFailure} from "./workflow-failures.js";

export function publishedText(value:string){return redactSecrets(value).replaceAll("<!--","<!-\u200b-");}
function publishedAgentData<T>(value:T):T{return JSON.parse(JSON.stringify(value),(_key,leaf)=>typeof leaf==="string"?publishedText(leaf):leaf) as T;}
const payloadMarker=/<!-- ai-factory:payload:v1 ([\s\S]*?) -->/;
export function withPayload(body:string,value:unknown){const json=JSON.stringify(value).replaceAll("--","-\\u002d");return `${body}\n\n<!-- ai-factory:payload:v1 ${json} -->`;}
export function payloadOf(body:string):unknown|null {const match=body.match(payloadMarker);if(!match)return null;try{return JSON.parse(match[1]);}catch{return null;}}
export async function readIssueState(github:Pick<RuntimeGitHub,"comments">,issue:number):Promise<ReadIssueState|null>{const comments=await github.comments(issue),status=comments.find(comment=>comment.body.includes("<!-- ai-factory:workflow-status:")),value=status?payloadOf(status.body):null;if(!value)return null;const index=validateIssueState(value),specs=[];for(const reference of index.specs){const comment=comments.find(candidate=>candidate.body.includes(`:${reference.marker} -->`));if(!comment)throw new Error(`Published specification v${reference.version} is missing`);const spec=validateSpecificationFact(payloadOf(comment.body));if(spec.version!==reference.version)throw new Error(`Published specification marker does not match v${reference.version}`);specs.push(spec);}return{index,specs};}

const approvalAction=(specVersion:number)=>`## Next action\n\n**Approve SPEC v${specVersion}**\n\n\`/factory approve v${specVersion} [guidance]\`\n\nApproving accepts every recommendation above. Optional guidance becomes a SPEC-scoped instruction.\n\n**Change a decision or request changes**\n\n\`/factory answer <feedback>\`\n\nFeedback becomes a human decision for Architect, who proposes a new version.`;
// Screenshots are linked at the exact commit the Designer produced, so the approved images stay
// reachable after the prototype leaves the branch.
function prototypeMarkdown(result:AgentResult,prototype?:{repo:string;head:string}) {
 const link=(file:string)=>prototype?`https://github.com/${prototype.repo}/blob/${prototype.head}/${file.split("/").map(encodeURIComponent).join("/")}`:undefined;
 const images=result.changedFiles.filter(file=>/\.(png|jpe?g|webp)$/i.test(file)),notes=result.changedFiles.find(file=>/README\.md$/i.test(file));
 const shots=images.map(file=>{const url=link(file),name=file.split("/").at(-1)!;return url?`**${name}**\n\n![${name}](${url}?raw=true)`:`- \`${file}\``;}).join("\n\n");
 return `## Screenshots\n\n${shots}${notes?`\n\nStates, flow and copy: ${link(notes)?`[${notes}](${link(notes)})`:`\`${notes}\``}`:""}`;
}
export function resultMarkdown(role:AgentRole,result:AgentResult,specVersion:number,pullRequestUrl?:string,options:{reportOnly?:boolean;prototype?:{repo:string;head:string}}={}) {
 result=publishedAgentData(result);
 const designer=role==="designer"&&result.outcome==="pass",prototypeFollows=role==="product-architect"&&result.outcome==="spec"&&result.taskAssessment?.uxImpact==="significant";
 const environmentBlocked=result.findings.some(finding=>finding.classification==="environment-blocked");
 const heading=role==="product-architect"&&result.outcome==="questions"?(environmentBlocked?"Architect — blocked":"Architect — questions"):role==="product-architect"&&result.outcome==="resolved"?"Architect — tactical decision":role==="product-architect"?(prototypeFollows?`Specification v${specVersion} — prototype in progress`:`Specification v${specVersion} — awaiting approval`):designer?`Prototype for SPEC v${specVersion} — awaiting approval`:`${roleFullName(role)} report`;
 const sections=[`# ${heading}`,`${options.reportOnly&&role==="qa"?"## Tester summary":"## Summary"}\n\n${result.summary}`];
 if(role==="product-architect"&&result.outcome==="spec")sections.push(result.brief.replace(/^(#{1,5})(?=\s)/gm,"#$1"),`## Acceptance criteria\n\n| ID | Criterion |\n| --- | --- |\n${result.acceptanceCriteria.map(criterion=>`| ${criterion.id} | ${criterion.description.replaceAll("|","\\|")} |`).join("\n")}`,prototypeFollows?"## Next action\n\n> The change has significant UX impact, so the Designer is preparing a prototype. The approval command arrives with it; there is nothing to do yet.":approvalAction(specVersion),`<details>\n<summary>Full technical specification v${specVersion} (for Builder, Tester and Reviewer; approving the brief approves it)</summary>\n\n${result.spec.replace(/^(#{1,5})(?=\s)/gm,"#$1")}\n\n</details>`);
 if(designer)sections.push(prototypeMarkdown(result,options.prototype),approvalAction(specVersion));
 if(result.questions.length)sections.push(`## Questions\n\n${result.questions.map((question,index)=>`${index+1}. ${question}`).join("\n")}\n\n## Next action\n\n${environmentBlocked?`A required capability was unavailable. Fix the blocker described below, then retry Design. Include any answers as retry guidance.\n\n\`\`\`text\n/factory retry\n${result.questions.map((_question,index)=>`${index+1}. <answer ${index+1}>`).join("\n")}\n\`\`\``:`Reply with:\n\n\`\`\`text\n/factory answer\n${result.questions.map((_question,index)=>`${index+1}. <answer ${index+1}>`).join("\n")}\n\`\`\``}`);
 if(result.coverage.length)sections.push(`## Acceptance evidence\n\n| Criterion | Status | Evidence |\n| --- | --- | --- |\n${result.coverage.map(row=>`| ${row.criterionId} | ${row.status} | ${row.evidence.replaceAll("|","\\|")} |`).join("\n")}`);
 if(result.tests.length)sections.push(`## Tests\n\n| Command | Exit | Evidence |\n| --- | ---: | --- |\n${result.tests.map(row=>`| \`${row.command.replaceAll("|","\\|")}\` | ${row.exitCode??"not run"} | ${row.evidence.replaceAll("|","\\|")} |`).join("\n")}`);
 if(result.changedFiles.length)sections.push(`## Changed files\n\n${result.changedFiles.map(file=>`- \`${file}\``).join("\n")}`);
 if(result.findings.length)sections.push(`## Findings\n\n${result.findings.map(finding=>`- **${finding.classification}** — ${finding.evidence}`).join("\n")}`);
 if(result.decisions.length)sections.push(`## Decisions\n\n${result.decisions.map(decision=>`- **${decision.kind}** — ${decision.decision}: ${decision.rationale}`).join("\n")}`);
 if(!result.questions.length&&result.outcome!=="spec"&&!designer){const action=result.findings.some(f=>f.classification==="environment-blocked")?"Work failed because a required execution capability is unavailable. Fix the reported environment issue, then Retry this stage. No next agent has been queued.":role==="product-architect"&&result.outcome==="resolved"?`No human action is required; ${roleShortName(result.nextRole!)} continues.`:role==="product-architect"?"Review the specification and use the command shown in the AI Factory status comment.":role==="qa"&&result.outcome==="decision"?"Architect will resolve this decision; no human action is required.":role==="reviewer"?`Review and merge the pull request${pullRequestUrl?` (${pullRequestUrl})`:""} when it is ready.`:`${roleShortName(role)} finished. The next workflow stage is queued automatically.`;sections.push(`## Next action\n\n> ${action}`);}
 return sections.filter(section=>!options.reportOnly||!section.startsWith("# ")&&!section.startsWith("## Next action")).join("\n\n");
}

const stageName:Record<WorkflowFailure["stage"],string>={DESIGN:"Design",BUILD:"Build",TEST:"Test",REVIEW:"Review",DELIVERY:"Delivery"};
function failureMarkdown(store:Store,failure:WorkflowFailure) {
 const run=failure.executionId?store.db.prepare("SELECT status,exit_code,finished_at FROM executions WHERE id=? AND work_item_id=?").get(failure.executionId,failure.workItemId) as {status:string;exit_code:number|null;finished_at:string|null}|undefined:undefined;
 const process=run?{status:run.status==="running"&&run.finished_at?"failed":run.status,exit_code:run.exit_code}:undefined;
 const reason=publishedText(sanitizeFailureEvidence(failure.message,1600))||"The workflow stopped without an error message.";
 return `# ${stageName[failure.stage]} failed\n\nThe Factory preserved this stage and its work so it can be retried safely.\n\n${failureDiagnosis(reason,"",process,failure.class)}\n\n## Exact validation message\n\n\`\`\`text\n${reason}\n\`\`\`\n\n## Next action\n\nFix the reported cause, then post:\n\n\`\`\`text\n/factory retry\n\`\`\`\n\n<sub>instance:${config.instanceName}</sub>`;
}

export type WorkflowPublication={status:"published";commentId:number|null;url:string|null;publishedAt:string}|{status:"failed";attempts:number;error:string;failedAt:string}|{status:"skipped"};
export const PUBLICATION_ATTENTION_ATTEMPTS=3;
export const resultPublicationKey=(eventId:number)=>`github:result:${eventId}`;
export const failurePublicationKey=(failureId:string)=>`github:failure:${failureId}`;
export const statusPublicationKey=(workItemId:string)=>`github:status:${workItemId}`;
export function publicationOf(store:Store,key:string):WorkflowPublication|undefined{const value=store.metadata<WorkflowPublication|boolean>(key);return value&&typeof value==="object"?value:undefined;}
export const commentUrl=(repo:string,issue:number,commentId:number|null|undefined)=>Number.isSafeInteger(commentId)&&(commentId as number)>0?`https://github.com/${repo}/issues/${issue}#issuecomment-${commentId}`:null;
export function isMilestoneResult(store:Store,row:{work_item_id:string;run_id:string},payload:{role:AgentRole;result:AgentResult}) {
 if(payload.result.outcome==="decision")return true;
 if(payload.role==="product-architect"&&["spec","questions","resolved"].includes(payload.result.outcome))return true;
 if(payload.role==="designer"&&payload.result.outcome==="pass")return true;
 if(payload.role==="reviewer"&&payload.result.outcome==="pass")return true;
 if(payload.result.outcome!=="changes")return false;
 const transition=store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND run_id=? AND type='workflow.transition' ORDER BY id DESC LIMIT 1").get(row.work_item_id,row.run_id) as {payload:string}|undefined;
 if(!transition)return false;
 try{return (JSON.parse(transition.payload) as {reason?:{code?:string}}).reason?.code==="correction-limit";}catch{return false;}
}

export class WorkflowGitHubPublisher {
 constructor(private store:Store,private github:Pick<RuntimeGitHub,keyof WorkflowGitHubPort>&Partial<Pick<RuntimeGitHub,"assignees"|"assign"|"unassign">>) {}
 /** Runs one GitHub write, records its outcome under `key` and never throws: a failure is stored with its attempt count and reported once per key, then once more when it needs attention. */
 private async attempt(target:{workItemId:string;issue:number;repo:string;key:string;kind:"status"|"result"|"failure"|"help"},write:()=>Promise<number|void>|number|void):Promise<Error|undefined>{
  try{
   const commentId=await write(),id=Number.isSafeInteger(commentId)&&(commentId as number)>0?commentId as number:null;
   const url=commentUrl(target.repo,target.issue,id);
   this.store.setMetadata(target.key,{status:"published",commentId:id,url,publishedAt:new Date().toISOString()} satisfies WorkflowPublication);
   // Recorded so an open dashboard conversation reloads and flips the milestone from pending to published; the events feed hides it.
   this.store.event("github.published",{issue:target.issue,key:target.key,kind:target.kind,commentId:id,url},target.workItemId);
   return undefined;
  }catch(error){
   const previous=publicationOf(this.store,target.key),attempts=(previous?.status==="failed"?previous.attempts:0)+1,message=error instanceof Error?error.message:String(error);
   this.store.setMetadata(target.key,{status:"failed",attempts,error:message,failedAt:new Date().toISOString()} satisfies WorkflowPublication);
   const detail={issue:target.issue,key:target.key,kind:target.kind,attempts,error:message};
   if(attempts===1)this.store.event("github.publish_failed",detail,target.workItemId);
   if(attempts===PUBLICATION_ATTENTION_ATTEMPTS)this.store.event("github.publish_stalled",detail,target.workItemId);
   return error instanceof Error?error:new Error(message);
  }
 }
 async publish(workItemId:string) {
  const row=this.store.db.prepare("SELECT issue_number,repo,revision,presentation_revision,published_presentation_revision,archived_at FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;repo:string;revision:number;presentation_revision:number;published_presentation_revision:number|null;archived_at:string|null}|undefined;
  if(!row)throw new Error("Unknown work item");
  if(row.archived_at||row.presentation_revision<=(row.published_presentation_revision??-1))return false;
  const revision=row.revision,presentationRevision=row.presentation_revision;
  const lastEvent=this.store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='workflow.transition' ORDER BY id DESC LIMIT 1").get(workItemId) as {payload:string}|undefined;
  let eventId:string|undefined;try{eventId=lastEvent?(JSON.parse(lastEvent.payload) as {eventId?:string}).eventId:undefined;}catch{}
  const status=`${workflowStatusMarkdown(this.store,workItemId)}\n\n<sub>workflow-rev:${revision} · presentation-rev:${presentationRevision}${eventId?` · event:${eventId}`:""}</sub>\n\n<sub>instance:${config.instanceName}</sub>`;let indexed:string|undefined,index:IssueStateIndex|undefined,clippedTo:number|null|undefined;
  try{
   const built=issueStateIndex(this.store,workItemId);
   built.latestResults=built.latestResults.map(publishedAgentData);
   if(built.failure)built.failure.message=publishedText(built.failure.message);
   built.records=built.records.map(record=>record.source_type==="agent-result"?{...record,payload:publishedAgentData(record.payload)}:record);
   index=built;
   const compacted=compactIssueState(built,candidate=>withPayload(status,candidate).length<=60_000);
   if(compacted){indexed=withPayload(status,compacted.index);clippedTo=compacted.clippedTo;}
  }catch(error){if(!(error instanceof IncompleteIssueStateError))throw error;const key=`github:state-incomplete:${workItemId}:${presentationRevision}`;if(!this.store.metadata(key)){this.store.event("github.state_incomplete",{issue:row.issue_number,reason:error.message,revision},workItemId);this.store.setMetadata(key,true);}}
  const body=indexed ?? status;
  if(indexed===undefined&&index!==undefined){const key=`github:state-too-large:${workItemId}:${presentationRevision}`;if(!this.store.metadata(key)){this.store.event("github.state_too_large",{issue:row.issue_number,bytes:withPayload(status,index).length,revision},workItemId);this.store.setMetadata(key,true);}}
  if(clippedTo!==null&&clippedTo!==undefined){const key=`github:state-compacted:${workItemId}:${presentationRevision}`;if(!this.store.metadata(key)){this.store.event("github.state_compacted",{issue:row.issue_number,clippedTo,revision},workItemId);this.store.setMetadata(key,true);}}
  const error=await this.attempt({workItemId,issue:row.issue_number,repo:row.repo,key:statusPublicationKey(workItemId),kind:"status"},()=>this.github.syncWorkflow(row.issue_number,workflowLabels(this.store,workItemId),body));
  if(error)throw error;
  this.store.db.prepare("UPDATE work_items SET published_presentation_revision=? WHERE id=? AND (published_presentation_revision IS NULL OR published_presentation_revision<?)").run(presentationRevision,workItemId,presentationRevision);
  return true;
 }
 /** Publishes every changed status comment. One work item's failure never blocks the others; the first error is rethrown after the pass. */
 async publishChanged() {
  let count=0,first:Error|undefined;
  for(const row of this.store.db.prepare("SELECT id FROM work_items WHERE archived_at IS NULL AND presentation_revision>COALESCE(published_presentation_revision,-1)").all() as Array<{id:string}>){
   try{if(await this.publish(row.id))count++;}catch(error){first??=error instanceof Error?error:new Error(String(error));}
  }
  if(first)throw first;
  return count;
 }
 async publishHelp() {
  let count=0,first:Error|undefined;const rows=this.store.db.prepare("SELECT DISTINCT e.work_item_id,w.issue_number,w.repo,w.archived_at FROM events e JOIN work_items w ON w.id=e.work_item_id WHERE e.type='command.help' ORDER BY e.id").all() as Array<{work_item_id:string;issue_number:number;repo:string;archived_at:string|null}>;
  for(const row of rows){const key=`github:help:${row.work_item_id}`;if(row.archived_at||publicationOf(this.store,key)?.status==="published")continue;const error=await this.attempt({workItemId:row.work_item_id,issue:row.issue_number,repo:row.repo,key,kind:"help"},()=>this.github.publishWorkflowComment(row.issue_number,"help",factoryHelpMarkdown()));if(error)first??=error;else count++;}
  if(first)throw first;
  return count;
 }
 async publishResults() {
  let count=0,first:Error|undefined;
  const rows=this.store.db.prepare("SELECT e.id,e.work_item_id,e.run_id,e.payload,w.issue_number,w.repo,w.archived_at,w.context FROM events e JOIN work_items w ON w.id=e.work_item_id WHERE e.type='agent.result' ORDER BY e.id").all() as Array<{id:number;work_item_id:string;run_id:string;payload:string;issue_number:number;repo:string;archived_at:string|null;context:string}>;
  for(const row of rows) {
   const key=resultPublicationKey(row.id),current=publicationOf(this.store,key);
   if(row.archived_at||current?.status==="published"||current?.status==="skipped")continue;
   const payload=JSON.parse(row.payload) as {role:AgentRole;result:AgentResult;specVersion:number;prototypeHead?:string};
   if(!isMilestoneResult(this.store,row,payload)) {this.store.setMetadata(key,{status:"skipped"} satisfies WorkflowPublication);continue;}
   const version=payload.specVersion||((this.store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(row.work_item_id) as {version:number|null}).version??0);
   const context=JSON.parse(row.context||"{}") as {pr?:string};let machine:Record<string,unknown>;
   if(payload.role==="product-architect"&&payload.result.outcome==="spec"){
    const spec=this.store.db.prepare("SELECT version,body,criteria,assessment FROM specs WHERE work_item_id=? AND version=?").get(row.work_item_id,version) as {version:number;body:string;criteria:string;assessment:string|null};machine={kind:"spec",version:spec.version,body:spec.body,criteria:JSON.parse(spec.criteria),assessment:spec.assessment?JSON.parse(spec.assessment):null};
   }else machine={kind:"result",role:payload.role,executionId:row.run_id,outcome:payload.result.outcome,findings:payload.result.findings,decisions:payload.result.decisions,coverage:payload.result.coverage,tests:payload.result.tests,changedFiles:payload.result.changedFiles,summary:payload.result.summary};
   const marker=`result-${row.run_id}`;
   const error=await this.attempt({workItemId:row.work_item_id,issue:row.issue_number,repo:row.repo,key,kind:"result"},()=>this.github.publishWorkflowComment(row.issue_number,marker,withPayload(`${resultMarkdown(payload.role,payload.result,version,context.pr,{prototype:payload.prototypeHead?{repo:row.repo,head:payload.prototypeHead}:undefined})}\n\n<sub>instance:${config.instanceName}</sub>`,publishedAgentData(machine))));
   if(error){first??=error;continue;}
   if(payload.role==="product-architect"&&payload.result.outcome==="spec"){const current=this.store.db.prepare("SELECT context FROM work_items WHERE id=?").get(row.work_item_id) as {context:string},value=JSON.parse(current.context||"{}") as Record<string,unknown>,specMarkers=value.specMarkers&&typeof value.specMarkers==="object"&&!Array.isArray(value.specMarkers)?value.specMarkers as Record<string,string>:{};this.store.db.prepare("UPDATE work_items SET context=? WHERE id=?").run(JSON.stringify({...value,specMarkers:{...specMarkers,[String(version)]:marker}}),row.work_item_id);}
   count++;
  }
  const failures=await this.publishFailures();
  if(first)throw first;
  if(failures instanceof Error)throw failures;
  return count+failures;
 }
 private async publishFailures():Promise<number|Error> {
  let count=0,first:Error|undefined;
  const rows=this.store.db.prepare("SELECT f.id,f.work_item_id,w.issue_number,w.repo,w.archived_at FROM failures f JOIN work_items w ON w.id=f.work_item_id WHERE f.resolved_at IS NULL ORDER BY f.created_at").all() as Array<{id:string;work_item_id:string;issue_number:number;repo:string;archived_at:string|null}>;
  const failures=new WorkflowFailures(this.store);
  for(const row of rows){const key=failurePublicationKey(row.id);if(row.archived_at||publicationOf(this.store,key)?.status==="published")continue;const failure=failures.get(row.id);if(!failure)continue;const error=await this.attempt({workItemId:row.work_item_id,issue:row.issue_number,repo:row.repo,key,kind:"failure"},()=>this.github.publishWorkflowComment(row.issue_number,`failure-${row.id}`,failureMarkdown(this.store,failure)));if(error)first??=error;else count++;}
  return first??count;
 }
}

import type {RuntimeGitHub} from "./github-runtime.js";
import type { Store } from "./storage.js";
import type { WorkflowGitHubPort } from "./adapters/github.js";
import { workflowStatusMarkdown,workflowLabels } from "./workflow-status.js";
import type { AgentResult,AgentRole } from "./types.js";
import { roleFullName,roleShortName } from "./names.js";
import { factoryHelpMarkdown } from "./factory-help.js";
import {config} from "./config.js";
import {issueStateIndex} from "./workflow-state.js";

const payloadMarker=/<!-- ai-factory:payload:v1 ([\s\S]*?) -->/;
export function withPayload(body:string,value:unknown){const json=JSON.stringify(value).replaceAll("--","-\\u002d");return `${body}\n\n<!-- ai-factory:payload:v1 ${json} -->`;}
export function payloadOf(body:string):unknown|null {const match=body.match(payloadMarker);if(!match)return null;try{return JSON.parse(match[1]);}catch{return null;}}

export function resultMarkdown(role:AgentRole,result:AgentResult,specVersion:number,pullRequestUrl?:string) {
 const heading=role==="product-architect"&&result.outcome==="questions"?"Architect — questions":role==="product-architect"&&result.outcome==="resolved"?"Architect — tactical decision":role==="product-architect"?`Specification v${specVersion} — awaiting approval`:`${roleFullName(role)} report`;
 const sections=[`# ${heading}`,`## Summary\n\n${result.summary}`];
 if(role==="product-architect"&&result.outcome==="spec")sections.push(result.spec.replace(/^(#{1,5})(?=\s)/gm,"#$1"),`## Acceptance criteria\n\n| ID | Criterion |\n| --- | --- |\n${result.acceptanceCriteria.map(criterion=>`| ${criterion.id} | ${criterion.description.replaceAll("|","\\|")} |`).join("\n")}`,`## Next action\n\n**Approve SPEC v${specVersion}**\n\n\`/factory approve v${specVersion} [guidance]\`\n\nOptional guidance becomes a SPEC-scoped instruction.\n\n**Request changes**\n\n\`/factory answer <feedback>\`\n\nFeedback becomes a human decision for Architect.`);
 if(result.questions.length)sections.push(`## Questions\n\n${result.questions.map((question,index)=>`${index+1}. ${question}`).join("\n")}\n\n## Next action\n\nReply with:\n\n\`\`\`text\n/factory answer\n${result.questions.map((_question,index)=>`${index+1}. <answer ${index+1}>`).join("\n")}\n\`\`\``);
 if(result.coverage.length)sections.push(`## Acceptance evidence\n\n| Criterion | Status | Evidence |\n| --- | --- | --- |\n${result.coverage.map(row=>`| ${row.criterionId} | ${row.status} | ${row.evidence.replaceAll("|","\\|")} |`).join("\n")}`);
 if(result.tests.length)sections.push(`## Tests\n\n| Command | Exit | Evidence |\n| --- | ---: | --- |\n${result.tests.map(row=>`| \`${row.command.replaceAll("|","\\|")}\` | ${row.exitCode??"not run"} | ${row.evidence.replaceAll("|","\\|")} |`).join("\n")}`);
 if(result.changedFiles.length)sections.push(`## Changed files\n\n${result.changedFiles.map(file=>`- \`${file}\``).join("\n")}`);
 if(result.findings.length)sections.push(`## Findings\n\n${result.findings.map(finding=>`- **${finding.classification}** — ${finding.evidence}`).join("\n")}`);
 if(result.decisions.length)sections.push(`## Decisions\n\n${result.decisions.map(decision=>`- **${decision.kind}** — ${decision.decision}: ${decision.rationale}`).join("\n")}`);
 if(!result.questions.length&&result.outcome!=="spec"){const action=result.findings.some(f=>f.classification==="environment-blocked")?"Work failed because a required execution capability is unavailable. Fix the reported environment issue, then Retry this stage. No next agent has been queued.":role==="product-architect"&&result.outcome==="resolved"?`No human action is required; ${roleShortName(result.nextRole!)} continues.`:role==="product-architect"?"Review the specification and use the command shown in the AI Factory status comment.":role==="qa"&&result.outcome==="decision"?"Architect will resolve this decision; no human action is required.":role==="reviewer"?`Review and merge the pull request${pullRequestUrl?` (${pullRequestUrl})`:""} when it is ready.`:`${roleShortName(role)} finished. The next workflow stage is queued automatically.`;sections.push(`## Next action\n\n> ${action}`);}
 return sections.join("\n\n");
}

export class WorkflowGitHubPublisher {
 constructor(private store:Store,private github:Pick<RuntimeGitHub,keyof WorkflowGitHubPort>&Partial<Pick<RuntimeGitHub,"assignees"|"assign"|"unassign">>) {}
 async publish(workItemId:string) {
  const row=this.store.db.prepare("SELECT issue_number,revision,presentation_revision,published_presentation_revision,archived_at FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;revision:number;presentation_revision:number;published_presentation_revision:number|null;archived_at:string|null}|undefined;
  if(!row)throw new Error("Unknown work item");
  if(row.archived_at||row.presentation_revision<=(row.published_presentation_revision??-1))return false;
  const revision=row.revision,presentationRevision=row.presentation_revision;
  const lastEvent=this.store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='workflow.transition' ORDER BY id DESC LIMIT 1").get(workItemId) as {payload:string}|undefined;
  let eventId:string|undefined;try{eventId=lastEvent?(JSON.parse(lastEvent.payload) as {eventId?:string}).eventId:undefined;}catch{}
  const status=`${workflowStatusMarkdown(this.store,workItemId)}\n\n<sub>workflow-rev:${revision} · presentation-rev:${presentationRevision}${eventId?` · event:${eventId}`:""}</sub>\n\n<sub>instance:${config.instanceName}</sub>`,indexed=withPayload(status,issueStateIndex(this.store,workItemId)),body=indexed.length<=60_000?indexed:status;
  if(indexed.length>60_000){const key=`github:state-too-large:${workItemId}:${presentationRevision}`;if(!this.store.metadata(key)){this.store.event("github.state_too_large",{issue:row.issue_number,bytes:indexed.length,revision},workItemId);this.store.setMetadata(key,true);}}
  await this.github.syncWorkflow(row.issue_number,workflowLabels(this.store,workItemId),body);
  this.store.db.prepare("UPDATE work_items SET published_presentation_revision=? WHERE id=? AND (published_presentation_revision IS NULL OR published_presentation_revision<?)").run(presentationRevision,workItemId,presentationRevision);
  return true;
 }
 async publishChanged() {
  let count=0;for(const row of this.store.db.prepare("SELECT id FROM work_items WHERE archived_at IS NULL AND presentation_revision>COALESCE(published_presentation_revision,-1)").all() as Array<{id:string}>)if(await this.publish(row.id))count++;return count;}
 async publishHelp() {
  let count=0;const rows=this.store.db.prepare("SELECT DISTINCT e.work_item_id,w.issue_number,w.archived_at FROM events e JOIN work_items w ON w.id=e.work_item_id WHERE e.type='command.help' ORDER BY e.id").all() as Array<{work_item_id:string;issue_number:number;archived_at:string|null}>;
  for(const row of rows){const key=`github:help:${row.work_item_id}`;if(row.archived_at||this.store.metadata<boolean>(key))continue;await this.github.publishWorkflowComment(row.issue_number,"help",factoryHelpMarkdown());this.store.setMetadata(key,true);count++;}
  return count;
 }
 async publishResults() {
  let count=0;
  const rows=this.store.db.prepare("SELECT e.id,e.work_item_id,e.run_id,e.payload,w.issue_number,w.archived_at,w.context FROM events e JOIN work_items w ON w.id=e.work_item_id WHERE e.type='agent.result' ORDER BY e.id").all() as Array<{id:number;work_item_id:string;run_id:string;payload:string;issue_number:number;archived_at:string|null;context:string}>;
  for(const row of rows) {
   if(row.archived_at||this.store.metadata<boolean>(`github:result:${row.id}`))continue;
   const payload=JSON.parse(row.payload) as {role:AgentRole;result:AgentResult;specVersion:number};
   if(!this.isMilestone(row,payload)) {this.store.setMetadata(`github:result:${row.id}`,true);continue;}
   const version=payload.specVersion||((this.store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(row.work_item_id) as {version:number|null}).version??0);
   const context=JSON.parse(row.context||"{}") as {pr?:string};let machine:Record<string,unknown>;
   if(payload.role==="product-architect"&&payload.result.outcome==="spec"){
    const spec=this.store.db.prepare("SELECT version,body,criteria,assessment FROM specs WHERE work_item_id=? AND version=?").get(row.work_item_id,version) as {version:number;body:string;criteria:string;assessment:string|null};machine={kind:"spec",version:spec.version,body:spec.body,criteria:JSON.parse(spec.criteria),assessment:spec.assessment?JSON.parse(spec.assessment):null};
   }else machine={kind:"result",role:payload.role,executionId:row.run_id,outcome:payload.result.outcome,findings:payload.result.findings,decisions:payload.result.decisions,coverage:payload.result.coverage,tests:payload.result.tests,changedFiles:payload.result.changedFiles,summary:payload.result.summary};
   await this.github.publishWorkflowComment(row.issue_number,`result-${row.run_id}`,withPayload(`${resultMarkdown(payload.role,payload.result,version,context.pr)}\n\n<sub>instance:${config.instanceName}</sub>`,machine));
   this.store.setMetadata(`github:result:${row.id}`,true);count++;
  }
  return count;
 }
 private isMilestone(row:{work_item_id:string;run_id:string},payload:{role:AgentRole;result:AgentResult}) {
  if(payload.result.outcome==="decision")return true;
  if(payload.role==="product-architect"&&["spec","questions","resolved"].includes(payload.result.outcome))return true;
  if(payload.role==="reviewer"&&payload.result.outcome==="pass")return true;
  if(payload.result.outcome!=="changes")return false;
  const transition=this.store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND run_id=? AND type='workflow.transition' ORDER BY id DESC LIMIT 1").get(row.work_item_id,row.run_id) as {payload:string}|undefined;
  if(!transition)return false;
  try{return (JSON.parse(transition.payload) as {reason?:{code?:string}}).reason?.code==="correction-limit";}catch{return false;}
 }
}

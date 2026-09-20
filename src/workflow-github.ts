import type { Store } from "./storage.js";
import type { WorkflowGitHubPort } from "./adapters/github.js";
import { workflowStatusMarkdown,workflowLabels } from "./workflow-status.js";
import type { AgentResult,AgentRole } from "./types.js";
import { roleFullName,roleShortName } from "./names.js";
import { factoryHelpMarkdown } from "./factory-help.js";

function resultMarkdown(role:AgentRole,result:AgentResult,specVersion:number) {
 const heading=role==="product-architect"&&result.outcome==="questions"?"Architect — questions":role==="product-architect"&&result.outcome==="resolved"?"Architect — tactical decision":role==="product-architect"?`Specification v${specVersion}`:`${roleFullName(role)} report`;
 const sections=[`# ${heading}`,`## Summary\n\n${result.summary}`];
 if(role==="product-architect"&&result.outcome==="spec")sections.push(result.spec);
 if(result.questions.length)sections.push(`## Questions\n\n${result.questions.map((question,index)=>`${index+1}. ${question}`).join("\n")}\n\n## Next action\n\nReply with:\n\n\`\`\`text\n/factory answer\n${result.questions.map((_question,index)=>`${index+1}. <answer ${index+1}>`).join("\n")}\n\`\`\``);
 if(result.coverage.length)sections.push(`## Acceptance evidence\n\n| Criterion | Status | Evidence |\n| --- | --- | --- |\n${result.coverage.map(row=>`| ${row.criterionId} | ${row.status} | ${row.evidence.replaceAll("|","\\|")} |`).join("\n")}`);
 if(result.tests.length)sections.push(`## Tests\n\n| Command | Exit | Evidence |\n| --- | ---: | --- |\n${result.tests.map(row=>`| \`${row.command.replaceAll("|","\\|")}\` | ${row.exitCode??"not run"} | ${row.evidence.replaceAll("|","\\|")} |`).join("\n")}`);
 if(result.changedFiles.length)sections.push(`## Changed files\n\n${result.changedFiles.map(file=>`- \`${file}\``).join("\n")}`);
 if(result.findings.length)sections.push(`## Findings\n\n${result.findings.map(finding=>`- **${finding.classification}** — ${finding.evidence}`).join("\n")}`);
 if(result.decisions.length)sections.push(`## Decisions\n\n${result.decisions.map(decision=>`- **${decision.kind}** — ${decision.decision}: ${decision.rationale}`).join("\n")}`);
 if(!result.questions.length){const action=role==="product-architect"&&result.outcome==="resolved"?`No human action is required; ${roleShortName(result.nextRole!)} continues.`:role==="product-architect"?"Review the specification and use the command shown in the AI Factory status comment.":role==="reviewer"?"Review the pull request and merge it when ready.":`${roleShortName(role)} finished. The next workflow stage is queued automatically.`;sections.push(`## Next action\n\n> ${action}`);}
 return sections.join("\n\n");
}

export class WorkflowGitHubPublisher {
 constructor(private store:Store,private github:WorkflowGitHubPort) {}
 publish(workItemId:string) {
  const row=this.store.db.prepare("SELECT issue_number,revision,presentation_revision,published_presentation_revision,archived_at FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;revision:number;presentation_revision:number;published_presentation_revision:number|null;archived_at:string|null}|undefined;
  if(!row)throw new Error("Unknown work item");
  if(row.archived_at||row.presentation_revision<=(row.published_presentation_revision??-1))return false;
  const revision=row.revision,presentationRevision=row.presentation_revision;
  const lastEvent=this.store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='workflow.transition' ORDER BY id DESC LIMIT 1").get(workItemId) as {payload:string}|undefined;
  let eventId:string|undefined;try{eventId=lastEvent?(JSON.parse(lastEvent.payload) as {eventId?:string}).eventId:undefined;}catch{}
  const body=`${workflowStatusMarkdown(this.store,workItemId)}\n\n<sub>workflow-rev:${revision} · presentation-rev:${presentationRevision}${eventId?` · event:${eventId}`:""}</sub>`;
  this.github.syncWorkflow(row.issue_number,workflowLabels(this.store,workItemId),body);
  this.store.db.prepare("UPDATE work_items SET published_presentation_revision=? WHERE id=? AND (published_presentation_revision IS NULL OR published_presentation_revision<?)").run(presentationRevision,workItemId,presentationRevision);
  return true;
 }
 publishChanged() {let count=0;for(const row of this.store.db.prepare("SELECT id FROM work_items WHERE archived_at IS NULL AND presentation_revision>COALESCE(published_presentation_revision,-1)").all() as Array<{id:string}>)if(this.publish(row.id))count++;return count;}
 publishHelp() {
  let count=0;const rows=this.store.db.prepare("SELECT DISTINCT e.work_item_id,w.issue_number,w.archived_at FROM events e JOIN work_items w ON w.id=e.work_item_id WHERE e.type='command.help' ORDER BY e.id").all() as Array<{work_item_id:string;issue_number:number;archived_at:string|null}>;
  for(const row of rows){const key=`github:help:${row.work_item_id}`;if(row.archived_at||this.store.metadata<boolean>(key))continue;this.github.publishWorkflowComment(row.issue_number,"help",factoryHelpMarkdown());this.store.setMetadata(key,true);count++;}
  return count;
 }
 publishResults() {
  let count=0;
  const rows=this.store.db.prepare("SELECT e.id,e.work_item_id,e.run_id,e.payload,w.issue_number,w.archived_at FROM events e JOIN work_items w ON w.id=e.work_item_id WHERE e.type='agent.result' ORDER BY e.id").all() as Array<{id:number;work_item_id:string;run_id:string;payload:string;issue_number:number;archived_at:string|null}>;
  for(const row of rows) {
   if(row.archived_at||this.store.metadata<boolean>(`github:result:${row.id}`))continue;
   const payload=JSON.parse(row.payload) as {role:AgentRole;result:AgentResult;specVersion:number};
   if(!this.isMilestone(row,payload)) {this.store.setMetadata(`github:result:${row.id}`,true);continue;}
   const version=payload.specVersion||((this.store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(row.work_item_id) as {version:number|null}).version??0);
   this.github.publishWorkflowComment(row.issue_number,`result-${row.run_id}`,resultMarkdown(payload.role,payload.result,version));
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

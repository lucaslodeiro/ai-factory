import {publishedText} from "./workflow-github.js";
import type { Store } from "./storage.js";
import { WorkflowFailures } from "./workflow-failures.js";
import { WorkflowProjections } from "./workflow-projection.js";
import { WorkflowRecords } from "./workflow-records.js";
import { sanitizeFailureEvidence,workflowFailureEvidence } from "./failure-report.js";
import { roleShortName } from "./names.js";
import type { LastCommandOutcome } from "./workflow-inbox.js";
import { factoryCommandReference } from "./factory-help.js";
import {config} from "./config.js";

const stages={DESIGN:"Design",BUILD:"Build",TEST:"Test",REVIEW:"Review",DELIVERY:"Delivery"} as const;
const stageActors={DESIGN:"Architect",BUILD:"Builder",TEST:"Tester",REVIEW:"Reviewer",DELIVERY:"Orchestrator"} as const;
const statuses={QUEUED:"Queued",RUNNING:"Running",WAITING:"Waiting for you",FAILED:"Failed",PAUSED:"Paused",CANCELLED:"Cancelled",COMPLETED:"Completed"} as const;
const palette={DESIGN:["5319e7","Architect is designing the specification"],BUILD:["1d76db","Builder is implementing the approved specification"],TEST:["fbca04","Tester is verifying the implementation"],REVIEW:["006b75","Reviewer is inspecting delivery evidence"],DELIVERY:["0e8a16","Delivery is awaiting or recording merge"],done:["0e8a16","Factory delivery completed"],WAITING:["d4c5f9","Human action is required"],FAILED:["b60205","Factory execution failed"],PAUSED:["c5def5","Factory workflow is paused"],CANCELLED:["6a737d","Factory workflow was cancelled"]} as const;
const box=(body:string)=>`## Next action\n\n> ${body.replaceAll("\n","\n> ")}`;
const command=(value:string)=>`\n\n\`\`\`text\n${value}\n\`\`\``;
const clipSummary=(value:string,max=1450)=>value.length<=max?{text:value,clipped:false}:{text:`${value.slice(0,max-1).trimEnd()}…`,clipped:true};
const utcMinute=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?value:`${date.toISOString().slice(0,16).replace("T"," ")} UTC`;};

function humanRequestAction(store:Store,request:NonNullable<ReturnType<WorkflowRecords["activeRequest"]>>) {
 if(request.payload.kind!=="request"||request.payload.owner!=="human")return "";
 if(request.payload.type==="spec-approval")return `Read the brief in the SPEC v${request.specVersion} comment: the decisions that need you, the solution and the acceptance criteria. The full specification is folded below it; you do not need to read it. Post one new comment.\n\n**Approve**${command(`/factory approve v${request.specVersion} [guidance]`)}\nApproving accepts every recommendation in the brief. Optional guidance becomes a spec-scoped instruction.\n\n**Change a decision or request changes**${command("/factory answer <feedback>")}\nFeedback becomes a human decision for Architect, who proposes a new version.`;
 if(request.payload.type==="merge") {const row=store.db.prepare("SELECT context FROM work_items WHERE id=?").get(request.workItemId) as {context:string}|undefined;const pr=JSON.parse(row?.context||"{}").pr;const link=typeof pr==="string"&&/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(pr)?`**[Open pull request](${pr})**\n\n`:"";return `${link}Review and merge the pull request in GitHub when it is ready, or request changes.\n\n**Merge** in GitHub.\n\n**Request changes**${command("/factory answer <changes>")}\nThe text becomes a human auto-fix finding for Builder.`;}
 if(request.payload.type==="correction-limit") {const transition=store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='workflow.transition' ORDER BY id DESC LIMIT 1").get(request.workItemId) as {payload:string}|undefined;let noChange=false;try{noChange=JSON.parse(transition?.payload??"{}").reason?.code==="no-change-pass";}catch{}const findings=(request.payload.findingIds??[]).map(id=>new WorkflowRecords(store).get(id)).filter(record=>record?.payload.kind==="finding").slice(0,4);const details=findings.length?`\n\n**Open findings**\n${findings.map(record=>`- ${record!.payload.kind==="finding"?clipSummary(publishedText(record!.payload.evidence),360).text:""}`).join("\n")}`:"";return `${noChange?"Builder found nothing to change after the last correction request.":"Automatic correction stopped after reaching its configured limit."}${details}\n\nTell Architect how to resolve these findings.${command("/factory answer <guidance>")}\nThe text becomes a human decision for Architect.`;}
 return `Reply with the guidance Architect needs.${command("/factory answer <guidance>")}\nThe text becomes a human decision for Architect.`;
}

export function workflowLabels(store:Store,workItemId:string) {
 const p=new WorkflowProjections(store).get(workItemId);
 if(p.status==="COMPLETED")return [{name:"factory:done",color:palette.done[0],description:palette.done[1]}];
 const stage=palette[p.stage],result:Array<{name:string;color:string;description:string}>=[{name:`factory:${p.stage.toLowerCase()}`,color:stage[0],description:stage[1]}];
 if(["WAITING","FAILED","PAUSED","CANCELLED"].includes(p.status)){const condition=palette[p.status as "WAITING"|"FAILED"|"PAUSED"|"CANCELLED"];result.push({name:`factory:${p.status.toLowerCase()}`,color:condition[0],description:condition[1]});}
 return result;
}

function nextAction(store:Store,workItemId:string) {
 const projection=new WorkflowProjections(store).get(workItemId),request=new WorkflowRecords(store).activeRequest(workItemId);
 if(["PAUSED","CANCELLED"].includes(projection.status)){const transition=store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='workflow.transition' ORDER BY id DESC LIMIT 1").get(workItemId) as {payload:string}|undefined;let actor="the operator",reason="";if(transition)try{const payload=JSON.parse(transition.payload) as {actor?:{type?:string;id?:string};reason?:{summary?:string}};if(payload.actor?.id)actor=payload.actor.type==="human"?`@${payload.actor.id}`:payload.actor.id;reason=payload.reason?.summary??"";}catch{}const state=projection.status==="PAUSED"?"Paused":"Cancelled",resume=projection.status==="PAUSED"?"resume":"restore the preserved work",intro=`${state} by ${actor}${reason?` — ${reason}`:""}. Post \`/factory retry\` to ${resume}.`;const preserved=projection.status==="PAUSED"&&request?.payload.kind==="request"&&request.payload.owner==="human"?`\n\n**Preserved request after resuming**\n\n${humanRequestAction(store,request)}`:"";return box(`${intro}${command("/factory retry [--issue] [--for <roles>] [guidance]")}\nOptional guidance stays active for the current SPEC by default.${preserved}`);}
 if(projection.status==="FAILED"){const failure=new WorkflowFailures(store).active(workItemId),intro=failure?.class==="environment"?"A required capability was unavailable. Fix the blocker described below, or state in retry guidance which available equivalent is acceptable.":failure?.class==="invalid-result"?`The agent's structured response contradicted the workflow contract: ${sanitizeFailureEvidence(failure.message,280)}. Correct that requirement, then retry the saved stage.`:"Resolve the reported cause, then retry this stage.";return box(`${intro}${command("/factory retry [--issue] [--for <roles>] [guidance]")}\n\nOptional guidance stays active for the current SPEC by default and appears above with its id.`);}
 if(request?.payload.kind==="request"&&request.payload.owner==="human") {
  return box(humanRequestAction(store,request));
 }
 if(request?.payload.kind==="request"&&request.payload.owner==="architect")return box(`Architect is next. No human action is required. You can still pause or cancel the workflow.${command("/factory pause [reason]")}${command("/factory cancel [reason]")}`);
 if(projection.status==="COMPLETED")return box("Delivery is complete. No further factory action is required.");
 return box(`${projection.status==="RUNNING"?"The current agent is running":"The next agent is queued"}. No human action is required. You can pause or cancel the workflow.${command("/factory pause [reason]")}${command("/factory cancel [reason]")}`);
}

function requestLabel(request:ReturnType<WorkflowRecords["activeRequest"]>) {
 if(!request||request.payload.kind!=="request")return "";
 if(request.payload.type==="clarification")return "Waiting for your answer";
 if(request.payload.type==="spec-approval")return `Waiting for approval of the SPEC v${request.specVersion} brief`;
 if(request.payload.type==="tactical-decision")return "Architect is deciding";
 if(request.payload.type==="correction-limit")return "Waiting for your correction guidance";
 return "Waiting for merge";
}

export function workflowStatusMarkdown(store:Store,workItemId:string) {
 const item=store.db.prepare("SELECT issue_number,context FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;context:string}|undefined;
 if(!item)throw new Error("Unknown work item");
 const context=JSON.parse(item.context||"{}") as {title?:string;pr?:string;observedComments?:Array<{id:number;updatedAt:string}>;lastCommand?:LastCommandOutcome;continuedFrom?:{instance:string;revision:number}};
 const projection=new WorkflowProjections(store).get(workItemId),records=new WorkflowRecords(store),request=records.activeRequest(workItemId),failure=new WorkflowFailures(store).active(workItemId);
 const spec=(store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number|null}).version??0;
 const actor=request?.payload.kind==="request"?(request.payload.owner==="human"?"Human":"Architect"):["FAILED","PAUSED","CANCELLED"].includes(projection.status)?"Human":projection.status==="RUNNING"||projection.status==="QUEUED"?stageActors[projection.stage]:"None";
 const rows=[["Stage",stages[projection.stage]],["Status",statuses[projection.status]],["Current actor",actor],["Instance",config.instanceName],["SPEC version",spec?`v${spec}`:"Not proposed"],["Attempt",String(projection.attempt)]];
 if(request?.payload.kind==="request")rows.push(["Open request",requestLabel(request)]);
 if(failure)rows.push(["Failure",publishedText(sanitizeFailureEvidence(failure.message,240))]);
 if(context.pr)rows.push(["Pull request",context.pr]);
 if(context.continuedFrom)rows.push(["Continuity",`Continued from ${context.continuedFrom.instance} at revision ${context.continuedFrom.revision}`]);
 if(context.observedComments?.length)rows.push(["Approver comments since last command",`${context.observedComments.length} — use \`/factory note\` to make guidance actionable`]);
 if(context.lastCommand){const last=context.lastCommand,reason=last.outcome==="deferred"?"waiting for the interrupted execution to exit":last.reason;rows.push(["Last command",`\`${last.kind}\` by @${last.login} — ${last.outcome}${reason?`: ${reason}`:""}`]);}
 const allHumanGuidance=records.humanGuidance(workItemId,false),ordinals=new Map(allHumanGuidance.map((record,index)=>[record.id,index+1])),humanGuidance=allHumanGuidance.filter(record=>record.status==="active");
 const guidance=humanGuidance.length?`\n\n### Active human guidance\n\n${humanGuidance.map(record=>`- **#${ordinals.get(record.id)}** · \`${record.id.slice(0,8)}\` — ${record.payload.kind==="instruction"?record.payload.text:record.payload.kind==="decision"?record.payload.decision:""}`).join("\n")}${humanGuidance.length>3?`\n\nConsider \`/factory replace\` or \`/factory revoke\` to keep guidance current.`:""}`:"";
 const transitions=(store.db.prepare("SELECT ts,payload FROM events WHERE work_item_id=? AND type='workflow.transition' AND json_extract(payload,'$.to.status')!='RUNNING' ORDER BY id DESC LIMIT 10").all(workItemId) as Array<{ts:string;payload:string}>).map(row=>{const event=JSON.parse(row.payload) as {to:{stage:string;status:string};reason:{summary:string}};return `- ${utcMinute(row.ts)} — ${stages[event.to.stage as keyof typeof stages]}/${statuses[event.to.status as keyof typeof statuses]}: ${publishedText(event.reason.summary)}`;});
 const history=transitions.length?`\n\n<details><summary>Last ${transitions.length} workflow transitions</summary>\n\n${transitions.join("\n")}\n\n</details>`:"";
 const failureDetails=failure?`\n\n${workflowFailureEvidence(store,failure,publishedText)}`:"";
 const latest=store.db.prepare(projection.status==="FAILED"?"SELECT payload,run_id FROM events WHERE work_item_id=? AND type='agent.result' ORDER BY id DESC LIMIT 1":"SELECT payload,run_id FROM events WHERE work_item_id=? AND type='agent.result' AND (json_extract(payload,'$.role')!='product-architect' OR json_extract(payload,'$.result.outcome')='resolved') ORDER BY id DESC LIMIT 1").get(workItemId) as {payload:string;run_id:string}|undefined;
 let latestSummary="";if(latest)try{const payload=JSON.parse(latest.payload) as {role:"product-architect"|"developer"|"qa"|"reviewer";result:{summary:string}},summary=clipSummary(publishedText(payload.result.summary)),heading=projection.status==="FAILED"?"Last agent report":"Latest delivery summary";latestSummary=`\n\n### ${heading}\n\n**${roleShortName(payload.role)}:** ${summary.text}${summary.clipped?`\n\nSummary clipped. Open execution \`${latest.run_id}\` in the dashboard for the full result.`:""}`;}catch{}
 const help=`\n\n<details><summary>All commands</summary>\n\n${factoryCommandReference}\n\n</details>`;
 return `# ${context.title??`Issue #${item.issue_number}`}\n\n${nextAction(store,workItemId)}\n\n| Detail | Value |\n| --- | --- |\n${rows.map(([name,value])=>`| ${name} | ${String(value).replaceAll("|","\\|")} |`).join("\n")}${guidance}${latestSummary}${failureDetails}${history}${help}`;
}

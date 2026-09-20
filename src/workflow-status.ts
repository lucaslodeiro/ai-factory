import type { Store } from "./storage.js";
import { WorkflowFailures } from "./workflow-failures.js";
import { WorkflowProjections } from "./workflow-projection.js";
import { WorkflowRecords } from "./workflow-records.js";
import { sanitizeFailureEvidence,workflowFailureEvidence } from "./failure-report.js";
import { roleShortName } from "./names.js";
import type { LastCommandOutcome } from "./workflow-inbox.js";
import { factoryCommandReference } from "./factory-help.js";

const stages={DESIGN:"Design",BUILD:"Build",TEST:"Test",REVIEW:"Review",DELIVERY:"Delivery"} as const;
const stageActors={DESIGN:"Architect",BUILD:"Builder",TEST:"Tester",REVIEW:"Reviewer",DELIVERY:"None"} as const;
const statuses={QUEUED:"Queued",RUNNING:"Running",WAITING:"Waiting for you",FAILED:"Failed",PAUSED:"Paused",CANCELLED:"Cancelled",COMPLETED:"Completed"} as const;
const palette={DESIGN:["5319e7","Architect is designing the specification"],BUILD:["1d76db","Builder is implementing the approved specification"],TEST:["fbca04","Tester is verifying the implementation"],REVIEW:["006b75","Reviewer is inspecting delivery evidence"],DELIVERY:["0e8a16","Delivery is awaiting or recording merge"],done:["0e8a16","Factory delivery completed"],WAITING:["d4c5f9","Human action is required"],FAILED:["b60205","Factory execution failed"],PAUSED:["c5def5","Factory workflow is paused"],CANCELLED:["6a737d","Factory workflow was cancelled"]} as const;
const box=(body:string)=>`## Next action\n\n> ${body.replaceAll("\n","\n> ")}`;
const command=(value:string)=>`\n\n\`\`\`text\n${value}\n\`\`\``;
const clipSummary=(value:string,max=1450)=>value.length<=max?{text:value,clipped:false}:{text:`${value.slice(0,max-1).trimEnd()}…`,clipped:true};

export function workflowLabels(store:Store,workItemId:string) {
 const p=new WorkflowProjections(store).get(workItemId);
 if(p.status==="COMPLETED")return [{name:"factory:done",color:palette.done[0],description:palette.done[1]}];
 const stage=palette[p.stage],result:Array<{name:string;color:string;description:string}>=[{name:`factory:${p.stage.toLowerCase()}`,color:stage[0],description:stage[1]}];
 if(["WAITING","FAILED","PAUSED","CANCELLED"].includes(p.status)){const condition=palette[p.status as "WAITING"|"FAILED"|"PAUSED"|"CANCELLED"];result.push({name:`factory:${p.status.toLowerCase()}`,color:condition[0],description:condition[1]});}
 return result;
}

function nextAction(store:Store,workItemId:string) {
 const projection=new WorkflowProjections(store).get(workItemId),request=new WorkflowRecords(store).activeRequest(workItemId);
 if(request?.payload.kind==="request"&&request.payload.owner==="human") {
  if(request.payload.type==="spec-approval")return box(`Review the proposed specification and post one new comment.\n\n**Approve**${command(`/factory approve v${request.specVersion} [guidance]`)}\nOptional guidance becomes a spec-scoped instruction.\n\n**Request changes**${command("/factory answer <feedback>")}\nFeedback becomes a human decision for Architect.`);
  if(request.payload.type==="merge")return box(`Review and merge the pull request in GitHub when it is ready, or request changes.\n\n**Merge** in GitHub.\n\n**Request changes**${command("/factory answer <changes>")}\nThe text becomes a human auto-fix finding for Builder.`);
  return box(`Reply with the guidance Architect needs.${command("/factory answer <guidance>")}\nThe text becomes a human decision for Architect.`);
 }
 if(request?.payload.kind==="request"&&request.payload.owner==="architect")return box(`Architect is next. No human action is required. You can still pause or cancel the workflow.${command("/factory pause [reason]")}${command("/factory cancel [reason]")}`);
 if(projection.status==="FAILED")return box(`Resolve the reported cause, then retry this stage.${command("/factory retry [--issue] [--for <roles>] [guidance]")}\n\nOptional guidance stays active for the current SPEC by default and appears above with its id.`);
 if(["PAUSED","CANCELLED"].includes(projection.status))return box(`Resume the preserved work when ready.${command("/factory retry [--issue] [--for <roles>] [guidance]")}\n\nOptional guidance stays active for the current SPEC by default and appears above with its id.`);
 if(projection.status==="COMPLETED")return box("Delivery is complete. No further factory action is required.");
 return box(`${projection.status==="RUNNING"?"The current agent is running":"The next agent is queued"}. No human action is required. You can pause or cancel the workflow.${command("/factory pause [reason]")}${command("/factory cancel [reason]")}`);
}

export function workflowStatusMarkdown(store:Store,workItemId:string) {
 const item=store.db.prepare("SELECT issue_number,context FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;context:string}|undefined;
 if(!item)throw new Error("Unknown work item");
 const context=JSON.parse(item.context||"{}") as {title?:string;pr?:string;observedApproverComments?:number;lastCommand?:LastCommandOutcome};
 const projection=new WorkflowProjections(store).get(workItemId),records=new WorkflowRecords(store),request=records.activeRequest(workItemId),failure=new WorkflowFailures(store).active(workItemId);
 const spec=(store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number|null}).version??0;
 const actor=request?.payload.kind==="request"?(request.payload.owner==="human"?"Human":"Architect"):projection.status==="RUNNING"||projection.status==="QUEUED"?stageActors[projection.stage]:"None";
 const rows=[["Stage",stages[projection.stage]],["Status",statuses[projection.status]],["Current actor",actor],["SPEC version",spec?`v${spec}`:"Not proposed"],["Attempt",String(projection.attempt)]];
 if(request?.payload.kind==="request")rows.push(["Open request",request.payload.type]);
 if(failure)rows.push(["Failure",sanitizeFailureEvidence(failure.message,240)]);
 if(context.pr)rows.push(["Pull request",context.pr]);
 if(context.observedApproverComments)rows.push(["Approver comments since last command",`${context.observedApproverComments} — use \`/factory note\` to make guidance actionable`]);
 if(context.lastCommand){const last=context.lastCommand,reason=last.outcome==="deferred"?"waiting for the interrupted execution to exit":last.reason;rows.push(["Last command",`\`${last.kind}\` by @${last.login} — ${last.outcome}${reason?`: ${reason}`:""}`]);}
 const allHumanGuidance=records.humanGuidance(workItemId,false),ordinals=new Map(allHumanGuidance.map((record,index)=>[record.id,index+1])),humanGuidance=allHumanGuidance.filter(record=>record.status==="active");
 const guidance=humanGuidance.length?`\n\n### Active human guidance\n\n${humanGuidance.map(record=>`- **#${ordinals.get(record.id)}** · \`${record.id.slice(0,8)}\` — ${record.payload.kind==="instruction"?record.payload.text:record.payload.kind==="decision"?record.payload.decision:""}`).join("\n")}${humanGuidance.length>3?`\n\nConsider \`/factory replace\` or \`/factory revoke\` to keep guidance current.`:""}`:"";
 const transitions=(store.db.prepare("SELECT ts,payload FROM events WHERE work_item_id=? AND type='workflow.transition' ORDER BY id DESC LIMIT 10").all(workItemId) as Array<{ts:string;payload:string}>).map(row=>{const event=JSON.parse(row.payload) as {to:{stage:string;status:string};reason:{summary:string}};return `- ${row.ts} — ${event.to.stage}/${event.to.status}: ${event.reason.summary}`;});
 const history=transitions.length?`\n\n<details><summary>Last ${transitions.length} workflow transitions</summary>\n\n${transitions.join("\n")}\n\n</details>`:"";
 const failureDetails=failure?`\n\n${workflowFailureEvidence(store,failure)}`:"";
 const latest=store.db.prepare("SELECT payload,run_id FROM events WHERE work_item_id=? AND type='agent.result' AND json_extract(payload,'$.role')!='product-architect' ORDER BY id DESC LIMIT 1").get(workItemId) as {payload:string;run_id:string}|undefined;
 let latestSummary="";if(latest)try{const payload=JSON.parse(latest.payload) as {role:"developer"|"qa"|"reviewer";result:{summary:string}},summary=clipSummary(payload.result.summary);latestSummary=`\n\n### Latest delivery summary\n\n**${roleShortName(payload.role)}:** ${summary.text}${summary.clipped?`\n\nSummary clipped. Open execution \`${latest.run_id}\` in the dashboard for the full result.`:""}`;}catch{}
 const help=`\n\n<details><summary>All commands</summary>\n\n${factoryCommandReference}\n\n</details>`;
 return `# ${context.title??`Issue #${item.issue_number}`}\n\n| Detail | Value |\n| --- | --- |\n${rows.map(([name,value])=>`| ${name} | ${String(value).replaceAll("|","\\|")} |`).join("\n")}${guidance}${latestSummary}${failureDetails}${history}\n\n${nextAction(store,workItemId)}${help}`;
}

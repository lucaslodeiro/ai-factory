import type { Store } from "./storage.js";
import { WorkflowFailures } from "./workflow-failures.js";
import { WorkflowProjections } from "./workflow-projection.js";
import { WorkflowRecords } from "./workflow-records.js";

const stages={DESIGN:"Design",BUILD:"Build",TEST:"Test",REVIEW:"Review",DELIVERY:"Delivery"} as const;
const statuses={QUEUED:"Queued",RUNNING:"Running",WAITING:"Waiting for you",FAILED:"Failed",PAUSED:"Paused",CANCELLED:"Cancelled",COMPLETED:"Completed"} as const;
const palette={DESIGN:["5319e7","Architect is designing the specification"],BUILD:["1d76db","Builder is implementing the approved specification"],TEST:["fbca04","Tester is verifying the implementation"],REVIEW:["006b75","Reviewer is inspecting delivery evidence"],DELIVERY:["0e8a16","Delivery is awaiting or recording merge"],done:["0e8a16","Factory delivery completed"],WAITING:["d4c5f9","Human action is required"],FAILED:["b60205","Factory execution failed"],PAUSED:["c5def5","Factory workflow is paused"],CANCELLED:["6a737d","Factory workflow was cancelled"]} as const;
const box=(body:string)=>`## Next action\n\n> ${body.replaceAll("\n","\n> ")}`;
const command=(value:string)=>`\n\n\`\`\`text\n${value}\n\`\`\``;

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
  if(request.payload.type==="spec-approval")return box(`Review the proposed specification and post one new comment.\n\n**Approve**${command(`/factory approve v${request.specVersion}`)}\n\n**Request changes**${command("/factory answer <feedback>")}`);
  if(request.payload.type==="merge")return box("Review and merge the pull request in GitHub when it is ready.");
  return box(`Reply with the guidance Architect needs.${command("/factory answer <guidance>")}`);
 }
 if(request?.payload.kind==="request"&&request.payload.owner==="architect")return box("Architect is next. No human action is required.");
 if(projection.status==="FAILED")return box(`Resolve the reported cause, then retry this stage.${command("/factory retry")}`);
 if(["PAUSED","CANCELLED"].includes(projection.status))return box(`Resume the preserved work when ready.${command("/factory retry")}`);
 if(projection.status==="COMPLETED")return box("Delivery is complete. No further factory action is required.");
 return box(`${projection.status==="RUNNING"?"The current agent is running":"The next agent is queued"}. No human action is required.`);
}

export function workflowStatusMarkdown(store:Store,workItemId:string) {
 const item=store.db.prepare("SELECT issue_number,context FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;context:string}|undefined;
 if(!item)throw new Error("Unknown work item");
 const context=JSON.parse(item.context||"{}") as {title?:string;pr?:string};
 const projection=new WorkflowProjections(store).get(workItemId),records=new WorkflowRecords(store),request=records.activeRequest(workItemId),failure=new WorkflowFailures(store).active(workItemId);
 const spec=(store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number|null}).version??0;
 const actor=request?.payload.kind==="request"?(request.payload.owner==="human"?"Human":"Architect"):projection.status==="RUNNING"?stages[projection.stage]:projection.status==="QUEUED"?stages[projection.stage]:"None";
 const rows=[["Stage",stages[projection.stage]],["Status",statuses[projection.status]],["Current actor",actor],["SPEC version",spec?`v${spec}`:"Not proposed"],["Attempt",String(projection.attempt)]];
 if(request?.payload.kind==="request")rows.push(["Open request",request.payload.type]);
 if(failure)rows.push(["Failure",failure.message]);
 if(context.pr)rows.push(["Pull request",context.pr]);
 const byId=new Map(["product-architect","developer","qa","reviewer"].flatMap(role=>records.active(workItemId,spec,role as "product-architect"|"developer"|"qa"|"reviewer")).filter(record=>record.payload.kind==="instruction").map(record=>[record.id,record]));
 const instructions=[...byId.values()].sort((a,b)=>a.sequence-b.sequence);
 const guidance=instructions.length?`\n\n### Active human instructions\n\n${instructions.map(record=>`- \`${record.id.slice(0,8)}\` — ${record.payload.kind==="instruction"?record.payload.text:""}`).join("\n")}${instructions.length>3?`\n\nConsider \`/factory replace\` or \`/factory revoke\` to keep guidance current.`:""}`:"";
 const transitions=(store.db.prepare("SELECT ts,payload FROM events WHERE work_item_id=? AND type='workflow.transition' ORDER BY id DESC LIMIT 10").all(workItemId) as Array<{ts:string;payload:string}>).map(row=>{const event=JSON.parse(row.payload) as {to:{stage:string;status:string};reason:{summary:string}};return `- ${row.ts} — ${event.to.stage}/${event.to.status}: ${event.reason.summary}`;});
 const history=transitions.length?`\n\n<details><summary>Last ${transitions.length} workflow transitions</summary>\n\n${transitions.join("\n")}\n\n</details>`:"";
 return `# ${context.title??`Issue #${item.issue_number}`}\n\n| Detail | Value |\n| --- | --- |\n${rows.map(([name,value])=>`| ${name} | ${String(value).replaceAll("|","\\|")} |`).join("\n")}${guidance}${history}\n\n${nextAction(store,workItemId)}`;
}

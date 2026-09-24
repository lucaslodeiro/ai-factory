import {roleShortName} from "./names.js";
import type {AgentRole} from "./types.js";

function subject(role?:AgentRole){return role?`${roleShortName(role)} execution`:"The agent execution";}

/** A short, operator-facing explanation for a final execution state. */
export function executionOutcomeText(status?:string,reason?:string,role?:AgentRole){
 const execution=subject(role);
 if(status==="timed_out")return `${execution} exceeded its time limit. The Factory stopped the process before it completed.`;
 if(reason==="token-budget-limit")return `${execution} reached 125% of the issue's token budget. The Factory stopped it and preserved its work.`;
 if(reason==="unexpected-shutdown")return `The Factory stopped unexpectedly while ${execution.toLowerCase()} was running. Retry to continue from preserved work.`;
 if(reason==="host-interrupted")return `The machine interrupted ${execution.toLowerCase()}. Retry to continue from preserved work.`;
 if(status==="cancelled"||reason==="user-cancel")return `${execution} was cancelled by a user.`;
 if(status==="interrupted")return `${execution} was interrupted before it completed.`;
 return undefined;
}

export function workflowExecutionSummary(summary:string,stage?:string){
 const match=/^Execution [0-9a-f-]+ (timed_out|cancelled|interrupted)$/i.exec(summary);
 if(!match)return summary;
 const role=({DESIGN:"product-architect",BUILD:"developer",TEST:"qa",REVIEW:"reviewer"} as Record<string,AgentRole>)[stage??""];
 return executionOutcomeText(match[1].toLowerCase(),undefined,role)??summary;
}

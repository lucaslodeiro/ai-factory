import path from "node:path";
import {config} from "./config.js";
import type {Store} from "./storage.js";
import {WorkflowFailures,type FailureClass} from "./workflow-failures.js";
import {failureDiagnosis,failureLogTail,sanitizeFailureEvidence} from "./failure-report.js";

// Evidence analysis only: no shell commands, network probes, mutations or retries.
export function diagnoseOperation(operation:string,message:string,stderr="",kind?:FailureClass,run?:{status:string;exit_code:number|null}) {
 const evidence=sanitizeFailureEvidence(message,4000),tail=sanitizeFailureEvidence(stderr,4000);
 const analysis=failureDiagnosis(evidence,tail,run,kind);
 const section=(label:string)=>analysis.match(new RegExp(`\\*\\*${label}:\\*\\* ([\\s\\S]*?)(?=\\n\\n\\*\\*|$)`))?.[1]??"Unavailable";
 return {operation:sanitizeFailureEvidence(operation,120),generatedAt:new Date().toISOString(),summary:section("Summary"),evidence:section("Evidence"),nextAction:section("Recommended action"),limitations:"Analysis of recorded evidence only. No live connectivity, permissions or remote branch checks were performed. No settings, files or workflow state were changed.",technical:[evidence,tail].filter(Boolean).join("\n\n")};
}
export function diagnoseWorkItem(store:Store,id:string) {
 const item=store.db.prepare("SELECT status,stage,active_failure_id,issue_number FROM work_items WHERE id=?").get(id) as {status:string;stage:string;active_failure_id:string|null;issue_number:number}|undefined;
 if(!item)throw Object.assign(new Error("Unknown work item"),{statusCode:404});
 const failure=item.active_failure_id?new WorkflowFailures(store).get(item.active_failure_id):undefined;
 if(item.status!=="FAILED"||!failure||failure.resolvedAt||failure.workItemId!==id)throw Object.assign(new Error("This issue no longer has an active failure. Refresh its current state."),{statusCode:409});
 const run=failure.executionId?store.db.prepare("SELECT id,status,exit_code FROM executions WHERE id=? AND work_item_id=?").get(failure.executionId,id) as {id:string;status:string;exit_code:number|null}|undefined:undefined;
 const stderr=run&&/^[a-zA-Z0-9_-]+$/.test(run.id)?failureLogTail(path.join(config.dataDir,"runs",run.id,"stderr.log"),25):"";
 return {...diagnoseOperation(`Issue #${item.issue_number} · ${failure.stage}`,failure.message,stderr,failure.class,run),failureId:failure.id,failedAt:failure.createdAt,attempt:failure.attempt,resume:failure.stage==="DELIVERY"?"Retry resumes Delivery using the completed review. It attempts branch publication and pull request creation; it does not rerun Build, Test or Review.":`Retry resumes the saved ${failure.stage} stage. Review the cause and preserved work before retrying.`};
}

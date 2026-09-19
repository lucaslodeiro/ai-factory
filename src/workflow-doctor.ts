import type { Store } from "./storage.js";
import { WorkflowFailures } from "./workflow-failures.js";
import { WorkflowRecords } from "./workflow-records.js";

type Row={id:string;stage:string|null;status:string|null;active_run_id:string|null;active_request_id:string|null;active_failure_id:string|null};

export function workflowProjectionProblems(store:Store) {
  const records=new WorkflowRecords(store),failures=new WorkflowFailures(store),problems:string[]=[];
  const foreignKeys=store.db.prepare("PRAGMA foreign_key_check").all() as Array<{table:string;rowid:number}>;
  for (const violation of foreignKeys) problems.push(`foreign key violation in ${violation.table} row ${violation.rowid}`);
  const rows=store.db.prepare("SELECT id,stage,status,active_run_id,active_request_id,active_failure_id FROM work_items").all() as Row[];
  for (const row of rows) {
    const label=`work item ${row.id}`;
    if (!row.stage || !row.status) { problems.push(`${label}: stage and status must be initialized together`);continue; }
    try {
      const request=records.activeRequest(row.id),failure=failures.active(row.id);
      if ((request?.id??null)!==row.active_request_id) problems.push(`${label}: activeRequestId does not match the deepest open request`);
      if ((failure?.id??null)!==row.active_failure_id) problems.push(`${label}: activeFailureId does not match the unresolved failure`);
      const owner=request?.payload.kind === "request" ? request.payload.owner : undefined;
      if (row.status === "WAITING" && owner !== "human") problems.push(`${label}: WAITING requires a human-owned active request`);
      if (owner === "human" && !["WAITING","PAUSED"].includes(row.status)) problems.push(`${label}: a human-owned request must be waiting or paused`);
      if (row.status === "FAILED" && !failure) problems.push(`${label}: FAILED requires an unresolved failure`);
      if (failure && !["FAILED","PAUSED"].includes(row.status)) problems.push(`${label}: an unresolved failure must be failed or paused`);
      if ((row.status === "RUNNING") !== Boolean(row.active_run_id)) problems.push(`${label}: RUNNING must match an active run id`);
      if (row.active_run_id) {
        const run=store.db.prepare("SELECT status FROM executions WHERE id=? AND work_item_id=?").get(row.active_run_id,row.id) as {status:string}|undefined;
        if (!run || run.status !== "running") problems.push(`${label}: activeRunId does not identify a running execution`);
      }
    } catch (error) { problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return problems;
}

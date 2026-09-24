import { config } from "./config.js";
import type { Store } from "./storage.js";
import type { AgentRole } from "./types.js";
import { WorkflowProjections } from "./workflow-projection.js";
import { WorkflowRecords } from "./workflow-records.js";
import {reportedTokens,type TokenUsage} from "./token-usage.js";

// The issue budget counts the tokens each provider's CLI reported, cache reads and writes included
// and unweighted, across every stage, retry and correction. It is checked before a run starts and
// gives an active execution the configured grace period:
// the run in progress finishes and its result is kept, so the budget can be exceeded by at most one
// run. A run that finished without reported usage is not counted as zero; the issue waits until an
// approver acknowledges it, unless its role is listed as unmetered.

export interface BudgetEntry { executionId:string; role:string; tokens:number|null; partial:boolean }
export type BudgetBlock = "exhausted" | "unknown";
export interface BudgetState {
 limit:number; extended:number; granted:number; consumed:number; remaining:number; percent:number;
 runs:number; partialRuns:number; unknownRuns:string[]; unacknowledgedRuns:string[]; block:BudgetBlock|null;
}
export interface BudgetSettings { issueBudgetTokens:number; budgetUnmeteredRoles:AgentRole[] }
export const budgetWarningThresholds = [60,80] as const;
export const budgetGracePercent=config.tokenBudgetGracePercent;
export function liveBudget(granted:number,completed:number,running:number|null){
 if(running===null)return{consumed:null,percent:null,alert:false,stop:false};
 const consumed=completed+running,percent=granted>0?Math.floor(consumed*100/granted):100;
 return{consumed,percent,alert:consumed>=granted,stop:consumed>=Math.ceil(granted*(100+budgetGracePercent)/100)};
}

const tokens = (value:unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function validBudgetEntry(value:unknown):value is BudgetEntry {
 if (!value || typeof value !== "object" || Array.isArray(value)) return false;
 const entry=value as Record<string,unknown>;
 return Object.keys(entry).every(key=>["executionId","role","tokens","partial"].includes(key)) && typeof entry.executionId === "string" && typeof entry.role === "string" &&
  (entry.tokens === null || tokens(entry.tokens) !== null) && typeof entry.partial === "boolean";
}

// Local executions plus the ledger carried from the installation this issue was continued from.
// Entries are keyed by execution id, so an issue that returns to an installation is not counted twice.
export function budgetLedger(store:Store,workItemId:string):BudgetEntry[] {
 const row=store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string}|undefined;
 if (!row) throw new Error("Unknown work item");
 const carried=(JSON.parse(row.context||"{}") as {budgetUsage?:unknown}).budgetUsage;
 const ledger=new Map<string,BudgetEntry>();
 for (const entry of Array.isArray(carried) ? carried : []) if (validBudgetEntry(entry)) ledger.set(entry.executionId,entry);
 const partial=new Set((store.db.prepare("SELECT run_id FROM events WHERE work_item_id=? AND type='execution.finished' AND json_extract(payload,'$.usage.partial')=1").all(workItemId) as Array<{run_id:string}>).map(item=>item.run_id));
 for (const run of store.db.prepare("SELECT id,role,total_tokens FROM executions WHERE work_item_id=? AND status<>'running' ORDER BY started_at").all(workItemId) as Array<{id:string;role:string;total_tokens:number|null}>){
  const event=store.db.prepare("SELECT payload FROM events WHERE run_id=? AND type='execution.finished' ORDER BY id DESC LIMIT 1").get(run.id) as {payload:string}|undefined;
  const start=store.db.prepare("SELECT payload FROM events WHERE run_id=? AND type='execution.started' ORDER BY id LIMIT 1").get(run.id) as {payload:string}|undefined;
  const provider=start?(JSON.parse(start.payload) as {selection?:{provider?:string}}).selection?.provider:undefined;
  const usage=event?(JSON.parse(event.payload) as {usage?:Partial<TokenUsage>}).usage:undefined;
  ledger.set(run.id,{executionId:run.id,role:run.role,tokens:provider==="cursor"?reportedTokens(usage,"cursor"):reportedTokens(usage,provider as "claude"|"codex"|undefined)??tokens(run.total_tokens),partial:partial.has(run.id)});
 }
 return [...ledger.values()];
}

// An epic and its stories share one budget: splitting an issue must not multiply what it may
// spend. The family is the epic plus every story planned under it, and an extension granted on any
// of their issues counts for all of them.
export function budgetFamily(store:Store,workItemId:string):string[] {
 const row=store.db.prepare("SELECT epic_work_item_id FROM work_items WHERE id=?").get(workItemId) as {epic_work_item_id:string|null}|undefined;
 if (!row) throw new Error("Unknown work item");
 const owner=row.epic_work_item_id ?? workItemId;
 return [owner,...(store.db.prepare("SELECT id FROM work_items WHERE epic_work_item_id=? ORDER BY created_at").all(owner) as Array<{id:string}>).map(item=>item.id)];
}

export const humanStops=["interrupted-for-guidance","user-pause","user-cancel"];
// A provider that went silent is stopped and retried by the Factory itself; holding the retry for a
// person to accept the silent run's unknown usage would turn an automatic recovery into a wait.
export const acknowledgedStops=[...humanStops,"provider-stalled"];

export function budgetState(store:Store,workItemId:string,settings:BudgetSettings=config):BudgetState {
 const family=budgetFamily(store,workItemId),ledger=family.flatMap(member=>budgetLedger(store,member));
 const grants=(store.db.prepare(`SELECT payload FROM records WHERE work_item_id IN (${family.map(()=>"?").join(",")}) AND kind='budget' AND status='active' ORDER BY sequence`).all(...family) as Array<{payload:string}>)
  .map(row=>JSON.parse(row.payload) as {tokens?:unknown;acknowledges?:unknown});
 const extended=grants.reduce((total,grant)=>total+(tokens(grant.tokens) ?? 0),0);
 const acknowledged=new Set(grants.flatMap(grant=>Array.isArray(grant.acknowledges) ? grant.acknowledges.filter((id):id is string=>typeof id === "string") : []));
 // A run a person stopped (pause, cancel, or interrupt with guidance) is acknowledged by that
 // decision: asking the same person to confirm afterwards that its cost is unknown adds a stop to
 // the workflow and no information. Its usage, when the stream reported some, still counts.
 for (const row of store.db.prepare(`SELECT id FROM executions WHERE work_item_id IN (${family.map(()=>"?").join(",")}) AND interruption_reason IN (${acknowledgedStops.map(()=>"?").join(",")})`).all(...family,...acknowledgedStops) as Array<{id:string}>) acknowledged.add(row.id);
 const consumed=ledger.reduce((total,entry)=>total+(entry.tokens ?? 0),0),granted=settings.issueBudgetTokens+extended;
 const unknownRuns=ledger.filter(entry=>entry.tokens === null).map(entry=>entry.executionId);
 const unacknowledgedRuns=ledger.filter(entry=>entry.tokens === null && !acknowledged.has(entry.executionId) && !settings.budgetUnmeteredRoles.includes(entry.role as AgentRole)).map(entry=>entry.executionId);
 return {limit:settings.issueBudgetTokens,extended,granted,consumed,remaining:Math.max(0,granted-consumed),percent:granted ? Math.floor(consumed*100/granted) : 100,
  runs:ledger.length,partialRuns:ledger.filter(entry=>entry.partial).length,unknownRuns,unacknowledgedRuns,
  block:consumed >= granted ? "exhausted" : unacknowledgedRuns.length ? "unknown" : null};
}

export const formatTokens = (value:number) => value.toLocaleString("en-US");

export function budgetSummary(state:BudgetState) {
 const base=`${state.percent}% · ${formatTokens(state.consumed)} of ${formatTokens(state.granted)} tokens`;
 const unknown=state.unknownRuns.length ? ` · ${state.unknownRuns.length} run${state.unknownRuns.length === 1 ? "" : "s"} without reported usage` : "";
 const partial=state.partialRuns ? ` · ${state.partialRuns} partially reported` : "";
 return `${base}${unknown}${partial}`;
}

export function budgetHoldSummary(state:BudgetState) {
 return state.block === "exhausted"
  ? `Token budget reached: ${formatTokens(state.consumed)} of ${formatTokens(state.granted)} tokens consumed`
  : `${state.unacknowledgedRuns.length} run${state.unacknowledgedRuns.length === 1 ? "" : "s"} finished without reported token usage`;
}

// A queued item that cannot start waits for an approver instead of failing: nothing broke, and the
// work already done is kept. The request extends an Architect consultation rather than replacing it.
export function holdForBudget(store:Store,workItemId:string,state:BudgetState) {
 if (!state.block) throw new Error("The issue budget does not block this work item");
 const projections=new WorkflowProjections(store),records=new WorkflowRecords(store),current=projections.get(workItemId);
 if (current.status !== "QUEUED") throw new Error(`Cannot hold work for budget while it is ${current.status}`);
 const active=records.activeRequest(workItemId),row=store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string};
 const cursor=(JSON.parse(row.context||"{}") as {cursor?:number}).cursor ?? 0,specVersion=(store.db.prepare("SELECT COALESCE(MAX(version),0) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number}).version;
 const ids:string[]=[];
 return projections.transition({workItemId,expectedRevision:current.revision,stage:current.stage,status:"WAITING",actor:{type:"orchestrator",id:"budget"},source:{},
  reason:{code:`budget-${state.block}`,summary:budgetHoldSummary(state)},recordIds:ids},()=>{
  ids.push(records.create({workItemId,specVersion,scope:"issue",parentId:active?.id,payload:{kind:"request",type:"budget",owner:"human",originatingStage:current.stage,
   allowedReturnStages:[current.stage],openedAfterCommentId:cursor,budget:state.block!},sourceType:"orchestrator",sourceId:`budget:${current.revision}`,actor:"orchestrator"}).id);
 });
}

// Each threshold is announced once for the budget currently granted; an extension re-arms them.
export function announceBudgetWarnings(store:Store,workItemId:string,settings:BudgetSettings=config) {
 const state=budgetState(store,workItemId,settings);
 const row=store.db.prepare("SELECT context FROM work_items WHERE id=?").get(workItemId) as {context:string};
 const context=JSON.parse(row.context||"{}") as Record<string,unknown>,previous=context.budgetWarned as {granted?:number;thresholds?:number[]}|undefined;
 const announced=previous?.granted === state.granted ? previous.thresholds ?? [] : [];
 const crossed=budgetWarningThresholds.filter(threshold=>state.percent >= threshold && state.percent < 100 && !announced.includes(threshold));
 if (!crossed.length) return [];
 const threshold=Math.max(...crossed),projections=new WorkflowProjections(store),current=projections.get(workItemId);
 projections.present({workItemId,expectedRevision:current.revision,actor:{type:"orchestrator",id:"budget"},source:{},reason:{code:"budget-warning",summary:`Token budget at ${state.percent}%`}},()=>{
  store.db.prepare("UPDATE work_items SET context=? WHERE id=?").run(JSON.stringify({...context,budgetWarned:{granted:state.granted,thresholds:[...announced,...crossed]}}),workItemId);
  store.event("budget.warning",{threshold,percent:state.percent,consumed:state.consumed,granted:state.granted},workItemId);
  store.db.prepare("INSERT INTO notifications(body,work_item_id) VALUES(?,?)").run(budgetWarningText(store,workItemId,state),workItemId);
 });
 return crossed;
}

function budgetWarningText(store:Store,workItemId:string,state:BudgetState) {
 const row=store.db.prepare("SELECT issue_number,repo,context FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;repo:string;context:string};
 const context=JSON.parse(row.context||"{}") as {title?:string;url?:string},issue=context.url||`https://github.com/${row.repo}/issues/${row.issue_number}`;
 return [`⚠️ Token budget at ${state.percent}%`,`*${(context.title ?? `Issue #${row.issue_number}`).replace(/[<>&]/g,"")}*`,`*Consumed:* ${budgetSummary(state)}`,
  `*Next action:* No action is required yet. The issue pauses when the budget is reached; an approver can extend it with \`/factory budget +<tokens>\`.`,`<${issue}|Open issue #${row.issue_number} in GitHub>`].join("\n\n");
}

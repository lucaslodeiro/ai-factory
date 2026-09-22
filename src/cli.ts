#!/usr/bin/env node
import {startupExitCode} from "./startup-error.js";
import { config } from "./config.js";
import { selectModel, modelPolicyVersion } from "./model-policy.js";
import type { AgentRole } from "./types.js";
import { roleShortName, roleStageName, stateName } from "./names.js";
import { Command } from "commander";
import { doctor } from "./doctor.js";
import { Store } from "./storage.js";
import { SlackAdapter } from "./adapters/slack.js";
import { startDaemon, acquireLock } from "./daemon.js";
import { startDashboard } from "./dashboard.js";
import {GitHubAdapter} from "./adapters/github.js";
import {Workspaces} from "./worktrees.js";
import {WorkflowRunner} from "./workflow-runner.js";
import {WorkflowOrchestrator} from "./workflow-orchestrator.js";
import {WorkflowRecords} from "./workflow-records.js";
import type {TaskAssessment} from "./types.js";
import {RepositoryMaintenance} from "./repository-maintenance.js";
import {verifyRepositoryIdentity} from "./repository-identity.js";
import {readIssueState} from "./workflow-github.js";
import {activityRow,summarizeActivity} from "./execution-activity.js";
import {buildBenchmarkReport,compareBenchmarks,comparable,type BenchmarkReport,type ExecutionSample,type Verification} from "./benchmark.js";
import {spawnSync as spawnVerifier} from "node:child_process";
import {fileURLToPath} from "node:url";
import fs from "node:fs";
const p = new Command().name("factory").description("Local AI Software Factory").version("0.2.0");
p.command("models").argument("[id]").description("Show model policy or preview role selections for a work item").action(id => {
 console.log(`Model policy: ${modelPolicyVersion}`);
 if (!id) { console.table(Object.entries(config.roles).map(([role, routing]) => ({ stage:roleStageName(role),agent:roleShortName(role),provider:routing.provider,model:routing.model }))); return; }
 const s = new Store();
 try {
  const row=s.db.prepare("SELECT correction_cycles FROM work_items WHERE id=?").get(id) as {correction_cycles:number}|undefined;if(!row)throw new Error("Unknown work item");const spec=s.db.prepare("SELECT assessment FROM specs WHERE work_item_id=? ORDER BY version DESC LIMIT 1").get(id) as {assessment:string|null}|undefined,assessment=spec?.assessment?JSON.parse(spec.assessment) as TaskAssessment:undefined,active=new WorkflowRecords(s).activeRequest(id),consultation=active?.payload.kind==="request"&&active.payload.owner==="architect";
  console.table((["product-architect", "developer", "qa", "reviewer"] as AgentRole[]).map(role => ({ stage:roleStageName(role),agent:roleShortName(role), ...selectModel(role,assessment,row.correction_cycles,consultation) })));
 } finally { s.db.close(); }
});
p.command("sync").description("Reconcile PR lifecycle and publish pending status/reports without running agents").action(async () => {
 const s = new Store(); try { const release = acquireLock(s); try { const github=new GitHubAdapter();verifyRepositoryIdentity(s,github);const runner=new WorkflowRunner(s,{},new Workspaces(),github),o=new WorkflowOrchestrator(s,github,runner,new SlackAdapter());await o.reconcilePullRequests();await o.flush(); } finally { release(); } } finally { s.db.close(); }
});
p.command("doctor").action(() => { process.exitCode = doctor() ? 0 : 1; });
p.command("status").argument("[id]").action(id => {
 const store = new Store();
 const items=(store.db.prepare(`SELECT id,issue_number,stage,status,attempt,revision,context FROM work_items ${id?"WHERE id=?":""} ORDER BY created_at`).all(...(id?[id]:[])) as any[]).map(row=>{const context=JSON.parse(row.context||"{}");return{id:row.id,issue:row.issue_number,stage:stateName(row.stage),status:stateName(row.status),attempt:row.attempt,revision:row.revision,spec:(store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(row.id) as any).version,pr:context.pr};});console.table(items);
 const runs = store.db.prepare("SELECT id,work_item_id,role,status,pid,recovery_pending FROM executions ORDER BY started_at DESC LIMIT 20").all() as Array<Record<string,unknown> & { role:string }>;
 console.table(runs.map(run => ({...run,role:roleShortName(run.role)}))); store.db.close();
});
for (const name of ["cancel", "retry"] as const) p.command(name).argument("<id>").description(`${name} a work item`).action(id => {
 const store = new Store(); store.request(name, id); store.db.close(); console.log(`${name} queued; processed by factory start.`);
});
p.command("refresh-list").description("Reconcile GitHub issues and evaluate only each issue's newest comment").action(() => {
 const store = new Store(); store.request("refresh-list"); store.db.close(); console.log("Issue-list refresh queued; processed by factory start.");
});
p.command("start-issue").argument("<number-or-url>").description("Assign an open GitHub issue to this Factory instance").action(reference => {
 const store=new Store(); store.request("start-issue",reference); store.db.close(); console.log(`Issue ${reference} queued for assignment to this Factory instance.`);
});
const issueCommand=p.command("issue").description("Inspect published Factory issue state");
issueCommand.command("show").argument("<number>").description("Show the state index carried by a GitHub issue").action(async raw=>{const number=Number.parseInt(raw,10);if(!Number.isSafeInteger(number)||number<1)throw new Error("Issue number must be a positive integer");const state=await readIssueState(new GitHubAdapter(),number);if(!state)throw new Error(`Issue #${number} does not carry a readable Factory state`);console.log(JSON.stringify(state.index,null,2));});
p.command("stop").option("--pause-active","Pause active tasks before stopping").action(options => { const s = new Store();const count=(s.db.prepare("SELECT COUNT(*) count FROM work_items WHERE status IN ('QUEUED','RUNNING')").get() as {count:number}).count;if(count&&!options.pauseActive){s.db.close();throw new Error(`${count} active task${count===1?"":"s"}; rerun with --pause-active to preserve and pause them`);}s.request("stop");s.db.close();console.log("Stop queued."); });
p.command("events").argument("[id]").action(id => {
 const s = new Store(); console.table(id ? s.db.prepare("SELECT * FROM events WHERE work_item_id=? ORDER BY id DESC LIMIT 50").all(id) : s.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 50").all()); s.db.close();
});
p.command("activity").argument("[id]").description("Per-role provider activity and cache split for one work item, or the most recent runs").action(id => {
 const s = new Store();
 try {
  const rows=(s.db.prepare(`SELECT e.payload payload, x.role role, x.stage stage, x.started_at startedAt
    FROM events e JOIN executions x ON x.id=e.run_id
    WHERE e.type='execution.finished'${id?" AND e.work_item_id=?":""} ORDER BY e.id DESC LIMIT 200`)
    .all(...(id?[id]:[])) as Array<{payload:string;role:string;stage:string|null;startedAt:string|null}>)
    .map(row=>{ let payload:unknown; try{payload=JSON.parse(row.payload);}catch{payload={};} return activityRow(payload,row.role,row.stage,row.startedAt); });
  if (!rows.length) { console.log(id?`No finished executions recorded for ${id}`:"No finished executions recorded"); return; }
  console.table(summarizeActivity(rows));
  console.log("events: JSON objects the provider wrote to stdout. A streaming provider reports many; a provider that returns one result envelope reports one.");
  console.log("Builder receives a repository map and Tester does not, so compare their events per run on the same work item.");
 } finally { s.db.close(); }
});
p.command("benchmark").argument("<id>").option("--save <file>","Write this run as a baseline")
 .option("--baseline <file>","Compare this run against a saved baseline").option("--role <role>","Role to compare, or ALL")
 .option("--verify <checkout>","Independently check the produced code against the benchmark issue")
 .description("Measure one benchmark run: tokens, cache, turns, cost, duration, transitions and health")
 .action((id:string,options:{save?:string;baseline?:string;role?:string;verify?:string}) => {
 const s = new Store();
 try {
  const item=s.db.prepare("SELECT issue_number,stage,status,attempt,correction_cycles FROM work_items WHERE id=?").get(id) as
   {issue_number:number;stage:string|null;status:string|null;attempt:number;correction_cycles:number}|undefined;
  if (!item) { console.log(`Unknown work item ${id}`); process.exitCode=1; return; }
  const finished=new Map<string,{usage:Record<string,unknown>;activity:Record<string,unknown>}>();
  for (const row of s.db.prepare("SELECT run_id,payload FROM events WHERE work_item_id=? AND type='execution.finished'").all(id) as Array<{run_id:string;payload:string}>) {
   try { const payload=JSON.parse(row.payload); finished.set(row.run_id,{usage:payload.usage ?? {},activity:payload.activity ?? {}}); } catch {}
  }
  const number=(value:unknown)=>typeof value === "number" && Number.isFinite(value) ? value : null;
  const executions=(s.db.prepare("SELECT id,role,stage,status,started_at,finished_at,prompt_bytes FROM executions WHERE work_item_id=? ORDER BY started_at").all(id) as
   Array<{id:string;role:string;stage:string|null;status:string;started_at:string|null;finished_at:string|null;prompt_bytes:number|null}>).map<ExecutionSample>(row=>{
    const extra=finished.get(row.id),usage=extra?.usage ?? {},activity=extra?.activity ?? {};
    return {role:row.role,stage:row.stage,status:row.status,startedAt:row.started_at,finishedAt:row.finished_at,promptBytes:row.prompt_bytes,
     inputTokens:number(usage.inputTokens),outputTokens:number(usage.outputTokens),cacheReadTokens:number(usage.cacheReadTokens),
     cacheWriteTokens:number(usage.cacheWriteTokens),totalTokens:number(usage.totalTokens),turns:number(activity.turns),events:number(activity.events),
     eventTypes:(activity.eventTypes && typeof activity.eventTypes === "object" ? activity.eventTypes : {}) as Record<string,number>,
     costUsd:number(activity.costUsd),durationMs:number(activity.durationMs)};
   });
  const transitions=(s.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='workflow.transition' ORDER BY id").all(id) as Array<{payload:string}>)
   .map(row=>{ try { const payload=JSON.parse(row.payload); return {from:`${payload.from?.stage}/${payload.from?.status}`,to:`${payload.to?.stage}/${payload.to?.status}`,reason:payload.reason?.code ?? null}; } catch { return null; } })
   .filter((value):value is {from:string;to:string;reason:string|null}=>value!==null);
  const outcomes=(s.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='agent.result' ORDER BY id").all(id) as Array<{payload:string}>)
   .map(row=>{ try { const payload=JSON.parse(row.payload); return {role:String(payload.role),outcome:String(payload.result?.outcome)}; } catch { return null; } })
   .filter((value):value is {role:string;outcome:string}=>value!==null);
  const eventCounts=Object.fromEntries((s.db.prepare("SELECT type,COUNT(*) n FROM events WHERE work_item_id=? GROUP BY type").all(id) as Array<{type:string;n:number}>).map(row=>[row.type,row.n]));
  const specVersions=((s.db.prepare("SELECT COUNT(*) n FROM specs WHERE work_item_id=?").get(id) as {n:number}).n);
  let verification:Verification|null=null;
  if (options.verify) {
   const script=fileURLToPath(new URL("../scripts/benchmark-verify.mjs",import.meta.url));
   const run=spawnVerifier(process.execPath,["--import","tsx",script,options.verify],{encoding:"utf8",timeout:120000,maxBuffer:10_000_000});
   try { verification=JSON.parse(run.stdout) as Verification; }
   catch { verification={resolved:false,module:null,failures:null,checks:[],error:run.stderr?.trim() || run.error?.message || "The verifier produced no result"}; }
  }
  const report=buildBenchmarkReport({workItemId:id,issueNumber:item.issue_number,stage:item.stage,status:item.status,
   attempt:item.attempt,correctionCycles:item.correction_cycles,specVersions,executions,transitions,outcomes,eventCounts,verification});

  console.log(`Issue #${report.issueNumber} · ${report.stage}/${report.status} · attempt ${report.attempt} · correction cycles ${report.correctionCycles} · SPEC versions ${report.specVersions}`);
  console.table(report.roles);
  console.table([report.totals]);
  console.log(`Transitions (${report.transitions.count}): ${report.transitions.path.join(" -> ")}`);
  console.log(`Reasons: ${Object.entries(report.transitions.reasons).map(([reason,count])=>`${reason}:${count}`).join(" ") || "none"}`);
  console.log(`Health: ${Object.entries(report.health).map(([key,value])=>`${key}:${value}`).join(" ")}`);
  if (report.verification) {
   const check=report.verification;
   console.log(`Resolved: ${check.resolved?"yes":"no"}${check.module?` · ${check.module}`:""}${check.failures!==null?` · ${check.failures} failed check(s)`:""}${check.error?` · ${check.error}`:""}`);
   for (const failed of check.checks.filter(entry=>!entry.passed).slice(0,5)) {
    console.log(`  behaviour ${failed.behaviour}: ${JSON.stringify(failed.input)} -> ${JSON.stringify(failed.actual)}, expected ${JSON.stringify(failed.expected)}`);
   }
  } else { console.log("Resolved: not checked. Pass --verify <checkout> so the cost is a measurement of doing the work."); }
  if (options.baseline) {
   const previous=JSON.parse(fs.readFileSync(options.baseline,"utf8")) as BenchmarkReport;
   const blocked=comparable(previous,report);
   if (blocked) { console.log(`\nNot compared. ${blocked}`); process.exitCode=1; }
   else {
   console.log(`\nAgainst ${options.baseline}, role ${options.role ?? "ALL"}:`);
   console.table(compareBenchmarks(previous,report,options.role ?? "ALL"));
   console.log("A metric missing on either side compares as null: it was never measured, so it is not an improvement.");
   }
  }
  if (options.save) { fs.writeFileSync(options.save,JSON.stringify(report,null,2)); console.log(`\nBaseline written to ${options.save}`); }
 } finally { s.db.close(); }
});
p.command("notifications").action(() => {
 const s = new Store(); console.table(s.db.prepare("SELECT id,sent,attempts,next_at,last_error FROM notifications ORDER BY id DESC LIMIT 50").all()); s.db.close();
});
p.command("slack-test").description("Send one explicit test notification to the configured Slack webhook").action(async () => {
 await new SlackAdapter().notify("🧪 AI Factory connection test\n\nSlack test notification from the CLI was delivered successfully. No action is required. Workflow decisions remain in GitHub."); console.log("Slack test delivered.");
});
p.command("start").action(async () => { const s = new Store(); try { await startDaemon(s); } finally { s.db.close(); } });
p.command("dashboard").description("Start the local administration dashboard").action(async () => {
 const s = new Store();
 try {
  const server = await startDashboard(s);
  await new Promise<void>((resolve, reject) => { server.once("close",resolve); server.once("error",reject); });
 } finally { s.db.close(); }
});
const repo=p.command("repo").description("Inspect and recover the configured target repository");
repo.command("check").description("Read-only repository and remote diagnostic").action(()=>{const s=new Store();try{console.log(JSON.stringify(new RepositoryMaintenance(s).check(),null,2));}finally{s.db.close();}});
repo.command("sync").description("Fetch and fast-forward a clean default branch").action(()=>{const s=new Store();try{console.log(JSON.stringify(new RepositoryMaintenance(s).sync(),null,2));}finally{s.db.close();}});
repo.command("publish").argument("<work-item-id>").description("Commit and push one factory branch").action(id=>{const s=new Store();try{console.log(JSON.stringify(new RepositoryMaintenance(s).publish(id),null,2));}finally{s.db.close();}});
repo.command("clear").requiredOption("--confirm <absolute-path>").requiredOption("--repeat <absolute-path>").description("Remove all contents of the configured local checkout").action(options=>{const s=new Store();try{console.log(JSON.stringify(new RepositoryMaintenance(s).clear(options.confirm,options.repeat),null,2));}finally{s.db.close();}});
repo.command("restore").description("Clone the configured repository into an empty checkout directory").action(()=>{const s=new Store();try{console.log(JSON.stringify(new RepositoryMaintenance(s).restore(),null,2));}finally{s.db.close();}});
try { await p.parseAsync(); } catch (e) { console.error(String(e)); process.exitCode = startupExitCode(e); }

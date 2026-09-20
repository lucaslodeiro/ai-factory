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
import {ControllerLease,formatControllerStatus} from "./controller-lease.js";
import {verifyRepositoryIdentity} from "./repository-identity.js";
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
 const s = new Store(); try { const release = acquireLock(s); try { const github=new GitHubAdapter(),o=new WorkflowOrchestrator(s,github,new WorkflowRunner(s,{},new Workspaces(),github),new SlackAdapter());o.reconcilePullRequests();await o.flush(); } finally { release(); } } finally { s.db.close(); }
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
p.command("start-issue").argument("<number-or-url>").description("Start an open GitHub issue in the factory").action(reference => {
 const store=new Store(); store.request("start-issue",reference); store.db.close(); console.log(`Issue ${reference} queued for factory start.`);
});
p.command("stop").option("--pause-active","Pause active tasks before stopping").action(options => { const s = new Store();const count=(s.db.prepare("SELECT COUNT(*) count FROM work_items WHERE status IN ('QUEUED','RUNNING')").get() as {count:number}).count;if(count&&!options.pauseActive){s.db.close();throw new Error(`${count} active task${count===1?"":"s"}; rerun with --pause-active to preserve and pause them`);}s.request("stop");s.db.close();console.log("Stop queued."); });
p.command("events").argument("[id]").action(id => {
 const s = new Store(); console.table(id ? s.db.prepare("SELECT * FROM events WHERE work_item_id=? ORDER BY id DESC LIMIT 50").all(id) : s.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 50").all()); s.db.close();
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
const controller=p.command("controller").description("Inspect repository controller ownership");
controller.command("status").description("Read the remote repository controller lease").action(()=>{const s=new Store();try{if(!config.repo)throw new Error("Configure GITHUB_REPOSITORY first");const repository=verifyRepositoryIdentity(s,new GitHubAdapter());console.log(formatControllerStatus(new ControllerLease(repository,s).readLease(),repository.fullName));}finally{s.db.close();}});
try { await p.parseAsync(); } catch (e) { console.error(String(e)); process.exitCode = startupExitCode(e); }

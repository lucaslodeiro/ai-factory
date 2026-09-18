#!/usr/bin/env node
import { config } from "./config.js";
import { modelForWork, modelPolicyVersion } from "./model-policy.js";
import type { AgentRole } from "./types.js";
import { Orchestrator } from "./orchestrator.js";
import { Command } from "commander";
import { doctor } from "./doctor.js";
import { Store } from "./storage.js";
import { SlackAdapter } from "./adapters/slack.js";
import { startDaemon, acquireLock } from "./daemon.js";
import { startDashboard } from "./dashboard.js";
const p = new Command().name("factory").description("Local AI Software Factory").version("0.1.0");
p.command("models").argument("[id]").description("Show model policy or preview role selections for a work item").action(id => {
 console.log(`Model policy: ${modelPolicyVersion}`);
 if (!id) { console.table(Object.entries(config.roles).map(([role, routing]) => ({ role,provider:routing.provider,model:routing.model }))); return; }
 const s = new Store();
 try {
  const w = s.get(id); if (!w) throw new Error("Unknown work item");
  console.table((["product-architect", "developer", "qa", "reviewer"] as AgentRole[]).map(role => ({ role, ...modelForWork(w, role) })));
 } finally { s.db.close(); }
});
p.command("sync").description("Reconcile PR lifecycle and publish pending status/reports without running agents").action(async () => {
 const s = new Store(); try { const release = acquireLock(s); try { const o = new Orchestrator(s, {}); await o.reconcilePullRequests(); await o.flush(); } finally { release(); } } finally { s.db.close(); }
});
p.command("doctor").action(() => { process.exitCode = doctor() ? 0 : 1; });
p.command("status").argument("[id]").action(id => {
 const store = new Store();
 console.table(store.items().filter(w => !id || w.id === id).map(w => ({ id: w.id, issue: w.issue_number, state: w.state, resume: w.context.resume, interruptedStage: w.context.pendingStage?.stage, spec: w.context.version, pr: w.context.pr })));
 console.table(store.db.prepare("SELECT id,work_item_id,role,status,pid,recovery_pending FROM executions ORDER BY started_at DESC LIMIT 20").all()); store.db.close();
});
for (const name of ["cancel", "retry"] as const) p.command(name).argument("<id>").action(id => {
 const store = new Store(); store.request(name, id); store.db.close(); console.log(`${name} queued; processed by factory start.`);
});
p.command("stop").action(() => { const s = new Store(); s.request("stop"); s.db.close(); console.log("Stop queued."); });
p.command("events").argument("[id]").action(id => {
 const s = new Store(); console.table(id ? s.db.prepare("SELECT * FROM events WHERE work_item_id=? ORDER BY id DESC LIMIT 50").all(id) : s.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 50").all()); s.db.close();
});
p.command("notifications").action(() => {
 const s = new Store(); console.table(s.db.prepare("SELECT id,sent,attempts,next_at,last_error FROM notifications ORDER BY id DESC LIMIT 50").all()); s.db.close();
});
p.command("slack-test").description("Send one explicit test notification to the configured Slack webhook").action(async () => {
 await new SlackAdapter().notify("AI Factory: Slack test notification. Workflow decisions remain in GitHub."); console.log("Slack test delivered.");
});
p.command("start").action(async () => { const s = new Store(); try { await startDaemon(s); } finally { s.db.close(); } });
p.command("dashboard").description("Start the local administration dashboard").action(async () => {
 const s = new Store();
 try {
  const server = await startDashboard(s);
  await new Promise<void>((resolve, reject) => { server.once("close",resolve); server.once("error",reject); });
 } finally { s.db.close(); }
});
try { await p.parseAsync(); } catch (e) { console.error(String(e)); process.exitCode = 1; }

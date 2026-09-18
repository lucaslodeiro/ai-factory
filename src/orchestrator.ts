import { randomUUID } from "node:crypto";
import { Store } from "./storage.js";
import { config } from "./config.js";
import { GitHubAdapter, type GitHubPort, type Issue, type Comment } from "./adapters/github.js";
import { SlackAdapter } from "./adapters/slack.js";
import type { AgentAdapter } from "./adapters/agent.js";
import { Workspaces, type WorkspacePort } from "./worktrees.js";
import { prompt } from "./prompts.js";
import { deliverNotifications, type NotificationPort } from "./notifications.js";
import { parseResult, validateCoverage } from "./results.js";
import type { WorkItem, WorkState, AgentRole, AgentResult, DeliveryStage } from "./types.js";
export class Orchestrator {
 constructor(readonly store: Store, private agents: Record<AgentRole, AgentAdapter>,
  private github: GitHubPort = new GitHubAdapter(), private workspaces: WorkspacePort = new Workspaces(),
  private slack: NotificationPort = new SlackAdapter()) {}
 async tick() {
  try { for (const issue of this.github.listQueued()) this.ingest(issue); }
  catch (e) { this.store.event("github.poll_failed", { error: String(e) }); }
  await this.flush();
  for (const snapshot of this.store.items()) {
   const w = this.store.get(snapshot.id)!;
   if (w.repo !== config.repo) throw new Error("Data directory belongs to a different repository");
   if (["FAILED", "CANCELLED", "PAUSED", "READY_TO_MERGE"].includes(w.state)) continue;
   try { await this.advance(w); }
   catch (e) {
    // A control command may have changed the item while its child process was running.
    const current = this.store.get(w.id)!;
    if (!["PAUSED", "CANCELLED"].includes(current.state)) {
     current.context.resume = current.state;
     this.store.db.transaction(() => {
      this.store.transition(current, "FAILED"); this.store.post(w.issue_number, `Execution failed: ${String(e)}. Inspect logs, then use factory retry ${w.id}.`);
     })();
    }
    this.store.event("workflow.error", { error: String(e) }, w.id);
   }
   await this.flush();
  }
 }
 private ingest(issue: Issue) {
  if (this.store.items().some(w => w.repo === config.repo && w.issue_number === issue.number)) return;
  const id = randomUUID(), now = new Date().toISOString();
  const context = { title: issue.title, body: issue.body, url: issue.url, version: 0, cursor: 0, feedback: [], cycles: 0, reports: {} };
  this.store.db.transaction(() => {
   this.store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,branch,created_at,updated_at,context) VALUES(?,?,?,?,?,?,?,?)")
    .run(id, issue.number, config.repo, "SPEC", `factory/issue-${issue.number}-${id.slice(0, 8)}`, now, now, JSON.stringify(context));
   this.store.event("work_item.created", { issue }, id);
   this.store.notify(this.store.get(id)!);
   this.store.post(issue.number, `AI Factory started. Work item: ${id}`);
  })();
 }
 async flush() {
  const rows = this.store.db.prepare("SELECT * FROM outbox WHERE sent=0 ORDER BY id").all() as { id: number; issue_number: number; body: string }[];
  for (const r of rows) {
   try {
    this.github.commentOnce(r.issue_number, r.body, `${config.repo}:${r.id}`);
    this.store.db.prepare("UPDATE outbox SET sent=1 WHERE id=?").run(r.id);

   } catch (e) { this.store.event("github.delivery_failed", { outboxId: r.id, error: String(e) }); }
  }
  await deliverNotifications(this.store, this.slack);
  for (const w of this.store.items()) {
   try { this.github.syncState(w.issue_number, w.state); }
   catch (e) { this.store.event("github.labels_failed", { error: String(e) }, w.id); }
  }
 }
 private async advance(w: WorkItem) {
  if (!w.context.title) throw new Error("Legacy work item has no context; recreate it in a new data directory");
  if (w.state === "WAITING_HUMAN") { this.human(w); return; }
  if (!w.context.cwd) { w.context.cwd = this.workspaces.ensure(w.id, w.branch); this.store.save(w); }
  const role = ({ SPEC: "product-architect", DEVELOPMENT: "developer", QA: "qa", REVIEW: "reviewer" } as const)[w.state as "SPEC" | "DEVELOPMENT" | "QA" | "REVIEW"];
  if (!role) return;
  if (role !== "product-architect" && (!w.context.approvedVersion || w.context.approvedVersion !== w.context.version)) throw new Error("No approval for current specification");
  this.workspaces.assertBranch(w.context.cwd, w.branch);
  const before = this.workspaces.head(w.context.cwd);
  const instructions = prompt(w, role) + (role === "reviewer" ? "\n\nImplementation diff:\n" + this.workspaces.diff(w.context.cwd) : "");
  w.context.pendingStage = { stage: w.state, beforeHead: before, startedAt: new Date().toISOString() };
  this.store.save(w);
  const result = parseResult(await this.agents[role].run({ workItemId: w.id, role, cwd: w.context.cwd, instructions }), role);
  if (this.store.get(w.id)!.state !== w.state) return;
  if (role !== "product-architect") validateCoverage(result, w.context.criteria ?? []);
  this.workspaces.check(w.context.cwd, role, before, w.branch);
  // Only the orchestrator commits; preserve evidence of all role outputs separately.
  if (role === "developer" || role === "qa") this.workspaces.commit(w.context.cwd, `factory: ${role} for #${w.issue_number}`, w.branch);
  w.context.reports[role] = result;
  this.store.event("agent.result", { role, result, specVersion: w.context.version }, w.id);
  w.context.pendingStage = undefined;
  if (role === "product-architect") {
   if (result.outcome === "resolved") { this.resolveTactical(w, result); return; }
   // Ignore commands posted before this new specification exists.
   w.context.cursor = Math.max(w.context.cursor, ...this.github.comments(w.issue_number).map(c => c.id));
   this.store.db.transaction(() => {
    w.context.approvedVersion = undefined; w.context.approval = undefined; w.context.consultation = undefined;
    if (result.outcome === "questions") {
     w.context.waiting = "questions";
     this.store.post(w.issue_number, `Product/Architect needs input:\n${result.questions.join("\n")}\n\nReply with /factory answer <your answer>.`);
    } else {
     w.context.spec = result.spec; w.context.criteria = result.acceptanceCriteria; w.context.decisions = result.decisions;
     w.context.version++; w.context.waiting = "approval";
     w.context.reports = { "product-architect": result };
     this.store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria) VALUES(?,?,?,?)").run(w.id, w.context.version, result.spec, JSON.stringify(result.acceptanceCriteria));
     this.store.post(w.issue_number, `SPEC v${w.context.version}\n\n${result.spec}\n\nAcceptance criteria:\n${JSON.stringify(result.acceptanceCriteria, null, 2)}\n\nApprove with /factory approve v${w.context.version}, or revise with /factory answer <feedback>.`);
    }
    this.store.transition(w, "WAITING_HUMAN");
   })(); return;
  }
  const decision = result.outcome === "decision" || result.findings.some(f => f.classification === "decision-required");
  const changes = result.outcome === "changes" || result.findings.some(f => f.classification === "auto-fix");
  if (decision || changes) {
   w.context.feedback.push(`${role}: ${JSON.stringify(result)}`); w.context.cycles++;
   this.store.db.transaction(() => {
    this.store.post(w.issue_number, `${role} report (SPEC v${w.context.version}):\n${JSON.stringify(result, null, 2)}`);
    if (w.context.cycles >= config.maxCycles) {
     w.context.waiting = "loop";
     this.store.post(w.issue_number, "Automatic correction limit reached. Reply /factory answer <guidance> to return to Product/Architect.");
     this.store.transition(w, "WAITING_HUMAN");
    } else if (decision) { w.context.consultation = { from: w.state as DeliveryStage }; this.store.transition(w, "SPEC"); }
    else if (w.state !== "DEVELOPMENT") this.routeDelivery(w, "DEVELOPMENT");
    else this.store.save(w);
   })(); return;
  }
  if (role === "reviewer") {
   if (w.context.reports.developer?.outcome !== "pass" || w.context.reports.qa?.outcome !== "pass") throw new Error("Developer and QA must pass before publication");
   this.workspaces.publish(w.context.cwd, w.branch);
   w.context.pr = this.github.ensurePR(w.branch, `#${w.issue_number}: ${w.context.title}`,
    `Closes #${w.issue_number}\n\nApproved SPEC v${w.context.version} by ${w.context.approval?.login}.\n\n${w.context.spec}\n\n## QA\n${w.context.reports.qa.summary.slice(0, 4000)}\n\n## Review\n${result.summary.slice(0, 4000)}\n\nFull structured reports, evidence, decisions and deferred findings: ${w.context.url}\n\nHuman merge required.`);
  }
  this.store.db.transaction(() => {
   this.store.post(w.issue_number, `${role} report (SPEC v${w.context.version}):\n${JSON.stringify(result, null, 2)}${w.context.pr ? `\nReady for human merge: ${w.context.pr}` : ""}`);
   this.store.transition(w, role === "developer" ? "QA" : role === "qa" ? "REVIEW" : "READY_TO_MERGE");
  })();
 }
 private routeDelivery(w: WorkItem, to: DeliveryStage) {
  // Invalidate downstream evidence whenever implementation or verification reruns.
  if (to === "DEVELOPMENT") delete w.context.reports.developer;
  if (to !== "REVIEW") delete w.context.reports.qa;
  delete w.context.reports.reviewer;
  this.store.transition(w, to);
 }
 private resolveTactical(w: WorkItem, result: AgentResult) {
  const from = w.context.consultation?.from;
  if (!from || !w.context.approvedVersion || w.context.approvedVersion !== w.context.version) throw new Error("Tactical resolution requires an approved-spec consultation");
  const to = ({ developer: "DEVELOPMENT", qa: "QA", reviewer: "REVIEW" } as const)[result.nextRole!];
  const allowed = { DEVELOPMENT: ["DEVELOPMENT"], QA: ["DEVELOPMENT", "QA"], REVIEW: ["DEVELOPMENT", "QA", "REVIEW"] };
  if (!allowed[from].includes(to)) throw new Error("Tactical resolution cannot skip a delivery gate");
  this.store.db.transaction(() => {
   w.context.decisions = [...(w.context.decisions ?? []), ...result.decisions];
   w.context.consultation = undefined;
   this.store.event("decision.tactical", { decisions: result.decisions, from, to, specVersion: w.context.version }, w.id);
   this.store.post(w.issue_number, `Product/Architect resolved a tactical question under SPEC v${w.context.version}:\n${JSON.stringify(result.decisions, null, 2)}\nNext: ${to}. No specification change.`);
   this.routeDelivery(w, to);
  })();
 }
 private human(w: WorkItem) {
  let replies: Comment[];
  try { replies = this.github.comments(w.issue_number); }
  catch (e) {
   // No agent failed: retain the approval gate and retry the remote read next tick.
   this.store.event("github.comments_failed", { error: String(e) }, w.id); return;
  }
  const comments = replies.filter(c => c.id > w.context.cursor).sort((a,b) => a.id-b.id);
  for (const c of comments) {
   w.context.cursor = c.id;
   if (c.user.type !== "User" || !config.approvers.includes(c.user.login)) { this.store.save(w); continue; }
   const body = c.body.trim();
   if (body === `/factory approve v${w.context.version}` && w.context.waiting === "approval" && w.context.spec) {
    w.context.approvedVersion = w.context.version; w.context.approval = { login: c.user.login, commentId: c.id };
    this.store.db.transaction(() => {
     this.store.event("spec.approved", { version: w.context.version, ...w.context.approval }, w.id);
     this.store.transition(w, "DEVELOPMENT");
    })(); return;
   }
   if (body.startsWith("/factory answer ") && body.slice(16).trim()) {
    w.context.feedback.push(`${c.user.login}: ${body.slice(16).trim()}`); w.context.cycles = 0;
    w.context.consultation = undefined;
    this.store.transition(w, "SPEC"); return;
   }
   this.store.save(w);
  }
 }
}

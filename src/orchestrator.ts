import { specMarkdown, reportMarkdown, decisionsMarkdown, progressMarkdown, questionsMarkdown } from "./presentation.js";
import { modelForWork } from "./model-policy.js";
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
function humanAnswer(body: string) {
 const lines = body.trim().split(/\r?\n/);
 const first = lines[0]?.trim();
 const last = lines.at(-1)?.trim();
 if (first === "/factory answer") return lines.slice(1).join("\n").trim();
 if (first?.startsWith("/factory answer ")) return [first.slice(16), ...lines.slice(1)].join("\n").trim();
 if (last === "/factory answer") return lines.slice(0, -1).join("\n").trim();
 return "";
}
export class Orchestrator {
 constructor(readonly store: Store, private agents: Partial<Record<AgentRole, AgentAdapter>>,
  private github: GitHubPort = new GitHubAdapter(), private workspaces: WorkspacePort = new Workspaces(),
  private slack: NotificationPort = new SlackAdapter()) {}
 async tick() {
  try { for (const issue of this.github.listQueued()) this.ingest(issue); }
  catch (e) { this.store.event("github.poll_failed", { error: String(e) }); }
  await this.reconcilePullRequests();
  await this.flush();
  for (const snapshot of this.store.items()) {
   const w = this.store.get(snapshot.id)!;
   if (w.repo !== config.repo) throw new Error("Data directory belongs to a different repository");
   if (["FAILED", "CANCELLED", "PAUSED", "READY_TO_MERGE", "MERGED", "PR_CLOSED"].includes(w.state)) continue;
   try { await this.advance(w); }
   catch (e) {
    // A control command may have changed the item while its child process was running.
    const current = this.store.get(w.id)!;
    if (!["PAUSED", "CANCELLED"].includes(current.state)) {
     current.context.resume = current.state;
     current.context.lastFailure = String(e);
     this.store.db.transaction(() => {
      this.store.transition(current, "FAILED"); this.store.post(w.issue_number, `Execution failed: ${String(e)}. Inspect logs, then use factory retry ${w.id}.`);
     })();
    }
    this.store.event("workflow.error", { error: String(e) }, w.id);
   }
   await this.flush();
  }
 }
 async reconcilePullRequests() {
  for (const w of this.store.items()) {
   if (w.repo !== config.repo || !["READY_TO_MERGE", "PR_CLOSED"].includes(w.state) || !w.context.pr) continue;
   try {
    const pr = this.github.pullRequestState(w.context.pr);
    const next = pr.state === "MERGED" ? "MERGED" : pr.state === "CLOSED" ? "PR_CLOSED" : "READY_TO_MERGE";
    if (next === w.state) continue;
    this.store.db.transaction(() => {
     if (next === "MERGED") w.context.merge = { at: pr.mergedAt!, commit: pr.mergeCommit?.oid ?? null };
     w.context.resume = undefined;
     this.store.transition(w, next);
     this.store.event("pull_request.reconciled", { url: w.context.pr, ...pr }, w.id);
     const message = next === "MERGED" ? `## Delivery merged\n\nGitHub confirmed that [the pull request](${w.context.pr}) was merged. Work is complete.`
      : next === "PR_CLOSED" ? `## Pull request closed without merge\n\n[The pull request](${w.context.pr}) was closed without integrating the changes. This is not completed delivery. Reopen it in GitHub to resume merge tracking.`
      : `## Pull request reopened\n\n[The pull request](${w.context.pr}) is open again and awaits human review/merge.`;
     this.store.post(w.issue_number, message);
    })();
   } catch (e) { this.store.event("github.pr_poll_failed", { error: String(e), url: w.context.pr }, w.id); }
  }
 }
 refreshIssue(id: string) {
  const w = this.store.get(id);
  if (!w) throw new Error("Unknown work item");
  const remote = this.github.issue(w.issue_number);
  const comments = this.github.comments(w.issue_number).slice().sort((a,b) => a.id-b.id);
  return this.refreshKnownIssue(w,remote,comments);
 }
 private refreshKnownIssue(w: WorkItem,remote: Issue,comments: Comment[]) {
  const latest = comments.at(-1);
  const previousCursor = this.store.commentCursorHighWater(w.id,w.context.cursor);
  w.context.title = remote.title;
  w.context.body = remote.body;
  w.context.url = remote.url;
  // WAITING_HUMAN evaluates only the newest comment through the normal command
  // rules. Never move a cursor backwards if a previously observed comment was
  // deleted or omitted by GitHub. Other states only advance to the newest ID.
  const hasNewLatest = Boolean(latest && latest.id > previousCursor);
  w.context.cursor = w.state === "WAITING_HUMAN" && hasNewLatest
   ? Math.max(previousCursor,comments.at(-2)?.id ?? 0)
   : Math.max(previousCursor,latest?.id ?? 0);
  this.store.save(w);
  if (w.state === "WAITING_HUMAN" && hasNewLatest) this.human(w);
  const refreshed = this.store.get(w.id)!;
  this.store.event("github.issue_refreshed",{ previousCursor,cursor:refreshed.context.cursor,latestCommentId:latest?.id ?? null,state:refreshed.state },w.id);
  this.github.syncState(refreshed.issue_number,refreshed.state,progressMarkdown(refreshed));
  return refreshed;
 }
 refreshIssueList() {
  const managed = this.github.listManaged();
  const byNumber = new Map(managed.map(issue => [issue.number,issue]));
  for (const local of this.store.items()) if (local.repo === config.repo && !byNumber.has(local.issue_number)) byNumber.set(local.issue_number,this.github.issue(local.issue_number));
  const issues = [...byNumber.values()];
  let added = 0,updated = 0;
  for (const issue of issues) {
   const existing = this.store.items().find(w => w.repo === config.repo && w.issue_number === issue.number);
   if (!existing) {
    const queued = issue.labels?.some(label => label.name === "factory:queued") ?? false;
    if (queued) {
     this.ingest(issue);
     const created = this.store.items().find(w => w.repo === config.repo && w.issue_number === issue.number)!;
     this.refreshKnownIssue(created,issue,this.github.comments(issue.number).slice().sort((a,b) => a.id-b.id));
    } else this.recoverManagedIssue(issue,this.github.comments(issue.number).slice().sort((a,b) => a.id-b.id));
    added++; continue;
   }
   this.refreshKnownIssue(existing,issue,this.github.comments(issue.number).slice().sort((a,b) => a.id-b.id));
   updated++;
  }
  this.store.event("github.issue_list_refreshed",{ found:issues.length,added,updated });
  return { found:issues.length,added,updated };
 }
 private recoverManagedIssue(issue: Issue,comments: Comment[]) {
  const existingId = comments.flatMap(comment => [...comment.body.matchAll(/Work item:\s*([0-9a-f-]{16,})/gi)].map(match => match[1])).at(0);
  const id = existingId && !this.store.get(existingId) ? existingId : randomUUID();
  const lastAnswer = [...comments].reverse().map(comment => ({ comment,answer:humanAnswer(comment.body) })).find(item => item.answer);
  const remoteLabel = issue.labels?.map(label => label.name).find(name => name.startsWith("factory:") && name !== "factory:queued") ?? "factory:unknown";
  const now = new Date().toISOString();
  const context = {
   title:issue.title,body:issue.body,url:issue.url,version:0,cursor:comments.at(-1)?.id ?? 0,
   feedback:lastAnswer ? [`${lastAnswer.comment.user.login}: ${lastAnswer.answer}`] : [],cycles:0,reports:{},resume:"SPEC" as const,
   lastFailure:`Recovered from GitHub state ${remoteLabel}. Local workflow evidence was unavailable; retry restarts at Product Architect.`,
  };
  this.store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,branch,created_at,updated_at,context) VALUES(?,?,?,?,?,?,?,?)")
   .run(id,issue.number,config.repo,"PAUSED",`factory/issue-${issue.number}-${id.slice(0,8)}`,now,now,JSON.stringify(context));
  this.store.event("work_item.recovered",{ issue,remoteLabel,cursor:context.cursor,resume:"SPEC" },id);
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
  const rows = this.store.db.prepare("SELECT * FROM outbox WHERE sent=0 ORDER BY id").all() as { id: number; issue_number: number; body: string; delivery_key: string | null }[];
  for (const r of rows) {
   try {
    this.github.commentOnce(r.issue_number,r.body,`${config.repo}:${r.delivery_key ?? r.id}`);
    this.store.db.prepare("UPDATE outbox SET sent=1 WHERE id=?").run(r.id);

   } catch (e) { this.store.event("github.delivery_failed", { outboxId: r.id, error: String(e) }); }
  }
  await deliverNotifications(this.store, this.slack);
  for (const w of this.store.items()) {
   try { this.github.syncState(w.issue_number, w.state, progressMarkdown(w)); }
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
  const selection = modelForWork(w, role);
  const instructions = prompt(w, role, selection.provider) + (role === "reviewer" ? "\n\nImplementation diff:\n" + this.workspaces.diff(w.context.cwd) : "");
  w.context.pendingStage = { stage: w.state, beforeHead: before, startedAt: new Date().toISOString() };
  this.store.save(w);
  this.store.event("model.selected", { role, specVersion: w.context.version, selection }, w.id);
  const adapter = this.agents[role];
  if (!adapter) throw new Error(`No adapter configured for ${role}`);
  const result = parseResult(await adapter.run({ workItemId: w.id, role, cwd: w.context.cwd, instructions, selection }), role);
  if (this.store.get(w.id)!.state !== w.state) return;
  if (role !== "product-architect") validateCoverage(result, w.context.criteria ?? []);
  this.workspaces.check(w.context.cwd, role, before, w.branch);
  // Only the orchestrator commits; preserve evidence of all role outputs separately.
  if (role === "developer" || role === "qa") this.workspaces.commit(w.context.cwd, `factory: ${role} for #${w.issue_number}`, w.branch);
  w.context.reports[role] = result;
  this.store.event("agent.result", { role, result, specVersion: w.context.version }, w.id);
  w.context.pendingStage = undefined;
  if (role === "product-architect") {
   if (w.context.architectDraft && result.outcome === "resolved") throw new Error("Architect draft review requires a specification or questions");
   if (result.outcome === "resolved") { this.resolveTactical(w, result); return; }
   if (result.outcome === "spec" && selection.profile !== "strong" &&
       (result.taskAssessment!.complexity === "high" || result.taskAssessment!.risk === "high")) {
    this.store.db.transaction(() => {
     w.context.architectDraft = result;
     w.context.approvedVersion = undefined; w.context.approval = undefined; w.context.consultation = undefined;
     this.store.save(w);
     this.store.event("spec.review_required", { assessment: result.taskAssessment, previousSelection: selection }, w.id);
     this.store.post(w.issue_number, "Product Architect detected high complexity or risk. The draft will receive an additional architectural review before a specification is published for approval.");
    })(); return;
   }
   // Ignore commands posted before this new specification exists.
   w.context.cursor = Math.max(w.context.cursor, ...this.github.comments(w.issue_number).map(c => c.id));
   this.store.db.transaction(() => {
    w.context.approvedVersion = undefined; w.context.approval = undefined; w.context.consultation = undefined;
    if (result.outcome === "questions") {
     w.context.waiting = "questions";
     this.store.post(w.issue_number, questionsMarkdown(result.questions));
    } else {
     w.context.architectDraft = undefined;
     w.context.taskAssessment = result.taskAssessment!;
     w.context.spec = result.spec; w.context.criteria = result.acceptanceCriteria; w.context.decisions = result.decisions;
     w.context.version++; w.context.waiting = "approval";
     w.context.reports = { "product-architect": result };
     this.store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,assessment) VALUES(?,?,?,?,?)").run(w.id, w.context.version, result.spec, JSON.stringify(result.acceptanceCriteria), JSON.stringify(result.taskAssessment));
     this.store.post(w.issue_number, specMarkdown(w.context.version, result));
    }
    this.store.transition(w, "WAITING_HUMAN");
   })(); return;
  }
  const decision = result.outcome === "decision" || result.findings.some(f => f.classification === "decision-required");
  const changes = result.outcome === "changes" || result.findings.some(f => f.classification === "auto-fix");
  if (decision || changes) {
   w.context.feedback.push(`${role}: ${JSON.stringify(result)}`); w.context.cycles++;
   this.store.db.transaction(() => {
    this.store.post(w.issue_number, reportMarkdown(role, w.context.version, result));
    if (w.context.cycles >= config.maxCycles) {
     w.context.waiting = "loop";
     this.store.post(w.issue_number, "Automatic correction limit reached. Reply /factory answer <guidance> to return to Product Architect.");
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
    `Closes #${w.issue_number}\n\nApproved SPEC v${w.context.version} by ${w.context.approval?.login}.\n\n${w.context.spec}\n\n## QA\n${w.context.reports.qa.summary.slice(0, 4000)}\n\n## Review\n${result.summary.slice(0, 4000)}\n\nReports, evidence, decisions and deferred findings: ${w.context.url}\n\nHuman merge required.`);
  }
  this.store.db.transaction(() => {
   this.store.post(w.issue_number, reportMarkdown(role, w.context.version, result, w.context.pr));
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
   this.store.post(w.issue_number, `Product Architect resolved a tactical question under SPEC v${w.context.version}:\n${decisionsMarkdown(result.decisions)}\nNext: ${to}. No specification change.`);
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
   const answer = humanAnswer(body);
   if (answer) {
    w.context.feedback.push(`${c.user.login}: ${answer}`); w.context.cycles = 0;
    w.context.consultation = undefined;
    this.store.transition(w, "SPEC"); return;
   }
   this.store.save(w);
  }
 }
}

import { specMarkdown, reportMarkdown, progressMarkdown, questionsMarkdown, startedMarkdown, recoveredMarkdown, readyToMergeMarkdown, prClosedMarkdown, mergedMarkdown, architecturalReviewMarkdown, correctionLimitMarkdown, retryAcceptedMarkdown, retryRejectedMarkdown, pullRequestReopenedMarkdown, tacticalResolutionMarkdown } from "./presentation.js";
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
import { retry, retryStageLabel } from "./retry.js";
import { failureMarkdown } from "./failure-report.js";
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
  try { this.discoverStartCommands(); }
  catch (e) { this.store.event("github.start_poll_failed", { error: String(e) }); }
  await this.reconcilePullRequests();
  await this.flush();
  for (const snapshot of this.store.items()) {
   const w = this.store.get(snapshot.id)!;
   if (w.repo !== config.repo) throw new Error("Data directory belongs to a different repository");
   if (["FAILED", "CANCELLED", "PAUSED"].includes(w.state)) {
    this.retryFromComment(w);
    await this.flush();
    continue;
   }
   if (w.state !== "WAITING_HUMAN") this.observeComments(w);
   if (["READY_TO_MERGE", "MERGED", "PR_CLOSED"].includes(w.state)) continue;
   try { await this.advance(w); }
   catch (e) {
    // A control command may have changed the item while its child process was running.
    const current = this.store.get(w.id)!;
    if (!["PAUSED", "CANCELLED"].includes(current.state)) {
     current.context.resume = current.state;
     current.context.lastFailure = String(e);
     this.store.db.transaction(() => {
      this.store.transition(current, "FAILED");
      this.store.post(w.issue_number,failureMarkdown(this.store,current,e));
     })();
    }
    this.store.event("workflow.error", { error: String(e) }, w.id);
   }
   await this.flush();
  }
 }
 private discoverStartCommands() {
  if (!this.github.repositoryComments) return;
  const key=`github.start-comments:${config.repo}`;
  const now=Date.now();
  const checkpoint=this.store.metadata<{since:string;id:number}>(key) ?? { since:new Date(now-5*60_000).toISOString(),id:0 };
  const comments=this.github.repositoryComments(checkpoint.since).slice().sort((a,b)=>a.id-b.id);
  let high=checkpoint.id;
  for (const comment of comments) {
   if (comment.id <= checkpoint.id) continue;
   if (comment.body.trim() === "/factory start") {
    const issueNumber=Number(comment.issue_url.split("/").at(-1));
    if (comment.created_at !== comment.updated_at) {
     this.store.event("start.command_rejected",{commentId:comment.id,issueNumber,login:comment.user.login,reason:"Edited comments cannot start work"});
    } else if (comment.user.type !== "User" || !config.approvers.includes(comment.user.login)) {
     this.store.event("start.command_rejected",{commentId:comment.id,issueNumber,login:comment.user.login,reason:"Only configured human approvers may start work"});
    } else if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
     this.store.event("start.command_rejected",{commentId:comment.id,issueUrl:comment.issue_url,login:comment.user.login,reason:"Invalid issue reference"});
    } else {
     try { this.startIssue(String(issueNumber),comment.user.login,{source:"comment",commentId:comment.id,login:comment.user.login}); }
     catch (error) {
      const reason=String(error);
      if (/is closed|is a pull request/.test(reason)) this.store.event("start.command_rejected",{commentId:comment.id,issueNumber,login:comment.user.login,reason});
      else throw error;
     }
    }
   }
   high=Math.max(high,comment.id);
  }
  this.store.setMetadata(key,{since:new Date(now-5000).toISOString(),id:high});
 }
 startIssue(reference: string,requestedBy="Dashboard or CLI",origin?: {source:"comment";commentId:number;login:string}) {
  const number=this.issueNumber(reference);
  const existing=this.store.items().find(w=>w.repo===config.repo&&w.issue_number===number);
  if (existing) {
   this.store.event("start.command_ignored",{issueNumber:number,requestedBy,reason:"Issue is already tracked"},existing.id);
   return {issue:number,id:existing.id,created:false,state:existing.state};
  }
  const issue=this.github.issue(number);
  if (issue.pullRequest) throw new Error(`#${number} is a pull request; start the corresponding issue instead`);
  if (issue.state === "CLOSED") throw new Error(`Issue #${number} is closed`);
  this.ingest(issue,{source:origin?.source ?? "control",requestedBy,commentId:origin?.commentId});
  const created=this.store.items().find(w=>w.repo===config.repo&&w.issue_number===number)!;
  return {issue:number,id:created.id,created:true,state:created.state};
 }
 private issueNumber(reference: string) {
  const value=reference.trim();
  const direct=value.match(/^#?(\d+)$/)?.[1];
  if (direct) return Number(direct);
  const escaped=config.repo.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const url=value.match(new RegExp(`^https://github\\.com/${escaped}/issues/(\\d+)/?(?:[?#].*)?$`,"i"));
  if (url) return Number(url[1]);
  throw new Error(`Use an issue number or a URL from https://github.com/${config.repo}/issues/…`);
 }
 private observeComments(w: WorkItem) {
  try {
   const replies=this.github.comments(w.issue_number).slice().sort((a,b)=>a.id-b.id);
   const cursor=this.store.commentCursorHighWater(w.id,w.context.cursor);
   const comments=replies.filter(comment=>comment.id>cursor),latest=comments.at(-1);
   if (!latest) return;
   w.context.cursor=latest.id; this.store.save(w);
   const humanComments=comments.filter(comment=>comment.user.type === "User").length;
   if (humanComments) this.store.event("github.comments_observed",{previousCursor:cursor,cursor:latest.id,state:w.state,count:humanComments},w.id);
  } catch (e) { this.store.event("github.comments_failed",{error:String(e)},w.id); }
 }
 private retryFromComment(w: WorkItem) {
  let replies: Comment[];
  try { replies = this.github.comments(w.issue_number); }
  catch (e) { this.store.event("github.comments_failed", { error: String(e) }, w.id); return; }
  const cursor = this.store.commentCursorHighWater(w.id,w.context.cursor);
  const comments = replies.filter(c => c.id > cursor).sort((a,b) => a.id-b.id);
  for (const c of comments) if (this.processRetryComment(w,c)) return;
 }
 private processRetryComment(w: WorkItem,c: Comment) {
  w.context.cursor = c.id;
  this.store.save(w);
  if (c.user.type !== "User" || !config.approvers.includes(c.user.login) || c.body.trim() !== "/factory retry") return false;
  try {
   const to = retry(this.store,w.id);
   this.store.event("retry.comment_accepted",{ login:c.user.login,commentId:c.id,to },w.id);
   this.store.post(w.issue_number,retryAcceptedMarkdown(c.user.login,retryStageLabel(to)));
  } catch (e) {
   this.store.event("retry.comment_rejected",{ login:c.user.login,commentId:c.id,error:String(e) },w.id);
   this.store.post(w.issue_number,retryRejectedMarkdown(e));
  }
  return true;
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
     const message = next === "MERGED" ? mergedMarkdown(w)
      : next === "PR_CLOSED" ? prClosedMarkdown(w)
      : pullRequestReopenedMarkdown(w.context.pr!);
     this.store.post(w.issue_number, message);
    })();
   } catch (e) { this.store.event("github.pr_poll_failed", { error: String(e), url: w.context.pr }, w.id); }
  }
 }
 private reconcileKnownIssue(w: WorkItem,remote: Issue) {
  const changedFields=[w.context.title !== remote.title ? "title" : "",w.context.body !== remote.body ? "body" : "",w.context.url !== remote.url ? "url" : ""].filter(Boolean);
  w.context.title = remote.title;
  w.context.body = remote.body;
  w.context.url = remote.url;
  this.store.save(w);
  this.store.event("github.issue_reconciled",{changedFields,state:w.state},w.id);
  return w;
 }
 private refreshLatestComment(w: WorkItem) {
  const comments=this.github.comments(w.issue_number).slice().sort((a,b)=>a.id-b.id);
  const latest=comments.at(-1);
  const previousCursor=this.store.commentCursorHighWater(w.id,w.context.cursor);
  if (latest && latest.id > previousCursor) {
   if (["FAILED","CANCELLED","PAUSED"].includes(w.state)) this.processRetryComment(w,latest);
   else if (w.state === "WAITING_HUMAN") this.processHumanComment(w,latest);
   else { w.context.cursor=latest.id; this.store.save(w); }
  }
  const current=this.store.get(w.id)!;
  const targetCursor=Math.max(previousCursor,latest?.id ?? 0);
  if (current.context.cursor < targetCursor) { current.context.cursor=targetCursor; this.store.save(current); }
  this.store.event("github.issue_refreshed",{
   previousCursor,cursor:current.context.cursor,latestCommentId:latest?.id ?? null,state:current.state,
  },w.id);
  return current;
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
    const recovered=this.recoverManagedIssue(issue,this.github.comments(issue.number).slice().sort((a,b) => a.id-b.id));
    const refreshed=this.refreshLatestComment(recovered);
    this.github.syncState(refreshed.issue_number,refreshed.state,progressMarkdown(refreshed));
    added++; continue;
   }
   this.reconcileKnownIssue(existing,issue);
   const refreshed=this.refreshLatestComment(existing);
   this.github.syncState(refreshed.issue_number,refreshed.state,progressMarkdown(refreshed));
   updated++;
  }
  this.store.event("github.issue_list_refreshed",{ found:issues.length,added,updated });
  return { found:issues.length,added,updated };
 }
 private recoverManagedIssue(issue: Issue,comments: Comment[]) {
  const existingId = comments.flatMap(comment => [...comment.body.matchAll(/Work item(?:\s*:|\s*\|)\s*`?([0-9a-f-]{16,})/gi)].map(match => match[1])).at(0);
  const id = existingId && !this.store.get(existingId) ? existingId : randomUUID();
  const lastAnswer = [...comments].reverse().map(comment => ({ comment,answer:humanAnswer(comment.body) })).find(item => item.answer);
  const remoteLabel = issue.labels?.map(label => label.name).find(name => name.startsWith("factory:")) ?? "factory:unknown";
  const now = new Date().toISOString();
  const context = {
   title:issue.title,body:issue.body,url:issue.url,version:0,cursor:0,
   feedback:lastAnswer ? [`${lastAnswer.comment.user.login}: ${lastAnswer.answer}`] : [],cycles:0,reports:{},resume:"SPEC" as const,
   lastFailure:`Recovered from GitHub state ${remoteLabel}. Local workflow evidence was unavailable; retry restarts at Product Architect.`,
  };
  this.store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,branch,created_at,updated_at,context) VALUES(?,?,?,?,?,?,?,?)")
   .run(id,issue.number,config.repo,"PAUSED",`factory/issue-${issue.number}-${id.slice(0,8)}`,now,now,JSON.stringify(context));
  this.store.event("work_item.recovered",{ issue,remoteLabel,cursor:comments.at(-1)?.id ?? 0,resume:"SPEC" },id);
  const recovered=this.store.get(id)!;
  this.store.post(issue.number,recoveredMarkdown(recovered,remoteLabel,comments.at(-1)?.id ?? null));
  return recovered;
 }
 private ingest(issue: Issue,start: {source:"comment"|"control";requestedBy:string;commentId?:number}) {
  if (this.store.items().some(w => w.repo === config.repo && w.issue_number === issue.number)) return;
  const id = randomUUID(), now = new Date().toISOString();
  const context = { title: issue.title, body: issue.body, url: issue.url, version: 0, cursor: start.commentId ?? 0, feedback: [], cycles: 0, reports: {} };
  this.store.db.transaction(() => {
   this.store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,branch,created_at,updated_at,context) VALUES(?,?,?,?,?,?,?,?)")
    .run(id, issue.number, config.repo, "SPEC", `factory/issue-${issue.number}-${id.slice(0, 8)}`, now, now, JSON.stringify(context));
   this.store.event("work_item.created", { issue:issue.number,source:start.source,requestedBy:start.requestedBy,commentId:start.commentId }, id);
   this.store.notify(this.store.get(id)!);
   this.store.post(issue.number, startedMarkdown(this.store.get(id)!,start.requestedBy,start.source));
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
     this.store.post(w.issue_number,architecturalReviewMarkdown());
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
     this.store.post(w.issue_number,correctionLimitMarkdown());
     this.store.transition(w, "WAITING_HUMAN");
    } else if (decision) { w.context.consultation = { from: w.state as DeliveryStage }; this.store.transition(w, "SPEC"); }
    else if (w.state !== "DEVELOPMENT") this.routeDelivery(w, "DEVELOPMENT");
    else this.store.save(w);
   })(); return;
  }
  let publishedCommit: string | undefined;
  if (role === "reviewer") {
   if (w.context.reports.developer?.outcome !== "pass" || w.context.reports.qa?.outcome !== "pass") throw new Error("Developer and QA must pass before publication");
   this.workspaces.publish(w.context.cwd, w.branch);
   w.context.pr = this.github.ensurePR(w.branch, `#${w.issue_number}: ${w.context.title}`,
    `Closes #${w.issue_number}\n\nApproved SPEC v${w.context.version} by ${w.context.approval?.login}.\n\n${w.context.spec}\n\n## QA\n${w.context.reports.qa.summary.slice(0, 4000)}\n\n## Review\n${result.summary.slice(0, 4000)}\n\nReports, evidence, decisions and deferred findings: ${w.context.url}\n\nHuman merge required.`);
   publishedCommit=this.workspaces.head(w.context.cwd);
  }
  this.store.db.transaction(() => {
   this.store.post(w.issue_number, reportMarkdown(role, w.context.version, result, w.context.pr));
   if (role === "reviewer") this.store.post(w.issue_number,readyToMergeMarkdown(w,publishedCommit!));
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
   this.store.post(w.issue_number,tacticalResolutionMarkdown(w.context.version,result.decisions,to));
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
  for (const c of comments) if (this.processHumanComment(w,c)) return;
 }
 private processHumanComment(w: WorkItem,c: Comment) {
  w.context.cursor = c.id;
  if (c.user.type !== "User" || !config.approvers.includes(c.user.login)) { this.store.save(w); return false; }
  const body = c.body.trim();
  if (body === `/factory approve v${w.context.version}` && w.context.waiting === "approval" && w.context.spec) {
   w.context.approvedVersion = w.context.version; w.context.approval = { login: c.user.login, commentId: c.id };
   this.store.db.transaction(() => {
    this.store.event("spec.approved", { version: w.context.version, ...w.context.approval }, w.id);
    this.store.transition(w, "DEVELOPMENT");
   })(); return true;
  }
  const answer = humanAnswer(body);
  if (answer) {
   w.context.feedback.push(`${c.user.login}: ${answer}`); w.context.cycles = 0;
   w.context.consultation = undefined;
   this.store.transition(w, "SPEC"); return true;
  }
  this.store.save(w);
  return false;
 }
}

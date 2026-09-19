import type { AgentResult, AgentRole, Decision, WorkItem, WorkState } from "./types.js";
export const statePresentation: Record<WorkState, { title: string; color: string; description: string }> = {
 MERGED: { title: "Merged — completed", color: "8250df", description: "GitHub confirmed the pull request was merged" },
 PR_CLOSED: { title: "PR closed without merge", color: "d73a4a", description: "Changes were not integrated; reopen the PR to resume tracking" },
 NEW: { title: "Queued", color: "d4c5f9", description: "Waiting for initial assessment" },
 SPEC: { title: "Designing the specification", color: "5319e7", description: "Product Architect is preparing the work" },
 WAITING_HUMAN: { title: "Waiting for your response", color: "fbca04", description: "Human approval, clarification or guidance required" },
 DEVELOPMENT: { title: "Implementing", color: "1d76db", description: "Developer is implementing the approved specification" },
 QA: { title: "Testing independently", color: "0e8a16", description: "QA is verifying the acceptance criteria" },
 REVIEW: { title: "Reviewing", color: "006b75", description: "Reviewer is inspecting implementation and evidence" },
 READY_TO_MERGE: { title: "Ready for human merge", color: "2cbe4e", description: "Delivery gates passed; review and merge the pull request" },
 FAILED: { title: "Execution needs attention", color: "d73a4a", description: "Inspect the failure and explicitly retry" },
 PAUSED: { title: "Paused", color: "bfbfbf", description: "Execution is paused; explicit retry required" },
 CANCELLED: { title: "Cancelled", color: "e4e669", description: "Execution was cancelled" },
};
const roles: Record<AgentRole, string> = { "product-architect": "Product Architect", developer: "Developer", qa: "QA", reviewer: "Reviewer" };
const stages: Partial<Record<WorkState,string>> = { SPEC:"Product Architect",WAITING_HUMAN:"human input",DEVELOPMENT:"Development",QA:"QA",REVIEW:"Review" };
const stageName = (state?: WorkState) => state ? stages[state] ?? state : "Product Architect";
const clip = (s: string, n = 700) => s.length > n ? s.slice(0, n) + "…" : s;
const cell = (s: string) => clip(s, 350).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "&#124;").replaceAll("\n", "<br>");
function table(headers: string[], rows: string[][]) {
 const shown = rows.slice(0, 20);
 return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...shown.map(row => `| ${row.map(cell).join(" | ")} |`), ...(rows.length > 20 ? [`\nShowing 20 of ${rows.length} entries. Full evidence remains in the local audit log.`] : [])].join("\n");
}
function details(title: string, body: string) { return `<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>`; }
const commandBox = (command: string) => `\`\`\`text\n${command}\n\`\`\``;
const nextAction = (body: string, multiple = false) => `### Next action${multiple ? "s" : ""}\n\n${body}`;
const noAction = (body: string) => nextAction(`> **No action required.** ${body}`);
const retryAction = (prefix = "When the cause is resolved, post a new comment containing exactly:") => nextAction(`${prefix}\n\n${commandBox("/factory retry")}`);
export function decisionsMarkdown(decisions: Decision[]) {
 return table(["Decision", "Rationale", "Type"], decisions.map(d => [d.decision, d.rationale, d.conflictsWithHuman ? "Requires human decision" : d.kind]));
}
function cleanQuestion(value: string) {
 return value
  .replace(/\\n/g, "\n")
  .split(/\r?\n/)
  .map(line => line.replace(/\\+\s*$/, "").trimEnd())
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
}
export function questionsMarkdown(questions: string[]) {
 const sections = questions.map((raw, index) => {
  const question = cleanQuestion(raw);
  const separator = question.indexOf(":");
  const hasTitle = separator > 0 && separator <= 100 && !question.slice(0, separator).includes("\n");
  const title = hasTitle ? question.slice(0, separator).replace(/^#+\s*/, "").trim() : `Question ${index + 1}`;
  const body = hasTitle ? question.slice(separator + 1).trim() : question;
  return `### ${index + 1}. ${title}\n\n${body}`;
 });
 const answerTemplate = questions.map((_, index) => `${index + 1}. <answer ${index + 1}>`).join("\n");
 return `## Product Architect — input needed\n\nThe factory cannot complete the specification until these decisions are provided. It has preserved the current draft and will remain in **Waiting for your response**.\n\n${sections.join("\n\n")}\n\n${nextAction(`Post a **new comment** using this format. Replace each placeholder with your answer; multiline answers are supported.\n\n${commandBox(`/factory answer\n${answerTemplate}`)}\n\nEditing a comment the factory already read will not reactivate the workflow.`)}`;
}
export function specMarkdown(version: number, r: AgentResult) {
 const a = r.taskAssessment!;
 return `## SPEC v${version} — awaiting approval\n\n${r.spec}\n\n### Task assessment\n\n**Complexity:** ${a.complexity} · **Risk:** ${a.risk}\n\n${a.rationale}\n\n${details("Acceptance criteria", table(["ID", "Expected behavior"], r.acceptanceCriteria.map(c => [c.id, c.description])))}\n\n${nextAction(`Choose one option and post it as a **new comment**.\n\n**Approve this specification**\n\n${commandBox(`/factory approve v${version}`)}\n\n**Request changes or add context**\n\n${commandBox("/factory answer <feedback>")}`,true)}`;
}
export function reportMarkdown(role: AgentRole, version: number, r: AgentResult, pr?: string) {
 const outcomes = { pass: "Passed", changes: "Changes required", decision: "Decision required", spec: "Specification proposed", questions: "Questions", resolved: "Resolved" };
 const sections = [`## ${roles[role]} — ${outcomes[r.outcome]}`, `SPEC v${version}`, clip(r.summary, 1800)];
 if (r.findings.length) sections.push("### Findings\n\n" + table(["Action", "Evidence"], r.findings.map(f => [{ "auto-fix": "Fix before proceeding", "decision-required": "Decision needed", defer: "Deferred" }[f.classification], f.evidence])));
 else sections.push("No findings reported.");
 if (r.tests.length) sections.push(details("Verification commands and results", table(["Command", "Exit code", "Evidence"], r.tests.map(t => [t.command, t.exitCode === null ? "Not run" : String(t.exitCode), t.evidence]))));
 if (r.coverage.length) sections.push(details(`Acceptance criteria (${r.coverage.filter(c => c.status === "passed").length}/${r.coverage.length} passed)`, table(["Criterion", "Result", "Evidence"], r.coverage.map(c => [c.criterionId, c.status, c.evidence]))));
 if (r.reviewChecks.length) sections.push(details("Review dimensions", table(["Dimension", "Result", "Evidence"], r.reviewChecks.map(c => [c.dimension, c.status, c.evidence]))));
 if (r.changedFiles.length) sections.push(details("Files reported", r.changedFiles.slice(0, 30).map(f => `- ${cell(f)}`).join("\n")));
 if (r.dependencies.length) sections.push(details("Dependency changes", table(["Dependency", "Change", "Rationale"], r.dependencies.map(d => [d.name, d.change, d.rationale]))));
 if (r.decisions.length) sections.push(details("Decisions", decisionsMarkdown(r.decisions)));
 sections.push("Full structured evidence is retained in the local execution audit.");
 const action = pr ? nextAction(`Review [the pull request](${pr}) and merge it when satisfied. The factory never merges automatically.`)
  : r.outcome === "changes" ? noAction("The factory will route the actionable findings through the correction cycle and publish the next result here.")
  : r.outcome === "decision" ? noAction("Product Architect will evaluate the decision and route the approved workflow without changing the specification silently.")
  : role === "developer" ? noAction("The factory will run independent QA next.")
  : role === "qa" ? noAction("The factory will run the independent Reviewer next.")
  : noAction("The factory will continue the workflow automatically.");
 sections.push(action);
 return sections.join("\n\n");
}
export function startedMarkdown(w: WorkItem,requestedBy: string,source: "comment" | "control") {
 const origin=source === "comment" ? `GitHub command from @${requestedBy}` : requestedBy;
 return `## AI Factory started\n\n| Detail | Value |\n| --- | --- |\n| Work item | \`${w.id}\` |\n| Starting stage | Product Architect |\n| Requested through | ${origin} |\n| Branch | \`${w.branch}\` |\n\nThe factory is preparing the initial specification.\n\n${noAction("Wait for Product Architect to request input or publish a SPEC for approval.")}`;
}
export function pausedMarkdown(w: WorkItem,reason: string,activeExecution: boolean) {
 const resume=w.context.resume ?? "SPEC";
 return `## Workflow paused\n\n| Detail | Value |\n| --- | --- |\n| Interrupted stage | ${stageName(resume)} |\n| Reason | ${reason} |\n| Recorded at | ${new Date().toISOString()} |\n| Agent execution | ${activeExecution ? "Stop requested; its process is being terminated safely" : "No active process detected"} |\n| Work preserved | Yes — local state and worktree remain available |\n| Resume stage | ${stageName(resume)} |\n\n${retryAction("When the daemon is running and you are ready to resume, post a new comment containing exactly:")}`;
}
export function cancelledMarkdown(w: WorkItem,activeExecution: boolean) {
 const resume=w.context.resume ?? "SPEC";
 return `## Workflow cancelled\n\n| Detail | Value |\n| --- | --- |\n| Cancelled stage | ${stageName(resume)} |\n| Requested through | Dashboard or CLI control |\n| Recorded at | ${new Date().toISOString()} |\n| Agent execution | ${activeExecution ? "Cancellation requested; its process is being terminated safely" : "No active process detected"} |\n| Work preserved | Yes — local state and worktree remain available |\n| Retry resumes at | ${stageName(resume)} |\n\n${retryAction("To resume the preserved work, post a new comment containing exactly:")}`;
}
export function recoveredMarkdown(w: WorkItem,remoteLabel: string,latestCommentId: number | null) {
 return `## Workflow state recovered\n\nThe local work item was missing, so the factory recovered this issue conservatively instead of guessing which agent work had completed.\n\n| Detail | Value |\n| --- | --- |\n| GitHub state found | \`${remoteLabel}\` |\n| Latest comment synchronized | ${latestCommentId ? `\`${latestCommentId}\`` : "No comments"} |\n| Current state | Paused |\n| Safe resume stage | Product Architect |\n| Previous GitHub discussion | Preserved as context |\n\n${retryAction("Review the recovered context. To restart safely at Product Architect, post:")}`;
}
export function readyToMergeMarkdown(w: WorkItem,commit: string) {
 const qa=clip(w.context.reports.qa?.summary ?? "QA passed.",700),review=clip(w.context.reports.reviewer?.summary ?? "Review passed.",700);
 return `## Delivery ready for human merge\n\nAll automated delivery gates passed for **SPEC v${w.context.version}**.\n\n| Detail | Value |\n| --- | --- |\n| Pull request | [Open PR](${w.context.pr}) |\n| Branch | \`${w.branch}\` |\n| Published commit | \`${commit}\` |\n| Approved by | @${w.context.approval?.login ?? "unknown"} |\n\n### QA\n\n${qa}\n\n### Review\n\n${review}\n\n${nextAction(`Review [the pull request](${w.context.pr}) and merge it manually when satisfied. The factory never performs the merge.`)}`;
}
export function prClosedMarkdown(w: WorkItem) {
 return `## Pull request closed without merge\n\n| Detail | Value |\n| --- | --- |\n| Pull request | [Open PR](${w.context.pr}) |\n| Delivery status | Not integrated |\n| Published branch | \`${w.branch}\` |\n| Work preserved | Yes |\n\n${nextAction(`Review [the pull request](${w.context.pr}). Reopen it if delivery should continue; the factory will return this issue to **Ready to merge** automatically.`)}`;
}
export function mergedMarkdown(w: WorkItem) {
 return `## Delivery merged\n\n| Detail | Value |\n| --- | --- |\n| Pull request | [Open merged PR](${w.context.pr}) |\n| Merge commit | ${w.context.merge?.commit ? `\`${w.context.merge.commit}\`` : "Not reported by GitHub"} |\n| Merged at | ${w.context.merge?.at ?? "Not reported by GitHub"} |\n| SPEC | v${w.context.version} |\n| Delivery status | Complete |\n\nGitHub manages issue closure through the PR's closing reference.\n\n${noAction("Delivery is complete.")}`;
}
export function progressMarkdown(w: WorkItem) {
 const c = w.context;
 const waiting = w.state === "WAITING_HUMAN" ? c.waiting === "approval"
  ? `### Why the factory is waiting\n\n**SPEC v${c.version} needs your approval.** No implementation will begin until an authorized approver accepts it or requests changes.`
  : c.waiting === "loop"
   ? `### Why the factory is waiting\n\n**The automatic correction limit was reached.** The current work and reports are preserved, but Product Architect needs your guidance before replanning.`
   : `### Why the factory is waiting\n\n**Product Architect needs clarification.** The current draft is preserved and work will resume after an authorized answer is posted.` : "";
 const action = w.state === "WAITING_HUMAN"
  ? c.waiting === "approval"
   ? nextAction(`Choose one option and post it as a **new comment**.\n\n**Approve SPEC v${c.version}**\n\n${commandBox(`/factory approve v${c.version}`)}\n\n**Request changes or add context**\n\n${commandBox("/factory answer <feedback>")}`,true)
   : c.waiting === "loop"
    ? nextAction(`Tell Product Architect how to proceed by posting a new comment:\n\n${commandBox("/factory answer <guidance>")}`)
    : nextAction(`Answer Product Architect in a new comment. You can write multiple lines after the command:\n\n${commandBox("/factory answer\n<your response>")}`)
  : w.state === "MERGED" ? noAction(`Delivery completed in [the merged pull request](${c.pr}).`)
  : w.state === "PR_CLOSED" ? nextAction(`Review [the pull request](${c.pr}) and reopen it if delivery should continue.`)
  : w.state === "READY_TO_MERGE" ? nextAction(`Review and merge [the pull request](${c.pr}) manually.`)
  : ["FAILED", "PAUSED", "CANCELLED"].includes(w.state) ? retryAction("Inspect the latest report and logs. After correcting the cause, post:")
  : noAction("The factory is working and will publish the next result here.");
 const stage = (role: AgentRole) => c.reports[role]?.outcome === "pass" ? "Passed" : "Pending";
 return `## AI Factory — ${statePresentation[w.state].title}\n\n${statePresentation[w.state].description}.\n\n${table(["Milestone", "Status"], [
  ["Specification", c.architectDraft ? "Strong-profile draft review" : c.version ? `v${c.version}` : "In preparation"],
  ["Human approval", c.approvedVersion === c.version && c.approval ? `v${c.version} approved by ${c.approval.login}` : "Pending"],
  ["Development", stage("developer")], ["Independent QA", stage("qa")], ["Review", stage("reviewer")],
 ])}\n\n${waiting ? `${waiting}\n\n` : ""}${w.state === "MERGED" ? "The linked PR has been merged. GitHub manages issue closure through the PR closing reference." : "The issue stays open while delivery or merge is pending. The linked PR closes it when merged into the default branch."}\n\n<sub>Orchestrator state: ${w.state} · Work item: ${w.id}</sub>\n\n${action}`;
}

export function architecturalReviewMarkdown() {
 return `## Additional architectural review\n\nProduct Architect detected high complexity or risk. A strong-profile architectural review will refine the draft before any specification is published for approval.\n\n${noAction("The factory will publish the reviewed specification or request clarification next.")}`;
}
export function correctionLimitMarkdown() {
 return `## Automatic correction limit reached\n\nThe current implementation, reports and worktree are preserved. Product Architect needs human guidance before replanning the next attempt.\n\n${nextAction(`Post a new comment describing how to proceed:\n\n${commandBox("/factory answer <guidance>")}`)}`;
}
export function retryAcceptedMarkdown(login: string, to: string) {
 return `## Retry accepted\n\n@${login} requested a retry. The factory will resume from **${to}**.\n\n${noAction("The next execution has been queued and its result will be published here.")}`;
}
export function retryRejectedMarkdown(error: unknown) {
 return `## Retry could not start\n\n${String(error)}\n\n${retryAction("Resolve the reported condition, then post a new comment containing exactly:")}`;
}
export function pullRequestReopenedMarkdown(url: string) {
 return `## Pull request reopened\n\nThe delivery is open again and awaits human review.\n\n${nextAction(`Review and merge [the pull request](${url}) when satisfied.`)}`;
}
export function tacticalResolutionMarkdown(version: number, decisions: Decision[], to: string) {
 return `## Product Architect — tactical question resolved\n\nThe decision remains within **SPEC v${version}** and does not change its approved scope.\n\n${decisionsMarkdown(decisions)}\n\n| Detail | Value |\n| --- | --- |\n| Resume stage | ${to} |\n| New approval required | No |\n\n${noAction("The factory will resume the selected delivery stage automatically.")}`;
}

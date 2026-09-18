import type { AgentResult, AgentRole, Decision, WorkItem, WorkState } from "./types.js";
export const statePresentation: Record<WorkState, { title: string; color: string; description: string }> = {
 MERGED: { title: "Merged — completed", color: "8250df", description: "GitHub confirmed the pull request was merged" },
 PR_CLOSED: { title: "PR closed without merge", color: "d73a4a", description: "Changes were not integrated; reopen the PR to resume tracking" },
 NEW: { title: "Queued", color: "d4c5f9", description: "Waiting for initial assessment" },
 SPEC: { title: "Designing the specification", color: "5319e7", description: "Product/Architect is preparing the work" },
 WAITING_HUMAN: { title: "Waiting for your response", color: "fbca04", description: "Human approval, clarification or guidance required" },
 DEVELOPMENT: { title: "Implementing", color: "1d76db", description: "Developer is implementing the approved specification" },
 QA: { title: "Testing independently", color: "0e8a16", description: "QA is verifying the acceptance criteria" },
 REVIEW: { title: "Reviewing", color: "006b75", description: "Reviewer is inspecting implementation and evidence" },
 READY_TO_MERGE: { title: "Ready for human merge", color: "2cbe4e", description: "Delivery gates passed; review and merge the pull request" },
 FAILED: { title: "Execution needs attention", color: "d73a4a", description: "Inspect the failure and explicitly retry" },
 PAUSED: { title: "Paused", color: "bfbfbf", description: "Execution is paused; explicit retry required" },
 CANCELLED: { title: "Cancelled", color: "e4e669", description: "Execution was cancelled" },
};
const roles: Record<AgentRole, string> = { "product-architect": "Product / Architect", developer: "Developer", qa: "QA", reviewer: "Reviewer" };
const clip = (s: string, n = 700) => s.length > n ? s.slice(0, n) + "…" : s;
const cell = (s: string) => clip(s, 350).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "&#124;").replaceAll("\n", "<br>");
function table(headers: string[], rows: string[][]) {
 const shown = rows.slice(0, 20);
 return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...shown.map(row => `| ${row.map(cell).join(" | ")} |`), ...(rows.length > 20 ? [`\nShowing 20 of ${rows.length} entries. Full evidence remains in the local audit log.`] : [])].join("\n");
}
function details(title: string, body: string) { return `<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>`; }
export function decisionsMarkdown(decisions: Decision[]) {
 return table(["Decision", "Rationale", "Type"], decisions.map(d => [d.decision, d.rationale, d.conflictsWithHuman ? "Requires human decision" : d.kind]));
}
export function specMarkdown(version: number, r: AgentResult) {
 const a = r.taskAssessment!;
 return `## SPEC v${version} — awaiting approval\n\n${r.spec}\n\n### Task assessment\n\n**Complexity:** ${a.complexity} · **Risk:** ${a.risk}\n\n${a.rationale}\n\n${details("Acceptance criteria", table(["ID", "Expected behavior"], r.acceptanceCriteria.map(c => [c.id, c.description])))}\n\n### Your next step\n\nApprove by posting \`/factory approve v${version}\` as a new comment, or request changes with \`/factory answer <feedback>\`.`;
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
 if (pr) sections.push(`### Ready for your review\n\n[Open the pull request](${pr}). Merge remains a human action.`);
 sections.push("Full structured evidence is retained in the local execution audit.");
 return sections.join("\n\n");
}
export function progressMarkdown(w: WorkItem) {
 const c = w.context;
 const action = w.state === "WAITING_HUMAN"
  ? c.waiting === "approval" ? `Review SPEC v${c.version} and post \`/factory approve v${c.version}\` or \`/factory answer <feedback>\`.` : "Post `/factory answer <your response>` to continue."
  : w.state === "MERGED" ? `Delivery completed: [merged pull request](${c.pr}). No further action required by the factory.`
  : w.state === "PR_CLOSED" ? `Review why [the PR](${c.pr}) was closed; reopen it if delivery should continue.`
  : w.state === "READY_TO_MERGE" ? `Review and merge the [pull request](${c.pr}).`
  : ["FAILED", "PAUSED", "CANCELLED"].includes(w.state) ? `Inspect the latest report/logs, then run \`factory retry ${w.id}\` when ready.`
  : "No action needed; the factory is working.";
 const stage = (role: AgentRole) => c.reports[role]?.outcome === "pass" ? "Passed" : "Pending";
 return `## AI Factory — ${statePresentation[w.state].title}\n\n${statePresentation[w.state].description}.\n\n${table(["Milestone", "Status"], [
  ["Specification", c.architectDraft ? "Strong-profile draft review" : c.version ? `v${c.version}` : "In preparation"],
  ["Human approval", c.approvedVersion === c.version && c.approval ? `v${c.version} approved by ${c.approval.login}` : "Pending"],
  ["Development", stage("developer")], ["Independent QA", stage("qa")], ["Review", stage("reviewer")],
 ])}\n\n**Next action:** ${action}\n\n${w.state === "MERGED" ? "The linked PR has been merged. GitHub manages issue closure through the PR closing reference." : "The issue stays open while delivery or merge is pending. The linked PR closes it when merged into the default branch."}\n\n<sub>Orchestrator state: ${w.state} · Work item: ${w.id}</sub>`;
}

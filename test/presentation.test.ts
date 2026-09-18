import test from "node:test";
import assert from "node:assert/strict";
import { reportMarkdown, specMarkdown, progressMarkdown } from "../src/presentation.js";
import { GitHubAdapter } from "../src/adapters/github.js";
import { result } from "./fixtures.js";
import type { WorkItem } from "../src/types.js";
test("human reports render evidence and actions as Markdown instead of serialized results", () => {
 const spec = specMarkdown(3, result("spec"));
 assert.match(spec, /Complexity:\*\* medium/); assert.match(spec, /factory approve v3/);
 assert.doesNotMatch(spec, /"complexity":|"acceptanceCriteria":/);
 const report = reportMarkdown("qa", 3, result("pass", { findings: [{ classification: "defer", evidence: "Optional | optimization\nnext line" }] }), "https://example.test/pr/1");
 assert.match(report, /QA — Passed/); assert.match(report, /<details>/);
 assert.match(report, /Optional &#124; optimization<br>next line/);
 assert.match(report, /node --test/); assert.match(report, /AC1/);
 assert.doesNotMatch(report, /"outcome":|"coverage":/);
});
test("progress distinguishes workflow stage, approval and human merge", () => {
 const w: WorkItem = { id: "w", repo: "owner/demo", issue_number: 1, branch: "factory/demo", state: "WAITING_HUMAN", context: { title: "Demo", body: "", url: "", version: 2, cursor: 0, feedback: [], cycles: 0, reports: {}, waiting: "approval" } };
 assert.match(progressMarkdown(w), /factory approve v2/);
 w.state = "READY_TO_MERGE"; w.context.pr = "https://example.test/pr/1";
 assert.match(progressMarkdown(w), /Ready for human merge/);
 assert.match(progressMarkdown(w), /issue stays open/);
 assert.match(progressMarkdown(w), /https:\/\/example.test\/pr\/1/);
});
test("GitHub status updates one comment, preserves unrelated factory labels, and performs no close", () => {
 const comments: { id: number; body: string }[] = [];
 let labels = [{ name: "factory:queued", color: "", description: "" }, { name: "factory:priority-high", color: "", description: "" }, { name: "bug", color: "", description: "" }];
 let edits = 0; const calls: string[][] = [];
 const invoke = (a: string[], input?: unknown) => {
  calls.push(a);
  if (a[0] === "api" && a.includes("--method")) { edits++; comments[0].body = (input as any).body; return "{}"; }
  if (a[0] === "api") return JSON.stringify([comments]);
  if (a[0] === "issue" && a[1] === "view") return JSON.stringify({ labels });
  if (a[0] === "label") { const name = a[2]; labels = labels.filter(l => l.name !== name); labels.push({ name, color: a[a.indexOf("--color") + 1], description: a[a.indexOf("--description") + 1] }); return ""; }
  if (a[1] === "edit") { for (let i=0;i<a.length;i++) if (a[i] === "--remove-label") labels = labels.filter(l => l.name !== a[i+1]); return ""; }
  if (a[1] === "comment") { comments.push({ id: 1, body: a[a.indexOf("--body") + 1] }); return ""; }
  throw new Error(`Unexpected command ${a.join(" ")}`);
 };
 const gh = new GitHubAdapter(invoke);
 gh.syncState(1, "DEVELOPMENT", "Implementing");
 gh.syncState(1, "QA", "Testing");
 gh.syncState(1, "QA", "Testing");
 assert.equal(comments.length, 1); assert.equal(edits, 1);
 assert.ok(comments[0].body.startsWith("Testing"));
 assert.deepEqual(labels.map(l => l.name).sort(), ["bug", "factory:priority-high", "factory:qa"]);
 assert.ok(!calls.some(a => a.includes("close")));
});

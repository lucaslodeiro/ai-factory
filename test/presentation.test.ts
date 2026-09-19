import test from "node:test";
import assert from "node:assert/strict";
import { reportMarkdown, specMarkdown, progressMarkdown, questionsMarkdown, startedMarkdown, pausedMarkdown, cancelledMarkdown, recoveredMarkdown, readyToMergeMarkdown, prClosedMarkdown, mergedMarkdown, architecturalReviewMarkdown, correctionLimitMarkdown, retryAcceptedMarkdown, retryRejectedMarkdown, pullRequestReopenedMarkdown, tacticalResolutionMarkdown } from "../src/presentation.js";
import { GitHubAdapter } from "../src/adapters/github.js";
import { config } from "../src/config.js";
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
test("architect questions render as readable instructions without visible line escapes", () => {
 const markdown = questionsMarkdown([
  "Data source: Do we already have an approved provider?\\",
  "Competition scope: Should tournaments be configured manually, or derived dynamically?\\nPlease choose one.",
  "Is there a required hosting target?\\"
 ]);
 assert.match(markdown,/## Product Architect — input needed/);
 assert.match(markdown,/### 1\. Data source\n\nDo we already have an approved provider\?/);
 assert.match(markdown,/### 2\. Competition scope/);
 assert.match(markdown,/Should tournaments be configured manually, or derived dynamically\?\nPlease choose one\./);
 assert.match(markdown,/### 3\. Question 3/);
 assert.match(markdown,/\/factory answer\n1\. <answer 1>\n2\. <answer 2>\n3\. <answer 3>/);
 assert.match(markdown,/Editing a comment the factory already read will not reactivate/);
 assert.doesNotMatch(markdown,/\\(?:\n|$)/);
});
test("progress distinguishes workflow stage, approval and human merge", () => {
 const w: WorkItem = { id: "w", repo: "owner/demo", issue_number: 1, branch: "factory/demo", state: "WAITING_HUMAN", context: { title: "Demo", body: "", url: "", version: 2, cursor: 0, feedback: [], cycles: 0, reports: {}, waiting: "approval" } };
 assert.match(progressMarkdown(w), /factory approve v2/);
 w.state = "READY_TO_MERGE"; w.context.pr = "https://example.test/pr/1";
 assert.match(progressMarkdown(w), /Ready for human merge/);
 assert.match(progressMarkdown(w), /issue stays open/);
 assert.match(progressMarkdown(w), /https:\/\/example.test\/pr\/1/);
});
test("waiting-for-human progress explains the gate and ends with boxed action choices", () => {
 const w: WorkItem = { id:"w",repo:"owner/demo",issue_number:1,branch:"factory/demo",state:"WAITING_HUMAN",context:{title:"Demo",body:"",url:"",version:2,cursor:0,feedback:[],cycles:0,reports:{},waiting:"approval"} };
 const approval=progressMarkdown(w);
 assert.match(approval,/Why the factory is waiting/); assert.match(approval,/SPEC v2 needs your approval/);
 assert.match(approval,/### Next actions[\s\S]*```text\n\/factory approve v2\n```[\s\S]*```text\n\/factory answer <feedback>\n```$/);
 w.context.waiting="questions";
 assert.match(progressMarkdown(w),/Product Architect needs clarification[\s\S]*```text\n\/factory answer\n<your response>\n```$/);
 w.context.waiting="loop";
 assert.match(progressMarkdown(w),/automatic correction limit was reached[\s\S]*```text\n\/factory answer <guidance>\n```$/i);
});
test("actionable lifecycle messages explain preserved work and next steps", () => {
 const w: WorkItem = { id:"work-1",repo:"owner/demo",issue_number:1,branch:"factory/issue-1",state:"PAUSED",context:{title:"Demo",body:"",url:"https://example.test/issues/1",version:2,cursor:0,feedback:[],cycles:0,resume:"QA",reports:{qa:result("pass"),reviewer:result("pass")},approval:{login:"owner",commentId:7},approvedVersion:2,pr:"https://example.test/pr/1",merge:{at:"2026-09-19T12:00:00Z",commit:"abc123"}} };
 assert.match(startedMarkdown(w,"owner","comment"),/GitHub command from @owner/);
 assert.match(pausedMarkdown(w,"Daemon stopped",true),/Interrupted stage \| QA/); assert.match(pausedMarkdown(w,"Daemon stopped",true),/Work preserved \| Yes/);
 assert.match(cancelledMarkdown(w,false),/Retry resumes at \| QA/);
 assert.match(recoveredMarkdown(w,"factory:review",42),/Safe resume stage \| Product Architect/);
 assert.match(readyToMergeMarkdown(w,"def456"),/Published commit \| `def456`/);
 assert.match(prClosedMarkdown(w),/Delivery status \| Not integrated/);
 assert.match(mergedMarkdown(w),/Merge commit \| `abc123`/);
 const comments=[
  startedMarkdown(w,"owner","comment"),pausedMarkdown(w,"Daemon stopped",true),cancelledMarkdown(w,false),recoveredMarkdown(w,"factory:review",42),
  readyToMergeMarkdown(w,"def456"),prClosedMarkdown(w),mergedMarkdown(w),architecturalReviewMarkdown(),correctionLimitMarkdown(),
  retryAcceptedMarkdown("owner","QA","Do not use Chromium."),retryRejectedMarkdown("still running"),pullRequestReopenedMarkdown(w.context.pr!),
  tacticalResolutionMarkdown(2,[{kind:"tactical",decision:"Keep the API",rationale:"Approved scope",conflictsWithHuman:false}],"QA"),
 ];
 for (const comment of comments) assert.match(comment,/### Next actions?\n\n[\s\S]+$/);
});
test("GitHub adapter reads repository-wide recent issue comments", () => {
 const calls:string[][]=[];
 const comments=[{id:9,body:"/factory start",issue_url:"https://api.github.com/repos/owner/demo/issues/3",created_at:"2026-09-19T10:00:00Z",updated_at:"2026-09-19T10:00:00Z",user:{login:"owner",type:"User"}}];
 const result=new GitHubAdapter(args=>{calls.push(args);return JSON.stringify([comments]);}).repositoryComments("2026-09-19T09:00:00Z");
 assert.equal(result[0].id,9); assert.match(calls[0].at(-1)!,/issues\/comments\?per_page=100/); assert.match(calls[0].at(-1)!,/since=2026-09-19T09%3A00%3A00Z/);
});
test("GitHub adapter distinguishes open issues from pull requests", () => {
 const issue=new GitHubAdapter(args=>{assert.deepEqual(args,["api",`repos/${config.repo}/issues/12`]);return JSON.stringify({number:12,title:"Feature",body:null,html_url:"https://github.com/owner/demo/issues/12",state:"open"});}).issue(12);
 assert.deepEqual(issue,{number:12,title:"Feature",body:"",url:"https://github.com/owner/demo/issues/12",state:"OPEN",pullRequest:false});
 const pull=new GitHubAdapter(()=>JSON.stringify({number:13,title:"Delivery",body:"",html_url:"https://github.com/owner/demo/pull/13",state:"open",pull_request:{url:"api"}})).issue(13);
 assert.equal(pull.pullRequest,true);
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
test("GitHub managed issue discovery excludes the removed queue label and unrelated labels", () => {
 const invoke = (args: string[]) => {
  assert.deepEqual(args,["issue","list","--repo",config.repo,"--state","open","--limit","1000","--json","number,title,body,url,labels"]);
  return JSON.stringify([
   {number:1,title:"Paused",body:"",url:"one",labels:[{name:"factory:paused"}]},
   {number:2,title:"Queued",body:"",url:"two",labels:[{name:"factory:queued"}]},
   {number:3,title:"Bug",body:"",url:"three",labels:[{name:"bug"}]},
  ]);
 };
 assert.deepEqual(new GitHubAdapter(invoke).listManaged().map(issue => issue.number),[1]);
});

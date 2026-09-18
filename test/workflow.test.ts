import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { Orchestrator } from "../src/orchestrator.js";
import { config, agentEnvironment } from "../src/config.js";
import { parseResult } from "../src/results.js";
import { retry } from "../src/daemon.js";
import type { AgentResult, AgentRole, WorkState } from "../src/types.js";
import type { Comment, GitHubPort } from "../src/adapters/github.js";
import type { AgentRunRequest } from "../src/adapters/agent.js";
config.repo = "owner/demo"; config.approvers = ["owner"];
import { result } from "./fixtures.js";
class GitHub implements GitHubPort {
 replies: Comment[] = []; posted = new Map<string,string>(); states: WorkState[] = []; prs = 0; fail = false; failComments = false;
 listQueued() { return [{ number: 1, title: "Feature", body: "Implement feature", url: "https://example.test/issues/1" }]; }
 comments() { if (this.failComments) throw new Error("GitHub temporarily unavailable"); return this.replies; }
 commentOnce(_n: number, body: string, key: string) { if (this.fail) throw new Error("offline"); this.posted.set(key, body); }
 syncState(_n: number, state: WorkState) { this.states.push(state); }
 ensurePR() { this.prs++; return "https://example.test/pull/1"; }
 reply(body: string, login = "owner", type = "User") { this.replies.push({ id: this.replies.length + 1, body, user: { login, type } }); }
}
function setup(overrides: Partial<Record<AgentRole, AgentResult[]>> = {}) {
 const store = new Store(":memory:"), gh = new GitHub(), calls: AgentRunRequest[] = [];
 let published = 0;
 const agents = Object.fromEntries((["product-architect", "developer", "qa", "reviewer"] as AgentRole[]).map(role => [role, { async run(req: AgentRunRequest) {
  calls.push(req); return overrides[role]?.shift() ?? result(role === "product-architect" ? "spec" : "pass");
 } }])) as any;
 const ws = { assertBranch() {}, ensure: () => "/tmp/fake", head: () => "abc", diff: () => "diff", check() {}, commit() {}, publish() { published++; } };
 const notifications: string[] = [];
 const o = new Orchestrator(store, agents, gh, ws, { enabled: true, async notify(text) { notifications.push(text); } });
 const item = () => store.items()[0];
 return { store, gh, calls, o, item, notifications, published: () => published };
}
test("issue -> version approval -> developer -> independent QA -> reviewer -> PR, duplicate polling safe", async () => {
 const f = setup(); await f.o.tick(); assert.equal(f.item().state, "WAITING_HUMAN");
 await f.o.tick(); assert.equal(f.calls.length, 1);
 f.gh.reply("/factory approve v1"); await f.o.tick();
 assert.equal(f.item().context.approval?.login, "owner");
 await f.o.tick(); await f.o.tick(); await f.o.tick();
 assert.equal(f.item().state, "READY_TO_MERGE"); assert.equal(f.published(), 1); assert.equal(f.gh.prs, 1);
 assert.deepEqual(f.calls.map(c => c.role), ["product-architect", "developer", "qa", "reviewer"]);
 assert.equal(f.store.items().length, 1); await f.o.tick(); assert.equal(f.gh.prs, 1);
 f.store.db.close();
});
test("reject unknown approver, bots, quoted command and stale spec version", async () => {
 const f = setup(); await f.o.tick();
 f.gh.reply("/factory approve v1", "stranger"); f.gh.reply("/factory approve v1", "owner", "Bot");
 f.gh.reply("> /factory approve v1"); f.gh.reply("/factory approve v0");
 await f.o.tick(); assert.equal(f.item().state, "WAITING_HUMAN"); assert.equal(f.calls.length, 1);
 f.gh.reply("/factory answer revise acceptance criteria"); await f.o.tick(); await f.o.tick();
 assert.equal(f.item().context.version, 2); f.gh.reply("/factory approve v1"); await f.o.tick();
 assert.equal(f.item().state, "WAITING_HUMAN"); f.gh.reply("/factory approve v2"); await f.o.tick();
 assert.equal(f.item().state, "DEVELOPMENT"); f.store.db.close();
});
test("questions and answer return to architect; approval cannot skip questions", async () => {
 const f = setup({ "product-architect": [result("questions", { questions: ["Which behavior?"] })] });
 await f.o.tick(); f.gh.reply("/factory approve v0"); await f.o.tick(); assert.equal(f.item().state, "WAITING_HUMAN");
 f.gh.reply("/factory answer return 42"); await f.o.tick(); await f.o.tick();
 assert.equal(f.item().context.version, 1); assert.match(f.calls[1].instructions, /return 42/); f.store.db.close();
});
test("QA fixes rerun developer and QA; deferred findings permit review", async () => {
 const f = setup({ qa: [result("changes", { findings: [{ classification: "auto-fix", evidence: "AC1 fails" }] }), result("pass", { findings: [{ classification: "defer", evidence: "optional optimization" }] })] });
 await f.o.tick(); f.gh.reply("/factory approve v1"); await f.o.tick();
 for (let i=0;i<5;i++) await f.o.tick();
 assert.equal(f.item().state, "READY_TO_MERGE");
 assert.deepEqual(f.calls.map(c => c.role), ["product-architect", "developer", "qa", "developer", "qa", "reviewer"]);
 assert.match(f.calls[3].instructions, /AC1 fails/); assert.doesNotMatch(f.calls[4].instructions, /AC1 fails/); f.store.db.close();
});
test("material decision invalidates previous approval and repeated fixes escalate", async () => {
 const f = setup({ developer: [result("decision")] });
 await f.o.tick(); f.gh.reply("/factory approve v1"); await f.o.tick(); await f.o.tick();
 assert.equal(f.item().state, "SPEC"); await f.o.tick(); assert.equal(f.item().context.approvedVersion, undefined);
 assert.equal(f.item().context.version, 2); f.store.db.close();
 const g = setup({ developer: Array.from({ length: config.maxCycles }, () => result("changes", { findings: [{ classification: "auto-fix", evidence: "failure" }] })) });
 await g.o.tick(); g.gh.reply("/factory approve v1"); await g.o.tick();
 for (let i=0;i<config.maxCycles;i++) await g.o.tick();
 assert.equal(g.item().state, "WAITING_HUMAN"); assert.equal(g.item().context.waiting, "loop"); g.store.db.close();
});
test("durable GitHub outbox retries; malformed outputs fail closed and retry routes correctly", async () => {
 const f = setup({ developer: [result("pass", { findings: [{ classification: "auto-fix", evidence: "blocking" }] })] });
 f.gh.fail = true; await f.o.tick(); assert.equal(f.gh.posted.size, 0);
 f.gh.fail = false; await f.o.flush(); assert.equal(f.gh.posted.size, 2);
 await f.o.flush(); assert.equal(f.gh.posted.size, 2);
 f.gh.reply("/factory approve v1"); await f.o.tick(); await f.o.tick();
 assert.equal(f.item().state, "FAILED"); retry(f.store, f.item().id); assert.equal(f.item().state, "DEVELOPMENT");
 await f.o.tick(); assert.equal(f.item().state, "QA"); f.store.db.close();
});
test("environment allowlist and result contract reject unintended data", () => {
 assert.deepEqual(agentEnvironment({ PATH: "/bin", GITHUB_TOKEN: "secret", SLACK_WEBHOOK_URL: "secret", OPENAI_API_KEY: "allowed", AGENT_SECRET_ALLOWLIST: "OPENAI_API_KEY" }), { PATH: "/bin", OPENAI_API_KEY: "allowed" });
 assert.throws(() => parseResult(result("pass"), "product-architect"));
 assert.throws(() => parseResult(result("spec", { spec: "" }), "product-architect"));
});

const tactical = (nextRole: AgentResult["nextRole"] = "developer") => result("resolved", {
 nextRole, decisions: [{ kind: "tactical", decision: "Use the existing parser helper", rationale: "Preserves every approved behavior", conflictsWithHuman: false }],
});
test("architect resolves a developer consultation without a new spec or approval", async () => {
 const f = setup({ developer: [result("decision")], "product-architect": [result("spec"), tactical()] });
 await f.o.tick(); f.gh.reply("/factory approve v1"); await f.o.tick();
 const approved = f.item().context.approval; const spec = f.item().context.spec;
 await f.o.tick(); assert.equal(f.item().state, "SPEC"); await f.o.tick();
 assert.equal(f.item().state, "DEVELOPMENT"); assert.equal(f.item().context.version, 1);
 assert.equal(f.item().context.spec, spec); assert.deepEqual(f.item().context.approval, approved);
 assert.equal((f.store.db.prepare("SELECT COUNT(*) AS n FROM specs").get() as any).n, 1);
 assert.equal(f.item().context.decisions?.[0].kind, "tactical");
 for (let i=0;i<3;i++) await f.o.tick();
 assert.equal(f.item().state, "READY_TO_MERGE"); assert.match(f.calls[3].instructions, /existing parser helper/);
 assert.equal(f.notifications.filter(n => n.includes("WAITING_HUMAN")).length, 1); f.store.db.close();
});
test("QA consultation can return to QA without inheriting developer reasoning", async () => {
 const f = setup({ qa: [result("decision")], "product-architect": [result("spec"), tactical("qa")] });
 await f.o.tick(); f.gh.reply("/factory approve v1"); await f.o.tick();
 for (let i=0;i<5;i++) await f.o.tick();
 assert.equal(f.item().state, "READY_TO_MERGE");
 assert.deepEqual(f.calls.map(c => c.role), ["product-architect", "developer", "qa", "product-architect", "qa", "reviewer"]);
 assert.match(f.calls[4].instructions, /existing parser helper/); f.store.db.close();
});
test("tactical result cannot skip QA, change spec, override a human, or approve itself initially", async () => {
 const f = setup({ developer: [result("decision")], "product-architect": [result("spec"), tactical("reviewer")] });
 await f.o.tick(); f.gh.reply("/factory approve v1"); await f.o.tick(); await f.o.tick(); await f.o.tick();
 assert.equal(f.item().state, "FAILED"); assert.equal(f.published(), 0); f.store.db.close();
 assert.throws(() => parseResult({ ...tactical(), spec: "new scope" }, "product-architect"), /Only a new specification/);
 assert.throws(() => parseResult({ ...tactical(), decisions: [{ kind: "major", decision: "Change auth", rationale: "Different product", conflictsWithHuman: false }] }, "product-architect"), /human decision/);
 assert.throws(() => parseResult({ ...tactical(), decisions: [{ kind: "tactical", decision: "Ignore human", rationale: "Preference", conflictsWithHuman: true }] }, "product-architect"), /human decision/);
 const g = setup({ "product-architect": [tactical()] }); await g.o.tick(); assert.equal(g.item().state, "FAILED"); g.store.db.close();
});
test("incomplete or unknown coverage prevents downstream roles and publication", async () => {
 for (const coverage of [[], [{ criterionId: "UNKNOWN", status: "passed" as const, evidence: "not in approved spec" }]]) {
  const f = setup({ developer: [result("pass", { coverage })] });
  await f.o.tick(); f.gh.reply("/factory approve v1"); await f.o.tick(); await f.o.tick();
  assert.equal(f.item().state, "FAILED"); assert.equal(f.published(), 0); assert.equal(f.calls.length, 2); f.store.db.close();
 }
});
test("Slack human-action notification remains deliverable during a GitHub outage", async () => {
 const f = setup(); f.gh.fail = true; await f.o.tick();
 assert.equal(f.gh.posted.size, 0);
 assert.ok(f.notifications.some(n => n.includes("/factory approve v1") && n.includes("https://example.test/issues/1")));
 f.store.db.close();
});

test("comment-read outage preserves human approval gate and resumes without manual retry", async () => {
 const f = setup(); await f.o.tick();
 const before = f.item().context;
 f.gh.reply("/factory approve v1"); f.gh.failComments = true;
 await f.o.tick(); await f.o.tick();
 assert.equal(f.item().state, "WAITING_HUMAN");
 assert.deepEqual(f.item().context, before);
 assert.equal(f.calls.length, 1);
 assert.equal((f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='github.comments_failed'").get() as any).n, 2);
 f.gh.failComments = false; await f.o.tick();
 assert.equal(f.item().state, "DEVELOPMENT");
 assert.equal(f.item().context.approval?.commentId, 1);
 for (let i = 0; i < 3; i++) await f.o.tick();
 assert.equal(f.item().state, "READY_TO_MERGE"); f.store.db.close();
});

test("approved assessment controls model routing, remains immutable during consultation and escalates fixes", async () => {
 const assessment = { complexity: "low" as const, risk: "low" as const, rationale: "One localized behavior" };
 const f = setup({ "product-architect": [result("spec", { taskAssessment: assessment }), tactical()], developer: [result("decision")] });
 await f.o.tick();
 assert.equal(f.calls[0].selection.profile, "balanced");
 assert.deepEqual(f.item().context.taskAssessment, assessment);
 assert.ok([...f.gh.posted.values()].some(body => body.includes("Task assessment") && body.includes(assessment.rationale)));
 f.gh.reply("/factory approve v1"); await f.o.tick(); await f.o.tick();
 assert.equal(f.calls[1].selection.profile, "fast");
 await f.o.tick(); assert.equal(f.calls[2].selection.profile, "strong");
 assert.deepEqual(f.item().context.taskAssessment, assessment);
 assert.equal(f.item().context.approvedVersion, 1);
 for (let i = 0; i < 3; i++) await f.o.tick();
 assert.equal(f.item().state, "READY_TO_MERGE");
 assert.ok(f.calls.slice(3).every(call => call.selection.profile === "strong"));
 assert.deepEqual(JSON.parse((f.store.db.prepare("SELECT assessment FROM specs WHERE version=1").get() as any).assessment), assessment);
 assert.equal((f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='model.selected'").get() as any).n, f.calls.length);
 f.store.db.close();
});

const highSpec = () => result("spec", { taskAssessment: { complexity: "high", risk: "low", rationale: "Cross-component architecture requires deeper review" } });
test("high complexity draft receives a strong review before any approval version exists", async () => {
 const f = setup({ "product-architect": [highSpec(), highSpec()] });
 await f.o.tick();
 assert.equal(f.item().state, "SPEC"); assert.equal(f.item().context.version, 0);
 assert.ok(f.item().context.architectDraft);
 assert.equal((f.store.db.prepare("SELECT COUNT(*) AS n FROM specs").get() as any).n, 0);
 assert.ok(![...f.gh.posted.values()].some(body => body.includes("/factory approve")));
 f.gh.reply("/factory approve v1");
 await f.o.tick();
 assert.deepEqual(f.calls.map(call => call.selection.profile), ["balanced", "strong"]);
 assert.match(f.calls[1].instructions, /unapproved draft/);
 assert.match(f.calls[1].instructions, /Cross-component architecture/);
 assert.equal(f.item().state, "WAITING_HUMAN"); assert.equal(f.item().context.version, 1);
 assert.equal(f.item().context.architectDraft, undefined);
 await f.o.tick(); assert.equal(f.item().state, "WAITING_HUMAN");
 f.gh.reply("/factory approve v1"); await f.o.tick();
 assert.equal(f.item().state, "DEVELOPMENT");
 assert.equal(f.calls.length, 2); f.store.db.close();
});
test("high risk draft survives a failed strong review and retry stays strong", async () => {
 const draft = result("spec", { taskAssessment: { complexity: "low", risk: "high", rationale: "Authorization changes" } });
 const f = setup({ "product-architect": [draft, result("spec", { taskAssessment: null }), result("spec")] });
 await f.o.tick(); await f.o.tick();
 assert.equal(f.item().state, "FAILED"); assert.ok(f.item().context.architectDraft);
 assert.equal(f.item().context.version, 0);
 retry(f.store, f.item().id); await f.o.tick();
 assert.deepEqual(f.calls.map(call => call.selection.profile), ["balanced", "strong", "strong"]);
 assert.equal(f.item().state, "WAITING_HUMAN"); assert.equal(f.item().context.version, 1);
 assert.equal(f.item().context.architectDraft, undefined); f.store.db.close();
});
test("strong draft review can ask questions and retains its profile after the human answers", async () => {
 const f = setup({ "product-architect": [highSpec(), result("questions", { questions: ["Which consistency guarantee?"] }), highSpec()] });
 await f.o.tick(); await f.o.tick();
 assert.equal(f.item().context.waiting, "questions"); assert.ok(f.item().context.architectDraft);
 f.gh.reply("/factory approve v0"); await f.o.tick(); assert.equal(f.item().state, "WAITING_HUMAN");
 f.gh.reply("/factory answer strict consistency"); await f.o.tick(); await f.o.tick();
 assert.equal(f.calls[2].selection.profile, "strong"); assert.match(f.calls[2].instructions, /strict consistency/);
 assert.equal(f.item().context.waiting, "approval"); assert.equal(f.item().context.version, 1);
 f.store.db.close();
});

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
const result = (outcome: AgentResult["outcome"], more: Partial<AgentResult> = {}): AgentResult => ({ outcome, summary: "Evidence: tests executed", spec: outcome === "spec" ? "# Specification\nAC1: returns 42" : "", questions: [], findings: [], ...more });
class GitHub implements GitHubPort {
 replies: Comment[] = []; posted = new Map<string,string>(); states: WorkState[] = []; prs = 0; fail = false;
 listQueued() { return [{ number: 1, title: "Feature", body: "Implement feature", url: "https://example.test/issues/1" }]; }
 comments() { return this.replies; }
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
 const ws = { ensure: () => "/tmp/fake", head: () => "abc", diff: () => "diff", check() {}, commit() {}, publish() { published++; } };
 const o = new Orchestrator(store, agents, gh, ws, { async notify() {} });
 const item = () => store.items()[0];
 return { store, gh, calls, o, item, published: () => published };
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

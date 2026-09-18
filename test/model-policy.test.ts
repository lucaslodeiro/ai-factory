import test from "node:test";
import assert from "node:assert/strict";
import { selectModel } from "../src/model-policy.js";
import { config } from "../src/config.js";
import { parseResult } from "../src/results.js";
import { result } from "./fixtures.js";
import type { TaskAssessment, AgentRole } from "../src/types.js";
const assessment = (complexity: TaskAssessment["complexity"], risk: TaskAssessment["risk"]): TaskAssessment => ({ complexity, risk, rationale: "Inspected task scope" });
test("balanced policy selects profiles by approved complexity, risk and independent role floors", () => {
 const roles: AgentRole[] = ["product-architect", "developer", "qa", "reviewer"];
 for (const role of roles) {
  assert.equal(selectModel(role, assessment("low", "low")).profile, role === "developer" ? "fast" : "balanced");
  assert.equal(selectModel(role, assessment("medium", "low")).profile, "balanced");
  assert.equal(selectModel(role, assessment("low", "medium")).profile, "balanced");
  assert.equal(selectModel(role, assessment("high", "low")).profile, "strong");
  assert.equal(selectModel(role, assessment("low", "high")).profile, "strong");
 }
});
test("initial assessment is balanced; legacy delivery and corrections are conservative", () => {
 assert.equal(selectModel("product-architect").profile, "balanced");
 assert.equal(selectModel("developer").profile, "strong");
 assert.equal(selectModel("qa").profile, "strong");
 assert.equal(selectModel("developer", assessment("low", "low"), 1).profile, "strong");
 assert.equal(selectModel("product-architect", assessment("low", "low"), 0, true).profile, "strong");
});
test("policy uses configured model IDs, records its reason and refuses a missing mapping", () => {
 const saved = config.models.codex.fast;
 try {
  config.models.codex.fast = "custom-fast-model";
  const choice = selectModel("developer", assessment("low", "low"));
  assert.equal(choice.model, "custom-fast-model"); assert.equal(choice.provider, "codex");
  assert.equal(choice.policy, "balanced-v2"); assert.match(choice.reason, /low-risk/);
  config.models.codex.fast = "";
  assert.throws(() => selectModel("developer", assessment("low", "low")), /Missing/);
 } finally { config.models.codex.fast = saved; }
});
test("only new specs can set an assessment and every assessment needs valid levels and rationale", () => {
 assert.throws(() => parseResult(result("spec", { taskAssessment: null }), "product-architect"), /requires a taskAssessment/);
 assert.equal(parseResult(result("pass", { taskAssessment: assessment("low", "low") }), "developer").taskAssessment, null);
 assert.throws(() => parseResult(result("spec", { taskAssessment: { ...assessment("low", "low"), rationale: "" } }), "product-architect"), /rationale/);
 assert.throws(() => parseResult(result("spec", { taskAssessment: { ...assessment("low", "low"), risk: "unknown" as any } }), "product-architect"), /risk/);
});

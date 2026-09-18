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
test("policy uses each role's configured provider and model IDs", () => {
 const saved = structuredClone(config.roles.developer);
 try {
  config.roles.developer.provider = "claude";
  config.roles.developer.models.fast = "custom-claude-fast";
  const choice = selectModel("developer", assessment("low", "low"));
  assert.equal(choice.model, "custom-claude-fast"); assert.equal(choice.provider, "claude");
  assert.equal(choice.policy, "balanced-v4"); assert.match(choice.reason, /low-risk/);
  config.roles.developer.modelMode = "auto";
  assert.equal(selectModel("developer", assessment("low", "low")).model, "auto");
  config.roles.developer.modelMode = "manual";
  config.roles.developer.models.fast = "";
  assert.throws(() => selectModel("developer", assessment("low", "low")), /developer profile fast/);
 } finally { config.roles.developer = saved; }
});
test("only new specs can set an assessment and every assessment needs valid levels and rationale", () => {
 assert.throws(() => parseResult(result("spec", { taskAssessment: null }), "product-architect"), /requires a taskAssessment/);
 assert.equal(parseResult(result("pass", { taskAssessment: assessment("low", "low") }), "developer").taskAssessment, null);
 assert.throws(() => parseResult(result("spec", { taskAssessment: { ...assessment("low", "low"), rationale: "" } }), "product-architect"), /rationale/);
 assert.throws(() => parseResult(result("spec", { taskAssessment: { ...assessment("low", "low"), risk: "unknown" as any } }), "product-architect"), /risk/);
});

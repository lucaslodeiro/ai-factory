import test from "node:test";
import assert from "node:assert/strict";
import { requiredVerificationDepth } from "../src/results.js";
import { selectModel } from "../src/model-policy.js";
import { config } from "../src/config.js";
import { parseResult } from "../src/results.js";
import { result } from "./fixtures.js";
import type { TaskAssessment, AgentRole } from "../src/types.js";
const assessment = (complexity: TaskAssessment["complexity"], risk: TaskAssessment["risk"]): TaskAssessment => ({ complexity, risk, verificationDepth: requiredVerificationDepth({ complexity, risk }), rationale: "Inspected task scope" });
test("configured routing is unchanged by assessment, corrections or consultations",()=>{
 for(const role of ["product-architect","developer","qa","reviewer"] as AgentRole[]){
  const selection=selectModel(role);assert.equal("profile" in selection,false);
  for(const level of ["low","medium","high"] as const)assert.deepEqual(selectModel(role,assessment(level,level),2,true),selection);
  assert.match(selection.reason,/Configured routing/);
 }
});
test("policy uses each role's configured provider and model IDs", () => {
 const saved = structuredClone(config.roles.developer);
 try {
  config.roles.developer.provider = "claude";
  config.roles.developer.model = "custom-claude";
  const choice = selectModel("developer", assessment("low", "low"));
  assert.equal(choice.model, "custom-claude"); assert.equal(choice.provider, "claude");
  assert.equal(choice.policy, "direct-v1"); assert.match(choice.reason, /claude\/custom-claude/);
  assert.equal(selectModel("developer", assessment("high", "high")).model, "custom-claude");
  config.roles.developer.model = "auto";
  assert.equal(selectModel("developer", assessment("low", "low")).model, "auto");
  config.roles.developer.model = "";
  assert.throws(() => selectModel("developer", assessment("low", "low")), /Missing claude model for Builder/);
 } finally { config.roles.developer = saved; }
});
test("only new specs can set an assessment and every assessment needs valid levels and rationale", () => {
 assert.throws(() => parseResult(result("spec", { taskAssessment: null }), "product-architect"), /requires a taskAssessment/);
 assert.equal(parseResult(result("pass", { taskAssessment: assessment("low", "low") }), "developer").taskAssessment, null);
 assert.throws(() => parseResult(result("spec", { taskAssessment: { ...assessment("low", "low"), rationale: "" } }), "product-architect"), /rationale/);
 assert.throws(() => parseResult(result("spec", { taskAssessment: { ...assessment("low", "low"), risk: "unknown" as any } }), "product-architect"), /risk/);
});

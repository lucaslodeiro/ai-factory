import type { AgentResult } from "../src/types.js";
import { reviewDimensions } from "../src/results.js";
export function result(outcome: AgentResult["outcome"], more: Partial<AgentResult> = {}): AgentResult {
 return { taskAssessment: outcome === "brief" ? { complexity: "medium", risk: "low", verificationDepth: "standard", uxImpact: "none", rationale: "Localized feature with standard tests" } : null, outcome, summary: "Evidence: tests executed", brief: outcome === "brief" ? "## Decisions for you\nNone.\n\n## Solution\nReturn 42." : "", spec: outcome === "spec" ? "# Specification\nAC1: returns 42" : "",
  acceptanceCriteria: outcome === "spec" ? [{ id: "AC1", description: "Returns 42" }] : [], stories: [],
  coverage: outcome === "pass" ? [{ criterionId: "AC1", status: "passed", evidence: "Verified output" }] : [],
  tests: outcome === "pass" ? [{ command: "node --test", exitCode: 0, evidence: "1 test passed" }] : [],
  testCandidates: outcome === "pass" ? [{ name: "returns 42", covers: ["AC1"], value: "essential", kept: true, reason: "The only criterion" }] : [],
  dependencies: [], changedFiles: [], decisions: [], nextRole: null,
  reviewChecks: outcome === "pass" ? reviewDimensions.map(dimension => ({ dimension, status: "passed", evidence: "Inspected implementation and tests" })) : [],
  questions: [], findings: outcome === "decision" ? [{ classification: "decision-required", severity: "major", evidence: "Ambiguous implementation choice" }] : [], ...more };
}
// The Architect answers the pass it is in: a brief until one is approved, then the spec under it.
export function architectPass(instructions: string, more: { brief?: Partial<AgentResult>; spec?: Partial<AgentResult> } = {}): AgentResult {
 return instructions.includes('"type": "specification"') ? result("spec", more.spec) : result("brief", more.brief);
}

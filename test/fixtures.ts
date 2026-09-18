import type { AgentResult } from "../src/types.js";
import { reviewDimensions } from "../src/results.js";
export function result(outcome: AgentResult["outcome"], more: Partial<AgentResult> = {}): AgentResult {
 return { outcome, summary: "Evidence: tests executed", spec: outcome === "spec" ? "# Specification\nAC1: returns 42" : "",
  acceptanceCriteria: outcome === "spec" ? [{ id: "AC1", description: "Returns 42" }] : [],
  coverage: outcome === "pass" ? [{ criterionId: "AC1", status: "passed", evidence: "Verified output" }] : [],
  tests: outcome === "pass" ? [{ command: "node --test", exitCode: 0, evidence: "1 test passed" }] : [],
  dependencies: [], changedFiles: [], decisions: [], nextRole: null,
  reviewChecks: outcome === "pass" ? reviewDimensions.map(dimension => ({ dimension, status: "passed", evidence: "Inspected implementation and tests" })) : [],
  questions: [], findings: outcome === "decision" ? [{ classification: "decision-required", evidence: "Ambiguous implementation choice" }] : [], ...more };
}

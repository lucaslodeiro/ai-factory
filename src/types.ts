export type AgentRole = "product-architect" | "developer" | "qa" | "reviewer";
export type AgentProvider = "codex" | "claude";
export type DeliveryStage = "BUILD" | "TEST" | "REVIEW";
export interface Criterion { id: string; description: string; }
export interface Finding { classification: "auto-fix" | "decision-required" | "defer" | "environment-blocked"; evidence: string; }
export interface Decision { kind: "tactical" | "major"; decision: string; rationale: string; conflictsWithHuman: boolean; supersedes: string[]; }
export interface TaskAssessment { complexity: "low" | "medium" | "high"; risk: "low" | "medium" | "high"; rationale: string; }
export interface ModelSelection { policy: string; provider: AgentProvider; model: string; reason: string; }
export interface AgentResult {
  taskAssessment: TaskAssessment | null;
  outcome: "spec" | "questions" | "resolved" | "pass" | "changes" | "decision";
  summary: string; spec: string; questions: string[]; findings: Finding[];
  acceptanceCriteria: Criterion[];
  coverage: { criterionId: string; status: "passed" | "failed" | "not-run"; evidence: string }[];
  tests: { command: string; exitCode: number | null; evidence: string }[];
  dependencies: { name: string; change: "added" | "updated" | "removed"; rationale: string }[];
  changedFiles: string[]; decisions: Decision[];
  nextRole: "developer" | "qa" | "reviewer" | null;
  reviewChecks: { dimension: string; status: "passed" | "failed" | "not-applicable"; evidence: string }[];
}

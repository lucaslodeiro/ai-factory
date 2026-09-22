export type AgentRole = "product-architect" | "developer" | "qa" | "reviewer";
export const agentProviders = ["codex", "claude", "cursor"] as const;
export type AgentProvider = typeof agentProviders[number];
// A provider that accepts a JSON Schema constrains generation itself, so the prompt
// does not have to restate in prose what the schema already forbids.
export const providerEnforcesResultSchema: Record<AgentProvider, boolean> = { codex: true, claude: true, cursor: false };
export type DeliveryStage = "BUILD" | "TEST" | "REVIEW";
export interface Criterion { id: string; description: string; }
// Severity is the defect; classification is what to do about it. A minor finding is recorded and
// never sent back, because one correction cycle re-runs Builder and Tester.
export type FindingSeverity = "critical" | "major" | "minor";
export interface Finding { classification: "auto-fix" | "decision-required" | "defer" | "environment-blocked"; severity: FindingSeverity; evidence: string; }
export interface Decision { kind: "tactical" | "major"; decision: string; rationale: string; conflictsWithHuman: boolean; supersedes: string[]; }
// How much verification the issue earns, declared with the spec and approved with it.
export type VerificationDepth = "minimal" | "standard" | "thorough";
export interface TaskAssessment { complexity: "low" | "medium" | "high"; risk: "low" | "medium" | "high"; verificationDepth: VerificationDepth; rationale: string; }
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

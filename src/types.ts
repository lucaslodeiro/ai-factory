export type WorkState = "NEW" | "SPEC" | "WAITING_HUMAN" | "DEVELOPMENT" | "QA" | "REVIEW" | "READY_TO_MERGE" | "MERGED" | "PR_CLOSED" | "PAUSED" | "FAILED" | "CANCELLED";
export type AgentRole = "product-architect" | "developer" | "qa" | "reviewer";
export type AgentProvider = "codex" | "claude";
export type DeliveryStage = "DEVELOPMENT" | "QA" | "REVIEW";
export interface Criterion { id: string; description: string; }
export interface Finding { classification: "auto-fix" | "decision-required" | "defer"; evidence: string; }
export interface Decision { kind: "tactical" | "major"; decision: string; rationale: string; conflictsWithHuman: boolean; }
export interface TaskAssessment { complexity: "low" | "medium" | "high"; risk: "low" | "medium" | "high"; rationale: string; }
export type ModelProfile = "fast" | "balanced" | "strong";
export interface ModelSelection { policy: string; provider: AgentProvider; profile: ModelProfile; model: string; reason: string; }
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
export interface Context {
  title: string; body: string; url: string; cwd?: string; spec?: string; version: number;
  architectDraft?: AgentResult;
  taskAssessment?: TaskAssessment;
  criteria?: Criterion[]; decisions?: Decision[]; consultation?: { from: DeliveryStage };
  approvedVersion?: number; approval?: { login: string; commentId: number };
  cursor: number; waiting?: "questions" | "approval" | "loop";
  feedback: string[]; cycles: number; resume?: WorkState;
  lastFailure?: string;
  pendingStage?: { stage: WorkState; beforeHead: string; startedAt: string };
  reports: Partial<Record<AgentRole, AgentResult>>; pr?: string; merge?: { at: string; commit: string | null };
}
export interface WorkItem { id: string; issue_number: number; repo: string; state: WorkState; branch: string; context: Context; }

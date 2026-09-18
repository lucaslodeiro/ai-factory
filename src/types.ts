export type WorkState = "NEW" | "SPEC" | "WAITING_HUMAN" | "DEVELOPMENT" | "QA" | "REVIEW" | "READY_TO_MERGE" | "PAUSED" | "FAILED" | "CANCELLED";
export type AgentRole = "product-architect" | "developer" | "qa" | "reviewer";
export interface Finding { classification: "auto-fix" | "decision-required" | "defer"; evidence: string; }
export interface AgentResult { outcome: "spec" | "questions" | "pass" | "changes" | "decision"; summary: string; spec: string; questions: string[]; findings: Finding[]; }
export interface Context {
  title: string; body: string; url: string; cwd?: string; spec?: string; version: number;
  approvedVersion?: number; approval?: { login: string; commentId: number }; cursor: number;
  waiting?: "questions" | "approval" | "loop"; feedback: string[]; cycles: number;
  resume?: WorkState; reports: Partial<Record<AgentRole, AgentResult>>; pr?: string;
}
export interface WorkItem { id: string; issue_number: number; repo: string; state: WorkState; branch: string; context: Context; }

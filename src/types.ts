export type AgentRole = "product-architect" | "designer" | "developer" | "qa" | "reviewer";
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
// A significant UX impact sends the SPEC through the Designer, whose prototype the human approves
// together with the brief.
export type UxImpact = "none" | "minor" | "significant";
export interface TaskAssessment { complexity: "low" | "medium" | "high"; risk: "low" | "medium" | "high"; verificationDepth: VerificationDepth; uxImpact: UxImpact; rationale: string; }
export interface ModelSelection { policy: string; provider: AgentProvider; model: string; reason: string; }
// A story is a slice of an epic that Builder and Tester deliver on its own branch from the epic's
// branch. The Architect proposes the split with the spec and the human approves it with the brief.
// Each story earns its own verification: its risk and complexity set the depth its Tester works
// to, floored like the epic's, so a low-risk slice is not tested to the epic's worst case.
export type StoryAssessment = Pick<TaskAssessment, "complexity" | "risk" | "verificationDepth">;
export interface Story { key: string; title: string; scope: string; criteria: string[]; dependsOn: string[]; assessment: StoryAssessment; }
export interface AgentResult {
  taskAssessment: TaskAssessment | null;
  outcome: "spec" | "questions" | "resolved" | "pass" | "changes" | "decision";
  // A new specification carries two documents: the brief is what the human reads and approves
  // (the decisions only they can make, the solution in a few lines, the acceptance criteria);
  // spec is the full technical contract for Builder, Tester and Reviewer.
  summary: string; brief: string; spec: string; questions: string[]; findings: Finding[];
  acceptanceCriteria: Criterion[];
  // Empty unless a new specification splits the issue into stories.
  stories: Story[];
  coverage: { criterionId: string; status: "passed" | "failed" | "not-run"; evidence: string }[];
  tests: { command: string; exitCode: number | null; evidence: string }[];
  // The Tester's minimum sufficient test set: every candidate it considered, which criteria each
  // one covers, its value and whether it was kept. Essential candidates are always kept, redundant
  // ones never; what was discarded and why is what lets the factory measure its own testing.
  testCandidates: { name: string; covers: string[]; value: "essential" | "valuable" | "redundant"; kept: boolean; reason: string }[];
  dependencies: { name: string; change: "added" | "updated" | "removed"; rationale: string }[];
  changedFiles: string[]; decisions: Decision[];
  nextRole: "developer" | "qa" | "reviewer" | null;
  reviewChecks: { dimension: string; status: "passed" | "failed" | "not-applicable"; evidence: string }[];
}

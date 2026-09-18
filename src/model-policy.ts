import { config } from "./config.js";
import type { AgentRole, ModelProfile, ModelSelection, TaskAssessment, WorkItem } from "./types.js";
export const modelPolicyVersion = "direct-v1";
export function selectModel(role: AgentRole, assessment?: TaskAssessment, cycles = 0, consultation = false): ModelSelection {
 const routing = config.roles[role], provider = routing.provider;
 let profile: ModelProfile = "balanced", reason = "Standard workflow assessment";
 if (cycles > 0 || consultation) { profile = "strong"; reason = "Correction or architectural consultation requires additional scrutiny"; }
 else if (assessment?.complexity === "high" || assessment?.risk === "high") { profile = "strong"; reason = "Approved assessment has high complexity or risk"; }
 else if (!assessment && role !== "product-architect") { profile = "strong"; reason = "Missing legacy assessment; use conservative workflow safeguards"; }
 else if (assessment?.complexity === "low" && assessment.risk === "low" && role === "developer") { profile = "fast"; reason = "Approved low-complexity, low-risk implementation"; }
 else if (role === "product-architect" && !assessment) reason = "Initial Product/Architect task assessment";
 // QA and Reviewer never use the fast profile, even for a simple implementation.
 const model = routing.model;
 if (!model?.trim()) throw new Error(`Missing ${provider} model for ${role}`);
 return { policy: modelPolicyVersion, provider, profile, model, reason };
}
export function modelForWork(w: WorkItem, role: AgentRole) {
 if (role === "product-architect" && w.context.architectDraft) {
  return { ...selectModel(role, undefined, 0, true), reason: "Review a high-complexity or high-risk draft before human approval" };
 }
 return selectModel(role, w.context.taskAssessment, w.context.cycles, Boolean(w.context.consultation));
}

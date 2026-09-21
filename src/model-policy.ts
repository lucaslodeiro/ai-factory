import { config } from "./config.js";
import type { AgentRole, ModelSelection, TaskAssessment } from "./types.js";
import { roleShortName } from "./names.js";
export const modelPolicyVersion = "direct-v1";
export function selectModel(role: AgentRole, _assessment?: TaskAssessment, _cycles = 0, _consultation = false): ModelSelection {
 const routing = config.roles[role], provider = routing.provider;
 const reason = `Configured routing for ${roleShortName(role)}: ${provider}/${routing.model}`;
 const model = routing.model;
 if (!model?.trim()) throw new Error(`Missing ${provider} model for ${roleShortName(role)}`);
 return { policy: modelPolicyVersion, provider, model, reason };
}

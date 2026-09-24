import type { AgentRole, AgentResult, DeliveryStage, ModelSelection } from "../types.js";
import type { TacticalNextRole } from "../tactical-routing.js";
export interface AgentRunRequest { workItemId: string; role: AgentRole; cwd: string; instructions: string; selection: ModelSelection; executionId?:string;promptMetadata?:import("../execution-manager.js").PromptManifestInput;allowedNextRoles?: TacticalNextRole[]; consultationFrom?: DeliveryStage; localRuntimeUrl?:string;
 // persist keeps the provider session on disk so a later run can continue it; resume continues the
 // session with that id, so instructions carry only what changed since it ended.
 session?: { persist?: boolean; resume?: string }; }
export interface AgentAdapter { run(req: AgentRunRequest): Promise<AgentResult>; }

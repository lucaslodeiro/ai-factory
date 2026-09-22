import type { AgentRole, AgentResult, DeliveryStage, ModelSelection } from "../types.js";
import type { TacticalNextRole } from "../tactical-routing.js";
export interface AgentRunRequest { workItemId: string; role: AgentRole; cwd: string; instructions: string; selection: ModelSelection; executionId?:string;promptMetadata?:import("../execution-manager.js").PromptManifestInput;allowedNextRoles?: TacticalNextRole[]; consultationFrom?: DeliveryStage; localRuntimeUrl?:string; }
export interface AgentAdapter { run(req: AgentRunRequest): Promise<AgentResult>; }

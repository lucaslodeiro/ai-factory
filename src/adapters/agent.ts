import type { AgentRole, AgentResult, DeliveryStage, ModelSelection } from "../types.js";
import type { TacticalNextRole } from "../tactical-routing.js";
export interface AgentRunRequest { workItemId: string; role: AgentRole; cwd: string; instructions: string; selection: ModelSelection; allowedNextRoles?: TacticalNextRole[]; consultationFrom?: DeliveryStage; }
export interface AgentAdapter { run(req: AgentRunRequest): Promise<AgentResult>; }

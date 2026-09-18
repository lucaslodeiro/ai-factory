import type { AgentRole, AgentResult, ModelSelection } from "../types.js";
export interface AgentRunRequest { workItemId: string; role: AgentRole; cwd: string; instructions: string; selection: ModelSelection; }
export interface AgentAdapter { run(req: AgentRunRequest): Promise<AgentResult>; }

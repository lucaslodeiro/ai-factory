import type { AgentRole, AgentResult } from "../types.js";
export interface AgentRunRequest { workItemId: string; role: AgentRole; cwd: string; instructions: string; }
export interface AgentAdapter { run(req: AgentRunRequest): Promise<AgentResult>; }

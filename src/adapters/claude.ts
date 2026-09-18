import { config } from "../config.js";
import { ExecutionManager } from "../execution-manager.js";
import { resultSchema, parseResult } from "../results.js";
import type { AgentAdapter, AgentRunRequest } from "./agent.js";
export class ClaudeAdapter implements AgentAdapter {
 constructor(private executions: ExecutionManager) {}
 async run(r: AgentRunRequest) {
  if (r.selection.provider !== "claude") throw new Error("Model selection/provider mismatch");
  const { stdout } = await this.executions.run(r.workItemId, r.role, config.claudeCommand,
   ["-p", "--model", r.selection.model, "--no-session-persistence", "--output-format", "json", "--json-schema", JSON.stringify(resultSchema), "--tools", "Read,Glob,Grep,WebSearch,WebFetch", "--allowedTools", "Read,Glob,Grep,WebSearch,WebFetch"], r.cwd, r.instructions, config.timeoutMs, r.selection);
  const envelope = JSON.parse(stdout);
  if (envelope.is_error) throw new Error("Claude returned an error result");
  return parseResult(envelope.structured_output ?? JSON.parse(envelope.result), r.role);
 }
}

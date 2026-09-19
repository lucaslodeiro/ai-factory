import { config } from "../config.js";
import { ExecutionManager } from "../execution-manager.js";
import { resultSchemaFor, parseResult } from "../results.js";
import type { AgentAdapter, AgentRunRequest } from "./agent.js";
export class ClaudeAdapter implements AgentAdapter {
 constructor(private executions: ExecutionManager) {}
 async run(r: AgentRunRequest) {
  if (r.selection.provider !== "claude") throw new Error("Model selection/provider mismatch");
  const tools = r.role === "developer" || r.role === "qa"
   ? "Read,Glob,Grep,WebSearch,WebFetch,Edit,Write,Bash"
   : "Read,Glob,Grep,WebSearch,WebFetch";
  const modelArgs = r.selection.model === "auto" ? [] : ["--model", r.selection.model];
  const { stdout } = await this.executions.run(r.workItemId, r.role, config.claudeCommand,
   ["-p", ...modelArgs, "--no-session-persistence", "--output-format", "json", "--json-schema", JSON.stringify(resultSchemaFor(r.role, r.allowedNextRoles)), "--tools", tools, "--allowedTools", tools], r.cwd, r.instructions, config.timeoutMs, r.selection);
  const envelope = JSON.parse(stdout);
  if (envelope.is_error) throw new Error("Claude returned an error result");
  return parseResult(envelope.structured_output ?? JSON.parse(envelope.result), r.role, r.allowedNextRoles, r.consultationFrom);
 }
}

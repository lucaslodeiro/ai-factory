import { config } from "../config.js";
import { ExecutionManager,providerFailureMessage } from "../execution-manager.js";
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
  // stream-json writes every event as it happens, so an interrupted run leaves its commands and
  // tool results on disk; --verbose is required by the CLI for stream-json in print mode.
  const { finalEvent: envelope } = await this.executions.run(r.workItemId, r.role, config.claudeCommand,
   ["-p", ...modelArgs, "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--json-schema", JSON.stringify(resultSchemaFor(r.role, r.allowedNextRoles)), "--tools", tools, "--allowedTools", tools], r.cwd, r.instructions, config.timeoutMs, r.selection,r.promptMetadata,r.executionId,r.localRuntimeUrl);
  if (!envelope) throw new Error("Claude did not return a result event");
  if (envelope.is_error) throw new Error(`Claude returned an error result${providerFailureMessage(envelope,"claude")?`: ${providerFailureMessage(envelope,"claude")}`:""}`);
  if(envelope.structured_output==null)throw new Error("Claude result is missing structured_output");
  return parseResult(envelope.structured_output, r.role, r.allowedNextRoles, r.consultationFrom);
 }
}

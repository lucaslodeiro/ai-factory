import { config } from "../config.js";
import { ExecutionManager } from "../execution-manager.js";
import { resultSchemaFor, parseResult } from "../results.js";
import type { AgentAdapter, AgentRunRequest } from "./agent.js";

// The Cursor Agent CLI has no JSON Schema flag. The schema travels inside the
// prompt and the final assistant message is extracted and validated here.
export function cursorOutputContract(schema: unknown) {
  return `OUTPUT CONTRACT — REQUIRED\nYour final message must be exactly one JSON object that validates against the JSON Schema below: every required field, no additional fields, no markdown fence, no comments and no text before or after the object. Do not describe the object; return it.\n${JSON.stringify(schema)}`;
}
export function extractCursorResult(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced ? fenced[1] : trimmed;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Cursor final message does not contain a JSON object");
  try { return JSON.parse(body.slice(start, end + 1)); } catch { throw new Error("Cursor final message is not valid JSON"); }
}
function lastJsonObject(stdout: string): Record<string, unknown> {
  const lines = stdout.split(/\r?\n/).filter(line => line.trim());
  for (let index = lines.length - 1; index >= 0; index--) {
    try { const value = JSON.parse(lines[index]); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch {}
  }
  try { const value = JSON.parse(stdout); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch {}
  throw new Error("Cursor did not return a JSON result envelope");
}
export class CursorAdapter implements AgentAdapter {
 constructor(private executions: ExecutionManager) {}
 async run(r: AgentRunRequest) {
  if (r.selection.provider !== "cursor") throw new Error("Model selection/provider mismatch");
  const schema = resultSchemaFor(r.role, r.allowedNextRoles);
  // Builder and Tester edit files and run commands; Architect and Reviewer use the documented read-only mode.
  const accessArgs = r.role === "developer" || r.role === "qa" ? ["--force"] : ["--mode", "ask"];
  const modelArgs = r.selection.model === "auto" ? [] : ["--model", r.selection.model];
  const { stdout } = await this.executions.run(r.workItemId, r.role, config.cursorCommand,
   ["-p", ...modelArgs, "--output-format", "json", "--trust", ...accessArgs], r.cwd, `${r.instructions}\n\n${cursorOutputContract(schema)}`, config.timeoutMs, r.selection,r.promptMetadata,r.executionId);
  const envelope = lastJsonObject(stdout);
  if (envelope.is_error) throw new Error("Cursor returned an error result");
  if (typeof envelope.result !== "string") throw new Error("Cursor result is missing the final message");
  return parseResult(extractCursorResult(envelope.result), r.role, r.allowedNextRoles, r.consultationFrom);
 }
}

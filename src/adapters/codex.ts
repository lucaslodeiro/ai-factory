import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { ExecutionManager } from "../execution-manager.js";
import { resultSchemaFor, parseResult } from "../results.js";
import type { AgentAdapter, AgentRunRequest } from "./agent.js";
export class CodexAdapter implements AgentAdapter {
 constructor(private executions: ExecutionManager) {}
 async run(r: AgentRunRequest) {
  if (r.selection.provider !== "codex") throw new Error("Model selection/provider mismatch");
  const dir = path.join(config.dataDir, "outputs", randomUUID()); fs.mkdirSync(dir, { recursive: true });
  const schema = path.join(dir, "schema.json"), output = path.join(dir, "result.json");
  fs.writeFileSync(schema, JSON.stringify(resultSchemaFor(r.role, r.allowedNextRoles)));
  const sandboxArgs = ["product-architect","reviewer"].includes(r.role) ? ["--sandbox","read-only"] : ["--sandbox","workspace-write","--config","sandbox_workspace_write.network_access=true"];
  const modelArgs = r.selection.model === "auto" ? [] : ["--model", r.selection.model];
  await this.executions.run(r.workItemId, r.role, config.codexCommand,
   ["exec", ...modelArgs, "--ephemeral", ...sandboxArgs, "--output-schema", schema, "--output-last-message", output, "-"], r.cwd, r.instructions, config.timeoutMs, r.selection,r.promptMetadata,r.executionId,r.localRuntimeUrl);
  return parseResult(JSON.parse(fs.readFileSync(output, "utf8")), r.role, r.allowedNextRoles, r.consultationFrom);
 }
}

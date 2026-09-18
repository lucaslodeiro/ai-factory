import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { ExecutionManager } from "../execution-manager.js";
import { resultSchema, parseResult } from "../results.js";
import type { AgentAdapter, AgentRunRequest } from "./agent.js";
export class CodexAdapter implements AgentAdapter {
 constructor(private executions: ExecutionManager) {}
 async run(r: AgentRunRequest) {
  const dir = path.join(config.dataDir, "outputs", randomUUID()); fs.mkdirSync(dir, { recursive: true });
  const schema = path.join(dir, "schema.json"), output = path.join(dir, "result.json");
  fs.writeFileSync(schema, JSON.stringify(resultSchema));
  await this.executions.run(r.workItemId, r.role, config.codexCommand,
   ["exec", "--ephemeral", "--sandbox", "workspace-write", "--config", "sandbox_workspace_write.network_access=true", "--output-schema", schema, "--output-last-message", output, "-"], r.cwd, r.instructions);
  return parseResult(JSON.parse(fs.readFileSync(output, "utf8")), r.role);
 }
}

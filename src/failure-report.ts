import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import type { Store } from "./storage.js";
import type { AgentRole, WorkItem, WorkState } from "./types.js";

const roleLabels: Record<AgentRole,string> = { "product-architect":"Product Architect",developer:"Developer",qa:"QA",reviewer:"Reviewer" };
const stageRoles: Partial<Record<WorkState,AgentRole>> = { SPEC:"product-architect",DEVELOPMENT:"developer",QA:"qa",REVIEW:"reviewer" };
const stageLabels: Partial<Record<WorkState,string>> = { SPEC:"Product Architect",WAITING_HUMAN:"human input",DEVELOPMENT:"Development",QA:"QA",REVIEW:"Review" };
const stageLabel = (state: WorkState) => stageLabels[state] ?? state;

function sanitize(value: unknown, limit = 4000) {
  let text=String(value ?? "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g,"")
    .replace(/\x1B[@-_]/g,"")
    .replace(/\r/g,"")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,"Bearer [REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|npm_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})\b/g,"[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,"[REDACTED]")
    .replace(/\b(api[_-]?key|token|authorization|password|secret|webhook)(\s*[=:]\s*|["']:\s*["'])([^\s"'`]+)/gi,"$1$2[REDACTED]")
    .replace(/(https?:\/\/[^\s:/]+:)[^\s@/]+@/gi,"$1[REDACTED]@")
    .replace(/Authorization:[ \t]*(?:Bearer[ \t]+)?(?:\[REDACTED\][ \t]*)+/gi,"Authorization: [REDACTED]");
  for (const [name,secret] of Object.entries(process.env)) {
    if (!secret || secret.length<6 || !/(?:KEY|TOKEN|SECRET|PASSWORD|WEBHOOK)/i.test(name)) continue;
    text=text.split(secret).join("[REDACTED]");
  }
  for (const [local,replacement] of [[config.dataDir,"<factory-data>"],[config.repoDir,"<target-checkout>"],[os.homedir(),"~"]] as const) {
    if (local) text=text.split(local).join(replacement);
  }
  text=text.replace(/```/g,"` ` `").trim();
  return text.length>limit ? `…${text.slice(-(limit-1))}` : text;
}

function tail(file: string, maxLines = 30) {
  try {
    const stat=fs.statSync(file),bytes=Math.min(stat.size,64*1024),buffer=Buffer.alloc(bytes),handle=fs.openSync(file,"r");
    try { if (bytes) fs.readSync(handle,buffer,0,bytes,stat.size-bytes); } finally { fs.closeSync(handle); }
    let text=buffer.toString("utf8");
    if (stat.size>bytes) { const newline=text.indexOf("\n"); text=newline>=0 ? text.slice(newline+1) : ""; }
    const lines=text.split(/\r?\n/); while (lines.at(-1)==="") lines.pop();
    return sanitize(lines.slice(-maxLines).join("\n"));
  } catch { return ""; }
}

export function failureMarkdown(store: Store, w: WorkItem, error: unknown) {
  const stage=w.context.resume ?? w.context.pendingStage?.stage ?? w.state;
  const expectedRole=stageRoles[stage];
  const latest=store.db.prepare("SELECT id,role,status,started_at,finished_at,exit_code FROM executions WHERE work_item_id=? ORDER BY started_at DESC LIMIT 1").get(w.id) as {id:string;role:AgentRole;status:string;started_at:string;finished_at:string|null;exit_code:number|null} | undefined;
  const run=latest && (!expectedRole || latest.role===expectedRole) ? latest : undefined;
  const selectionRow=run ? store.db.prepare("SELECT payload FROM events WHERE run_id=? AND type='execution.started' ORDER BY id DESC LIMIT 1").get(run.id) as {payload:string} | undefined : undefined;
  let selection: {selection?:{provider?:string;model?:string}} = {};
  try { selection=JSON.parse(selectionRow?.payload ?? "{}"); } catch {}
  const stderr=run && path.basename(run.id)===run.id ? tail(path.join(config.dataDir,"runs",run.id,"stderr.log")) : "";
  const reason=sanitize(error,1600) || "The workflow stopped without an error message.";
  const facts=[`**Stage:** ${stageLabel(stage)}`];
  if (run) {
    facts.push(`**Agent:** ${roleLabels[run.role]}`);
    if (selection.selection?.provider || selection.selection?.model) facts.push(`**Provider / model:** ${[selection.selection.provider,selection.selection.model].filter(Boolean).join(" · ")}`);
    facts.push(`**Execution:** \`${run.id}\``);
    facts.push(`**Process result:** ${run.status}${run.exit_code === null ? "" : ` · exit ${run.exit_code}`}`);
  }
  const troubleshooting=stderr
    ? `\n\n<details>\n<summary>Last ${Math.min(30,stderr.split("\n").length)} stderr lines</summary>\n\n\`\`\`text\n${stderr}\n\`\`\`\n\n</details>`
    : `\n\n_No stderr output was available. Use **Daemon logs** in the dashboard for additional context._`;
  return `## Execution failed\n\n${facts.join("  \n")}\n\n### What happened\n\n${reason}\n\n### Troubleshooting${troubleshooting}\n\n### How to continue\n\n1. Correct the reported cause.\n2. Post a new comment containing exactly:\n\n\`\`\`text\n/factory retry\n\`\`\`\n\nYou can also use **Retry** in the dashboard or run \`npm run factory -- retry ${w.id}\`.`;
}

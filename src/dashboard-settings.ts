import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

type Field = { key: string; label: string; description: string; group: string; secret?: boolean; required?: boolean; type?: "number" | "text" };

const descriptions: Record<string,Omit<Field,"key">> = {
  FACTORY_DATA_DIR:{label:"Data directory",description:"SQLite, logs and retained worktrees.",group:"Factory",required:true},
  FACTORY_REPO_DIR:{label:"Target checkout",description:"Absolute path to the application clone.",group:"Target",required:true},
  FACTORY_POLL_INTERVAL_MS:{label:"Polling interval",description:"Milliseconds between GitHub polls.",group:"Factory",type:"number"},
  FACTORY_EXECUTION_TIMEOUT_MS:{label:"Agent timeout",description:"Maximum milliseconds for one agent execution.",group:"Factory",type:"number"},
  FACTORY_MAX_FIX_CYCLES:{label:"Correction cycles",description:"Maximum automatic developer/QA correction loops.",group:"Factory",type:"number"},
  FACTORY_DASHBOARD_HOST:{label:"Dashboard host",description:"Loopback address used by this dashboard.",group:"Dashboard",required:true},
  FACTORY_DASHBOARD_PORT:{label:"Dashboard port",description:"Local HTTP port; restart dashboard after changing it.",group:"Dashboard",type:"number",required:true},
  GITHUB_REPOSITORY:{label:"GitHub repository",description:"Owner/name used for issues and pull requests.",group:"Target",required:true},
  GITHUB_DEFAULT_BRANCH:{label:"Default branch",description:"Base branch for worktrees and pull requests.",group:"Target",required:true},
  FACTORY_APPROVERS:{label:"Approvers",description:"Comma-separated GitHub logins allowed to approve.",group:"Target",required:true},
  SLACK_WEBHOOK_URL:{label:"Slack webhook",description:"Optional. Leave blank to keep the configured secret.",group:"Notifications",secret:true},
  CODEX_COMMAND:{label:"Codex command",description:"Absolute Codex CLI path.",group:"Tools",required:true},
  CLAUDE_COMMAND:{label:"Claude command",description:"Absolute Claude CLI path.",group:"Tools",required:true},
  GIT_COMMAND:{label:"Git command",description:"Absolute Git executable path.",group:"Tools",required:true},
  AGENT_SECRET_ALLOWLIST:{label:"Agent secret allowlist",description:"Extra environment variable names forwarded to agents.",group:"Security"},
  CODEX_MODEL_FAST:{label:"Codex fast",description:"Model for low-complexity Codex work.",group:"Models",required:true},
  CODEX_MODEL_BALANCED:{label:"Codex balanced",description:"Model for standard Codex work.",group:"Models",required:true},
  CODEX_MODEL_STRONG:{label:"Codex strong",description:"Model for demanding Codex work.",group:"Models",required:true},
  CLAUDE_MODEL_FAST:{label:"Claude fast",description:"Model for low-complexity Claude work.",group:"Models",required:true},
  CLAUDE_MODEL_BALANCED:{label:"Claude balanced",description:"Model for standard Claude work.",group:"Models",required:true},
  CLAUDE_MODEL_STRONG:{label:"Claude strong",description:"Model for demanding Claude work.",group:"Models",required:true},
};

function encode(value: string) {
  if (/[\r\n\0]/.test(value)) throw new Error("Use a single line");
  for (const quote of ["'", "`", '"']) if (!value.includes(quote) && !(quote === '"' && /\\[nr]/.test(value))) return quote + value + quote;
  throw new Error("Value contains an unsupported combination of quotes");
}
function validate(key: string, value: string) {
  encode(value);
  if (/_MS$/.test(key) || key === "FACTORY_MAX_FIX_CYCLES") {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error(`${key}: enter a positive integer`);
  }
  if (key === "FACTORY_DASHBOARD_PORT" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new Error(`${key}: enter a port from 1 to 65535`);
  if (key === "FACTORY_DASHBOARD_HOST" && !["127.0.0.1","localhost","::1"].includes(value)) throw new Error(`${key}: use 127.0.0.1, localhost or ::1`);
  if (key === "GITHUB_REPOSITORY" && value && !/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error(`${key}: use owner/repository`);
  if (key === "FACTORY_APPROVERS" && value && !value.split(",").every(item => /^[a-zA-Z0-9-]+$/.test(item.trim()))) throw new Error(`${key}: use comma-separated GitHub usernames`);
  if (key === "AGENT_SECRET_ALLOWLIST" && value && !value.split(",").every(item => /^[A-Za-z_][A-Za-z0-9_]*$/.test(item.trim()))) throw new Error(`${key}: use comma-separated environment variable names`);
  if (key.includes("_MODEL_") && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)) throw new Error(`${key}: enter a model identifier`);
  if (["FACTORY_DATA_DIR","GITHUB_DEFAULT_BRANCH","CODEX_COMMAND","CLAUDE_COMMAND","GIT_COMMAND","FACTORY_DASHBOARD_HOST","FACTORY_DASHBOARD_PORT"].includes(key) && !value.trim()) throw new Error(`${key}: this value cannot be empty`);
  if (key === "SLACK_WEBHOOK_URL" && value) {
    let url: URL; try { url = new URL(value); } catch { throw new Error(`${key}: enter an HTTPS URL`); }
    if (url.protocol !== "https:") throw new Error(`${key}: enter an HTTPS URL`);
  }
}

function files(root: string) {
  return { template:path.join(root,".env.example"), env:path.join(root,".env") };
}
export function readDashboardSettings(root: string) {
  const names = files(root);
  const template = fs.readFileSync(names.template,"utf8");
  const defaults = parse(template);
  const saved = fs.existsSync(names.env) ? parse(fs.readFileSync(names.env,"utf8")) : {};
  const values = {...defaults,...saved};
  const fields = Object.keys(defaults).map(key => {
    const meta = descriptions[key] ?? {label:key,description:"Factory setting.",group:"Other"};
    return {key,...meta,value:meta.secret ? "" : values[key] ?? "",configured:meta.secret ? Boolean(values[key]) : undefined};
  });
  return { fields };
}
export function saveDashboardSettings(root: string, changes: Record<string,unknown>, clearSecrets: string[] = []) {
  const names = files(root);
  const template = fs.readFileSync(names.template,"utf8");
  const original = fs.existsSync(names.env) ? fs.readFileSync(names.env,"utf8") : null;
  const defaults = parse(template), saved = parse(original ?? ""), values: Record<string,string> = {...defaults,...saved};
  for (const [key,input] of Object.entries(changes)) {
    if (!(key in defaults)) throw new Error(`Unknown setting: ${key}`);
    if (typeof input !== "string") throw new Error(`${key}: expected text`);
    if (descriptions[key]?.secret && input === "" && !clearSecrets.includes(key)) continue;
    values[key] = input.trim();
  }
  for (const key of clearSecrets) {
    if (!descriptions[key]?.secret) throw new Error(`Cannot clear non-secret setting: ${key}`);
    values[key] = "";
  }
  for (const key of Object.keys(defaults)) validate(key,values[key] ?? "");
  let output = template.replace(/^([A-Z_][A-Z0-9_]*)=.*$/gm,(_,key) => `${key}=${encode(values[key] ?? "")}`);
  for (const [key,value] of Object.entries(saved)) if (!(key in defaults)) output += `\n${key}=${encode(value)}`;
  if ((fs.existsSync(names.env) ? fs.readFileSync(names.env,"utf8") : null) !== original) throw new Error("Configuration changed while saving; reload and retry");
  if (original !== null) fs.writeFileSync(path.join(root,`.env.backup-${Date.now()}-${process.pid}`),original,{flag:"wx",mode:0o600});
  const temporary = `${names.env}.tmp-${process.pid}`;
  try { fs.writeFileSync(temporary,output,{flag:"wx",mode:0o600}); fs.renameSync(temporary,names.env); }
  finally { fs.rmSync(temporary,{force:true}); }
  return readDashboardSettings(root);
}

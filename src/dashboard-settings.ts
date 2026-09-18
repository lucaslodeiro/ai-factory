import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

type Option = { value: string; label: string };
type Field = { key: string; label: string; description: string; group: string; secret?: boolean; required?: boolean; type?: "number" | "text" | "select"; options?: Option[]; unit?: string; restart?: "daemon" | "dashboard" | "all"; hidden?: boolean; section?: string; role?: string; profile?: "fast" | "balanced" | "strong"; kind?: "provider" | "role-model" };

const groups = [
  {id:"credentials",label:"Credentials",description:"Authentication for the services used by the factory."},
  {id:"project",label:"Project & GitHub",description:"Repository, checkout and delivery workflow."},
  {id:"runtime",label:"Runtime",description:"Storage, polling and execution limits."},
  {id:"dashboard",label:"Dashboard",description:"Local administration server."},
  {id:"models",label:"Agent roles",description:"Provider and task-aware model selection for every factory role."},
  {id:"tools",label:"Agent tools",description:"Executables used by workers and Git operations."},
  {id:"access",label:"Access & secrets",description:"Human approvers and environment exposure."},
  {id:"notifications",label:"Notifications",description:"Optional outbound integrations."},
];
const codexModels = ["gpt-5.6-luna","gpt-5.6-terra","gpt-5.6-sol","gpt-6-astra","gpt-5.5"].map(value => ({value,label:value}));
const claudeModels = ["haiku","sonnet","opus"].map(value => ({value,label:value}));
const providerOptions = [{value:"codex",label:"Codex"},{value:"claude",label:"Claude"}];
const roleField = (section: string, role: string, label: string): Omit<Field,"key"> => ({label:"Provider",description:`CLI that executes the ${label} role.`,group:"models",type:"select",options:providerOptions,required:true,restart:"daemon",section,role,kind:"provider"});
const modelField = (section: string, role: string, profile: "fast" | "balanced" | "strong"): Omit<Field,"key"> => ({label:`${profile[0].toUpperCase()}${profile.slice(1)} model`,description:profile === "fast" ? "Used for eligible low-complexity, low-risk work." : profile === "balanced" ? "Used for standard work and role quality floors." : "Used for high-risk, high-complexity and correction work.",group:"models",type:"select",required:true,restart:"daemon",section,role,profile,kind:"role-model"});

const descriptions: Record<string,Omit<Field,"key">> = {
  FACTORY_DATA_DIR:{label:"Data directory",description:"SQLite database, logs and retained worktrees.",group:"runtime",required:true,restart:"all"},
  FACTORY_REPO_DIR:{label:"Target checkout",description:"Absolute path to the application clone.",group:"project",required:true,restart:"daemon"},
  FACTORY_POLL_INTERVAL_MS:{label:"GitHub polling interval",description:"How often the daemon checks issues and comments.",group:"runtime",type:"number",unit:"milliseconds",restart:"daemon"},
  FACTORY_EXECUTION_TIMEOUT_MS:{label:"Agent execution timeout",description:"Maximum duration of one agent process.",group:"runtime",type:"number",unit:"milliseconds",restart:"daemon"},
  FACTORY_MAX_FIX_CYCLES:{label:"Automatic correction cycles",description:"Maximum Developer and QA correction loops before human input.",group:"runtime",type:"number",unit:"cycles",restart:"daemon"},
  FACTORY_DASHBOARD_HOST:{label:"Listen address",description:"Loopback address used by the administration UI.",group:"dashboard",type:"select",options:["127.0.0.1","localhost","::1"].map(value => ({value,label:value})),required:true,restart:"dashboard"},
  FACTORY_DASHBOARD_PORT:{label:"HTTP port",description:"Local port for the administration UI.",group:"dashboard",type:"number",unit:"port",required:true,restart:"dashboard"},
  GITHUB_REPOSITORY:{label:"Repository",description:"GitHub owner/name used for issues and pull requests.",group:"project",required:true,restart:"daemon"},
  GITHUB_DEFAULT_BRANCH:{label:"Default branch",description:"Base branch for worktrees and pull requests.",group:"project",required:true,restart:"daemon"},
  FACTORY_APPROVERS:{label:"Authorized approvers",description:"Comma-separated GitHub logins allowed to answer and approve.",group:"access",required:true,restart:"daemon"},
  SLACK_WEBHOOK_URL:{label:"Slack webhook",description:"Optional HTTPS webhook. Blank preserves the configured secret.",group:"notifications",secret:true,restart:"daemon"},
  CODEX_COMMAND:{label:"Codex CLI",description:"Absolute path or command used to start Codex.",group:"tools",required:true,restart:"daemon"},
  CLAUDE_COMMAND:{label:"Claude CLI",description:"Absolute path or command used to start Claude.",group:"tools",required:true,restart:"daemon"},
  GIT_COMMAND:{label:"Git executable",description:"Absolute path or command used for Git operations.",group:"tools",required:true,restart:"all"},
  AGENT_SECRET_ALLOWLIST:{label:"Agent environment allowlist",description:"Extra environment variable names forwarded to worker processes.",group:"access",restart:"daemon"},
  CODEX_MODEL_FAST:{label:"Codex · Fast",description:"Provider fallback.",group:"models",hidden:true},
  CODEX_MODEL_BALANCED:{label:"Codex · Balanced",description:"Provider fallback.",group:"models",hidden:true},
  CODEX_MODEL_STRONG:{label:"Codex · Strong",description:"Provider fallback.",group:"models",hidden:true},
  CLAUDE_MODEL_FAST:{label:"Claude · Fast",description:"Provider fallback.",group:"models",hidden:true},
  CLAUDE_MODEL_BALANCED:{label:"Claude · Balanced",description:"Provider fallback.",group:"models",hidden:true},
  CLAUDE_MODEL_STRONG:{label:"Claude · Strong",description:"Provider fallback.",group:"models",hidden:true},
  PRODUCT_ARCHITECT_PROVIDER:roleField("Product / Architect","product-architect","Product / Architect"),
  PRODUCT_ARCHITECT_MODEL_FAST:modelField("Product / Architect","product-architect","fast"),
  PRODUCT_ARCHITECT_MODEL_BALANCED:modelField("Product / Architect","product-architect","balanced"),
  PRODUCT_ARCHITECT_MODEL_STRONG:modelField("Product / Architect","product-architect","strong"),
  DEVELOPER_PROVIDER:roleField("Developer","developer","Developer"),
  DEVELOPER_MODEL_FAST:modelField("Developer","developer","fast"),
  DEVELOPER_MODEL_BALANCED:modelField("Developer","developer","balanced"),
  DEVELOPER_MODEL_STRONG:modelField("Developer","developer","strong"),
  QA_PROVIDER:roleField("QA","qa","QA"),
  QA_MODEL_FAST:modelField("QA","qa","fast"),
  QA_MODEL_BALANCED:modelField("QA","qa","balanced"),
  QA_MODEL_STRONG:modelField("QA","qa","strong"),
  REVIEWER_PROVIDER:roleField("Reviewer","reviewer","Reviewer"),
  REVIEWER_MODEL_FAST:modelField("Reviewer","reviewer","fast"),
  REVIEWER_MODEL_BALANCED:modelField("Reviewer","reviewer","balanced"),
  REVIEWER_MODEL_STRONG:modelField("Reviewer","reviewer","strong"),
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
  if (key.endsWith("_PROVIDER") && !["codex","claude"].includes(value)) throw new Error(`${key}: choose codex or claude`);
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
  const providerCatalog = {
    codex:{options:codexModels,defaults:{fast:values.CODEX_MODEL_FAST,balanced:values.CODEX_MODEL_BALANCED,strong:values.CODEX_MODEL_STRONG}},
    claude:{options:claudeModels,defaults:{fast:values.CLAUDE_MODEL_FAST,balanced:values.CLAUDE_MODEL_BALANCED,strong:values.CLAUDE_MODEL_STRONG}},
  };
  const fields = Object.keys(defaults).map(key => {
    const meta = descriptions[key] ?? {label:key,description:"Factory setting.",group:"Other"};
    const value = meta.secret ? "" : values[key] ?? "";
    let baseOptions = meta.options;
    if (meta.kind === "role-model") {
      const prefix = key.slice(0,key.indexOf("_MODEL_")), selectedProvider = values[`${prefix}_PROVIDER`] === "claude" ? "claude" : "codex";
      const catalog = providerCatalog[selectedProvider];
      baseOptions = [...catalog.options];
      const inherited = catalog.defaults[meta.profile!];
      if (inherited && !baseOptions.some(option => option.value === inherited)) baseOptions.push({value:inherited,label:`${inherited} (provider default)`});
    }
    const options = baseOptions && value && !baseOptions.some(option => option.value === value) ? [...baseOptions,{value,label:`${value} (current custom value)`}] : baseOptions;
    return {key,...meta,options,value,configured:meta.secret ? Boolean(values[key]) : undefined};
  }).filter(field => !field.hidden);
  return { groups,fields,modelCatalog:providerCatalog };
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

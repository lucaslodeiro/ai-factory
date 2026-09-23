import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import { roleFullName } from "./names.js";
import { factoryHome } from "./home.js";

type Option = { value: string; label: string };
type Field = { key: string; label: string; description: string; group: string; scope?: string; secret?: boolean; required?: boolean; type?: "number" | "text" | "select"; options?: Option[]; unit?: string; restart?: "daemon" | "dashboard" | "all"; hidden?: boolean; section?: string; role?: string; kind?: "provider" | "role-model"; setup?: boolean };

const groups = [
  {id:"connections",label:"Connections",description:"GitHub, agent providers and Slack."},
  {id:"project",label:"Project",description:"Repository, checkout, approvers and this installation's identity."},
  {id:"workflow",label:"Workflow",description:"Verification behavior and workflow commands."},
  {id:"limits",label:"Limits & quotas",description:"An epic and its stories share one token budget. Each story has its own executions and correction cycles; labels below show the scope of each setting."},
  {id:"agents",label:"Agents",description:"Provider and model selection for each workflow role."},
  {id:"tools",label:"Tools",description:"Commands used to run Codex, Claude, Cursor and Git."},
  {id:"service",label:"Service",description:"Storage, polling and the local dashboard server."},
  {id:"advanced",label:"Advanced",description:"Worker environment and troubleshooting."},
];
const automaticModel = {value:"auto",label:"Auto (provider recommended)"};
const codexModels = [automaticModel,...["gpt-6-astra","gpt-6-sol","gpt-6-luna","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.5"].map(value=>({value,label:value}))];
const claudeModels = [automaticModel,...["fable","opus","sonnet","haiku"].map(value => ({value,label:value}))];
// Curated CLI IDs; account availability still varies. Other IDs can be entered manually.
const cursorModels = [automaticModel,...["composer-2.5","gpt-5","sonnet-4-thinking"].map(value=>({value,label:value}))];
const providerOptions = [{value:"codex",label:"Codex"},{value:"claude",label:"Claude"},{value:"cursor",label:"Cursor"}];
const roleField = (section: string, role: string, label: string): Omit<Field,"key"> => ({label:"Provider",description:`Provider used for the ${label} role.`,group:"agents",type:"select",options:providerOptions,required:true,restart:"daemon",section,role,kind:"provider"});
const modelField = (section: string, role: string): Omit<Field,"key"> => ({label:"Model",description:"Choose a suggested model or type an exact model ID. Auto lets the provider choose; available models depend on the connected account.",group:"agents",type:"select",required:true,restart:"daemon",section,role,kind:"role-model"});

const descriptions: Record<string,Omit<Field,"key">> = {
  FACTORY_DATA_DIR:{label:"Data directory",description:"SQLite database, logs and retained worktrees.",group:"service",required:true,restart:"all"},
  FACTORY_REPO_DIR:{label:"Target checkout",description:"Path to the application checkout. Startup clones it if missing and initializes an empty remote.",group:"project",required:true,restart:"all",setup:true},
  FACTORY_INSTANCE_NAME:{label:"Instance name",description:"Name used to identify this Factory in GitHub issue labels. Empty uses the machine hostname.",group:"project",restart:"daemon",setup:true},
  FACTORY_POLL_INTERVAL_MS:{label:"GitHub polling interval",description:"How often the daemon checks issues and comments.",group:"service",type:"number",unit:"milliseconds",restart:"daemon"},
  FACTORY_EXECUTION_TIMEOUT_MS:{label:"Agent execution timeout",description:"Maximum duration of one agent process.",group:"limits",type:"number",unit:"milliseconds",restart:"daemon"},
  FACTORY_VERIFY_COMMAND:{label:"Verification command",description:"Shell command the factory runs after the Tester stage. Empty disables factory verification.",group:"workflow",restart:"daemon"},
  FACTORY_MAX_FIX_CYCLES:{label:"Automatic corrections",description:"Builder corrections the factory makes on its own before asking for human guidance. 0 asks at the first change request.",group:"limits",type:"number",unit:"corrections",restart:"daemon"},
  FACTORY_BRIEF_TARGET_CHARS:{label:"Brief target",description:"Suggested brief length; a longer complete brief remains valid.",group:"limits",type:"number",unit:"characters",restart:"daemon"},
  FACTORY_SPEC_TARGET_CHARS:{label:"Spec target",description:"Suggested spec length; a longer complete spec remains valid.",group:"limits",type:"number",unit:"characters",restart:"daemon"},
  FACTORY_SUMMARY_TARGET_CHARS:{label:"Summary target",description:"Suggested summary length; a longer complete result remains valid.",group:"limits",type:"number",unit:"characters",restart:"daemon"},
  FACTORY_MAX_QUESTIONS:{label:"Architect questions",description:"Maximum clarification questions in one result.",group:"limits",type:"number",unit:"questions",restart:"daemon"},
  FACTORY_MAX_HUMAN_DECISIONS:{label:"Human decisions",description:"Maximum decisions requested in a brief; writing guidance, not a rejection rule.",group:"limits",type:"number",unit:"decisions",restart:"daemon"},
  FACTORY_MAX_STORIES:{label:"Stories per issue",description:"Maximum stories in an approved split.",group:"limits",type:"number",unit:"stories",restart:"daemon"},
  FACTORY_RESULT_MAX_ITEMS:{label:"Items per result list",description:"Safety cap for findings, tests, coverage and other result lists.",group:"limits",type:"number",unit:"items",restart:"daemon"},
  FACTORY_STRUCTURED_OUTPUT_RETRIES:{label:"Structured output attempts",description:"Maximum Claude attempts to satisfy the result schema within one execution.",group:"limits",type:"number",unit:"attempts",restart:"daemon"},
  FACTORY_RECOVERABLE_ERROR_RETRIES:{label:"Recoverable error retries",description:"Extra executions after an invalid result or transient provider error. 0 asks for human retry immediately.",group:"limits",type:"number",unit:"retries",restart:"daemon"},
  FACTORY_TOKEN_BUDGET_GRACE_PERCENT:{label:"Token budget grace",description:"Extra percentage allowed for a running agent after the issue token budget is reached.",group:"limits",type:"number",unit:"percent",restart:"daemon"},
  FACTORY_VERIFY_TIMEOUT_MS:{label:"Verification timeout",description:"Maximum duration of the verification command.",group:"limits",type:"number",unit:"milliseconds",restart:"daemon"},
  FACTORY_ISSUE_BUDGET_TOKENS:{label:"Shared token budget",description:"One budget covers the epic and every story, including all runs and cached tokens. An approver can extend it for the whole family.",group:"limits",type:"number",unit:"tokens",restart:"daemon"},
  FACTORY_BUDGET_UNMETERED_ROLES:{label:"Roles without usage reporting",description:"Comma-separated roles (architect, designer, builder, tester, reviewer) allowed to run without reported token usage.",group:"limits",restart:"daemon"},
  FACTORY_CONTEXT_BUDGET_BYTES:{label:"Default context budget",description:"Maximum prompt bytes before optional context is omitted.",group:"limits",type:"number",unit:"bytes",restart:"daemon"},
  FACTORY_ARTIFACT_RETENTION_DAYS:{label:"Artifact retention",description:"Days to retain exact prompt and execution output after completion or cancellation. Use 0 to disable pruning.",group:"limits",type:"number",unit:"days",restart:"daemon"},
  FACTORY_CONTEXT_BUDGET_OVERRIDES:{label:"Context budget overrides",description:'Optional JSON object keyed by role or "provider/model". Provider/model wins over role.',group:"limits",restart:"daemon"},
  FACTORY_DASHBOARD_HOST:{label:"Listen address",description:"Loopback address used by the administration UI.",group:"service",type:"select",options:["127.0.0.1","localhost","::1"].map(value => ({value,label:value})),required:true,restart:"dashboard"},
  FACTORY_DASHBOARD_PORT:{label:"HTTP port",description:"Local port for the administration UI.",group:"service",type:"number",unit:"port",required:true,restart:"dashboard"},
  GITHUB_REPOSITORY:{label:"Repository",description:"GitHub owner/name used for issues and pull requests.",group:"project",required:true,restart:"all",setup:true},
  GITHUB_DEFAULT_BRANCH:{label:"Default branch (auto-filled)",description:"Filled from GitHub when the repository changes; editable later for troubleshooting.",group:"project",required:true,restart:"all"},
  FACTORY_APPROVERS:{label:"Authorized approvers",description:"Comma-separated GitHub logins allowed to answer and approve.",group:"project",required:true,restart:"daemon",setup:true},
  SLACK_WEBHOOK_URL:{label:"Slack webhook",description:"Optional HTTPS Incoming Webhook URL. Leave it blank to preserve the configured secret.",group:"connections",secret:true,restart:"daemon"},
  CODEX_COMMAND:{label:"Codex command",description:"Absolute path or command used to start Codex.",group:"tools",required:true,restart:"all"},
  CLAUDE_COMMAND:{label:"Claude command",description:"Absolute path or command used to start Claude.",group:"tools",required:true,restart:"all"},
  CURSOR_COMMAND:{label:"Cursor command",description:"Absolute path or command used to start the Cursor Agent CLI.",group:"tools",required:true,restart:"all"},
  GIT_COMMAND:{label:"Git command",description:"Absolute path or command used for Git operations.",group:"tools",required:true,restart:"all"},
  AGENT_SECRET_ALLOWLIST:{label:"Agent environment allowlist",description:"Extra environment variable names forwarded to worker processes.",group:"advanced",restart:"daemon"},
  PRODUCT_ARCHITECT_PROVIDER:roleField(roleFullName("product-architect"),"product-architect",roleFullName("product-architect")),
  PRODUCT_ARCHITECT_MODEL:modelField(roleFullName("product-architect"),"product-architect"),
  DESIGNER_PROVIDER:roleField(roleFullName("designer"),"designer",roleFullName("designer")),
  DESIGNER_MODEL:modelField(roleFullName("designer"),"designer"),
  DEVELOPER_PROVIDER:roleField(roleFullName("developer"),"developer",roleFullName("developer")),
  DEVELOPER_MODEL:modelField(roleFullName("developer"),"developer"),
  QA_PROVIDER:roleField(roleFullName("qa"),"qa",roleFullName("qa")),
  QA_MODEL:modelField(roleFullName("qa"),"qa"),
  REVIEWER_PROVIDER:roleField(roleFullName("reviewer"),"reviewer",roleFullName("reviewer")),
  REVIEWER_MODEL:modelField(roleFullName("reviewer"),"reviewer"),
};
const fieldOrder=["SLACK_WEBHOOK_URL","GITHUB_REPOSITORY","FACTORY_REPO_DIR","GITHUB_DEFAULT_BRANCH","FACTORY_APPROVERS","FACTORY_INSTANCE_NAME","FACTORY_VERIFY_COMMAND","FACTORY_BRIEF_TARGET_CHARS","FACTORY_SPEC_TARGET_CHARS","FACTORY_SUMMARY_TARGET_CHARS","FACTORY_MAX_QUESTIONS","FACTORY_MAX_HUMAN_DECISIONS","FACTORY_MAX_STORIES","FACTORY_RESULT_MAX_ITEMS","FACTORY_MAX_FIX_CYCLES","FACTORY_ISSUE_BUDGET_TOKENS","FACTORY_TOKEN_BUDGET_GRACE_PERCENT","FACTORY_BUDGET_UNMETERED_ROLES","FACTORY_EXECUTION_TIMEOUT_MS","FACTORY_VERIFY_TIMEOUT_MS","FACTORY_STRUCTURED_OUTPUT_RETRIES","FACTORY_RECOVERABLE_ERROR_RETRIES","FACTORY_CONTEXT_BUDGET_BYTES","FACTORY_CONTEXT_BUDGET_OVERRIDES","FACTORY_ARTIFACT_RETENTION_DAYS","PRODUCT_ARCHITECT_PROVIDER","PRODUCT_ARCHITECT_MODEL","DESIGNER_PROVIDER","DESIGNER_MODEL","DEVELOPER_PROVIDER","DEVELOPER_MODEL","QA_PROVIDER","QA_MODEL","REVIEWER_PROVIDER","REVIEWER_MODEL","CODEX_COMMAND","CLAUDE_COMMAND","CURSOR_COMMAND","GIT_COMMAND","FACTORY_DATA_DIR","FACTORY_POLL_INTERVAL_MS","FACTORY_DASHBOARD_HOST","FACTORY_DASHBOARD_PORT","AGENT_SECRET_ALLOWLIST"];
const limitScopes:Record<string,string>={
  FACTORY_BRIEF_TARGET_CHARS:"Issue / epic design",FACTORY_SPEC_TARGET_CHARS:"Issue / epic design",FACTORY_MAX_QUESTIONS:"Issue / epic design",FACTORY_MAX_HUMAN_DECISIONS:"Issue / epic design",FACTORY_MAX_STORIES:"Epic split",
  FACTORY_SUMMARY_TARGET_CHARS:"Each agent result",FACTORY_RESULT_MAX_ITEMS:"Each agent result",FACTORY_MAX_FIX_CYCLES:"Each work item",FACTORY_ISSUE_BUDGET_TOKENS:"Epic + stories · shared",FACTORY_TOKEN_BUDGET_GRACE_PERCENT:"Each running execution",FACTORY_BUDGET_UNMETERED_ROLES:"All roles",
  FACTORY_EXECUTION_TIMEOUT_MS:"Each agent execution",FACTORY_VERIFY_TIMEOUT_MS:"Each verification",FACTORY_STRUCTURED_OUTPUT_RETRIES:"Each Claude execution",FACTORY_RECOVERABLE_ERROR_RETRIES:"Each stage attempt",FACTORY_CONTEXT_BUDGET_BYTES:"Each agent prompt",FACTORY_CONTEXT_BUDGET_OVERRIDES:"Each agent prompt",FACTORY_ARTIFACT_RETENTION_DAYS:"All completed work items",
};
const fieldRank=new Map(fieldOrder.map((key,index)=>[key,index]));

function encode(value: string) {
  if (/[\r\n\0]/.test(value)) throw new Error("Use a single line");
  for (const quote of ["'", "`", '"']) if (!value.includes(quote) && !(quote === '"' && /\\[nr]/.test(value))) return quote + value + quote;
  throw new Error("Value contains an unsupported combination of quotes");
}
export function validateSetting(key: string, value: string) {
  encode(value);
  if (key === "FACTORY_MAX_FIX_CYCLES" && !/^\d+$/.test(value)) throw new Error(`${key}: enter 0 or a positive integer`);
  if (key === "FACTORY_RECOVERABLE_ERROR_RETRIES" && !/^\d+$/.test(value)) throw new Error(`${key}: enter 0 or a positive integer`);
  if (/_MS$/.test(key) || ["FACTORY_CONTEXT_BUDGET_BYTES","FACTORY_ISSUE_BUDGET_TOKENS","FACTORY_BRIEF_TARGET_CHARS","FACTORY_SPEC_TARGET_CHARS","FACTORY_SUMMARY_TARGET_CHARS","FACTORY_MAX_QUESTIONS","FACTORY_MAX_HUMAN_DECISIONS","FACTORY_MAX_STORIES","FACTORY_RESULT_MAX_ITEMS","FACTORY_STRUCTURED_OUTPUT_RETRIES"].includes(key)) {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error(`${key}: enter a positive integer`);
  }
  if(key==="FACTORY_ARTIFACT_RETENTION_DAYS"&&!/^\d+$/.test(value))throw new Error(`${key} must be a nonnegative integer`);
  if(key==="FACTORY_RESULT_MAX_ITEMS"&&Number(value)<7)throw new Error(`${key}: enter at least 7 to allow all review dimensions`);
  if(key==="FACTORY_TOKEN_BUDGET_GRACE_PERCENT"&&(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>100))throw new Error(`${key}: enter a whole percentage from 0 to 100`);
  if (key === "FACTORY_CONTEXT_BUDGET_OVERRIDES") {
    let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw new Error(`${key}: enter a JSON object`);}
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`${key}: enter a JSON object`);
    const roles=new Set(["product-architect","designer","developer","qa","reviewer"]);
    for (const [name,budget] of Object.entries(parsed)) {
      if (!roles.has(name) && !/^(codex|claude|cursor)\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(name)) throw new Error(`${key}: invalid override key ${name}`);
      if (!Number.isSafeInteger(budget) || Number(budget)<1) throw new Error(`${key}: ${name} must be a positive integer`);
    }
  }
  if (key === "FACTORY_DASHBOARD_PORT" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new Error(`${key}: enter a port from 1 to 65535`);
  if (key === "FACTORY_DASHBOARD_HOST" && !["127.0.0.1","localhost","::1"].includes(value)) throw new Error(`${key}: use 127.0.0.1, localhost or ::1`);
  if (key === "GITHUB_REPOSITORY" && value && !/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error(`${key}: use owner/repository`);
  if (key === "FACTORY_APPROVERS" && value && !value.split(",").every(item => /^[a-zA-Z0-9-]+$/.test(item.trim()))) throw new Error(`${key}: use comma-separated GitHub usernames`);
  if(key==="FACTORY_INSTANCE_NAME"&&value&&!/^[a-zA-Z0-9-]{1,40}$/.test(value))throw new Error(`${key}: use at most 40 letters, numbers or hyphens`);
  if (key === "AGENT_SECRET_ALLOWLIST" && value && !value.split(",").every(item => /^[A-Za-z_][A-Za-z0-9_]*$/.test(item.trim()))) throw new Error(`${key}: use comma-separated environment variable names`);
  if (key === "FACTORY_BUDGET_UNMETERED_ROLES" && value && !value.split(",").every(item => ["architect","designer","builder","tester","reviewer","product-architect","developer","qa"].includes(item.trim().toLowerCase()))) throw new Error(`${key}: use comma-separated roles: architect, designer, builder, tester, reviewer`);
  if (key.includes("_MODEL") && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)) throw new Error(`${key}: enter a model identifier`);
  if (key.endsWith("_PROVIDER") && !["codex","claude","cursor"].includes(value)) throw new Error(`${key}: choose codex, claude or cursor`);
  if (["FACTORY_DATA_DIR","GITHUB_DEFAULT_BRANCH","CODEX_COMMAND","CLAUDE_COMMAND","CURSOR_COMMAND","GIT_COMMAND","FACTORY_DASHBOARD_HOST","FACTORY_DASHBOARD_PORT"].includes(key) && !value.trim()) throw new Error(`${key}: this value cannot be empty`);
  if (key === "SLACK_WEBHOOK_URL" && value) {
    let url: URL; try { url = new URL(value); } catch { throw new Error(`${key}: enter an HTTPS URL`); }
    if (url.protocol !== "https:") throw new Error(`${key}: enter an HTTPS URL`);
  }
}

function files(root: string) {
  const home=factoryHome(root);
  return { template:path.join(root,".env.example"), env:path.join(home,".env"),home };
}
function prepareDashboardSettings(root: string, changes: Record<string,unknown>, clearSecrets: string[] = []) {
  const names = files(root);
  const template = fs.readFileSync(names.template,"utf8");
  const original = fs.existsSync(names.env) ? fs.readFileSync(names.env,"utf8") : null;
  const defaults = parse(template), saved = parse(original ?? ""), previous: Record<string,string> = {...defaults,...saved}, values: Record<string,string> = {...previous};
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
  for (const key of Object.keys(defaults)) validateSetting(key,values[key] ?? "");
  let output = template.replace(/^([A-Z_][A-Z0-9_]*)=.*$/gm,(_,key) => `${key}=${encode(values[key] ?? "")}`);
  for (const [key,value] of Object.entries(saved)) if (!(key in defaults)) output += `\n${key}=${encode(value)}`;
  const changedKeys = Object.keys(defaults).filter(key => values[key] !== previous[key]);
  const restartServices = [...new Set(changedKeys.flatMap(key => {
    const restart = descriptions[key]?.restart;
    return restart === "all" ? ["daemon","dashboard"] : restart ? [restart] : [];
  }))] as Array<"daemon" | "dashboard">;
  return { names,original,output,changedKeys,restartServices };
}
export function validateDashboardSettings(root: string, changes: Record<string,unknown>, clearSecrets: string[] = []) {
  const { changedKeys,restartServices } = prepareDashboardSettings(root,changes,clearSecrets);
  return { changedKeys,restartServices };
}
export function readDashboardSetting(root: string, key: string) {
  const names = files(root), defaults = parse(fs.readFileSync(names.template,"utf8"));
  const saved = fs.existsSync(names.env) ? parse(fs.readFileSync(names.env,"utf8")) : {};
  if (!(key in defaults)) throw new Error(`Unknown setting: ${key}`);
  return saved[key] ?? defaults[key] ?? "";
}
export function readDashboardSettings(root: string, suggestions: Record<string,string> = {}) {
  const names = files(root);
  const template = fs.readFileSync(names.template,"utf8");
  const defaults = parse(template);
  const saved = fs.existsSync(names.env) ? parse(fs.readFileSync(names.env,"utf8")) : {};
  const values: Record<string,string> = {...defaults,...saved};
  for (const [key,value] of Object.entries(suggestions)) if (key in defaults && !values[key]) values[key]=value;
  const providerCatalog = {
    codex:{options:codexModels,default:"auto"},
    claude:{options:claudeModels,default:"auto"},
    cursor:{options:cursorModels,default:"auto"},
  };
  const fields = Object.keys(defaults).map(key => {
    const meta = descriptions[key] ?? {label:key,description:"Factory setting.",group:"Other"};
    const value = meta.secret ? "" : values[key] ?? "";
    let baseOptions = meta.options;
    if (meta.kind === "role-model") {
      const prefix = key.slice(0,-"_MODEL".length), selectedProvider = values[`${prefix}_PROVIDER`] === "claude" ? "claude" : values[`${prefix}_PROVIDER`] === "cursor" ? "cursor" : "codex";
      const catalog = providerCatalog[selectedProvider];
      baseOptions = [...catalog.options];
    }
    const options = baseOptions && value && !baseOptions.some(option => option.value === value) ? [...baseOptions,{value,label:`${value} (current custom value)`}] : baseOptions;
    return {key,...meta,scope:meta.group==="limits"?limitScopes[key]:undefined,options,value,suggested:Boolean(value && suggestions[key] === value && !saved[key]),configured:meta.secret ? Boolean(values[key]) : undefined};
  }).filter(field => !field.hidden).sort((a,b)=>(fieldRank.get(a.key)??fieldOrder.length)-(fieldRank.get(b.key)??fieldOrder.length));
  return { groups,fields,modelCatalog:providerCatalog };
}
export function saveDashboardSettings(root: string, changes: Record<string,unknown>, clearSecrets: string[] = []) {
  const { names,original,output } = prepareDashboardSettings(root,changes,clearSecrets);
  if ((fs.existsSync(names.env) ? fs.readFileSync(names.env,"utf8") : null) !== original) throw new Error("Configuration changed while saving; reload and retry");
  if (original !== null) fs.writeFileSync(path.join(names.home,`.env.backup-${Date.now()}-${process.pid}`),original,{flag:"wx",mode:0o600});
  const temporary = `${names.env}.tmp-${process.pid}`;
  try { fs.writeFileSync(temporary,output,{flag:"wx",mode:0o600}); fs.renameSync(temporary,names.env); }
  finally { fs.rmSync(temporary,{force:true}); }
  return readDashboardSettings(root);
}

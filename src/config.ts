import path from "node:path";
import os from "node:os";
import { config as loadEnvironment } from "dotenv";
import { factoryHome } from "./home.js";
import { agentProviders, type AgentProvider, type AgentRole } from "./types.js";
const home=factoryHome();
loadEnvironment({path:path.join(home,".env"),quiet:true});
function positive(name: string, fallback: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}
function nonnegative(name:string,fallback:number){const n=Number(process.env[name]??fallback);if(!Number.isSafeInteger(n)||n<0)throw new Error(`${name} must be a nonnegative integer`);return n;}
function atLeast(name:string,fallback:number,minimum:number){const n=positive(name,fallback);if(n<minimum)throw new Error(`${name} must be at least ${minimum}`);return n;}
function percentage(name:string,fallback:number){const n=nonnegative(name,fallback);if(n>100)throw new Error(`${name} must be at most 100`);return n;}
// Roles whose runs may finish without reported usage without pausing the issue for acknowledgement.
// Older Cursor versions or interrupted runs may omit usage and pause after a run.
function unmeteredRoles(){
  const names:Record<string,AgentRole>={"product-architect":"product-architect",architect:"product-architect",designer:"designer",developer:"developer",builder:"developer",qa:"qa",tester:"qa",reviewer:"reviewer"};
  return [...new Set((process.env.FACTORY_BUDGET_UNMETERED_ROLES ?? "").split(",").map(value=>value.trim().toLowerCase()).filter(Boolean).map(value=>{const role=names[value];if(!role)throw new Error(`FACTORY_BUDGET_UNMETERED_ROLES: unknown role ${value}; use architect, designer, builder, tester or reviewer`);return role;}))];
}
function model(name: string, fallback: string) {
  const value = (process.env[name] ?? fallback).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)) throw new Error(`${name} must be a nonempty model identifier`);
  return value;
}
function provider(name: string, fallback: AgentProvider): AgentProvider {
  const value = (process.env[name] ?? fallback).trim();
  if (!(agentProviders as readonly string[]).includes(value)) throw new Error(`${name} must be ${agentProviders.join(", ")}`);
  return value as AgentProvider;
}
function dashboardHost() {
  const value = (process.env.FACTORY_DASHBOARD_HOST ?? "127.0.0.1").trim();
  if (!["127.0.0.1", "localhost", "::1"].includes(value)) throw new Error("FACTORY_DASHBOARD_HOST must be a loopback address");
  return value;
}
function dashboardPort() {
  const value = positive("FACTORY_DASHBOARD_PORT", 4173);
  if (value > 65535) throw new Error("FACTORY_DASHBOARD_PORT must be at most 65535");
  return value;
}
function contextBudgetOverrides() {
  const raw=(process.env.FACTORY_CONTEXT_BUDGET_OVERRIDES ?? "{}").trim();
  let value:unknown;
  try { value=JSON.parse(raw); } catch { throw new Error("FACTORY_CONTEXT_BUDGET_OVERRIDES must be a JSON object"); }
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("FACTORY_CONTEXT_BUDGET_OVERRIDES must be a JSON object");
  const roles=new Set(["product-architect","designer","developer","qa","reviewer"]),result:Record<string,number>={};
  for (const [key,budget] of Object.entries(value)) {
    if (!roles.has(key) && !/^(codex|claude|cursor)\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(key)) throw new Error(`Invalid context budget override key: ${key}`);
    if (!Number.isSafeInteger(budget) || Number(budget)<1) throw new Error(`Context budget override ${key} must be a positive integer`);
    result[key]=Number(budget);
  }
  return result;
}
export function normalizeInstanceName(input:string){const value=input.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,40).replace(/-+$/g,"");return value||"factory";}
function role(prefix: string, fallback: AgentProvider, fallbackModel: string) {
  const selected = provider(`${prefix}_PROVIDER`,fallback);
  return { provider:selected,model:model(`${prefix}_MODEL`,fallbackModel) };
}
export const config = {
  roles: {
    "product-architect":role("PRODUCT_ARCHITECT","claude","auto"),
    designer:role("DESIGNER","claude","auto"),
    developer:role("DEVELOPER","codex","auto"),
    qa:role("QA","codex","auto"),
    reviewer:role("REVIEWER","claude","auto"),
  },
  home,
  instanceName:normalizeInstanceName(process.env.FACTORY_INSTANCE_NAME?.trim()||os.hostname()),
  dataDir: path.resolve(home,process.env.FACTORY_DATA_DIR ?? "data"),
  repoDir: process.env.FACTORY_REPO_DIR?.trim() ? path.resolve(home,process.env.FACTORY_REPO_DIR.trim()) : undefined,
  pollMs: positive("FACTORY_POLL_INTERVAL_MS", 15000),
  timeoutMs: positive("FACTORY_EXECUTION_TIMEOUT_MS", 600000),
  verifyTimeoutMs: positive("FACTORY_VERIFY_TIMEOUT_MS", 1800000),
  verifyCommand: process.env.FACTORY_VERIFY_COMMAND?.trim() || undefined,
  // Automatic Builder corrections allowed before the issue waits for human guidance.
  maxCycles: nonnegative("FACTORY_MAX_FIX_CYCLES", 1),
  briefTargetChars: positive("FACTORY_BRIEF_TARGET_CHARS",4000),
  specTargetChars: positive("FACTORY_SPEC_TARGET_CHARS",20000),
  summaryTargetChars: positive("FACTORY_SUMMARY_TARGET_CHARS",600),
  maxQuestions: positive("FACTORY_MAX_QUESTIONS",5),
  maxHumanDecisions: positive("FACTORY_MAX_HUMAN_DECISIONS",5),
  maxStories: positive("FACTORY_MAX_STORIES",5),
  resultMaxItems: atLeast("FACTORY_RESULT_MAX_ITEMS",100,7),
  structuredOutputRetries: positive("FACTORY_STRUCTURED_OUTPUT_RETRIES",2),
  recoverableErrorRetries: nonnegative("FACTORY_RECOVERABLE_ERROR_RETRIES",1),
  tokenBudgetGracePercent: percentage("FACTORY_TOKEN_BUDGET_GRACE_PERCENT",25),
  issueBudgetTokens: positive("FACTORY_ISSUE_BUDGET_TOKENS", 2000000),
  budgetUnmeteredRoles: unmeteredRoles(),
  contextBudget:{defaultBytes:positive("FACTORY_CONTEXT_BUDGET_BYTES",200000),overrides:contextBudgetOverrides()},
  artifactRetentionDays:nonnegative("FACTORY_ARTIFACT_RETENTION_DAYS",30),
  dashboardHost: dashboardHost(),
  dashboardPort: dashboardPort(),
  repo: process.env.GITHUB_REPOSITORY ?? "",
  defaultBranch: process.env.GITHUB_DEFAULT_BRANCH ?? "main",
  approvers: (process.env.FACTORY_APPROVERS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  slackWebhook: process.env.SLACK_WEBHOOK_URL ?? "",
  codexCommand: process.env.CODEX_COMMAND ?? "codex",
  claudeCommand: process.env.CLAUDE_COMMAND ?? "claude",
  cursorCommand: process.env.CURSOR_COMMAND ?? "cursor-agent",
  gitCommand: process.env.GIT_COMMAND ?? "git",
};
export function agentEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME",
    ...(source.AGENT_SECRET_ALLOWLIST ?? "").split(",").map(s => s.trim()).filter(Boolean)];
  return Object.fromEntries(names.filter(n => source[n] !== undefined).map(n => [n, source[n]]));
}

export function requiredRepoDir(){if(!config.repoDir)throw new Error("FACTORY_REPO_DIR is required");return config.repoDir;}

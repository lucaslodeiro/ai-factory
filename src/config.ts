import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { factoryHome } from "./home.js";
const home=factoryHome();
loadEnvironment({path:path.join(home,".env"),quiet:true});
function positive(name: string, fallback: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}
function nonnegative(name:string,fallback:number){const n=Number(process.env[name]??fallback);if(!Number.isSafeInteger(n)||n<0)throw new Error(`${name} must be a nonnegative integer`);return n;}
function model(name: string, fallback: string) {
  const value = (process.env[name] ?? fallback).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)) throw new Error(`${name} must be a nonempty model identifier`);
  return value;
}
function provider(name: string, fallback: "codex" | "claude"): "codex" | "claude" {
  const value = (process.env[name] ?? fallback).trim();
  if (value !== "codex" && value !== "claude") throw new Error(`${name} must be codex or claude`);
  return value as "codex" | "claude";
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
  const roles=new Set(["product-architect","developer","qa","reviewer"]),result:Record<string,number>={};
  for (const [key,budget] of Object.entries(value)) {
    if (!roles.has(key) && !/^(codex|claude)\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(key)) throw new Error(`Invalid context budget override key: ${key}`);
    if (!Number.isSafeInteger(budget) || Number(budget)<1) throw new Error(`Context budget override ${key} must be a positive integer`);
    result[key]=Number(budget);
  }
  return result;
}
function role(prefix: string, fallback: "codex" | "claude", fallbackModel: string) {
  const selected = provider(`${prefix}_PROVIDER`,fallback);
  return { provider:selected,model:model(`${prefix}_MODEL`,fallbackModel) };
}
export const config = {
  roles: {
    "product-architect":role("PRODUCT_ARCHITECT","claude","auto"),
    developer:role("DEVELOPER","codex","auto"),
    qa:role("QA","codex","auto"),
    reviewer:role("REVIEWER","claude","auto"),
  },
  home,
  dataDir: path.resolve(home,process.env.FACTORY_DATA_DIR ?? "data"),
  repoDir: path.resolve(home,process.env.FACTORY_REPO_DIR ?? "."),
  pollMs: positive("FACTORY_POLL_INTERVAL_MS", 15000),
  timeoutMs: positive("FACTORY_EXECUTION_TIMEOUT_MS", 1800000),
  maxCycles: positive("FACTORY_MAX_FIX_CYCLES", 3),
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
  gitCommand: process.env.GIT_COMMAND ?? "git",
};
export function agentEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME",
    ...(source.AGENT_SECRET_ALLOWLIST ?? "").split(",").map(s => s.trim()).filter(Boolean)];
  return Object.fromEntries(names.filter(n => source[n] !== undefined).map(n => [n, source[n]]));
}

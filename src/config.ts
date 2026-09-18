import "dotenv/config";
import path from "node:path";
function positive(name: string, fallback: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}
function model(name: string, fallback: string) {
  const value = (process.env[name] ?? fallback).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)) throw new Error(`${name} must be a nonempty model identifier`);
  return value;
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
export const config = {
  models: {
    codex: { fast: model("CODEX_MODEL_FAST", "gpt-5.6-luna"), balanced: model("CODEX_MODEL_BALANCED", "gpt-5.6-terra"), strong: model("CODEX_MODEL_STRONG", "gpt-5.6-sol") },
    claude: { fast: model("CLAUDE_MODEL_FAST", "sonnet"), balanced: model("CLAUDE_MODEL_BALANCED", "sonnet"), strong: model("CLAUDE_MODEL_STRONG", "opus") },
  },
  dataDir: path.resolve(process.env.FACTORY_DATA_DIR ?? ".factory"),
  repoDir: path.resolve(process.env.FACTORY_REPO_DIR ?? "."),
  pollMs: positive("FACTORY_POLL_INTERVAL_MS", 15000),
  timeoutMs: positive("FACTORY_EXECUTION_TIMEOUT_MS", 1800000),
  maxCycles: positive("FACTORY_MAX_FIX_CYCLES", 3),
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

import "dotenv/config";
import path from "node:path";
function positive(name: string, fallback: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}
export const config = {
  dataDir: path.resolve(process.env.FACTORY_DATA_DIR ?? ".factory"),
  repoDir: path.resolve(process.env.FACTORY_REPO_DIR ?? "."),
  pollMs: positive("FACTORY_POLL_INTERVAL_MS", 15000),
  timeoutMs: positive("FACTORY_EXECUTION_TIMEOUT_MS", 1800000),
  maxCycles: positive("FACTORY_MAX_FIX_CYCLES", 3),
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

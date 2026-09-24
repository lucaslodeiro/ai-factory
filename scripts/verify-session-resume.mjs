#!/usr/bin/env node
// Checks, against the real provider CLIs, what the factory relies on before continuing a run that
// was cut short: a run killed mid-turn the way the factory kills it (SIGTERM to the process group,
// SIGKILL a second later) leaves a provider session that a new run can resume, and the resumed run
// remembers what the killed run had already read.
//
// Usage: node scripts/verify-session-resume.mjs [claude] [codex] [cursor]   (default: claude codex)
// Each provider costs one short run and one short resume. Nothing in the factory is touched.
import { spawn, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The same environment the factory gives its agents (src/config.ts agentEnvironment), so a variable
// inherited from the shell, such as a Claude Code session id, cannot change what is being checked.
const agentNames = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME", ...(process.env.AGENT_SECRET_ALLOWLIST ?? "").split(",").map(name => name.trim()).filter(Boolean)];
const env = Object.fromEntries(agentNames.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
env.PATH = `${path.join(os.homedir(), ".local", "bin")}${path.delimiter}${env.PATH ?? ""}`;
const command = (variable, fallback) => process.env[variable] || fallback;
const RUN_LIMIT_MS = 300_000, KILL_AFTER_MS = 1_000;
const readOnly = "Read,Glob,Grep";

const providers = {
  claude: {
    command: command("CLAUDE_COMMAND", "claude"),
    fresh: () => ["-p", "--output-format", "stream-json", "--verbose", "--tools", readOnly, "--allowedTools", readOnly],
    resume: id => ["-p", "--resume", id, "--output-format", "stream-json", "--verbose", "--tools", readOnly, "--allowedTools", readOnly],
    session: event => typeof event.session_id === "string" ? event.session_id : undefined,
    finalText: events => events.filter(event => event.type === "result").map(event => String(event.result ?? "")).at(-1),
    usedTool: event => event.type === "assistant" && Array.isArray(event.message?.content) && event.message.content.some(part => part.type === "tool_use"),
  },
  codex: {
    command: command("CODEX_COMMAND", "codex"),
    // Same shape the factory uses: --sandbox is not global, so it precedes the resume subcommand.
    fresh: () => ["exec", "--json", "--sandbox", "read-only", "-"],
    resume: id => ["exec", "--json", "--sandbox", "read-only", "resume", id, "-"],
    session: event => event.type === "thread.started" && typeof event.thread_id === "string" ? event.thread_id : undefined,
    finalText: events => events.filter(event => event.type === "item.completed" && event.item?.type === "agent_message").map(event => String(event.item.text ?? "")).at(-1),
    usedTool: event => event.type === "item.started" && event.item?.type === "command_execution",
  },
  cursor: {
    command: command("CURSOR_COMMAND", "cursor-agent"),
    fresh: () => ["-p", "--output-format", "stream-json", "--trust", "--mode", "ask"],
    resume: id => ["-p", "--resume", id, "--output-format", "stream-json", "--trust", "--mode", "ask"],
    session: event => typeof event.session_id === "string" ? event.session_id : undefined,
    finalText: events => events.filter(event => event.type === "result").map(event => String(event.result ?? "")).at(-1),
    usedTool: event => event.type === "tool_call",
  },
};

const parse = text => text.split(/\r?\n/).flatMap(line => { try { const value = JSON.parse(line); return value && typeof value === "object" ? [value] : []; } catch { return []; } });

// Runs one provider process in its own process group, like the factory's supervisor does, and
// optionally stops it the factory's way as soon as `stopWhen` holds for what it has written.
function run(command, args, input, cwd, log, stopWhen) {
  return new Promise(resolve => {
    let stdout = "", stderr = "", stopped = false, settled = false;
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const stop = () => {
      if (stopped || !child.pid) return; stopped = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, KILL_AFTER_MS).unref();
    };
    const limit = setTimeout(stop, RUN_LIMIT_MS);
    child.stdout.on("data", chunk => { stdout += chunk; if (stopWhen && stopWhen(stdout)) stop(); });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { if (settled) return; settled = true; clearTimeout(limit); resolve({ code: null, stopped, stdout, stderr: `${stderr}${error.message}` }); });
    child.on("close", code => { if (settled) return; settled = true; clearTimeout(limit); fs.writeFileSync(log, stdout); fs.writeFileSync(`${log}.stderr`, stderr); resolve({ code, stopped, stdout, stderr }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function verify(name, provider, root) {
  const cwd = fs.mkdtempSync(path.join(root, `${name}-`));
  spawnSync("git", ["init", "-q"], { cwd });
  const words = Array.from({ length: 6 }, (_, index) => `${["amber", "birch", "cobalt", "delta", "ember", "fjord"][index]}-${randomInt(1000, 9999)}`);
  words.forEach((word, index) => fs.writeFileSync(path.join(cwd, `w${index + 1}.txt`), `The secret word in this file is ${word}.\n`));
  const task = "This directory has six files, w1.txt to w6.txt, each holding one secret word. Read them strictly one at a time, in order, with exactly one separate tool call per file, and never read two files in one call. After reading all six, reply with the six secret words, one per line.";
  const resumeTask = "You were interrupted. Do not use any tool and do not read any file. From what you already read earlier in this conversation, list every secret word you saw, exactly as written, one per line. If you saw none, reply NONE.";

  const first = await run(provider.command, provider.fresh(), task, cwd, path.join(cwd, "1-killed.jsonl"),
    stdout => words.some(word => stdout.includes(word)) && !parse(stdout).some(event => event.type === "result"));
  if (first.code === null && !first.stopped) return { verdict: "FAIL", detail: `could not start ${provider.command}: ${first.stderr.trim().slice(-300)}`, cwd };
  const events = parse(first.stdout), sessionId = events.map(provider.session).find(Boolean);
  const seen = words.filter(word => first.stdout.includes(word));
  if (!first.stopped) return { verdict: "INCONCLUSIVE", detail: `the run finished before it could be interrupted (exit ${first.code}); run the check again`, cwd };
  if (!sessionId) return { verdict: "FAIL", detail: "the killed run's stream carried no session id", cwd };
  if (!seen.length) return { verdict: "INCONCLUSIVE", detail: "the run was interrupted before it read any file", cwd };

  const second = await run(provider.command, provider.resume(sessionId), resumeTask, cwd, path.join(cwd, "2-resumed.jsonl"));
  const resumed = parse(second.stdout), answer = provider.finalText(resumed) ?? "";
  if (second.code !== 0) return { verdict: "FAIL", detail: `resume exited ${second.code}: ${(second.stderr || answer).trim().slice(-400)}`, cwd, sessionId };
  if (resumed.some(provider.usedTool)) return { verdict: "INCONCLUSIVE", detail: "the resumed run read files again, so its answer does not prove it remembered", cwd, sessionId };
  const missing = seen.filter(word => !answer.includes(word));
  return missing.length
    ? { verdict: "FAIL", detail: `resumed, but did not remember ${missing.join(", ")} of the ${seen.length} word(s) read before the kill. Answer: ${answer.trim().slice(0, 300)}`, cwd, sessionId }
    : { verdict: "PASS", detail: `resumed session ${sessionId} and recalled all ${seen.length} word(s) read before the kill without reading again`, cwd, sessionId };
}

const requested = process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex"];
const unknown = requested.filter(name => !providers[name]);
if (unknown.length) { console.error(`Unknown provider: ${unknown.join(", ")}. Use claude, codex or cursor.`); process.exit(2); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-resume-check-"));
let failed = false;
for (const name of requested) {
  process.stdout.write(`${name}: running, interrupting mid-turn and resuming… `);
  const outcome = await verify(name, providers[name], root);
  failed ||= outcome.verdict !== "PASS";
  console.log(`${outcome.verdict}\n  ${outcome.detail}\n  logs: ${outcome.cwd}`);
}
process.exit(failed ? 1 : 0);

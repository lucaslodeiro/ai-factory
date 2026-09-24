#!/usr/bin/env node
// Checks, against the real provider CLIs, what the factory relies on before continuing a run that
// was cut short: a run killed mid-turn the way the factory kills it (SIGTERM to the process group,
// SIGKILL a second later) leaves a provider session that a new run can resume, and the resumed run
// remembers what the killed run had already read.
//
// Usage: node scripts/verify-session-resume.mjs [claude] [codex] [cursor]   (default: claude codex cursor)
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
const RUN_LIMIT_MS = 300_000;
// How long a provider gets to react to the interrupt signal before SIGKILL. Claude and Cursor die
// on SIGTERM immediately; Codex's SIGINT handler round-trips a TurnInterrupt request to its own
// in-process server and waits for the response before exiting, which needs real time to complete.
const graceMs = { SIGTERM: 1_000, SIGINT: 10_000 };
const readOnly = "Read,Glob,Grep";

const providers = {
  claude: {
    command: command("CLAUDE_COMMAND", "claude"),
    stopSignal: "SIGTERM",
    fresh: () => ["-p", "--output-format", "stream-json", "--verbose", "--tools", readOnly, "--allowedTools", readOnly],
    resume: id => ["-p", "--resume", id, "--output-format", "stream-json", "--verbose", "--tools", readOnly, "--allowedTools", readOnly],
    session: event => typeof event.session_id === "string" ? event.session_id : undefined,
    finalText: events => events.filter(event => event.type === "result").map(event => String(event.result ?? "")).at(-1),
    usedTool: event => event.type === "assistant" && Array.isArray(event.message?.content) && event.message.content.some(part => part.type === "tool_use"),
  },
  codex: {
    command: command("CODEX_COMMAND", "codex"),
    // codex-rs only installs a handler for SIGINT (tokio::signal::ctrl_c, its graceful shutdown
    // that flushes the buffered rollout writer); it has no SIGTERM handler, so SIGTERM kills it
    // with the default disposition before that flush runs and the completed item is lost.
    stopSignal: "SIGINT",
    // Same shape the factory uses: --sandbox is not global, so it precedes the resume subcommand.
    fresh: () => ["exec", "--json", "--sandbox", "read-only", "-"],
    resume: id => ["exec", "--json", "--sandbox", "read-only", "resume", id, "-"],
    session: event => event.type === "thread.started" && typeof event.thread_id === "string" ? event.thread_id : undefined,
    finalText: events => events.filter(event => event.type === "item.completed" && event.item?.type === "agent_message").map(event => String(event.item.text ?? "")).at(-1),
    usedTool: event => event.type === "item.started" && event.item?.type === "command_execution",
  },
  cursor: {
    command: command("CURSOR_COMMAND", "cursor-agent"),
    stopSignal: "SIGTERM",
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
function run(command, args, input, cwd, log, stopSignal, stopWhen) {
  return new Promise(resolve => {
    let stdout = "", stderr = "", stopped = false, settled = false;
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const stop = () => {
      if (stopped || !child.pid) return; stopped = true;
      try { process.kill(-child.pid, stopSignal); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, graceMs[stopSignal] ?? 1_000).unref();
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

  // Stopped once three files were read, like a real interruption well into a run. A provider may
  // record a step only when the step ends (Codex writes a tool's output when the model's response
  // for that step finishes), so the file read in the step cut short may be lost; the earlier ones
  // must not be. Stopping at the very first read measured only that last, unfinished step.
  const first = await run(provider.command, provider.fresh(), task, cwd, path.join(cwd, "1-killed.jsonl"), provider.stopSignal,
    stdout => words.filter(word => stdout.includes(word)).length >= 3 && !parse(stdout).some(event => event.type === "result"));
  if (first.code === null && !first.stopped) return { verdict: "FAIL", detail: `could not start ${provider.command}: ${first.stderr.trim().slice(-300)}`, cwd };
  if (!first.stopped) return { verdict: "INCONCLUSIVE", detail: `the run finished (exit ${first.code}) before the interrupt signal could be sent; run the check again`, cwd };
  const events = parse(first.stdout), sessionId = events.map(provider.session).find(Boolean);
  const seen = words.filter(word => first.stdout.includes(word));
  if (!sessionId) return { verdict: "FAIL", detail: "the killed run's stream carried no session id", cwd };
  if (seen.length < 2) return { verdict: "INCONCLUSIVE", detail: `the run was interrupted after reading ${seen.length} file(s), too few to tell a lost step from a lost session; run the check again`, cwd };

  const second = await run(provider.command, provider.resume(sessionId), resumeTask, cwd, path.join(cwd, "2-resumed.jsonl"), provider.stopSignal);
  const resumed = parse(second.stdout), answer = provider.finalText(resumed) ?? "";
  if (second.code !== 0) return { verdict: "FAIL", detail: `resume exited ${second.code}: ${(second.stderr || answer).trim().slice(-400)}`, cwd, sessionId };
  if (resumed.some(provider.usedTool)) return { verdict: "INCONCLUSIVE", detail: "the resumed run read files again, so its answer does not prove it remembered", cwd, sessionId };
  // Words in the order the killed run read them; only the last one can have been in flight.
  const order = seen.slice().sort((a, b) => first.stdout.indexOf(a) - first.stdout.indexOf(b));
  const remembered = order.filter(word => answer.includes(word)), settled = order.slice(0, -1);
  const lostSettled = settled.filter(word => !answer.includes(word));
  const detail = `remembered ${remembered.length} of the ${order.length} word(s) read before the kill (${order.map(word => `${word}${answer.includes(word) ? " ✓" : " ✗"}`).join(", ")})`;
  if (lostSettled.length) return { verdict: "FAIL", detail: `resumed, but lost steps that had finished before the kill: ${detail}. Answer: ${answer.trim().slice(0, 300)}`, cwd, sessionId };
  return remembered.length === order.length
    ? { verdict: "PASS", detail: `resumed session ${sessionId}: ${detail}`, cwd, sessionId }
    : { verdict: "PASS", detail: `resumed session ${sessionId}; only the step cut short was lost: ${detail}`, cwd, sessionId };
}

// A run that finished its turn normally, then resumed: what the factory relies on to correct a
// rejected result with nothing but the rejection, and to continue the Architect's passes.
async function verifyCompleted(name, provider, root) {
  const cwd = fs.mkdtempSync(path.join(root, `${name}-completed-`));
  spawnSync("git", ["init", "-q"], { cwd });
  const word = `granite-${randomInt(1000, 9999)}`;
  fs.writeFileSync(path.join(cwd, "w1.txt"), `The secret word in this file is ${word}.\n`);
  const first = await run(provider.command, provider.fresh(), "Read w1.txt with one tool call, then reply with only the word DONE.", cwd, path.join(cwd, "1-completed.jsonl"), provider.stopSignal);
  if (first.code !== 0) return { verdict: "FAIL", detail: `the first run exited ${first.code}: ${first.stderr.trim().slice(-300)}`, cwd };
  const sessionId = parse(first.stdout).map(provider.session).find(Boolean);
  if (!sessionId) return { verdict: "FAIL", detail: "the completed run's stream carried no session id", cwd };
  if (!first.stdout.includes(word)) return { verdict: "INCONCLUSIVE", detail: "the first run did not read the file", cwd };
  const second = await run(provider.command, provider.resume(sessionId), "Do not use any tool and do not read any file. What secret word did you read earlier in this conversation? Reply with the word only, or NONE.", cwd, path.join(cwd, "2-resumed.jsonl"), provider.stopSignal);
  const resumed = parse(second.stdout), answer = provider.finalText(resumed) ?? "";
  if (second.code !== 0) return { verdict: "FAIL", detail: `resume exited ${second.code}: ${(second.stderr || answer).trim().slice(-400)}`, cwd, sessionId };
  if (resumed.some(provider.usedTool)) return { verdict: "INCONCLUSIVE", detail: "the resumed run read the file again", cwd, sessionId };
  return answer.includes(word)
    ? { verdict: "PASS", detail: `resumed session ${sessionId} and recalled ${word} without reading again`, cwd, sessionId }
    : { verdict: "FAIL", detail: `resumed, but did not remember ${word}. Answer: ${answer.trim().slice(0, 300)}`, cwd, sessionId };
}

const requested = process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex", "cursor"];
const unknown = requested.filter(name => !providers[name]);
if (unknown.length) { console.error(`Unknown provider: ${unknown.join(", ")}. Use claude, codex or cursor.`); process.exit(2); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-resume-check-"));
let failed = false;
// The completed turn is what every resume in the factory depends on today, so it decides the exit
// code; a mid-turn kill only decides whether a cut-short run can be continued instead of restarted.
for (const name of requested) {
  process.stdout.write(`${name} — completed turn, then resume: `);
  const completed = await verifyCompleted(name, providers[name], root);
  failed ||= completed.verdict !== "PASS";
  console.log(`${completed.verdict}\n  ${completed.detail}\n  logs: ${completed.cwd}`);
  process.stdout.write(`${name} — killed mid-turn, then resume: `);
  const killed = await verify(name, providers[name], root);
  console.log(`${killed.verdict}\n  ${killed.detail}\n  logs: ${killed.cwd}`);
}
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Checks, against the real provider CLIs and the factory's own adapters, that a result the validator
// rejects is corrected by continuing the run that produced it with nothing but the rejection, and
// how many tokens that correction consumes next to the original run. It uses the Architect's real prompt contract,
// the runner's real correction note and the same adapter flags the factory uses, so it exercises
// the path a live rejection takes. The rejection is made on purpose: the first run is asked for one
// question, and its result is then rejected for lacking a token it could not have known.
//
// Usage: node scripts/verify-correction.mjs [claude] [codex] [cursor]   (default: claude codex cursor)
// Run from an installed engine after `npm run build`. It reads the installation's .env for the
// provider commands and the agent secret allowlist, and writes only to a temporary directory.
import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-correction-check-"));
// Set before the engine loads its configuration, which never overrides a variable already set.
process.env.FACTORY_DATA_DIR = path.join(root, "data");
const load = file => import(new URL(`../dist/src/${file}`, import.meta.url));
const [{ Store }, { ExecutionManager }, { ClaudeAdapter }, { CodexAdapter }, { CursorAdapter }, { promptContract }, { rejectionContinuation }] = await Promise.all([
  load("storage.js"), load("execution-manager.js"), load("adapters/claude.js"), load("adapters/codex.js"), load("adapters/cursor.js"), load("prompts.js"), load("workflow-runner.js"),
]);
const adapters = { claude: ClaudeAdapter, codex: CodexAdapter, cursor: CursorAdapter };

// The first run does real work, as a Designer or a Builder would before its report is rejected: six
// files read one tool call at a time. What a correction saves is not redoing that.
const task = `## Issue

This is an automated check of the factory's correction path, not a real issue. The repository holds six notes, w1.txt to w6.txt. Read them strictly one at a time, with exactly one separate tool call per file, and do not read anything else. Then return outcome "questions" with exactly one question: which of the colors named in the notes the new button should be. Keep the summary to one sentence.`;
const colors = ["teal", "coral", "amber", "indigo", "olive", "plum"];
// Tool calls the provider made, not counting the call Claude uses to return structured output.
const toolCalls = {
  claude: event => event.type === "assistant" && Array.isArray(event.message?.content) ? event.message.content.filter(part => part.type === "tool_use" && part.name !== "StructuredOutput").length : 0,
  codex: event => event.type === "item.started" && event.item?.type === "command_execution" ? 1 : 0,
  cursor: event => event.type === "tool_call" && event.subtype === "started" ? 1 : 0,
};

function runFacts(store, name, executionId) {
  const row = store.db.prepare("SELECT total_tokens FROM executions WHERE id=?").get(executionId);
  const finished = store.db.prepare("SELECT payload FROM events WHERE run_id=? AND type='execution.finished' ORDER BY id DESC LIMIT 1").get(executionId);
  const payload = finished ? JSON.parse(finished.payload) : {};
  let tools = 0;
  for (const line of fs.readFileSync(path.join(root, "data", "runs", executionId, "stdout.log"), "utf8").split("\n")) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event && typeof event === "object") tools += toolCalls[name](event);
  }
  // Tokens as the provider's CLI reported them for this run, not a weighted or priced estimate.
  return { tokens: row?.total_tokens ?? null, turns: payload.activity?.turns ?? null, tools, sessionId: payload.sessionId };
}
const lastExecution = store => store.db.prepare("SELECT id FROM executions ORDER BY rowid DESC LIMIT 1").get()?.id;
const format = value => value === null || value === undefined ? "unreported" : Number(value).toLocaleString("en-US");

async function verify(name) {
  const cwd = fs.mkdtempSync(path.join(root, `${name}-`));
  spawnSync("git", ["init", "-q"], { cwd });
  colors.forEach((color, index) => fs.writeFileSync(path.join(cwd, `w${index + 1}.txt`), `Note ${index + 1}: the brand palette includes ${color}.\n`));
  const store = new Store(":memory:"), adapter = new adapters[name](new ExecutionManager(store));
  const selection = { policy: "verify-correction", provider: name, model: "auto", reason: "correction check" };
  const request = { workItemId: "correction-check", role: "product-architect", cwd, selection };
  let first;
  try { first = await adapter.run({ ...request, instructions: `${promptContract("product-architect", name)}\n\n${task}`, session: { persist: true } }); }
  catch (error) { return { verdict: "FAIL", detail: `the first run failed: ${String(error.message ?? error).slice(0, 400)}`, cwd }; }
  const original = runFacts(store, name, lastExecution(store));
  if (first.outcome !== "questions") return { verdict: "INCONCLUSIVE", detail: `the first run returned ${first.outcome}, not questions; run the check again`, cwd };
  if (!original.sessionId) return { verdict: "FAIL", detail: "the first run's stream carried no session id", cwd };
  const marker = `ORCHID-${randomInt(1000, 9999)}`;
  const rejection = `questions[0] must contain the exact token ${marker}, and the question you returned does not.`;
  let corrected;
  try { corrected = await adapter.run({ ...request, instructions: rejectionContinuation(rejection), session: { resume: original.sessionId } }); }
  catch (error) { return { verdict: "FAIL", detail: `the correction failed: ${String(error.message ?? error).slice(0, 400)}`, cwd }; }
  const correction = runFacts(store, name, lastExecution(store));
  const share = (a, b) => a && b ? ` (${Math.round(a * 100 / b)}%)` : "";
  const cost = [
    `original run: ${original.tools} tool call(s), ${format(original.turns)} turn(s), ${format(original.tokens)} tokens`,
    `correction:   ${correction.tools} tool call(s), ${format(correction.turns)} turn(s), ${format(correction.tokens)} tokens${share(correction.tokens, original.tokens)}`,
  ].join("\n  ");
  if (original.tools < colors.length) return { verdict: "INCONCLUSIVE", detail: `the first run made ${original.tools} tool call(s), fewer than the ${colors.length} files, so there was little work to redo; run the check again\n  ${cost}`, cwd };
  if (corrected.outcome !== "questions" || !corrected.questions.some(question => question.includes(marker)))
    return { verdict: "FAIL", detail: `the correction returned a valid result that did not fix what was rejected (outcome ${corrected.outcome}: ${JSON.stringify(corrected.questions).slice(0, 200)})\n  ${cost}`, cwd };
  if (correction.tools > 0)
    return { verdict: "FAIL", detail: `the correction fixed the result but redid work (${correction.tools} tool call(s)), so it saves little\n  ${cost}`, cwd };
  return { verdict: "PASS", detail: `corrected in its own session with only the rejection, without redoing any work; the result passed the validator and fixes it\n  ${cost}`, cwd };
}

const requested = process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex", "cursor"];
const unknown = requested.filter(name => !adapters[name]);
if (unknown.length) { console.error(`Unknown provider: ${unknown.join(", ")}. Use claude, codex or cursor.`); process.exit(2); }
let failed = false;
for (const name of requested) {
  process.stdout.write(`${name} — rejected result, corrected in its own session: `);
  const outcome = await verify(name);
  failed ||= outcome.verdict !== "PASS";
  console.log(`${outcome.verdict}\n  ${outcome.detail}\n  logs: ${outcome.cwd} and ${path.join(root, "data", "runs")}`);
}
process.exit(failed ? 1 : 0);

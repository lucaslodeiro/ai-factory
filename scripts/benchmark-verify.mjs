#!/usr/bin/env node
// Independent oracle for the benchmark issue in docs/BENCHMARK.md.
//
// It never reads the tests the Builder or the Tester wrote, and never trusts a reported PASS.
// It finds the function the run was supposed to produce, calls it, and checks the three
// behaviours the issue stated. Without this, a run that got cheaper by getting lazier scores
// as an improvement: the system would be grading its own homework.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Derived from the three numbered behaviours, in the order the issue states them: lowercase,
// then each run of whitespace to one hyphen, then drop anything that is not a letter, digit or
// hyphen, collapse repeated hyphens and trim them from both ends.
const CHECKS = [
  { behaviour: 1, input: "Hello World", expected: "hello-world" },
  { behaviour: 1, input: "ALLCAPS", expected: "allcaps" },
  { behaviour: 2, input: "  Multiple   Spaces  ", expected: "multiple-spaces" },
  { behaviour: 2, input: "Tabs\tand\nnewlines", expected: "tabs-and-newlines" },
  { behaviour: 3, input: "¡Hola, Mundo!", expected: "hola-mundo" },
  { behaviour: 3, input: "C++ & Rust", expected: "c-rust" },
  { behaviour: 3, input: "--already--hyphenated--", expected: "already-hyphenated" },
  { behaviour: 3, input: "2026 Report", expected: "2026-report" },
];

const fail = (error, extra = {}) => {
  process.stdout.write(JSON.stringify({ resolved: false, module: null, checks: [], failures: null, error, ...extra }));
  process.exit(1);
};

const checkout = process.argv[2];
if (!checkout) fail("Usage: benchmark-verify.mjs <path-to-checkout>");

const listed = spawnSync("git", ["ls-files", "-z"], { cwd: checkout, encoding: "utf8", timeout: 30000, maxBuffer: 10_000_000 });
if (listed.status !== 0) fail(`Not a git checkout: ${listed.stderr?.trim() || checkout}`);

const candidates = listed.stdout.split("\0").filter(file => /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(file) && !file.includes("node_modules"));
const grep = spawnSync("git", ["grep", "-l", "-E", "(export[^\\n]*slugify|slugify[^\\n]*=)", "--", ...candidates], { cwd: checkout, encoding: "utf8", timeout: 30000 });
const named = (grep.stdout || "").split("\n").map(file => file.trim()).filter(Boolean);
if (!named.length) fail("No file in the checkout exports a slugify function", { searched: candidates.length });

// Prefer a source file over a test file: the run is graded on the implementation it produced.
const ordered = [...named].sort((a, b) => Number(/test|spec|__tests__/.test(a)) - Number(/test|spec|__tests__/.test(b)));
let slugify, chosen = null, importErrors = [];
for (const file of ordered) {
  try {
    const loaded = await import(pathToFileURL(path.resolve(checkout, file)).href);
    const candidate = loaded.slugify ?? loaded.default?.slugify ?? (typeof loaded.default === "function" ? loaded.default : undefined);
    if (typeof candidate === "function") { slugify = candidate; chosen = file; break; }
    importErrors.push(`${file}: imported but exports no slugify function`);
  } catch (error) { importErrors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
}
if (!slugify) fail("Found no importable slugify function", { candidates: named, importErrors });

const checks = CHECKS.map(check => {
  let actual, threw = null;
  try { actual = slugify(check.input); } catch (error) { threw = error instanceof Error ? error.message : String(error); }
  return { ...check, actual: threw === null ? actual : null, threw, passed: threw === null && actual === check.expected };
});
const failures = checks.filter(check => !check.passed).length;
process.stdout.write(JSON.stringify({ resolved: failures === 0, module: chosen, checks, failures, error: null }));
process.exit(failures === 0 ? 0 : 1);

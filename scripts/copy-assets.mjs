import { cpSync, mkdirSync } from "node:fs";
for (const dir of ["agents", "templates", "dashboard"]) cpSync(dir, `dist/${dir}`, { recursive: true });
cpSync("src/worker-supervisor.mjs", "dist/src/worker-supervisor.mjs");

cpSync("src/browser-runner.mjs", "dist/src/browser-runner.mjs");

// `ai-factory benchmark --verify` resolves the oracle next to the compiled CLI, so an installed
// engine needs it under dist/ too. Without this the verifier only exists in a source checkout and
// every installed run reports "Resolved: no" for a reason that has nothing to do with the run.
mkdirSync("dist/scripts", { recursive: true });
cpSync("scripts/benchmark-verify.mjs", "dist/scripts/benchmark-verify.mjs");

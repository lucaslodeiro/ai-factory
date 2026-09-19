import { spawnSync } from "node:child_process";
import { config } from "./config.js";
import { Store } from "./storage.js";
import { workflowProjectionProblems } from "./workflow-doctor.js";
export function doctor() {
 let ok = true;
 const check = (name: string, pass: boolean) => { ok = ok && pass; console.log(`${pass ? "✓" : "✗"} ${name}`); };
 check("Node >= 22", Number(process.versions.node.split(".")[0]) >= 22);
 for (const [cmd, args] of [[config.gitCommand, ["--version"]], ["gh", ["auth", "status"]], [config.codexCommand, ["--version"]], [config.claudeCommand, ["--version"]]] as [string, string[]][]) {
  check(cmd, spawnSync(cmd, args, { encoding: "utf8", timeout: 15000 }).status === 0);
 }
 check("Codex authentication", spawnSync(config.codexCommand, ["login", "status"], { encoding: "utf8", timeout: 15000 }).status === 0);
 const auth = spawnSync(config.claudeCommand, ["auth", "status"], { encoding: "utf8", timeout: 15000 });
 try { check("Claude authentication", auth.status === 0 && JSON.parse(auth.stdout).loggedIn === true); } catch { check("Claude authentication", false); }
 check("GITHUB_REPOSITORY", /^[^/]+\/[^/]+$/.test(config.repo));
 check("FACTORY_APPROVERS", config.approvers.length > 0);
 for (const key of ["user.name", "user.email"]) {
  const identity = spawnSync(config.gitCommand, ["config", key], { cwd: config.repoDir, encoding: "utf8" });
  check(`Git ${key}`, identity.status === 0 && Boolean(identity.stdout.trim()));
 }
 const remote = spawnSync(config.gitCommand, ["remote", "get-url", "origin"], { cwd: config.repoDir, encoding: "utf8" });
 check("Target checkout origin matches repository", Boolean(config.repo) && remote.status === 0 && remote.stdout.trim().replace(/\.git$/, "").endsWith(config.repo));
 try {
  const s = new Store();
  try {
   s.db.prepare("SELECT 1").get();check("SQLite writable",true);
   const problems=workflowProjectionProblems(s);check("Workflow projection invariants",problems.length===0);
   for (const problem of problems) console.log(`  - ${problem}`);
  } finally { s.db.close(); }
 } catch (error) {
  check("SQLite writable", false);check("Workflow projection invariants",false);
  console.log(`  - ${error instanceof Error ? error.message : String(error)}`);
 }
 console.log(`Slack: ${config.slackWebhook ? "configured" : "optional, disabled"}`);
 return ok;
}

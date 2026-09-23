import fs from "node:fs";
import {normalizedRepository} from "./repository-setup.js";
import { spawnSync } from "node:child_process";
import { config } from "./config.js";
import { agentProviders, type AgentProvider, type AgentRole } from "./types.js";
import { roleShortName } from "./names.js";
import { Store } from "./storage.js";
import { workflowProjectionProblems } from "./workflow-doctor.js";
import {GitHubAdapter,type GitHubPort} from "./adapters/github.js";
import {verifyRepositoryIdentity} from "./repository-identity.js";
import {RepositoryMaintenance} from "./repository-maintenance.js";
export function doctor(existingStore?:Store,github:Pick<GitHubPort,"repository">=new GitHubAdapter()) {
 let ok = true;
 const check = (name: string, pass: boolean) => { ok = ok && pass; console.log(`${pass ? "✓" : "✗"} ${name}`); };
 check("Node >= 22", Number(process.versions.node.split(".")[0]) >= 22);
 for (const [cmd, args] of [[config.gitCommand, ["--version"]], [process.env.GH_COMMAND ?? "gh", ["auth", "status"]]] as [string, string[]][]) {
  check(cmd, spawnSync(cmd, args, { encoding: "utf8", timeout: 15000 }).status === 0);
 }
 const probe = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8", timeout: 15000 });
 const jsonFlag = (output: ReturnType<typeof probe>, flag: string) => { try { return output.status === 0 && JSON.parse(output.stdout)[flag] === true; } catch { return false; } };
 const providerChecks: Record<AgentProvider, { label: string; command: string; authenticated: () => boolean }> = {
  codex: { label: "Codex", command: config.codexCommand, authenticated: () => probe(config.codexCommand, ["login", "status"]).status === 0 },
  claude: { label: "Claude", command: config.claudeCommand, authenticated: () => jsonFlag(probe(config.claudeCommand, ["auth", "status"]), "loggedIn") },
  cursor: { label: "Cursor", command: config.cursorCommand, authenticated: () => jsonFlag(probe(config.cursorCommand, ["status", "--format", "json"]), "isAuthenticated") },
 };
 // A provider costs nothing until a role selects it: only selected CLIs must be installed and authenticated.
 const selected = new Set(Object.values(config.roles).map(routing => routing.provider));
 for (const provider of agentProviders) {
  if (!selected.has(provider)) continue;
  const { label, command, authenticated } = providerChecks[provider];
  check(command, probe(command, ["--version"]).status === 0);
  check(`${label} authentication`, authenticated());
 }
 check("GITHUB_REPOSITORY", /^[^/]+\/[^/]+$/.test(config.repo));
 check("FACTORY_APPROVERS", config.approvers.length > 0);
 console.log(`Instance: ${config.instanceName}`);
 const checkoutExists=Boolean(config.repoDir&&fs.existsSync(config.repoDir)&&fs.statSync(config.repoDir).isDirectory());
 check(`Target checkout directory exists: ${config.repoDir}`,checkoutExists);
 if(checkoutExists){
  for (const key of ["user.name", "user.email"]) {
   const identity=spawnSync(config.gitCommand,["config",key],{cwd:config.repoDir,encoding:"utf8"});
   check(`Git ${key}`,identity.status===0&&Boolean(identity.stdout?.trim()));
  }
  const remote=spawnSync(config.gitCommand,["config","--get","remote.origin.url"],{cwd:config.repoDir,encoding:"utf8"});
  check("Target checkout origin matches repository",Boolean(config.repo)&&remote.status===0&&normalizedRepository(remote.stdout)===normalizedRepository(`https://github.com/${config.repo}`));
 }
 try {
  const s = existingStore??new Store();
  try {
   s.db.prepare("SELECT 1").get();check("SQLite writable",true);
   try{verifyRepositoryIdentity(s,github);check("GitHub repository identity",true);}catch(error){check("GitHub repository identity",false);console.log(`  - ${error instanceof Error?error.message:String(error)}`);}
   try{check("GitHub default branch matches configured base",github.repository().defaultBranch===config.defaultBranch);}catch(error){check("GitHub default branch matches configured base",false);console.log(`  - ${error instanceof Error?error.message:String(error)}`);}
   if(checkoutExists)try{check(`Remote base branch ${config.defaultBranch} exists`,Boolean(new RepositoryMaintenance(s).check().remoteHead));}catch(error){check(`Remote base branch ${config.defaultBranch} exists`,false);console.log(`  - ${error instanceof Error?error.message:String(error)}`);}
   const problems=workflowProjectionProblems(s);check("Workflow projection invariants",problems.length===0);
   for (const problem of problems) console.log(`  - ${problem}`);
  } finally { if(!existingStore)s.db.close(); }
 } catch (error) {
  check("SQLite writable", false);check("Workflow projection invariants",false);
  console.log(`  - ${error instanceof Error ? error.message : String(error)}`);
 }
 console.log(`Slack: ${config.slackWebhook ? "configured" : "optional, disabled"}`);
 console.log(`Token budget per issue: ${config.issueBudgetTokens.toLocaleString("en-US")} tokens`);
 // Older Cursor versions and interrupted runs may omit usage and require acknowledgement.
 const unmeasured=(Object.entries(config.roles) as Array<[AgentRole,{provider:string}]>).filter(([role,routing])=>routing.provider==="cursor"&&!config.budgetUnmeteredRoles.includes(role)).map(([role])=>roleShortName(role));
 if(unmeasured.length)console.log(`  - ${unmeasured.join(", ")} run${unmeasured.length===1?"s":""} on Cursor: runs without detailed token usage will wait for /factory budget +0 unless listed in FACTORY_BUDGET_UNMETERED_ROLES`);
 return ok;
}

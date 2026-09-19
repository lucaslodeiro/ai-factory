import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { config } from "./config.js";
function gitOutput(cwd: string, args: string[]) {
 const r = spawnSync(config.gitCommand, args, { cwd, encoding: "utf8", timeout: 60000, maxBuffer: 10_000_000 });
 if (r.status !== 0) throw new Error(r.stderr || r.error?.message || "git failed"); return r.stdout;
}
function gitSucceeds(cwd: string, args: string[]) {
 const result = spawnSync(config.gitCommand,args,{cwd,encoding:"utf8",timeout:60000,maxBuffer:10_000_000});
 return result.status === 0;
}
export function git(cwd: string, args: string[]) { return gitOutput(cwd, args).trim(); }
export interface WorkspacePort {
 assertBranch(cwd: string, branch: string): void;
 ensure(id: string, branch: string): string;
 head(cwd: string): string;
 diff(cwd: string): string;
 check(cwd: string, role: string, before: string, branch: string): void;
 commit(cwd: string, message: string, branch: string): void;
 publish(cwd: string, branch: string): void;
}
export class Workspaces implements WorkspacePort {
 assertBranch(cwd: string, branch: string) {
  if (!branch.startsWith("factory/") || branch === config.defaultBranch || git(cwd, ["branch", "--show-current"]) !== branch) throw new Error("Worktree branch mismatch; expected assigned factory branch");
 }
 ensure(id: string, branch: string) {
  const root = path.join(config.dataDir, "worktrees"); fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, id);
  if (fs.existsSync(target)) {
   this.assertBranch(target, branch);
   return target;
  }
  git(config.repoDir, ["fetch", "origin", config.defaultBranch]);
  git(config.repoDir,["worktree","prune"]);
  if (gitSucceeds(config.repoDir,["show-ref","--verify","--quiet",`refs/heads/${branch}`])) {
   git(config.repoDir,["worktree","add",target,branch]);
  } else {
   const remoteBranch = gitSucceeds(config.repoDir,["fetch","origin",`${branch}:refs/remotes/origin/${branch}`])
    && gitSucceeds(config.repoDir,["show-ref","--verify","--quiet",`refs/remotes/origin/${branch}`]);
   git(config.repoDir,["worktree","add","-b",branch,target,remoteBranch ? `origin/${branch}` : `origin/${config.defaultBranch}`]);
  }
  return target;
 }
 head(cwd: string) { return git(cwd, ["rev-parse", "HEAD"]); }
 diff(cwd: string) { return git(cwd, ["diff", `origin/${config.defaultBranch}...HEAD`]); }
 check(cwd: string, role: string, before: string, branch: string) {
  this.assertBranch(cwd, branch);
  if (this.head(cwd) !== before) throw new Error("Agents must not create commits; orchestrator owns commits");
  // NUL records preserve whitespace, newlines and non-ASCII paths. Disable rename
  // detection so a production-file deletion cannot hide behind a test-file destination.
  const changed = [...gitOutput(cwd, ["diff", "--name-only", "--no-renames", "-z", "HEAD"]).split("\0"), ...gitOutput(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")].filter(Boolean);
  if ((role === "product-architect" || role === "reviewer") && changed.length) throw new Error(`${role} modified the worktree`);
  if (role === "qa" && changed.some(p => !/(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[^/]+$/.test(p))) throw new Error("Verification Engineer modified a non-test file; inspect before retry");
  if (changed.some(p => /(^|\/)(\.env($|\.)|auth\.json$|credentials)/.test(p))) throw new Error("Potential credential file in changes; inspect before commit");
 }
 commit(cwd: string, message: string, branch: string) {
  this.assertBranch(cwd, branch);
  git(cwd, ["add", "--all"]);
  if (git(cwd, ["diff", "--cached", "--name-only"])) git(cwd, ["commit", "-m", message]);
 }
 publish(cwd: string, branch: string) {
  if (!branch.startsWith("factory/") || branch === config.defaultBranch || git(cwd, ["branch", "--show-current"]) !== branch) throw new Error("Refusing to push unexpected branch");
  git(cwd, ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`]);
 }
}

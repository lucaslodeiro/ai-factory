import { spawnSync } from "node:child_process";
import { config } from "../config.js";
import type { WorkState } from "../types.js";
export type Issue = { number: number; title: string; body: string; url: string; };
export type Comment = { id: number; body: string; user: { login: string; type: string }; };
export interface GitHubPort {
 listQueued(): Issue[]; comments(n: number): Comment[];
 commentOnce(n: number, body: string, key: string): void;
 syncState(n: number, state: WorkState): void;
 ensurePR(branch: string, title: string, body: string): string;
}
function gh(args: string[]) {
 const r = spawnSync("gh", args, { encoding: "utf8", timeout: 60000, maxBuffer: 10_000_000 });
 if (r.status !== 0) throw new Error(r.stderr || r.error?.message || "gh failed"); return r.stdout.trim();
}
export class GitHubAdapter implements GitHubPort {
 listQueued(): Issue[] {
  return JSON.parse(gh(["issue", "list", "--repo", config.repo, "--label", "factory:queued", "--state", "open", "--limit", "100", "--json", "number,title,body,url"]));
 }
 comments(n: number): Comment[] {
  return JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${config.repo}/issues/${n}/comments?per_page=100`])).flat();
 }
 commentOnce(n: number, body: string, key: string) {
  const marker = `<!-- ai-factory:${key} -->`;
  if (!this.comments(n).some(c => c.body.includes(marker))) gh(["issue", "comment", String(n), "--repo", config.repo, "--body", `${body}\n\n${marker}`]);
 }
 syncState(n: number, state: WorkState) {
  const label = `factory:${state.toLowerCase().replaceAll("_", "-")}`;
  const current = JSON.parse(gh(["issue", "view", String(n), "--repo", config.repo, "--json", "labels"])).labels as { name: string }[];
  if (current.some(l => l.name === label) && !current.some(l => l.name.startsWith("factory:") && l.name !== label)) return;
  gh(["label", "create", label, "--repo", config.repo, "--color", "7057ff", "--force"]);
  const args = ["issue", "edit", String(n), "--repo", config.repo, "--add-label", label];
  for (const l of current) if (l.name.startsWith("factory:") && l.name !== label) args.push("--remove-label", l.name);
  gh(args);
 }
 ensurePR(branch: string, title: string, body: string) {
  const prs = JSON.parse(gh(["pr", "list", "--repo", config.repo, "--head", branch, "--base", config.defaultBranch, "--state", "open", "--json", "url"]));
  if (prs.length) return prs[0].url as string;
  return gh(["pr", "create", "--repo", config.repo, "--head", branch, "--base", config.defaultBranch, "--title", title, "--body", body]);
 }
}

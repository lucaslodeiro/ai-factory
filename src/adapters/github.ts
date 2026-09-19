import { statePresentation } from "../presentation.js";
import { spawnSync } from "node:child_process";
import { config } from "../config.js";
import type { WorkState } from "../types.js";
export type Issue = { number: number; title: string; body: string; url: string; state?: "OPEN" | "CLOSED"; pullRequest?: boolean; labels?: Array<{ name: string }> };
export type Comment = { id: number; body: string; user: { login: string; type: string }; };
export type RepositoryComment = Comment & { issue_url: string; created_at: string; updated_at: string };
export interface PullRequestState { state: "OPEN" | "CLOSED" | "MERGED"; mergedAt: string | null; mergeCommit: { oid: string } | null; }
export interface GitHubPort {
 pullRequestState(url: string): PullRequestState;
 listQueued(): Issue[]; listManaged(): Issue[]; issue(n: number): Issue; comments(n: number): Comment[]; repositoryComments?(since: string): RepositoryComment[];
 commentOnce(n: number, body: string, key: string): void;
 syncState(n: number, state: WorkState, progress?: string): void;
 ensurePR(branch: string, title: string, body: string): string;
}
function gh(args: string[], input?: unknown) {
 const r = spawnSync("gh", args, { input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8", timeout: 60000, maxBuffer: 10_000_000 });
 if (r.status !== 0) throw new Error(r.stderr || r.error?.message || "gh failed"); return r.stdout.trim();
}
export class GitHubAdapter implements GitHubPort {
 constructor(private invoke: (args: string[], input?: unknown) => string = gh) {}
 listQueued(): Issue[] {
  return JSON.parse(this.invoke(["issue", "list", "--repo", config.repo, "--label", "factory:queued", "--state", "open", "--limit", "100", "--json", "number,title,body,url"]));
 }
 listManaged(): Issue[] {
  const managed = new Set(["factory:queued",...Object.keys(statePresentation).map(state => `factory:${state.toLowerCase().replaceAll("_","-")}`)]);
  const issues = JSON.parse(this.invoke(["issue","list","--repo",config.repo,"--state","open","--limit","1000","--json","number,title,body,url,labels"])) as Issue[];
  return issues.filter(issue => issue.labels?.some(label => managed.has(label.name)));
 }
 issue(n: number): Issue {
  const value=JSON.parse(this.invoke(["api",`repos/${config.repo}/issues/${n}`]));
  const state=String(value.state).toUpperCase();
  if (state !== "OPEN" && state !== "CLOSED") throw new Error(`Invalid issue state: ${value.state}`);
  return {number:value.number,title:value.title,body:value.body ?? "",url:value.html_url,state,pullRequest:Boolean(value.pull_request)};
 }
 comments(n: number): Comment[] {
  return JSON.parse(this.invoke(["api", "--paginate", "--slurp", `repos/${config.repo}/issues/${n}/comments?per_page=100`])).flat();
 }
 repositoryComments(since: string): RepositoryComment[] {
  const query=`repos/${config.repo}/issues/comments?per_page=100&sort=created&direction=asc&since=${encodeURIComponent(since)}`;
  return JSON.parse(this.invoke(["api","--paginate","--slurp",query])).flat();
 }
 commentOnce(n: number, body: string, key: string) {
  const marker = `<!-- ai-factory:${key} -->`;
  if (!this.comments(n).some(c => c.body.includes(marker))) this.invoke(["issue", "comment", String(n), "--repo", config.repo, "--body", `${body}\n\n${marker}`]);
 }
 syncState(n: number, state: WorkState, progress?: string) {
  const label = `factory:${state.toLowerCase().replaceAll("_", "-")}`;
  const display = statePresentation[state];
  const managed = new Set(["factory:queued", ...Object.keys(statePresentation).map(s => `factory:${s.toLowerCase().replaceAll("_", "-")}`)]);
  const current = JSON.parse(this.invoke(["issue", "view", String(n), "--repo", config.repo, "--json", "labels"])).labels as { name: string; color?: string; description?: string }[];
  const present = current.find(l => l.name === label);
  if (!present || present.color !== display.color || present.description !== display.description) this.invoke(["label", "create", label, "--repo", config.repo, "--color", display.color, "--description", display.description, "--force"]);
  const stale = current.filter(l => managed.has(l.name) && l.name !== label);
  if (!present || stale.length) {
   const args = ["issue", "edit", String(n), "--repo", config.repo, "--add-label", label];
   for (const l of stale) args.push("--remove-label", l.name);
   this.invoke(args);
  }
  if (progress) {
   const marker = `<!-- ai-factory:progress:${config.repo}:${n} -->`;
   const body = `${progress}\n\n${marker}`;
   const existing = this.comments(n).find(c => c.body.includes(marker));
   if (!existing) this.invoke(["issue", "comment", String(n), "--repo", config.repo, "--body", body]);
   else if (existing.body !== body) this.invoke(["api", `repos/${config.repo}/issues/comments/${existing.id}`, "--method", "PATCH", "--input", "-"], { body });
  }
 }
 pullRequestState(url: string): PullRequestState {
  const result = JSON.parse(this.invoke(["pr", "view", url, "--repo", config.repo, "--json", "state,mergedAt,mergeCommit"]));
  if (!["OPEN", "CLOSED", "MERGED"].includes(result.state) || (result.state === "MERGED" && !result.mergedAt)) throw new Error("Invalid pull request state from GitHub");
  return result;
 }
 ensurePR(branch: string, title: string, body: string) {
  const prs = JSON.parse(this.invoke(["pr", "list", "--repo", config.repo, "--head", branch, "--base", config.defaultBranch, "--state", "open", "--json", "url"]));
  if (prs.length) return prs[0].url as string;
  return this.invoke(["pr", "create", "--repo", config.repo, "--head", branch, "--base", config.defaultBranch, "--title", title, "--body", body]);
 }
}

import { spawnSync } from "node:child_process";
import { config } from "../config.js";
export type Issue = { id:number;nodeId:string;number: number; title: string; body: string; url: string; state?: "OPEN" | "CLOSED"; pullRequest?: boolean; labels?: Array<{ name: string }>;createdAt:string;updatedAt:string;author:{login:string;type:string} };
export type Comment = { id: number; body: string; user: { login: string; type: string };updatedAt:string };
export type RepositoryComment = Comment & { issueUrl: string; createdAt: string;issue_url:string;created_at:string;updated_at:string };
export type Repository = {id:number;nodeId:string;fullName:string;defaultBranch:string};
export interface PullRequestState { state: "OPEN" | "CLOSED" | "MERGED"; mergedAt: string | null; mergeCommit: { oid: string } | null; }
export interface GitHubPort {
 pullRequestState(url: string): PullRequestState;
 listManaged(): Issue[]; issue(n: number): Issue; comments(n: number): Comment[]; repository():Repository;repositoryComments?(since: string): RepositoryComment[];
 ensurePR(branch: string, title: string, body: string): string;
}
export interface WorkflowGitHubPort { syncWorkflow(n:number,labels:Array<{name:string;color:string;description:string}>,body:string):void; publishWorkflowComment(n:number,key:string,body:string):void; }
function gh(args: string[], input?: unknown) {
 const r = spawnSync("gh", args, { input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8", timeout: 60000, maxBuffer: 10_000_000 });
 if (r.status !== 0) throw new Error(r.stderr || r.error?.message || "gh failed"); return r.stdout.trim();
}
export class GitHubAdapter implements GitHubPort {
 constructor(private invoke: (args: string[], input?: unknown) => string = gh) {}
 listManaged(): Issue[] {
  const managed = new Set(["factory:design","factory:build","factory:test","factory:review","factory:delivery","factory:done","factory:waiting","factory:failed","factory:paused","factory:cancelled"]);
  const issues = (JSON.parse(this.invoke(["api","--paginate","--slurp",`repos/${config.repo}/issues?state=open&per_page=100`])) as unknown[][]).flat().map(value=>this.toIssue(value));
  return issues.filter(issue => issue.labels?.some(label => managed.has(label.name)));
 }
 syncWorkflow(n:number,labels:Array<{name:string;color:string;description:string}>,progress:string) {
  const managed=/^factory:(?:design|build|test|review|delivery|done|waiting|failed|paused|cancelled)$/;
  const current=JSON.parse(this.invoke(["issue","view",String(n),"--repo",config.repo,"--json","labels"])).labels as Array<{name:string;color?:string;description?:string}>;
  for(const label of labels) {
   const present=current.find(candidate=>candidate.name===label.name);
   if(!present||present.color!==label.color||present.description!==label.description)this.invoke(["label","create",label.name,"--repo",config.repo,"--color",label.color,"--description",label.description,"--force"]);
  }
  const wanted=new Set(labels.map(label=>label.name)),stale=current.filter(label=>managed.test(label.name)&&!wanted.has(label.name));
  if(labels.some(label=>!current.some(existing=>existing.name===label.name))||stale.length) {
   const args=["issue","edit",String(n),"--repo",config.repo];
   for(const label of labels)if(!current.some(existing=>existing.name===label.name))args.push("--add-label",label.name);
   for(const label of stale)args.push("--remove-label",label.name);
   this.invoke(args);
  }
  const marker=`<!-- ai-factory:workflow-status:${config.repo}:${n} -->`,body=`${progress}\n\n${marker}`;
  const existing=this.comments(n).find(comment=>comment.body.includes(marker));
  if(!existing)this.invoke(["issue","comment",String(n),"--repo",config.repo,"--body",body]);
  else if(existing.body!==body)this.invoke(["api",`repos/${config.repo}/issues/comments/${existing.id}`,"--method","PATCH","--input","-"],{body});
 }
 publishWorkflowComment(n:number,key:string,content:string) {
  const marker=`<!-- ai-factory:workflow-comment:${config.repo}:${n}:${key} -->`;
  if(this.comments(n).some(comment=>comment.body.includes(marker)))return;
  this.invoke(["issue","comment",String(n),"--repo",config.repo,"--body",`${content}\n\n${marker}`]);
 }
 issue(n: number): Issue {
  const value=JSON.parse(this.invoke(["api",`repos/${config.repo}/issues/${n}`]));
  return this.toIssue(value);
 }
 comments(n: number): Comment[] {
  return (JSON.parse(this.invoke(["api", "--paginate", "--slurp", `repos/${config.repo}/issues/${n}/comments?per_page=100`])) as unknown[][]).flat().map(value=>this.toComment(value));
 }
 repositoryComments(since: string): RepositoryComment[] {
  const query=`repos/${config.repo}/issues/comments?per_page=100&sort=created&direction=asc&since=${encodeURIComponent(since)}`;
  return (JSON.parse(this.invoke(["api","--paginate","--slurp",query])) as unknown[][]).flat().map(value=>{const raw=value as Record<string,any>;return {...this.toComment(raw),issueUrl:String(raw.issue_url),createdAt:String(raw.created_at),issue_url:String(raw.issue_url),created_at:String(raw.created_at),updated_at:String(raw.updated_at)};});
 }
 repository():Repository {const value=JSON.parse(this.invoke(["api",`repos/${config.repo}`]));return {id:value.id,nodeId:value.node_id,fullName:value.full_name,defaultBranch:value.default_branch};}
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
 private toIssue(value:unknown):Issue {const raw=value as Record<string,any>,state=String(raw.state).toUpperCase();if(state!=="OPEN"&&state!=="CLOSED")throw new Error(`Invalid issue state: ${raw.state}`);return {id:Number(raw.id),nodeId:String(raw.node_id),number:Number(raw.number),title:String(raw.title),body:String(raw.body??""),url:String(raw.html_url),state,pullRequest:Boolean(raw.pull_request),labels:Array.isArray(raw.labels)?raw.labels.map((label:any)=>({name:String(label.name)})):[],createdAt:String(raw.created_at),updatedAt:String(raw.updated_at),author:{login:String(raw.user?.login??""),type:String(raw.user?.type??"")}};}
 private toComment(value:unknown):Comment {const raw=value as Record<string,any>;return {id:Number(raw.id),body:String(raw.body??""),user:{login:String(raw.user?.login??""),type:String(raw.user?.type??"")},updatedAt:String(raw.updated_at)};}
}

import {createHash} from "node:crypto";
import {verificationPolicy,verificationPathAllowed,verificationArtifactAllowed,secretPath,type VerificationPolicy} from "./verification-paths.js";
import { execFile,spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { config,requiredRepoDir } from "./config.js";
import type {AgentRole} from "./types.js";
import {prototypeDirectory} from "./results.js";
import { buildRepositoryMap, type RepositoryMap } from "./repository-map.js";
function gitOutput(cwd: string, args: string[]) {
 const r = spawnSync(config.gitCommand, args, { cwd, encoding: "utf8", timeout: 60000, maxBuffer: 10_000_000 });
 if (r.status !== 0) throw new Error(r.stderr || r.error?.message || "git failed"); return r.stdout;
}
function gitSucceeds(cwd: string, args: string[]) {
 const result = spawnSync(config.gitCommand,args,{cwd,encoding:"utf8",timeout:60000,maxBuffer:10_000_000});
 return result.status === 0;
}
function gitFile(cwd:string,args:string[],file:string){
 const fd=fs.openSync(file,"wx",0o600);
 try{
  const result=spawnSync(config.gitCommand,args,{cwd,encoding:"utf8",timeout:60000,maxBuffer:65536,stdio:["ignore",fd,"pipe"]});
  if(result.status!==0)throw new Error(`Could not prepare reviewer diff: ${result.error?.message||result.stderr||`git exited ${result.status}`}`);
 }finally{fs.closeSync(fd);}
}
export function git(cwd: string, args: string[]) { return gitOutput(cwd, args).trim(); }
// Where the approved prototype lives once it leaves the branch: in the worktree for Builder, Tester
// and Reviewer to consult, excluded from Git so it never reaches the pull request.
export const approvedPrototypeDirectory=".factory-prototype";
const insidePrototype=(file:string)=>file.startsWith(`${prototypeDirectory}/`);
function excludeFromGit(cwd:string,entry:string){
 const value=git(cwd,["rev-parse","--git-path","info/exclude"]),exclude=path.isAbsolute(value)?value:path.resolve(cwd,value);fs.mkdirSync(path.dirname(exclude),{recursive:true});
 const current=fs.existsSync(exclude)?fs.readFileSync(exclude,"utf8"):"";if(!current.split(/\r?\n/).includes(entry))fs.appendFileSync(exclude,`${current&&!current.endsWith("\n")?"\n":""}${entry}\n`);
}
export interface WorkspaceSnapshot {head:string;files:Map<string,string>;dirty:string[];policy:VerificationPolicy;}
export interface WorkspaceSync {before:string;after:string;merged:string[];skipped?:string;}
export class SyncConflictError extends Error {
 constructor(public files:string[],public ref:string){super(`Could not merge ${ref}; conflicting files: ${files.join(", ")||"unknown"}`);this.name="SyncConflictError";}
}
export interface WorkspacePort {
 capture?(cwd:string):WorkspaceSnapshot;
 assertBranch(cwd: string, branch: string): void;
 ensure(id: string, branch: string): string;
 sync(cwd:string,branch:string,base:string,role:AgentRole):WorkspaceSync;
 head(cwd: string): string;
 diff(cwd: string): string;
 check(cwd: string, role: string, before: string, branch: string, baseline?:WorkspaceSnapshot): string[]|void;
 commit(cwd: string, message: string, branch: string, files?:string[]): void;
 publish(cwd: string, branch: string): void;
 publishAsync?(cwd:string,branch:string):Promise<void>;
 changeSummary(cwd:string):{files:string[];stat:string};
 changeSummarySince?(cwd:string,base:string):{files:string[];stat:string};
 repositoryMap?(cwd:string):RepositoryMap|undefined;
 prepareReviewerContext(cwd:string,workItemId:string):{path:string;files:string[];stat:string};
 archivePrototype?(cwd:string,branch:string,message:string):boolean;
 cleanupReviewerContext(cwd:string,workItemId:string):void;
}
export class Workspaces implements WorkspacePort {
 assertBranch(cwd: string, branch: string) {
  if (!branch.startsWith("factory/") || branch === config.defaultBranch || git(cwd, ["branch", "--show-current"]) !== branch) throw new Error("Worktree branch mismatch; expected assigned factory branch");
 }
 ensure(id: string, branch: string) {
  const repoDir=requiredRepoDir();
  const root = path.join(config.dataDir, "worktrees"); fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, id);
  if (fs.existsSync(target)) {
   this.assertBranch(target, branch);
   return target;
  }
  git(repoDir, ["fetch", "origin", config.defaultBranch]);
  git(repoDir,["worktree","prune"]);
  if (gitSucceeds(repoDir,["show-ref","--verify","--quiet",`refs/heads/${branch}`])) {
   git(repoDir,["worktree","add",target,branch]);
  } else {
   const remoteBranch = gitSucceeds(repoDir,["fetch","origin",`${branch}:refs/remotes/origin/${branch}`])
    && gitSucceeds(repoDir,["show-ref","--verify","--quiet",`refs/remotes/origin/${branch}`]);
   git(repoDir,["worktree","add","-b",branch,target,remoteBranch ? `origin/${branch}` : `origin/${config.defaultBranch}`]);
  }
  return target;
 }
 sync(cwd:string,branch:string,base:string,role:AgentRole):WorkspaceSync {
  this.assertBranch(cwd,branch);
  const before=this.head(cwd),issue=branch.match(/^factory\/issue-(\d+)$/)?.[1]??branch;
  const dirty=this.capture(cwd).dirty;
  const reject=(reason:string,files:string[])=>{if(files.length)throw new Error(`${reason}: ${files.map(file=>JSON.stringify(file)).join(", ")}`);};
  reject("Potential credential file in changes; inspect before commit",dirty.filter(secretPath));
  if(role==="product-architect"||role==="reviewer")reject(`${role} cannot continue with uncommitted worktree changes`,dirty);
  if(role==="designer")reject(`Designer cannot continue with uncommitted changes outside ${prototypeDirectory}/`,dirty.filter(file=>!insidePrototype(file)));
  if(role==="qa"){
   // These files are about to be committed and pushed, usually left by a Tester that timed out
   // before check() ran, so they meet the same rules check() applies to a finished execution.
   const policy=verificationPolicy(cwd);
   reject("Verification Engineer cannot continue with a protected non-test file (only tests and declared verification artifacts are allowed)",dirty.filter(file=>!verificationPathAllowed(file,policy)));
   reject("Verification Engineer cannot continue with verification artifacts/tests that are links or executable evidence",dirty.filter(file=>this.unsafeVerificationFile(cwd,file,policy)));
  }
  if(dirty.length)this.commit(cwd,`factory: work in progress for #${issue}`,branch);
  const baseFetch=spawnSync(config.gitCommand,["fetch","origin",base],{cwd,encoding:"utf8",timeout:60000,maxBuffer:10_000_000});
  if(baseFetch.status!==0)return{before,after:this.head(cwd),merged:[],skipped:baseFetch.stderr||baseFetch.error?.message||"git fetch failed"};
  const branchFetch=spawnSync(config.gitCommand,["fetch","origin",`${branch}:refs/remotes/origin/${branch}`],{cwd,encoding:"utf8",timeout:60000,maxBuffer:10_000_000});
  if(branchFetch.status!==0&&!/couldn't find remote ref|remote ref .* not found/i.test(branchFetch.stderr||""))return{before,after:this.head(cwd),merged:[],skipped:branchFetch.stderr||branchFetch.error?.message||"git fetch failed"};
  const merged:string[]=[];
  for(const ref of [`origin/${branch}`,`origin/${base}`]){
   if(!gitSucceeds(cwd,["show-ref","--verify","--quiet",`refs/remotes/${ref}`])||gitSucceeds(cwd,["merge-base","--is-ancestor",ref,"HEAD"]))continue;
   const merge=spawnSync(config.gitCommand,["merge","--no-edit",ref],{cwd,encoding:"utf8",timeout:60000,maxBuffer:10_000_000});
   if(merge.status!==0){const files=gitOutput(cwd,["diff","--name-only","--diff-filter=U","-z"]).split("\0").filter(Boolean);if(gitSucceeds(cwd,["rev-parse","--verify","MERGE_HEAD"]))git(cwd,["merge","--abort"]);if(files.length)throw new SyncConflictError(files,ref);throw new Error(merge.stderr||merge.error?.message||`Could not merge ${ref}`);}
   merged.push(ref);
  }
  return{before,after:this.head(cwd),merged};
 }
 head(cwd: string) { return git(cwd, ["rev-parse", "HEAD"]); }
 diff(cwd: string) { return git(cwd, ["diff", `origin/${config.defaultBranch}...HEAD`]); }
 capture(cwd:string,policy?:VerificationPolicy):WorkspaceSnapshot {
  const index=new Map<string,string>();
  for(const entry of gitOutput(cwd,["ls-files","--stage","-z"]).split("\0").filter(Boolean)){const tab=entry.indexOf("\t");index.set(entry.slice(tab+1),entry.slice(0,tab));}
  const names=new Set([...index.keys(),...gitOutput(cwd,["ls-files","--others","--exclude-standard","-z"]).split("\0").filter(Boolean)]);
  const files=new Map<string,string>();
  for(const name of names){const file=path.join(cwd,name);let content="missing";
   if(this.unsafeParent(cwd,name))content="unsafe-parent";
   else try{const stat=fs.lstatSync(file);content=stat.isSymbolicLink()?`symlink:${fs.readlinkSync(file)}`:stat.isFile()?`${stat.mode&0o777}:${stat.nlink}:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`:"directory";}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
   files.set(name,`${index.get(name)??"untracked"}:${content}`);
  }
  const dirty=[...new Set([...gitOutput(cwd,["diff","--name-only","--no-renames","-z","HEAD"]).split("\0"),...gitOutput(cwd,["ls-files","--others","--exclude-standard","-z"]).split("\0")].filter(Boolean))];
  return{head:this.head(cwd),files,dirty,policy:policy??verificationPolicy(cwd)};
 }
 private unsafeVerificationFile(cwd:string,file:string,policy:VerificationPolicy){
  if(this.unsafeParent(cwd,file))return true;
  try{const stat=fs.lstatSync(path.join(cwd,file));return !stat.isFile()||stat.nlink>1||(policy.evidenceDirectories.some(dir=>file.startsWith(dir+"/"))&&Boolean(stat.mode&0o111));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}
 }
 private unsafeParent(cwd:string,file:string){const parts=file.split("/");parts.pop();let parent=cwd;for(const part of parts){parent=path.join(parent,part);try{if(fs.lstatSync(parent).isSymbolicLink())return true;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}return false;}
 check(cwd: string, role: string, before: string, branch: string, baseline?:WorkspaceSnapshot) {
  this.assertBranch(cwd, branch);
  if (this.head(cwd) !== before) throw new Error("Agents must not create commits; orchestrator owns commits");
  const current=baseline?this.capture(cwd,baseline.policy):undefined;
  // Builder owns the complete pending implementation across retries; restricted
  // roles are accountable only for their execution delta.
  const changed=role!=="developer"&&baseline&&current?[...new Set([...baseline.files.keys(),...current.files.keys()])].filter(file=>baseline.files.get(file)!==current.files.get(file)):[...new Set([...gitOutput(cwd,["diff","--name-only","--no-renames","-z","HEAD"]).split("\0"),...gitOutput(cwd,["ls-files","--others","--exclude-standard","-z"]).split("\0")].filter(Boolean))];
  const reject=(reason:string,files:string[])=>{if(files.length)throw new Error(`${reason}: ${files.map(file=>JSON.stringify(file)).join(", ")}`);};
  reject("Potential credential file in changes; inspect before commit",changed.filter(secretPath));
  if(role==="product-architect"||role==="reviewer")reject(`${role} modified the worktree`,changed);
  if(role==="designer"){
   reject(`Designer may only write the disposable prototype under ${prototypeDirectory}/`,changed.filter(file=>!insidePrototype(file)));
   reject("Prototype files must be regular, non-executable files",changed.filter(file=>{if(this.unsafeParent(cwd,file))return true;try{const stat=fs.lstatSync(path.join(cwd,file));return !stat.isFile()||stat.nlink>1||Boolean(stat.mode&0o111);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}}));
  }
  if(role==="qa"){
   const policy=baseline?.policy??verificationPolicy(cwd);
   reject("Verification Engineer modified a protected non-test file (only tests and declared verification artifacts are allowed)",changed.filter(file=>!verificationPathAllowed(file,policy)));
   reject("Verification artifacts/tests must be regular files, not links or executable evidence",changed.filter(file=>this.unsafeVerificationFile(cwd,file,policy)));
  }
  if(baseline&&(role==="qa"||role==="reviewer"))reject("Pre-existing uncommitted code or configuration needs review before verification can be accepted (not attributed to this agent)",baseline.dirty.filter(file=>!changed.includes(file)&&!verificationArtifactAllowed(file,baseline.policy)));
  return changed;
 }
 commit(cwd: string, message: string, branch: string, files?:string[]) {
  this.assertBranch(cwd, branch);
  if(files){
   const paths=files.filter(file=>fs.existsSync(path.join(cwd,file))||gitSucceeds(cwd,["ls-files","--error-unmatch","--",`:(literal)${file}`])).map(file=>`:(literal)${file}`);
   if(!paths.length)return;
   git(cwd,["add","--all","--",...paths]);
   if(git(cwd,["diff","--cached","--name-only","--",...paths]))git(cwd,["commit","--only","-m",message,"--",...paths]);
  }else{
   git(cwd,["add","--all"]);
   if(git(cwd,["diff","--cached","--name-only"]))git(cwd,["commit","-m",message]);
  }
 }

 // Moves the approved prototype out of the branch before the Builder starts. Git history keeps the
 // commit the human approved; the pull request diff never contains it.
 archivePrototype(cwd:string,branch:string,message:string){
  this.assertBranch(cwd,branch);
  const tracked=gitOutput(cwd,["ls-files","-z","--",prototypeDirectory]).split("\0").filter(Boolean);
  if(!tracked.length)return false;
  const target=path.join(cwd,approvedPrototypeDirectory);
  if(gitOutput(cwd,["ls-files","--",approvedPrototypeDirectory]).trim())throw new Error(`Refusing to replace tracked ${approvedPrototypeDirectory}`);
  if(fs.existsSync(target)){if(fs.lstatSync(target).isSymbolicLink())throw new Error(`${approvedPrototypeDirectory} must not be a link`);fs.rmSync(target,{recursive:true});}
  excludeFromGit(cwd,`/${approvedPrototypeDirectory}/`);
  for(const file of tracked){if(this.unsafeParent(cwd,file))throw new Error(`Prototype file ${file} is behind a link`);const source=path.join(cwd,file);if(!fs.existsSync(source)||!fs.lstatSync(source).isFile())continue;const destination=path.join(target,path.relative(prototypeDirectory,file));fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(source,destination);}
  git(cwd,["rm","-r","-q","--",prototypeDirectory]);
  git(cwd,["commit","-q","-m",message]);
  return true;
 }

 async publishAsync(cwd:string,branch:string){
  this.assertBranch(cwd,branch);
  await new Promise<void>((resolve,reject)=>execFile(config.gitCommand,["push","--set-upstream","origin",`HEAD:refs/heads/${branch}`],{cwd,timeout:60000,maxBuffer:10000000},(error,_stdout,stderr)=>error?reject(new Error(stderr||error.message)):resolve()));
 }
 publish(cwd: string, branch: string) {
  if (!branch.startsWith("factory/") || branch === config.defaultBranch || git(cwd, ["branch", "--show-current"]) !== branch) throw new Error("Refusing to push unexpected branch");
  git(cwd, ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`]);
 }
 changeSummary(cwd:string){const range=`origin/${config.defaultBranch}...HEAD`,files=gitOutput(cwd,["diff","--name-only","--no-renames","-z",range]).split("\0").filter(Boolean),stat=gitOutput(cwd,["diff","--stat",range]).trim();return{files,stat};}
 changeSummarySince(cwd:string,base:string){const range=`${base}..HEAD`,files=gitOutput(cwd,["diff","--name-only","--no-renames","-z",range]).split("\0").filter(Boolean),stat=gitOutput(cwd,["diff","--stat",range]).trim();return{files,stat};}
 // Tracked files only: what .gitignore excludes is not part of the repository a Builder edits.
 repositoryMap(cwd:string){
  try { return buildRepositoryMap(gitOutput(cwd,["ls-files","-z"]).split("\0")); } catch { return undefined; }
 }
 prepareReviewerContext(cwd:string,workItemId:string){const directory=path.join(cwd,".factory-context"),owner=path.join(directory,"OWNER"),diff=path.join(directory,"review.diff"),expected=`ai-factory:${workItemId}\n`;
  this.assertContextSafe(cwd,directory,owner,expected,true);if(fs.existsSync(directory))fs.rmSync(directory,{recursive:true});fs.mkdirSync(directory,{mode:0o700});fs.writeFileSync(owner,expected,{mode:0o600});try{const summary=this.changeSummary(cwd);gitFile(cwd,["diff","--no-ext-diff","--no-textconv","--binary",`origin/${config.defaultBranch}...HEAD`],diff);
  excludeFromGit(cwd,"/.factory-context/");
  return{path:diff,files:summary.files,stat:summary.stat};
  }catch(error){try{this.cleanupReviewerContext(cwd,workItemId);}catch{}throw error;}
 }
 cleanupReviewerContext(cwd:string,workItemId:string){const directory=path.join(cwd,".factory-context"),owner=path.join(directory,"OWNER");if(!fs.existsSync(directory))return;this.assertContextSafe(cwd,directory,owner,`ai-factory:${workItemId}\n`,false);fs.rmSync(directory,{recursive:true});}
 private assertContextSafe(cwd:string,directory:string,owner:string,expected:string,allowMissing:boolean){if(!fs.existsSync(directory)){if(allowMissing)return;throw new Error("Reviewer context directory is missing");}const stat=fs.lstatSync(directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error("Reviewer context path must be an owned directory");if(gitOutput(cwd,["ls-files","--",path.relative(cwd,directory)]).trim())throw new Error("Refusing to replace a tracked reviewer context directory");if(!fs.existsSync(owner)||fs.lstatSync(owner).isSymbolicLink()||fs.readFileSync(owner,"utf8")!==expected)throw new Error("Reviewer context directory is foreign or has no valid owner marker");}
}

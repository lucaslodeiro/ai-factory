import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";

export const normalizedRepository=(value:string)=>value.trim().replace(/^git@github\.com:/,"https://github.com/").replace(/\/$/,"").replace(/\.git$/i,"").toLowerCase();
export type RepositorySetup={repoDir:string;repo:string;defaultBranch:string;gitCommand:string};
export function prepareRepository(settings:RepositorySetup,account=()=>{
 const result=spawnSync(process.env.GH_COMMAND??"gh",["api","user"],{encoding:"utf8",timeout:30000});
 if(result.status!==0)throw new Error("Cannot read the authenticated GitHub account to configure the local Git identity");
 return JSON.parse(result.stdout) as {login:string;id:number};
}) {
 const root=path.resolve(settings.repoDir),url=`https://github.com/${settings.repo}.git`;
 const git=(args:string[],allow=false,cwd=root)=>{
  const result=spawnSync(settings.gitCommand,args,{cwd,encoding:"utf8",timeout:120000});
  if(!allow&&result.status!==0)throw new Error((result.stderr||result.error?.message||`git ${args[0]} failed`).trim().replace(/(https?:\/\/)[^/@\s]+@/g,"$1***@"));
  return {ok:result.status===0,text:result.stdout?.trim()??""};
 };
 if(!/^[\w.-]+\/[\w.-]+$/.test(settings.repo))throw new Error("Configure a valid GITHUB_REPOSITORY before preparing the checkout");
 if(!git(["check-ref-format",`refs/heads/${settings.defaultBranch}`],true,process.cwd()).ok)throw new Error("Invalid repository base branch");
 if(fs.existsSync(root)&&!fs.statSync(root).isDirectory())throw new Error(`Target checkout is not a directory: ${root}`);
 if(!fs.existsSync(root)||fs.readdirSync(root).length===0){
  fs.mkdirSync(path.dirname(root),{recursive:true});
  git(["clone",url,root],false,path.dirname(root));
 }
 const top=git(["rev-parse","--show-toplevel"],true);
 if(!top.ok||fs.realpathSync(top.text)!==fs.realpathSync(root))throw new Error(`Target path must be a Git checkout root: ${root}`);
 if(normalizedRepository(git(["config","--get","remote.origin.url"]).text)!==normalizedRepository(url))throw new Error(`Target checkout origin does not match ${settings.repo}`);
 const refs=git(["ls-remote","origin"]); // An inaccessible remote is never treated as empty.
 const base=refs.text.split("\n").find(line=>line.endsWith(`\trefs/heads/${settings.defaultBranch}`));
 if(refs.text&&!base)throw new Error(`Remote base branch ${settings.defaultBranch} does not exist; the remote is not empty`);
 const missing=["user.name","user.email"].filter(key=>!git(["config",key],true).text);
 if(missing.length){
  const user=account();
  if(!/^[a-zA-Z0-9-]+$/.test(user.login)||!Number.isSafeInteger(user.id)||user.id<=0)throw new Error("Invalid authenticated GitHub identity");
  for(const key of missing)git(["config","--local",key,key==="user.name"?user.login:`${user.id}+${user.login}@users.noreply.github.com`]);
 }
 const head=git(["rev-parse","--verify","HEAD"],true);
 if(!head.ok){
  if(git(["status","--porcelain"]).text)throw new Error("Cannot initialize a checkout containing local changes");
  if(base){
   git(["fetch","origin",settings.defaultBranch]);
   git(["checkout","-B",settings.defaultBranch,`origin/${settings.defaultBranch}`]);
  }else{
   git(["symbolic-ref","HEAD",`refs/heads/${settings.defaultBranch}`]);
   fs.writeFileSync(path.join(root,"README.md"),`# ${settings.repo.split("/")[1]}\n\nDemo application managed by AI Factory.\n`,{flag:"wx"});
   git(["add","--","README.md"]);
   git(["commit","-m","chore: initialize demo"]);
   git(["config","--local","factory.bootstrapCommit",git(["rev-parse","HEAD"]).text]);
  }
 }
 const pending=git(["config","--get","factory.bootstrapCommit"],true).text;
 if(pending){
  if(git(["branch","--show-current"]).text!==settings.defaultBranch||git(["rev-parse","HEAD"]).text!==pending||git(["status","--porcelain"]).text)throw new Error("Bootstrap checkout changed before publication; review local changes");
  // Explicit refspec and no force: never overwrite a branch created concurrently.
  git(["push","-u","origin",`HEAD:refs/heads/${settings.defaultBranch}`]);
  git(["config","--local","--unset","factory.bootstrapCommit"]);
 }else if(!base)throw new Error("Remote is empty but the checkout has existing commits; publish them explicitly");
 return {root};
}

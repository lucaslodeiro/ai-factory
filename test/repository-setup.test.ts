import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {prepareRepository} from "../src/repository-setup.js";
import {StartupError,startupExitCode} from "../src/startup-error.js";

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-setup-")),remote=path.join(root,"remote.git"),checkout=path.join(root,"repos","demo"),home=path.join(root,"home");fs.mkdirSync(home);
 const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
 const wrapper=path.join(root,"git");
 fs.writeFileSync(wrapper,`#!/bin/sh\nexport HOME=${quote(home)}\nexport GIT_CONFIG_NOSYSTEM=1\nexport GIT_CONFIG_GLOBAL=/dev/null\nexec /usr/bin/git -c ${quote(`url.file://${remote}.insteadOf=https://github.com/owner/demo.git`)} "$@"\n`,{mode:0o755});
 const git=(args:string[],cwd=root)=>{const r=spawnSync(wrapper,args,{cwd,encoding:"utf8"});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 git(["init","--bare",remote]);const settings={repoDir:checkout,repo:"owner/demo",defaultBranch:"main",gitCommand:wrapper};
 const prepare=()=>prepareRepository(settings,()=>({login:"owner",id:123}));
 return {root,remote,checkout,git,settings,prepare,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test("startup clones an absent checkout, initializes an empty remote and preserves identity on repeat",()=>{
 const f=fixture();try{
  f.prepare();const head=f.git(["rev-parse","HEAD"],f.checkout);
  assert.equal(f.git(["rev-parse","main"],f.remote),head);
  assert.equal(f.git(["config","user.email"],f.checkout),"123+owner@users.noreply.github.com");
  assert.equal(f.git(["status","--porcelain"],f.checkout),"");
  assert.equal(f.git(["rev-parse","--abbrev-ref","@{upstream}"],f.checkout),"origin/main");
  assert.match(fs.readFileSync(path.join(f.checkout,"README.md"),"utf8"),/^# demo\n/);
  f.git(["config","user.name","Existing Author"],f.checkout);f.prepare();
  assert.equal(f.git(["rev-parse","HEAD"],f.checkout),head);
  assert.equal(f.git(["config","user.name"],f.checkout),"Existing Author");
 }finally{f.close();}
});
test("startup clones a populated remote even when its symbolic HEAD is unset",()=>{
 const f=fixture();try{f.prepare();const head=f.git(["rev-parse","HEAD"],f.checkout);fs.rmSync(f.checkout,{recursive:true});f.prepare();assert.equal(f.git(["rev-parse","HEAD"],f.checkout),head);}finally{f.close();}
});
test("startup refuses wrong origin and does not initialize a nonempty remote missing the base branch",()=>{
 const f=fixture();try{
  f.prepare();f.git(["remote","set-url","origin","https://github.com/other/demo.git"],f.checkout);
  assert.throws(f.prepare,/origin does not match/);
  f.git(["remote","set-url","origin","https://github.com/owner/demo.git"],f.checkout);
  const head=f.git(["rev-parse","HEAD"],f.checkout);f.git(["update-ref","refs/heads/trunk",head],f.remote);f.git(["update-ref","-d","refs/heads/main"],f.remote);
  assert.throws(f.prepare,/remote is not empty/);assert.equal(f.git(["show-ref"],f.remote),`${head} refs/heads/trunk`);
 }finally{f.close();}
});
test("startup preserves untracked files in an unborn checkout",()=>{
 const f=fixture();try{fs.mkdirSync(path.dirname(f.checkout),{recursive:true});f.git(["clone","https://github.com/owner/demo.git",f.checkout]);fs.writeFileSync(path.join(f.checkout,"README.md"),"my draft");assert.throws(f.prepare,/local changes/);assert.equal(fs.readFileSync(path.join(f.checkout,"README.md"),"utf8"),"my draft");assert.equal(f.git(["ls-remote",f.remote]),"");}finally{f.close();}
});
test("failed initial push can be retried without a second commit",()=>{
 const f=fixture();try{
  const hook=path.join(f.remote,"hooks","pre-receive");fs.writeFileSync(hook,"#!/bin/sh\nexit 1\n",{mode:0o755});assert.throws(f.prepare,/rejected/);
  const head=f.git(["rev-parse","HEAD"],f.checkout);fs.rmSync(hook);f.prepare();assert.equal(f.git(["rev-parse","main"],f.remote),head);assert.equal(f.git(["rev-list","--count","main"],f.remote),"1");
 }finally{f.close();}
});
test("managed startup failures stop launchd retries but CLI and runtime errors remain failures",()=>{
 assert.equal(startupExitCode(new StartupError("setup"),true),0);assert.equal(startupExitCode(new StartupError("setup"),false),1);assert.equal(startupExitCode(new Error("runtime"),true),1);
});

test("doctor reports a missing checkout without misleading identity, origin or branch failures",async()=>{
 const {doctor}=await import("../src/doctor.js"),{config}=await import("../src/config.js"),{Store}=await import("../src/storage.js");
 const f=fixture(),old={repoDir:config.repoDir,repo:config.repo,codexCommand:config.codexCommand,claudeCommand:config.claudeCommand},oldPath=process.env.PATH,log=console.log,lines:string[]=[],store=new Store(":memory:");
 const fake=path.join(f.root,"gh");fs.writeFileSync(fake,'#!/bin/sh\necho \'{"loggedIn":true}\'\n',{mode:0o755});
 try{
  Object.assign(config,{repoDir:f.checkout,repo:"owner/demo",codexCommand:fake,claudeCommand:fake});process.env.PATH=`${f.root}:${oldPath}`;console.log=(...values)=>{lines.push(values.join(" "));};
  assert.equal(doctor(store,{repository:()=>({id:1,nodeId:"R_1",fullName:"owner/demo",defaultBranch:"main"})}),false);
  assert.match(lines.join("\n"),/✗ Target checkout directory exists:/);
  assert.doesNotMatch(lines.join("\n"),/✗ (Git user|Target checkout origin|Remote base branch)/);
  assert.equal(fs.existsSync(path.resolve("instance.json")),false,"doctor must not create an instance identity");
 }finally{console.log=log;Object.assign(config,old);process.env.PATH=oldPath;store.db.close();f.close();}
});

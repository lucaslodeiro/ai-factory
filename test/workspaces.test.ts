import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncConflictError,Workspaces, git } from "../src/worktrees.js";
import { config } from "../src/config.js";
test("real Git worktree isolation, QA boundaries, commit and branch publication", async() => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-git-"));
 try {
  const origin = path.join(root,"origin.git"), repo = path.join(root,"repo"); fs.mkdirSync(origin); fs.mkdirSync(repo);
  git(origin,["init","--bare"]); git(repo,["init"]); git(repo,["config","user.name","Factory Test"]); git(repo,["config","user.email","factory@example.test"]);
  fs.writeFileSync(path.join(repo,"app.txt"),"base"); git(repo,["add","."]); git(repo,["commit","-m","base"]); git(repo,["branch","-M","main"]);
  git(repo,["remote","add","origin",origin]); git(repo,["push","-u","origin","main"]);
  config.repoDir=repo; config.dataDir=path.join(root,"data"); const ws=new Workspaces(); const branch="factory/issue-1";
  const cwd=ws.ensure("one",branch,"main"), before=ws.head(cwd); assert.equal(ws.ensure("one",branch,"main"),cwd);
  fs.writeFileSync(path.join(cwd,"app.txt"),"implementation"); assert.throws(()=>ws.check(cwd,"qa",before,branch),/non-test/);
  assert.throws(()=>ws.check(cwd,"reviewer",before,branch),/modified/); ws.check(cwd,"developer",before,branch); ws.commit(cwd,"implementation",branch);
  fs.mkdirSync(path.join(cwd,"test")); fs.writeFileSync(path.join(cwd,"test","app.test.ts"),"test");
  ws.check(cwd,"qa",ws.head(cwd),branch); ws.commit(cwd,"test",branch); await ws.publishAsync(cwd,branch);
  assert.equal(git(origin,["rev-parse",`refs/heads/${branch}`]),ws.head(cwd)); assert.equal(fs.readFileSync(path.join(repo,"app.txt"),"utf8"),"base");
  assert.throws(()=>ws.publish(cwd,"main"),/Refusing/);
  // Branch switches at the same HEAD must fail before any orchestrator commit.
  git(cwd,["checkout","-b","unexpected"]);
  assert.throws(()=>ws.check(cwd,"developer",ws.head(cwd),branch),/branch mismatch/);
  fs.writeFileSync(path.join(cwd,"pending.txt"),"uncommitted");
  assert.throws(()=>ws.commit(cwd,"must not commit",branch),/branch mismatch/);
  assert.equal(git(cwd,["diff","--cached","--name-only"]),"");
  fs.unlinkSync(path.join(cwd,"pending.txt")); git(cwd,["checkout",branch]);
  git(cwd,["checkout","--detach"]);
  assert.throws(()=>ws.assertBranch(cwd,branch),/branch mismatch/);
  git(cwd,["checkout",branch]);
  // Valid Unicode/quoted test names are allowed; raw credential names remain blocked.
  const unicodeTest=path.join(cwd,"test","á\ncase.test.ts");
  fs.writeFileSync(unicodeTest,"test"); ws.check(cwd,"qa",ws.head(cwd),branch); fs.unlinkSync(unicodeTest);
  const secret=path.join(cwd,"credentials\tprivate");
  fs.writeFileSync(secret,"fixture");
  assert.throws(()=>ws.check(cwd,"developer",ws.head(cwd),branch),/credential/); fs.unlinkSync(secret);
  const spaced=path.join(cwd," test/looks.testless");
  fs.mkdirSync(path.dirname(spaced)); fs.writeFileSync(spaced,"not a test filename");
  assert.throws(()=>ws.check(cwd,"qa",ws.head(cwd),branch),/non-test/); fs.unlinkSync(spaced);
  // A staged rename must check its source as well as its destination.
  git(cwd,["mv","app.txt","test/moved.test.ts"]);
  assert.throws(()=>ws.check(cwd,"qa",ws.head(cwd),branch),/non-test/);
  // Recovery may preserve the branch while its previous worktree directory is gone.
  git(repo,["worktree","remove","--force",cwd]);
  config.dataDir=path.join(root,"recovered-data");
  const recovered=new Workspaces().ensure("recovered",branch,"main");
  assert.equal(git(recovered,["branch","--show-current"]),branch);
  assert.equal(fs.readFileSync(path.join(recovered,"app.txt"),"utf8"),"implementation");

 } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test("ensure restores a deterministic branch that exists only in the remote",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-remote-branch-")),old={repoDir:config.repoDir,dataDir:config.dataDir};
 try {
  const origin=path.join(root,"origin.git"),seed=path.join(root,"seed"),checkout=path.join(root,"checkout"),branch="factory/issue-9";
  fs.mkdirSync(origin);fs.mkdirSync(seed);git(origin,["init","--bare"]);git(seed,["init"]);git(seed,["config","user.name","Factory Test"]);git(seed,["config","user.email","factory@example.test"]);
  fs.writeFileSync(path.join(seed,"base.txt"),"base\n");git(seed,["add","."]);git(seed,["commit","-m","base"]);git(seed,["branch","-M","main"]);git(seed,["remote","add","origin",origin]);git(seed,["push","-u","origin","main"]);
  git(seed,["checkout","-b",branch]);fs.writeFileSync(path.join(seed,"continued.txt"),"remote work\n");git(seed,["add","."]);git(seed,["commit","-m","continued work"]);git(seed,["push","origin",branch]);
  git(root,["clone","--branch","main",origin,checkout]);git(checkout,["config","user.name","Factory Test"]);git(checkout,["config","user.email","factory@example.test"]);
  config.repoDir=checkout;config.dataDir=path.join(root,"data");const cwd=new Workspaces().ensure("new-item",branch,"main");
  assert.equal(git(cwd,["branch","--show-current"]),branch);assert.equal(fs.readFileSync(path.join(cwd,"continued.txt"),"utf8"),"remote work\n");assert.equal(git(cwd,["rev-parse","HEAD"]),git(origin,["rev-parse",`refs/heads/${branch}`]));
 } finally {config.repoDir=old.repoDir;config.dataDir=old.dataDir;fs.rmSync(root,{recursive:true,force:true});}
});

test("sync preserves interrupted work and merges remote work and base commits",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-sync-")),old={repoDir:config.repoDir,dataDir:config.dataDir};
 try{
  const origin=path.join(root,"origin.git"),seed=path.join(root,"seed"),repo=path.join(root,"repo"),branch="factory/issue-12";
  fs.mkdirSync(origin);fs.mkdirSync(seed);git(origin,["init","--bare"]);git(seed,["init"]);git(seed,["config","user.name","Factory Test"]);git(seed,["config","user.email","factory@example.test"]);
  fs.writeFileSync(path.join(seed,"shared.txt"),"base\n");git(seed,["add","."]);git(seed,["commit","-m","base"]);git(seed,["branch","-M","main"]);git(seed,["remote","add","origin",origin]);git(seed,["push","-u","origin","main"]);
  git(root,["clone","--branch","main",origin,repo]);git(repo,["config","user.name","Factory Test"]);git(repo,["config","user.email","factory@example.test"]);config.repoDir=repo;config.dataDir=path.join(root,"data");
  const ws=new Workspaces(),cwd=ws.ensure("work-12",branch,"main");fs.writeFileSync(path.join(cwd,"partial.txt"),"preserved\n");
  git(seed,["checkout","-b",branch]);fs.writeFileSync(path.join(seed,"human.txt"),"remote branch\n");git(seed,["add","."]);git(seed,["commit","-m","human branch"]);git(seed,["push","origin",branch]);
  git(seed,["checkout","main"]);fs.writeFileSync(path.join(seed,"base.txt"),"new base\n");git(seed,["add","."]);git(seed,["commit","-m","base update"]);git(seed,["push","origin","main"]);
  const synced=ws.sync(cwd,branch,"main","developer");assert.deepEqual(synced.merged,[`origin/${branch}`,"origin/main"]);assert.equal(fs.readFileSync(path.join(cwd,"partial.txt"),"utf8"),"preserved\n");assert.equal(fs.readFileSync(path.join(cwd,"human.txt"),"utf8"),"remote branch\n");assert.equal(fs.readFileSync(path.join(cwd,"base.txt"),"utf8"),"new base\n");assert.match(git(cwd,["log","--format=%s","-4"]),/factory: work in progress for #12/);
 }finally{config.repoDir=old.repoDir;config.dataDir=old.dataDir;fs.rmSync(root,{recursive:true,force:true});}
});

test("sync aborts a conflicting merge and reports the conflicting files",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-sync-conflict-")),old={repoDir:config.repoDir,dataDir:config.dataDir};
 try{
  const origin=path.join(root,"origin.git"),seed=path.join(root,"seed"),repo=path.join(root,"repo"),branch="factory/issue-13";
  fs.mkdirSync(origin);fs.mkdirSync(seed);git(origin,["init","--bare"]);git(seed,["init"]);git(seed,["config","user.name","Factory Test"]);git(seed,["config","user.email","factory@example.test"]);fs.writeFileSync(path.join(seed,"same.txt"),"base\n");git(seed,["add","."]);git(seed,["commit","-m","base"]);git(seed,["branch","-M","main"]);git(seed,["remote","add","origin",origin]);git(seed,["push","-u","origin","main"]);
  git(root,["clone","--branch","main",origin,repo]);git(repo,["config","user.name","Factory Test"]);git(repo,["config","user.email","factory@example.test"]);config.repoDir=repo;config.dataDir=path.join(root,"data");const ws=new Workspaces(),cwd=ws.ensure("work-13",branch,"main");
  fs.writeFileSync(path.join(cwd,"same.txt"),"factory\n");git(cwd,["add","."]);git(cwd,["commit","-m","factory side"]);git(seed,["checkout","-b",branch]);fs.writeFileSync(path.join(seed,"same.txt"),"human\n");git(seed,["add","."]);git(seed,["commit","-m","human side"]);git(seed,["push","origin",branch]);
  assert.throws(()=>ws.sync(cwd,branch,"main","developer"),(error:unknown)=>error instanceof SyncConflictError&&error.files.includes("same.txt"));assert.equal(git(cwd,["status","--porcelain"]),"");assert.throws(()=>git(cwd,["rev-parse","--verify","MERGE_HEAD"]));
 }finally{config.repoDir=old.repoDir;config.dataDir=old.dataDir;fs.rmSync(root,{recursive:true,force:true});}
});

test("sync enforces the prepared role policy before preserving interrupted work",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-sync-policy-")),old={repoDir:config.repoDir,dataDir:config.dataDir};
 try{
  const origin=path.join(root,"origin.git"),repo=path.join(root,"repo"),branch="factory/issue-7";fs.mkdirSync(origin);fs.mkdirSync(repo);git(origin,["init","--bare"]);git(repo,["init"]);git(repo,["config","user.name","Factory Test"]);git(repo,["config","user.email","factory@example.test"]);fs.writeFileSync(path.join(repo,"app.txt"),"base\n");git(repo,["add","."]);git(repo,["commit","-m","base"]);git(repo,["branch","-M","main"]);git(repo,["remote","add","origin",origin]);git(repo,["push","-u","origin","main"]);config.repoDir=repo;config.dataDir=path.join(root,"data");const ws=new Workspaces(),cwd=ws.ensure("policy",branch,"main"),before=ws.head(cwd);
  fs.writeFileSync(path.join(cwd,".env"),"GITHUB_TOKEN=secret\n");assert.throws(()=>ws.sync(cwd,branch,"main","developer"),/credential/);assert.equal(ws.head(cwd),before);fs.unlinkSync(path.join(cwd,".env"));
  fs.writeFileSync(path.join(cwd,"package.json"),"{}\n");assert.throws(()=>ws.sync(cwd,branch,"main","qa"),/protected non-test/);assert.equal(ws.head(cwd),before);assert.throws(()=>ws.sync(cwd,branch,"main","product-architect"),/uncommitted/);assert.equal(ws.head(cwd),before);fs.unlinkSync(path.join(cwd,"package.json"));
  fs.writeFileSync(path.join(cwd,"partial.txt"),"work\n");ws.sync(cwd,branch,"main","developer");assert.notEqual(ws.head(cwd),before);assert.match(git(cwd,["log","-1","--format=%s"]),/work in progress for #7/);
 }finally{config.repoDir=old.repoDir;config.dataDir=old.dataDir;fs.rmSync(root,{recursive:true,force:true});}
});

test("sync refuses to commit links or executable evidence left by an interrupted Tester",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-sync-qa-")),old={repoDir:config.repoDir,dataDir:config.dataDir};
 try{
  const origin=path.join(root,"origin.git"),seed=path.join(root,"seed"),repo=path.join(root,"repo"),branch="factory/issue-12";
  fs.mkdirSync(origin);fs.mkdirSync(seed);git(origin,["init","--bare"]);git(seed,["init"]);git(seed,["config","user.name","Factory Test"]);git(seed,["config","user.email","factory@example.test"]);
  fs.writeFileSync(path.join(seed,"app.txt"),"production\n");git(seed,["add","."]);git(seed,["commit","-m","base"]);git(seed,["branch","-M","main"]);git(seed,["remote","add","origin",origin]);git(seed,["push","-u","origin","main"]);
  git(root,["clone","--branch","main",origin,repo]);git(repo,["config","user.name","Factory Test"]);git(repo,["config","user.email","factory@example.test"]);config.repoDir=repo;config.dataDir=path.join(root,"data");
  const ws=new Workspaces(),cwd=ws.ensure("work-12",branch,"main"),head=git(cwd,["rev-parse","HEAD"]),evidence=path.join(cwd,"evidence");fs.mkdirSync(evidence);
  const refused=(setup:()=>void,cleanup:()=>void)=>{setup();try{assert.throws(()=>ws.sync(cwd,branch,"main","qa"),/links or executable evidence/);assert.equal(git(cwd,["rev-parse","HEAD"]),head);}finally{cleanup();}};
  refused(()=>fs.symlinkSync("../app.txt",path.join(evidence,"report.md")),()=>fs.rmSync(path.join(evidence,"report.md")));
  refused(()=>fs.writeFileSync(path.join(evidence,"result.json"),"{}\n",{mode:0o755}),()=>fs.rmSync(path.join(evidence,"result.json")));
  refused(()=>fs.linkSync(path.join(cwd,"app.txt"),path.join(evidence,"copy.txt")),()=>fs.rmSync(path.join(evidence,"copy.txt")));
  fs.writeFileSync(path.join(evidence,"report.md"),"partial\n");ws.sync(cwd,branch,"main","qa");
  assert.match(git(cwd,["log","--format=%s","-1"]),/factory: work in progress for #12/);assert.equal(git(cwd,["show","--name-only","--format=","HEAD"]),"evidence/report.md");
 }finally{config.repoDir=old.repoDir;config.dataDir=old.dataDir;fs.rmSync(root,{recursive:true,force:true});}
});

test("Designer writes only the prototype, and the approved prototype leaves the branch before the Builder",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-git-"));
 try {
  const origin=path.join(root,"origin.git"),repo=path.join(root,"repo");fs.mkdirSync(origin);fs.mkdirSync(repo);
  git(origin,["init","--bare"]);git(repo,["init"]);git(repo,["config","user.name","Factory Test"]);git(repo,["config","user.email","factory@example.test"]);
  fs.writeFileSync(path.join(repo,"app.txt"),"base");git(repo,["add","."]);git(repo,["commit","-m","base"]);git(repo,["branch","-M","main"]);
  git(repo,["remote","add","origin",origin]);git(repo,["push","-u","origin","main"]);
  config.repoDir=repo;config.dataDir=path.join(root,"data");const ws=new Workspaces(),branch="factory/issue-3";
  const cwd=ws.ensure("three",branch,"main");git(cwd,["config","user.name","Factory Test"]);git(cwd,["config","user.email","factory@example.test"]);
  let before=ws.head(cwd);
  fs.writeFileSync(path.join(cwd,"app.txt"),"designer edit");
  assert.throws(()=>ws.check(cwd,"designer",before,branch),/only write the disposable prototype/);
  git(cwd,["checkout","--","app.txt"]);
  fs.mkdirSync(path.join(cwd,".factory","prototype"),{recursive:true});
  fs.writeFileSync(path.join(cwd,".factory","prototype","01-main.png"),"png");fs.writeFileSync(path.join(cwd,".factory","prototype","README.md"),"01-main: main flow");
  fs.writeFileSync(path.join(cwd,".factory","prototype","run.sh"),"#!/bin/sh",{mode:0o755});
  assert.throws(()=>ws.check(cwd,"designer",before,branch),/regular, non-executable/);
  fs.unlinkSync(path.join(cwd,".factory","prototype","run.sh"));
  assert.deepEqual(ws.check(cwd,"designer",before,branch)?.sort(),[".factory/prototype/01-main.png",".factory/prototype/README.md"]);
  ws.commit(cwd,"prototype",branch);const prototypeCommit=ws.head(cwd);
  assert.equal(ws.archivePrototype(cwd,branch,"move prototype"),true);
  assert.equal(git(cwd,["ls-files",".factory/prototype"]),"","the prototype no longer reaches the pull request diff");
  assert.equal(fs.readFileSync(path.join(cwd,".factory-prototype","README.md"),"utf8"),"01-main: main flow");
  assert.equal(git(cwd,["status","--porcelain"]),"","the archived copy is excluded from Git");
  assert.equal(git(cwd,["show",`${prototypeCommit}:.factory/prototype/README.md`]),"01-main: main flow","the approved commit keeps the prototype");
  assert.equal(ws.archivePrototype(cwd,branch,"nothing to move"),false);
  before=ws.head(cwd);ws.check(cwd,"developer",before,branch);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test("a story worktree grows from its epic branch, not from the repository default branch",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-story-base-")),old={repoDir:config.repoDir,dataDir:config.dataDir};
 try{
  const origin=path.join(root,"origin.git"),seed=path.join(root,"seed"),repo=path.join(root,"repo"),epic="factory/issue-12",story="factory/issue-13";
  fs.mkdirSync(origin);fs.mkdirSync(seed);git(origin,["init","--bare"]);git(seed,["init"]);git(seed,["config","user.name","Factory Test"]);git(seed,["config","user.email","factory@example.test"]);
  fs.writeFileSync(path.join(seed,"shared.txt"),"base\n");git(seed,["add","."]);git(seed,["commit","-m","base"]);git(seed,["branch","-M","main"]);git(seed,["remote","add","origin",origin]);git(seed,["push","-u","origin","main"]);
  git(seed,["checkout","-b",epic]);fs.writeFileSync(path.join(seed,"epic.txt"),"epic design\n");git(seed,["add","."]);git(seed,["commit","-m","epic design"]);git(seed,["push","origin",epic]);
  // The local clone knows only main: the epic branch must be fetched by its name.
  git(root,["clone","--branch","main",origin,repo]);git(repo,["config","user.name","Factory Test"]);git(repo,["config","user.email","factory@example.test"]);config.repoDir=repo;config.dataDir=path.join(root,"data");
  const ws=new Workspaces(),cwd=ws.ensure("work-13",story,epic);
  assert.equal(git(cwd,["branch","--show-current"]),story);assert.equal(fs.readFileSync(path.join(cwd,"epic.txt"),"utf8"),"epic design\n");
  fs.writeFileSync(path.join(cwd,"story.txt"),"story work\n");git(cwd,["add","."]);git(cwd,["commit","-m","story work"]);
  // The story's change is measured against the epic, so the epic's own commits are not its diff.
  assert.deepEqual(ws.changeSummary(cwd,epic).files,["story.txt"]);assert.deepEqual(ws.changeSummary(cwd,"main").files.sort(),["epic.txt","story.txt"]);
  // A later epic commit reaches the story through sync; main is not consulted.
  git(seed,["checkout",epic]);fs.writeFileSync(path.join(seed,"epic.txt"),"epic update\n");git(seed,["add","."]);git(seed,["commit","-m","epic update"]);git(seed,["push","origin",epic]);
  git(seed,["checkout","main"]);fs.writeFileSync(path.join(seed,"main-only.txt"),"main moved\n");git(seed,["add","."]);git(seed,["commit","-m","main update"]);git(seed,["push","origin","main"]);
  const synced=ws.sync(cwd,story,epic,"developer");assert.deepEqual(synced.merged,[`origin/${epic}`]);
  assert.equal(fs.readFileSync(path.join(cwd,"epic.txt"),"utf8"),"epic update\n");assert.equal(fs.existsSync(path.join(cwd,"main-only.txt")),false);
  const review=ws.prepareReviewerContext(cwd,"work-13",epic);try{assert.deepEqual(review.files,["story.txt"]);assert.match(fs.readFileSync(review.path,"utf8"),/story work/);assert.doesNotMatch(fs.readFileSync(review.path,"utf8"),/epic design/);}finally{ws.cleanupReviewerContext(cwd,"work-13");}
 }finally{config.repoDir=old.repoDir;config.dataDir=old.dataDir;fs.rmSync(root,{recursive:true,force:true});}
});

test("integrate merges a verified story into the epic branch and stops on a conflict",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-integrate-")),old={repoDir:config.repoDir,dataDir:config.dataDir};
 try{
  const origin=path.join(root,"origin.git"),seed=path.join(root,"seed"),repo=path.join(root,"repo"),epic="factory/issue-12",story="factory/issue-13",other="factory/issue-14";
  fs.mkdirSync(origin);fs.mkdirSync(seed);git(origin,["init","--bare"]);git(seed,["init"]);git(seed,["config","user.name","Factory Test"]);git(seed,["config","user.email","factory@example.test"]);
  fs.writeFileSync(path.join(seed,"shared.txt"),"base\n");git(seed,["add","."]);git(seed,["commit","-m","base"]);git(seed,["branch","-M","main"]);git(seed,["remote","add","origin",origin]);git(seed,["push","-u","origin","main"]);
  git(seed,["checkout","-b",epic]);git(seed,["push","origin",epic]);
  git(seed,["checkout","-b",story]);fs.writeFileSync(path.join(seed,"story.txt"),"story\n");git(seed,["add","."]);git(seed,["commit","-m","story"]);git(seed,["push","origin",story]);
  git(seed,["checkout",epic]);git(seed,["checkout","-b",other]);fs.writeFileSync(path.join(seed,"shared.txt"),"other\n");git(seed,["add","."]);git(seed,["commit","-m","other"]);git(seed,["push","origin",other]);
  git(root,["clone","--branch","main",origin,repo]);git(repo,["config","user.name","Factory Test"]);git(repo,["config","user.email","factory@example.test"]);config.repoDir=repo;config.dataDir=path.join(root,"data");
  const ws=new Workspaces(),cwd=ws.ensure("epic",epic,"main");git(cwd,["config","user.name","Factory Test"]);git(cwd,["config","user.email","factory@example.test"]);
  fs.writeFileSync(path.join(cwd,"shared.txt"),"epic\n");git(cwd,["add","."]);git(cwd,["commit","-m","epic side"]);
  const commit=ws.integrate(cwd,epic,story);
  assert.equal(commit,ws.head(cwd));assert.equal(fs.readFileSync(path.join(cwd,"story.txt"),"utf8"),"story\n");assert.match(git(cwd,["log","-1","--format=%s"]),/integrate factory\/issue-13 into factory\/issue-12/);
  assert.equal(git(cwd,["rev-list","--count","--merges","HEAD"]),"1","a story enters through one merge commit");
  assert.equal(ws.integrate(cwd,epic,story),commit,"an integrated story is not merged again");
  assert.throws(()=>ws.integrate(cwd,epic,other),(error:unknown)=>error instanceof SyncConflictError&&error.files.includes("shared.txt"));
  assert.equal(git(cwd,["status","--porcelain"]),"");assert.throws(()=>git(cwd,["rev-parse","--verify","MERGE_HEAD"]));
  assert.throws(()=>ws.integrate(cwd,epic,"main"),/unexpected branch/);
 }finally{config.repoDir=old.repoDir;config.dataDir=old.dataDir;fs.rmSync(root,{recursive:true,force:true});}
});

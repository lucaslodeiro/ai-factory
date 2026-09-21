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
  const cwd=ws.ensure("one",branch), before=ws.head(cwd); assert.equal(ws.ensure("one",branch),cwd);
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
  const recovered=new Workspaces().ensure("recovered",branch);
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
  config.repoDir=checkout;config.dataDir=path.join(root,"data");const cwd=new Workspaces().ensure("new-item",branch);
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
  const ws=new Workspaces(),cwd=ws.ensure("work-12",branch);fs.writeFileSync(path.join(cwd,"partial.txt"),"preserved\n");
  git(seed,["checkout","-b",branch]);fs.writeFileSync(path.join(seed,"human.txt"),"remote branch\n");git(seed,["add","."]);git(seed,["commit","-m","human branch"]);git(seed,["push","origin",branch]);
  git(seed,["checkout","main"]);fs.writeFileSync(path.join(seed,"base.txt"),"new base\n");git(seed,["add","."]);git(seed,["commit","-m","base update"]);git(seed,["push","origin","main"]);
  const synced=ws.sync(cwd,branch,"main");assert.deepEqual(synced.merged,[`origin/${branch}`,"origin/main"]);assert.equal(fs.readFileSync(path.join(cwd,"partial.txt"),"utf8"),"preserved\n");assert.equal(fs.readFileSync(path.join(cwd,"human.txt"),"utf8"),"remote branch\n");assert.equal(fs.readFileSync(path.join(cwd,"base.txt"),"utf8"),"new base\n");assert.match(git(cwd,["log","--format=%s","-4"]),/factory: work in progress for #12/);
 }finally{config.repoDir=old.repoDir;config.dataDir=old.dataDir;fs.rmSync(root,{recursive:true,force:true});}
});

test("sync aborts a conflicting merge and reports the conflicting files",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-sync-conflict-")),old={repoDir:config.repoDir,dataDir:config.dataDir};
 try{
  const origin=path.join(root,"origin.git"),seed=path.join(root,"seed"),repo=path.join(root,"repo"),branch="factory/issue-13";
  fs.mkdirSync(origin);fs.mkdirSync(seed);git(origin,["init","--bare"]);git(seed,["init"]);git(seed,["config","user.name","Factory Test"]);git(seed,["config","user.email","factory@example.test"]);fs.writeFileSync(path.join(seed,"same.txt"),"base\n");git(seed,["add","."]);git(seed,["commit","-m","base"]);git(seed,["branch","-M","main"]);git(seed,["remote","add","origin",origin]);git(seed,["push","-u","origin","main"]);
  git(root,["clone","--branch","main",origin,repo]);git(repo,["config","user.name","Factory Test"]);git(repo,["config","user.email","factory@example.test"]);config.repoDir=repo;config.dataDir=path.join(root,"data");const ws=new Workspaces(),cwd=ws.ensure("work-13",branch);
  fs.writeFileSync(path.join(cwd,"same.txt"),"factory\n");git(cwd,["add","."]);git(cwd,["commit","-m","factory side"]);git(seed,["checkout","-b",branch]);fs.writeFileSync(path.join(seed,"same.txt"),"human\n");git(seed,["add","."]);git(seed,["commit","-m","human side"]);git(seed,["push","origin",branch]);
  assert.throws(()=>ws.sync(cwd,branch,"main"),(error:unknown)=>error instanceof SyncConflictError&&error.files.includes("same.txt"));assert.equal(git(cwd,["status","--porcelain"]),"");assert.throws(()=>git(cwd,["rev-parse","--verify","MERGE_HEAD"]));
 }finally{config.repoDir=old.repoDir;config.dataDir=old.dataDir;fs.rmSync(root,{recursive:true,force:true});}
});

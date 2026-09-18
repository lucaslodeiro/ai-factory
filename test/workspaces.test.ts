import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspaces, git } from "../src/worktrees.js";
import { config } from "../src/config.js";
test("real Git worktree isolation, QA boundaries, commit and branch publication", () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-git-"));
 try {
  const origin = path.join(root,"origin.git"), repo = path.join(root,"repo"); fs.mkdirSync(origin); fs.mkdirSync(repo);
  git(origin,["init","--bare"]); git(repo,["init"]); git(repo,["config","user.name","Factory Test"]); git(repo,["config","user.email","factory@example.test"]);
  fs.writeFileSync(path.join(repo,"app.txt"),"base"); git(repo,["add","."]); git(repo,["commit","-m","base"]); git(repo,["branch","-M","main"]);
  git(repo,["remote","add","origin",origin]); git(repo,["push","-u","origin","main"]);
  config.repoDir=repo; config.dataDir=path.join(root,"data"); const ws=new Workspaces(); const branch="factory/issue-1";
  const cwd=ws.ensure("one",branch), before=ws.head(cwd); assert.equal(ws.ensure("one",branch),cwd);
  fs.writeFileSync(path.join(cwd,"app.txt"),"implementation"); assert.throws(()=>ws.check(cwd,"qa",before),/non-test/);
  assert.throws(()=>ws.check(cwd,"reviewer",before),/modified/); ws.check(cwd,"developer",before); ws.commit(cwd,"implementation");
  fs.mkdirSync(path.join(cwd,"test")); fs.writeFileSync(path.join(cwd,"test","app.test.ts"),"test");
  ws.check(cwd,"qa",ws.head(cwd)); ws.commit(cwd,"test"); ws.publish(cwd,branch);
  assert.equal(git(origin,["rev-parse",`refs/heads/${branch}`]),ws.head(cwd)); assert.equal(fs.readFileSync(path.join(repo,"app.txt"),"utf8"),"base");
  assert.throws(()=>ws.publish(cwd,"main"),/Refusing/);
 } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

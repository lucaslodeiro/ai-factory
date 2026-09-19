import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {config} from "../src/config.js";
import {git,Workspaces} from "../src/worktrees.js";

test("reviewer diff artifact is owned, private, excluded and safely removed",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-context-")),origin=path.join(root,"origin.git"),repo=path.join(root,"repo"),oldRepo=config.repoDir,oldData=config.dataDir;
 fs.mkdirSync(origin);fs.mkdirSync(repo);git(origin,["init","--bare"]);git(repo,["init"]);git(repo,["config","user.name","Test"]);git(repo,["config","user.email","test@example.test"]);fs.writeFileSync(path.join(repo,"base.txt"),"base\n");git(repo,["add","."]);git(repo,["commit","-m","base"]);git(repo,["branch","-M","main"]);git(repo,["remote","add","origin",origin]);git(repo,["push","-u","origin","main"]);git(repo,["checkout","-b","factory/issue-1-test"]);fs.writeFileSync(path.join(repo,"feature.txt"),"feature\n");git(repo,["add","."]);git(repo,["commit","-m","feature"]);config.repoDir=repo;config.dataDir=path.join(root,"data");
 try{const workspaces=new Workspaces(),artifact=workspaces.prepareReviewerContext(repo,"work-1"),directory=path.dirname(artifact.path);assert.deepEqual(artifact.files,["feature.txt"]);assert.match(artifact.stat,/feature\.txt/);assert.match(fs.readFileSync(artifact.path,"utf8"),/feature\.txt/);assert.equal(fs.statSync(artifact.path).mode&0o777,0o600);assert.equal(fs.statSync(directory).mode&0o777,0o700);assert.equal(git(repo,["ls-files","--others","--exclude-standard"]),"");git(repo,["add","--all"]);assert.doesNotMatch(git(repo,["diff","--cached","--name-only"]),/factory-context/);workspaces.cleanupReviewerContext(repo,"work-1");assert.equal(fs.existsSync(directory),false);
  fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,"OWNER"),"foreign\n");assert.throws(()=>workspaces.prepareReviewerContext(repo,"work-1"),/foreign|owner/i);fs.rmSync(directory,{recursive:true});fs.symlinkSync(path.join(repo,"feature.txt"),directory);assert.throws(()=>workspaces.prepareReviewerContext(repo,"work-1"),/owned directory/);
 }finally{config.repoDir=oldRepo;config.dataDir=oldData;fs.rmSync(root,{recursive:true,force:true});}
});

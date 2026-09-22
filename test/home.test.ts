import fs from "node:fs";
import os from "node:os";
import {spawnSync} from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { factoryHome } from "../src/home.js";

test("factory home uses the explicit environment override",()=>{
  assert.equal(factoryHome("/tmp/install/engine",{AI_FACTORY_HOME:"/tmp/custom"}),path.resolve("/tmp/custom"));
});
test("factory home is the parent of an installed engine directory",()=>{
  assert.equal(factoryHome("/tmp/install/engine",{}),path.resolve("/tmp/install"));
});
test("factory home is a developer checkout when its name is not engine",()=>{
  assert.equal(factoryHome("/tmp/ai-factory",{}),path.resolve("/tmp/ai-factory"));
});

test("empty checkout allows configuration loading but daemon startup fails early",()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),"factory-empty-checkout-"));
 try{
  const script=`import assert from 'node:assert/strict';import {config} from './src/config.ts';import {startDaemon} from './src/daemon.ts';import {Store} from './src/storage.ts';assert.equal(config.repoDir,undefined);const store=new Store(':memory:');try{await assert.rejects(startDaemon(store),/FACTORY_REPO_DIR is required/);}finally{store.db.close();}`;
  const run=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",script],{env:{...process.env,AI_FACTORY_HOME:home,FACTORY_REPO_DIR:""},encoding:"utf8"});assert.equal(run.status,0,run.stderr+run.stdout);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test("doctor uses GH_COMMAND and remains callable without a checkout",()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),"factory-doctor-command-")),command=path.join(home,"fake-gh"),record=path.join(home,"calls");
 try{
  fs.writeFileSync(command,`#!/bin/sh\nprintf '%s\\n' "$*" >> '${record}'\necho '{"loggedIn":true}'\n`,{mode:0o755});
  const script=`import {config} from './src/config.ts';import {doctor} from './src/doctor.ts';import {Store} from './src/storage.ts';config.gitCommand=config.codexCommand=config.claudeCommand=config.cursorCommand=process.env.GH_COMMAND;const store=new Store(':memory:');try{doctor(store,{repository(){return {id:1,nodeId:'R_1',fullName:'owner/demo',defaultBranch:'main'}}});}finally{store.db.close();}`;
  const run=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",script],{env:{...process.env,AI_FACTORY_HOME:home,FACTORY_REPO_DIR:"",GH_COMMAND:command},encoding:"utf8"});assert.equal(run.status,0,run.stderr+run.stdout);
  assert.match(run.stdout,new RegExp(`✓ ${command}`));assert.match(fs.readFileSync(record,'utf8'),/auth status/);
  assert.doesNotMatch(run.stdout,/Cursor authentication/);assert.doesNotMatch(fs.readFileSync(record,'utf8'),/status --format json/);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});

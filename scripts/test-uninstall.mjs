import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import Database from "better-sqlite3";

const source=fileURLToPath(new URL("..",import.meta.url)),sandbox=fs.mkdtempSync(path.join(os.tmpdir(),"factory-uninstall-"));
const run=(command,args,options={})=>spawnSync(command,args,{encoding:"utf8",...options});
try{
  const passthroughRoot=path.join(sandbox,"passthrough"),passthroughLog=path.join(sandbox,"passthrough.json");fs.mkdirSync(path.join(passthroughRoot,"scripts"),{recursive:true});
  fs.copyFileSync(path.join(source,"scripts/services.sh"),path.join(passthroughRoot,"scripts/services.sh"));fs.writeFileSync(path.join(passthroughRoot,"scripts/uninstall.mjs"),`import fs from "node:fs";fs.writeFileSync(process.env.PASSTHROUGH_LOG,JSON.stringify(process.argv.slice(2)));`);
  const passthrough=run("bash",[path.join(passthroughRoot,"scripts/services.sh"),"uninstall","--purge","--yes","--force"],{env:{...process.env,PASSTHROUGH_LOG:passthroughLog}});assert.equal(passthrough.status,0,passthrough.stderr);assert.deepEqual(JSON.parse(fs.readFileSync(passthroughLog)),["--purge","--yes","--force"]);

  const userHome=path.join(sandbox,"user"),home=path.join(userHome,"ai-factory"),engine=path.join(home,"engine"),data=path.join(home,"data"),repos=path.join(home,"repos"),target=path.join(repos,"target"),agents=path.join(userHome,"Library","LaunchAgents");
  fs.mkdirSync(path.join(engine,"scripts"),{recursive:true});fs.mkdirSync(data,{recursive:true});fs.mkdirSync(target,{recursive:true});fs.mkdirSync(agents,{recursive:true});
  fs.writeFileSync(path.join(engine,"package.json"),JSON.stringify({name:"ai-factory"}));fs.copyFileSync(path.join(source,"scripts/uninstall.mjs"),path.join(engine,"scripts/uninstall.mjs"));fs.symlinkSync(path.join(source,"node_modules"),path.join(engine,"node_modules"),"dir");
  fs.mkdirSync(path.join(userHome,".local","bin"),{recursive:true});fs.symlinkSync(path.join(engine,"scripts","ai-factory"),path.join(userHome,".local","bin","ai-factory"));
  const bin=path.join(sandbox,"bin"),gitLog=path.join(sandbox,"git.log");fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,"git"),`#!/bin/sh\nprintf '%s\\n' "$*" >> "$GIT_LOG"\nif [ "$1" = ls-remote ]; then exit 0; fi\nexec /usr/bin/git "$@"\n`,{mode:0o755});
  fs.writeFileSync(path.join(home,".env"),`FACTORY_DATA_DIR=data\nFACTORY_REPO_DIR=repos/target\nGIT_COMMAND=${path.join(bin,"git")}\n`);fs.writeFileSync(path.join(home,".env.backup-1"),"backup");
  const database=new Database(path.join(data,"factory.db"));database.exec("CREATE TABLE work_items(issue_number INTEGER,stage TEXT,status TEXT,branch TEXT)");database.prepare("INSERT INTO work_items VALUES(?,?,?,?)").run(17,"BUILD","PAUSED","factory/issue-17-demo");database.close();
  fs.writeFileSync(path.join(target,"keep"),"target");for(const service of["daemon","dashboard"])fs.writeFileSync(path.join(agents,`com.ai-factory.${service}.plist`),"fixture");
  const env={...process.env,HOME:userHome,GIT_LOG:gitLog,AI_FACTORY_HOME:home,AI_FACTORY_UNINSTALL_SKIP_LAUNCHCTL:"1"};
  const mismatchedHome=path.join(userHome,"Documents"),mismatchedSentinel=path.join(mismatchedHome,"keep");fs.mkdirSync(mismatchedHome,{recursive:true});fs.writeFileSync(mismatchedSentinel,"keep");
  const mismatched=run(process.execPath,[path.join(engine,"scripts/uninstall.mjs"),"--purge","--yes","--force"],{cwd:engine,env:{...env,AI_FACTORY_HOME:mismatchedHome}});assert.notEqual(mismatched.status,0);assert.match(mismatched.stderr,new RegExp(`engine .* is not inside factory home .*Documents`));assert.equal(fs.readFileSync(mismatchedSentinel,"utf8"),"keep");assert.equal(fs.existsSync(engine),true);
  const refused=run(process.execPath,[path.join(engine,"scripts/uninstall.mjs"),"--yes"],{cwd:engine,env});assert.notEqual(refused.status,0);assert.match(refused.stderr,/--yes --force/);
  const basic=run(process.execPath,[path.join(engine,"scripts/uninstall.mjs"),"--yes","--force"],{cwd:engine,env});assert.equal(basic.status,0,basic.stderr+basic.stdout);
  assert.equal(fs.existsSync(engine),false);assert.equal(fs.existsSync(data),false);assert.equal(fs.readFileSync(path.join(home,".env"),"utf8").includes("FACTORY_DATA_DIR"),true);assert.equal(fs.readFileSync(path.join(target,"keep"),"utf8"),"target");assert.match(basic.stdout,new RegExp(path.join(home,".env").replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));

  fs.mkdirSync(path.join(engine,"scripts"),{recursive:true});fs.writeFileSync(path.join(engine,"package.json"),JSON.stringify({name:"ai-factory"}));fs.copyFileSync(path.join(source,"scripts/uninstall.mjs"),path.join(engine,"scripts/uninstall.mjs"));fs.symlinkSync(path.join(source,"node_modules"),path.join(engine,"node_modules"),"dir");
  run("/usr/bin/git",["init"],{cwd:target});run("/usr/bin/git",["config","user.email","test@example.com"],{cwd:target});run("/usr/bin/git",["config","user.name","Test"],{cwd:target});fs.writeFileSync(path.join(target,"dirty"),"dirty");
  fs.writeFileSync(gitLog,"");
  const purgeBlocked=run(process.execPath,[path.join(engine,"scripts/uninstall.mjs"),"--purge","--yes"],{cwd:engine,env});assert.notEqual(purgeBlocked.status,0);assert.match(purgeBlocked.stdout,/dirty working tree/,purgeBlocked.stderr);assert.equal(fs.existsSync(home),true);
  assert.match(fs.readFileSync(gitLog,"utf8"),/status --porcelain/);assert.match(fs.readFileSync(gitLog,"utf8"),/log --branches --not --remotes --oneline/);
  const purged=run(process.execPath,[path.join(engine,"scripts/uninstall.mjs"),"--purge","--yes","--force"],{cwd:engine,env});assert.equal(purged.status,0,purged.stderr+purged.stdout);assert.equal(fs.existsSync(home),false);assert.match(purged.stdout,/home was removed/);
  console.log("PASS: basic uninstall preserves configuration and repos; purge preflights dirty clones and removes the complete home only with force");
}finally{fs.rmSync(sandbox,{recursive:true,force:true});}

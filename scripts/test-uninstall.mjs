import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("..",import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(),"factory-uninstall-"));
try {
  const home=path.join(sandbox,"home"),root=path.join(home,"ai-factory"),data=path.join(home,"factory-data"),target=path.join(home,"Source","target"),agents=path.join(home,"Library","LaunchAgents");
  fs.mkdirSync(path.join(root,"scripts"),{recursive:true}); fs.mkdirSync(data,{recursive:true}); fs.mkdirSync(target,{recursive:true}); fs.mkdirSync(agents,{recursive:true});
  fs.writeFileSync(path.join(root,"package.json"),JSON.stringify({name:"ai-factory"}));
  fs.copyFileSync(path.join(source,"scripts","uninstall.mjs"),path.join(root,"scripts","uninstall.mjs"));
  fs.mkdirSync(path.join(home,".local","bin"),{recursive:true}); fs.symlinkSync(path.join(root,"scripts","ai-factory"),path.join(home,".local","bin","ai-factory"));
  fs.writeFileSync(path.join(root,".env"),`FACTORY_DATA_DIR=${data}\nFACTORY_REPO_DIR=${target}\n`);
  fs.writeFileSync(path.join(data,"factory.db"),"fixture"); fs.writeFileSync(path.join(target,"keep"),"target");
  for (const service of ["daemon","dashboard"]) fs.writeFileSync(path.join(agents,`com.ai-factory.${service}.plist`),"fixture");
  fs.writeFileSync(path.join(home,".local-tool"),"keep");
  const cancelled=spawnSync(process.execPath,[path.join(root,"scripts","uninstall.mjs")],{cwd:root,env:{...process.env,HOME:home},encoding:"utf8"});
  assert.notEqual(cancelled.status,0);
  assert.match(cancelled.stderr,/Re-run with --yes/);
  assert.equal(fs.existsSync(root),true);
  const result=spawnSync(process.execPath,[path.join(root,"scripts","uninstall.mjs"),"--yes"],{cwd:root,env:{...process.env,HOME:home,AI_FACTORY_UNINSTALL_SKIP_LAUNCHCTL:"1"},encoding:"utf8"});
  assert.equal(result.status,0,result.stderr+result.stdout);
  assert.equal(fs.existsSync(root),false); assert.equal(fs.existsSync(data),false);
  assert.equal(fs.existsSync(path.join(agents,"com.ai-factory.daemon.plist")),false); assert.equal(fs.existsSync(path.join(agents,"com.ai-factory.dashboard.plist")),false);
  assert.equal(fs.existsSync(path.join(home,".local","bin","ai-factory")),false);
  assert.equal(fs.readFileSync(path.join(target,"keep"),"utf8"),"target"); assert.equal(fs.readFileSync(path.join(home,".local-tool"),"utf8"),"keep");
  assert.match(result.stdout,/AI Factory was uninstalled/);
  assert.match(result.stdout,/parent shell may still reference the removed directory/);
  console.log("PASS: uninstall removes factory services, installation and data while preserving targets and shared tools");
} finally { fs.rmSync(sandbox,{recursive:true,force:true}); }

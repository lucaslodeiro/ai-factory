import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("service launcher installs and controls daemon and dashboard independently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"factory-services-"));
  const home = path.join(root,"home"), bin = path.join(root,"bin"), state = path.join(root,"state");
  fs.mkdirSync(home); fs.mkdirSync(bin); fs.mkdirSync(state);
  fs.writeFileSync(path.join(bin,"uname"),"#!/bin/sh\necho Darwin\n",{mode:0o755});
  fs.writeFileSync(path.join(bin,"plutil"),"#!/bin/sh\nexit 0\n",{mode:0o755});
  fs.writeFileSync(path.join(bin,"launchctl"),`#!/usr/bin/env bash
set -e
case $1 in
  print) name=\${2##*/}; [[ -f "$SERVICE_STATE/$name" ]] || exit 1; echo 'state = running'; echo 'pid = 42';;
  bootstrap) name=\$(basename "$3" .plist); touch "$SERVICE_STATE/$name";;
  bootout) name=\${2##*/}; rm -f "$SERVICE_STATE/$name";;
  kickstart) ;;
esac
`,{mode:0o755});
  const env = {...process.env,HOME:home,SERVICE_STATE:state,PATH:`${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`};
  const run = (...args: string[]) => {
    const result = spawnSync("bash",["scripts/services.sh",...args],{cwd:process.cwd(),env,encoding:"utf8"});
    assert.equal(result.status,0,result.stderr + result.stdout);
    return result.stdout;
  };
  try {
    assert.match(run("install","all"),/Dashboard: http:\/\/127\.0\.0\.1:4173/);
    const agentDir = path.join(home,"Library","LaunchAgents");
    const daemon = fs.readFileSync(path.join(agentDir,"com.ai-factory.daemon.plist"),"utf8");
    const dashboard = fs.readFileSync(path.join(agentDir,"com.ai-factory.dashboard.plist"),"utf8");
    assert.match(daemon,/<string>start<\/string>/);
    assert.match(dashboard,/<string>dashboard<\/string>/);
    assert.match(run("start","daemon"),/Logs:\s+npm run service -- logs daemon/);
    assert.match(run("status","daemon"),/daemon: loaded/);
    assert.match(run("status","dashboard"),/dashboard: stopped/);
    run("restart","dashboard");
    run("stop","daemon");
    assert.match(run("status","daemon"),/daemon: stopped/);
    assert.match(run("status","dashboard"),/dashboard: loaded/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

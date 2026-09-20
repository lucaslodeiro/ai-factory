import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('..',import.meta.url));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'factory-script-test-'));
const remote=path.join(temp,'remote.git'), seed=path.join(temp,'seed'), dest=path.join(temp,'installed factory'), engine=path.join(dest,'engine'), bin=path.join(temp,'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin,'npm'),`#!/bin/sh\nif [ \"$1\" = ci ]; then ln -s '${path.join(source,'node_modules').replaceAll("'","'\\''")}' node_modules; ln -s '${path.join(source,'dist').replaceAll("'","'\\''")}' dist; fi\nif [ \"$1\" = test ] && [ \"\${FAIL_NPM_TEST:-0}\" = 1 ]; then exit 41; fi\nexit 0\n`,{mode:0o755});
fs.writeFileSync(path.join(bin,'curl'),`#!/bin/sh\nexit 0\n`,{mode:0o755});
fs.writeFileSync(path.join(bin,'open'),`#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$AI_FACTORY_OPEN_LOG\"\n`,{mode:0o755});
fs.writeFileSync(path.join(bin,'uname'),`#!/bin/sh\necho Darwin\n`,{mode:0o755});
fs.writeFileSync(path.join(bin,'launchctl'),`#!/bin/sh\nprintf '%s\\n' "$*" >> "$AI_FACTORY_LAUNCHCTL_LOG"\n`,{mode:0o755});
const home=path.join(temp,'home');fs.mkdirSync(home);
const env={...process.env,HOME:home,PATH:`${bin}:${process.env.PATH}`,AI_FACTORY_SKIP_SERVICES:'1'};
for(const k of Object.keys(env)) if(/^(FACTORY_|GITHUB_|CODEX_COMMAND|CLAUDE_COMMAND|GIT_COMMAND)/.test(k)) delete env[k];
function run(command,args,cwd=temp,ok=true){const r=spawnSync(command,args,{cwd,env,encoding:'utf8'}); if(ok)assert.equal(r.status,0,r.stderr+r.stdout);else assert.notEqual(r.status,0);return r;}
try {
run(process.execPath,[path.join(source,'scripts/test-dashboard-config.mjs')]);
run(process.execPath,[path.join(source,'scripts/test-uninstall.mjs')]);
assert.match(run('bash',[path.join(source,'scripts/update.sh'),'--help']).stdout,/--start-services/);
assert.match(run('bash',[path.join(source,'scripts/update.sh'),'--restart-services','--help']).stdout,/ai-factory help/);
run('git',['init','--bare',remote]);run('git',['clone',remote,seed]);
run('git',['config','user.email','test@example.com'],seed);run('git',['config','user.name','Test'],seed);
fs.mkdirSync(path.join(seed,'scripts'));
for(const f of ['install-core.sh','update.sh','update.mjs','configure.sh','configure.mjs','dashboard-url.mjs','prepare-dashboard-config.mjs','initialize-environment.mjs','paths.mjs']) fs.copyFileSync(path.join(source,'scripts',f),path.join(seed,'scripts',f));
fs.writeFileSync(path.join(seed,'scripts','services.sh'),`#!/bin/sh
printf '%s %s\\n' \"$1\" \"$2\" >> \"$AI_FACTORY_SERVICE_LOG\"
if [ \"$1 $2\" = \"start dashboard\" ] && [ -n \"\${AI_FACTORY_FAKE_DASHBOARD_PORT:-}\" ]; then
  node -e 'require("http").createServer((request,response)=>{response.setHeader("content-type","application/json");response.end(request.url==="/api/settings"?JSON.stringify({readiness:{ready:true}}):JSON.stringify({ok:true}))}).listen(Number(process.argv[1]),"127.0.0.1")' \"$AI_FACTORY_FAKE_DASHBOARD_PORT\" > /dev/null 2>&1 &
  echo $! > \"$AI_FACTORY_FAKE_DASHBOARD_PID\"
fi
`,{mode:0o755});
fs.writeFileSync(path.join(seed,'scripts','service-summary.mjs'),`console.log('Dashboard: http://127.0.0.1:4173');\n`);
for(const f of ['.gitignore','.env.example','package.json']) fs.copyFileSync(path.join(source,f),path.join(seed,f));
run('git',['add','.'],seed);run('git',['commit','-m','initial'],seed);run('git',['push','origin','HEAD:main'],seed);
env.AI_FACTORY_SKIP_SERVICES='0';
env.AI_FACTORY_SERVICE_LOG=path.join(temp,'install-services.log');
env.AI_FACTORY_OPEN_LOG=path.join(temp,'open.log');
env.AI_FACTORY_LAUNCHCTL_LOG=path.join(temp,'launchctl.log');
const installation = run('bash',[path.join(source,'scripts/install-core.sh'),'--repo',remote,'--dir',dest,'--dashboard-port','64173']);
assert.match(installation.stdout,/installation completed successfully/);
assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dest,'data','install.json'),'utf8'))).sort(),['branch','installedAt','revision','version']);
assert.equal(fs.readlinkSync(path.join(home,'.local','bin','ai-factory')),path.join(engine,'scripts','ai-factory'));
assert.match(installation.stdout,/continue in the dashboard/);
assert.doesNotMatch(installation.stdout,/Setup incomplete/);
assert.doesNotMatch(installation.stdout,/Configure factory/);
assert.match(fs.readFileSync(path.join(dest,'.env'),'utf8'),/^GITHUB_REPOSITORY=$/m);
assert.equal(fs.statSync(path.join(dest,'.env')).mode & 0o777,0o600);
assert.match(fs.readFileSync(env.AI_FACTORY_SERVICE_LOG,'utf8'),/install all\nstart dashboard/);
assert.equal(fs.readFileSync(env.AI_FACTORY_OPEN_LOG,'utf8').trim(),'http://127.0.0.1:64173/?setup=1');
const oneShotState=path.join(temp,'one-shot-state.json'),oneShotUpdate=path.join(temp,'one-shot-update.sh'),oneShotRuns=path.join(temp,'one-shot-runs');
fs.writeFileSync(oneShotState,JSON.stringify({status:'updating'}));
fs.writeFileSync(oneShotUpdate,`#!/bin/sh\necho run >> '${oneShotRuns}'\nnode -e 'const fs=require("fs");fs.writeFileSync(process.env.AI_FACTORY_UPDATE_STATE_FILE,JSON.stringify({status:"completed"}))'\n`,{mode:0o755});
run('bash',[path.join(source,'scripts/update-job.sh'),oneShotState,oneShotUpdate,'com.ai-factory.update.test']);
run('bash',[path.join(source,'scripts/update-job.sh'),oneShotState,oneShotUpdate,'com.ai-factory.update.test']);
assert.equal(fs.readFileSync(oneShotRuns,'utf8').trim(),'run');
assert.match(fs.readFileSync(env.AI_FACTORY_LAUNCHCTL_LOG,'utf8'),/remove com\.ai-factory\.update\.test/);
const legacyState=path.join(temp,'legacy-update-state.json'),legacyRuns=path.join(temp,'legacy-update-runs'),legacyUpdate=path.join(temp,'legacy-update.sh');
fs.writeFileSync(legacyState,JSON.stringify({status:'updating'}));
fs.writeFileSync(legacyUpdate,`#!/bin/sh\necho run >> '${legacyRuns}'\nprintf '{"status":"completed"}' > "$AI_FACTORY_UPDATE_STATE_FILE"\n`,{mode:0o755});
const legacy=spawnSync('/bin/bash',[path.join(source,'scripts/update-job.sh'),legacyState,legacyUpdate],{cwd:source,env:{HOME:home,PATH:'/usr/bin:/bin'},encoding:'utf8'});
assert.equal(legacy.status,0,legacy.stderr+legacy.stdout);
assert.equal(fs.readFileSync(legacyRuns,'utf8').trim(),'run');
env.AI_FACTORY_SKIP_SERVICES='1';
run('bash',[path.join(source,'scripts/install-core.sh'),'--repo',remote,'--dir',dest],temp,false);

const failedDest=path.join(temp,'failed install');
env.FAIL_NPM_TEST='1';
const failedInstall=run('bash',[path.join(source,'scripts/install-core.sh'),'--repo',remote,'--dir',failedDest],temp,false);
assert.match(failedInstall.stderr,/Installation failed while running the validation suite/);
assert.match(failedInstall.stderr,new RegExp(`mv .*engine.*engine\\.incomplete-[0-9-]+`));
assert.ok(failedInstall.stderr.includes(`bash /tmp/ai-factory-install-macos.sh --dir ${failedDest.replaceAll(" ","\\ ")}`));
assert.equal(fs.existsSync(path.join(failedDest,'data','install.json')),false);
delete env.FAIL_NPM_TEST;
const failedRetry=run('bash',[path.join(source,'scripts/install-core.sh'),'--repo',remote,'--dir',failedDest],temp,false);
assert.match(failedRetry.stderr,/incomplete engine already exists/);
const incompleteEngine=path.join(failedDest,'engine.incomplete-test');
fs.renameSync(path.join(failedDest,'engine'),incompleteEngine);
fs.mkdirSync(path.join(failedDest,'data','service-logs'),{recursive:true});
run('bash',[path.join(source,'scripts/install-core.sh'),'--repo',remote,'--dir',failedDest],temp);
assert.equal(fs.existsSync(path.join(failedDest,'engine','.git')),true);
assert.equal(fs.existsSync(path.join(failedDest,'engine.incomplete-test','.git')),true);
assert.equal(fs.existsSync(path.join(failedDest,'data','service-logs')),true);
assert.equal(fs.existsSync(path.join(failedDest,'data','install.json')),true);
const skippedTestsDest=path.join(temp,'tests skipped install');
env.AI_FACTORY_INSTALL_TESTS='0';
const skippedTestsInstall=run('bash',[path.join(source,'scripts/install-core.sh'),'--repo',remote,'--dir',skippedTestsDest],temp);
assert.equal(fs.existsSync(path.join(skippedTestsDest,'data','install.json')),true);
delete env.AI_FACTORY_INSTALL_TESTS;

const preservedDest=path.join(temp,'preserved home');
fs.mkdirSync(path.join(preservedDest,'repos'),{recursive:true});
fs.writeFileSync(path.join(preservedDest,'.env'),'GITHUB_REPOSITORY=preserved/example\n');
run('bash',[path.join(source,'scripts/install-core.sh'),'--repo',remote,'--dir',preservedDest],temp);
assert.equal(fs.readFileSync(path.join(preservedDest,'.env'),'utf8'),'GITHUB_REPOSITORY=preserved/example\n');
assert.equal(fs.existsSync(path.join(preservedDest,'engine','.git')),true);
assert.equal(fs.existsSync(path.join(preservedDest,'data','install.json')),true);

const seededDest=path.join(temp,'environment-seeded home');
env.AI_FACTORY_SKIP_SERVICES='1';env.GITHUB_REPOSITORY='owner/from-shell';env.FACTORY_APPROVERS='owner';env.FACTORY_POLL_INTERVAL_MS='54321';
run('bash',[path.join(source,'scripts/install-core.sh'),'--repo',remote,'--dir',seededDest],temp);
const seededEnvironment=fs.readFileSync(path.join(seededDest,'.env'),'utf8');
assert.match(seededEnvironment,/^GITHUB_REPOSITORY='owner\/from-shell'$/m);assert.match(seededEnvironment,/^FACTORY_APPROVERS='owner'$/m);assert.match(seededEnvironment,/^FACTORY_POLL_INTERVAL_MS='54321'$/m);
delete env.GITHUB_REPOSITORY;delete env.FACTORY_APPROVERS;delete env.FACTORY_POLL_INTERVAL_MS;

const readyDest=path.join(temp,'ready preserved home'),readyPort='64174',readyPid=path.join(temp,'ready-dashboard.pid');
fs.mkdirSync(readyDest,{recursive:true});fs.writeFileSync(path.join(readyDest,'.env'),'GITHUB_REPOSITORY=preserved/example\n');
env.AI_FACTORY_SKIP_SERVICES='0';env.AI_FACTORY_NO_OPEN='1';env.AI_FACTORY_FAKE_DASHBOARD_PORT=readyPort;env.AI_FACTORY_FAKE_DASHBOARD_PID=readyPid;env.AI_FACTORY_SERVICE_LOG=path.join(temp,'ready-services.log');
run('bash',[path.join(source,'scripts/install-core.sh'),'--repo',remote,'--dir',readyDest,'--dashboard-port',readyPort],temp);
assert.match(fs.readFileSync(env.AI_FACTORY_SERVICE_LOG,'utf8'),/start dashboard\nstart daemon/);
assert.equal(fs.readFileSync(env.AI_FACTORY_OPEN_LOG,'utf8').trim(),'http://127.0.0.1:64173/?setup=1');
process.kill(Number(fs.readFileSync(readyPid,'utf8').trim()));
delete env.AI_FACTORY_NO_OPEN;delete env.AI_FACTORY_FAKE_DASHBOARD_PORT;delete env.AI_FACTORY_FAKE_DASHBOARD_PID;
env.AI_FACTORY_SKIP_SERVICES='1';

if(!fs.existsSync(path.join(engine,'dist')))fs.symlinkSync(path.join(source,'dist'),path.join(engine,'dist'),'dir');
fs.appendFileSync(path.join(engine,'.git','info','exclude'),'\n/dist\n/node_modules\n');
fs.mkdirSync(path.join(dest,'data','worktrees'),{recursive:true});
fs.writeFileSync(path.join(dest,'data','worktrees','keep'),'worktree');
const originalEnv=fs.readFileSync(path.join(dest,'.env'),'utf8');
fs.writeFileSync(path.join(seed,'change.txt'),'upstream');run('git',['add','.'],seed);run('git',['commit','-m','upstream'],seed);run('git',['push','origin','HEAD:main'],seed);
env.AI_FACTORY_UPDATE_STATE_FILE=path.join(temp,'update-state.json');
run('bash',['scripts/update.sh'],engine);
assert.equal(JSON.parse(fs.readFileSync(env.AI_FACTORY_UPDATE_STATE_FILE,'utf8')).status,'completed');
assert.equal(JSON.parse(fs.readFileSync(path.join(dest,'data','install.json'),'utf8')).revision,run('git',['rev-parse','HEAD'],engine).stdout.trim());
assert.equal(fs.readFileSync(path.join(engine,'change.txt'),'utf8'),'upstream');
assert.equal(fs.readFileSync(path.join(dest,'.env'),'utf8'),originalEnv);
assert.equal(fs.readFileSync(path.join(dest,'data','worktrees','keep'),'utf8'),'worktree');
assert.ok(fs.readdirSync(path.join(dest,'data')).some(f=>f.startsWith('update-backup-')));
// The dashboard records service intent before its detached updater stops the
// daemon. A later status check must not overwrite that durable intent.
env.AI_FACTORY_SKIP_SERVICES='0';
fs.writeFileSync(env.AI_FACTORY_UPDATE_STATE_FILE,JSON.stringify({status:'updating',restoreDaemon:true,restoreDashboard:true}));
fs.writeFileSync(env.AI_FACTORY_SERVICE_LOG,'');
run('bash',['scripts/update.sh','--restart-services'],engine);
const restored=fs.readFileSync(env.AI_FACTORY_SERVICE_LOG,'utf8');
assert.match(restored,/stop daemon/);assert.match(restored,/start daemon/);assert.match(restored,/start dashboard/);
env.AI_FACTORY_SKIP_SERVICES='1';
fs.writeFileSync(path.join(engine,'dirty'),'dirty');assert.match(run('bash',['scripts/update.sh'],engine,false).stderr,/Local changes/);fs.unlinkSync(path.join(engine,'dirty'));
const db=new Database(path.join(dest,'data','factory.db'));
db.prepare('INSERT INTO daemon_lock(id,pid,token) VALUES(1,?,?)').run(process.pid,'test');
assert.match(run('bash',['scripts/update.sh'],engine,false).stderr,/Daemon already running/);
db.prepare('DELETE FROM daemon_lock').run();db.close();
run('git',['config','user.email','test@example.com'],engine);run('git',['config','user.name','Test'],engine);
fs.writeFileSync(path.join(engine,'local'),'local');run('git',['add','.'],engine);run('git',['commit','-m','local'],engine);
assert.match(run('bash',['scripts/update.sh'],engine,false).stderr,/merge-base/);
assert.match(JSON.parse(fs.readFileSync(env.AI_FACTORY_UPDATE_STATE_FILE,'utf8')).phase,/checking the local checkout|merge-base/i);
env.AI_FACTORY_SKIP_SERVICES='0';
fs.writeFileSync(path.join(engine,'scripts','services.sh'),`#!/bin/sh
if [ "$1 $2" = "status dashboard" ]; then echo 'dashboard: loaded'; elif [ "$1" = status ]; then echo "$2: stopped"; else echo "$1 $2" >> '${path.join(temp,'service-recovery.log')}'; fi
`,{mode:0o755});
run('bash',['scripts/update.sh','--start-services'],engine,false);
const recovery=fs.readFileSync(path.join(temp,'service-recovery.log'),'utf8');
assert.match(recovery,/stop daemon/);assert.match(recovery,/install daemon/);assert.match(recovery,/start daemon/);assert.doesNotMatch(recovery,/stop all|install dashboard|start dashboard/);
assert.equal(JSON.parse(fs.readFileSync(env.AI_FACTORY_UPDATE_STATE_FILE,'utf8')).status,'failed');
console.log('PASS: dashboard-first install, existing destination, fast-forward, config/worktree preservation, backup, dirty checkout, daemon lock, local-only commit, persisted update state and dashboard availability.');
} finally { fs.rmSync(temp,{recursive:true,force:true}); }

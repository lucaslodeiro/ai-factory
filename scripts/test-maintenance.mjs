import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('..',import.meta.url));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'factory-script-test-'));
const remote=path.join(temp,'remote.git'), seed=path.join(temp,'seed'), dest=path.join(temp,'installed factory'), bin=path.join(temp,'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin,'npm'),`#!/bin/sh\nif [ \"$1\" = ci ]; then ln -s '${path.join(source,'node_modules').replaceAll("'","'\\''")}' node_modules; fi\nexit 0\n`,{mode:0o755});
const env={...process.env,PATH:`${bin}:${process.env.PATH}`,AI_FACTORY_SKIP_SERVICES:'1'};
for(const k of Object.keys(env)) if(/^(FACTORY_|GITHUB_|CODEX_COMMAND|CLAUDE_COMMAND|GIT_COMMAND)/.test(k)) delete env[k];
function run(command,args,cwd=temp,ok=true){const r=spawnSync(command,args,{cwd,env,encoding:'utf8'}); if(ok)assert.equal(r.status,0,r.stderr+r.stdout);else assert.notEqual(r.status,0);return r;}
try {
run('git',['init','--bare',remote]);run('git',['clone',remote,seed]);
run('git',['config','user.email','test@example.com'],seed);run('git',['config','user.name','Test'],seed);
fs.mkdirSync(path.join(seed,'scripts'));
for(const f of ['install.sh','update.sh','update.mjs','configure.sh','configure.mjs']) fs.copyFileSync(path.join(source,'scripts',f),path.join(seed,'scripts',f));
for(const f of ['.gitignore','.env.example','package.json']) fs.copyFileSync(path.join(source,f),path.join(seed,f));
run('git',['add','.'],seed);run('git',['commit','-m','initial'],seed);run('git',['push','origin','HEAD:main'],seed);
const installation = run('bash',[path.join(source,'scripts/install.sh'),'--skip-tools','--defaults','--repo',remote,'--dir',dest]);
assert.match(installation.stdout,/installation completed successfully/);
assert.match(installation.stdout,/saved for later/);
assert.doesNotMatch(installation.stdout,/Setup incomplete/);
assert.match(fs.readFileSync(path.join(dest,'.env'),'utf8'),/^GITHUB_REPOSITORY=''$/m);
run('bash',[path.join(source,'scripts/install.sh'),'--skip-tools','--defaults','--repo',remote,'--dir',dest],temp,false);

fs.symlinkSync(path.join(source,'dist'),path.join(dest,'dist'),'dir');
fs.appendFileSync(path.join(dest,'.git','info','exclude'),'\n/dist\n/node_modules\n');
fs.mkdirSync(path.join(dest,'.factory','worktrees'),{recursive:true});
fs.writeFileSync(path.join(dest,'.factory','worktrees','keep'),'worktree');
const originalEnv=fs.readFileSync(path.join(dest,'.env'),'utf8');
fs.writeFileSync(path.join(seed,'change.txt'),'upstream');run('git',['add','.'],seed);run('git',['commit','-m','upstream'],seed);run('git',['push','origin','HEAD:main'],seed);
env.AI_FACTORY_UPDATE_STATE_FILE=path.join(temp,'update-state.json');
run('bash',['scripts/update.sh','--defaults'],dest);
assert.equal(JSON.parse(fs.readFileSync(env.AI_FACTORY_UPDATE_STATE_FILE,'utf8')).status,'completed');
assert.equal(fs.readFileSync(path.join(dest,'change.txt'),'utf8'),'upstream');
assert.equal(fs.readFileSync(path.join(dest,'.env'),'utf8'),originalEnv);
assert.equal(fs.readFileSync(path.join(dest,'.factory','worktrees','keep'),'utf8'),'worktree');
assert.ok(fs.readdirSync(path.join(dest,'.factory')).some(f=>f.startsWith('update-backup-')));
fs.writeFileSync(path.join(dest,'dirty'),'dirty');assert.match(run('bash',['scripts/update.sh','--defaults'],dest,false).stderr,/Local changes/);fs.unlinkSync(path.join(dest,'dirty'));
const db=new Database(path.join(dest,'.factory','factory.db'));
db.prepare('INSERT INTO daemon_lock(id,pid,token) VALUES(1,?,?)').run(process.pid,'test');
assert.match(run('bash',['scripts/update.sh','--defaults'],dest,false).stderr,/Daemon already running/);
db.prepare('DELETE FROM daemon_lock').run();db.close();
run('git',['config','user.email','test@example.com'],dest);run('git',['config','user.name','Test'],dest);
fs.writeFileSync(path.join(dest,'local'),'local');run('git',['add','.'],dest);run('git',['commit','-m','local'],dest);
assert.match(run('bash',['scripts/update.sh','--defaults'],dest,false).stderr,/merge-base/);
env.AI_FACTORY_SKIP_SERVICES='0';
fs.writeFileSync(path.join(dest,'scripts','services.sh'),`#!/bin/sh
if [ "$1 $2" = "status dashboard" ]; then echo 'dashboard: loaded'; elif [ "$1" = status ]; then echo "$2: stopped"; else echo "$1 $2" >> '${path.join(temp,'service-recovery.log')}'; fi
`,{mode:0o755});
run('bash',['scripts/update.sh','--defaults','--restart-services'],dest,false);
const recovery=fs.readFileSync(path.join(temp,'service-recovery.log'),'utf8');
assert.match(recovery,/stop all/);assert.match(recovery,/install dashboard/);assert.match(recovery,/start dashboard/);
assert.equal(JSON.parse(fs.readFileSync(env.AI_FACTORY_UPDATE_STATE_FILE,'utf8')).status,'failed');
console.log('PASS: install, existing destination, fast-forward, config/worktree preservation, backup, dirty checkout, daemon lock, local-only commit, persisted update state and dashboard recovery.');
} finally { fs.rmSync(temp,{recursive:true,force:true}); }

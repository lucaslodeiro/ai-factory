import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parse} from 'dotenv';
import Database from 'better-sqlite3';
const source = fileURLToPath(new URL('..',import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(),'factory-configure-'));
try {
  const home = path.join(root,'home');
  const bin = path.join(root,'bin');
  const remote = path.join(root,'alice','ai-factory-demo.git');
  const ghLog = path.join(root,'gh.log');
  const ghAuth = path.join(root,'gh.authenticated');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'gh'),`#!/usr/bin/env bash
set -e
echo "$*" >> "$GH_LOG"
if [[ $1 == auth && $2 == login ]]; then
  touch "$GH_AUTH"
elif [[ $1 == api && $2 == user ]]; then
  [[ -f $GH_AUTH ]] || exit 1
  [[ $4 == .login ]] && echo alice || echo 12345
elif [[ $1 == repo && $2 == view ]]; then
  [[ -d $GH_REMOTE ]]
elif [[ $1 == repo && $2 == create ]]; then
  mkdir -p "$(dirname "$GH_REMOTE")"
  git init --bare "$GH_REMOTE" >/dev/null
elif [[ $1 == repo && $2 == clone ]]; then
  git clone "$GH_REMOTE" "$4" >/dev/null 2>&1
fi
`,{mode:0o755});
  const env = {...process.env,HOME:home,GH_REMOTE:remote,GH_LOG:ghLog,GH_AUTH:ghAuth,PATH:`${bin}:${process.env.PATH}`};
  fs.mkdirSync(path.join(root,'scripts'));
  for (const file of ['configure.sh','configure.mjs']) fs.copyFileSync(path.join(source,'scripts',file),path.join(root,'scripts',file));
  fs.copyFileSync(path.join(source,'.env.example'),path.join(root,'.env.example'));
  fs.symlinkSync(path.join(source,'node_modules'),path.join(root,'node_modules'),'dir');
  const template = fs.readFileSync(path.join(root,'.env.example'),'utf8');
  const keys = Object.keys(parse(template));
  const file = path.join(root,'.env');
  function run(args = [], input = '', success = true) {
    const result = spawnSync('bash',[path.join(root,'scripts/configure.sh'),...args],{input,encoding:'utf8',env});
    assert.equal(result.status === 0,success,result.stdout + result.stderr);
    return result;
  }
  const initial = run(['--defaults']);
  assert.match(initial.stdout,/not an installation error/);
  assert.doesNotMatch(initial.stdout,/Setup incomplete/);
  assert.equal(parse(fs.readFileSync(file)).FACTORY_POLL_INTERVAL_MS,'15000');
  assert.equal(parse(fs.readFileSync(file)).GITHUB_REPOSITORY,'');
  const provisioned = run([],keys.map(() => '').join('\n') + '\ny\n');
  const provisionedValues = parse(fs.readFileSync(file));
  assert.equal(provisionedValues.GITHUB_REPOSITORY,'alice/ai-factory-demo');
  assert.equal(provisionedValues.FACTORY_APPROVERS,'alice');
  assert.equal(provisionedValues.FACTORY_REPO_DIR,path.join(home,'Source','ai-factory-demo'));
  assert.match(provisioned.stdout,/Required target settings now have usable defaults/);
  assert.equal(spawnSync('git',['-C',provisionedValues.FACTORY_REPO_DIR,'log','-1','--format=%s'],{encoding:'utf8'}).stdout.trim(),'chore: initialize demo');
  assert.match(fs.readFileSync(ghLog,'utf8'),/label create factory:queued/);
  assert.match(fs.readFileSync(ghLog,'utf8'),/auth login --hostname github.com --git-protocol https --web/);
  fs.writeFileSync(file,"GITHUB_REPOSITORY=example/existing\nFACTORY_APPROVERS=alice\nFACTORY_DATA_DIR=.factory\nSLACK_WEBHOOK_URL=https://hooks.example.com/private-secret\nCUSTOM_VALUE='keep # $HOME'\n");
  const saved = fs.readFileSync(file,'utf8');
  const target = path.join(root,'my target #1');
  const answers = keys.map(key => ({FACTORY_REPO_DIR:target,FACTORY_POLL_INTERVAL_MS:'0\n5000',GITHUB_REPOSITORY:'invalid\nexample/new',FACTORY_APPROVERS:'-'}[key] ?? '')).join('\n') + '\n';
  const result = run([],answers);
  assert.ok(!result.stdout.includes('private-secret'));
  const values = parse(fs.readFileSync(file));
  assert.equal(values.FACTORY_REPO_DIR,target);
  assert.equal(values.GITHUB_REPOSITORY,'example/new');
  assert.equal(values.FACTORY_APPROVERS,'');
  assert.equal(values.FACTORY_POLL_INTERVAL_MS,'5000');
  assert.equal(values.CUSTOM_VALUE,'keep # $HOME');
  assert.equal(values.CLAUDE_MODEL_STRONG,'opus');
  const backups = fs.readdirSync(root).filter(name => name.startsWith('.env.backup-'));
  assert.equal(fs.readFileSync(path.join(root,backups.at(-1)),'utf8'),saved);
  assert.equal(fs.statSync(file).mode & 0o777,0o600);
  const before = fs.readFileSync(file,'utf8');
  run([], '\n',false);
  assert.equal(fs.readFileSync(file,'utf8'),before);
  run(['--defaults']);
  assert.deepEqual(parse(fs.readFileSync(file)),values);
  fs.mkdirSync(path.join(root,'.factory'));
  const db = new Database(path.join(root,'.factory','factory.db'));
  db.exec('CREATE TABLE daemon_lock(id INTEGER PRIMARY KEY,pid INTEGER,token TEXT)');
  db.prepare('INSERT INTO daemon_lock VALUES(1,?,?)').run(process.pid,'test');
  assert.match(run(['--defaults'],'',false).stderr,/Stop the factory/);
  db.close();
  console.log('PASS: installation defaults, GitHub-derived required defaults, private demo provisioning, saved defaults, edits, clearing, validation/retry, secret masking, unknown settings, backups, permissions, EOF cancellation and daemon guard.');
} finally { fs.rmSync(root,{recursive:true,force:true}); }

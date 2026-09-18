import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Load the installed runtime before replacing dependencies/build assets.
const {config} = await import('../dist/src/config.js');
const {Store} = await import('../dist/src/storage.js');
const {acquireLock} = await import('../dist/src/daemon.js');
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {encoding:'utf8', stdio:capture ? 'pipe' : 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed${capture ? `: ${result.stderr.trim()}` : ''}`);
  return capture ? result.stdout.trim() : '';
}
const git = (...args) => run(config.gitCommand, args, true);
let store, release, backup, before;
try {
  if (git('status','--porcelain')) throw new Error('Local changes found. Commit or move them before updating.');
  const branch = git('symbolic-ref','--quiet','--short','HEAD');
  before = git('rev-parse','HEAD');
  store = new Store();
  release = acquireLock(store);
  // Fetch only; refuse local commits/divergence before touching the checkout.
  run(config.gitCommand,['fetch','origin',`refs/heads/${branch}`]);
  const target = git('rev-parse','FETCH_HEAD');
  git('merge-base','--is-ancestor',before,target);
  backup = fs.mkdtempSync(path.join(config.dataDir,'update-backup-'));
  fs.chmodSync(backup,0o700);
  await store.db.backup(path.join(backup,'factory.db'));
  if (fs.existsSync('.env')) {
    fs.copyFileSync('.env',path.join(backup,'.env'));
    fs.chmodSync(path.join(backup,'.env'),0o600);
  }
  fs.writeFileSync(path.join(backup,'revision.json'),JSON.stringify({before,target,branch},null,2));
  console.log(`Backup: ${backup}`);
  run(config.gitCommand,['merge','--ff-only',target]);
  run('npm',['ci']);
  run('npm',['run','build']);
  run('npm',['test']);
  console.log(`Factory updated to ${target}. Configuration and worktrees preserved. Start it explicitly when ready.`);
} catch (error) {
  console.error(`Update stopped: ${error.message}`);
  if (backup) console.error(`Backup: ${backup}\nPrevious revision: ${before}\nNo automatic rollback or daemon restart was performed.`);
  process.exitCode = 1;
} finally {
  try { release?.(); } finally { store?.db.close(); }
}

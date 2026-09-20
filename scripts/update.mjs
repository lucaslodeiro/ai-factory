import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {environmentFile} from './paths.mjs';

// Load the installed runtime before replacing dependencies/build assets.
const {config} = await import('../dist/src/config.js');
const {Store} = await import('../dist/src/storage.js');
const {acquireLock} = await import('../dist/src/daemon.js');
const stateFile=process.env.AI_FACTORY_UPDATE_STATE_FILE;
let step='preparing the update';
function progress(phase,status='updating') {
  if (!stateFile) return;
  let old={};
  try { old=JSON.parse(fs.readFileSync(stateFile,'utf8')); } catch {}
  const now=new Date().toISOString(),next={...old,status,phase,updatedAt:now,versionActivated:activated};
  if (status!=='updating') next.finishedAt=now;
  fs.mkdirSync(path.dirname(stateFile),{recursive:true});
  const temporary=`${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(next,null,2),{mode:0o600});
  fs.renameSync(temporary,stateFile);
}
function run(command, args, capture = false, timeout = 600000, cwd = process.cwd()) {
  const result = spawnSync(command, args, {cwd,encoding:'utf8', stdio:capture ? 'pipe' : 'inherit',timeout,killSignal:'SIGTERM'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed${capture ? `: ${result.stderr.trim()}` : ''}`);
  return capture ? result.stdout.trim() : '';
}
const git = (...args) => run(config.gitCommand, args, true);
let store, release, backup, before, candidate, activated=false;
const moved=[];
async function acquireUpdateLock() {
  const deadline=Date.now()+60000;
  while (true) {
    store?.db.close();
    store=new Store();
    try { return acquireLock(store); }
    catch (error) {
      const daemonStopping=process.env.AI_FACTORY_WAIT_FOR_DAEMON_STOP==='1' && /Daemon already running/.test(error.message);
      if (!daemonStopping || Date.now()>=deadline) throw error;
      progress('Waiting for the daemon to finish stopping…');
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
}
try {
  step='checking the local checkout'; progress('Checking the local checkout…');
  if (git('status','--porcelain')) throw new Error('Local changes found. Commit or move them before updating.');
  const branch = git('symbolic-ref','--quiet','--short','HEAD');
  before = git('rev-parse','HEAD');
  release = await acquireUpdateLock();
  // Fetch only; refuse local commits/divergence before touching the checkout.
  step='downloading the latest source'; progress('Downloading the latest source…');
  run(config.gitCommand,['fetch','origin',`refs/heads/${branch}`],false,120000);
  const target = git('rev-parse','FETCH_HEAD');
  git('merge-base','--is-ancestor',before,target);
  step='backing up configuration and runtime data'; progress('Backing up configuration and runtime data…');
  backup = fs.mkdtempSync(path.join(config.dataDir,'update-backup-'));
  fs.chmodSync(backup,0o700);
  await store.db.backup(path.join(backup,'factory.db'));
  if (fs.existsSync(environmentFile)) {
    fs.copyFileSync(environmentFile,path.join(backup,'.env'));
    fs.chmodSync(path.join(backup,'.env'),0o600);
  }
  fs.writeFileSync(path.join(backup,'revision.json'),JSON.stringify({before,target,branch},null,2));
  console.log(`Backup: ${backup}`);
  step='preparing the candidate version'; progress('Preparing the candidate version…');
  candidate=path.join(backup,'candidate');
  run(config.gitCommand,['worktree','add','--detach',candidate,target]);
  step='installing candidate dependencies'; progress('Installing candidate dependencies…');
  run('npm',['ci'],false,600000,candidate);
  step='building the candidate'; progress('Building the candidate…');
  run('npm',['run','build'],false,300000,candidate);
  step='validating the candidate installation'; progress('Validating runtime, assets and database compatibility…');
  run(process.execPath,[path.join(candidate,'scripts/validate-installation.mjs'),path.join(backup,'factory.db')],false,60000,candidate);
  step='activating the validated version'; progress('Activating the validated version…');
  // Recheck before activation: a concurrent edit must not be overwritten.
  if(git('status','--porcelain')||git('rev-parse','HEAD')!==before)throw new Error('Checkout changed during update preparation');
  run(config.gitCommand,['merge','--ff-only',target]);
  activated=true;
  for(const name of ['node_modules','dist']){
    const old=path.join(backup,name);
    if(fs.existsSync(name)){fs.renameSync(name,old);moved.push(name);}
    fs.renameSync(path.join(candidate,name),path.resolve(name));
  }
  progress("Validated version activated; restoring services…");
  console.log(`Factory updated to ${target}. Configuration and worktrees preserved. Start it explicitly when ready.`);
} catch (error) {
  if(activated){
    try{
      run(config.gitCommand,['reset','--keep',before]);
      for(const name of ['node_modules','dist'])if(moved.includes(name)){fs.rmSync(name,{recursive:true,force:true});fs.renameSync(path.join(backup,name),path.resolve(name));}
      activated=false;
    }catch(recovery){console.error(`Version recovery failed: ${recovery.message}. Keep services stopped and use backup ${backup}.`);}
  }
  const message=`Update failed while ${step}: ${error.message}`;
  progress(message,'failed');
  console.error(message);
  if (backup) console.error(`Backup: ${backup}\nPrevious revision: ${before}\n${activated?"Version recovery is incomplete; keep services stopped.":"Previous installed version preserved."}`);
  process.exitCode = 1;
} finally {
  if(candidate)spawnSync(config.gitCommand,["worktree","remove","--force",candidate],{encoding:"utf8"});
  try { release?.(); } finally { store?.db.close(); }
}

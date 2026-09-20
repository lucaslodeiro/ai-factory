import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import readline from 'node:readline';
import {Writable} from 'node:stream';
import {parse} from 'dotenv';
import Database from 'better-sqlite3';
import {prepareRepository} from '../dist/src/repository-setup.js';
import {validateSetting} from '../dist/src/dashboard-settings.js';
function installationHome(root){return process.env.AI_FACTORY_HOME?.trim()?path.resolve(process.env.AI_FACTORY_HOME):path.basename(path.resolve(root))==='engine'?path.dirname(path.resolve(root)):path.resolve(root);}

function run(command, args, options = {}) {
  return spawnSync(command,args,{encoding:'utf8',timeout:30000,...options});
}
function githubValue(expression) {
  const result = run('gh',['api','user','--jq',expression]);
  return result.status === 0 ? result.stdout.trim() : '';
}
function githubLogin() {
  const login = githubValue('.login');
  return /^[a-zA-Z0-9-]+$/.test(login) ? login : '';
}
function repositoryDefaultBranch(repository) {
  const result=run('gh',['api',`repos/${repository}`,'--jq','.default_branch']);
  const value=result.status===0?result.stdout.trim():'';
  return /^[A-Za-z0-9._/-]+$/.test(value)?value:'';
}
function requireSuccess(result, action) {
  if (result.status !== 0) throw new Error(`${action} failed.\n${(result.stderr || result.stdout || '').trim()}`);
}
async function askYesNo(lines, question) {
  while (true) {
    process.stdout.write(`${question} [Y/n]: `);
    const answer = await lines.next();
    if (answer.done) throw new Error('Configuration cancelled; no changes saved.');
    const value = answer.value.trim().toLowerCase();
    if (!value || ['y','yes','s','si','sí'].includes(value)) return true;
    if (['n','no'].includes(value)) return false;
    console.log('Answer yes or no.');
  }
}
async function prepareTarget(root, values, lines, login) {
  if (!values.GITHUB_REPOSITORY || !values.FACTORY_REPO_DIR || !login) return false;
  const repoDir = path.resolve(installationHome(root),values.FACTORY_REPO_DIR);
  const exists = fs.existsSync(repoDir);
  const remote = run('gh',['repo','view',values.GITHUB_REPOSITORY,'--json','nameWithOwner']);
  const repoExists = remote.status === 0;
  if (!exists) {
    const action = repoExists ? 'Clone' : 'Create as a private repository and clone';
    if (!await askYesNo(lines,`${action} ${values.GITHUB_REPOSITORY} in ${repoDir}?`)) return false;
    if (!repoExists) requireSuccess(run('gh',['repo','create',values.GITHUB_REPOSITORY,'--private','--description','Demo application managed by AI Factory']),'Creating the private GitHub repository');
  }
  prepareRepository({repoDir,repo:values.GITHUB_REPOSITORY,defaultBranch:values.GITHUB_DEFAULT_BRANCH,gitCommand:values.GIT_COMMAND},()=>({login,id:Number(githubValue('.id'))}));
  return true;
}

export function encode(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Use a single line.');
  for (const quote of ["'", '`', '"']) {
    if (!value.includes(quote) && !(quote === '"' && /\\[nr]/.test(value))) return quote + value + quote;
  }
  throw new Error('Value contains an unsupported combination of quotes.');
}
export function saveConfig(root, template, values, original) {
  // Preserve unrecognized settings as well as every known setting.
  let output = template.replace(/^([A-Z_][A-Z0-9_]*)=.*$/gm, (_, key) => `${key}=${encode(values[key])}`);
  const known = parse(template);
  for (const [key, value] of Object.entries(values)) if (!(key in known)) output += `\n${key}=${encode(value)}`;
  const home=installationHome(root),file = path.join(home,'.env');
  const current = fs.existsSync(file) ? fs.readFileSync(file,'utf8') : null;
  if (current !== original) throw new Error('.env changed during configuration; rerun to load the new defaults.');
  if (original !== null) {
    const backup = path.join(home,`.env.backup-${Date.now()}-${process.pid}`);
    fs.writeFileSync(backup,original,{flag:'wx',mode:0o600});
    console.log(`Previous configuration saved to ${backup}`);
  }
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary,output,{flag:'wx',mode:0o600});
    fs.renameSync(temporary,file);
  } finally { fs.rmSync(temporary,{force:true}); }
}
function assertStopped(root, values) {
  const file = path.join(path.resolve(installationHome(root),values.FACTORY_DATA_DIR), 'factory.db');
  if (!fs.existsSync(file)) return;
  const db = new Database(file,{readonly:true});
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='daemon_lock'").get()) return;
    const row = db.prepare('SELECT pid FROM daemon_lock WHERE id=1').get();
    if (row) {
      try { process.kill(row.pid,0); } catch (error) { if (error.code === 'ESRCH') return; }
      throw new Error('Stop the factory daemon/sync/updater before configuring it.');
    }
  } finally { db.close(); }
}
export async function configure(root, useDefaults = false) {
  const template = fs.readFileSync(path.join(root,'.env.example'),'utf8');
  const file = path.join(installationHome(root),'.env');
  const original = fs.existsSync(file) ? fs.readFileSync(file,'utf8') : null;
  const saved = parse(original ?? '');
  const defaults = parse(template);
  const values = {...defaults,...saved};
  assertStopped(root, values);
  const oldValues = {...values};
  let targetPrepared;
  let rl;
  try {
    if (!useDefaults) {
      let login = githubLogin();
      if (!login) {
        if (run('gh',['--version']).status !== 0) throw new Error('GitHub CLI was not found. Add ~/.local/bin to PATH or reinstall the toolchain, then rerun configuration.');
        console.log('GitHub authentication is required to read issues and create pull requests. Opening GitHub login...');
        const auth = run('gh',['auth','login','--hostname','github.com','--git-protocol','https','--web'],{stdio:'inherit',encoding:undefined,timeout:300000});
        requireSuccess(auth,'GitHub authentication');
        login = githubLogin();
        if (!login) throw new Error('GitHub authentication completed, but the account login could not be read. Run `gh auth status` and retry.');
      }
      requireSuccess(run('gh',['auth','setup-git','--hostname','github.com']), 'Configuring GitHub authentication for Git');
      if (!values.GITHUB_REPOSITORY) values.GITHUB_REPOSITORY = `${login}/ai-factory-demo`;
      if (!values.FACTORY_APPROVERS) values.FACTORY_APPROVERS = login;
      if (!values.FACTORY_REPO_DIR) {
        const repositoryName = values.GITHUB_REPOSITORY.split('/').at(-1) || 'ai-factory-demo';
        values.FACTORY_REPO_DIR = path.join(installationHome(root),'repos',repositoryName);
      }
      console.log('Configure factory: Enter keeps [default]; "-" clears an optional value. Ctrl+C cancels without saving.');
      console.log(`GitHub account: ${login}. Required target settings now have usable defaults.`);
      console.log('Paths are relative to the factory checkout.');
      let hidden = false;
      const output = new Writable({write(chunk, encoding, next) { if (!hidden) process.stdout.write(chunk,encoding); next(); }});
      rl = readline.createInterface({input:process.stdin,output,terminal:!!process.stdin.isTTY});
      const lines = rl[Symbol.asyncIterator]();
      rl.on('SIGINT', () => rl.close());
      for (const key of Object.keys(defaults)) {
        const secret = key === 'SLACK_WEBHOOK_URL';
        while (true) {
          process.stdout.write(`${key} [${secret && values[key] ? 'configured; hidden' : values[key] || 'empty'}]: `);
          hidden = secret;
          const answer = await lines.next();
          hidden = false;
          if (secret && process.stdin.isTTY) process.stdout.write('\n');
          if (answer.done) throw new Error('Configuration cancelled; no changes saved.');
          const value = answer.value === '' ? values[key] : answer.value === '-' ? '' : answer.value.trim();
          try {
            validateSetting(key,value);
            const previous = values[key];
            values[key] = value;
            if (key.endsWith('_PROVIDER') && value !== previous) {
              const prefix = key.slice(0,-'_PROVIDER'.length);
              values[`${prefix}_MODEL`] = 'auto';
            }
            break;
          }
          catch (error) { console.log(error.message); }
        }
      }
      const defaultBranch=repositoryDefaultBranch(values.GITHUB_REPOSITORY);
      if(defaultBranch&&values.GITHUB_REPOSITORY!==oldValues.GITHUB_REPOSITORY)values.GITHUB_DEFAULT_BRANCH=defaultBranch;
      const required = ['GITHUB_REPOSITORY','FACTORY_REPO_DIR','FACTORY_APPROVERS'];
      if (required.every(key => values[key])) targetPrepared = await prepareTarget(root,values,lines,login);
    }
    for (const key of Object.keys(defaults)) validateSetting(key,values[key]);
    assertStopped(root, oldValues);
    assertStopped(root, values);
    saveConfig(root,template,values,original);
    const missing = ['GITHUB_REPOSITORY','FACTORY_REPO_DIR','FACTORY_APPROVERS'].filter(key => !values[key]);
    console.log('\nConfiguration saved safely to .env. No daemon was started.');
    if (missing.length) {
      console.log('The factory engine is installed. Target-project setup was left for later; this is not an installation error.');
      console.log(`Still required before the first start: ${missing.join(', ')}`);
      console.log('Run `npm run configure` to complete GitHub and target-project setup.');
    } else if (targetPrepared !== true) {
      console.log('Target settings were saved, but the local clone was not prepared.');
      console.log('Run `npm run configure` when you are ready to create or clone it.');
    } else {
      console.log('Target-project configuration is complete.');
      console.log('Next validation: npm run factory -- doctor');
    }
  } finally { rl?.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log('Usage: bash scripts/configure.sh [--defaults]\nExisting .env values override installation defaults. --defaults saves without prompting.');
  else if (args.some(arg => arg !== '--defaults')) { console.error('Unknown argument; see --help.'); process.exitCode = 1; }
  else {
    try { await configure(fileURLToPath(new URL('..',import.meta.url)),args.includes('--defaults')); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}

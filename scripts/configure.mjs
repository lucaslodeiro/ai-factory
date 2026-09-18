import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import readline from 'node:readline';
import {Writable} from 'node:stream';
import {parse} from 'dotenv';
import Database from 'better-sqlite3';

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
function git(root, command, args, options = {}) {
  return run(command,['-C',root,...args],options);
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
function ensureGitIdentity(repoDir, gitCommand, login) {
  const name = git(repoDir,gitCommand,['config','user.name']);
  if (name.status !== 0 || !name.stdout.trim()) requireSuccess(git(repoDir,gitCommand,['config','user.name',login]),'Configuring the repository Git author name');
  const email = git(repoDir,gitCommand,['config','user.email']);
  if (email.status !== 0 || !email.stdout.trim()) {
    const id = githubValue('.id');
    const address = /^\d+$/.test(id) ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`;
    requireSuccess(git(repoDir,gitCommand,['config','user.email',address]),'Configuring the repository Git author email');
  }
}
async function prepareTarget(values, lines, login) {
  if (!values.GITHUB_REPOSITORY || !values.FACTORY_REPO_DIR || !login) return false;
  const repoDir = path.resolve(values.FACTORY_REPO_DIR);
  const exists = fs.existsSync(repoDir);
  const remote = run('gh',['repo','view',values.GITHUB_REPOSITORY,'--json','nameWithOwner']);
  const repoExists = remote.status === 0;
  if (!exists) {
    const action = repoExists ? 'Clone' : 'Create as a private repository and clone';
    if (!await askYesNo(lines,`${action} ${values.GITHUB_REPOSITORY} in ${repoDir}?`)) return false;
    fs.mkdirSync(path.dirname(repoDir),{recursive:true});
    if (!repoExists) requireSuccess(run('gh',['repo','create',values.GITHUB_REPOSITORY,'--private','--description','Demo application managed by AI Factory']),'Creating the private GitHub repository');
    requireSuccess(run('gh',['repo','clone',values.GITHUB_REPOSITORY,repoDir],{timeout:120000}),'Cloning the target repository');
  }
  if (!fs.statSync(repoDir).isDirectory()) throw new Error(`Target checkout is not a directory: ${repoDir}`);
  const origin = git(repoDir,values.GIT_COMMAND,['remote','get-url','origin']);
  const normalizedOrigin = origin.stdout.trim().replace(/\.git$/,'');
  if (origin.status !== 0 || !normalizedOrigin.endsWith(values.GITHUB_REPOSITORY)) {
    throw new Error(`Target checkout origin does not match ${values.GITHUB_REPOSITORY}: ${repoDir}`);
  }
  ensureGitIdentity(repoDir,values.GIT_COMMAND,login);
  const head = git(repoDir,values.GIT_COMMAND,['rev-parse','--verify','HEAD']);
  if (head.status !== 0) {
    requireSuccess(git(repoDir,values.GIT_COMMAND,['symbolic-ref','HEAD',`refs/heads/${values.GITHUB_DEFAULT_BRANCH}`]),'Selecting the initial branch');
    const readme = path.join(repoDir,'README.md');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme,`# ai-factory-demo\n\nDemo application managed by AI Factory.\n`);
    requireSuccess(git(repoDir,values.GIT_COMMAND,['add','README.md']),'Staging the demo README');
    requireSuccess(git(repoDir,values.GIT_COMMAND,['commit','-m','chore: initialize demo']),'Creating the initial demo commit');
    requireSuccess(git(repoDir,values.GIT_COMMAND,['push','-u','origin',values.GITHUB_DEFAULT_BRANCH],{timeout:120000}),'Publishing the initial demo branch');
  }
  requireSuccess(run('gh',['label','create','factory:queued','--repo',values.GITHUB_REPOSITORY,'--color','7057ff','--description','Queued for AI Factory','--force']),'Creating the factory queue label');
  return true;
}

export function encode(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Use a single line.');
  for (const quote of ["'", '`', '"']) {
    if (!value.includes(quote) && !(quote === '"' && /\\[nr]/.test(value))) return quote + value + quote;
  }
  throw new Error('Value contains an unsupported combination of quotes.');
}
export function validate(key, value) {
  encode(value);
  if (/_MS$/.test(key) || key === 'FACTORY_MAX_FIX_CYCLES') {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error('Enter a positive integer.');
  }
  if (key === 'FACTORY_DASHBOARD_PORT' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new Error('Enter a port from 1 to 65535.');
  if (key === 'FACTORY_DASHBOARD_HOST' && !['127.0.0.1','localhost','::1'].includes(value)) throw new Error('Use a loopback address: 127.0.0.1, localhost or ::1.');
  if (key === 'GITHUB_REPOSITORY' && value && !/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error('Use owner/repository.');
  if (key === 'FACTORY_APPROVERS' && value && !value.split(',').every(v => /^[a-zA-Z0-9-]+$/.test(v.trim()))) throw new Error('Use comma-separated GitHub usernames.');
  if (key === 'AGENT_SECRET_ALLOWLIST' && value && !value.split(',').every(v => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()))) throw new Error('Use comma-separated environment variable names.');
  if (key.includes('_MODEL_') && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)) throw new Error('Enter a model identifier.');
  if (key.endsWith('_PROVIDER') && !['codex','claude'].includes(value)) throw new Error('Choose codex or claude.');
  if (['FACTORY_DATA_DIR','GITHUB_DEFAULT_BRANCH','CODEX_COMMAND','CLAUDE_COMMAND','GIT_COMMAND'].includes(key) && !value.trim()) throw new Error('This value cannot be empty.');
  if (key === 'SLACK_WEBHOOK_URL' && value) {
    let url; try { url = new URL(value); } catch { throw new Error('Enter an HTTPS URL.'); }
    if (url.protocol !== 'https:') throw new Error('Enter an HTTPS URL.');
  }
}
export function saveConfig(root, template, values, original) {
  // Preserve unrecognized settings as well as every known setting.
  let output = template.replace(/^([A-Z_][A-Z0-9_]*)=.*$/gm, (_, key) => `${key}=${encode(values[key])}`);
  const known = parse(template);
  for (const [key, value] of Object.entries(values)) if (!(key in known)) output += `\n${key}=${encode(value)}`;
  const file = path.join(root,'.env');
  const current = fs.existsSync(file) ? fs.readFileSync(file,'utf8') : null;
  if (current !== original) throw new Error('.env changed during configuration; rerun to load the new defaults.');
  if (original !== null) {
    const backup = path.join(root,`.env.backup-${Date.now()}-${process.pid}`);
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
  const file = path.join(path.resolve(root,values.FACTORY_DATA_DIR), 'factory.db');
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
  const file = path.join(root,'.env');
  const original = fs.existsSync(file) ? fs.readFileSync(file,'utf8') : null;
  const saved = parse(original ?? '');
  const defaults = parse(template);
  for (const [key, command] of Object.entries({CODEX_COMMAND:'codex',CLAUDE_COMMAND:'claude',GIT_COMMAND:'git'})) {
    const found = run('which',[command]);
    if (found.status === 0) defaults[key] = found.stdout.trim();
  }
  const values = {...defaults,...saved};
  for (const prefix of ['PRODUCT_ARCHITECT','DEVELOPER','QA','REVIEWER']) {
    const selected = (values[`${prefix}_PROVIDER`] || defaults[`${prefix}_PROVIDER`]).toUpperCase();
    for (const profile of ['FAST','BALANCED','STRONG']) {
      const roleKey = `${prefix}_MODEL_${profile}`;
      if (!(roleKey in saved)) values[roleKey] = values[`${selected}_MODEL_${profile}`] || defaults[roleKey];
    }
  }
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
        values.FACTORY_REPO_DIR = path.join(process.env.HOME || process.cwd(),'Source',repositoryName);
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
            validate(key,value);
            const previous = values[key];
            values[key] = value;
            if (key.endsWith('_PROVIDER') && value !== previous) {
              const prefix = key.slice(0,-'_PROVIDER'.length), selected = value.toUpperCase();
              for (const profile of ['FAST','BALANCED','STRONG']) values[`${prefix}_MODEL_${profile}`] = values[`${selected}_MODEL_${profile}`];
            }
            break;
          }
          catch (error) { console.log(error.message); }
        }
      }
      const required = ['GITHUB_REPOSITORY','FACTORY_REPO_DIR','FACTORY_APPROVERS'];
      if (required.every(key => values[key])) targetPrepared = await prepareTarget(values,lines,login);
    }
    for (const key of Object.keys(defaults)) validate(key,values[key]);
    assertStopped(root, oldValues);
    assertStopped(root, values);
    saveConfig(root,template,values,original);
    const missing = ['GITHUB_REPOSITORY','FACTORY_REPO_DIR','FACTORY_APPROVERS'].filter(key => !values[key]);
    console.log('\nConfiguration saved safely to .env. No daemon was started.');
    if (missing.length) {
      console.log('The factory engine is installed. Target-project setup was left for later; this is not an installation error.');
      console.log(`Still required before the first start: ${missing.join(', ')}`);
      console.log('Run `npm run configure` to complete GitHub and target-project setup.');
    } else if (targetPrepared === false) {
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

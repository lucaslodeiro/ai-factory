import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import readline from 'node:readline';
import {Writable} from 'node:stream';
import {parse} from 'dotenv';
import Database from 'better-sqlite3';

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
  if (key === 'GITHUB_REPOSITORY' && value && !/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error('Use owner/repository.');
  if (key === 'FACTORY_APPROVERS' && value && !value.split(',').every(v => /^[a-zA-Z0-9-]+$/.test(v.trim()))) throw new Error('Use comma-separated GitHub usernames.');
  if (key === 'AGENT_SECRET_ALLOWLIST' && value && !value.split(',').every(v => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()))) throw new Error('Use comma-separated environment variable names.');
  if (key.includes('_MODEL_') && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)) throw new Error('Enter a model identifier.');
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
    const found = spawnSync('which',[command],{encoding:'utf8'});
    if (found.status === 0) defaults[key] = found.stdout.trim();
  }
  const values = {...defaults,...saved};
  assertStopped(root, values);
  const oldValues = {...values};
  let rl;
  try {
    if (!useDefaults) {
      console.log('Configure factory: Enter keeps [default]; "-" clears an optional value. Ctrl+C cancels without saving.');
      console.log('Blank repository/clone/approvers leave setup incomplete. Paths are relative to the factory checkout.');
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
          try { validate(key,value); values[key] = value; break; }
          catch (error) { console.log(error.message); }
        }
      }
    }
    for (const key of Object.keys(defaults)) validate(key,values[key]);
    assertStopped(root, oldValues);
    assertStopped(root, values);
    saveConfig(root,template,values,original);
    console.log('Configuration saved to .env. No daemon started.');
    if (['GITHUB_REPOSITORY','FACTORY_REPO_DIR','FACTORY_APPROVERS'].some(key => !values[key])) console.log('Setup incomplete: configure repository, local clone and approvers before starting.');
    console.log('Next: npm run factory -- doctor');
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

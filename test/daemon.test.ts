import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { result } from "./fixtures.js";
import { Store } from "../src/storage.js";
import { git } from "../src/worktrees.js";

test("full daemon and CLI integration with local Git remote and deterministic provider/GitHub executables", { timeout: 30000 }, async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-daemon-"));
 const repo = path.join(root, "repo"), origin = path.join(root, "owner", "demo.git"), bin = path.join(root, "bin"), data = path.join(root, "data");
 for (const p of [repo, origin, bin, data]) fs.mkdirSync(p, { recursive: true });
 git(origin, ["init", "--bare"]); git(repo, ["init"]);
 git(repo, ["config", "user.name", "Factory Test"]); git(repo, ["config", "user.email", "factory@example.test"]);
 fs.writeFileSync(path.join(repo, "README.md"), "Demo"); git(repo, ["add", "."]); git(repo, ["commit", "-m", "base"]);
 git(repo, ["branch", "-M", "main"]); git(repo, ["remote", "add", "origin", origin]); git(repo, ["push", "-u", "origin", "main"]);
 git(repo,["remote","set-url","origin","https://github.com/owner/demo.git"]);
 git(repo,["config",`url.${origin}.insteadOf`,"https://github.com/owner/demo.git"]);
 const stateFile = path.join(root, "github.json"); fs.writeFileSync(stateFile, JSON.stringify({ comments: [], label: "bug", prs: 0 }));
 const executable = (name: string, code: string) => {
  const file = path.join(bin, name); fs.writeFileSync(file, `#!${process.execPath}\n${code}`, { mode: 0o755 }); return file;
 };
 const github = executable("gh", `
const fs=require('node:fs');const file=${JSON.stringify(stateFile)};const a=process.argv.slice(2);const s=JSON.parse(fs.readFileSync(file));
const save=()=>fs.writeFileSync(file,JSON.stringify(s));const out=x=>console.log(JSON.stringify(x));
if(a[0]==='auth'){process.exit(0)}
if(a[0]==='api'){const endpoint=a.at(-1);if(a.includes('--method')){const id=Number(a[1].split('/').pop());s.comments.find(c=>c.id===id).body=JSON.parse(fs.readFileSync(0,'utf8')).body;save();out({});}else if(endpoint==='repos/owner/demo'){out({id:1,node_id:'R_1',full_name:'owner/demo',default_branch:'main'});}else if(endpoint==='repos/owner/demo/issues/1'){out({id:100,node_id:'I_100',number:1,title:'Add greet',body:'Add greet function and tests',html_url:'https://github.com/owner/demo/issues/1',state:'open',created_at:'2026-09-20T00:00:00Z',updated_at:'2026-09-20T00:00:00Z',user:{login:'owner',type:'User'}});}else if(endpoint.startsWith('repos/owner/demo/issues?'))out([[]]);else out([s.comments])}
else if(a[0]==='label'){}
else if(a[0]==='issue'&&a[1]==='list'){out([{number:1,title:'Add greet',body:'Add greet function and tests',url:'https://github.com/owner/demo/issues/1'}])}
else if(a[0]==='issue'&&a[1]==='view'){out({labels:[{name:s.label}]})}
else if(a[0]==='issue'&&a[1]==='edit'){s.label=a[a.indexOf('--add-label')+1];save()}
else if(a[0]==='issue'&&a[1]==='comment'){s.comments.push({id:s.comments.length+1,body:a[a.indexOf('--body')+1],user:{login:'factory',type:'Bot'}});save()}
else if(a[0]==='pr'&&a[1]==='view'){out({state:'OPEN',mergedAt:null,mergeCommit:null})}
else if(a[0]==='pr'&&a[1]==='list'){out(s.prs?[{url:'https://example.test/pull/1'}]:[])}
else if(a[0]==='pr'&&a[1]==='create'){s.prs++;save();console.log('https://example.test/pull/1')}
else {console.error('Unexpected gh command',a);process.exit(2)}
`);
 const provider = executable("provider", `
const fs=require('node:fs');const cp=require('node:child_process');const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('fake-1');process.exit(0)}
if(a[0]==='login'){process.exit(0)}
if(a[0]==='auth'){console.log(JSON.stringify({loggedIn:true}));process.exit(0)}
const input=fs.readFileSync(0,'utf8');const codex=a[0]==='exec';
const architect=input.includes('# Product Architect (Architect) Contract'),developer=input.includes('# Implementation Engineer (Builder) Contract'),qa=input.includes('# Verification Engineer (Tester) Contract');
let result=architect?${JSON.stringify(result("spec"))}:${JSON.stringify(result("pass"))};
if(developer){
  const marker=${JSON.stringify(path.join(root, 'first-developer'))};
  if(!fs.existsSync(marker)){fs.writeFileSync(marker,'running');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}
  fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/greet.mjs','export const greet = name => "Hello " + name;');
} else if(qa){
  fs.mkdirSync('test',{recursive:true});fs.writeFileSync('test/greet.test.mjs','import {greet} from "../src/greet.mjs";import assert from "node:assert/strict";assert.equal(greet("world"),"Hello world");');
  const r=cp.spawnSync(process.execPath,['--test','test/greet.test.mjs']);if(r.status!==0)process.exit(5);
}
if(codex){
 fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify(result));
} else {
 console.log(JSON.stringify({is_error:false,structured_output:result}));
}
`);
 const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AI_FACTORY_HOME:root, FACTORY_DATA_DIR: data, FACTORY_REPO_DIR: repo,
  GITHUB_REPOSITORY: "owner/demo", GITHUB_DEFAULT_BRANCH: "main", FACTORY_APPROVERS: "owner", FACTORY_POLL_INTERVAL_MS: "50",
  CODEX_COMMAND: provider, CLAUDE_COMMAND: provider, PRODUCT_ARCHITECT_PROVIDER:"codex", DEVELOPER_PROVIDER:"claude",
  QA_PROVIDER:"claude", REVIEWER_PROVIDER:"codex", SLACK_WEBHOOK_URL: "", AI_FACTORY_CONTROLLER_REMOTE:origin };
 const cli = path.resolve("src/cli.ts");
 const log = fs.openSync(path.join(root, "daemon.log"), "w");
 const child = spawn(process.execPath, ["--import", "tsx", cli, "start"], { env, stdio: ["ignore", log, log], detached: true }); fs.closeSync(log);
 const exited = new Promise<number | null>(resolve => child.on("exit", resolve));
 let store: Store | undefined;
 const waitFor = async (condition: () => boolean) => {
  const until = Date.now() + 20000;
  while (!condition()) {
   if (Date.now() > until || child.exitCode !== null) throw new Error(fs.readFileSync(path.join(root, "daemon.log"), "utf8") || "Daemon timeout");
   await new Promise(r => setTimeout(r, 50));
  }
 };
 try {
  await waitFor(() => fs.existsSync(path.join(data, "factory.db")));
  store = new Store(path.join(data, "factory.db"));
  const command = (name: string, id?: string) => spawnSync(process.execPath, ["--import", "tsx", cli, name, ...(id ? [id] : [])], { env, encoding: "utf8" });
  assert.equal(command("start-issue", "1").status,0);
  await waitFor(() => (store!.db.prepare("SELECT stage,status FROM work_items LIMIT 1").get() as any)?.status === "WAITING" && JSON.parse(fs.readFileSync(stateFile, "utf8")).comments.some((c: any) => c.body.includes("SPEC v1")));
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")); state.comments.push({ id: state.comments.length + 1, body: "/factory approve v1", user: { login: "owner", type: "User" } }); fs.writeFileSync(stateFile, JSON.stringify(state));
  await waitFor(() => fs.existsSync(path.join(root, "first-developer")));
  const workId = (store.db.prepare("SELECT id FROM work_items LIMIT 1").get() as {id:string}).id;
  assert.equal(command("status").status, 0);
  assert.equal(command("sync").status, 1, "Standalone sync must not race the active daemon");
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM executions WHERE status='running'").get() as any).n, 1);
  assert.equal(command("cancel", workId).status, 0);
  await waitFor(() => (store!.db.prepare("SELECT status FROM work_items LIMIT 1").get() as any)?.status === "CANCELLED" && (store!.db.prepare("SELECT COUNT(*) AS n FROM executions WHERE status='running'").get() as any).n === 0);
  assert.equal(command("retry", workId).status, 0);
  await waitFor(() => {const row=store!.db.prepare("SELECT stage,status FROM work_items LIMIT 1").get() as any;return row?.stage==="DELIVERY"&&row?.status==="WAITING";});
  const workRow=store.db.prepare("SELECT branch,context FROM work_items LIMIT 1").get() as {branch:string;context:string};const w={branch:workRow.branch,context:JSON.parse(workRow.context)}; assert.equal(w.context.pr, "https://example.test/pull/1");
  assert.equal(git(origin, ["show", `${w.branch}:src/greet.mjs`]), 'export const greet = name => "Hello " + name;');
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM executions WHERE status='succeeded'").get() as any).n, 4);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).prs, 1);
  const stop = spawnSync(process.execPath, ["--import", "tsx", cli, "stop"], { env, encoding: "utf8" }); assert.equal(stop.status, 0, stop.stderr);
  await waitFor(() => child.exitCode !== null); assert.equal(await exited, 0);
  assert.equal(fs.existsSync(path.join(data, "daemon.lock")), false);
  const daemonLog=fs.readFileSync(path.join(root,"daemon.log"),"utf8");
  assert.match(daemonLog,/INFO\s+daemon\.starting/); assert.match(daemonLog,/INFO\s+daemon\.ready/);
  assert.match(daemonLog,/INFO\s+execution_started[\s\S]*role="Builder"/); assert.match(daemonLog,/INFO\s+workflow_transition/);
  assert.match(daemonLog,/INFO\s+daemon\.stopped/); assert.doesNotMatch(daemonLog,/Add greet function and tests/);
 } finally {
  if (child.exitCode === null && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} await exited; }
  store?.db.close(); fs.rmSync(root, { recursive: true, force: true });
 }
});

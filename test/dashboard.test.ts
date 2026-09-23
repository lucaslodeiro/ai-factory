import {validateDashboardSettings} from "../src/dashboard-settings.js";
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage.js";
import { startDashboard,versionInfo } from "../src/dashboard.js";
import { config } from "../src/config.js";

test("dashboard serves readable state and queues daemon controls", async () => {
  const store = new Store(":memory:");
  const previousApprovers=[...config.approvers];config.approvers.splice(0,config.approvers.length,"demo-user");store.setMetadata("runtime:factory-account","demo-user");
  // Upgrade compatibility: obsolete standby metadata cannot disable local controls.
  store.db.exec("CREATE TABLE repository_controller(repository_id INTEGER PRIMARY KEY,instance_id TEXT,generation INTEGER,remote_sha TEXT,state TEXT,last_verified_at TEXT,last_error TEXT); INSERT INTO repository_controller VALUES(1,'old-instance',1,'old-sha','standby','2099-01-01',NULL)");
  const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(),"factory-dashboard-settings-"));
  const previousFactoryHome = process.env.AI_FACTORY_HOME;
  process.env.AI_FACTORY_HOME=settingsRoot;
  const previousGit = config.gitCommand,previousDataDir=config.dataDir;
  const previousCodex = config.codexCommand, previousClaude = config.claudeCommand, previousCursor = config.cursorCommand, previousGh = process.env.GH_COMMAND;
  const fakeGit = path.join(settingsRoot,"git");
  fs.writeFileSync(fakeGit,`#!/usr/bin/env bash
case "$*" in
  "rev-parse --short HEAD") if [[ -f "$PWD/runtime-stale" ]]; then echo d9d0c3b; else echo abc1234; fi;;
  "rev-parse --is-inside-work-tree") echo true;;
  "symbolic-ref --quiet --short HEAD") if [[ -f "$PWD/detached-head" ]]; then exit 1; else echo main; fi;;
  "rev-parse HEAD") if [[ -f "$PWD/runtime-stale" ]]; then echo d9d0c3bd9d0c3bd9d0c3bd9d0c3bd9d0c3bd9d0; else echo abc1234abc1234abc1234abc1234abc1234abc1; fi;;
  "config user.name") echo 'AI Factory Test';;
  "config user.email") echo 'factory@example.com';;
  "remote get-url origin") echo 'https://github.com/owner/demo.git';;
  "fetch origin refs/heads/main") ;;
  "rev-parse FETCH_HEAD") if [[ -f "$PWD/runtime-stale" ]]; then echo d9d0c3bd9d0c3bd9d0c3bd9d0c3bd9d0c3bd9d0; elif [[ -f "$PWD/up-to-date" ]]; then echo abc1234abc1234abc1234abc1234abc1234abc1; else echo def5678def5678def5678def5678def5678def5; fi;;
  "rev-parse --short FETCH_HEAD") if [[ -f "$PWD/runtime-stale" ]]; then echo d9d0c3b; elif [[ -f "$PWD/up-to-date" ]]; then echo abc1234; else echo def5678; fi;;
  "merge-base --is-ancestor abc1234abc1234abc1234abc1234abc1234abc1 def5678def5678def5678def5678def5678def5") ;;
  *) echo "unexpected git args: $*" >&2; exit 1;;
esac
`,{mode:0o755});
  config.gitCommand=fakeGit;
  const fakeGh = path.join(settingsRoot,"gh"), fakeCodex = path.join(settingsRoot,"codex"), fakeClaude = path.join(settingsRoot,"claude"), fakeCursor = path.join(settingsRoot,"cursor-agent");
  fs.writeFileSync(fakeGh,`#!/usr/bin/env bash
if [[ $1 == auth && $2 == status ]]; then [[ -f "$PWD/gh-authenticated" ]]; exit; fi
if [[ $1 == auth && $2 == login ]]; then touch "$PWD/gh-authenticated"; exit; fi
if [[ $1 == auth && $2 == refresh ]]; then touch "$PWD/gh-refreshed"; exit; fi
if [[ $1 == auth && $2 == setup-git ]]; then exit; fi
if [[ $1 == api && $2 == user ]]; then echo demo-user; exit; fi
if [[ $1 == api && $2 == repos/owner/demo ]]; then echo '{"id":1,"node_id":"R_1","full_name":"owner/demo","default_branch":"main"}'; exit; fi
exit 1
`,{mode:0o755});
  fs.writeFileSync(fakeCodex,`#!/usr/bin/env bash
if [[ $1 == login && $2 == status ]]; then exit 0; fi
exit 0
`,{mode:0o755});
  fs.writeFileSync(fakeClaude,`#!/usr/bin/env bash
if [[ $1 == auth && $2 == status ]]; then echo '{"loggedIn":true,"email":"claude@example.com"}'; exit 0; fi
exit 0
`,{mode:0o755});
  fs.writeFileSync(fakeCursor,`#!/usr/bin/env bash
if [[ $1 == status ]]; then echo '{"status":"unauthenticated","isAuthenticated":false,"message":"Not logged in"}'; exit 0; fi
exit 0
`,{mode:0o755});
  config.codexCommand=fakeCodex; config.claudeCommand=fakeClaude; config.cursorCommand=fakeCursor; process.env.GH_COMMAND=fakeGh;
  fs.writeFileSync(path.join(settingsRoot,"package.json"),JSON.stringify({version:"0.1.0"}));
  fs.copyFileSync(".env.example",path.join(settingsRoot,".env.example"));
  // Saving a provider change validates every selected provider through the commands in .env, so they
  // point at the fakes: a machine without a real Codex or Claude CLI, CI included, must pass too.
  fs.writeFileSync(path.join(settingsRoot,".env"),`FACTORY_POLL_INTERVAL_MS=15000\nSLACK_WEBHOOK_URL='https://hooks.example.com/private'\nDEVELOPER_MODEL='custom-codex-model'\nCODEX_COMMAND='${fakeCodex}'\nCLAUDE_COMMAND='${fakeClaude}'\n`);
  fs.mkdirSync(path.join(settingsRoot,"scripts"));
  fs.writeFileSync(path.join(settingsRoot,"scripts","services.sh"),`#!/usr/bin/env bash
state="$PWD/daemon-service-state"
if [[ $1 == status ]]; then
  if [[ $2 == daemon && -f $state ]]; then printf 'daemon: loaded\\n  state = running\\n'; else echo "$2: stopped"; fi
  exit 0
fi
echo "$1 $2" >> "$PWD/service-actions.log"
if [[ $2 == daemon ]]; then
  if [[ $1 == stop ]]; then rm -f "$state"; fi
  if [[ $1 == start || $1 == restart ]]; then
    if [[ -f "$PWD/fail-next-daemon-start" ]]; then rm -f "$PWD/fail-next-daemon-start"; echo 'simulated daemon start failure' >&2; exit 1; fi
    touch "$state"
  fi
fi
`);
  fs.writeFileSync(path.join(settingsRoot,"daemon-service-state"),"");
  fs.writeFileSync(path.join(settingsRoot,"scripts","update.sh"),`#!/usr/bin/env bash
echo "$*" >> "$PWD/update-actions.log"
`);
  const serviceLogs=path.join(settingsRoot,"data","service-logs");
  fs.mkdirSync(serviceLogs,{recursive:true});
  fs.writeFileSync(path.join(serviceLogs,"daemon.log"),Array.from({length:80},(_,index)=>`output-line-${index}`).join("\n")+"\n");
  fs.writeFileSync(path.join(serviceLogs,"daemon.error.log"),"provider temporarily unavailable\nretry scheduled\n");
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context) VALUES(?,?,?,?,?,?)")
    .run("owner-demo-7",7,"owner/demo","2026-01-01T00:00:00.000Z","2026-01-02T00:00:00.000Z",JSON.stringify({title:"Repair login",url:"https://github.com/owner/demo/issues/7"}));
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context) VALUES(?,?,?,?,?,?)")
    .run("owner-demo-8",8,"owner/demo","2026-01-01T00:00:00.000Z","2026-01-02T00:00:00.000Z",JSON.stringify({title:"Closed manually",url:"https://github.com/owner/demo/issues/8"}));
  store.db.prepare("UPDATE work_items SET stage='TEST',status='FAILED' WHERE id='owner-demo-7'").run();
  store.db.prepare("UPDATE work_items SET stage='BUILD',status='CANCELLED',archived_at='2026-01-02T00:00:00.000Z' WHERE id='owner-demo-8'").run();
  store.event("github.issue_closed",{issue:8,visibility:"archived"},"owner-demo-8");
  store.event("workflow.transition",{from:{stage:"TEST",status:"RUNNING"},to:{stage:"TEST",status:"FAILED"},reason:{summary:"Tests failed"}},"owner-demo-7");
  store.event("agent.result",{role:"qa",result:{outcome:"pass",summary:"All acceptance criteria passed",coverage:Array(20).fill({status:"passed"})}},"owner-demo-7");
  store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at,finished_at,exit_code,input_tokens,output_tokens,cached_tokens,total_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("run-12345678","owner-demo-7","qa","TEST","succeeded","2026-01-02T00:00:00.000Z","2026-01-02T00:01:05.000Z",0,1000,250,500,1750);
  config.dataDir=path.join(settingsRoot,"runtime");fs.mkdirSync(path.join(config.dataDir,"runs","run-12345678"),{recursive:true});fs.writeFileSync(path.join(config.dataDir,"runs","run-12345678","prompt.md"),"sensitive prompt",{mode:0o600});
  store.event("execution.started",{role:"qa",selection:{provider:"claude",model:"sonnet"}},"owner-demo-7","run-12345678");
  store.event("execution.finished",{status:"succeeded",code:0,usage:{inputTokens:1000,outputTokens:250,cachedTokens:500,totalTokens:1750}},"owner-demo-7","run-12345678");
  store.event("command.applied",{commentId:5,login:"demo-user",command:"note",text:"Keep going",source:"dashboard"},"owner-demo-7");
  store.event("github.publish_failed",{issue:7,key:"github:status:owner-demo-7",kind:"status",attempts:1,error:"HTTP 502"},"owner-demo-7");
  const server = await startDashboard(store,"127.0.0.1",0,settingsRoot);
  const port = (server.address() as AddressInfo).port;
  const diagnostic=await fetch(`http://127.0.0.1:${port}/api/diagnosis`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operation:"Delivery",message:"RPC failed; HTTP 400"})});
  assert.equal(diagnostic.status,200);assert.match((await diagnostic.json() as any).summary,/transfer/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/issues/missing/diagnosis`)).status,404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/issues/owner-demo-7/diagnosis`)).status,409);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/diagnosis`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operation:"Delivery",message:{command:"push"}})})).status,400);
  const originalFetch = globalThis.fetch;
  let slackPayload: any;
  globalThis.fetch = ((input: URL | RequestInfo, init?: RequestInit) => {
    if (String(input) === "https://hooks.example.com/private") {
      slackPayload=JSON.parse(String(init?.body));
      return Promise.resolve(new Response("ok",{status:200}));
    }
    return originalFetch(input,init);
  }) as typeof fetch;
  try {
    // An idle installation can update without a running daemon.
    const planResponse=await fetch(`http://127.0.0.1:${port}/api/maintenance`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operation:"update"})});
    const plan=await planResponse.json() as {id:string};
    const prepared=await fetch(`http://127.0.0.1:${port}/api/maintenance/${plan.id}/confirm`,{method:"POST"});
    assert.equal(prepared.status,200);assert.equal((await prepared.json() as any).status,"ready");
    store.db.prepare("UPDATE maintenance_operations SET status='completed' WHERE id=?").run(plan.id);

    const envPath=path.join(settingsRoot,".env"),savedEnv=fs.readFileSync(envPath,"utf8"),savedRepo=config.repo;
    try{
      fs.writeFileSync(envPath,savedEnv+"\nGITHUB_REPOSITORY=owner/demo\n");config.repo="";
      assert.deepEqual(validateDashboardSettings(settingsRoot,{GITHUB_DEFAULT_BRANCH:"another-branch"}).restartServices.sort(),["daemon","dashboard"]);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/controller`)).status,404);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/controller`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"takeover"})})).status,405);
      const live=await fetch(`http://127.0.0.1:${port}/api/snapshot`).then(r=>r.json()) as any;assert.equal(live.repository,"owner/demo");assert.equal("controller" in live,false);
      fs.writeFileSync(envPath,savedEnv+"\nGITHUB_REPOSITORY=\n");config.repo="stale/repo";
      const absent=await fetch(`http://127.0.0.1:${port}/api/issues/remote`);assert.equal(absent.status,200);assert.deepEqual((await absent.json() as any).issues,[]);
    }finally{config.repo=savedRepo;fs.writeFileSync(envPath,savedEnv);}
    const html = await fetch(`http://127.0.0.1:${port}/`).then(response => response.text());
    assert.match(html,/AI Factory/);
    assert.match(html,/theme-toggle/);
    assert.match(html,/live-status/);
    assert.match(html,/factory-update/);
    assert.match(html,/daemon-logs-panel/);
    assert.match(html,/Copy visible logs/);
    assert.match(html,/Time and tokens by issue/);
    assert.match(html,/Configuration/);
    assert.match(html,/settings-navigation/);
    assert.match(html,/Add Issue/);
    assert.match(html,/Enter the number or URL of an open GitHub issue/);
    assert.match(html,/ACTION REQUIRED/);
    assert.match(html,/Complete the required setup/);
    assert.doesNotMatch(html,/daemon-stopped-banner|issue-refresh-status|The daemon is stopped/);
    assert.ok(html.indexOf('class="metrics"')<html.indexOf('Runtime controls'));
    assert.ok(html.indexOf('Runtime controls')<html.indexOf('Local issues'));
    assert.match(html,/<details class="panel settings-panel">/);
    assert.match(html,/<details class="panel usage-panel">/);
    assert.doesNotMatch(html,/Provider-reported token usage/);
    assert.doesNotMatch(html,/Dismiss guide/);
    assert.doesNotMatch(html,/Stop daemon/);
    const client = await fetch(`http://127.0.0.1:${port}/app.js`).then(response => response.text());
    assert.match(client,/pendingDashboardUrl/); assert.match(client,/location\.assign\(pendingDashboardUrl\)/); assert.match(client,/loadDaemonLogs/); assert.match(client,/execCommand\('copy'\)/); assert.match(client,/expandedUsageItems/); assert.match(client,/data-usage-item/); assert.match(client,/data-provider-choice/); assert.match(client,/codex:'openai'/);assert.match(client,/repositoryCard/);assert.match(client,/revealPrompt/);assert.match(client,/thread-prompt/);assert.match(client,/thread-result/);assert.match(client,/thread-event/);assert.match(client,/thread-human/);assert.match(client,/Approve specification/);assert.match(client,/Interrupt and retry with this/);assert.match(client,/not an authorized approver/);assert.match(client,/Rejected:/);assert.doesNotMatch(client,/panel\.open=true/);assert.doesNotMatch(client,/expandedUsageItems\.add\(data\.usage\[0\]/); assert.doesNotMatch(client,/function refreshIssue\(/);
    const styles = await fetch(`http://127.0.0.1:${port}/styles.css`).then(response => response.text());
    assert.match(styles,/@media\(max-width:650px\)/); assert.match(styles,/content:attr\(data-label\)/); assert.match(styles,/\.usage-card\[open\]/);assert.match(styles,/\.usage-panel>summary/); assert.match(styles,/\.provider-choice\[aria-pressed="true"\]/);
    for (const asset of ["github","git","openai","claude","slack"]) {
      const response = await fetch(`http://127.0.0.1:${port}/assets/brands/${asset}.svg`);
      assert.equal(response.status,200);
      assert.match(response.headers.get("content-type") ?? "",/image\/svg\+xml/);
      assert.match(await response.text(),/<svg/);
    }
    const daemonLogs = await fetch(`http://127.0.0.1:${port}/api/logs/daemon?lines=50`).then(response => response.json()) as any;
    assert.equal(daemonLogs.lines,50); assert.equal(daemonLogs.logs.length,2);
    assert.equal(daemonLogs.logs[0].path,"data/service-logs/daemon.log");
    assert.doesNotMatch(daemonLogs.logs[0].content,/output-line-29(?:\n|$)/); assert.match(daemonLogs.logs[0].content,/output-line-30/); assert.match(daemonLogs.logs[0].content,/output-line-79/);
    assert.equal(daemonLogs.logs[0].truncated,true); assert.match(daemonLogs.logs[1].content,/retry scheduled/);
    const snapshot = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then(response => response.json()) as any;
    assert.equal(snapshot.daemon.running,false);
    store.db.prepare("UPDATE work_items SET status='PAUSED' WHERE id='owner-demo-7'").run();
    store.db.prepare("INSERT INTO maintenance_operations(id,operation,actor,status,requested_at,confirmed_at,finished_at) VALUES('paused-maintenance','update','dashboard','completed','now','now','now')").run();
    store.db.prepare("INSERT INTO maintenance_items(maintenance_id,work_item_id,confirmed_revision,paused_at) VALUES('paused-maintenance','owner-demo-7',0,'now')").run();
    const resumeWhileStopped=await fetch(`http://127.0.0.1:${port}/api/maintenance/paused-maintenance/resume`,{method:"POST"});
    assert.equal(resumeWhileStopped.status,409);
    assert.deepEqual(await resumeWhileStopped.json(),{error:"Start the daemon before resuming paused tasks."});
    assert.equal((store.db.prepare("SELECT COUNT(*) count FROM controls WHERE kind='maintenance-resume'").get() as {count:number}).count,0);
    store.db.prepare("UPDATE work_items SET status='FAILED' WHERE id='owner-demo-7'").run();
    assert.equal(snapshot.items.length,1);
    assert.equal(snapshot.items[0].title,"Repair login");
    assert.deepEqual({stage:snapshot.items[0].stage,status:snapshot.items[0].status},{stage:"TEST",status:"FAILED"});
    assert.ok(snapshot.events.every((event:any)=>event.issue !== 8));
    assert.deepEqual({issue:snapshot.executions[0].issue,title:snapshot.executions[0].title,role:snapshot.executions[0].role,status:snapshot.executions[0].status,provider:snapshot.executions[0].provider,model:snapshot.executions[0].model,durationMs:snapshot.executions[0].durationMs,totalTokens:snapshot.executions[0].totalTokens},
      {issue:7,title:"Repair login",role:"qa",status:"succeeded",provider:"claude",model:"sonnet",durationMs:65000,totalTokens:1750});
    assert.deepEqual({issue:snapshot.usage[0].issue,runs:snapshot.usage[0].runs,durationMs:snapshot.usage[0].durationMs,totalTokens:snapshot.usage[0].totalTokens,stage:snapshot.usage[0].stages[0].state},
      {issue:7,runs:1,durationMs:65000,totalTokens:1750,stage:"TEST"});
    assert.deepEqual(snapshot.events.filter((event:any)=>/^(workflow\.|agent\.|execution\.|command\.|model\.)/.test(event.type)).map((event:any)=>event.type),[],"system activity leaves workflow progress to the issue conversation");
    const publishEvent=snapshot.events.find((event:any)=>event.type==="github.publish_failed");assert.equal(publishEvent.title,"GitHub publication delayed");assert.equal(publishEvent.issue,7);assert.equal(publishEvent.severity,"warning");
    const promptDenied=await fetch(`http://127.0.0.1:${port}/api/executions/run-12345678/prompt`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});assert.equal(promptDenied.status,400);const prompt=await fetch(`http://127.0.0.1:${port}/api/executions/run-12345678/prompt`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({acknowledgeSensitive:true})}).then(response=>response.json()) as any;assert.equal(prompt.prompt,"sensitive prompt");assert.match(prompt.warning,/Sensitive/);
    assert.equal(publishEvent.issueTitle,"Repair login"); assert.equal(publishEvent.issueUrl,"https://github.com/owner/demo/issues/7");
    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/api/stream`,{signal:controller.signal});
    assert.match(stream.headers.get("content-type") ?? "",/text\/event-stream/);
    const reader = stream.body!.getReader(), first = await reader.read();
    assert.match(new TextDecoder().decode(first.value),/"items":\[/);
    await reader.cancel(); controller.abort();
    const services = await fetch(`http://127.0.0.1:${port}/api/services`).then(response => response.json()) as any;
    assert.deepEqual(services.version,{number:"0.1.0",revision:"abc1234",branch:"main",display:"v0.1.0 · abc1234"});
    fs.writeFileSync(path.join(settingsRoot,"detached-head"),"");assert.equal(versionInfo(settingsRoot).branch,"detached");fs.rmSync(path.join(settingsRoot,"detached-head"));
    assert.deepEqual(services.services.map(({service,loaded,running}: any) => ({service,loaded,running})),[
      {service:"daemon",loaded:true,running:true},
      {service:"dashboard",loaded:false,running:false}
    ]);
    const restarted = await fetch(`http://127.0.0.1:${port}/api/services`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({service:"daemon",action:"restart"})});
    assert.equal(restarted.status,202);
    assert.match(fs.readFileSync(path.join(settingsRoot,"service-actions.log"),"utf8"),/restart daemon/);
    const perServiceUpdate = await fetch(`http://127.0.0.1:${port}/api/services`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({service:"daemon",action:"update"})});
    assert.equal(perServiceUpdate.status,400);
    store.db.exec("CREATE TABLE daemon_lock(id INTEGER PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL)");
    store.db.prepare("INSERT INTO daemon_lock VALUES(1,?,?)").run(process.pid,"dashboard-test");
    const refreshIssue = await fetch(`http://127.0.0.1:${port}/api/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"refresh",target:"owner-demo-7"})});
    assert.equal(refreshIssue.status,400);
    assert.equal(store.db.prepare("SELECT kind,target FROM controls WHERE kind='refresh'").get(),undefined);
    const refreshList = await fetch(`http://127.0.0.1:${port}/api/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"refresh-list"})});
    assert.equal(refreshList.status,202);
    const refreshControl = store.db.prepare("SELECT id FROM controls WHERE kind='refresh-list'").get() as { id:number };
    assert.ok(refreshControl);
    let refreshSnapshot = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then(response => response.json()) as any;
    assert.deepEqual(refreshSnapshot.issueRefresh,{status:"queued",message:"Waiting for the daemon to refresh GitHub issues…"});
    store.db.prepare("UPDATE controls SET handled=1 WHERE id=?").run(refreshControl.id);
    store.event("control.applied",{id:refreshControl.id,kind:"refresh-list",target:"",result:{found:2,added:1,updated:1}});
    refreshSnapshot = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then(response => response.json()) as any;
    assert.deepEqual(refreshSnapshot.issueRefresh,{status:"completed",message:"Found 2 factory issues; added 1, updated 1."});
    assert.equal(refreshSnapshot.events[0].title,"Issue list refresh completed");
    assert.equal(refreshSnapshot.events[0].details,"2 found · 1 added · 1 updated");
    const startIssue = await fetch(`http://127.0.0.1:${port}/api/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"start-issue",target:"#19"})});
    assert.equal(startIssue.status,202);
    assert.deepEqual(store.db.prepare("SELECT kind,target FROM controls WHERE kind='start-issue'").get(),{kind:"start-issue",target:"#19"});
    const claimIssue = await fetch(`http://127.0.0.1:${port}/api/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"claim-issue",target:"19"})});
    assert.equal(claimIssue.status,202);assert.deepEqual(store.db.prepare("SELECT kind,target FROM controls WHERE kind='claim-issue'").get(),{kind:"claim-issue",target:"19"});
    const continueIssue = await fetch(`http://127.0.0.1:${port}/api/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"continue-issue",target:"19"})});
    assert.equal(continueIssue.status,202);assert.deepEqual(store.db.prepare("SELECT kind,target FROM controls WHERE kind='continue-issue'").get(),{kind:"continue-issue",target:"19"});
    fs.mkdirSync(path.join(settingsRoot,"data"),{recursive:true});
    fs.writeFileSync(path.join(settingsRoot,"data","update-state.json"),JSON.stringify({status:"updating",phase:"stale",pid:process.pid,startedAt:"2026-01-01T00:00:00.000Z"}));
    const staleUpdate = await fetch(`http://127.0.0.1:${port}/api/services`).then(response => response.json()) as any;
    assert.equal(staleUpdate.update.status,"failed");
    assert.match(staleUpdate.update.phase,/stopped unexpectedly/);
    const checked = await fetch(`http://127.0.0.1:${port}/api/update/check`,{method:"POST"}).then(response => response.json()) as any;
    assert.equal(checked.available,true); assert.equal(checked.latest,"def5678");
    const updating = await fetch(`http://127.0.0.1:${port}/api/update`,{method:"POST"});
    assert.equal(updating.status,202);
    const updateResponse = await updating.json() as any;
    assert.equal(updateResponse.update.status,"updating");
    assert.equal(updateResponse.update.restoreDaemon,true);
    assert.equal(updateResponse.update.restoreDashboard,false);
    const duringUpdate = await fetch(`http://127.0.0.1:${port}/api/services`).then(response => response.json()) as any;
    assert.equal(duringUpdate.update.status,"updating");
    for (let attempt=0; attempt<60 && !fs.existsSync(path.join(settingsRoot,"update-actions.log")); attempt++) await new Promise(resolve => setTimeout(resolve,25));
    assert.match(fs.readFileSync(path.join(settingsRoot,"update-actions.log"),"utf8"),/--restart-services/);
    fs.writeFileSync(path.join(settingsRoot,"up-to-date"),"");
    const currentCheck = await fetch(`http://127.0.0.1:${port}/api/update/check`,{method:"POST"}).then(response => response.json()) as any;
    assert.equal(currentCheck.available,false);
    fs.writeFileSync(path.join(settingsRoot,"data","update-state.json"),JSON.stringify({status:"failed",phase:"Previous update failed"}));
    await fetch(`http://127.0.0.1:${port}/api/update/check`,{method:"POST"});
    assert.equal(JSON.parse(fs.readFileSync(path.join(settingsRoot,"data","update-state.json"),"utf8")).status,"idle");
    fs.writeFileSync(path.join(settingsRoot,"runtime-stale"),"");
    const activationCheck=await fetch(`http://127.0.0.1:${port}/api/update/check`,{method:"POST"}).then(response => response.json()) as any;
    assert.equal(activationCheck.available,true);assert.equal(activationCheck.runtimeStale,true);assert.match(activationCheck.message,/ready to activate/);
    fs.unlinkSync(path.join(settingsRoot,"runtime-stale"));
    const unnecessaryUpdate = await fetch(`http://127.0.0.1:${port}/api/update`,{method:"POST"});
    assert.equal(unnecessaryUpdate.status,409);
    const unknownService = await fetch(`http://127.0.0.1:${port}/api/services`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({service:"worker",action:"restart"})});
    assert.equal(unknownService.status,400);
    const settings = await fetch(`http://127.0.0.1:${port}/api/settings`).then(response => response.json()) as any;
    assert.equal(settings.readiness.ready,false);
    assert.ok(settings.readiness.missing.some((item: any) => item.id === "github-credential"));
    assert.ok(settings.readiness.missing.some((item: any) => item.id === "checkout"));
    assert.ok(settings.readiness.missing.some((item: any) => item.id === "repository"));
    assert.ok(settings.readiness.missing.some((item: any) => item.id === "approvers"));
    assert.deepEqual(settings.groups.map((group: any) => group.id),["connections","project","workflow","limits","agents","tools","service","advanced"]);
    assert.ok(settings.fields.every((field: any) => settings.groups.some((group: any) => group.id===field.group)));
    assert.ok(settings.fields.filter((field:any)=>field.group==="limits").every((field:any)=>field.scope),"Every limit states its scope");
    assert.equal(settings.fields.find((field:any)=>field.key==="FACTORY_ISSUE_BUDGET_TOKENS")?.scope,"Epic + stories · shared");
    assert.equal(settings.fields.find((field:any)=>field.key==="FACTORY_MAX_FIX_CYCLES")?.scope,"Each work item");
    assert.equal(settings.fields.find((field:any)=>field.key==="FACTORY_EXECUTION_TIMEOUT_MS")?.scope,"Each agent execution");
    for(const [key,value] of Object.entries({FACTORY_BRIEF_TARGET_CHARS:"4000",FACTORY_SPEC_TARGET_CHARS:"20000",FACTORY_SUMMARY_TARGET_CHARS:"600",FACTORY_MAX_QUESTIONS:"5",FACTORY_MAX_HUMAN_DECISIONS:"5",FACTORY_MAX_STORIES:"5",FACTORY_RESULT_MAX_ITEMS:"100",FACTORY_STRUCTURED_OUTPUT_RETRIES:"2",FACTORY_RECOVERABLE_ERROR_RETRIES:"1",FACTORY_TOKEN_BUDGET_GRACE_PERCENT:"25"})){
      const field=settings.fields.find((candidate:any)=>candidate.key===key);
      assert.equal(field?.group,"limits",key);assert.equal(field.value,value,key);
    }
    for(const key of ["FACTORY_MAX_FIX_CYCLES","FACTORY_ISSUE_BUDGET_TOKENS","FACTORY_BUDGET_UNMETERED_ROLES","FACTORY_EXECUTION_TIMEOUT_MS","FACTORY_VERIFY_TIMEOUT_MS","FACTORY_CONTEXT_BUDGET_BYTES","FACTORY_CONTEXT_BUDGET_OVERRIDES","FACTORY_ARTIFACT_RETENTION_DAYS"])
      assert.equal(settings.fields.find((field:any)=>field.key===key)?.group,"limits",key);
    assert.deepEqual(settings.fields.filter((field:any)=>field.setup).map((field:any)=>field.key).sort(),["AGENT_PROVIDER","FACTORY_APPROVERS","FACTORY_INSTANCE_NAME","FACTORY_REPO_DIR","GITHUB_REPOSITORY"]);
    const dashboardHost = settings.fields.find((field: any) => field.key === "FACTORY_DASHBOARD_HOST");
    assert.equal(dashboardHost.type,"select"); assert.deepEqual(dashboardHost.options.map((option: any) => option.value),["127.0.0.1","localhost","::1"]);
    const developerProvider = settings.fields.find((field: any) => field.key === "DEVELOPER_PROVIDER");
    assert.equal(developerProvider.group,"agents"); assert.equal(developerProvider.type,"select"); assert.deepEqual(developerProvider.options.map((option: any) => option.value),["codex","claude","cursor"]);
    assert.equal(developerProvider.description,"Provider used for the Implementation Engineer role.");
    assert.equal(settings.fields.find((field:any)=>field.key==="CODEX_COMMAND")?.group,"tools");
    assert.equal(settings.fields.find((field:any)=>field.key==="CURSOR_COMMAND")?.group,"tools");
    assert.equal(settings.modelCatalog.cursor.default,"auto");
    const developerModel = settings.fields.find((field: any) => field.key === "DEVELOPER_MODEL");
    assert.equal(developerModel.kind,"role-model"); assert.equal(developerModel.section,"Implementation Engineer");
    assert.equal(developerModel.value,"custom-codex-model");
    assert.ok(developerModel.options.some((option: any) => option.value === "auto"));
    assert.ok(developerModel.options.some((option: any) => option.value === "gpt-5.6-terra"));
    assert.equal(settings.modelCatalog.codex.default,"auto");
    assert.ok(settings.modelCatalog.codex.options.some((option: any) => option.value === "gpt-5.6-luna"));
    assert.equal(settings.fields.some((field: any) => field.key === "CODEX_MODEL_FAST"),false);
    const slackWebhook = settings.fields.find((field: any) => field.key === "SLACK_WEBHOOK_URL");
    assert.equal(slackWebhook.group,"connections"); assert.equal(slackWebhook.secret,true); assert.equal(slackWebhook.configured,true); assert.equal(slackWebhook.value,"");
    assert.ok(!JSON.stringify(settings).includes("private"));
    const slack = await fetch(`http://127.0.0.1:${port}/api/slack`).then(response => response.json()) as any;
    assert.deepEqual({configured:slack.configured,pending:slack.pending,failed:slack.failed,sent:slack.sent},{configured:true,pending:0,failed:0,sent:0});
    assert.ok(!JSON.stringify(slack).includes("private"));
    const slackSaved = await fetch(`http://127.0.0.1:${port}/api/slack`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({webhook:"",clear:false})});
    assert.equal(slackSaved.status,200);
    const slackTest = await fetch(`http://127.0.0.1:${port}/api/slack/test`,{method:"POST"});
    assert.equal(slackTest.status,200);
    assert.match(slackPayload.text,/Slack test notification from the dashboard/);
    assert.equal(slackPayload.blocks[0].type,"header");
    assert.equal(slackPayload.blocks[1].text.type,"mrkdwn");
    const credentials = await fetch(`http://127.0.0.1:${port}/api/credentials`).then(response => response.json()) as any;
    assert.deepEqual(credentials.credentials.map(({id,status}: any) => ({id,status})),[
      {id:"github",status:"disconnected"},{id:"claude",status:"connected"},{id:"codex",status:"connected"},{id:"cursor",status:"disconnected"}
    ]);
    assert.equal(credentials.credentials.find((item: any) => item.id === "cursor").installed,true);
    assert.equal(credentials.credentials.find((item: any) => item.id === "github").account,undefined);
    assert.equal(credentials.credentials.find((item: any) => item.id === "claude").account,"claude@example.com");
    assert.ok(!JSON.stringify(credentials).includes("token"));
    const login = await fetch(`http://127.0.0.1:${port}/api/credentials/connect`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"github"})});
    assert.equal(login.status,202);
    let connected: any;
    for (let attempt=0; attempt<60; attempt++) {
      connected = await fetch(`http://127.0.0.1:${port}/api/credentials`).then(response => response.json());
      if (connected.credentials.find((item: any) => item.id === "github").status === "connected") break;
      await new Promise(resolve => setTimeout(resolve,25));
    }
    assert.equal(connected.credentials.find((item: any) => item.id === "github").status,"connected");
    assert.equal(connected.credentials.find((item: any) => item.id === "github").account,"demo-user");
    const reconnect = await fetch(`http://127.0.0.1:${port}/api/credentials/connect`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"github"})});
    assert.equal(reconnect.status,202); assert.match(await reconnect.text(),/reauthentication/);
    for (let attempt=0; attempt<60 && !fs.existsSync(path.join(settingsRoot,"gh-refreshed")); attempt++) await new Promise(resolve => setTimeout(resolve,25));
    assert.ok(fs.existsSync(path.join(settingsRoot,"gh-refreshed")));
    const suggestedSettings = await fetch(`http://127.0.0.1:${port}/api/settings`).then(response => response.json()) as any;
    assert.equal(suggestedSettings.readiness.ready,false);
    assert.equal(suggestedSettings.readiness.missing.some((item: any) => item.id === "github-credential"),false);
    const suggestedValue = (key: string) => suggestedSettings.fields.find((field: any) => field.key === key);
    assert.deepEqual({value:suggestedValue("GITHUB_REPOSITORY").value,suggested:suggestedValue("GITHUB_REPOSITORY").suggested},{value:"demo-user/ai-factory-demo",suggested:true});
    assert.equal(suggestedValue("FACTORY_REPO_DIR").value,path.join(settingsRoot,"repos","ai-factory-demo"));
    assert.deepEqual({value:suggestedValue("FACTORY_APPROVERS").value,suggested:suggestedValue("FACTORY_APPROVERS").suggested},{value:"demo-user",suggested:true});
    const unknownCredential = await fetch(`http://127.0.0.1:${port}/api/credentials/connect`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"other"})});
    assert.equal(unknownCredential.status,400);
    // From here the launchd stub is authoritative. Avoid treating this test process as
    // the daemon process while saveConfiguration waits for the old daemon PID to exit.
    store.db.prepare("DELETE FROM daemon_lock").run();
    const serviceActionsBeforeProviderCheck=fs.readFileSync(path.join(settingsRoot,"service-actions.log"),"utf8");
    const cursorValidation=await fetch(`http://127.0.0.1:${port}/api/settings/validate`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({values:{DEVELOPER_PROVIDER:"cursor",CURSOR_COMMAND:fakeCursor}})});
    const cursorValidationResult=await cursorValidation.json() as any;
    assert.equal(cursorValidation.status,400,JSON.stringify(cursorValidationResult));assert.match(cursorValidationResult.error,/Cursor is not connected.*Connect in Connections/);
    const cursorSave=await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{DEVELOPER_PROVIDER:"cursor",CURSOR_COMMAND:fakeCursor}})});
    assert.equal(cursorSave.status,400);assert.match((await cursorSave.json() as any).error,/Cursor is not connected/);
    assert.equal(fs.readFileSync(path.join(settingsRoot,"service-actions.log"),"utf8"),serviceActionsBeforeProviderCheck,"a disconnected provider must not stop the daemon");
    const saved = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{FACTORY_POLL_INTERVAL_MS:"5000",FACTORY_MAX_QUESTIONS:"4",SLACK_WEBHOOK_URL:"",AGENT_PROVIDER:"claude",DEVELOPER_MODEL:"auto"}})});
    assert.equal(saved.status,200);
    const savedResult = await saved.json() as any;
    assert.deepEqual(savedResult.restartedServices,["daemon"]);
    assert.match(savedResult.message,/Daemon restarted and verified/);
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^FACTORY_POLL_INTERVAL_MS='5000'$/m);
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^FACTORY_MAX_QUESTIONS='4'$/m);
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^SLACK_WEBHOOK_URL='https:\/\/hooks\.example\.com\/private'$/m);
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^DEVELOPER_PROVIDER='claude'$/m);
    for(const key of["PRODUCT_ARCHITECT_PROVIDER","QA_PROVIDER","REVIEWER_PROVIDER"])assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),new RegExp(`^${key}='claude'$`,`m`));
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^DEVELOPER_MODEL='auto'$/m);
    assert.ok(fs.readdirSync(settingsRoot).some(file => file.startsWith(".env.backup-")));
    const serviceActionsBeforeInvalid = fs.readFileSync(path.join(settingsRoot,"service-actions.log"),"utf8");
    const invalid = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{FACTORY_DASHBOARD_PORT:"70000"}})});
    assert.equal(invalid.status,400);
    assert.match(await invalid.text(),/port from 1 to 65535/);
    assert.equal(fs.readFileSync(path.join(settingsRoot,"service-actions.log"),"utf8"),serviceActionsBeforeInvalid);
    const invalidProvider = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{QA_PROVIDER:"unknown"}})});
    assert.equal(invalidProvider.status,400);
    assert.match(await invalidProvider.text(),/choose codex, claude or cursor/);
    const appliedWhileRunning = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{FACTORY_POLL_INTERVAL_MS:"6000"}})});
    assert.equal(appliedWhileRunning.status,200);
    assert.deepEqual((await appliedWhileRunning.json() as any).restartedServices,["daemon"]);
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^FACTORY_POLL_INTERVAL_MS='6000'$/m);
    const appliedSlackWhileRunning = await fetch(`http://127.0.0.1:${port}/api/slack`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({webhook:"",clear:true})});
    assert.equal(appliedSlackWhileRunning.status,200);
    assert.equal((await appliedSlackWhileRunning.json() as any).configured,false);
    assert.match(fs.readFileSync(path.join(settingsRoot,"service-actions.log"),"utf8"),/stop daemon[\s\S]*start daemon/);
    assert.ok(fs.existsSync(path.join(settingsRoot,"daemon-service-state")));
    const beforeFailedRestart=fs.readFileSync(path.join(settingsRoot,".env"),"utf8");
    fs.writeFileSync(path.join(settingsRoot,"fail-next-daemon-start"),"");
    const failedRestart = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{FACTORY_POLL_INTERVAL_MS:"7000"}})});
    assert.equal(failedRestart.status,400);
    assert.match(await failedRestart.text(),/Configuration was rolled back/);
    assert.equal(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),beforeFailedRestart);
    assert.ok(fs.existsSync(path.join(settingsRoot,"daemon-service-state")));
    store.db.prepare("DELETE FROM daemon_lock").run();
    const statuses=["COMPLETED","QUEUED","RUNNING","PAUSED","FAILED","WAITING","CANCELLED","WAITING"];
    statuses.forEach((status,index)=>store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,status) VALUES(?,?,?,'now',?,'{}',?)").run(`order-${index}`,100+index,"owner/demo",`2026-09-21T12:00:0${index}Z`,status));
    const ordered=await fetch(`http://127.0.0.1:${port}/api/snapshot`).then(response=>response.json()) as any;
    assert.deepEqual(ordered.items.filter((item:any)=>item.id.startsWith("order-")).map((item:any)=>item.id),["order-7","order-5","order-4","order-3","order-2","order-1","order-6","order-0"]);
    store.db.prepare("DELETE FROM work_items WHERE id LIKE 'order-%'").run();
    const stoppedRefresh = await fetch(`http://127.0.0.1:${port}/api/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"refresh-list"})});
    const stoppedRetry=await fetch(`http://127.0.0.1:${port}/api/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"retry"})});
    assert.equal(stoppedRetry.status,409);assert.deepEqual(await stoppedRetry.json(),{error:"Start the daemon before sending controls."});
    assert.equal(stoppedRefresh.status,409); assert.match(await stoppedRefresh.text(),/Start the daemon/);
    const actionsBeforeStoppedDashboardChange = fs.readFileSync(path.join(settingsRoot,"service-actions.log"),"utf8");
    const changedStoppedDashboard = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{FACTORY_DASHBOARD_PORT:"4174"}})});
    assert.equal(changedStoppedDashboard.status,200);
    assert.equal((await changedStoppedDashboard.json() as any).dashboardRestarting,false);
    assert.equal(fs.readFileSync(path.join(settingsRoot,"service-actions.log"),"utf8"),actionsBeforeStoppedDashboardChange);
    store.db.prepare("INSERT INTO daemon_lock VALUES(1,?,?)").run(process.pid,"dashboard-controls-test");
    const workControl=(kind:string)=>fetch(`http://127.0.0.1:${port}/api/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind,target:"owner-demo-7"})});
    assert.equal((await workControl("pause")).status,409);
    store.db.prepare("UPDATE work_items SET status='QUEUED' WHERE id='owner-demo-7'").run();
    assert.equal((await workControl("pause")).status,202);
    assert.equal((await workControl("resume")).status,409);
    store.db.prepare("UPDATE work_items SET status='PAUSED' WHERE id='owner-demo-7'").run();
    assert.equal((await workControl("resume")).status,202);
    assert.equal((await workControl("retry")).status,409);
    store.db.prepare("UPDATE work_items SET status='FAILED' WHERE id='owner-demo-7'").run();
    const response = await fetch(`http://127.0.0.1:${port}/api/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"retry",target:"owner-demo-7"})});
    assert.equal(response.status,202);
    assert.deepEqual(store.db.prepare("SELECT kind,target FROM controls WHERE kind='retry'").get(),{kind:"retry",target:"owner-demo-7"});
    store.db.prepare("UPDATE work_items SET stage='DESIGN',status='WAITING' WHERE id='owner-demo-7'").run();
    store.db.prepare("INSERT INTO records(id,work_item_id,sequence,kind,spec_version,scope,status,payload,source_type,source_id,actor,created_at,updated_at) VALUES('approval','owner-demo-7',1,'request',1,'spec','open',?,'orchestrator','request','orchestrator','now','now')").run(JSON.stringify({kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["DESIGN"],openedAfterCommentId:1}));
    const thread=await fetch(`http://127.0.0.1:${port}/api/issues/owner-demo-7/thread`).then(result=>result.json()) as any;assert.deepEqual(thread.actions,["approve","answer"]);assert.equal(thread.operator.approver,true);assert.equal(typeof thread.publication.revision,"number");assert.equal(typeof thread.publication.behind,"boolean");assert.equal(typeof thread.sync.daemonRunning,"boolean");assert.deepEqual([...new Set(thread.turns.map((turn:any)=>turn.kind))].sort(),["event","execution","human"].sort(),"the command left out of system activity is in the conversation");const execution=thread.turns.find((turn:any)=>turn.kind==="execution");assert.equal(execution.durationMs,65_000);assert.equal(execution.status,"succeeded");
    store.setMetadata("runtime:factory-account","viewer");const controlsBefore=(store.db.prepare("SELECT COUNT(*) count FROM controls").get() as {count:number}).count;const deniedMessage=await fetch(`http://127.0.0.1:${port}/api/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"message",target:"owner-demo-7",text:"approve",action:"approve"})});assert.equal(deniedMessage.status,403);assert.equal((store.db.prepare("SELECT COUNT(*) count FROM controls").get() as {count:number}).count,controlsBefore);store.setMetadata("runtime:factory-account","demo-user");
    const failedTarget=JSON.stringify({workItemId:"owner-demo-7",text:"stale",action:"approve"}),failedControl=store.request("message",failedTarget);store.db.prepare("UPDATE controls SET handled=1 WHERE id=?").run(failedControl);store.event("control.failed",{id:failedControl,kind:"message",target:failedTarget,error:"Command is stale"});const failedSnapshot=await fetch(`http://127.0.0.1:${port}/api/snapshot`).then(result=>result.json()) as any;assert.equal(failedSnapshot.items[0].control.error,"Command is stale");assert.equal(failedSnapshot.items[0].lastEventId,(store.db.prepare("SELECT MAX(id) id FROM events WHERE work_item_id='owner-demo-7'").get() as {id:number}).id);
    store.db.prepare("DELETE FROM records WHERE id='approval'").run();store.db.prepare("UPDATE work_items SET stage='TEST',status='FAILED' WHERE id='owner-demo-7'").run();
    store.db.prepare("DELETE FROM daemon_lock").run();
    fs.rmSync(path.join(settingsRoot,"daemon-service-state"),{force:true});
    fs.writeFileSync(path.join(settingsRoot,"fail-next-daemon-start"),"");
    const failedFirstSetupSave = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({
      startDaemonWhenReady:true,
      values:{GITHUB_REPOSITORY:"owner/demo",GITHUB_DEFAULT_BRANCH:"wrong",FACTORY_REPO_DIR:settingsRoot,FACTORY_APPROVERS:"demo-user",GIT_COMMAND:fakeGit,FACTORY_POLL_INTERVAL_MS:"8000"},
    })});
    assert.equal(failedFirstSetupSave.status,200);
    const failedFirstSetupResult=await failedFirstSetupSave.json() as any;
    assert.match(failedFirstSetupResult.daemonStartError,/simulated daemon start failure/);
    assert.deepEqual(failedFirstSetupResult.startedServices,[]);
    assert.match(failedFirstSetupResult.message,/Configuration saved\. The daemon did not start: simulated daemon start failure\. Fix the cause and start it from the Services panel\./);
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^FACTORY_POLL_INTERVAL_MS='8000'$/m);
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^GITHUB_DEFAULT_BRANCH='main'$/m);
    assert.equal(fs.existsSync(path.join(settingsRoot,"daemon-service-state")),false);
    const firstSetupSave = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({
      startDaemonWhenReady:true,
      values:{GITHUB_REPOSITORY:"owner/demo",FACTORY_REPO_DIR:path.join(settingsRoot,"missing-checkout"),FACTORY_APPROVERS:"demo-user",GIT_COMMAND:fakeGit},
    })});
    assert.equal(firstSetupSave.status,200);
    const firstSetupResult=await firstSetupSave.json() as any;
    assert.deepEqual(firstSetupResult.startedServices,["daemon"]);
    assert.equal(firstSetupResult.readiness.ready,true);
    assert.equal(fs.existsSync(path.join(settingsRoot,"missing-checkout")),false,"readiness checks do not mutate the checkout");
    assert.match(firstSetupResult.message,/Daemon started and verified/);
    assert.ok(fs.existsSync(path.join(settingsRoot,"daemon-service-state")));
  } finally {
    globalThis.fetch=originalFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.db.close();
    config.gitCommand=previousGit;config.dataDir=previousDataDir;config.approvers.splice(0,config.approvers.length,...previousApprovers);
    config.codexCommand=previousCodex; config.claudeCommand=previousClaude; config.cursorCommand=previousCursor;
    if (previousGh === undefined) delete process.env.GH_COMMAND; else process.env.GH_COMMAND=previousGh;
    if (previousFactoryHome === undefined) delete process.env.AI_FACTORY_HOME; else process.env.AI_FACTORY_HOME=previousFactoryHome;
    fs.rmSync(settingsRoot,{recursive:true,force:true});
  }
});

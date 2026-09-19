import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage.js";
import { startDashboard } from "../src/dashboard.js";
import { config } from "../src/config.js";

test("dashboard serves readable state and queues daemon controls", async () => {
  const store = new Store(":memory:");
  const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(),"factory-dashboard-settings-"));
  const previousGit = config.gitCommand;
  const previousCodex = config.codexCommand, previousClaude = config.claudeCommand, previousGh = process.env.GH_COMMAND;
  const fakeGit = path.join(settingsRoot,"git");
  fs.writeFileSync(fakeGit,`#!/usr/bin/env bash
case "$*" in
  "rev-parse --short HEAD") echo abc1234;;
  "symbolic-ref --quiet --short HEAD") echo main;;
  "rev-parse HEAD") echo abc1234abc1234abc1234abc1234abc1234abc1;;
  "fetch origin refs/heads/main") ;;
  "rev-parse FETCH_HEAD") if [[ -f "$PWD/up-to-date" ]]; then echo abc1234abc1234abc1234abc1234abc1234abc1; else echo def5678def5678def5678def5678def5678def5; fi;;
  "rev-parse --short FETCH_HEAD") if [[ -f "$PWD/up-to-date" ]]; then echo abc1234; else echo def5678; fi;;
  "merge-base --is-ancestor abc1234abc1234abc1234abc1234abc1234abc1 def5678def5678def5678def5678def5678def5") ;;
  *) echo "unexpected git args: $*" >&2; exit 1;;
esac
`,{mode:0o755});
  config.gitCommand=fakeGit;
  const fakeGh = path.join(settingsRoot,"gh"), fakeCodex = path.join(settingsRoot,"codex"), fakeClaude = path.join(settingsRoot,"claude");
  fs.writeFileSync(fakeGh,`#!/usr/bin/env bash
if [[ $1 == auth && $2 == status ]]; then [[ -f "$PWD/gh-authenticated" ]]; exit; fi
if [[ $1 == auth && $2 == login ]]; then touch "$PWD/gh-authenticated"; exit; fi
if [[ $1 == auth && $2 == refresh ]]; then touch "$PWD/gh-refreshed"; exit; fi
if [[ $1 == auth && $2 == setup-git ]]; then exit; fi
if [[ $1 == api && $2 == user ]]; then echo demo-user; exit; fi
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
  config.codexCommand=fakeCodex; config.claudeCommand=fakeClaude; process.env.GH_COMMAND=fakeGh;
  fs.writeFileSync(path.join(settingsRoot,"package.json"),JSON.stringify({version:"0.1.0"}));
  fs.copyFileSync(".env.example",path.join(settingsRoot,".env.example"));
  fs.writeFileSync(path.join(settingsRoot,".env"),"FACTORY_POLL_INTERVAL_MS=15000\nSLACK_WEBHOOK_URL='https://hooks.example.com/private'\nDEVELOPER_MODEL_MODE='manual'\nDEVELOPER_MODEL_BALANCED='custom-codex-model'\nCODEX_MODEL_FAST='retired-model'\n");
  fs.mkdirSync(path.join(settingsRoot,"scripts"));
  fs.writeFileSync(path.join(settingsRoot,"scripts","services.sh"),`#!/usr/bin/env bash
if [[ $1 == status ]]; then
  if [[ $2 == daemon ]]; then printf 'daemon: loaded\\n  state = running\\n'; else echo 'dashboard: stopped'; fi
else
  echo "$1 $2" >> "$PWD/service-actions.log"
fi
`);
  fs.writeFileSync(path.join(settingsRoot,"scripts","update.sh"),`#!/usr/bin/env bash
echo "$*" >> "$PWD/update-actions.log"
`);
  const serviceLogs=path.join(settingsRoot,".factory","service-logs");
  fs.mkdirSync(serviceLogs,{recursive:true});
  fs.writeFileSync(path.join(serviceLogs,"daemon.log"),Array.from({length:80},(_,index)=>`output-line-${index}`).join("\n")+"\n");
  fs.writeFileSync(path.join(serviceLogs,"daemon.error.log"),"provider temporarily unavailable\nretry scheduled\n");
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,created_at,updated_at,context) VALUES(?,?,?,?,?,?,?)")
    .run("owner-demo-7",7,"owner/demo","FAILED","2026-01-01T00:00:00.000Z","2026-01-02T00:00:00.000Z",JSON.stringify({title:"Repair login",url:"https://github.com/owner/demo/issues/7",version:1,cursor:0,feedback:[],cycles:0,reports:{}}));
  store.event("state.changed",{from:"QA",to:"FAILED"},"owner-demo-7");
  store.event("agent.result",{role:"qa",result:{outcome:"pass",summary:"All acceptance criteria passed",coverage:Array(20).fill({})}},"owner-demo-7");
  const server = await startDashboard(store,"127.0.0.1",0,settingsRoot);
  const port = (server.address() as AddressInfo).port;
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
    const html = await fetch(`http://127.0.0.1:${port}/`).then(response => response.text());
    assert.match(html,/AI Factory/);
    assert.match(html,/theme-toggle/);
    assert.match(html,/live-status/);
    assert.match(html,/factory-update/);
    assert.match(html,/daemon-logs-panel/);
    assert.match(html,/Configuration/);
    assert.match(html,/settings-navigation/);
    assert.match(html,/ACTION REQUIRED/);
    assert.match(html,/Complete the required setup/);
    assert.doesNotMatch(html,/Dismiss guide/);
    assert.doesNotMatch(html,/Stop daemon/);
    const client = await fetch(`http://127.0.0.1:${port}/app.js`).then(response => response.text());
    assert.match(client,/pendingDashboardUrl/); assert.match(client,/location\.assign\(pendingDashboardUrl\)/); assert.match(client,/loadDaemonLogs/);
    const daemonLogs = await fetch(`http://127.0.0.1:${port}/api/logs/daemon?lines=50`).then(response => response.json()) as any;
    assert.equal(daemonLogs.lines,50); assert.equal(daemonLogs.logs.length,2);
    assert.equal(daemonLogs.logs[0].path,".factory/service-logs/daemon.log");
    assert.doesNotMatch(daemonLogs.logs[0].content,/output-line-29(?:\n|$)/); assert.match(daemonLogs.logs[0].content,/output-line-30/); assert.match(daemonLogs.logs[0].content,/output-line-79/);
    assert.equal(daemonLogs.logs[0].truncated,true); assert.match(daemonLogs.logs[1].content,/retry scheduled/);
    const snapshot = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then(response => response.json()) as any;
    assert.equal(snapshot.daemon.running,false);
    assert.equal(snapshot.items[0].title,"Repair login");
    assert.match(snapshot.events[0].details,/outcome: pass · All acceptance criteria passed/);
    assert.ok(snapshot.events[0].details.length < 421);
    assert.match(snapshot.events[1].details,/from: QA/);
    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/api/stream`,{signal:controller.signal});
    assert.match(stream.headers.get("content-type") ?? "",/text\/event-stream/);
    const reader = stream.body!.getReader(), first = await reader.read();
    assert.match(new TextDecoder().decode(first.value),/"items":\[/);
    await reader.cancel(); controller.abort();
    const services = await fetch(`http://127.0.0.1:${port}/api/services`).then(response => response.json()) as any;
    assert.deepEqual(services.version,{number:"0.1.0",revision:"abc1234",branch:"main",display:"v0.1.0 · abc1234"});
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
    assert.equal(refreshIssue.status,202);
    assert.equal((store.db.prepare("SELECT kind,target FROM controls WHERE kind='refresh'").get() as any).target,"owner-demo-7");
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
    assert.equal(refreshSnapshot.events[0].details,"Issue list refreshed: 2 found, 1 added, 1 updated.");
    store.event("github.issue_refreshed",{previousCursor:99,cursor:99,latestCommentId:50,state:"FAILED"},"owner-demo-7");
    refreshSnapshot = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then(response => response.json()) as any;
    assert.equal(refreshSnapshot.events[0].details,"GitHub issue refreshed; no newer comment was found and workflow remains failed.");
    fs.mkdirSync(path.join(settingsRoot,".factory"),{recursive:true});
    fs.writeFileSync(path.join(settingsRoot,".factory","update-state.json"),JSON.stringify({status:"updating",phase:"stale",pid:process.pid,startedAt:"2026-01-01T00:00:00.000Z"}));
    const staleUpdate = await fetch(`http://127.0.0.1:${port}/api/services`).then(response => response.json()) as any;
    assert.equal(staleUpdate.update.status,"failed");
    assert.match(staleUpdate.update.phase,/stopped unexpectedly/);
    const checked = await fetch(`http://127.0.0.1:${port}/api/update/check`,{method:"POST"}).then(response => response.json()) as any;
    assert.equal(checked.available,true); assert.equal(checked.latest,"def5678");
    const updating = await fetch(`http://127.0.0.1:${port}/api/update`,{method:"POST"});
    assert.equal(updating.status,202);
    const updateResponse = await updating.json() as any;
    assert.equal(updateResponse.update.status,"updating");
    const duringUpdate = await fetch(`http://127.0.0.1:${port}/api/services`).then(response => response.json()) as any;
    assert.equal(duringUpdate.update.status,"updating");
    for (let attempt=0; attempt<60 && !fs.existsSync(path.join(settingsRoot,"update-actions.log")); attempt++) await new Promise(resolve => setTimeout(resolve,25));
    assert.match(fs.readFileSync(path.join(settingsRoot,"update-actions.log"),"utf8"),/--restart-services/);
    fs.writeFileSync(path.join(settingsRoot,"up-to-date"),"");
    const currentCheck = await fetch(`http://127.0.0.1:${port}/api/update/check`,{method:"POST"}).then(response => response.json()) as any;
    assert.equal(currentCheck.available,false);
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
    assert.deepEqual(settings.groups.map((group: any) => group.id),["credentials","project","runtime","dashboard","models","tools","access","notifications"]);
    const dashboardHost = settings.fields.find((field: any) => field.key === "FACTORY_DASHBOARD_HOST");
    assert.equal(dashboardHost.type,"select"); assert.deepEqual(dashboardHost.options.map((option: any) => option.value),["127.0.0.1","localhost","::1"]);
    const developerProvider = settings.fields.find((field: any) => field.key === "DEVELOPER_PROVIDER");
    assert.equal(developerProvider.group,"models"); assert.equal(developerProvider.type,"select"); assert.deepEqual(developerProvider.options.map((option: any) => option.value),["codex","claude"]);
    const developerModel = settings.fields.find((field: any) => field.key === "DEVELOPER_MODEL");
    assert.equal(developerModel.kind,"role-model"); assert.equal(developerModel.section,"Developer");
    assert.equal(developerModel.value,"custom-codex-model");
    assert.ok(developerModel.options.some((option: any) => option.value === "auto"));
    assert.ok(developerModel.options.some((option: any) => option.value === "gpt-5.6-terra"));
    assert.equal(settings.modelCatalog.codex.default,"gpt-5.6-terra");
    assert.ok(settings.modelCatalog.codex.options.some((option: any) => option.value === "gpt-5.6-luna"));
    assert.equal(settings.fields.some((field: any) => field.key === "CODEX_MODEL_FAST"),false);
    const slackWebhook = settings.fields.find((field: any) => field.key === "SLACK_WEBHOOK_URL");
    assert.equal(slackWebhook.group,"notifications"); assert.equal(slackWebhook.secret,true); assert.equal(slackWebhook.configured,true); assert.equal(slackWebhook.value,"");
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
      {id:"github",status:"disconnected"},{id:"claude",status:"connected"},{id:"codex",status:"connected"}
    ]);
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
    assert.deepEqual({value:suggestedValue("FACTORY_REPO_DIR").value,suggested:suggestedValue("FACTORY_REPO_DIR").suggested},{value:path.join(os.homedir(),"Source","ai-factory-demo"),suggested:true});
    assert.deepEqual({value:suggestedValue("FACTORY_APPROVERS").value,suggested:suggestedValue("FACTORY_APPROVERS").suggested},{value:"demo-user",suggested:true});
    const unknownCredential = await fetch(`http://127.0.0.1:${port}/api/credentials/connect`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"other"})});
    assert.equal(unknownCredential.status,400);
    const saved = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{FACTORY_POLL_INTERVAL_MS:"5000",SLACK_WEBHOOK_URL:"",DEVELOPER_PROVIDER:"claude",DEVELOPER_MODEL:"auto"}})});
    assert.equal(saved.status,200);
    const savedResult = await saved.json() as any;
    assert.deepEqual(savedResult.restartedServices,["daemon"]);
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^FACTORY_POLL_INTERVAL_MS='5000'$/m);
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^SLACK_WEBHOOK_URL='https:\/\/hooks\.example\.com\/private'$/m);
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^DEVELOPER_PROVIDER='claude'$/m);
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^DEVELOPER_MODEL='auto'$/m);
    assert.doesNotMatch(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/DEVELOPER_MODEL_(MODE|BALANCED)|CODEX_MODEL_FAST/);
    assert.ok(fs.readdirSync(settingsRoot).some(file => file.startsWith(".env.backup-")));
    const serviceActionsBeforeInvalid = fs.readFileSync(path.join(settingsRoot,"service-actions.log"),"utf8");
    const invalid = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{FACTORY_DASHBOARD_PORT:"70000"}})});
    assert.equal(invalid.status,400);
    assert.match(await invalid.text(),/port from 1 to 65535/);
    assert.equal(fs.readFileSync(path.join(settingsRoot,"service-actions.log"),"utf8"),serviceActionsBeforeInvalid);
    const invalidProvider = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{QA_PROVIDER:"unknown"}})});
    assert.equal(invalidProvider.status,400);
    assert.match(await invalidProvider.text(),/choose codex or claude/);
    const appliedWhileRunning = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{FACTORY_POLL_INTERVAL_MS:"6000"}})});
    assert.equal(appliedWhileRunning.status,200);
    assert.deepEqual((await appliedWhileRunning.json() as any).restartedServices,["daemon"]);
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^FACTORY_POLL_INTERVAL_MS='6000'$/m);
    const appliedSlackWhileRunning = await fetch(`http://127.0.0.1:${port}/api/slack`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({webhook:"",clear:true})});
    assert.equal(appliedSlackWhileRunning.status,200);
    assert.equal((await appliedSlackWhileRunning.json() as any).configured,false);
    assert.match(fs.readFileSync(path.join(settingsRoot,"service-actions.log"),"utf8"),/stop daemon[\s\S]*start daemon/);
    store.db.prepare("DELETE FROM daemon_lock").run();
    const stoppedRefresh = await fetch(`http://127.0.0.1:${port}/api/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"refresh-list"})});
    assert.equal(stoppedRefresh.status,409); assert.match(await stoppedRefresh.text(),/Start the daemon/);
    const actionsBeforeStoppedDashboardChange = fs.readFileSync(path.join(settingsRoot,"service-actions.log"),"utf8");
    const changedStoppedDashboard = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{FACTORY_DASHBOARD_PORT:"4174"}})});
    assert.equal(changedStoppedDashboard.status,200);
    assert.equal((await changedStoppedDashboard.json() as any).dashboardRestarting,false);
    assert.equal(fs.readFileSync(path.join(settingsRoot,"service-actions.log"),"utf8"),actionsBeforeStoppedDashboardChange);
    const response = await fetch(`http://127.0.0.1:${port}/api/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"retry",target:"owner-demo-7"})});
    assert.equal(response.status,202);
    assert.deepEqual(store.db.prepare("SELECT kind,target FROM controls WHERE kind='retry'").get(),{kind:"retry",target:"owner-demo-7"});
  } finally {
    globalThis.fetch=originalFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.db.close();
    config.gitCommand=previousGit;
    config.codexCommand=previousCodex; config.claudeCommand=previousClaude;
    if (previousGh === undefined) delete process.env.GH_COMMAND; else process.env.GH_COMMAND=previousGh;
    fs.rmSync(settingsRoot,{recursive:true,force:true});
  }
});

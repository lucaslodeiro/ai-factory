import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage.js";
import { startDashboard } from "../src/dashboard.js";

test("dashboard serves readable state and queues daemon controls", async () => {
  const store = new Store(":memory:");
  const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(),"factory-dashboard-settings-"));
  fs.copyFileSync(".env.example",path.join(settingsRoot,".env.example"));
  fs.writeFileSync(path.join(settingsRoot,".env"),"FACTORY_POLL_INTERVAL_MS=15000\nSLACK_WEBHOOK_URL='https://hooks.example.com/private'\n");
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
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,created_at,updated_at,context) VALUES(?,?,?,?,?,?,?)")
    .run("owner-demo-7",7,"owner/demo","FAILED","2026-01-01T00:00:00.000Z","2026-01-02T00:00:00.000Z",JSON.stringify({title:"Repair login",url:"https://github.com/owner/demo/issues/7",version:1,cursor:0,feedback:[],cycles:0,reports:{}}));
  store.event("state.changed",{from:"QA",to:"FAILED"},"owner-demo-7");
  store.event("agent.result",{role:"qa",result:{outcome:"pass",summary:"All acceptance criteria passed",coverage:Array(20).fill({})}},"owner-demo-7");
  const server = await startDashboard(store,"127.0.0.1",0,settingsRoot);
  const port = (server.address() as AddressInfo).port;
  try {
    const html = await fetch(`http://127.0.0.1:${port}/`).then(response => response.text());
    assert.match(html,/AI Factory/);
    assert.match(html,/theme-toggle/);
    assert.match(html,/live-status/);
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
    assert.deepEqual(services.services.map(({service,loaded,running}: any) => ({service,loaded,running})),[
      {service:"daemon",loaded:true,running:true},
      {service:"dashboard",loaded:false,running:false}
    ]);
    const restarted = await fetch(`http://127.0.0.1:${port}/api/services`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({service:"daemon",action:"restart"})});
    assert.equal(restarted.status,202);
    assert.match(fs.readFileSync(path.join(settingsRoot,"service-actions.log"),"utf8"),/restart daemon/);
    const updating = await fetch(`http://127.0.0.1:${port}/api/services`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({service:"daemon",action:"update"})});
    assert.equal(updating.status,202);
    for (let attempt=0; attempt<60 && !fs.existsSync(path.join(settingsRoot,"update-actions.log")); attempt++) await new Promise(resolve => setTimeout(resolve,25));
    assert.match(fs.readFileSync(path.join(settingsRoot,"update-actions.log"),"utf8"),/--defaults --restart-services/);
    const unknownService = await fetch(`http://127.0.0.1:${port}/api/services`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({service:"worker",action:"restart"})});
    assert.equal(unknownService.status,400);
    const settings = await fetch(`http://127.0.0.1:${port}/api/settings`).then(response => response.json()) as any;
    assert.equal(settings.fields.find((field: any) => field.key === "SLACK_WEBHOOK_URL").value,"");
    assert.equal(settings.fields.find((field: any) => field.key === "SLACK_WEBHOOK_URL").configured,true);
    assert.ok(!JSON.stringify(settings).includes("private"));
    const saved = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{FACTORY_POLL_INTERVAL_MS:"5000",SLACK_WEBHOOK_URL:""}})});
    assert.equal(saved.status,200);
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^FACTORY_POLL_INTERVAL_MS='5000'$/m);
    assert.match(fs.readFileSync(path.join(settingsRoot,".env"),"utf8"),/^SLACK_WEBHOOK_URL='https:\/\/hooks\.example\.com\/private'$/m);
    assert.ok(fs.readdirSync(settingsRoot).some(file => file.startsWith(".env.backup-")));
    const invalid = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{FACTORY_DASHBOARD_PORT:"70000"}})});
    assert.equal(invalid.status,400);
    assert.match(await invalid.text(),/port from 1 to 65535/);
    store.db.exec("CREATE TABLE daemon_lock(id INTEGER PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL)");
    store.db.prepare("INSERT INTO daemon_lock VALUES(1,?,?)").run(process.pid,"dashboard-test");
    const blocked = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({values:{FACTORY_POLL_INTERVAL_MS:"6000"}})});
    assert.equal(blocked.status,409);
    store.db.prepare("DELETE FROM daemon_lock").run();
    const response = await fetch(`http://127.0.0.1:${port}/api/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"retry",target:"owner-demo-7"})});
    assert.equal(response.status,202);
    assert.deepEqual(store.db.prepare("SELECT kind,target FROM controls").get(),{kind:"retry",target:"owner-demo-7"});
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.db.close();
    fs.rmSync(settingsRoot,{recursive:true,force:true});
  }
});

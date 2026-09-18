import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/storage.js";
import { startDashboard } from "../src/dashboard.js";

test("dashboard serves readable state and queues daemon controls", async () => {
  const store = new Store(":memory:");
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,state,created_at,updated_at,context) VALUES(?,?,?,?,?,?,?)")
    .run("owner-demo-7",7,"owner/demo","FAILED","2026-01-01T00:00:00.000Z","2026-01-02T00:00:00.000Z",JSON.stringify({title:"Repair login",url:"https://github.com/owner/demo/issues/7",version:1,cursor:0,feedback:[],cycles:0,reports:{}}));
  store.event("state.changed",{from:"QA",to:"FAILED"},"owner-demo-7");
  store.event("agent.result",{role:"qa",result:{outcome:"pass",summary:"All acceptance criteria passed",coverage:Array(20).fill({})}},"owner-demo-7");
  const server = await startDashboard(store,"127.0.0.1",0);
  const port = (server.address() as AddressInfo).port;
  try {
    const html = await fetch(`http://127.0.0.1:${port}/`).then(response => response.text());
    assert.match(html,/AI Factory/);
    const snapshot = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then(response => response.json()) as any;
    assert.equal(snapshot.daemon.running,false);
    assert.equal(snapshot.items[0].title,"Repair login");
    assert.match(snapshot.events[0].details,/outcome: pass · All acceptance criteria passed/);
    assert.ok(snapshot.events[0].details.length < 421);
    assert.match(snapshot.events[1].details,/from: QA/);
    const response = await fetch(`http://127.0.0.1:${port}/api/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"retry",target:"owner-demo-7"})});
    assert.equal(response.status,202);
    assert.deepEqual(store.db.prepare("SELECT kind,target FROM controls").get(),{kind:"retry",target:"owner-demo-7"});
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.db.close();
  }
});

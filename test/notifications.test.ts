import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { Store } from "../src/storage.js";
import { deliverNotifications, notificationText, slackPayload } from "../src/notifications.js";
import { SlackAdapter } from "../src/adapters/slack.js";
import { config } from "../src/config.js";
import type { WorkItem } from "../src/types.js";
const item: WorkItem = { id: "w", issue_number: 7, repo: "a/b", branch: "factory/test", state: "WAITING_HUMAN", context: { title: "Demo", body: "", url: "https://github.com/a/b/issues/7", version: 2, cursor: 0, waiting: "approval", feedback: [], cycles: 0, reports: {} } };
test("Slack delivery persists, backs off and survives restart; no resend after success", async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-slack-")); const db = path.join(root, "state.db");
 let s = new Store(db); let attempts = 0;
 const port = { enabled: true, async notify() { attempts++; if (attempts === 1) throw new Error("SECRET-WEBHOOK-URL"); } };
 try {
  s.notify(item); await deliverNotifications(s, { ...port, enabled: false }, 0); assert.equal(attempts, 0);
  await deliverNotifications(s, port, 0); assert.equal(attempts, 1);
  assert.equal((s.db.prepare("SELECT sent FROM notifications").get() as any).sent, 0);
  assert.doesNotMatch(JSON.stringify(s.db.prepare("SELECT * FROM notifications").all()), /SECRET/);
  s.db.close(); s = new Store(db);
  await deliverNotifications(s, port, 999); assert.equal(attempts, 1);
  await deliverNotifications(s, port, 1000); await deliverNotifications(s, port, 2000);
  assert.equal(attempts, 2); assert.equal((s.db.prepare("SELECT sent FROM notifications").get() as any).sent, 1);
 } finally { s.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test("real Slack HTTP adapter sends actionable issue link and reports HTTP failures", async () => {
 const old = config.slackWebhook; let status = 500; const payloads: any[] = [];
 const server = createServer((req, res) => { let body = ""; req.on("data", c => body += c); req.on("end", () => { payloads.push(JSON.parse(body)); res.writeHead(status); res.end("ok"); }); });
 await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
 try {
  config.slackWebhook = `http://127.0.0.1:${(server.address() as any).port}/hook`;
  const adapter = new SlackAdapter(); const text = notificationText(item);
  await assert.rejects(adapter.notify(text), /HTTP 500/); status = 200; await adapter.notify(text);
  assert.equal(payloads.length, 2); assert.match(payloads[1].text, /approve v2/); assert.match(payloads[1].text, /https:\/\/github.com\/a\/b\/issues\/7/);
  assert.equal(payloads[1].blocks[0].type,"header"); assert.equal(payloads[1].blocks[1].text.type,"mrkdwn");
 } finally { config.slackWebhook = old; await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("Slack messages prioritize user action and relevant workflow evidence", () => {
 const approval = notificationText({ ...item, context:{ ...item.context, taskAssessment:{ complexity:"high",risk:"medium",rationale:"Cross-cutting change" }, reports:{ "product-architect":{ summary:"Add account recovery",questions:[],findings:[],taskAssessment:{ complexity:"high",risk:"medium",rationale:"Cross-cutting change" } } as any } } });
 assert.match(approval,/Action required · Review SPEC v2/); assert.match(approval,/high complexity • medium risk/);
 assert.match(approval,/`\/factory approve v2`/); assert.match(approval,/<https:\/\/github.com\/a\/b\/issues\/7\|Open issue #7/);
 const questions = notificationText({ ...item, context:{ ...item.context, waiting:"questions",reports:{ "product-architect":{ questions:["Which identity provider?","Should sessions expire?"],findings:[] } as any } } });
 assert.match(questions,/1\. Which identity provider\?/); assert.match(questions,/2\. Should sessions expire\?/); assert.match(questions,/`\/factory answer <answer>`/);
 const failed = notificationText({ ...item,state:"FAILED",context:{ ...item.context,lastFailure:"Agent exited with code 2" } });
 assert.match(failed,/Execution failed/); assert.match(failed,/Cause:\* Agent exited with code 2/); assert.match(failed,new RegExp(item.id));
 const payload = slackPayload(approval); assert.equal(payload.text,approval); assert.equal(payload.blocks[0].type,"header"); assert.equal(payload.blocks[1].type,"section");
});

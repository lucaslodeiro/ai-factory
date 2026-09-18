import { config } from "../config.js";
export class SlackAdapter {
 async notify(text: string) {
  if (!config.slackWebhook) return;
  const r = await fetch(config.slackWebhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("Slack notification failed: " + r.status);
 }
}

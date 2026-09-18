import { config } from "../config.js";
import type { NotificationPort } from "../notifications.js";
export class SlackAdapter implements NotificationPort {
  constructor(private webhook = config.slackWebhook) {}
  get enabled() { return Boolean(this.webhook); }
  async notify(text: string) {
    if (!this.enabled) throw new Error("SLACK_WEBHOOK_URL is not configured");
    const r = await fetch(this.webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`Slack returned HTTP ${r.status}`);
  }
}

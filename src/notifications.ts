import type { Store } from "./storage.js";
import type { WorkItem } from "./types.js";
export interface NotificationPort { readonly enabled: boolean; notify(text: string): Promise<void>; }
export function notificationText(w: WorkItem, detail?: string) {
  const action = w.state === "WAITING_HUMAN"
    ? w.context.waiting === "approval" ? `Review SPEC v${w.context.version}; reply /factory approve v${w.context.version} or /factory answer <feedback> in GitHub.`
      : w.context.waiting === "loop" ? "Correction limit reached. Reply /factory answer <guidance> in GitHub."
      : "Product/Architect needs your answer. Reply /factory answer <answer> in GitHub."
    : w.state === "FAILED" ? `Inspect logs, then factory retry ${w.id}.`
    : w.state === "MERGED" ? `Delivery merged: ${w.context.pr}`
    : w.state === "PR_CLOSED" ? `PR closed without merge. Review or reopen: ${w.context.pr}`
    : w.state === "READY_TO_MERGE" ? `Review the PR and merge manually: ${w.context.pr}` : "";
  const summary = w.state === "WAITING_HUMAN" ? w.context.waiting === "questions"
    ? w.context.reports?.["product-architect"]?.questions.join("; ")
    : w.context.waiting === "approval" ? w.context.reports?.["product-architect"]?.summary
    : w.context.feedback?.at(-1)?.slice(0, 1000) : undefined;
  return [`AI Factory #${w.issue_number}: ${w.state}`, w.context.title, detail, summary?.slice(0, 1200), action,
    w.context.url || `https://github.com/${w.repo}/issues/${w.issue_number}`].filter(Boolean).join("\n");
}
export async function deliverNotifications(store: Store, port: NotificationPort, now = Date.now()) {
  if (!port.enabled) return;
  const rows = store.db.prepare("SELECT * FROM notifications WHERE sent=0 AND next_at<=? ORDER BY id LIMIT 20").all(now) as { id: number; body: string; attempts: number }[];
  for (const row of rows) {
    try {
      await port.notify(row.body);
      store.db.prepare("UPDATE notifications SET sent=1,attempts=attempts+1,last_error=NULL WHERE id=?").run(row.id);
    } catch {
      const delay = Math.min(300000, 1000 * 2 ** Math.min(row.attempts, 9));
      store.db.prepare("UPDATE notifications SET attempts=attempts+1,next_at=?,last_error=? WHERE id=?").run(now + delay, "Slack delivery failed; retry scheduled", row.id);
      store.event("slack.delivery_failed", { notificationId: row.id, nextAttemptAt: now + delay });
    }
  }
}

import type { Store } from "./storage.js";
export interface NotificationPort { readonly enabled: boolean; notify(text: string): Promise<void>; }

export function workflowNotificationText(store:Store,workItemId:string,projection:{stage:string;status:string;attempt:number},reason:{summary:string}) {
  const row=store.db.prepare("SELECT issue_number,repo,context FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;repo:string;context:string};let context:any={};try{context=JSON.parse(row.context||"{}");}catch{}
  const labels:Record<string,string>={DESIGN:"Design",BUILD:"Build",TEST:"Test",REVIEW:"Review",DELIVERY:"Delivery",QUEUED:"Queued",RUNNING:"Running",WAITING:"Waiting for you",FAILED:"Failed",PAUSED:"Paused",CANCELLED:"Cancelled",COMPLETED:"Completed"};
  const request=store.db.prepare("SELECT payload FROM records WHERE work_item_id=? AND kind='request' AND status='open' ORDER BY sequence DESC LIMIT 1").get(workItemId) as {payload:string}|undefined;let requestPayload:any;try{requestPayload=request?JSON.parse(request.payload):undefined;}catch{}
  const failure=store.db.prepare("SELECT message FROM failures WHERE work_item_id=? AND resolved_at IS NULL").get(workItemId) as {message:string}|undefined;
  let heading="AI Factory workflow update",action="No human action is required.";
  if(projection.status==="WAITING") {heading="⚠️ Action required";action=requestPayload?.type==="brief-approval"?"Read the brief (decisions, solution, scope), then post `/factory approve v<version>` or `/factory answer <feedback>` in GitHub.":requestPayload?.type==="spec-approval"?"Look at the prototype screenshots, then post `/factory approve v<version>` or `/factory answer <feedback>` in GitHub.":requestPayload?.type==="merge"?"Review and merge the pull request in GitHub.":requestPayload?.type==="budget"?"An approver can extend the token budget with `/factory budget +<tokens> [reason]` in GitHub or from the dashboard.":"Reply in GitHub with `/factory answer <guidance>`.";}
  else if(projection.status==="FAILED"){heading="❌ Action required · Workflow failed";action="Inspect the failure and daemon logs, then post `/factory retry` in GitHub or use Retry in the dashboard.";}
  else if(projection.status==="PAUSED"){heading="⏸️ Work paused";action="Resume the preserved task from the dashboard or post `/factory retry` when appropriate.";}
  else if(projection.status==="CANCELLED"){heading="⏹️ Work cancelled";action="Use Retry only if you intend to resume the preserved task.";}
  else if(projection.status==="COMPLETED"){heading="🎉 Delivery completed";action="No further factory action is required.";}
  const issue=context.url||`https://github.com/${row.repo}/issues/${row.issue_number}`;
  return [heading,`*${escapeSlack(clean(context.title)||`Issue #${row.issue_number}`)}*`,`*Workflow:* ${labels[projection.stage]??projection.stage} · ${labels[projection.status]??projection.status} · attempt ${projection.attempt}`,`*What changed:* ${escapeSlack(clean(reason.summary,900))}`,failure?`*Cause:* ${escapeSlack(clean(failure.message,900))}`:"",`*Next action:* ${action}`,`<${issue}|Open issue #${row.issue_number} in GitHub>`].filter(Boolean).join("\n\n").slice(0,3900);
}

function clean(value: string | undefined, limit = 700) {
  const text = (value ?? "").replace(/\s+/g," ").trim();
  return text.length > limit ? `${text.slice(0,limit - 1)}…` : text;
}
function escapeSlack(value: string) { return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
export function slackPayload(text: string) {
  const [heading,...body] = text.split("\n"), content = body.join("\n").trim();
  return { text, blocks:[
    { type:"header",text:{ type:"plain_text",text:clean(heading || "AI Factory",150),emoji:true } },
    ...(content ? [{ type:"section",text:{ type:"mrkdwn",text:content.slice(0,3000) } }] : []),
  ] };
}
export async function deliverNotifications(store: Store, port: NotificationPort, now = Date.now()) {
  if (!port.enabled) return;
  const rows = store.db.prepare("SELECT * FROM notifications WHERE sent=0 AND next_at<=? ORDER BY id LIMIT 20").all(now) as { id: number; body: string; attempts: number; work_item_id: string | null }[];
  for (const row of rows) {
    if (row.work_item_id && (store.db.prepare("SELECT archived_at FROM work_items WHERE id=?").get(row.work_item_id) as {archived_at:string|null}|undefined)?.archived_at) {
      store.db.prepare("UPDATE notifications SET sent=1,last_error=? WHERE id=?").run("Suppressed because the GitHub issue is closed",row.id);
      store.event("slack.delivery_skipped_closed",{notificationId:row.id},row.work_item_id);
      continue;
    }
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

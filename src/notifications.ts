import type { Store } from "./storage.js";
import type { AgentResult, WorkItem } from "./types.js";
import { roleShortName, stateName } from "./names.js";
export interface NotificationPort { readonly enabled: boolean; notify(text: string): Promise<void>; }

export function workflowNotificationText(store:Store,workItemId:string,projection:{stage:string;status:string;attempt:number},reason:{summary:string}) {
  const row=store.db.prepare("SELECT issue_number,repo,context FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;repo:string;context:string};let context:any={};try{context=JSON.parse(row.context||"{}");}catch{}
  const labels:Record<string,string>={DESIGN:"Design",BUILD:"Build",TEST:"Test",REVIEW:"Review",DELIVERY:"Delivery",QUEUED:"Queued",RUNNING:"Running",WAITING:"Waiting for you",FAILED:"Failed",PAUSED:"Paused",CANCELLED:"Cancelled",COMPLETED:"Completed"};
  const request=store.db.prepare("SELECT payload FROM records WHERE work_item_id=? AND kind='request' AND status='open' ORDER BY sequence DESC LIMIT 1").get(workItemId) as {payload:string}|undefined;let requestPayload:any;try{requestPayload=request?JSON.parse(request.payload):undefined;}catch{}
  const failure=store.db.prepare("SELECT message FROM failures WHERE work_item_id=? AND resolved_at IS NULL").get(workItemId) as {message:string}|undefined;
  let heading="AI Factory workflow update",action="No human action is required.";
  if(projection.status==="WAITING") {heading="⚠️ Action required";action=requestPayload?.type==="spec-approval"?"Review the proposed SPEC, then post `/factory approve v<version>` or `/factory answer <feedback>` in GitHub.":requestPayload?.type==="merge"?"Review and merge the pull request in GitHub.":"Reply in GitHub with `/factory answer <guidance>`.";}
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
function command(value: string) { return `\`${value.replace(/`/g,"'")}\``; }
function reportSummary(report: AgentResult | undefined) {
  if (!report) return "";
  const findings = report.findings.slice(0,3).map(f => `• ${escapeSlack(clean(f.evidence,240))}`).join("\n");
  return [escapeSlack(clean(report.summary)),findings].filter(Boolean).join("\n");
}
function issueUrl(w: WorkItem) { return w.context.url || `https://github.com/${w.repo}/issues/${w.issue_number}`; }
function identity(w: WorkItem) {
  return `*${escapeSlack(clean(w.context.title,180) || "Untitled issue")}*\n*Project:* \`${escapeSlack(w.repo)}\`  •  *Issue:* <${issueUrl(w)}|#${w.issue_number}>  •  *Status:* ${stateName(w.state)}`;
}
function assessment(w: WorkItem) {
  const value = w.context.taskAssessment ?? w.context.reports["product-architect"]?.taskAssessment;
  return value ? `*Assessment:* ${value.complexity} complexity • ${value.risk} risk` : "";
}
function latestDeliveryReport(w: WorkItem) {
  for (const role of ["reviewer","qa","developer"] as const) {
    const summary = reportSummary(w.context.reports[role]);
    if (summary) return `*Latest ${roleShortName(role)} report:*\n${summary}`;
  }
  return "";
}
export function notificationText(w: WorkItem, detail?: string) {
  const issue = issueUrl(w), version = w.context.version;
  let heading = "AI Factory update", content: string[] = [];
  switch (w.state) {
    case "NEW": heading = "📥 Issue queued"; content = ["The issue was added to the factory queue."]; break;
    case "SPEC": heading = "🧭 Design started · Architect"; content = [version ? `Architect is revising SPEC v${version}.` : "Architect is defining the first specification.",assessment(w)]; break;
    case "WAITING_HUMAN":
      if (w.context.waiting === "approval") {
        heading = `⚠️ Action required · Review SPEC v${version}`;
        content = [assessment(w),`*Summary:* ${escapeSlack(clean(w.context.reports["product-architect"]?.summary) || "The specification is ready for review.")}`,
          `*Choose one in GitHub:*\n• Approve: ${command(`/factory approve v${version}`)}\n• Request changes or add context: ${command("/factory answer <feedback>")}`];
      } else if (w.context.waiting === "loop") {
        heading = "⚠️ Action required · Correction limit reached";
        content = [`The factory stopped after *${w.context.cycles} automatic correction cycles* and needs guidance before continuing.`,latestDeliveryReport(w),
          `*Next step:* Review the issue history, then reply in GitHub with ${command("/factory answer <guidance>")}.`];
      } else {
        const questions = (w.context.reports["product-architect"]?.questions ?? []).slice(0,5).map((question,index) => `${index + 1}. ${escapeSlack(clean(question,350))}`).join("\n");
        heading = "⚠️ Action required · Product input needed";
        content = [questions ? `*Questions:*\n${questions}` : "Architect needs more information before it can define the specification.",
          `*Next step:* Reply in GitHub with ${command("/factory answer <answer>")}. You can write a multiline answer before or after the command.`];
      }
      break;
    case "DEVELOPMENT": heading = "🛠️ Build started · Builder"; content = [`The approved SPEC v${w.context.approvedVersion ?? version} is being implemented${w.context.approval?.login ? ` after approval by *${escapeSlack(w.context.approval.login)}*` : ""}.`,assessment(w)]; break;
    case "QA": heading = "🧪 Test started · Tester"; content = ["Build completed. Tester is now validating the approved acceptance criteria.",reportSummary(w.context.reports.developer) ? `*Builder report:*\n${reportSummary(w.context.reports.developer)}` : ""]; break;
    case "REVIEW": heading = "🔎 Review started · Reviewer"; content = ["Test passed. Reviewer is inspecting the implementation and verification evidence.",reportSummary(w.context.reports.qa) ? `*Tester report:*\n${reportSummary(w.context.reports.qa)}` : ""]; break;
    case "READY_TO_MERGE": heading = "✅ Action required · Pull request ready to merge"; content = [reportSummary(w.context.reports.reviewer) ? `*Review result:*\n${reportSummary(w.context.reports.reviewer)}` : "All automated delivery gates passed.",w.context.pr ? `*Next step:* <${w.context.pr}|Review and merge the pull request manually>.` : "*Next step:* Open the issue and review the pull request."]; break;
    case "MERGED": heading = "🎉 Delivery merged"; content = [w.context.pr ? `The <${w.context.pr}|pull request> was merged and delivery is complete.` : "The pull request was merged and delivery is complete.",w.context.merge?.commit ? `*Merge commit:* \`${escapeSlack(w.context.merge.commit)}\`` : ""]; break;
    case "PR_CLOSED": heading = "⚠️ Action required · Pull request closed without merge"; content = [w.context.pr ? `The <${w.context.pr}|pull request> was closed without integrating the changes.` : "The pull request was closed without integrating the changes.","*Next step:* Review the decision or reopen the pull request to resume merge tracking."]; break;
    case "PAUSED": heading = "⏸️ Work paused"; content = [`The workflow paused during *${stateName(w.context.resume ?? "SPEC")}*. Post ${command("/factory retry")} as a new issue comment or use Retry in the dashboard when ready.`]; break;
    case "FAILED": heading = "❌ Action required · Execution failed"; content = [(detail || w.context.lastFailure) ? `*Cause:* ${escapeSlack(clean(detail || w.context.lastFailure,1000))}` : "The workflow failed. Inspect the execution logs for the cause.",`*Next step:* Inspect the logs, then post ${command("/factory retry")} as a new issue comment, retry from the dashboard, or run ${command(`npm run factory -- retry ${w.id}`)}.`]; break;
    case "CANCELLED": heading = "⏹️ Work cancelled"; content = [`The workflow was cancelled during *${stateName(w.context.resume ?? "SPEC")}*. Post ${command("/factory retry")} as a new issue comment or use Retry in the dashboard to resume it.`]; break;
  }
  return [heading,identity(w),...content.filter(Boolean),`<${issue}|Open issue #${w.issue_number} in GitHub>`].join("\n\n").slice(0,3900);
}
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

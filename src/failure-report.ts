import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import type { Store } from "./storage.js";
import type { AgentRole } from "./types.js";
import { roleShortName } from "./names.js";
import type { WorkflowFailure } from "./workflow-failures.js";

export function redactSecrets(text:string):string {
  text=text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,"Bearer [REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|npm_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})\b/g,"[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,"[REDACTED]")
    .replace(/\b(api[_-]?key|token|authorization|password|secret|webhook)(\s*[=:]\s*|["']:\s*["'])([^\s"'`]+)/gi,"$1$2[REDACTED]")
    .replace(/(https?:\/\/[^\s:/]+:)[^\s@/]+@/gi,"$1[REDACTED]@")
    .replace(/Authorization:[ \t]*(?:Bearer[ \t]+)?(?:\[REDACTED\][ \t]*)+/gi,"Authorization: [REDACTED]");
  for (const [name,secret] of Object.entries(process.env)) {
    if (!secret || secret.length<6 || !/(?:KEY|TOKEN|SECRET|PASSWORD|WEBHOOK)/i.test(name)) continue;
    text=text.split(secret).join("[REDACTED]");
  }
  return text;
}

export function sanitizeFailureEvidence(value: unknown, limit = 4000) {
  let text=String(value ?? "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g,"")
    .replace(/\x1B[@-_]/g,"")
    .replace(/\r/g,"");
  text=redactSecrets(text);
  for (const [local,replacement] of [[config.dataDir,"<factory-data>"],[config.repoDir,"<target-checkout>"],[os.homedir(),"~"]] as const) {
    if (local) text=text.split(local).join(replacement);
  }
  text=text.replace(/```/g,"` ` `").trim();
  return text.length>limit ? `…${text.slice(-(limit-1))}` : text;
}

export function failureLogTail(file: string, maxLines = 30) {
  try {
    const stat=fs.statSync(file),bytes=Math.min(stat.size,64*1024),buffer=Buffer.alloc(bytes),handle=fs.openSync(file,"r");
    try { if (bytes) fs.readSync(handle,buffer,0,bytes,stat.size-bytes); } finally { fs.closeSync(handle); }
    let text=buffer.toString("utf8");
    if (stat.size>bytes) { const newline=text.indexOf("\n"); text=newline>=0 ? text.slice(newline+1) : ""; }
    const lines=text.split(/\r?\n/); while (lines.at(-1)==="") lines.pop();
    return sanitizeFailureEvidence(lines.slice(-maxLines).join("\n"));
  } catch { return ""; }
}

export function failureDiagnosis(reason: string, stderr: string, run?: {status:string;exit_code:number|null},failureClass?:WorkflowFailure["class"]) {
  const evidence=`${reason}\n${stderr}`;
  const kind=failureClass??reason.match(/^\[([^\]]+)\]/)?.[1] as WorkflowFailure["class"]|undefined;
  if (/(?:RPC failed|remote end hung up unexpectedly|HTTP [45]\d\d|curl \d+)/i.test(evidence) && /(?:RPC failed|remote end hung up|git push)/i.test(evidence)) return [
    "**Summary:** Git could not complete the transfer to the remote repository.",
    "**Evidence:** The recorded Git output reports a transport failure. An HTTP 400 alone does not prove invalid credentials, a size limit or a server outage.",
    "**Recommended action:** Check the push destination and remote branch before retrying. Verify network/proxy and Git transport settings; use SSH only after configuring and verifying access. Retry Delivery after correcting the connection; the completed review is preserved.",
  ].join("\n\n");
  if (/(?:authentication failed|not logged in|unauthorized|HTTP 401|HTTP 403|Permission denied \(publickey\))/i.test(evidence)) return [
    "**Summary:** The integration rejected authentication or repository access.",
    "**Evidence:** The recorded error explicitly reports an authentication or access failure; it does not identify which credential or permission is missing.",
    "**Recommended action:** Verify the account and repository permissions for the configured transport. Reconnect the affected provider or verify the SSH key, then retry the failed operation.",
  ].join("\n\n");
  if (/ENOBUFS/i.test(evidence)) return [
    "**Summary:** A subprocess exceeded the output buffer available to the Factory.",
    "**Evidence:** The process wrapper reported ENOBUFS. This is not evidence of a problem in the application being built.",
    "**Recommended action:** Update the Factory to a version that streams large command output. If it persists, share the sanitized technical evidence with the Factory maintainer before retrying.",
  ].join("\n\n");
  if (/Factory local runtime announced no loopback address/i.test(evidence)) return [
    "**Summary:** The preview server started, but it published only addresses this machine's Factory will not drive.",
    `**Evidence:** ${reason.replace(/^Error:\s*/,"").replace(/^Could not prepare workflow execution:\s*/,"")}`,
    "**Recommended action:** The Factory drives the preview from this machine, so the target repository must publish a loopback origin in `.local/url`, first or alongside any LAN or tunnel address. Make its preview script bind loopback as well, then retry the saved stage.",
  ].join("\n\n");
  if (/Factory local runtime did not become ready/i.test(evidence)) return [
    "**Summary:** The Factory starts the target repository's preview server for browser checks, and it did not come up within fifteen seconds.",
    `**Evidence:** ${reason.replace(/^Error:\s*/,"").replace(/^Could not prepare workflow execution:\s*/,"")} The named log holds the script's own output. The server is started because the repository declares a browser dependency and a preview script, not because this issue asked for one.`,
    "**Recommended action:** Open the named log: the usual causes are the script exiting on a busy port, needing an environment variable the Factory does not set, or taking longer than fifteen seconds to write `.local/url`. Free the port or fix the script, then retry the saved stage. If this issue does not need a browser at all, the preview server is pure cost: remove the browser dependency or the preview script from the target repository.",
  ].join("\n\n");
  if (kind==="invalid-context") return [
    "**Summary:** The required specification, decisions, instructions and request chain do not fit within the configured context budget.",
    "**Evidence:** Context assembly stopped before invoking a provider rather than silently dropping protected information.",
    "**Recommended action:** Remove or replace obsolete guidance, or increase the matching context budget in Configuration → Runtime, then retry.",
  ].join("\n\n");
  if (kind==="invalid-result"&&/Environment blockers require/i.test(reason)) return [
    "**Summary:** This run used an older validation rule that could not combine Architect's clarification questions with an unavailable capability. The current Factory accepts that combination.",
    "**Evidence:** Architect completed and returned useful questions plus a capability blocker. The former validator rejected the report before those questions could become the next workflow action.",
    "**Recommended action:** Retry Design. Restore the reported capability when it is required; if the check is optional, say which available equivalent is acceptable in the retry guidance.",
  ].join("\n\n");
  if (kind==="invalid-result") return [
    "**Summary:** The agent returned output that did not satisfy the workflow contract for this role or stage.",
    `**Evidence:** The provider completed, but Factory rejected its report because: ${reason.replace(/^Error:\s*/,"")}`,
    "**Recommended action:** Correct the stated report requirement, then retry the saved stage. Add retry guidance only when the requested behavior needs clarification.",
  ].join("\n\n");
  if (kind==="environment") return [
    "**Summary:** A capability required to complete this stage was unavailable.",
    `**Evidence:** ${reason.replace(/^Error:\s*/,"")}`,
    "**Recommended action:** Restore the reported capability, then retry the saved stage. If that capability is optional for the requested scope, retry with explicit guidance to use an available equivalent and treat the limitation as non-blocking.",
  ].join("\n\n");
  if (kind==="recovery") return [
    "**Summary:** The daemon stopped before it could record a safe completion for this execution.",
    "**Evidence:** Startup recovery found an execution that was still marked running and preserved its stage and worktree.",
    "**Recommended action:** Inspect the preserved changes and daemon logs, then retry the saved stage.",
  ].join("\n\n");
  if (kind==="integration"&&/(?:Base ref must be a branch|Head sha can't be blank)/i.test(evidence)) return [
    "**Summary:** Delivery could not create the pull request because the configured base branch is unavailable or invalid on GitHub.",
    `**Evidence:** ${reason.replace(/^Error:\s*/,"")}`,
    "**Recommended action:** Run Doctor, create and push the configured base branch or select the repository's real default branch, then retry. Delivery will reuse the successful review.",
  ].join("\n\n");
  if (kind==="integration"&&/No commits between/i.test(evidence)) return [
    "**Summary:** Delivery could not create a pull request because GitHub found no commits between the configured base and factory branches.",
    `**Evidence:** ${reason.replace(/^Error:\s*/,"")}`,
    "**Recommended action:** Inspect the preserved factory branch and base history, correct the branch relationship, then retry Delivery.",
  ].join("\n\n");
  if (kind==="integration"||kind==="configuration") return [
    "**Summary:** A required factory setting or external integration prevented the stage from running safely.",
    "**Evidence:** The orchestrator stopped at its configuration or integration boundary before advancing the workflow.",
    "**Recommended action:** Inspect the exact operation and error below. Run the relevant connection or configuration check; do not change credentials unless the evidence identifies an access failure. Retry after the reported cause is resolved.",
  ].join("\n\n");
  if(kind==="execution"&&run?.status==="timed_out")return [
    "**Summary:** The agent execution exceeded its configured time limit.",
    `**Evidence:** The execution supervisor recorded the process as timed out before the stage completed. ${reason.replace(/^Error:\s*/,"")}`,
    "**Recommended action:** Review the last observable activity. A quiet stream alone does not prove a stalled process; interrupt with guidance or increase the timeout only when appropriate, then retry.",
  ].join("\n\n");
  if(kind==="execution"&&run?.status==="cancelled")return [
    "**Summary:** The agent execution was cancelled before the stage completed.",
    "**Evidence:** The execution supervisor recorded a final cancelled status.",
    "**Recommended action:** Confirm why cancellation was requested, then retry the preserved stage only when the work should continue.",
  ].join("\n\n");
  if(kind==="execution"&&run?.status==="interrupted")return [
    "**Summary:** The agent execution was interrupted before the stage completed.",
    "**Evidence:** The execution supervisor recorded a final interrupted status and preserved the workflow stage.",
    "**Recommended action:** Confirm the daemon and host are stable, inspect the preserved worktree, then retry the stage.",
  ].join("\n\n");
  if(kind==="execution"&&run&&run.status!=="failed")return [
    "**Summary:** The agent execution ended before the workflow stage completed.",
    `**Evidence:** The execution supervisor recorded the final process status as ${run.status}.`,
    "**Recommended action:** Inspect the evidence below and retry the preserved stage after correcting the recorded process failure.",
  ].join("\n\n");
  if (/Tactical resolution selected nextRole=/i.test(reason)) return [
    "**Summary:** Architect selected a return role that would skip an unfinished delivery gate.",
    `**Evidence:** ${reason.replace(/^Error:\s*/,"")}`,
    "**Recommended action:** Retry with guidance to resolve the tactical question and return to one of the allowed roles shown above. The approved SPEC, human answer and preserved worktree can be reused.",
  ].join("\n\n");
  if (/PASS requires successful executed tests with exit codes/i.test(reason)) return [
    "**Summary:** The agent returned PASS, but its `tests` evidence included a failed or unexecuted command.",
    `**Evidence:** ${reason.replace(/^Error:\s*/,"")}`,
    "**Recommended action:** Retry after deciding whether that command is required acceptance verification. Required verification must succeed before PASS; setup, diagnostics and server cleanup belong in the summary or a finding rather than the `tests` evidence list.",
  ].join("\n\n");
  if (/Tactical resolution requires an approved-spec consultation/i.test(reason)) return [
    "**Summary:** Architect returned a tactical resolution, but the saved workflow no longer contained the approved consultation route needed to apply it.",
    "**Evidence:** The agent completed successfully; the orchestrator rejected the result while validating the approved SPEC and delivery return stage.",
    "**Recommended action:** Update the factory to a version that preserves and repairs consultation state, then retry. The existing SPEC, approval audit and worktree can be reused.",
  ].join("\n\n");
  if (/Tactical resolution cannot require a human decision/i.test(reason)) return [
    "**Summary:** Architect marked its response as a completed tactical resolution while the same response still requested a human decision or conflicted with prior human guidance.",
    "**Evidence:** The agent process succeeded, but its structured result combined `resolved` with questions, a major/conflicting decision, or a decision-required finding.",
    "**Recommended action:** Retry with clear guidance: resolve within the approved SPEC when the decision is already known, or ask one explicit question when human input is still required.",
  ].join("\n\n");
  if (/Changes require (?:actionable findings|an auto-fix finding)/i.test(reason)) {
    const browserBlocked=/(?:playwright|chromium|chrome-headless-shell)/i.test(stderr) && /(?:permission denied|MachPortRendezvous|bootstrap_check_in|SIGTRAP)/i.test(stderr);
    if (browserBlocked) return [
        "**Summary:** The agent process completed, but the orchestrator rejected its report because it requested changes without providing an actionable finding. During validation, Playwright/Chromium also failed before the browser could start.",
        "**Evidence:** The process exited successfully, the result contract reported non-actionable changes, and Chromium was stopped by a macOS permission/sandbox error (`MachPortRendezvous` / `Permission denied`).",
        "**Recommended action:** Do not repeat the same Chromium validation on this host. Retry with explicit non-browser validation guidance, or use a host where browser processes are permitted if browser verification is mandatory.",
      ].join("\n\n");
    return [
      "**Summary:** The agent process completed, but its structured report requested changes without an actionable finding, so the orchestrator could not determine a safe next step.",
      `**Evidence:** The provider exited successfully, then result validation raised \`${reason.replace(/^Error:\s*/,"")}\`.`,
      "**Recommended action:** Retry with guidance that tells the agent to complete the work and return PASS evidence, report a concrete auto-fix as changes, or report a blocked human choice as a decision-required finding with outcome decision.",
    ].join("\n\n");
  }
  if (/(?:playwright|chromium|chrome-headless-shell)/i.test(evidence) && /(?:permission denied|MachPortRendezvous|bootstrap_check_in|SIGTRAP)/i.test(evidence)) return [
    "**Summary:** Browser-based validation could not start on this host.",
    "**Evidence:** Playwright launched Chromium, but macOS denied its rendezvous/process operation before the page or tests ran.",
    "**Recommended action:** Validate without Chromium when the approved scope permits it, or run the browser check on a host with the required permissions.",
  ].join("\n\n");
  if (/branch named ['\"].+['\"] already exists/i.test(evidence)) return [
    "**Summary:** Worktree preparation stopped because the factory branch already exists.",
    "**Evidence:** Git refused to create a new branch with an existing name.",
    "**Recommended action:** Inspect the preserved worktree/branch and retry through the factory so it can resume the saved stage; remove the branch only after confirming it contains no work that must be kept.",
  ].join("\n\n");
  if (/(?:authentication|not logged in|unauthorized|forbidden|HTTP 401|HTTP 403)/i.test(evidence)) return [
    "**Summary:** An external command or integration rejected the configured credentials.",
    "**Evidence:** The failure output contains an authentication or authorization error.",
    "**Recommended action:** Reconnect the affected credential in the dashboard, run Doctor, and retry after the connection passes validation.",
  ].join("\n\n");
  if (/(?:command not found|ENOENT|No such file or directory)/i.test(evidence)) return [
    "**Summary:** A required executable or file was not available to the agent process.",
    "**Evidence:** The failure output reports a missing command or path.",
    "**Recommended action:** Verify the configured command paths and target checkout with Doctor, then retry after the missing dependency is available.",
  ].join("\n\n");
  if (/(?:timed out|timeout|ETIMEDOUT)/i.test(evidence)) return [
    "**Summary:** The operation exceeded its allowed execution time or could not reach a dependency in time.",
    "**Evidence:** The workflow or subprocess reported a timeout.",
    "**Recommended action:** Check daemon and integration connectivity, increase the execution timeout only if the operation is expected to run longer, then retry.",
  ].join("\n\n");
  if (/daemon restart|daemon restarted|interrupted/i.test(evidence)) return [
    "**Summary:** The stage was interrupted before the orchestrator could safely record completion.",
    "**Evidence:** Recovery found an unfinished execution after the daemon stopped or restarted.",
    "**Recommended action:** Confirm the daemon is stable, inspect the preserved worktree, and retry the saved stage.",
  ].join("\n\n");
  if (run?.status === "failed" || (run?.exit_code !== null && run?.exit_code !== undefined && run.exit_code !== 0)) return [
    "**Summary:** The agent subprocess failed before the workflow stage could complete.",
    `**Evidence:** The recorded process status is ${run.status}${run.exit_code === null ? "" : ` with exit code ${run.exit_code}`}.`,
    "**Recommended action:** Use the stderr evidence below to correct the first concrete command or test failure, then retry the saved stage.",
  ].join("\n\n");
  return [
    "**Summary:** The operation failed, but the available evidence does not identify its underlying cause.",
    `**Evidence:** ${reason.replace(/\s+/g," ")}`,
    "**Recommended action:** Inspect the evidence below and daemon logs, add clarifying guidance to the retry comment if needed, then retry the saved stage.",
  ].join("\n\n");
}

export function workflowFailureEvidence(store:Store,failure:WorkflowFailure,publishText:(value:string)=>string=value=>value) {
  const storedRun=failure.executionId ? store.db.prepare("SELECT id,role,status,exit_code,finished_at FROM executions WHERE id=? AND work_item_id=?").get(failure.executionId,failure.workItemId) as {id:string;role:AgentRole;status:string;exit_code:number|null;finished_at:string|null}|undefined : undefined;
  const run=storedRun?{...storedRun,status:storedRun.status==="running"&&storedRun.finished_at?"failed":storedRun.status}:undefined;
  const stderr=run && path.basename(run.id)===run.id ? publishText(failureLogTail(path.join(config.dataDir,"runs",run.id,"stderr.log"),25)) : "";
  const reason=publishText(sanitizeFailureEvidence(failure.message,1600))||"The workflow stopped without an error message.";
  const analysis=failureDiagnosis(reason,stderr,run,failure.class);
  const facts=[`- **Failure class:** ${failure.class}`,`- **Stage:** ${failure.stage}`,`- **Attempt:** ${failure.attempt}`];
  if(run)facts.push(`- **Agent:** ${roleShortName(run.role)}`,`- **Execution:** \`${run.id}\``,`- **Process result:** ${run.status}${run.exit_code===null?"":` · exit ${run.exit_code}`}`);
  const output=stderr?`\n\n<details><summary>Last ${Math.min(25,stderr.split("\n").length)} stderr lines</summary>\n\n\`\`\`text\n${stderr}\n\`\`\`\n\n</details>`:`\n\n_No stderr output was available. Use **Daemon logs** in the dashboard for additional context._`;
  return `### Failure details\n\n${facts.join("\n")}\n\n#### What happened\n\n${reason}\n\n#### Diagnosis\n\n${analysis}${output}`;
}

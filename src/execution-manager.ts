import {browserRequired,browserInstructions} from "./browser-runner.mjs";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Store } from "./storage.js";
import { config, agentEnvironment } from "./config.js";
import type { AgentRole, ModelSelection } from "./types.js";
import { tokenUsageReducer } from "./token-usage.js";
import { providerActivityReducer } from "./provider-activity.js";
import { eachJsonLine, type JsonEvent } from "./provider-stream.js";
import {progressMonitor,progressKey} from "./execution-progress.js";
import {sanitizeFailureEvidence} from "./failure-report.js";
import {InvalidResultError} from "./results.js";
import {budgetState,liveBudget} from "./budget.js";
const workflowStage: Record<AgentRole,string> = {"product-architect":"DESIGN",designer:"DESIGN",developer:"BUILD",qa:"TEST",reviewer:"REVIEW"};
export function providerFailureMessage(event:JsonEvent|undefined,provider:ModelSelection["provider"]|undefined){
  if(!event||!provider)return undefined;
  const failed=event.type==="result"&&event.is_error===true||provider==="codex"&&event.type==="turn.failed";
  if(!failed)return undefined;
  const error=event.error&&typeof event.error==="object"?event.error as Record<string,unknown>:undefined;
  const message=typeof event.result==="string"&&event.result.trim()?event.result
    :Array.isArray(event.errors)&&typeof event.errors[0]==="string"?event.errors[0]
    :typeof error?.message==="string"?error.message
    :typeof event.message==="string"?event.message
    :typeof event.subtype==="string"?event.subtype:undefined;
  return message?sanitizeFailureEvidence(message,500):undefined;
}
export interface PromptManifestInput {
  includedRecordIds?:string[];
  activeRequestId?:string;
  sectionBytes?:Record<string,number>;
  budgetBytes?:number|null;
  budgetSource?:string;
}
function readOutput(file:string,maxBytes:number) {
  try {
    const stat=fs.statSync(file);
    if (stat.size>maxBytes) return {text:"",tooLarge:true};
    return {text:fs.readFileSync(file,"utf8"),tooLarge:false};
  } catch { return {text:"",tooLarge:false}; }
}
export interface ExecutionOutput {
  id:string;
  /** The last `type: "result"` event of a streaming provider, when it wrote one. */
  finalEvent?:JsonEvent;
  /** The whole of stdout as text, for a provider that answers with a single envelope. */
  readStdout():string;
}
export class ExecutionManager {
  private running = new Map<string, { child: ChildProcess; cancel: () => void; interrupt: (reason:string) => void }>();
  constructor(private store: Store) {}
  async run(workItemId: string, role: AgentRole, command: string, args: string[], cwd: string, input = "", timeoutMs = config.timeoutMs, selection?: ModelSelection, promptMetadata:PromptManifestInput = {}, executionId?:string, localRuntimeUrl?:string): Promise<ExecutionOutput> {
    if(browserRequired(cwd,role))input+=browserInstructions(cwd,localRuntimeUrl);
    const id = executionId??randomUUID();
    const logDir = path.join(config.dataDir, "runs", id);
    fs.mkdirSync(logDir, { recursive: true });
    const promptBytes=Buffer.byteLength(input),promptSha256=createHash("sha256").update(input).digest("hex"),specVersion=(this.store.db.prepare("SELECT MAX(version) version FROM specs WHERE work_item_id=?").get(workItemId) as {version:number|null}|undefined)?.version??0;
    const promptManifest={executionId:id,role,provider:selection?.provider??null,model:selection?.model??null,specVersion,
      includedRecordIds:promptMetadata.includedRecordIds??[],activeRequestId:promptMetadata.activeRequestId??null,
      sectionBytes:promptMetadata.sectionBytes??{rawPrompt:promptBytes},budgetBytes:promptMetadata.budgetBytes??null,budgetSource:promptMetadata.budgetSource??"direct-unbounded",
      promptBytes,promptSha256};
    fs.writeFileSync(path.join(logDir,"prompt.md"),input,{mode:0o600});
    fs.writeFileSync(path.join(logDir,"prompt.json"),JSON.stringify(promptManifest,null,2)+"\n",{mode:0o600});
    const out = fs.openSync(path.join(logDir, "stdout.log"), "w", 0o600);
    const err = fs.openSync(path.join(logDir, "stderr.log"), "w", 0o600);
    if(executionId){
      const existing=this.store.db.prepare("SELECT work_item_id,role,status FROM executions WHERE id=?").get(id) as {work_item_id:string;role:string;status:string}|undefined;
      if(!existing||existing.work_item_id!==workItemId||existing.role!==role||existing.status!=="running")throw new Error("Precreated execution does not match the active workflow run");
      this.store.db.prepare("UPDATE executions SET prompt_bytes=?,prompt_sha256=? WHERE id=?").run(promptBytes,promptSha256,id);
    } else this.store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at,prompt_bytes,prompt_sha256) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, workItemId, role, workflowStage[role], "running", new Date().toISOString(),promptBytes,promptSha256);
    this.store.event("execution.started", { role, command, cwd, logDir, selection }, workItemId, id);
    const monitor=progressMonitor(logDir,selection?.provider??null);
    this.store.setMetadata(progressKey(id),monitor.poll());
    return new Promise((resolve, reject) => {
      let cancelled = false, interrupted = false, interruptionReason:string|undefined, timedOut = false;
      const env=agentEnvironment();
      // Claude's default five schema attempts can turn a small formatting error into a long run.
      if(selection?.provider==="claude")env.MAX_STRUCTURED_OUTPUT_RETRIES="2";
      const child = spawn(process.execPath, [fileURLToPath(new URL("./worker-supervisor.mjs", import.meta.url)), id, logDir], { cwd, env, detached: true, stdio: ["pipe", out, err, "ipc"] });
      fs.closeSync(out); fs.closeSync(err);
      this.store.db.prepare("UPDATE executions SET pid=? WHERE id=?").run(child.pid ?? null, id);
      const send = (message:{type:"cancel";reason?:string}|{type:"interrupt";reason:string}) => { if(child.connected) try{child.send(message);}catch{} };
      const cancel = (reason="user-cancel") => { if (cancelled) return; cancelled = true; interruptionReason=reason; send({type:"cancel",reason}); };
      const interrupt = (reason:string) => { if(cancelled||interrupted)return;interrupted=true;interruptionReason=reason;send({type:"interrupt",reason}); };
      this.running.set(id, { child, cancel, interrupt });
      const timeout = setTimeout(() => { timedOut = true; cancel("execution-timeout"); }, timeoutMs);
      let observed=0,budgetStopped=false,closing=false;
      const recordProgress=()=>{try{const snapshot=monitor.poll();if(snapshot.events!==observed){observed=snapshot.events;this.store.setMetadata(progressKey(id),snapshot);if(!closing&&!budgetStopped&&snapshot.usageTokens!==null){const budget=budgetState(this.store,workItemId),live=liveBudget(budget.granted,budget.consumed,snapshot.usageTokens);if(live.stop){budgetStopped=true;this.store.event("budget.execution_limit",{consumed:live.consumed,granted:budget.granted},workItemId,id);cancel("token-budget-limit");}}}}catch{}};
      const progressTimer=setInterval(recordProgress,2000);progressTimer.unref();
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify({ command, args, cwd, input, role, browserExecutable: process.env.FACTORY_BROWSER_EXECUTABLE }));
      let spawnError: Error | undefined;
      child.on("error", e => { spawnError = e; });
      child.on("close", code => {
        // Clean any remaining descendants even after a normal provider exit.
        closing=true;clearTimeout(timeout);clearInterval(progressTimer);recordProgress();this.running.delete(id);
        let completion: { runId: string; status: string; code: number | null; reason?:string } | undefined;
        try {
          const saved = JSON.parse(fs.readFileSync(path.join(logDir, "completion.json"), "utf8"));
          if (saved.runId === id && (saved.code === null || Number.isInteger(saved.code))) completion = saved;
        } catch {}
        const providerExitCode = completion?.code ?? code;
        interruptionReason=timedOut?"execution-timeout":cancelled?(completion?.reason??interruptionReason??"user-cancel"):completion?.reason??interruptionReason;
        let status = timedOut ? "timed_out" : cancelled||completion?.status==="cancelled" ? "cancelled" : interrupted||completion?.status==="interrupted" ? "interrupted" : code === 0 && !spawnError && completion?.status === "succeeded" ? "succeeded" : "failed";
        // One pass over the provider's event stream, however long the run was: its usage, its
        // activity and the final result envelope. Plain-text output simply yields no events.
        const stdoutFile=path.join(logDir,"stdout.log"),usageReducer=tokenUsageReducer(selection?.provider),activityReducer=providerActivityReducer();
        let finalEvent:JsonEvent|undefined,failedTurn:JsonEvent|undefined;
        // A transcript that cannot be read leaves usage and activity unknown; it must not stop the
        // execution from being recorded.
        try { eachJsonLine(stdoutFile,event=>{usageReducer.add(event);activityReducer.add(event);if(event.type==="result")finalEvent=event;if(event.type==="turn.failed")failedTurn=event;}); } catch {}
        if(status==="succeeded"&&(finalEvent?.is_error===true||failedTurn))status="failed";
        const usage=usageReducer.result();
        // Without a completion record the supervisor died before the agent was reaped, so the agent may
        // still be running: retry must prove its process group is gone first.
        this.store.db.prepare("UPDATE executions SET status=?,finished_at=?,exit_code=?,input_tokens=?,output_tokens=?,cached_tokens=?,total_tokens=?,interruption_reason=?,recovery_pending=? WHERE id=?")
          .run(status, new Date().toISOString(), providerExitCode, usage?.inputTokens ?? null,usage?.outputTokens ?? null,usage?.cachedTokens ?? null,usage?.totalTokens ?? null,interruptionReason??null,completion?0:1,id);
        const providerError=status==="failed"?providerFailureMessage(finalEvent??failedTurn,selection?.provider):undefined;
        this.store.event("execution.finished", { status, code: providerExitCode, supervisorExitCode: code,usage,activity:activityReducer.result(),interruptionReason,providerError }, workItemId, id);
        if (status !== "succeeded") {const message=`Execution ${id} ${status}${providerError ? `: ${providerError}` : spawnError ? ': ' + spawnError.message : ''}`;return reject(providerError&&/Failed to provide valid structured output after \d+ attempts/i.test(providerError)?new InvalidResultError(message):new Error(message));}
        resolve({ id, finalEvent, readStdout:()=>{ const stdout=readOutput(stdoutFile,10_000_000); if(stdout.tooLarge)throw new Error("Agent output exceeds 10 MB"); return stdout.text; } });
      });
    });
  }
  cancel(id: string) { const entry = this.running.get(id); if (!entry) return false; entry.cancel(); return true; }
  interrupt(id:string,reason="planned-maintenance"){const entry=this.running.get(id);if(!entry)return false;entry.interrupt(reason);return true;}
  isRunning(id:string){return this.running.has(id);}
  cancelAll() { for (const e of this.running.values()) e.cancel(); }
}
export class ExecutionNotStoppedError extends Error {}
export function assertExecutionStopped(store: Store, workItemId: string) {
  if (store.db.prepare("SELECT id FROM executions WHERE work_item_id=? AND status='running'").get(workItemId)) throw new ExecutionNotStoppedError("Wait for the active process to stop before retry");
  const pending = store.db.prepare("SELECT id,pid FROM executions WHERE work_item_id=? AND recovery_pending=1").all(workItemId) as { id: string; pid: number | null }[];
  for (const run of pending) {
    // The supervisor and the agent lead separate process groups: an agent whose supervisor was
    // killed keeps writing to the worktree, so both groups must be gone before a retry starts.
    for (const group of [run.pid, workerGroup(run.id)]) {
      if (!group) continue;
      try { process.kill(-group, 0); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") continue;
        throw new ExecutionNotStoppedError(`Cannot establish whether interrupted run ${run.id} has exited`);
      }
      throw new ExecutionNotStoppedError(group === run.pid
        ? `Interrupted run ${run.id} still has a live process group; wait for supervisor cleanup before retry.`
        : `Interrupted run ${run.id} left its agent process group ${group} running without a supervisor; stop it before retry.`);
    }
    store.db.prepare("UPDATE executions SET recovery_pending=0 WHERE id=?").run(run.id);
  }
}
function workerGroup(runId: string): number | undefined {
  let saved: unknown;
  try { saved = JSON.parse(fs.readFileSync(path.join(config.dataDir, "runs", runId, "worker.json"), "utf8")); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ExecutionNotStoppedError(`Cannot read the agent process record of interrupted run ${runId}`);
  }
  const record = saved as { runId?: unknown; pid?: unknown } | null;
  if (record?.runId !== runId || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 1) throw new ExecutionNotStoppedError(`Agent process record of interrupted run ${runId} is invalid`);
  return record.pid as number;
}

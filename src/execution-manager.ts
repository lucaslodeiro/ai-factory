import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Store } from "./storage.js";
import { config, agentEnvironment } from "./config.js";
import { failureMarkdown } from "./failure-report.js";
import type { AgentRole, ModelSelection } from "./types.js";
import { extractTokenUsage } from "./token-usage.js";
const workflowState: Record<AgentRole,string> = {"product-architect":"SPEC",developer:"DEVELOPMENT",qa:"QA",reviewer:"REVIEW"};
function readOutput(file:string,maxBytes:number,fromEnd=false) {
  try {
    const stat=fs.statSync(file);
    if (!fromEnd && stat.size>maxBytes) return {text:"",tooLarge:true};
    const bytes=Math.min(stat.size,maxBytes),buffer=Buffer.alloc(bytes),handle=fs.openSync(file,"r");
    try { if(bytes) fs.readSync(handle,buffer,0,bytes,fromEnd ? stat.size-bytes : 0); } finally { fs.closeSync(handle); }
    return {text:buffer.toString("utf8"),tooLarge:stat.size>maxBytes};
  } catch { return {text:"",tooLarge:false}; }
}
export class ExecutionManager {
  private running = new Map<string, { child: ChildProcess; cancel: () => void }>();
  constructor(private store: Store) {}
  async run(workItemId: string, role: AgentRole, command: string, args: string[], cwd: string, input = "", timeoutMs = config.timeoutMs, selection?: ModelSelection): Promise<{id: string; stdout: string}> {
    const id = randomUUID();
    const logDir = path.join(config.dataDir, "runs", id);
    fs.mkdirSync(logDir, { recursive: true });
    const out = fs.openSync(path.join(logDir, "stdout.log"), "w", 0o600);
    const err = fs.openSync(path.join(logDir, "stderr.log"), "w", 0o600);
    this.store.db.prepare("INSERT INTO executions(id,work_item_id,role,workflow_state,status,started_at) VALUES(?,?,?,?,?,?)")
      .run(id, workItemId, role, workflowState[role], "running", new Date().toISOString());
    this.store.event("execution.started", { role, command, cwd, logDir, selection }, workItemId, id);
    return new Promise((resolve, reject) => {
      let cancelled = false, timedOut = false, force: NodeJS.Timeout | undefined;
      const child = spawn(process.execPath, [fileURLToPath(new URL("./worker-supervisor.mjs", import.meta.url)), id, logDir], { cwd, env: agentEnvironment(), detached: true, stdio: ["pipe", out, err, "ipc"] });
      fs.closeSync(out); fs.closeSync(err);
      this.store.db.prepare("UPDATE executions SET pid=? WHERE id=?").run(child.pid ?? null, id);
      const signal = (s: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, s); } catch {} } };
      const cancel = () => { if (cancelled) return; cancelled = true; signal("SIGTERM"); force = setTimeout(() => signal("SIGKILL"), 1000); };
      this.running.set(id, { child, cancel });
      const timeout = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify({ command, args, cwd, input }));
      let spawnError: Error | undefined;
      child.on("error", e => { spawnError = e; });
      child.on("close", code => {
        // Clean any remaining descendants even after a normal provider exit.
        signal("SIGKILL");
        clearTimeout(timeout); if (force) clearTimeout(force); this.running.delete(id);
        let completion: { runId: string; status: string; code: number | null } | undefined;
        try {
          const saved = JSON.parse(fs.readFileSync(path.join(logDir, "completion.json"), "utf8"));
          if (saved.runId === id && (saved.code === null || Number.isInteger(saved.code))) completion = saved;
        } catch {}
        const providerExitCode = completion?.code ?? code;
        const status = timedOut ? "timed_out" : cancelled ? "cancelled" : code === 0 && !spawnError && completion?.status === "succeeded" ? "succeeded" : "failed";
        const stdoutFile=path.join(logDir,"stdout.log"),stderrFile=path.join(logDir,"stderr.log");
        const stdout=readOutput(stdoutFile,10_000_000),stderr=readOutput(stderrFile,512*1024,true);
        const usage=extractTokenUsage(selection?.provider,stdout.text,stderr.text);
        this.store.db.prepare("UPDATE executions SET status=?,finished_at=?,exit_code=?,input_tokens=?,output_tokens=?,cached_tokens=?,total_tokens=? WHERE id=?")
          .run(status, new Date().toISOString(), providerExitCode, usage?.inputTokens ?? null,usage?.outputTokens ?? null,usage?.cachedTokens ?? null,usage?.totalTokens ?? null,id);
        this.store.event("execution.finished", { status, code: providerExitCode, supervisorExitCode: code,usage }, workItemId, id);
        if (status !== "succeeded") return reject(new Error(`Execution ${id} ${status}${spawnError ? ': ' + spawnError.message : ''}`));
        try {
          if (stdout.tooLarge) return reject(new Error("Agent output exceeds 10 MB"));
          resolve({ id, stdout:stdout.text });
        } catch (error) { reject(error); }
      });
    });
  }
  cancel(id: string) { const entry = this.running.get(id); if (!entry) return false; entry.cancel(); return true; }
  cancelAll() { for (const e of this.running.values()) e.cancel(); }
  recover() {
    const rows = this.store.db.prepare("SELECT id,work_item_id FROM executions WHERE status='running'").all() as { id: string; work_item_id: string }[];
    this.store.db.transaction(() => {
      for (const r of rows) {
        this.store.db.prepare("UPDATE executions SET status='interrupted',recovery_pending=1,finished_at=? WHERE id=?").run(new Date().toISOString(), r.id);
        const w = this.store.get(r.work_item_id);
        if (w && ["SPEC", "DEVELOPMENT", "QA", "REVIEW"].includes(w.state)) {
          w.context.resume = w.context.pendingStage?.stage ?? w.state;
          w.context.lastFailure = "An agent execution was interrupted because the daemon restarted.";
          this.store.transition(w, "FAILED");
          this.store.post(w.issue_number,failureMarkdown(this.store,w,w.context.lastFailure));
        }
        this.store.event("execution.interrupted", { reason: "Daemon restarted; supervisor disconnect terminates its worker group. Retry waits until group exit." }, r.work_item_id, r.id);
      }
      // Covers a crash after successful process exit but before the workflow transaction.
      for (const w of this.store.items()) {
        if (w.context.pendingStage && ["SPEC", "DEVELOPMENT", "QA", "REVIEW"].includes(w.state)) {
          w.context.resume = w.context.pendingStage.stage;
          w.context.lastFailure = "The daemon restarted before the workflow could record the completed agent stage.";
          this.store.transition(w, "FAILED");
          this.store.post(w.issue_number,failureMarkdown(this.store,w,w.context.lastFailure));
          this.store.event("stage.interrupted", w.context.pendingStage, w.id);
        }
      }
    })();
    return rows.length;
  }
}
export function assertRetrySafe(store: Store, workItemId: string) {
  if (store.db.prepare("SELECT id FROM executions WHERE work_item_id=? AND status='running'").get(workItemId)) throw new Error("Wait for the active process to stop before retry");
  const pending = store.db.prepare("SELECT id,pid FROM executions WHERE work_item_id=? AND recovery_pending=1").all(workItemId) as { id: string; pid: number | null }[];
  for (const run of pending) {
    if (run.pid) {
      try { process.kill(-run.pid, 0); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw new Error(`Cannot establish whether interrupted run ${run.id} has exited`);
        store.db.prepare("UPDATE executions SET recovery_pending=0 WHERE id=?").run(run.id);
        continue;
      }
      throw new Error(`Interrupted run ${run.id} still has a live process group; wait for supervisor cleanup before retry. Legacy runs may require inspection.`);
    }
    store.db.prepare("UPDATE executions SET recovery_pending=0 WHERE id=?").run(run.id);
  }
}

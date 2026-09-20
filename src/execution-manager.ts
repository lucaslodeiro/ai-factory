import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Store } from "./storage.js";
import { config, agentEnvironment } from "./config.js";
import type { AgentRole, ModelSelection } from "./types.js";
import { extractTokenUsage } from "./token-usage.js";
const workflowStage: Record<AgentRole,string> = {"product-architect":"DESIGN",developer:"BUILD",qa:"TEST",reviewer:"REVIEW"};
export interface PromptManifestInput {
  includedRecordIds?:string[];
  activeRequestId?:string;
  sectionBytes?:Record<string,number>;
  budgetBytes?:number|null;
  budgetSource?:string;
}
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
  private running = new Map<string, { child: ChildProcess; cancel: () => void; interrupt: (reason:string) => void }>();
  constructor(private store: Store) {}
  async run(workItemId: string, role: AgentRole, command: string, args: string[], cwd: string, input = "", timeoutMs = config.timeoutMs, selection?: ModelSelection, promptMetadata:PromptManifestInput = {}, executionId?:string): Promise<{id: string; stdout: string}> {
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
    return new Promise((resolve, reject) => {
      let cancelled = false, interrupted = false, interruptionReason:string|undefined, timedOut = false;
      const child = spawn(process.execPath, [fileURLToPath(new URL("./worker-supervisor.mjs", import.meta.url)), id, logDir], { cwd, env: agentEnvironment(), detached: true, stdio: ["pipe", out, err, "ipc"] });
      fs.closeSync(out); fs.closeSync(err);
      this.store.db.prepare("UPDATE executions SET pid=? WHERE id=?").run(child.pid ?? null, id);
      const send = (message:{type:"cancel"}|{type:"interrupt";reason:string}) => { if(child.connected) try{child.send(message);}catch{} };
      const cancel = () => { if (cancelled) return; cancelled = true; send({type:"cancel"}); };
      const interrupt = (reason:string) => { if(cancelled||interrupted)return;interrupted=true;interruptionReason=reason;send({type:"interrupt",reason}); };
      this.running.set(id, { child, cancel, interrupt });
      const timeout = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify({ command, args, cwd, input }));
      let spawnError: Error | undefined;
      child.on("error", e => { spawnError = e; });
      child.on("close", code => {
        // Clean any remaining descendants even after a normal provider exit.
        clearTimeout(timeout); this.running.delete(id);
        let completion: { runId: string; status: string; code: number | null; reason?:string } | undefined;
        try {
          const saved = JSON.parse(fs.readFileSync(path.join(logDir, "completion.json"), "utf8"));
          if (saved.runId === id && (saved.code === null || Number.isInteger(saved.code))) completion = saved;
        } catch {}
        const providerExitCode = completion?.code ?? code;
        interruptionReason=!timedOut&&cancelled?"user-cancel":completion?.reason??interruptionReason;
        const status = timedOut ? "timed_out" : cancelled||completion?.status==="cancelled" ? "cancelled" : interrupted||completion?.status==="interrupted" ? "interrupted" : code === 0 && !spawnError && completion?.status === "succeeded" ? "succeeded" : "failed";
        const stdoutFile=path.join(logDir,"stdout.log"),stderrFile=path.join(logDir,"stderr.log");
        const stdout=readOutput(stdoutFile,10_000_000),stderr=readOutput(stderrFile,512*1024,true);
        const usage=extractTokenUsage(selection?.provider,stdout.text,stderr.text);
        this.store.db.prepare("UPDATE executions SET status=?,finished_at=?,exit_code=?,input_tokens=?,output_tokens=?,cached_tokens=?,total_tokens=?,interruption_reason=? WHERE id=?")
          .run(status, new Date().toISOString(), providerExitCode, usage?.inputTokens ?? null,usage?.outputTokens ?? null,usage?.cachedTokens ?? null,usage?.totalTokens ?? null,interruptionReason??null,id);
        this.store.event("execution.finished", { status, code: providerExitCode, supervisorExitCode: code,usage,interruptionReason }, workItemId, id);
        if (status !== "succeeded") return reject(new Error(`Execution ${id} ${status}${spawnError ? ': ' + spawnError.message : ''}`));
        try {
          if (stdout.tooLarge) return reject(new Error("Agent output exceeds 10 MB"));
          resolve({ id, stdout:stdout.text });
        } catch (error) { reject(error); }
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
    if (run.pid) {
      try { process.kill(-run.pid, 0); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw new ExecutionNotStoppedError(`Cannot establish whether interrupted run ${run.id} has exited`);
        store.db.prepare("UPDATE executions SET recovery_pending=0 WHERE id=?").run(run.id);
        continue;
      }
      throw new ExecutionNotStoppedError(`Interrupted run ${run.id} still has a live process group; wait for supervisor cleanup before retry.`);
    }
    store.db.prepare("UPDATE executions SET recovery_pending=0 WHERE id=?").run(run.id);
  }
}

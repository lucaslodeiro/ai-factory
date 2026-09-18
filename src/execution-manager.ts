import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Store } from "./storage.js";
import { config, agentEnvironment } from "./config.js";
import type { AgentRole } from "./types.js";
export class ExecutionManager {
  private running = new Map<string, { child: ChildProcess; cancel: () => void }>();
  constructor(private store: Store) {}
  async run(workItemId: string, role: AgentRole, command: string, args: string[], cwd: string, input = "", timeoutMs = config.timeoutMs): Promise<{id: string; stdout: string}> {
    const id = randomUUID();
    const logDir = path.join(config.dataDir, "runs", id);
    fs.mkdirSync(logDir, { recursive: true });
    const out = fs.openSync(path.join(logDir, "stdout.log"), "w", 0o600);
    const err = fs.openSync(path.join(logDir, "stderr.log"), "w", 0o600);
    this.store.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at) VALUES(?,?,?,?,?)")
      .run(id, workItemId, role, "running", new Date().toISOString());
    this.store.event("execution.started", { role, command, cwd, logDir }, workItemId, id);
    return new Promise((resolve, reject) => {
      let cancelled = false, timedOut = false, force: NodeJS.Timeout | undefined;
      const child = spawn(command, args, { cwd, env: agentEnvironment(), detached: true, stdio: ["pipe", out, err] });
      fs.closeSync(out); fs.closeSync(err);
      this.store.db.prepare("UPDATE executions SET pid=? WHERE id=?").run(child.pid ?? null, id);
      const signal = (s: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, s); } catch {} } };
      const cancel = () => { if (cancelled) return; cancelled = true; signal("SIGTERM"); force = setTimeout(() => signal("SIGKILL"), 1000); };
      this.running.set(id, { child, cancel });
      const timeout = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
      let spawnError: Error | undefined;
      child.on("error", e => { spawnError = e; });
      child.on("close", code => {
        if (cancelled) signal("SIGKILL");
        clearTimeout(timeout); if (force) clearTimeout(force); this.running.delete(id);
        const status = timedOut ? "timed_out" : cancelled ? "cancelled" : code === 0 && !spawnError ? "succeeded" : "failed";
        this.store.db.prepare("UPDATE executions SET status=?,finished_at=?,exit_code=? WHERE id=?")
          .run(status, new Date().toISOString(), code, id);
        this.store.event("execution.finished", { status, code }, workItemId, id);
        if (status !== "succeeded") return reject(new Error(`Execution ${id} ${status}${spawnError ? ': ' + spawnError.message : ''}`));
        const file = path.join(logDir, "stdout.log");
        if (fs.statSync(file).size > 10_000_000) return reject(new Error("Agent output exceeds 10 MB"));
        resolve({ id, stdout: fs.readFileSync(file, "utf8") });
      });
    });
  }
  cancel(id: string) { const entry = this.running.get(id); if (!entry) return false; entry.cancel(); return true; }
  cancelAll() { for (const e of this.running.values()) e.cancel(); }
  recover() {
    const rows = this.store.db.prepare("SELECT id,work_item_id FROM executions WHERE status='running'").all() as { id: string; work_item_id: string }[];
    for (const r of rows) {
      this.store.db.prepare("UPDATE executions SET status='failed',finished_at=? WHERE id=?").run(new Date().toISOString(), r.id);
      const w = this.store.get(r.work_item_id);
      if (w && ["SPEC", "DEVELOPMENT", "QA", "REVIEW"].includes(w.state)) { w.context.resume = w.state; this.store.transition(w, "FAILED"); }
      this.store.event("execution.recovered_as_failed", { reason: "Daemon interrupted; inspect worktree and orphan processes before retry" }, r.work_item_id, r.id);
    }
    return rows.length;
  }
}

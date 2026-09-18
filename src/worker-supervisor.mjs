// A per-run process-group leader. IPC disconnect catches daemon crashes without
// trusting a persisted PID (which may have been reused after a restart).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const [runId, logDir] = process.argv.slice(2);
let stopping = false, finished = false;
const record = (status, code) => {
  const file = path.join(logDir, "completion.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify({ runId, status, code, finishedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
};
function terminate(status) {
  if (stopping || finished) return;
  stopping = true;
  try { record(status, null); } catch {}
  // This supervisor was spawned detached and is the leader of this group.
  try { process.kill(-process.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); } }, 500);
}
process.on("disconnect", () => terminate("interrupted"));
process.on("SIGTERM", () => terminate("cancelled"));
process.on("SIGINT", () => terminate("cancelled"));
let request = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { request += chunk; });
process.stdin.on("end", () => {
  if (stopping) return;
  try {
    const { command, args, cwd, input } = JSON.parse(request);
    const child = spawn(command, args, { cwd, env: process.env, detached: false, stdio: ["pipe", "inherit", "inherit"] });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    child.on("error", error => { console.error(error.message); });
    child.on("close", (code, signal) => {
      if (stopping) return;
      finished = true;
      try { record(code === 0 && !signal ? "succeeded" : "failed", code); } catch (error) { console.error(error.message); process.exit(1); }
      process.exit(code === 0 && !signal ? 0 : 1);
    });
  } catch (error) {
    console.error(error.message);
    try { record("failed", 1); } catch {}
    finished = true; process.exit(1);
  }
});

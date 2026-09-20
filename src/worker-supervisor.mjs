// A per-run process-group leader. IPC disconnect catches daemon crashes without
// trusting a persisted PID (which may have been reused after a restart).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const [runId, logDir] = process.argv.slice(2);
let stopping = false, finished = false, worker, stopStatus, stopReason, force;
const record = (status, code, reason) => {
  const file = path.join(logDir, "completion.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify({ runId, status, code, reason, finishedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
};
function terminate(status, reason, escalate) {
  if (finished) return;
  if (stopping) {
    if(escalate&&!force&&worker?.pid){stopStatus=status;stopReason=reason;force=setTimeout(()=>{try{process.kill(-worker.pid,"SIGKILL");}catch{}},1000);}
    return;
  }
  stopping = true;stopStatus=status;stopReason=reason;
  if (!worker?.pid) {try{record(status,null,reason);}catch{}process.exit(1);return;}
  try { process.kill(-worker.pid, "SIGTERM"); } catch {}
  if(escalate)force=setTimeout(()=>{try{process.kill(-worker.pid,"SIGKILL");}catch{}},1000);
}
process.on("disconnect", () => terminate("interrupted","unexpected-shutdown",true));
process.on("SIGTERM", () => terminate("cancelled","user-cancel",true));
process.on("SIGINT", () => terminate("cancelled","user-cancel",true));
process.on("message", message=>{if(message?.type==="interrupt")terminate("interrupted",message.reason??"planned-maintenance",false);else if(message?.type==="cancel")terminate("cancelled","user-cancel",true);});
let request = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { request += chunk; });
process.stdin.on("end", () => {
  if (stopping) return;
  try {
    const { command, args, cwd, input } = JSON.parse(request);
    worker = spawn(command, args, { cwd, env: process.env, detached: true, stdio: ["pipe", "inherit", "inherit"] });
    worker.stdin?.on("error", () => {});
    worker.stdin?.end(input);
    worker.on("error", error => { console.error(error.message); });
    worker.on("close", (code, signal) => {
      if(force)clearTimeout(force);
      if(stopping){finished=true;try{record(stopStatus,code,stopReason);}catch{}process.exit(1);return;}
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

// A per-run process-group leader. IPC disconnect catches daemon crashes without
// trusting a persisted PID (which may have been reused after a restart).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {browserRequired,browserExecutable,createBrowserRunner} from "./browser-runner.mjs";
let browser;
const [runId, logDir] = process.argv.slice(2);
let stopping = false, finished = false, worker, stopStatus, stopReason, force;
const record = (status, code, reason) => {
  const file = path.join(logDir, "completion.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify({ runId, status, code, reason, finishedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
};
async function terminate(status, reason, escalate) {
  if (finished) return;
  if (stopping) {
    if(escalate&&!force&&worker?.pid){stopStatus=status;stopReason=reason;force=setTimeout(()=>{try{process.kill(-worker.pid,"SIGKILL");}catch{}},1000);}
    return;
  }
  stopping = true;stopStatus=status;stopReason=reason;
  if (!worker?.pid) {await browser?.close();try{record(status,null,reason);}catch{}process.exit(1);return;}
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
process.stdin.on("end", async () => {
  if (stopping) return;
  try {
    const { command, args, cwd, role, browserExecutable: executable } = JSON.parse(request);
    let {input}=JSON.parse(request),env={...process.env};
    if(browserRequired(cwd,role)){
      env.FACTORY_BROWSER_REPORT=path.join(logDir,"browser.json");
      browser=createBrowserRunner(browserExecutable(executable));
      try{
        const probe=await browser.start();
        fs.writeFileSync(path.join(logDir,"browser.json"),JSON.stringify({status:"ready",...probe}),{mode:0o600});
        env.FACTORY_BROWSER_CDP_URL=probe.endpoint;env.FACTORY_BROWSER_DEBUG_PORT=String(probe.port);
        env.FACTORY_BROWSER_STATUS="ready";
        console.error(`Factory browser ready: ${probe.browser}; debugging and loopback checks passed.`);
      }catch(error){
        await browser.close();
        fs.writeFileSync(path.join(logDir,"browser.json"),JSON.stringify({status:"unavailable",error:error.message}),{mode:0o600});
        env.FACTORY_BROWSER_STATUS="unavailable";
        console.error(`Factory browser unavailable: ${error.message}`);
      }
    }
    if(stopping)return;
    worker = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "inherit", "inherit"] });
    worker.stdin?.on("error", () => {});
    worker.stdin?.end(input);
    worker.on("error", error => { console.error(error.message); });
    worker.on("close", async (code, signal) => {
      await browser?.close();
      if(force)clearTimeout(force);
      if(stopping){finished=true;try{record(stopStatus,code,stopReason);}catch{}process.exit(1);return;}
      finished = true;
      try { record(code === 0 && !signal ? "succeeded" : "failed", code); } catch (error) { console.error(error.message); process.exit(1); }
      process.exit(code === 0 && !signal ? 0 : 1);
    });
  } catch (error) {
    await browser?.close();
    console.error(error.message);
    try { record("failed", 1); } catch {}
    finished = true; process.exit(1);
  }
});

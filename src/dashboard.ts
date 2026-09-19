import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { config } from "./config.js";
import { Store } from "./storage.js";
import { readDashboardSetting, readDashboardSettings, saveDashboardSettings, validateDashboardSettings } from "./dashboard-settings.js";
import { connectCredential, credentialStatuses, type CredentialProvider } from "./dashboard-credentials.js";
import { SlackAdapter } from "./adapters/slack.js";

const assets = fileURLToPath(new URL("../dashboard/", import.meta.url));
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function daemonState(store: Store) {
  const lockTable = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='daemon_lock'").get();
  const lock = lockTable ? store.db.prepare("SELECT pid FROM daemon_lock WHERE id=1").get() as { pid: number } | undefined : undefined;
  return { running:Boolean(lock && alive(lock.pid)), pid:lock?.pid ?? null };
}
function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function details(payload: string) {
  try {
    const value = JSON.parse(payload);
    if (!value || typeof value !== "object") return String(value ?? "");
    const parts: string[] = [];
    for (const [key,item] of Object.entries(value)) {
      if (item === null || item === undefined || item === "") continue;
      if (key === "result" && typeof item === "object") {
        const result = item as { outcome?: string; summary?: string };
        if (result.outcome) parts.push(`outcome: ${result.outcome}`);
        if (result.summary) parts.push(result.summary);
      } else if (Array.isArray(item)) parts.push(`${key}: ${item.length} item${item.length === 1 ? "" : "s"}`);
      else if (typeof item === "object") {
        const summary = Object.entries(item).filter(([,nested]) => ["string","number","boolean"].includes(typeof nested)).slice(0,3).map(([nestedKey,nested]) => `${nestedKey}: ${nested}`).join(", ");
        parts.push(`${key}: ${summary || "details recorded"}`);
      } else parts.push(`${key}: ${String(item)}`);
    }
    const text = parts.join(" · ");
    return text.length > 420 ? `${text.slice(0,417)}…` : text;
  } catch { return payload; }
}
function snapshot(store: Store) {
  const items = store.items().slice().reverse().map(item => ({
    id: item.id, issue: item.issue_number, repo: item.repo, state: item.state, title: item.context.title,
    url: item.context.url, pr: item.context.pr ?? null, updatedAt: (store.db.prepare("SELECT updated_at FROM work_items WHERE id=?").get(item.id) as any).updated_at,
  }));
  const executions = store.db.prepare("SELECT id,work_item_id,role,status,pid,started_at,finished_at,exit_code FROM executions ORDER BY started_at DESC LIMIT 30").all();
  const events = (store.db.prepare("SELECT id,ts,work_item_id,type,payload FROM events ORDER BY id DESC LIMIT 60").all() as any[])
    .map(event => ({ id:event.id, ts:event.ts, workItemId:event.work_item_id, type:event.type, details:details(event.payload) }));
  const lastRefresh = store.db.prepare("SELECT id,handled FROM controls WHERE kind='refresh-list' ORDER BY id DESC LIMIT 1").get() as { id:number; handled:number } | undefined;
  let issueRefresh: { status:"queued" | "completed" | "failed"; message:string } | null = null;
  if (lastRefresh) {
    if (!lastRefresh.handled) issueRefresh={status:"queued",message:"Waiting for the daemon to refresh GitHub issues…"};
    else {
      const outcome = (store.db.prepare("SELECT type,payload FROM events WHERE type IN ('control.applied','control.failed') ORDER BY id DESC").all() as Array<{type:string;payload:string}>).map(event => {
        try { return {...event,data:JSON.parse(event.payload) as { id?:number; error?:string; result?:{found?:number;added?:number;updated?:number} }}; } catch { return null; }
      }).find(event => event?.data.id === lastRefresh.id);
      if (outcome?.type === "control.failed") issueRefresh={status:"failed",message:outcome.data.error ?? "GitHub issue refresh failed."};
      else if (outcome?.type === "control.applied") {
        const result=outcome.data.result;
        issueRefresh={status:"completed",message:result ? `Found ${result.found ?? 0} queued issue${result.found === 1 ? "" : "s"}; added ${result.added ?? 0}, updated ${result.updated ?? 0}.` : "GitHub issue refresh completed."};
      }
    }
  }
  return { generatedAt:new Date().toISOString(), repository:config.repo, branch:config.defaultBranch, daemon:daemonState(store), issueRefresh, items, executions, events };
}
async function readBody(req: http.IncomingMessage) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 32768) throw new Error("Request body is too large");
  }
  return JSON.parse(body || "{}");
}
function asset(res: http.ServerResponse, name: string) {
  const file = path.join(assets, name);
  try {
    const content = fs.readFileSync(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(content);
  } catch { res.writeHead(404).end("Not found"); }
}
function serviceStatus(root: string, service: "daemon" | "dashboard") {
  const result = spawnSync("bash",[path.join(root,"scripts/services.sh"),"status",service],{cwd:root,encoding:"utf8",timeout:10000});
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { service, loaded:result.status === 0 && output.includes(`${service}: loaded`), running:/state = (running|active)/.test(output), detail:output.trim() };
}
type UpdateState = { status: "idle" | "updating" | "completed" | "failed"; phase?: string; pid?: number; startedAt?: string; updatedAt?: string; finishedAt?: string };
type VersionInfo = { number: string; revision: string; branch: string; display: string };
const updateStateFile = (root: string) => path.join(root,".factory","update-state.json");
function git(root: string, args: string[], timeout = 10000) {
  const result = spawnSync(config.gitCommand,args,{cwd:root,encoding:"utf8",timeout});
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  return result.stdout.trim();
}
function versionInfo(root: string): VersionInfo {
  const manifest = JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8")) as { version?: string };
  const revision = git(root,["rev-parse","--short","HEAD"]);
  const branch = git(root,["symbolic-ref","--quiet","--short","HEAD"]);
  const number = manifest.version ?? "0.0.0";
  return { number,revision,branch,display:`v${number} · ${revision}` };
}
function checkUpdate(root: string) {
  const current = versionInfo(root);
  const currentFull = git(root,["rev-parse","HEAD"]);
  git(root,["fetch","origin",`refs/heads/${current.branch}`],30000);
  const latestFull = git(root,["rev-parse","FETCH_HEAD"]);
  const latest = git(root,["rev-parse","--short","FETCH_HEAD"]);
  if (latestFull !== currentFull) git(root,["merge-base","--is-ancestor",currentFull,latestFull]);
  return { current,latest,available:latestFull !== currentFull,checkedAt:new Date().toISOString() };
}
function writeUpdateState(root: string, state: UpdateState) {
  const file = updateStateFile(root);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(state,null,2),{mode:0o600});
  fs.renameSync(temporary,file);
}
function processAlive(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid,0);
    const command = spawnSync("ps",["-p",String(pid),"-o","command="],{encoding:"utf8",timeout:3000});
    return command.status === 0 && /(?:scripts\/update(?:-job)?\.sh|factory-dashboard-update)/.test(command.stdout);
  } catch { return false; }
}
function updateState(root: string): UpdateState {
  const file = updateStateFile(root);
  if (!fs.existsSync(file)) return { status:"idle" };
  try {
    const state = JSON.parse(fs.readFileSync(file,"utf8")) as UpdateState;
    const awaitingPid = state.status === "updating" && !state.pid && Date.now()-new Date(state.startedAt ?? 0).getTime() < 30000;
    if (state.status === "updating" && !awaitingPid && !processAlive(state.pid)) {
      const failed = { ...state,status:"failed" as const,phase:"Update process stopped unexpectedly. Inspect update.log.",finishedAt:new Date().toISOString() };
      writeUpdateState(root,failed); return failed;
    }
    return state;
  } catch { return { status:"failed",phase:"Update status could not be read. Inspect update.log." }; }
}
function runService(root: string, service: "daemon" | "dashboard", action: "start" | "stop" | "restart") {
  const script = path.join(root,"scripts/services.sh");
  if (service === "dashboard" && ["stop","restart"].includes(action)) {
    const child = spawn("/bin/bash",["-c",'sleep 0.5; exec bash "$1" "$2" dashboard',"factory-dashboard-control",script,action],{cwd:root,detached:true,stdio:"ignore"});
    child.unref();
    return { accepted:true, message:`Dashboard ${action} scheduled; this page may reconnect.` };
  }
  const result = spawnSync("bash",[script,action,service],{cwd:root,encoding:"utf8",timeout:30000});
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${service} ${action} failed`).trim());
  return { accepted:true, message:`${service} ${action} completed.` };
}
function runUpdate(root: string) {
  const current = updateState(root);
  if (current.status === "updating") throw new Error("A factory update is already running");
  const logs = path.join(root,".factory","service-logs");
  fs.mkdirSync(logs,{recursive:true});
  const logFile = path.join(logs,"update.log");
  const stateFile = updateStateFile(root);
  writeUpdateState(root,{status:"updating",phase:"Preparing update…",startedAt:new Date().toISOString()});
  if (process.platform === "darwin" && serviceStatus(root,"dashboard").loaded) {
    const label = `com.ai-factory.update.${Date.now()}`;
    const submitted = spawnSync("launchctl",["submit","-l",label,"-o",logFile,"-e",logFile,"--","/bin/bash",path.join(root,"scripts/update-job.sh"),stateFile,path.join(root,"scripts/update.sh"),label],{cwd:root,encoding:"utf8",timeout:10000});
    if (submitted.status !== 0) {
      writeUpdateState(root,{status:"failed",phase:"Could not start the independent update job.",finishedAt:new Date().toISOString()});
      throw new Error((submitted.stderr || submitted.stdout || "Could not start the independent update job").trim());
    }
  } else {
    const output = fs.openSync(logFile,"a");
    const child = spawn("/bin/bash",["-c",'sleep 0.75; exec bash "$1" --restart-services',"factory-dashboard-update",path.join(root,"scripts/update.sh")],{
      cwd:root,detached:true,stdio:["ignore",output,output],env:{...process.env,AI_FACTORY_UPDATE_STATE_FILE:stateFile}
    });
    fs.closeSync(output);
    writeUpdateState(root,{status:"updating",phase:"Preparing update…",pid:child.pid,startedAt:new Date().toISOString()});
    child.unref();
  }
  return { accepted:true,message:"Factory update started. Services will stop, update, and reconnect when ready.",update:updateState(root) };
}
function slackStatus(root: string, store: Store) {
  const configured = Boolean(readDashboardSetting(root,"SLACK_WEBHOOK_URL"));
  const counts = store.db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN sent=0 THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN sent=0 AND attempts>0 THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN sent=1 THEN 1 ELSE 0 END) AS sent FROM notifications").get() as { total:number; pending:number | null; failed:number | null; sent:number | null };
  const last = store.db.prepare("SELECT last_error FROM notifications WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 1").get() as { last_error:string } | undefined;
  return { configured,pending:counts.pending ?? 0,failed:counts.failed ?? 0,sent:counts.sent ?? 0,lastError:last?.last_error ?? null };
}
type SetupRequirement = { id: string; label: string; group: "credentials" | "project" | "access" };
function normalizedRepository(value: string) {
  return value.trim().replace(/^https?:\/\/github\.com\//,"https://github.com/").replace(/^git@github\.com:/,"https://github.com/").replace(/\.git$/i,"").replace(/\/$/,"").toLowerCase();
}
function setupReadiness(root: string, credentials: ReturnType<typeof credentialStatuses>) {
  const missing: SetupRequirement[] = [];
  const require = (condition: boolean, requirement: SetupRequirement) => { if (!condition) missing.push(requirement); };
  const repository = readDashboardSetting(root,"GITHUB_REPOSITORY").trim();
  const repoDirValue = readDashboardSetting(root,"FACTORY_REPO_DIR").trim();
  const repoDir = repoDirValue ? path.resolve(root,repoDirValue) : "";
  const approvers = readDashboardSetting(root,"FACTORY_APPROVERS").split(",").map(item => item.trim()).filter(Boolean);
  const gitCommand = readDashboardSetting(root,"GIT_COMMAND").trim() || config.gitCommand;
  const credential = (id: CredentialProvider) => credentials.credentials.find(item => item.id === id);
  const github = credential("github");

  require(Boolean(github?.installed && github.connected),{
    id:"github-credential",label:github?.installed ? "Connect GitHub." : "Install the GitHub CLI and connect GitHub.",group:"credentials",
  });
  const selectedProviders = new Set(["PRODUCT_ARCHITECT","DEVELOPER","QA","REVIEWER"].map(role => readDashboardSetting(root,`${role}_PROVIDER`) as CredentialProvider));
  for (const provider of ["claude","codex"] as const) {
    if (!selectedProviders.has(provider)) continue;
    const status = credential(provider), label = provider === "claude" ? "Claude" : "Codex";
    require(Boolean(status?.installed && status.connected),{
      id:`${provider}-credential`,label:status?.installed ? `Connect ${label}; at least one agent role uses it.` : `Install and connect ${label}; at least one agent role uses it.`,group:"credentials",
    });
  }

  require(/^[\w.-]+\/[\w.-]+$/.test(repository),{id:"repository",label:"Choose the GitHub repository to process.",group:"project"});
  require(Boolean(approvers.length),{id:"approvers",label:"Add at least one authorized approver.",group:"access"});
  const checkoutExists = Boolean(repoDir && fs.existsSync(repoDir) && fs.statSync(repoDir).isDirectory());
  if (!checkoutExists) {
    require(false,{id:"checkout",label:"Choose an existing local checkout of the target repository.",group:"project"});
  } else {
    const runGit = (args: string[]) => spawnSync(gitCommand,args,{cwd:repoDir,encoding:"utf8",timeout:5000});
    const inside = runGit(["rev-parse","--is-inside-work-tree"]);
    if (inside.status !== 0 || inside.stdout.trim() !== "true") {
      require(false,{id:"checkout-git",label:"Use a target checkout that is a Git working tree.",group:"project"});
    } else {
      const name = runGit(["config","user.name"]), email = runGit(["config","user.email"]);
      require(name.status === 0 && Boolean(name.stdout.trim()) && email.status === 0 && Boolean(email.stdout.trim()),{
        id:"git-identity",label:"Configure Git user.name and user.email for the target checkout.",group:"project",
      });
      if (/^[\w.-]+\/[\w.-]+$/.test(repository)) {
        const origin = runGit(["remote","get-url","origin"]), expected = `https://github.com/${repository}`;
        require(origin.status === 0 && normalizedRepository(origin.stdout) === normalizedRepository(expected),{
          id:"origin",label:`Point the target checkout origin to ${repository}.`,group:"project",
        });
      }
    }
  }
  return { ready:missing.length === 0,missing };
}
function dashboardSettings(root: string) {
  const credentials = credentialStatuses(root);
  const github = credentials.credentials.find(item => item.id === "github");
  const login = github?.status === "connected" ? github.account : undefined;
  const settings = readDashboardSettings(root,login ? {
    GITHUB_REPOSITORY:`${login}/ai-factory-demo`,
    FACTORY_REPO_DIR:path.join(os.homedir(),"Source","ai-factory-demo"),
    FACTORY_APPROVERS:login,
  } : {});
  return {...settings,readiness:setupReadiness(root,credentials)};
}
function saveConfiguration(store: Store, root: string, values: Record<string,unknown>, clearSecrets: string[] = []) {
  const plan = validateDashboardSettings(root,values,clearSecrets);
  if (!plan.changedKeys.length) return {...dashboardSettings(root),daemonRunning:daemonState(store).running,restartedServices:[],dashboardRestarting:false,message:"Configuration is already up to date."};
  const daemon = serviceStatus(root,"daemon"), dashboard = serviceStatus(root,"dashboard");
  const daemonActive = daemonState(store).running || daemon.running;
  const restartDaemon = plan.restartServices.includes("daemon") && daemonActive;
  const restartDashboard = plan.restartServices.includes("dashboard") && dashboard.running;
  if (plan.restartServices.includes("daemon") && daemonActive && !daemon.loaded) throw new Error("The daemon is running outside the service manager. Stop it, then save again.");
  let daemonStopped = false;
  try {
    if (restartDaemon) { runService(root,"daemon","stop"); daemonStopped=true; }
    saveDashboardSettings(root,values,clearSecrets);
  } catch (error) {
    if (daemonStopped) try { runService(root,"daemon","start"); } catch {}
    throw error;
  }
  const restartedServices: string[] = [];
  if (restartDaemon) {
    try { runService(root,"daemon","start"); restartedServices.push("daemon"); }
    catch (error) { throw new Error(`Configuration was saved, but the daemon could not restart: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (restartDashboard) { runService(root,"dashboard","restart"); restartedServices.push("dashboard"); }
  const message = restartedServices.length ? `Configuration saved. Restarting ${restartedServices.join(" and ")}.` : "Configuration saved. Stopped services were left stopped.";
  return {...dashboardSettings(root),daemonRunning:daemonState(store).running,restartedServices,dashboardRestarting:restartDashboard,message};
}

export function createDashboardServer(store: Store, settingsRoot = process.cwd()) {
  const runtimeVersion = versionInfo(settingsRoot);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/api/snapshot") return json(res,200,snapshot(store));
      if (req.method === "GET" && url.pathname === "/api/stream") {
        res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform","connection":"keep-alive"});
        const send = () => { if (!res.destroyed) res.write(`data: ${JSON.stringify(snapshot(store))}\n\n`); };
        send();
        const timer = setInterval(send,2000);
        timer.unref();
        req.on("close",() => clearInterval(timer));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/settings") return json(res,200,{...dashboardSettings(settingsRoot),daemonRunning:daemonState(store).running});
      if (req.method === "GET" && url.pathname === "/api/credentials") return json(res,200,credentialStatuses(settingsRoot));
      if (req.method === "GET" && url.pathname === "/api/slack") return json(res,200,slackStatus(settingsRoot,store));
      if (req.method === "GET" && url.pathname === "/api/services") return json(res,200,{services:[serviceStatus(settingsRoot,"daemon"),serviceStatus(settingsRoot,"dashboard")],update:updateState(settingsRoot),version:runtimeVersion});
      if (req.method === "POST" && url.pathname === "/api/update/check") return json(res,200,checkUpdate(settingsRoot));
      if (req.method === "GET" && url.pathname === "/healthz") return json(res,200,{ok:true});
      if (req.method === "PUT" && url.pathname === "/api/settings") {
        const body = await readBody(req) as { values?: Record<string,unknown>; clearSecrets?: string[] };
        if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) return json(res,400,{error:"Settings are required"});
        return json(res,200,saveConfiguration(store,settingsRoot,body.values,Array.isArray(body.clearSecrets) ? body.clearSecrets : []));
      }
      if (req.method === "POST" && url.pathname === "/api/control") {
        const body = await readBody(req) as { kind?: string; target?: string };
        if (!["stop","cancel","retry","refresh","refresh-list"].includes(body.kind ?? "")) return json(res,400,{error:"Unknown control"});
        if (!["stop","refresh-list"].includes(body.kind ?? "") && !body.target) return json(res,400,{error:"A work item or run id is required"});
        if (["refresh","refresh-list"].includes(body.kind ?? "") && !daemonState(store).running) return json(res,409,{error:"Start the daemon before refreshing GitHub issues."});
        store.request(body.kind!,body.target ?? "");
        return json(res,202,{ok:true,message:body.kind === "refresh-list" ? "GitHub issue refresh queued." : `${body.kind} queued`});
      }
      if (req.method === "POST" && url.pathname === "/api/services") {
        const body = await readBody(req) as { service?: string; action?: string };
        if (!['daemon','dashboard'].includes(body.service ?? "") || !['start','stop','restart'].includes(body.action ?? "")) return json(res,400,{error:"Unknown service action"});
        return json(res,202,runService(settingsRoot,body.service as "daemon" | "dashboard",body.action as "start" | "stop" | "restart"));
      }
      if (req.method === "POST" && url.pathname === "/api/credentials/connect") {
        const body = await readBody(req) as { provider?: string };
        if (!['github','claude','codex'].includes(body.provider ?? "")) return json(res,400,{error:"Unknown credential provider"});
        return json(res,202,connectCredential(settingsRoot,body.provider as CredentialProvider));
      }
      if (req.method === "PUT" && url.pathname === "/api/slack") {
        const body = await readBody(req) as { webhook?: unknown; clear?: unknown };
        if (typeof body.webhook !== "string" || typeof body.clear !== "boolean") return json(res,400,{error:"Webhook and clear flag are required"});
        const saved = saveConfiguration(store,settingsRoot,{SLACK_WEBHOOK_URL:body.clear ? "" : body.webhook},body.clear ? ["SLACK_WEBHOOK_URL"] : []);
        return json(res,200,{...slackStatus(settingsRoot,store),message:body.clear ? `Slack connection removed. ${saved.message}` : `Slack webhook saved. ${saved.message}`});
      }
      if (req.method === "POST" && url.pathname === "/api/slack/test") {
        const webhook = readDashboardSetting(settingsRoot,"SLACK_WEBHOOK_URL");
        if (!webhook) return json(res,409,{error:"Configure and save a Slack webhook first"});
        await new SlackAdapter(webhook).notify("🧪 AI Factory connection test\n\nSlack test notification from the dashboard was delivered successfully. No action is required. Workflow decisions remain in GitHub.");
        return json(res,200,{...slackStatus(settingsRoot,store),message:"Slack test notification delivered."});
      }
      if (req.method === "POST" && url.pathname === "/api/update") {
        const check = checkUpdate(settingsRoot);
        if (!check.available) return json(res,409,{error:`${check.current.display} is already up to date`,check});
        return json(res,202,{...runUpdate(settingsRoot),check});
      }
      if (req.method !== "GET") return json(res,405,{error:"Method not allowed"});
      const files: Record<string,string> = { "/":"index.html", "/index.html":"index.html", "/app.js":"app.js", "/styles.css":"styles.css" };
      return files[url.pathname] ? asset(res,files[url.pathname]) : json(res,404,{error:"Not found"});
    } catch (error) { return json(res,400,{error:error instanceof Error ? error.message : String(error)}); }
  });
}

export async function startDashboard(store: Store, host = config.dashboardHost, port = config.dashboardPort, settingsRoot = process.cwd()) {
  const server = createDashboardServer(store,settingsRoot);
  await new Promise<void>((resolve,reject) => { server.once("error",reject); server.listen(port,host,resolve); });
  const address = server.address() as AddressInfo;
  const displayHost = address.address === "::1" ? "[::1]" : address.address;
  console.log(`AI Factory dashboard: http://${displayHost}:${address.port}`);
  return server;
}

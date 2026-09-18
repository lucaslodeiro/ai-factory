import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { config } from "./config.js";
import { Store } from "./storage.js";
import { readDashboardSettings, saveDashboardSettings } from "./dashboard-settings.js";

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
  return { generatedAt:new Date().toISOString(), repository:config.repo, branch:config.defaultBranch, daemon:daemonState(store), items, executions, events };
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

export function createDashboardServer(store: Store, settingsRoot = process.cwd()) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/api/snapshot") return json(res,200,snapshot(store));
      if (req.method === "GET" && url.pathname === "/api/settings") return json(res,200,{...readDashboardSettings(settingsRoot),daemonRunning:daemonState(store).running});
      if (req.method === "GET" && url.pathname === "/healthz") return json(res,200,{ok:true});
      if (req.method === "PUT" && url.pathname === "/api/settings") {
        if (daemonState(store).running) return json(res,409,{error:"Stop the daemon before changing configuration"});
        const body = await readBody(req) as { values?: Record<string,unknown>; clearSecrets?: string[] };
        if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) return json(res,400,{error:"Settings are required"});
        const saved = saveDashboardSettings(settingsRoot,body.values,Array.isArray(body.clearSecrets) ? body.clearSecrets : []);
        return json(res,200,{...saved,message:"Configuration saved. Restart affected services to apply it."});
      }
      if (req.method === "POST" && url.pathname === "/api/control") {
        const body = await readBody(req) as { kind?: string; target?: string };
        if (!["stop","cancel","retry"].includes(body.kind ?? "")) return json(res,400,{error:"Unknown control"});
        if (body.kind !== "stop" && !body.target) return json(res,400,{error:"A work item or run id is required"});
        store.request(body.kind!,body.target ?? "");
        return json(res,202,{ok:true,message:`${body.kind} queued`});
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

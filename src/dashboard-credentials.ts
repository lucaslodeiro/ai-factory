import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { config } from "./config.js";
import { factoryHome } from "./home.js";

export type CredentialProvider = "github" | "claude" | "codex";
type StoredState = { status: "connecting" | "failed"; pid?: number; startedAt?: string; finishedAt?: string };

const providers: Array<{ id: CredentialProvider; label: string; description: string }> = [
  { id:"github",label:"GitHub",description:"Issues, pull requests and authenticated Git operations." },
  { id:"claude",label:"Claude",description:"Product, architecture and review agents." },
  { id:"codex",label:"Codex",description:"Builder and Tester agents." },
];

const stateFile = (root: string) => path.join(factoryHome(root),"data","credential-state.json");
const logFile = (root: string) => path.join(factoryHome(root),"data","service-logs","credentials.log");
const githubCommand = () => process.env.GH_COMMAND || "gh";

function processAlive(pid?: number) {
  if (!pid) return false;
  try { process.kill(pid,0); return true; } catch { return false; }
}
function readState(root: string): Partial<Record<CredentialProvider,StoredState>> {
  try { return JSON.parse(fs.readFileSync(stateFile(root),"utf8")); } catch { return {}; }
}
function writeState(root: string, states: Partial<Record<CredentialProvider,StoredState>>) {
  const file = stateFile(root);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(states,null,2),{mode:0o600});
  fs.renameSync(temporary,file);
}
function saveProviderState(root: string, provider: CredentialProvider, state: StoredState) {
  writeState(root,{...readState(root),[provider]:state});
}
function run(root: string, command: string, args: string[]) {
  return spawnSync(command,args,{cwd:root,encoding:"utf8",timeout:15000,env:process.env});
}
function actualStatus(root: string, provider: CredentialProvider) {
  if (provider === "github") {
    const auth = run(root,githubCommand(),["auth","status","--hostname","github.com"]);
    if (auth.error) return { installed:false,connected:false };
    if (auth.status !== 0) return { installed:true,connected:false };
    const account = run(root,githubCommand(),["api","user","--jq",".login"]);
    return { installed:true,connected:true,account:account.status === 0 ? account.stdout.trim() : undefined };
  }
  if (provider === "codex") {
    const auth = run(root,config.codexCommand,["login","status"]);
    return { installed:!auth.error,connected:!auth.error && auth.status === 0 };
  }
  const auth = run(root,config.claudeCommand,["auth","status"]);
  if (auth.error) return { installed:false,connected:false };
  try {
    const parsed = JSON.parse(auth.stdout) as { loggedIn?: boolean; email?: string };
    return { installed:true,connected:auth.status === 0 && parsed.loggedIn === true,account:parsed.loggedIn ? parsed.email : undefined };
  } catch { return { installed:true,connected:false }; }
}

export function credentialStatuses(root: string) {
  const stored = readState(root);
  let changed = false;
  const credentials = providers.map(provider => {
    const actual = actualStatus(root,provider.id);
    const pending = stored[provider.id];
    if (pending?.status === "connecting" && processAlive(pending.pid)) return {...provider,...actual,status:"connecting" as const,startedAt:pending.startedAt};
    if (actual.connected) return {...provider,...actual,status:"connected" as const};
    if (pending?.status === "connecting") {
      stored[provider.id] = {...pending,status:"failed",finishedAt:new Date().toISOString()};
      changed = true;
      return {...provider,...actual,status:"failed" as const};
    }
    return {...provider,...actual,status:pending?.status === "failed" ? "failed" as const : "disconnected" as const};
  });
  if (changed) writeState(root,stored);
  return { credentials,log:"data/service-logs/credentials.log" };
}

export function connectCredential(root: string, provider: CredentialProvider) {
  if (!providers.some(item => item.id === provider)) throw new Error("Unknown credential provider");
  const existing = readState(root)[provider];
  if (existing?.status === "connecting" && processAlive(existing.pid)) throw new Error(`${provider} login is already running`);
  const current = actualStatus(root,provider);
  if (!current.installed) throw new Error(`${providers.find(item => item.id === provider)!.label} CLI is not installed or cannot be executed`);

  const log = logFile(root);
  fs.mkdirSync(path.dirname(log),{recursive:true});
  const output = fs.openSync(log,"a",0o600);
  const command = provider === "github" ? "/bin/bash" : provider === "claude" ? config.claudeCommand : config.codexCommand;
  const githubScript = current.connected
    ? '"$1" auth refresh --hostname github.com --reset-scopes && "$1" auth setup-git --hostname github.com'
    : '"$1" auth login --hostname github.com --git-protocol https --web && "$1" auth setup-git --hostname github.com';
  const args = provider === "github"
    ? ["-c",githubScript,"factory-github-login",githubCommand()]
    : provider === "claude" ? ["auth","login"] : ["login"];
  const child = spawn(command,args,{cwd:root,detached:true,stdio:["ignore",output,output],env:process.env});
  fs.closeSync(output);
  const startedAt = new Date().toISOString();
  saveProviderState(root,provider,{status:"connecting",pid:child.pid,startedAt});
  child.once("error",() => saveProviderState(root,provider,{status:"failed",startedAt,finishedAt:new Date().toISOString()}));
  child.once("exit",() => {
    const authenticated = actualStatus(root,provider).connected;
    if (!authenticated) saveProviderState(root,provider,{status:"failed",startedAt,finishedAt:new Date().toISOString()});
  });
  child.unref();
  const action = provider === "github" && current.connected ? "reauthentication" : "login";
  return { accepted:true,message:`${providers.find(item => item.id === provider)!.label} ${action} opened on this Mac. Complete it in the browser, then refresh status.` };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
if (args.some(arg => ["-h","--help"].includes(arg))) {
  console.log("Usage: ai-factory uninstall [--yes] [--force]\nRemoves AI Factory services, configuration, local runtime data and this installation. Target repositories, shared tools and provider credentials are preserved.\nRun `ai-factory help` for every command.");
  process.exit(0);
}
if (args.some(arg => !["--yes","--force"].includes(arg))) throw new Error("Unknown option. Use --help.");
const confirmed = args.includes("--yes");
const forced = args.includes("--force");
const root = path.resolve(fileURLToPath(new URL("..",import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
if (manifest.name !== "ai-factory") throw new Error(`Refusing to remove an unrecognized directory: ${root}`);

const home = path.resolve(os.homedir());
const envText = fs.existsSync(path.join(root,".env")) ? fs.readFileSync(path.join(root,".env"),"utf8") : "";
const envValue = key => {
  const raw = envText.match(new RegExp(`^${key}=(.*)$`,`m`))?.[1]?.trim() ?? "";
  return raw.length >= 2 && ["'",'"',"`"].includes(raw[0]) && raw.at(-1) === raw[0] ? raw.slice(1,-1) : raw;
};
const values = { FACTORY_DATA_DIR:envValue("FACTORY_DATA_DIR"),FACTORY_REPO_DIR:envValue("FACTORY_REPO_DIR") };
const dataDir = path.resolve(root,values.FACTORY_DATA_DIR || ".factory");
const targetDir = values.FACTORY_REPO_DIR ? path.resolve(root,values.FACTORY_REPO_DIR) : null;
const externalData = dataDir !== root && !dataDir.startsWith(`${root}${path.sep}`);
const plists = ["daemon","dashboard"].map(service => path.join(home,"Library","LaunchAgents",`com.ai-factory.${service}.plist`));
const launcher = path.join(home,".local","bin","ai-factory");

if ([path.parse(root).root,home,path.dirname(home)].includes(root)) throw new Error(`Unsafe installation path: ${root}`);
if (externalData && ([path.parse(dataDir).root,home,path.dirname(home),targetDir].filter(Boolean).includes(dataDir))) throw new Error(`Unsafe configured data directory: ${dataDir}`);
if (externalData && fs.existsSync(dataDir) && !fs.existsSync(path.join(dataDir,"factory.db"))) throw new Error(`Refusing to remove external data without a factory.db marker: ${dataDir}`);

console.log("AI Factory uninstall plan");
console.log(`  Services:     daemon and dashboard LaunchAgents`);
console.log(`  Installation: ${root}`);
if (externalData) console.log(`  Runtime data: ${dataDir}`);
console.log("  Preserved:    target repository, GitHub/Codex/Claude credentials, Node, Git, gh, Codex and Claude CLIs");

let unpublished=[];
const databaseFile=path.join(dataDir,"factory.db");
if (!fs.existsSync(databaseFile)) {
  console.log("  Work preflight: no factory database was found; continuing without workflow inspection.");
} else {
  try {
    const db=new Database(databaseFile,{readonly:true,fileMustExist:true});
    let active=[];
    try {
      active=db.prepare("SELECT issue_number,stage,status,branch FROM work_items WHERE status IN ('QUEUED','RUNNING','WAITING','PAUSED') ORDER BY issue_number").all();
    } finally { db.close(); }
    const gitCommand=envValue("GIT_COMMAND") || "git";
    unpublished=active.map(item=>{
      if (!item.branch || !targetDir || !fs.existsSync(targetDir)) return {...item,published:false,publication:"unverifiable"};
      const remote=spawnSync(gitCommand,["ls-remote","--heads","origin",item.branch],{cwd:targetDir,encoding:"utf8",timeout:10000});
      const published=remote.status===0 && Boolean(remote.stdout.trim());
      return {...item,published,publication:remote.status===0 ? (published ? "published" : "unpublished") : "unverifiable"};
    }).filter(item=>!item.published);
    console.log(`  Work preflight: ${active.length} active item${active.length===1?"":"s"}; ${unpublished.length} with an unpublished or unverifiable branch.`);
    for (const item of unpublished) console.log(`    #${item.issue_number} ${item.stage}/${item.status} — ${item.branch || "no branch"} (${item.publication})`);
  } catch (error) {
    console.log(`  Work preflight: factory.db could not be inspected (${error.message}); continuing without workflow inspection.`);
  }
}

if (confirmed && unpublished.length && !forced) throw new Error("Unpublished active work would be removed. Re-run with --yes --force after reviewing the list above.");

if (!confirmed) {
  if (!process.stdin.isTTY) throw new Error("Interactive confirmation unavailable. Re-run with --yes after reviewing the paths above.");
  const prompt = readline.createInterface({input:process.stdin,output:process.stdout});
  const answer = await prompt.question('Type "uninstall" to permanently remove this factory installation: ');
  if (answer !== "uninstall") { prompt.close(); console.log("Uninstall cancelled."); process.exit(0); }
  if (unpublished.length && !forced) {
    const forceAnswer=await prompt.question('Unpublished active work may be lost. Type "force" to continue: ');
    if (forceAnswer !== "force") { prompt.close(); console.log("Uninstall cancelled."); process.exit(0); }
  }
  prompt.close();
}

if (process.platform === "darwin" && process.env.AI_FACTORY_UNINSTALL_SKIP_LAUNCHCTL !== "1") {
  const domain = `gui/${process.getuid()}`;
  const jobs = spawnSync("launchctl",["list"],{encoding:"utf8"});
  for (const line of (jobs.stdout ?? "").split("\n")) {
    const label = line.trim().split(/\s+/).at(-1) ?? "";
    if (label.startsWith("com.ai-factory.update.")) spawnSync("launchctl",["remove",label],{encoding:"utf8"});
  }
  for (const service of ["daemon","dashboard"]) {
    // bootout returns non-zero when a service is already unloaded, which is safe here.
    spawnSync("launchctl",["bootout",`${domain}/com.ai-factory.${service}`],{encoding:"utf8"});
  }
}
for (const plist of plists) fs.rmSync(plist,{force:true});
try {
  if (fs.lstatSync(launcher).isSymbolicLink() && path.resolve(path.dirname(launcher),fs.readlinkSync(launcher)) === path.join(root,"scripts","ai-factory")) fs.rmSync(launcher,{force:true});
} catch {}
if (externalData) fs.rmSync(dataDir,{recursive:true,force:true});
const callerWasInsideInstallation = process.cwd() === root || process.cwd().startsWith(`${root}${path.sep}`);
if (callerWasInsideInstallation) process.chdir(home);
fs.rmSync(root,{recursive:true,force:true});
console.log("AI Factory was uninstalled. Target repositories, shared tools and provider credentials were preserved.");
if (callerWasInsideInstallation) console.log(`Your parent shell may still reference the removed directory. Run: cd ${home}`);

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: npm run uninstall -- [--yes]\nRemoves AI Factory services, configuration, local runtime data and this installation. Target repositories, shared tools and provider credentials are preserved.");
  process.exit(0);
}
if (args.some(arg => arg !== "--yes")) throw new Error("Unknown option. Use --help.");
const confirmed = args.includes("--yes");
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

if ([path.parse(root).root,home,path.dirname(home)].includes(root)) throw new Error(`Unsafe installation path: ${root}`);
if (externalData && ([path.parse(dataDir).root,home,path.dirname(home),targetDir].filter(Boolean).includes(dataDir))) throw new Error(`Unsafe configured data directory: ${dataDir}`);
if (externalData && fs.existsSync(dataDir) && !fs.existsSync(path.join(dataDir,"factory.db"))) throw new Error(`Refusing to remove external data without a factory.db marker: ${dataDir}`);

console.log("AI Factory uninstall plan");
console.log(`  Services:     daemon and dashboard LaunchAgents`);
console.log(`  Installation: ${root}`);
if (externalData) console.log(`  Runtime data: ${dataDir}`);
console.log("  Preserved:    target repository, GitHub/Codex/Claude credentials, Node, Git, gh, Codex and Claude CLIs");

if (!confirmed) {
  if (!process.stdin.isTTY) throw new Error("Interactive confirmation unavailable. Re-run with --yes after reviewing the paths above.");
  const prompt = readline.createInterface({input:process.stdin,output:process.stdout});
  const answer = await prompt.question('Type "uninstall" to permanently remove this factory installation: ');
  prompt.close();
  if (answer !== "uninstall") { console.log("Uninstall cancelled."); process.exit(0); }
}

if (process.platform === "darwin" && process.env.AI_FACTORY_UNINSTALL_SKIP_LAUNCHCTL !== "1") {
  const domain = `gui/${process.getuid()}`;
  for (const service of ["daemon","dashboard"]) {
    // bootout returns non-zero when a service is already unloaded, which is safe here.
    spawnSync("launchctl",["bootout",`${domain}/com.ai-factory.${service}`],{encoding:"utf8"});
  }
}
for (const plist of plists) fs.rmSync(plist,{force:true});
if (externalData) fs.rmSync(dataDir,{recursive:true,force:true});
const callerWasInsideInstallation = process.cwd() === root || process.cwd().startsWith(`${root}${path.sep}`);
if (callerWasInsideInstallation) process.chdir(home);
fs.rmSync(root,{recursive:true,force:true});
console.log("AI Factory was uninstalled. Target repositories, shared tools and provider credentials were preserved.");
if (callerWasInsideInstallation) console.log(`Your parent shell may still reference the removed directory. Run: cd ${home}`);

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args=process.argv.slice(2);
if(args.some(arg=>["-h","--help"].includes(arg))){console.log("Usage: ai-factory uninstall [--purge] [--yes] [--force]\nBasic uninstall preserves .env, backups and repos/. --purge removes the entire factory home after checking managed clones. Provider credentials and shared tools are always preserved.");process.exit(0);}
if(args.some(arg=>!["--purge","--yes","--force"].includes(arg)))throw new Error("Unknown option. Use --help.");
const confirmed=args.includes("--yes"),forced=args.includes("--force"),purge=args.includes("--purge");
const engine=path.resolve(fileURLToPath(new URL("..",import.meta.url)));
const factoryHome=path.resolve(process.env.AI_FACTORY_HOME?.trim()||(path.basename(engine)==="engine"?path.dirname(engine):engine));
const userHome=path.resolve(os.homedir());
const manifest=JSON.parse(fs.readFileSync(path.join(engine,"package.json"),"utf8"));
if(manifest.name!=="ai-factory")throw new Error(`Refusing to remove an unrecognized engine: ${engine}`);
if([path.parse(factoryHome).root,userHome,path.dirname(userHome)].includes(factoryHome))throw new Error(`Unsafe factory home: ${factoryHome}`);
const actualEngine=fs.realpathSync(engine),actualFactoryHome=fs.realpathSync(factoryHome);
if(purge&&path.dirname(actualEngine)!==actualFactoryHome&&actualEngine!==actualFactoryHome)throw new Error(`Refusing to purge because engine ${engine} is not inside factory home ${factoryHome}`);
const environmentFile=path.join(factoryHome,".env"),envText=fs.existsSync(environmentFile)?fs.readFileSync(environmentFile,"utf8"):"";
const envValue=key=>{const raw=envText.match(new RegExp(`^${key}=(.*)$`,`m`))?.[1]?.trim()??"";return raw.length>=2&&["'",'"',"`"].includes(raw[0])&&raw.at(-1)===raw[0]?raw.slice(1,-1):raw;};
const gitCommand=envValue("GIT_COMMAND")||"git",configuredData=path.resolve(factoryHome,envValue("FACTORY_DATA_DIR")||"data"),standardData=path.join(factoryHome,"data"),targetDir=envValue("FACTORY_REPO_DIR")?path.resolve(factoryHome,envValue("FACTORY_REPO_DIR")):null,reposDir=path.join(factoryHome,"repos");
const plists=["daemon","dashboard"].map(service=>path.join(userHome,"Library","LaunchAgents",`com.ai-factory.${service}.plist`)),launcher=path.join(userHome,".local","bin","ai-factory");
for(const directory of new Set([configuredData,standardData]))if(!directory.startsWith(`${factoryHome}${path.sep}`)){
  if([path.parse(directory).root,userHome,path.dirname(userHome),targetDir].filter(Boolean).includes(directory))throw new Error(`Unsafe configured data directory: ${directory}`);
  if(fs.existsSync(directory)&&!fs.existsSync(path.join(directory,"factory.db")))throw new Error(`Refusing to remove external data without a factory.db marker: ${directory}`);
}
console.log("AI Factory uninstall plan");
console.log("  Services:     daemon and dashboard LaunchAgents");console.log(`  Engine:       ${engine}`);console.log(`  Runtime data: ${configuredData}${configuredData===standardData?"":` and ${standardData}`}`);
console.log(purge?`  Purge:        ${factoryHome} including configuration and repos/`:`  Preserved:    ${environmentFile}, .env.backup-* and ${reposDir}`);console.log("  Credentials:  GitHub, Codex and Claude credentials are preserved");

let unsafeWork=[];const databaseFile=path.join(configuredData,"factory.db");
if(fs.existsSync(databaseFile))try{
  const {default:Database}=await import("better-sqlite3");
  const db=new Database(databaseFile,{readonly:true,fileMustExist:true});let active=[];try{active=db.prepare("SELECT issue_number,stage,status,branch FROM work_items WHERE status IN ('QUEUED','RUNNING','WAITING','PAUSED') ORDER BY issue_number").all();}finally{db.close();}
  unsafeWork=active.map(item=>{if(!item.branch||!targetDir||!fs.existsSync(targetDir))return{...item,published:false,publication:"unverifiable"};const remote=spawnSync(gitCommand,["ls-remote","--heads","origin",item.branch],{cwd:targetDir,encoding:"utf8",timeout:10000});const published=remote.status===0&&Boolean(remote.stdout.trim());return{...item,published,publication:remote.status===0?(published?"published":"unpublished"):"unverifiable"};}).filter(item=>!item.published);
  console.log(`  Work preflight: ${active.length} active item${active.length===1?"":"s"}; ${unsafeWork.length} with unpublished or unverifiable work.`);for(const item of unsafeWork)console.log(`    #${item.issue_number} ${item.stage}/${item.status} — ${item.branch||"no branch"} (${item.publication})`);
}catch(error){console.log(`  Work preflight: factory.db could not be inspected (${error.message}); continuing without workflow inspection.`);}else console.log("  Work preflight: no factory database was found.");

const unsafeRepos=[];
if(purge&&fs.existsSync(reposDir))for(const name of fs.readdirSync(reposDir)){
  const repo=path.join(reposDir,name);if(!fs.statSync(repo).isDirectory()||!fs.existsSync(path.join(repo,".git")))continue;
  const dirty=spawnSync(gitCommand,["status","--porcelain"],{cwd:repo,encoding:"utf8",timeout:10000}),unique=spawnSync(gitCommand,["log","--branches","--not","--remotes","--oneline"],{cwd:repo,encoding:"utf8",timeout:10000}),reasons=[];
  if(dirty.status!==0||dirty.stdout.trim())reasons.push("dirty working tree");if(unique.status!==0||unique.stdout.trim())reasons.push("unpushed commits");if(reasons.length)unsafeRepos.push({repo,reasons});
}
for(const item of unsafeRepos)console.log(`  Repository preflight: ${item.repo} — ${item.reasons.join(" and ")}`);
if(confirmed&&!forced&&(unsafeWork.length||unsafeRepos.length))throw new Error("Unpublished work would be removed. Re-run with --yes --force after reviewing the plan.");
if(!confirmed){
  if(!process.stdin.isTTY)throw new Error("Interactive confirmation unavailable. Re-run with --yes after reviewing the paths above.");
  const prompt=readline.createInterface({input:process.stdin,output:process.stdout}),word=purge?"purge":"uninstall",answer=await prompt.question(`Type "${word}" to continue: `);if(answer!==word){prompt.close();console.log("Uninstall cancelled.");process.exit(0);}
  if(!forced&&(unsafeWork.length||unsafeRepos.length)){const forceAnswer=await prompt.question('Unpublished work may be lost. Type "force" to continue: ');if(forceAnswer!=="force"){prompt.close();console.log("Uninstall cancelled.");process.exit(0);}}prompt.close();
}
if((process.platform==="darwin"||process.env.AI_FACTORY_UNINSTALL_LAUNCHCTL==="1")&&process.env.AI_FACTORY_UNINSTALL_SKIP_LAUNCHCTL!=="1"){
  const domain=`gui/${process.getuid()}`,call=args=>spawnSync("launchctl",args,{encoding:"utf8"}),loaded=label=>call(["print",`${domain}/${label}`]).status===0,jobs=call(["list"]);
  for(const line of(jobs.stdout??"").split("\n")){const label=line.trim().split(/\s+/).at(-1)??"";if(label.startsWith("com.ai-factory.update.")){call(["remove",label]);if(loaded(label))throw new Error(`Could not stop existing service: ${label}`);}}
  for(const service of["daemon","dashboard"]){const label=`com.ai-factory.${service}`;if(!loaded(label))continue;call(["bootout",`${domain}/${label}`]);if(loaded(label))throw new Error(`Could not stop existing service: ${label}`);console.log(`Stopped ${service} service.`);}
}
const configuredRepository=envValue("GITHUB_REPOSITORY"),controllerCli=path.join(engine,"dist","src","cli.js");
if(configuredRepository&&fs.existsSync(controllerCli)){
  const release=spawnSync(process.execPath,[controllerCli,"controller","release",...(forced?["--force"]:[])],{cwd:engine,env:{...process.env,AI_FACTORY_HOME:factoryHome},encoding:"utf8",timeout:60000});
  if(release.status!==0){console.error("Repository controller release failed. Another installation must run:");console.error(`  ai-factory controller takeover --force`);if(!forced)throw new Error("Remote repository control was not released. Re-run uninstall with --force to remove this installation locally.");}
  else console.log("Released repository control.");
}
for(const plist of plists)fs.rmSync(plist,{force:true});
const installedLayout=path.basename(actualEngine)==="engine"&&path.dirname(actualEngine)===actualFactoryHome,residualRoot=path.join(factoryHome,".uninstall");
if(!purge&&installedLayout){fs.mkdirSync(path.join(residualRoot,"scripts"),{recursive:true});fs.copyFileSync(fileURLToPath(import.meta.url),path.join(residualRoot,"scripts","uninstall.mjs"));fs.copyFileSync(path.join(engine,"scripts","ai-factory"),path.join(residualRoot,"scripts","ai-factory"));fs.chmodSync(path.join(residualRoot,"scripts","ai-factory"),0o755);fs.writeFileSync(path.join(residualRoot,"package.json"),JSON.stringify({name:"ai-factory"})+"\n");fs.mkdirSync(path.dirname(launcher),{recursive:true});try{fs.rmSync(launcher,{force:true});}catch{}fs.symlinkSync(path.join(residualRoot,"scripts","ai-factory"),launcher);}
else try{if(fs.lstatSync(launcher).isSymbolicLink()){const target=path.resolve(path.dirname(launcher),fs.readlinkSync(launcher));if(target===path.join(engine,"scripts","ai-factory")||target===path.join(residualRoot,"scripts","ai-factory"))fs.rmSync(launcher,{force:true});}}catch{}
const callerInside=process.cwd()===factoryHome||process.cwd().startsWith(`${factoryHome}${path.sep}`);if(callerInside)process.chdir(userHome);
for(const directory of new Set([configuredData,standardData]))fs.rmSync(directory,{recursive:true,force:true});fs.rmSync(engine,{recursive:true,force:true});
if(purge){fs.rmSync(factoryHome,{recursive:true,force:true});console.log(`AI Factory was purged. The home was removed: ${factoryHome}`);}else{const preserved=[];if(fs.existsSync(environmentFile))preserved.push(environmentFile);if(fs.existsSync(reposDir))for(const name of fs.readdirSync(reposDir))preserved.push(path.join(reposDir,name));console.log("AI Factory was uninstalled. Preserved paths:");for(const item of preserved)console.log(`  ${item}`);if(!preserved.length)console.log(`  ${factoryHome} (empty)`);if(installedLayout)console.log("The uninstall helper remains available. Run `ai-factory uninstall --purge` later to remove the preserved home.");}
console.log("Provider credentials and shared command-line tools were preserved.");if(callerInside)console.log(`Your parent shell may still reference the removed engine. Run: cd ${userHome}`);

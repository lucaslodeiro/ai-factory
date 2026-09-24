import {spawn,type ChildProcess} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {config,agentEnvironment} from "./config.js";

type Runtime={child:ChildProcess;cwd:string;url:string;script:string;log:string};

// A target repository may announce several origins, one per line, primary first: a preview server
// can bind loopback plus a LAN or tunnel address. The Factory drives it from this machine, so it
// takes the first loopback entry and ignores the rest instead of failing on the whole file.
// Reading the file as a single URL made a multi-origin repository time out with no explanation.
const loopbackHosts=new Set(["127.0.0.1","localhost","::1","[::1]"]);
export interface AnnouncedRuntime { url:string|null; announced:string[] }
export function announcedRuntimeUrl(contents:string):AnnouncedRuntime {
 const announced:string[]=[];let url:string|null=null;
 for (const line of contents.split(/\r?\n/).map(entry=>entry.trim()).filter(Boolean)) {
  let parsed:URL;try{parsed=new URL(line);}catch{continue;}
  announced.push(parsed.hostname);
  if (url===null && loopbackHosts.has(parsed.hostname)) url=line;
 }
 return {url,announced};
}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export class LocalRuntimeManager {
 private runtimes=new Map<string,Runtime>();
 private script(cwd:string){try{const scripts=JSON.parse(fs.readFileSync(path.join(cwd,"package.json"),"utf8")).scripts??{};return ["local:serve","preview","dev","serve"].find(name=>typeof scripts[name]==="string");}catch{return undefined;}}
 async ensure(workItemId:string,cwd:string){
  const current=this.runtimes.get(workItemId);if(current&&current.cwd===cwd&&!current.child.killed)return current;if(current)await this.stop(workItemId);
  const script=this.script(cwd);if(!script)return undefined;
  const dir=path.join(config.dataDir,"local-runtimes"),log=path.join(dir,`${workItemId}.log`);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(log,"",{mode:0o600});
  try{return await this.start(workItemId,cwd,script,log);}
  catch(error){
   // A preview that serves the built site cannot start before the first build: on factory-demo#20
   // `local:serve` stopped with ENOENT on dist in a fresh worktree and the Builder gave up before
   // writing any code. Building once and starting again is what a person would do.
   if(!this.hasScript(cwd,"build"))throw error;
   const built=await this.build(cwd,log);
   if(!built.ok)throw new Error(`Factory local runtime did not become ready, and \`npm run build\` ${built.reason} before a second start. See ${log}`);
   return await this.start(workItemId,cwd,script,log);
  }
 }
 private hasScript(cwd:string,name:string){try{return typeof JSON.parse(fs.readFileSync(path.join(cwd,"package.json"),"utf8")).scripts?.[name]==="string";}catch{return false;}}
 private build(cwd:string,log:string):Promise<{ok:boolean;reason?:string}>{
  return new Promise(resolve=>{
   const output=fs.openSync(log,"a",0o600),child=spawn("npm",["run","build"],{cwd,env:agentEnvironment(),stdio:["ignore",output,output]});fs.closeSync(output);
   const timer=setTimeout(()=>{child.kill("SIGKILL");resolve({ok:false,reason:"did not finish in five minutes"});},300_000);
   child.once("error",error=>{clearTimeout(timer);resolve({ok:false,reason:`could not start: ${error.message}`});});
   child.once("exit",code=>{clearTimeout(timer);resolve(code===0?{ok:true}:{ok:false,reason:`exited ${code}`});});
  });
 }
 private async start(workItemId:string,cwd:string,script:string,log:string){
  fs.rmSync(path.join(cwd,".local","url"),{force:true});
  const output=fs.openSync(log,"a",0o600),child=spawn("npm",["run",script],{cwd,env:{...agentEnvironment(),LOCAL_PORT:"0"},stdio:["ignore",output,output]});fs.closeSync(output);
  const runtime={child,cwd,url:"",script,log};this.runtimes.set(workItemId,runtime);const deadline=Date.now()+15000;
  let announced:string[]=[];
  while(Date.now()<deadline){
   if(child.exitCode!==null)break;
   try{
    const found=announcedRuntimeUrl(fs.readFileSync(path.join(cwd,".local","url"),"utf8"));
    if(found.announced.length)announced=found.announced;
    if(found.url){const response=await fetch(found.url,{signal:AbortSignal.timeout(1000)});if(response.ok||response.status<500){runtime.url=found.url;return runtime;}}
   }catch{}
   await sleep(100);
  }
  await this.stop(workItemId);
  // Announcing only non-loopback origins is a different problem from never starting, and saying
  // which hosts were announced is the difference between a fixable report and a dead end.
  if(announced.length)throw new Error(`Factory local runtime announced no loopback address. \`${script}\` published ${announced.join(", ")}. See ${log}`);
  throw new Error(`Factory local runtime did not become ready. See ${log}`);
 }
 async stop(workItemId:string){const runtime=this.runtimes.get(workItemId);if(!runtime)return;this.runtimes.delete(workItemId);if(runtime.child.exitCode!==null)return;runtime.child.kill("SIGTERM");await Promise.race([new Promise(resolve=>runtime.child.once("exit",resolve)),sleep(1500)]);if(runtime.child.exitCode===null)runtime.child.kill("SIGKILL");}
 async reconcile(activeIds:Set<string>){for(const id of this.runtimes.keys())if(!activeIds.has(id))await this.stop(id);}
 async close(){for(const id of [...this.runtimes.keys()])await this.stop(id);}
}

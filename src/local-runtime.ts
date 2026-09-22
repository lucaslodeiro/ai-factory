import {spawn,type ChildProcess} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {config,agentEnvironment} from "./config.js";

type Runtime={child:ChildProcess;cwd:string;url:string;script:string;log:string};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export class LocalRuntimeManager {
 private runtimes=new Map<string,Runtime>();
 private script(cwd:string){try{const scripts=JSON.parse(fs.readFileSync(path.join(cwd,"package.json"),"utf8")).scripts??{};return ["local:serve","preview","dev","serve"].find(name=>typeof scripts[name]==="string");}catch{return undefined;}}
 async ensure(workItemId:string,cwd:string){
  const current=this.runtimes.get(workItemId);if(current&&current.cwd===cwd&&!current.child.killed)return current;if(current)await this.stop(workItemId);
  const script=this.script(cwd);if(!script)return undefined;
  const dir=path.join(config.dataDir,"local-runtimes"),log=path.join(dir,`${workItemId}.log`);fs.mkdirSync(dir,{recursive:true});fs.rmSync(path.join(cwd,".local","url"),{force:true});
  const output=fs.openSync(log,"w",0o600),child=spawn("npm",["run",script],{cwd,env:{...agentEnvironment(),LOCAL_PORT:"0"},stdio:["ignore",output,output]});fs.closeSync(output);
  const runtime={child,cwd,url:"",script,log};this.runtimes.set(workItemId,runtime);const deadline=Date.now()+15000;
  while(Date.now()<deadline){if(child.exitCode!==null)break;try{const url=fs.readFileSync(path.join(cwd,".local","url"),"utf8").trim(),parsed=new URL(url);if(parsed.hostname!=="127.0.0.1"&&parsed.hostname!=="localhost")throw new Error("Local runtime must bind to loopback");const response=await fetch(url,{signal:AbortSignal.timeout(1000)});if(response.ok||response.status<500){runtime.url=url;return runtime;}}catch{}await sleep(100);}
  await this.stop(workItemId);throw new Error(`Factory local runtime did not become ready. See ${log}`);
 }
 async stop(workItemId:string){const runtime=this.runtimes.get(workItemId);if(!runtime)return;this.runtimes.delete(workItemId);if(runtime.child.exitCode!==null)return;runtime.child.kill("SIGTERM");await Promise.race([new Promise(resolve=>runtime.child.once("exit",resolve)),sleep(1500)]);if(runtime.child.exitCode===null)runtime.child.kill("SIGKILL");}
 async reconcile(activeIds:Set<string>){for(const id of this.runtimes.keys())if(!activeIds.has(id))await this.stop(id);}
 async close(){for(const id of [...this.runtimes.keys()])await this.stop(id);}
}

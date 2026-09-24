import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {config} from "./config.js";

// An agent that starts a server in the background (a dev server, a test server) leaves it running
// after its run: the provider runs each command in its own process group, so stopping the run's
// group misses it. A daemon that restarts without stopping its preview server leaves that one too.
// They hold memory and ports, and a held port can fail the next Tester. Anything still running
// inside a Factory worktree that this daemon did not start is therefore stopped: after every run
// in that worktree, and for every worktree when the daemon starts.
interface Proc {pid:number;ppid:number;cwd:string}

function processes():Proc[] {
 if(process.platform==="linux"){
  return fs.readdirSync("/proc").filter(name=>/^\d+$/.test(name)).flatMap(name=>{
   try{const stat=fs.readFileSync(`/proc/${name}/stat`,"utf8"),ppid=Number(stat.slice(stat.lastIndexOf(")")+2).split(" ")[1]);return[{pid:Number(name),ppid,cwd:fs.readlinkSync(`/proc/${name}/cwd`)}];}catch{return[];}
  });
 }
 const parents=new Map<number,number>();
 for(const line of (spawnSync("ps",["-A","-o","pid=,ppid="],{encoding:"utf8"}).stdout??"").split("\n")){const [pid,ppid]=line.trim().split(/\s+/).map(Number);if(pid)parents.set(pid,ppid);}
 const found:Proc[]=[];let pid=0;
 for(const line of (spawnSync("lsof",["-n","-P","-a","-d","cwd","-Fpn"],{encoding:"utf8",maxBuffer:64<<20}).stdout??"").split("\n")){
  if(line.startsWith("p"))pid=Number(line.slice(1));else if(line.startsWith("n")&&pid)found.push({pid,ppid:parents.get(pid)??0,cwd:line.slice(1)});
 }
 return found;
}

const inside=(dir:string,root:string)=>dir===root||dir.startsWith(root.endsWith(path.sep)?root:root+path.sep);

/** Processes running in `dir` that neither this daemon nor anything it started owns. */
export function strayProcesses(dir:string,all=processes(),self=process.pid):number[] {
 const byPid=new Map(all.map(proc=>[proc.pid,proc]));
 const ours=(pid:number)=>{for(let current=pid,hops=0;current>1&&hops<64;hops++){if(current===self)return true;current=byPid.get(current)?.ppid??0;}return false;};
 return all.filter(proc=>proc.pid!==self&&inside(proc.cwd,dir)&&!ours(proc.pid)).map(proc=>proc.pid);
}

/** Stops the stray processes in a Factory worktree, or in all of them. Returns the pids stopped. */
export async function reapStrayProcesses(dir=path.join(config.dataDir,"worktrees")):Promise<number[]> {
 const root=path.resolve(config.dataDir,"worktrees"),target=path.resolve(dir);
 if(!inside(target,root))return []; // never outside the Factory's own worktrees
 let real=target;try{real=fs.realpathSync(target);}catch{}
 const pids=[...new Set([...strayProcesses(target),...(real!==target?strayProcesses(real):[])])];
 for(const pid of pids)try{process.kill(pid,"SIGTERM");}catch{}
 if(pids.length){await new Promise(resolve=>setTimeout(resolve,1500));for(const pid of pids)try{process.kill(pid,0);process.kill(pid,"SIGKILL");}catch{}}
 return pids;
}

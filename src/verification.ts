import { spawn } from "node:child_process";

// Only the operator's configured command may reach this entry point.
export function runVerification({cwd,command,timeoutMs}:{cwd:string;command:string;timeoutMs:number}):Promise<{command:string;exitCode:number|null;durationMs:number;outputTail:string}>{
 return new Promise(resolve=>{
  const started=Date.now();let outputTail="",timedOut=false;
  const child=spawn("sh",["-c",command],{cwd,detached:process.platform!=="win32",stdio:["ignore","pipe","pipe"]});
  const append=(chunk:string)=>{outputTail=(outputTail+chunk).slice(-4000);};
  child.stdout.setEncoding("utf8").on("data",append);child.stderr.setEncoding("utf8").on("data",append);
  const timer=setTimeout(()=>{timedOut=true;try{if(process.platform!=="win32"&&child.pid)process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}catch{}},timeoutMs);
  child.on("error",error=>append(error.message));
  child.on("close",exitCode=>{clearTimeout(timer);resolve({command,exitCode:timedOut?null:exitCode,durationMs:Date.now()-started,outputTail});});
 });
}

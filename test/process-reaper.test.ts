import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {config} from "../src/config.js";
import {reapStrayProcesses,strayProcesses} from "../src/process-reaper.js";

test("a stray process is one running in the worktree that the daemon did not start",()=>{
 const all=[{pid:100,ppid:1,cwd:"/data/worktrees"},{pid:200,ppid:100,cwd:"/data/worktrees/a"},{pid:201,ppid:200,cwd:"/data/worktrees/a/app"},
  {pid:300,ppid:1,cwd:"/data/worktrees/a"},{pid:301,ppid:300,cwd:"/data/worktrees/a/server"},{pid:400,ppid:1,cwd:"/data/worktrees/ab"},{pid:500,ppid:1,cwd:"/home/me/project"}];
 // 100 is the daemon: its preview server (200) and that server's child stay; the orphans go.
 assert.deepEqual(strayProcesses("/data/worktrees/a",all,100),[300,301]);
 assert.deepEqual(strayProcesses("/data/worktrees",all,100),[300,301,400],"a sibling worktree is a different directory, not a prefix match");
});

test("a server an agent left running in a worktree is stopped, and nothing outside the worktrees is touched",{skip:process.platform==="win32"},async()=>{
 const saved=config.dataDir,data=fs.mkdtempSync(path.join(os.tmpdir(),"factory-reaper-"));config.dataDir=data;
 const worktree=path.join(data,"worktrees","item");fs.mkdirSync(worktree,{recursive:true});
 // Started in the background by a shell that then exits, as an agent's `npm run server &` would.
 const stray=Number(execFileSync("sh",["-c","sleep 60 >/dev/null 2>&1 & echo $!"],{cwd:worktree,encoding:"utf8"}).trim());
 // A killed process whose parent has not collected it yet is a zombie: it no longer runs.
 const alive=(pid:number)=>{try{process.kill(pid,0);}catch{return false;}try{return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`,"utf8"));}catch{return true;}};
 try{
  assert.ok(alive(stray));
  assert.deepEqual(await reapStrayProcesses(os.tmpdir()),[],"a directory outside the Factory's worktrees is never reaped");
  assert.deepEqual(await reapStrayProcesses(worktree),[stray]);
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(alive(stray),false);
 }finally{try{process.kill(stray,"SIGKILL");}catch{}config.dataDir=saved;fs.rmSync(data,{recursive:true,force:true});}
});

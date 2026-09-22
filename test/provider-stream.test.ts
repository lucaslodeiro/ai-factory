import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eachJsonLine, maxEventBytes, type JsonEvent } from "../src/provider-stream.js";

const fixture=(name:string)=>path.join("test","fixtures","providers",name);
const read=(file:string,chunkBytes?:number)=>{const events:JsonEvent[]=[];const scan=eachJsonLine(file,event=>events.push(event),chunkBytes);return {events,scan};};
const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),"factory-stream-"));

test("an interrupted run's stream ends on the command it was running",()=>{
 // codex exec --json stopped with SIGTERM while `sleep 30` ran.
 const codex=read(fixture("codex-interrupted.jsonl"));
 assert.deepEqual(codex.scan,{events:6,skipped:0});
 assert.deepEqual(codex.events.at(-1),{type:"item.started",item:{id:"item_2",type:"command_execution",command:"/bin/bash -lc 'sleep 30'",aggregated_output:"",exit_code:null,status:"in_progress"}});
 assert.equal(codex.events.some(event=>event.type==="turn.completed"),false);
 // claude -p stream-json stopped with SIGTERM: the killed command's result is the last event and no result envelope exists.
 const claude=read(fixture("claude-interrupted.jsonl"));
 const last=claude.events.at(-1) as {type:string;message:{content:Array<{type:string;is_error:boolean;content:string}>}};
 assert.equal(last.type,"user");assert.equal(last.message.content[0].type,"tool_result");assert.equal(last.message.content[0].is_error,true);assert.match(last.message.content[0].content,/^Exit code 137/);
 assert.equal(claude.events.some(event=>event.type==="result"),false);
});

test("the Claude result envelope is found although other events follow it",()=>{
 const {events}=read(fixture("claude-stream.jsonl"));
 const index=events.findIndex(event=>event.type==="result");
 assert.ok(index>=0&&index<events.length-1,"the real stream writes a task summary after the result");
 assert.deepEqual(events[index].structured_output,{summary:"Ran `wc -l a.txt` and read the file; it contains 1 line (\"hello\").",lines:1});
});

test("a last line cut off by a killed process is skipped and every complete line is kept",()=>{
 const root=scratch();
 try{
  const text=fs.readFileSync(fixture("codex-complete.jsonl"),"utf8"),file=path.join(root,"stdout.log");
  fs.writeFileSync(file,text.slice(0,text.trimEnd().lastIndexOf("\n")+40));
  const {events,scan}=read(file);
  assert.deepEqual(scan,{events:8,skipped:1});
  assert.equal(events.at(-1)!.type,"item.completed");
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("chunk boundaries inside a line or a multi-byte character do not change what is read",()=>{
 const root=scratch();
 try{
  const file=path.join(root,"stdout.log"),lines=[{type:"a",text:"añ€𝄞"},{type:"b",text:"x".repeat(50)},{type:"c"}];
  fs.writeFileSync(file,lines.map(line=>JSON.stringify(line)).join("\r\n")+"\n\n");
  for(const size of [1,2,3,7,64,1<<20])assert.deepEqual(read(file,size).events,lines,`chunk of ${size} bytes`);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("an event too large to be one is skipped without losing the events after it",()=>{
 const root=scratch();
 try{
  const file=path.join(root,"stdout.log");
  fs.writeFileSync(file,`{"type":"before"}\n{"type":"huge","text":"${"x".repeat(maxEventBytes)}"}\nnot json\n[1,2]\n{"type":"after"}\n`);
  const {events,scan}=read(file);
  assert.deepEqual(events.map(event=>event.type),["before","after"]);
  assert.deepEqual(scan,{events:2,skipped:3});
  assert.deepEqual(eachJsonLine(path.join(root,"missing.log"),()=>assert.fail()),{events:0,skipped:0});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

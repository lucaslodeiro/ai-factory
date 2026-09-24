import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {Store} from "../src/storage.js";
import {prototypeScreenshot,workflowThread} from "../src/workflow-chat.js";
import {result} from "./fixtures.js";

test("the dashboard shows the Designer's screenshots from the prototype commit on this machine, and nothing it did not report",()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),"factory-prototype-")),git=(...args:string[])=>execFileSync("git",["-C",cwd,...args],{encoding:"utf8"}).trim();
 const png=Buffer.from("89504e470d0a1a0a0000000d49484452","hex");
 git("init","-q");git("config","user.email","f@example.com");git("config","user.name","f");
 fs.mkdirSync(path.join(cwd,".factory/prototype/screenshots"),{recursive:true});
 fs.writeFileSync(path.join(cwd,".factory/prototype/screenshots/01-home.png"),png);fs.writeFileSync(path.join(cwd,"secret.png"),png);
 git("add","-A");git("commit","-qm","prototype");const head=git("rev-parse","HEAD");
 // The prototype leaves the branch before the Builder starts; the commit still holds it.
 git("rm","-rq",".factory");git("commit","-qm","archive prototype");
 const store=new Store(":memory:");
 try{
  store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',20,'owner/demo','now','now',?,'DESIGN','WAITING')").run(JSON.stringify({cwd,title:"Header"}));
  store.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at) VALUES('design','w','designer','succeeded','now')").run();
  store.event("agent.result",{role:"designer",specVersion:1,prototypeHead:head,result:result("pass",{changedFiles:[".factory/prototype/screenshots/01-home.png"],tests:[],coverage:[]})},"w","design");
  const shot=prototypeScreenshot(store,"design",".factory/prototype/screenshots/01-home.png");
  assert.equal(shot?.type,"image/png");assert.deepEqual(shot?.bytes,png);
  for(const file of ["secret.png",".factory/prototype/../secret.png",".factory/prototype/screenshots/02-missing.png"])assert.equal(prototypeScreenshot(store,"design",file),undefined,file);
  const markdown=JSON.stringify(workflowThread(store,"w"));
  assert.match(markdown,/!\[01-home.png\]\(\/api\/executions\/design\/prototype\?path=\.factory%2Fprototype%2Fscreenshots%2F01-home\.png\)/,"the dashboard points at this machine, not at GitHub");
 }finally{store.db.close();fs.rmSync(cwd,{recursive:true,force:true});}
});

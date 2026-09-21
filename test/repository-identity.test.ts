import test from "node:test";
import assert from "node:assert/strict";
import {Store} from "../src/storage.js";
import {verifyRepositoryIdentity} from "../src/repository-identity.js";
import {startDaemon} from "../src/daemon.js";
import {config} from "../src/config.js";
import {doctor} from "../src/doctor.js";

const repository=(id:number,fullName="owner/demo")=>({authenticatedLogin:()=>"factory",repository:()=>({id,nodeId:`R_${id}`,fullName,defaultBranch:"main"})});

test("repository identity is stored once and a different GitHub repository id is refused",()=>{
 const store=new Store(":memory:");
 try {
  verifyRepositoryIdentity(store,repository(1));
  assert.deepEqual(store.metadata("repository_identity"),{id:1,nodeId:"R_1",fullName:"owner/demo"});
  assert.throws(()=>verifyRepositoryIdentity(store,repository(2,"owner/recreated")),/Data directory belongs to repository owner\/demo \(id 1\).*empty FACTORY_DATA_DIR/);
 } finally {store.db.close();}
});

test("daemon refuses a mismatched repository identity before acquiring its lock",async()=>{
 const store=new Store(":memory:"),previousRepo=config.repo,previousApprovers=[...config.approvers];config.repo="owner/demo";config.approvers.splice(0,config.approvers.length,"owner");
 try {
  store.setMetadata("repository_identity",{id:1,nodeId:"R_1",fullName:"owner/original"});
  await assert.rejects(()=>startDaemon(store,repository(2) as any),/Data directory belongs to repository owner\/original \(id 1\)/);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daemon_lock'").get(),undefined);
 } finally {config.repo=previousRepo;config.approvers.splice(0,config.approvers.length,...previousApprovers);store.db.close();}
});

test("doctor reports a repository identity mismatch",()=>{
 const store=new Store(":memory:"),lines:string[]=[],original=console.log;store.setMetadata("repository_identity",{id:1,nodeId:"R_1",fullName:"owner/original"});console.log=(...values:unknown[])=>lines.push(values.join(" "));
 try {assert.equal(doctor(store,repository(2) as any),false);assert.match(lines.join("\n"),/✗ GitHub repository identity[\s\S]*Data directory belongs to repository owner\/original \(id 1\)/);}
 finally {console.log=original;store.db.close();}
});

test("doctor reports a configured base that differs from GitHub",()=>{
 const store=new Store(":memory:"),lines:string[]=[],original=console.log,previous=config.defaultBranch;config.defaultBranch="develop";console.log=(...values:unknown[])=>lines.push(values.join(" "));
 try {doctor(store,repository(1) as any);assert.doesNotMatch(lines.join("\n"),/Repository controller/);assert.match(lines.join("\n"),/✗ GitHub default branch matches configured base/);}
 finally {config.defaultBranch=previous;console.log=original;store.db.close();}
});

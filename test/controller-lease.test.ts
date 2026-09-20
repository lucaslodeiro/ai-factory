import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {ControllerLease,CONTROLLER_REF,type ControllerLeaseRecord} from "../src/controller-lease.js";
import type {FactoryInstance} from "../src/instance.js";

const git=(args:string[],cwd?:string)=>execFileSync("git",args,{cwd,encoding:"utf8"}).trim();
const repository={id:42,nodeId:"R_42",fullName:"owner/demo",defaultBranch:"main"},instance:FactoryInstance={schemaVersion:1,instanceId:"11111111-1111-4111-8111-111111111111",displayName:"Factory 111111",createdAt:"2026-09-21T00:00:00.000Z"};
const valid=(overrides:Partial<ControllerLeaseRecord>={}):ControllerLeaseRecord=>({schemaVersion:1,repositoryId:42,repositoryNodeId:"R_42",instanceId:"22222222-2222-4222-8222-222222222222",displayName:"Factory 222222",contact:"",generation:3,engineVersion:"0.3.0",acquiredAt:"2026-09-21T00:00:00.000Z",heartbeatAt:"2026-09-21T00:05:00.000Z",activeWorkCount:2,...overrides});
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-controller-")),remote=path.join(root,"origin.git"),writer=path.join(root,"writer"),home=path.join(root,"home");git(["init","--bare",remote]);git(["init",writer]);git(["config","user.name","Test"],writer);git(["config","user.email","test@example.com"],writer);git(["remote","add","origin",remote],writer);return{root,remote,writer,home,write(value:unknown){fs.writeFileSync(path.join(writer,"lease.json"),typeof value==="string"?value:JSON.stringify(value));git(["add","lease.json"],writer);git(["commit","-m","lease"],writer);const sha=git(["rev-parse","HEAD"],writer);git(["push","origin",`${sha}:${CONTROLLER_REF}`,`--force-with-lease=${CONTROLLER_REF}:`],writer);return sha;}};}

test("controller read reports absent and validates a current local-bare lease",()=>{const f=fixture();try{const client=new ControllerLease(repository,undefined,{home:f.home,remote:f.remote,instance,now:()=>Date.parse("2026-09-21T00:06:00.000Z")});assert.equal(client.readLease().state,"absent");const sha=f.write(valid()),observed=client.readLease();if(observed.state==="absent")throw new Error("expected lease");assert.equal(observed.state,"standby");assert.equal(observed.sha,sha);assert.equal(observed.record.activeWorkCount,2);assert.equal(observed.expiresAt,"2026-09-21T00:15:00.000Z");}finally{fs.rmSync(f.root,{recursive:true,force:true});}});

test("controller read rejects malformed and mismatched records",()=>{for(const [name,value,pattern] of [["malformed","not json",/Malformed controller lease/],["repository mismatch",valid({repositoryId:99}),/different GitHub repository identity/]] as const){const f=fixture();try{f.write(value);const client=new ControllerLease(repository,undefined,{home:f.home,remote:f.remote,instance});assert.throws(()=>client.readLease(),pattern,name);}finally{fs.rmSync(f.root,{recursive:true,force:true});}}});

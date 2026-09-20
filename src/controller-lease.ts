import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {config} from "./config.js";
import {factoryHome} from "./home.js";
import {readOrCreateInstance,type FactoryInstance} from "./instance.js";
import type {Repository} from "./adapters/github.js";
import type {Store} from "./storage.js";

export const CONTROLLER_REF="refs/ai-factory/lease",CONTROLLER_HEARTBEAT_MS=120_000,CONTROLLER_LEASE_MS=600_000;
export type ControllerLeaseRecord={schemaVersion:1;repositoryId:number;repositoryNodeId:string;instanceId:string;displayName:string;contact:string;generation:number;engineVersion:string;acquiredAt:string;heartbeatAt:string;activeWorkCount:number};
export type LeaseObservation={state:"absent";instance:FactoryInstance}|{state:"active"|"standby"|"expired";sha:string;record:ControllerLeaseRecord;expiresAt:string;heartbeatAgeMs:number;instance:FactoryInstance};

function validateDate(value:unknown,name:string){if(typeof value!=="string"||!Number.isFinite(Date.parse(value)))throw new Error(`Invalid controller lease ${name}`);return value;}
export function validateLeaseRecord(value:unknown,repository:Pick<Repository,"id"|"nodeId">):ControllerLeaseRecord{
 const record=value as Partial<ControllerLeaseRecord>;
 if(!record||record.schemaVersion!==1)throw new Error("Invalid controller lease schema");
 if(record.repositoryId!==repository.id||record.repositoryNodeId!==repository.nodeId)throw new Error("Controller lease belongs to a different GitHub repository identity");
 if(typeof record.instanceId!=="string"||!/^[0-9a-f-]{36}$/i.test(record.instanceId))throw new Error("Invalid controller lease instance id");
 if(typeof record.displayName!=="string"||!record.displayName.trim()||record.displayName.length>100)throw new Error("Invalid controller lease display name");
 if(typeof record.contact!=="string"||record.contact.length>200)throw new Error("Invalid controller lease contact");
 if(!Number.isSafeInteger(record.generation)||Number(record.generation)<1)throw new Error("Invalid controller lease generation");
 if(typeof record.engineVersion!=="string"||!record.engineVersion.trim())throw new Error("Invalid controller lease engine version");
 validateDate(record.acquiredAt,"acquiredAt");validateDate(record.heartbeatAt,"heartbeatAt");
 if(!Number.isSafeInteger(record.activeWorkCount)||Number(record.activeWorkCount)<0)throw new Error("Invalid controller lease active work count");
 return record as ControllerLeaseRecord;
}

export class ControllerLease{
 readonly instance:FactoryInstance;readonly controlDir:string;readonly remote:string;
 constructor(readonly repository:Repository,private store?:Store,options:{home?:string;gitCommand?:string;remote?:string;now?:()=>number;instance?:FactoryInstance}={}){
  this.home=options.home??factoryHome();this.gitCommand=options.gitCommand??config.gitCommand;this.remote=options.remote??process.env.AI_FACTORY_CONTROLLER_REMOTE??`https://github.com/${repository.fullName}.git`;this.now=options.now??Date.now;this.instance=options.instance??readOrCreateInstance(this.home);this.controlDir=path.join(this.home,"data","controller.git");
 }
 private home:string;private gitCommand:string;private now:()=>number;
 private git(args:string[]){const result=spawnSync(this.gitCommand,[`--git-dir=${this.controlDir}`,...args],{encoding:"utf8",timeout:60_000,maxBuffer:2_000_000});if(result.status!==0)throw new Error((result.stderr||result.error?.message||"Controller Git operation failed").trim());return result.stdout.trim();}
 private ensureBare(){if(!fs.existsSync(path.join(this.controlDir,"HEAD"))){fs.mkdirSync(path.dirname(this.controlDir),{recursive:true});const result=spawnSync(this.gitCommand,["init","--bare",this.controlDir],{encoding:"utf8",timeout:30_000});if(result.status!==0)throw new Error((result.stderr||result.error?.message||"Could not initialize controller repository").trim());}const current=spawnSync(this.gitCommand,[`--git-dir=${this.controlDir}`,"remote","get-url","origin"],{encoding:"utf8"});if(current.status===0)this.git(["remote","set-url","origin",this.remote]);else this.git(["remote","add","origin",this.remote]);}
 readLease():LeaseObservation{
  this.ensureBare();const line=this.git(["ls-remote","origin",CONTROLLER_REF]).split(/\r?\n/).find(Boolean);
  if(!line){const result={state:"absent",instance:this.instance} as const;this.remember(result);return result;}
  const [sha,ref]=line.trim().split(/\s+/);if(ref!==CONTROLLER_REF||!/^[0-9a-f]{40,64}$/.test(sha))throw new Error("Invalid controller lease ref response");
  this.git(["fetch","--no-tags","origin",CONTROLLER_REF]);
  let parsed:unknown;try{parsed=JSON.parse(this.git(["cat-file","-p",`${sha}:lease.json`]));}catch(error){throw new Error(`Malformed controller lease record: ${error instanceof Error?error.message:String(error)}`);}
  const record=validateLeaseRecord(parsed,this.repository),heartbeat=Date.parse(record.heartbeatAt),expiresAt=new Date(heartbeat+CONTROLLER_LEASE_MS).toISOString(),heartbeatAgeMs=Math.max(0,this.now()-heartbeat),state=record.instanceId===this.instance.instanceId?"active":heartbeatAgeMs>=CONTROLLER_LEASE_MS?"expired":"standby",result={state,sha,record,expiresAt,heartbeatAgeMs,instance:this.instance} as LeaseObservation;this.remember(result);return result;
 }
 private remember(observation:LeaseObservation){if(!this.store)return;const row=observation.state==="absent"?{repositoryId:this.repository.id,instanceId:this.instance.instanceId,generation:null,remoteSha:null,state:"absent",lastVerifiedAt:new Date(this.now()).toISOString(),lastError:null}:{repositoryId:this.repository.id,instanceId:observation.record.instanceId,generation:observation.record.generation,remoteSha:observation.sha,state:observation.state,lastVerifiedAt:new Date(this.now()).toISOString(),lastError:null};this.store.db.prepare(`INSERT INTO repository_controller(repository_id,instance_id,generation,remote_sha,state,last_verified_at,last_error) VALUES(@repositoryId,@instanceId,@generation,@remoteSha,@state,@lastVerifiedAt,@lastError) ON CONFLICT(repository_id) DO UPDATE SET instance_id=excluded.instance_id,generation=excluded.generation,remote_sha=excluded.remote_sha,state=excluded.state,last_verified_at=excluded.last_verified_at,last_error=excluded.last_error`).run(row);}
}

export function formatControllerStatus(observation:LeaseObservation,repositoryName:string){
 const lines=[`Repository: ${repositoryName}`,`This instance: ${observation.instance.displayName} (${observation.instance.instanceId})`];
 if(observation.state==="absent")return [...lines,"Controller: none","The repository is available for acquisition."].join("\n");
 const seconds=Math.floor(observation.heartbeatAgeMs/1000);lines.push(`Controller: ${observation.record.displayName}`,`Contact: ${observation.record.contact||"not provided"}`,`State: ${observation.state}`,`Generation: ${observation.record.generation}`,`Heartbeat age: ${seconds}s`,`Expires: ${observation.expiresAt}`,`Active work: ${observation.record.activeWorkCount}`);return lines.join("\n");
}

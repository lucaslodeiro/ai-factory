import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {config} from "./config.js";
import {factoryHome} from "./home.js";
import {readOrCreateInstance,type FactoryInstance} from "./instance.js";
import type {Repository} from "./adapters/github.js";
import type {Store} from "./storage.js";
import {factoryEngineRoot} from "./home.js";

export const CONTROLLER_REF="refs/ai-factory/lease",CONTROLLER_HEARTBEAT_MS=120_000,CONTROLLER_LEASE_MS=600_000;
export type ControllerLeaseRecord={schemaVersion:1;repositoryId:number;repositoryNodeId:string;instanceId:string;displayName:string;contact:string;generation:number;engineVersion:string;acquiredAt:string;heartbeatAt:string;activeWorkCount:number};
export type LeaseObservation={state:"absent";instance:FactoryInstance}|{state:"active"|"standby"|"expired";sha:string;record:ControllerLeaseRecord;expiresAt:string;heartbeatAgeMs:number;instance:FactoryInstance};
type PresentLease=Exclude<LeaseObservation,{state:"absent"}>;
export class ControllerCasError extends Error{constructor(message="Repository controller changed concurrently"){super(message);this.name="ControllerCasError";}}

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
 private git(args:string[],input?:string){const result=spawnSync(this.gitCommand,[`--git-dir=${this.controlDir}`,...args],{input,encoding:"utf8",timeout:60_000,maxBuffer:2_000_000,env:{...process.env,GIT_AUTHOR_NAME:"AI Factory",GIT_AUTHOR_EMAIL:"noreply@ai-factory.local",GIT_COMMITTER_NAME:"AI Factory",GIT_COMMITTER_EMAIL:"noreply@ai-factory.local"}});if(result.status!==0)throw new Error((result.stderr||result.error?.message||"Controller Git operation failed").trim());return result.stdout.trim();}
 private ensureBare(){if(!fs.existsSync(path.join(this.controlDir,"HEAD"))){fs.mkdirSync(path.dirname(this.controlDir),{recursive:true});const result=spawnSync(this.gitCommand,["init","--bare",this.controlDir],{encoding:"utf8",timeout:30_000});if(result.status!==0)throw new Error((result.stderr||result.error?.message||"Could not initialize controller repository").trim());}const current=spawnSync(this.gitCommand,[`--git-dir=${this.controlDir}`,"remote","get-url","origin"],{encoding:"utf8"});if(current.status===0)this.git(["remote","set-url","origin",this.remote]);else this.git(["remote","add","origin",this.remote]);}
 readLease():LeaseObservation{
  this.ensureBare();const line=this.git(["ls-remote","origin",CONTROLLER_REF]).split(/\r?\n/).find(Boolean);
  if(!line){const result={state:"absent",instance:this.instance} as const;this.remember(result);return result;}
  const [sha,ref]=line.trim().split(/\s+/);if(ref!==CONTROLLER_REF||!/^[0-9a-f]{40,64}$/.test(sha))throw new Error("Invalid controller lease ref response");
  this.git(["fetch","--no-tags","origin",CONTROLLER_REF]);
  let parsed:unknown;try{parsed=JSON.parse(this.git(["cat-file","-p",`${sha}:lease.json`]));}catch(error){throw new Error(`Malformed controller lease record: ${error instanceof Error?error.message:String(error)}`);}
  const record=validateLeaseRecord(parsed,this.repository),heartbeat=Date.parse(record.heartbeatAt),expiresAt=new Date(heartbeat+CONTROLLER_LEASE_MS).toISOString(),heartbeatAgeMs=Math.max(0,this.now()-heartbeat),state=record.instanceId===this.instance.instanceId?"active":heartbeatAgeMs>=CONTROLLER_LEASE_MS?"expired":"standby",result={state,sha,record,expiresAt,heartbeatAgeMs,instance:this.instance} as LeaseObservation;this.remember(result);return result;
 }
 acquire():LeaseObservation{
  this.store?.event("controller.acquire_requested",{repository:this.repository.fullName,displayName:this.instance.displayName});
  for(let attempt=0;attempt<2;attempt++){
   const observed=this.readLease();
   if(observed.state!=="absent"&&observed.record.instanceId!==this.instance.instanceId){this.store?.event("controller.standby",{repository:this.repository.fullName,owner:observed.record.displayName,generation:observed.record.generation});return observed;}
   if(observed.state!=="absent")return this.renew(observed);
   const now=this.nowIso(),record=this.newRecord(1,now,now);
   if(this.updateRemoteRef(this.commit(record),"")){const acquired=this.readLease();this.store?.event("controller.acquired",{repository:this.repository.fullName,displayName:this.instance.displayName,generation:1});return acquired;}
  }
  return this.readLease();
 }
 renew(observed:PresentLease):LeaseObservation{
  if(observed.record.instanceId!==this.instance.instanceId)throw new Error(`Repository is controlled by ${observed.record.displayName}`);
  const record={...observed.record,displayName:this.instance.displayName,heartbeatAt:this.nowIso(),activeWorkCount:this.activeWorkCount()};
  if(!this.updateRemoteRef(this.commit(record),observed.sha))throw new ControllerCasError();
  return this.readLease();
 }
 release(force=false):LeaseObservation{
  this.store?.event("controller.release_requested",{repository:this.repository.fullName,displayName:this.instance.displayName,force});
  const unsafe=this.unsafeWorkCount();if(unsafe&&!force)throw new Error(`${unsafe} active work item${unsafe===1?"":"s"}; use --force to abandon controller ownership`);
  const observed=this.readLease();if(observed.state==="absent")return observed;if(observed.record.instanceId!==this.instance.instanceId)throw new Error(`Repository is controlled by ${observed.record.displayName}`);
  if(!this.updateRemoteRef(null,observed.sha))throw new ControllerCasError();const released=this.readLease();this.store?.event("controller.released",{repository:this.repository.fullName,displayName:this.instance.displayName,generation:observed.record.generation});return released;
 }
 takeover(force=false,displayed:LeaseObservation=this.readLease()):LeaseObservation{
  const observed=displayed;if(observed.state==="absent")return this.acquire();if(observed.record.instanceId===this.instance.instanceId)return this.renew(observed);if(observed.state!=="expired"&&!force){this.store?.event("controller.takeover_rejected",{repository:this.repository.fullName,owner:observed.record.displayName,generation:observed.record.generation});throw new Error(`Controller ${observed.record.displayName} has not expired`);}
  const now=this.nowIso(),record=this.newRecord(observed.record.generation+1,now,now);
  if(!this.updateRemoteRef(this.commit(record),observed.sha)){this.store?.event("controller.takeover_rejected",{repository:this.repository.fullName,owner:observed.record.displayName,generation:observed.record.generation});throw new ControllerCasError("Another takeover won the repository controller race");}
  const taken=this.readLease();this.store?.event("controller.takeover",{repository:this.repository.fullName,previousOwner:observed.record.displayName,newOwner:this.instance.displayName,generation:record.generation,force});return taken;
 }
 assertController(generation:number){const observed=this.readLease();if(observed.state==="absent"||observed.record.instanceId!==this.instance.instanceId||observed.record.generation!==generation)throw new Error("Repository controller ownership was lost");return observed;}
 markLocalState(state:"uncertain"|"fenced"|"standby",error?:string){this.store?.db.prepare("UPDATE repository_controller SET state=?,last_error=? WHERE repository_id=?").run(state,error??null,this.repository.id);}
 private newRecord(generation:number,acquiredAt:string,heartbeatAt:string):ControllerLeaseRecord{let engineVersion="unknown";try{engineVersion=String(JSON.parse(fs.readFileSync(path.join(factoryEngineRoot(),"package.json"),"utf8")).version??"unknown");}catch{}return{schemaVersion:1,repositoryId:this.repository.id,repositoryNodeId:this.repository.nodeId,instanceId:this.instance.instanceId,displayName:this.instance.displayName,contact:"",generation,engineVersion,acquiredAt,heartbeatAt,activeWorkCount:this.activeWorkCount()};}
 private activeWorkCount(){if(!this.store)return 0;return (this.store.db.prepare("SELECT COUNT(*) count FROM work_items WHERE archived_at IS NULL AND status IN ('QUEUED','RUNNING','WAITING','FAILED','PAUSED')").get() as {count:number}).count;}
 private unsafeWorkCount(){return this.activeWorkCount();}
 private nowIso(){return new Date(this.now()).toISOString();}
 private commit(record:ControllerLeaseRecord){const body=`${JSON.stringify(record,null,2)}\n`,blob=this.git(["hash-object","-w","--stdin"],body),tree=this.git(["mktree"],`100644 blob ${blob}\tlease.json\n`);return this.git(["commit-tree",tree],"repository controller lease\n");}
 private updateRemoteRef(commit:string|null,expected:string){const current=this.git(["ls-remote","origin",CONTROLLER_REF]).split(/\s+/)[0]??"";if(current!==expected)return false;const refspec=commit?`${commit}:${CONTROLLER_REF}`:`:${CONTROLLER_REF}`,lease=`--force-with-lease=${CONTROLLER_REF}:${expected}`,result=spawnSync(this.gitCommand,[`--git-dir=${this.controlDir}`,"push","origin",refspec,lease],{encoding:"utf8",timeout:60_000,maxBuffer:2_000_000});if(result.status===0)return true;const message=`${result.stdout}\n${result.stderr}`;if(/stale info|rejected|fetch first/i.test(message))return false;throw new Error((result.stderr||result.error?.message||"Controller ref update failed").trim());}
 private remember(observation:LeaseObservation){if(!this.store)return;const row=observation.state==="absent"?{repositoryId:this.repository.id,instanceId:this.instance.instanceId,generation:null,remoteSha:null,state:"absent",lastVerifiedAt:new Date(this.now()).toISOString(),lastError:null}:{repositoryId:this.repository.id,instanceId:observation.record.instanceId,generation:observation.record.generation,remoteSha:observation.sha,state:observation.state,lastVerifiedAt:new Date(this.now()).toISOString(),lastError:null};this.store.db.prepare(`INSERT INTO repository_controller(repository_id,instance_id,generation,remote_sha,state,last_verified_at,last_error) VALUES(@repositoryId,@instanceId,@generation,@remoteSha,@state,@lastVerifiedAt,@lastError) ON CONFLICT(repository_id) DO UPDATE SET instance_id=excluded.instance_id,generation=excluded.generation,remote_sha=excluded.remote_sha,state=excluded.state,last_verified_at=excluded.last_verified_at,last_error=excluded.last_error`).run(row);}
}

export function formatControllerStatus(observation:LeaseObservation,repositoryName:string){
 const lines=[`Repository: ${repositoryName}`,`This instance: ${observation.instance.displayName} (${observation.instance.instanceId})`];
 if(observation.state==="absent")return [...lines,"Controller: none","The repository is available for acquisition."].join("\n");
 const seconds=Math.floor(observation.heartbeatAgeMs/1000);lines.push(`Controller: ${observation.record.displayName}`,`Contact: ${observation.record.contact||"not provided"}`,`State: ${observation.state}`,`Generation: ${observation.record.generation}`,`Heartbeat age: ${seconds}s`,`Expires: ${observation.expiresAt}`,`Active work: ${observation.record.activeWorkCount}`);return lines.join("\n");
}

export type CachedControllerState={state:"unconfigured"|"absent"|"active"|"standby"|"expired"|"uncertain"|"fenced";instanceId:string|null;generation:number|null;remoteSha:string|null;lastVerifiedAt:string|null;lastError:string|null};
export function cachedControllerState(store:Store):CachedControllerState{
 const row=store.db.prepare("SELECT instance_id instanceId,generation,remote_sha remoteSha,state,last_verified_at lastVerifiedAt,last_error lastError FROM repository_controller ORDER BY last_verified_at DESC LIMIT 1").get() as Omit<CachedControllerState,"state">&{state:CachedControllerState["state"]}|undefined;
 return row??{state:"unconfigured",instanceId:null,generation:null,remoteSha:null,lastVerifiedAt:null,lastError:null};
}
export function controllerAttribution(store:Store){const cached=cachedControllerState(store);if(!cached.instanceId||cached.generation===null)return null;let displayName=`Factory ${cached.instanceId.replaceAll("-","").slice(0,6)}`;try{const value=JSON.parse(fs.readFileSync(path.join(factoryHome(),"instance.json"),"utf8")) as FactoryInstance;if(value.instanceId===cached.instanceId)displayName=value.displayName;}catch{}return{displayName,generation:cached.generation};}

import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {factoryHome} from "./home.js";

export type FactoryInstance={schemaVersion:1;instanceId:string;displayName:string;createdAt:string};

export function validateInstance(value:unknown):FactoryInstance{
 const candidate=value as Partial<FactoryInstance>;
 if(!candidate||candidate.schemaVersion!==1||typeof candidate.instanceId!=="string"||!/^[0-9a-f-]{36}$/i.test(candidate.instanceId)||typeof candidate.displayName!=="string"||!candidate.displayName.trim()||typeof candidate.createdAt!=="string"||!Number.isFinite(Date.parse(candidate.createdAt)))throw new Error("Invalid AI Factory instance identity");
 return candidate as FactoryInstance;
}

export function readOrCreateInstance(home=factoryHome(),now=()=>new Date()):FactoryInstance{
 const file=path.join(home,"instance.json");
 if(fs.existsSync(file))return validateInstance(JSON.parse(fs.readFileSync(file,"utf8")));
 fs.mkdirSync(home,{recursive:true});
 const instanceId=randomUUID(),identity:FactoryInstance={schemaVersion:1,instanceId,displayName:`Factory ${instanceId.replaceAll("-","").slice(0,6)}`,createdAt:now().toISOString()},temporary=`${file}.tmp-${process.pid}`;
 fs.writeFileSync(temporary,`${JSON.stringify(identity,null,2)}\n`,{mode:0o600,flag:"wx"});
 try{fs.renameSync(temporary,file);}catch(error){fs.rmSync(temporary,{force:true});if(fs.existsSync(file))return validateInstance(JSON.parse(fs.readFileSync(file,"utf8")));throw error;}
 return identity;
}

export function readInstance(home=factoryHome()):FactoryInstance{return validateInstance(JSON.parse(fs.readFileSync(path.join(home,"instance.json"),"utf8")));}

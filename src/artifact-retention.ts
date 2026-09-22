import fs from "node:fs";
import path from "node:path";
import {config} from "./config.js";
import type {Store} from "./storage.js";

const removable=["prompt.md","stdout.log","stderr.log","completion.json","worker.json","review.diff"];
export function pruneExecutionArtifacts(store:Store,now=Date.now()) {
 if(config.artifactRetentionDays===0)return{executions:0,files:0,disabled:true};const cutoff=new Date(now-config.artifactRetentionDays*86_400_000).toISOString();
 const rows=store.db.prepare(`SELECT e.id FROM executions e JOIN work_items w ON w.id=e.work_item_id WHERE w.status IN ('COMPLETED','CANCELLED') AND w.updated_at<=?`).all(cutoff) as Array<{id:string}>;let files=0;
 for(const row of rows){const directory=path.join(config.dataDir,"runs",row.id);for(const name of removable){const file=path.join(directory,name);if(fs.existsSync(file)){fs.rmSync(file,{force:true});files++;}}}
 if(files)store.event("artifacts.pruned",{executions:rows.length,files,cutoff});return{executions:rows.length,files,disabled:false};
}

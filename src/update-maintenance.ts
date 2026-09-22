import fs from "node:fs";
import type {Store} from "./storage.js";

type UpdateOutcome={maintenanceId?:string;status?:string;phase?:string;startedAt?:string;finishedAt?:string};

// A finished update supersedes older preparations that never started. Preserve
// paused tasks for explicit resume, and never release a newer or running barrier.
export function reconcileUpdateMaintenance(store:Store,state:UpdateOutcome){
 if(!state||!["completed","failed"].includes(state.status??""))return 0;
 return store.db.transaction(()=>{
  const current=state.maintenanceId?store.db.prepare("SELECT id,status,requested_at FROM maintenance_operations WHERE id=? AND operation='update'").get(state.maintenanceId) as {id:string;status:string;requested_at:string}|undefined:undefined;
  let reconciled=0;
  const finish=(id:string,status:string,error:string|null)=>{
    store.db.prepare("UPDATE maintenance_operations SET status=?,finished_at=?,error=? WHERE id=?").run(status,new Date().toISOString(),error,id);
   store.event(`maintenance.${status}`,{maintenanceId:id,operation:"update",error:error??undefined,reconciledBy:current?.id??"update-state"});
    reconciled++;
  };
  if(current&&!['completed','failed'].includes(current.status))finish(current.id,state.status!,state.status==="failed"?state.phase??"Update failed":null);
  if(current){
   const abandoned=store.db.prepare("SELECT id FROM maintenance_operations WHERE operation='update' AND id<>? AND requested_at<=? AND status IN ('requested','confirmed','pausing','ready')").all(current.id,current.requested_at) as {id:string}[];
   for(const row of abandoned)finish(row.id,"failed",`Superseded by finished update ${current.id}`);
  }
  // A dashboard may be replaced while its independent updater finishes. A
  // terminal durable update makes an empty update barrier from before that run
  // stale even when the updater could not persist its maintenance id. It has
  // no paused work to resume, so it must never block a later scheduler tick.
  const started=Date.parse(state.startedAt??''),finished=Date.parse(state.finishedAt??'');
  if(Number.isFinite(started)&&Number.isFinite(finished)&&finished>=started){
   const barrier=`operation='update' AND status IN ('confirmed','pausing','ready','running') AND NOT EXISTS(SELECT 1 FROM maintenance_items WHERE maintenance_id=maintenance_operations.id)`;
   const orphaned=store.db.prepare(`SELECT id FROM maintenance_operations WHERE ${barrier} AND requested_at>=? AND requested_at<=?`).all(new Date(started).toISOString(),new Date(finished).toISOString()) as {id:string}[];
   const older=store.db.prepare(`SELECT id FROM maintenance_operations WHERE ${barrier} AND requested_at<?`).all(new Date(started).toISOString()) as {id:string}[];
   for(const row of [...orphaned,...older])if(row.id!==current?.id)finish(row.id,state.status!,state.status==="failed"?state.phase??"Update failed":null);
  }
  return reconciled;
 }).immediate();
}

export function reconcileUpdateMaintenanceFile(store:Store,file:string){
 let state:UpdateOutcome;
 try{state=JSON.parse(fs.readFileSync(file,"utf8"));}catch{return 0;}
 return reconcileUpdateMaintenance(store,state);
}

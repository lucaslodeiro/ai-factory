import fs from "node:fs";
import type {Store} from "./storage.js";

type UpdateOutcome={maintenanceId?:string;status?:string;phase?:string};

// A finished update supersedes older preparations that never started. Preserve
// paused tasks for explicit resume, and never release a newer or running barrier.
export function reconcileUpdateMaintenance(store:Store,state:UpdateOutcome){
 if(!state?.maintenanceId||!["completed","failed"].includes(state.status??""))return 0;
 return store.db.transaction(()=>{
  const current=store.db.prepare("SELECT id,status,requested_at FROM maintenance_operations WHERE id=? AND operation='update'").get(state.maintenanceId) as {id:string;status:string;requested_at:string}|undefined;
  if(!current)return 0;
  let reconciled=0;
  const finish=(id:string,status:string,error:string|null)=>{
   store.db.prepare("UPDATE maintenance_operations SET status=?,finished_at=?,error=? WHERE id=?").run(status,new Date().toISOString(),error,id);
   store.event(`maintenance.${status}`,{maintenanceId:id,operation:"update",error:error??undefined,reconciledBy:current.id});
   reconciled++;
  };
  if(!["completed","failed"].includes(current.status))finish(current.id,state.status!,state.status==="failed"?state.phase??"Update failed":null);
  const abandoned=store.db.prepare("SELECT id FROM maintenance_operations WHERE operation='update' AND id<>? AND requested_at<=? AND status IN ('requested','confirmed','pausing','ready')").all(current.id,current.requested_at) as {id:string}[];
  for(const row of abandoned)finish(row.id,"failed",`Superseded by finished update ${current.id}`);
  return reconciled;
 }).immediate();
}

export function reconcileUpdateMaintenanceFile(store:Store,file:string){
 let state:UpdateOutcome;
 try{state=JSON.parse(fs.readFileSync(file,"utf8"));}catch{return 0;}
 return reconcileUpdateMaintenance(store,state);
}

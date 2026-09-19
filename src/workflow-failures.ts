import { randomUUID } from "node:crypto";
import type { Store } from "./storage.js";
import type { V3Stage } from "./workflow-records.js";

export type FailureClass = "execution"|"invalid-result"|"invalid-context"|"recovery"|"integration"|"configuration";
export interface WorkflowFailure { id:string;workItemId:string;executionId?:string;class:FailureClass;message:string;stage:V3Stage;attempt:number;createdAt:string;resolvedAt?:string;resolvedBy?:string; }
type Row={id:string;work_item_id:string;execution_id:string|null;class:FailureClass;message:string;stage:V3Stage;attempt:number;created_at:string;resolved_at:string|null;resolved_by:string|null};
const parse=(row:Row):WorkflowFailure=>({id:row.id,workItemId:row.work_item_id,executionId:row.execution_id??undefined,class:row.class,message:row.message,stage:row.stage,attempt:row.attempt,createdAt:row.created_at,resolvedAt:row.resolved_at??undefined,resolvedBy:row.resolved_by??undefined});

export class WorkflowFailures {
 constructor(private store:Store) {}
 open(input:Omit<WorkflowFailure,"id"|"createdAt"|"resolvedAt"|"resolvedBy">) {
  const id=randomUUID(),createdAt=new Date().toISOString();
  this.store.db.prepare("INSERT INTO failures(id,work_item_id,execution_id,class,message,stage,attempt,created_at) VALUES(?,?,?,?,?,?,?,?)")
   .run(id,input.workItemId,input.executionId??null,input.class,input.message,input.stage,input.attempt,createdAt);
  return this.get(id)!;
 }
 get(id:string) { const row=this.store.db.prepare("SELECT * FROM failures WHERE id=?").get(id) as Row|undefined; return row ? parse(row) : undefined; }
 active(workItemId:string) { const row=this.store.db.prepare("SELECT * FROM failures WHERE work_item_id=? AND resolved_at IS NULL").get(workItemId) as Row|undefined; return row ? parse(row) : undefined; }
 resolve(id:string,resolvedBy:string) {
  const current=this.get(id); if (!current || current.resolvedAt) throw new Error("Only an unresolved failure can be resolved");
  this.store.db.prepare("UPDATE failures SET resolved_at=?,resolved_by=? WHERE id=?").run(new Date().toISOString(),resolvedBy,id);
  return this.get(id)!;
 }
}

import type { Store } from "./storage.js";
import type { WorkflowGitHubPort } from "./adapters/github.js";
import { workflowStatusMarkdown,workflowLabels } from "./workflow-status.js";

export class WorkflowGitHubPublisher {
 constructor(private store:Store,private github:WorkflowGitHubPort) {}
 publish(workItemId:string) {
  const row=this.store.db.prepare("SELECT issue_number,revision,presentation_revision,published_presentation_revision,archived_at FROM work_items WHERE id=?").get(workItemId) as {issue_number:number;revision:number;presentation_revision:number;published_presentation_revision:number|null;archived_at:string|null}|undefined;
  if(!row)throw new Error("Unknown work item");
  if(row.archived_at||row.presentation_revision<=(row.published_presentation_revision??-1))return false;
  const revision=row.revision,presentationRevision=row.presentation_revision;
  const lastEvent=this.store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='workflow.transition' ORDER BY id DESC LIMIT 1").get(workItemId) as {payload:string}|undefined;
  let eventId:string|undefined;try{eventId=lastEvent?(JSON.parse(lastEvent.payload) as {eventId?:string}).eventId:undefined;}catch{}
  const body=`${workflowStatusMarkdown(this.store,workItemId)}\n\n<sub>workflow-rev:${revision} · presentation-rev:${presentationRevision}${eventId?` · event:${eventId}`:""}</sub>`;
  this.github.syncWorkflow(row.issue_number,workflowLabels(this.store,workItemId),body);
  this.store.db.prepare("UPDATE work_items SET published_presentation_revision=? WHERE id=? AND (published_presentation_revision IS NULL OR published_presentation_revision<?)").run(presentationRevision,workItemId,presentationRevision);
  return true;
 }
 publishChanged() {let count=0;for(const row of this.store.db.prepare("SELECT id FROM work_items WHERE archived_at IS NULL AND presentation_revision>COALESCE(published_presentation_revision,-1)").all() as Array<{id:string}>)if(this.publish(row.id))count++;return count;}
}

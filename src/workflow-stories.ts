import type { Issue } from "./adapters/github.js";
import type { Store } from "./storage.js";
import type { Criterion, Story, StoryAssessment, TaskAssessment } from "./types.js";
import { WorkflowProjections } from "./workflow-projection.js";
import { WorkflowRecords } from "./workflow-records.js";

// A story row is the local ledger of a split: it exists from the approval that planned it, and the
// GitHub issue, its dependencies and its work item are attached to it as each one is created. The
// primary key is what makes creation idempotent after a crash: a story is never planned twice.
export interface StoryRow {
 epic_work_item_id:string;spec_version:number;key:string;title:string;scope:string;criteria:string[];depends_on:string[];assessment:StoryAssessment;
 issue_number:number|null;issue_id:number|null;dependencies_declared:boolean;work_item_id:string|null;
}
interface RawStoryRow {epic_work_item_id:string;spec_version:number;key:string;title:string;scope:string;criteria:string;depends_on:string;assessment:string;issue_number:number|null;issue_id:number|null;dependencies_declared:number;work_item_id:string|null}
export interface EpicRow {id:string;issue_number:number;issue_id:number|null;branch:string;stage:string;status:string;revision:number;archived_at:string|null;context:string;spec_version:number}

const parse=(row:RawStoryRow):StoryRow=>({...row,criteria:JSON.parse(row.criteria),depends_on:JSON.parse(row.depends_on),assessment:JSON.parse(row.assessment),dependencies_declared:Boolean(row.dependencies_declared)});

export class WorkflowStories {
 constructor(private store:Store){}
 // Called inside the approval transaction: the split becomes durable with the approval itself.
 plan(epicWorkItemId:string,specVersion:number,stories:Story[]){
  const insert=this.store.db.prepare("INSERT INTO stories(epic_work_item_id,spec_version,key,title,scope,criteria,depends_on,assessment,created_at) VALUES(?,?,?,?,?,?,?,?,?)"),now=new Date().toISOString();
  for(const story of stories)insert.run(epicWorkItemId,specVersion,story.key,story.title,story.scope,JSON.stringify(story.criteria),JSON.stringify(story.dependsOn),JSON.stringify(story.assessment),now);
 }
 forEpic(epicWorkItemId:string,specVersion:number):StoryRow[]{return (this.store.db.prepare("SELECT * FROM stories WHERE epic_work_item_id=? AND spec_version=? ORDER BY created_at,key").all(epicWorkItemId,specVersion) as RawStoryRow[]).map(parse);}
 byIssueId(issueId:number):StoryRow|undefined{const row=this.store.db.prepare("SELECT * FROM stories WHERE issue_id=?").get(issueId) as RawStoryRow|undefined;return row?parse(row):undefined;}
 // Epics whose current specification planned stories and that are still waiting for them.
 epics():EpicRow[]{
  return this.store.db.prepare(`SELECT w.id,w.issue_number,w.issue_id,w.branch,w.stage,w.status,w.revision,w.archived_at,w.context,s.version spec_version FROM work_items w
   JOIN specs s ON s.work_item_id=w.id AND s.version=(SELECT MAX(version) FROM specs WHERE work_item_id=w.id)
   WHERE w.archived_at IS NULL AND w.epic_work_item_id IS NULL AND w.status NOT IN ('COMPLETED','CANCELLED') AND EXISTS(SELECT 1 FROM stories st WHERE st.epic_work_item_id=w.id AND st.spec_version=s.version)`).all() as EpicRow[];
 }
 attachIssue(story:StoryRow,issue:Pick<Issue,"number"|"id">){this.store.db.prepare("UPDATE stories SET issue_number=?,issue_id=? WHERE epic_work_item_id=? AND spec_version=? AND key=?").run(issue.number,issue.id,story.epic_work_item_id,story.spec_version,story.key);}
 markDependenciesDeclared(story:StoryRow){this.store.db.prepare("UPDATE stories SET dependencies_declared=1 WHERE epic_work_item_id=? AND spec_version=? AND key=?").run(story.epic_work_item_id,story.spec_version,story.key);}
 attachWorkItem(story:StoryRow,workItemId:string){this.store.db.prepare("UPDATE stories SET work_item_id=? WHERE epic_work_item_id=? AND spec_version=? AND key=?").run(workItemId,story.epic_work_item_id,story.spec_version,story.key);}
 // The issue body states the story's contract; what it belongs to and what it waits for are
 // GitHub relationships, not text.
 issueBody(epicIssue:number,story:StoryRow,criteria:Criterion[]){
  const owned=criteria.filter(criterion=>story.criteria.includes(criterion.id));
  return `Story **${story.key}** of #${epicIssue}, approved with its SPEC v${story.spec_version}. Complexity ${story.assessment.complexity}, risk ${story.assessment.risk}, verification depth ${story.assessment.verificationDepth}.\n\n## Scope\n\n${story.scope}\n\n## Acceptance criteria\n\n${owned.map(criterion=>`- **${criterion.id}** — ${criterion.description}`).join("\n")}`;
 }
 // The story's own specification: its slice of the epic contract, approved by the epic's approval.
 specification(epic:{issue_number:number;title:string;body:string;criteria:Criterion[];assessment:TaskAssessment|null;approved_by:string|null;approval_comment_id:number|null;approved_at:string|null},story:StoryRow){
  const owned=epic.criteria.filter(criterion=>story.criteria.includes(criterion.id));
  const body=`# Story ${story.key}: ${story.title}\n\nPart of epic #${epic.issue_number} (${epic.title}), delivered on its own branch from the epic branch and approved with the epic's SPEC v${story.spec_version}. Implement and verify only this story's scope and criteria; the epic specification below is the contract it belongs to.\n\n## Scope\n\n${story.scope}\n\n## Acceptance criteria of this story\n\n${owned.map(criterion=>`- **${criterion.id}** — ${criterion.description}`).join("\n")}\n\n---\n\n${epic.body}`;
  // The story's own risk and depth govern its Tester; the epic's UX impact and rationale still apply.
  const assessment:TaskAssessment={...story.assessment,uxImpact:epic.assessment?.uxImpact??"none",rationale:`Story ${story.key} of #${epic.issue_number}: ${epic.assessment?.rationale??"assessed with the epic"}`};
  return {body,criteria:owned,assessment,approvedBy:epic.approved_by,approvalCommentId:epic.approval_comment_id,approvedAt:epic.approved_at};
 }
 // What the completed stories already verified, for the epic's own Tester and Reviewer: the
 // criteria each story owns and the coverage its Tester reported. The epic verifies the rest and
 // runs the project's suite once; it does not repeat the stories' tests.
 verifiedByStories(epicWorkItemId:string,specVersion:number){
  const stories=this.forEpic(epicWorkItemId,specVersion).filter(row=>row.work_item_id).filter(row=>(this.store.db.prepare("SELECT status FROM work_items WHERE id=?").get(row.work_item_id) as {status:string}|undefined)?.status==="COMPLETED");
  return stories.map(story=>{
   let coverage:unknown[]=[];
   for(const row of this.store.db.prepare("SELECT payload FROM events WHERE work_item_id=? AND type='agent.result' ORDER BY id DESC").all(story.work_item_id) as Array<{payload:string}>){const payload=JSON.parse(row.payload) as {role?:string;result?:{coverage?:unknown[]}};if(payload.role==="qa"){coverage=payload.result?.coverage??[];break;}}
   return {key:story.key,issue:story.issue_number,criteria:story.criteria,verificationDepth:story.assessment.verificationDepth,coverage};
  });
 }
 // Every story of the epic's current plan has been integrated into the epic branch.
 integrated(epic:EpicRow){
  const rows=this.forEpic(epic.id,epic.spec_version);if(!rows.length||rows.some(row=>!row.work_item_id))return false;
  const statuses=this.store.db.prepare(`SELECT status FROM work_items WHERE id IN (${rows.map(()=>"?").join(",")})`).all(...rows.map(row=>row.work_item_id)) as Array<{status:string}>;
  return statuses.length===rows.length&&statuses.every(row=>row.status==="COMPLETED");
 }
 // The epic resumes on its own branch once its stories are in it. Review is the target; the runner
 // sends it through Test first because the branch head moved since anything was verified.
 resume(epic:EpicRow){
  const projections=new WorkflowProjections(this.store),records=new WorkflowRecords(this.store),current=projections.get(epic.id),request=records.activeRequest(epic.id);
  if(current.status!=="WAITING"||request?.payload.kind!=="request"||request.payload.type!=="stories")return undefined;
  return projections.transition({workItemId:epic.id,expectedRevision:current.revision,stage:"REVIEW",status:"QUEUED",actor:{type:"orchestrator",id:"stories"},source:{},reason:{code:"stories-integrated",summary:"Every story is integrated into the epic branch"},recordIds:[request.id]},()=>{records.resolveRequest(request.id);});
 }
}

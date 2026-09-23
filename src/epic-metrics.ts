import type { Store } from "./storage.js";
import { budgetFamily, budgetLedger } from "./budget.js";

// The numbers that say whether a split, a depth or a test selection was worth it. Everything here
// is read from rows and events the workflow already writes; nothing is estimated. A metric nobody
// measured is reported as null, never as zero.

export interface MemberMetrics {
 id:string; issue:number; kind:"epic"|"story"|"issue"; key:string|null; stage:string|null; status:string|null;
 tokens:number; unmeasuredRuns:number; executions:Record<string,number>; correctionCycles:number; attempts:number;
 startedAt:string|null; completedAt:string|null; durationSeconds:number|null;
 outcomes:ExecutionOutcomes;
}
// How the runs ended, which is what says whether recovering interrupted work would be worth building:
// a run that ends without a result is spent again by the next attempt.
export interface ExecutionOutcomes {
 /** Per role, how many runs ended in each status; an interruption is keyed by its reason (`interrupted:user-pause`). */
 byRole:Record<string,Record<string,number>>;
 /** Finished runs that produced no result: every status except `succeeded` and `running`. */
 unsuccessful:number;
 /** Wall time of those runs; null when none of them has both a start and an end. */
 unsuccessfulSeconds:number|null;
 /** Runs that succeeded but whose result the validator rejected. */
 invalidResults:number;
 /** The longest run of consecutive timeouts in one stage: at 2 or more, the slice does not fit the time limit. */
 longestTimeoutStreak:{stage:string|null;runs:number};
}
export interface TestingMetrics { runs:number; candidates:number; kept:number; essential:number; valuable:number; redundant:number; valuableDiscarded:number; keptRatio:number|null; byDepth:Record<string,{runs:number;candidates:number;kept:number}> }
// Turns are the multiplier on every optimization that trims what a role writes or reads: each turn
// re-reads the whole prompt and everything written or read so far, so fewer turns compounds with a
// smaller prompt while a smaller prompt alone does not. Per role, so a contract change aimed at one
// role (for example, batching a Designer's screenshots into one script) shows up here directly.
export interface TurnsByRole { runs:number; measuredRuns:number; totalTurns:number; avgTurns:number|null }
export interface EpicMetricsReport {
 workItem:{id:string;issue:number;kind:"epic"|"issue"};
 members:MemberMetrics[];
 totals:{tokens:number;executions:number;correctionCycles:number;humanCommands:number;stories:number;storiesCompleted:number;wallSeconds:number|null;
  unsuccessfulExecutions:number;unsuccessfulSeconds:number|null;invalidResults:number;longestTimeoutStreak:{stage:string|null;runs:number}};
 testing:TestingMetrics;
 turnsByRole:Record<string,TurnsByRole>;
 epicVerification:Array<{role:string;criteria:number;verifiedByStories:number;required:number;covered:number}>;
 findings:{byRole:Record<string,Record<string,number>>;reviewerOnStoryCriteria:number;noChangePasses:number};
 interventions:{commands:number;byKind:Record<string,number>};
}

const count=(record:Record<string,number>,key:string)=>{record[key]=(record[key]??0)+1;};

function executionOutcomes(store:Store,id:string):ExecutionOutcomes {
 const runs=store.db.prepare("SELECT role,stage,status,interruption_reason,started_at,finished_at FROM executions WHERE work_item_id=? ORDER BY started_at,rowid").all(id) as Array<{role:string;stage:string|null;status:string;interruption_reason:string|null;started_at:string;finished_at:string|null}>;
 const byRole:Record<string,Record<string,number>>={},streak={stage:null as string|null,runs:0},current={stage:null as string|null,runs:0};
 let unsuccessful=0,seconds:number|null=null;
 for(const run of runs){
  count(byRole[run.role]??(byRole[run.role]={}),run.status==="interrupted"&&run.interruption_reason?`interrupted:${run.interruption_reason}`:run.status);
  if(run.status!=="succeeded"&&run.status!=="running"){
   unsuccessful++;
   const elapsed=run.finished_at?(Date.parse(run.finished_at)-Date.parse(run.started_at))/1000:NaN;
   if(Number.isFinite(elapsed)&&elapsed>=0)seconds=(seconds??0)+elapsed;
  }
  // A work item runs one execution at a time, so any run that did not time out ends the streak.
  if(run.status==="timed_out"){if(current.runs&&current.stage===run.stage)current.runs++;else{current.stage=run.stage;current.runs=1;}}
  else if(run.status!=="running"){current.stage=null;current.runs=0;}
  if(current.runs>streak.runs){streak.stage=current.stage;streak.runs=current.runs;}
 }
 const invalidResults=(store.db.prepare("SELECT COUNT(*) count FROM events WHERE work_item_id=? AND type='execution.invalid_result'").get(id) as {count:number}).count;
 return {byRole,unsuccessful,unsuccessfulSeconds:seconds===null?null:Math.round(seconds),invalidResults,longestTimeoutStreak:streak};
}

function addTurns(target:Record<string,TurnsByRole>,role:string,turns:unknown){
 const bucket=target[role]??(target[role]={runs:0,measuredRuns:0,totalTurns:0,avgTurns:null});
 bucket.runs++;
 if(typeof turns==="number"&&Number.isFinite(turns)){bucket.measuredRuns++;bucket.totalTurns+=turns;}
}
function turnsByRole(store:Store,id:string):Array<{role:string;turns:unknown}>{
 return (store.db.prepare("SELECT x.role role, e.payload payload FROM events e JOIN executions x ON x.id=e.run_id WHERE e.work_item_id=? AND e.type='execution.finished'").all(id) as Array<{role:string;payload:string}>)
  .map(row=>({role:row.role,turns:(JSON.parse(row.payload) as {activity?:{turns?:unknown}}).activity?.turns}));
}

export function epicMetrics(store:Store,workItemId:string):EpicMetricsReport {
 const family=budgetFamily(store,workItemId),owner=family[0];
 const rows=store.db.prepare(`SELECT id,issue_number,stage,status,correction_cycles,attempt,epic_work_item_id,created_at FROM work_items WHERE id IN (${family.map(()=>"?").join(",")})`).all(...family) as Array<{id:string;issue_number:number;stage:string|null;status:string|null;correction_cycles:number;attempt:number;epic_work_item_id:string|null;created_at:string}>;
 const byId=new Map(rows.map(row=>[row.id,row]));
 const stories=store.db.prepare("SELECT key,work_item_id,criteria FROM stories WHERE epic_work_item_id=?").all(owner) as Array<{key:string;work_item_id:string|null;criteria:string}>;
 const storyKey=new Map(stories.filter(story=>story.work_item_id).map(story=>[story.work_item_id!,story.key]));
 const storyCriteria=new Set(stories.flatMap(story=>JSON.parse(story.criteria) as string[]));
 const events=(type:string,id:string)=>(store.db.prepare("SELECT ts,payload FROM events WHERE work_item_id=? AND type=? ORDER BY id").all(id,type) as Array<{ts:string;payload:string}>).map(row=>({ts:row.ts,payload:JSON.parse(row.payload) as Record<string,unknown>}));
 const members:MemberMetrics[]=family.map(id=>{
  const row=byId.get(id);if(!row)throw new Error(`Unknown work item ${id}`);
  const ledger=budgetLedger(store,id),executions:Record<string,number>={};
  for(const run of store.db.prepare("SELECT role FROM executions WHERE work_item_id=?").all(id) as Array<{role:string}>)count(executions,run.role);
  const transitions=events("workflow.transition",id),completed=transitions.find(event=>(event.payload.to as {status?:string}|undefined)?.status==="COMPLETED");
  const startedAt=transitions[0]?.ts??row.created_at,completedAt=completed?.ts??null;
  return {id,issue:row.issue_number,kind:id===owner?(stories.length?"epic":"issue"):"story",key:storyKey.get(id)??null,stage:row.stage,status:row.status,
   tokens:ledger.reduce((total,entry)=>total+(entry.tokens??0),0),unmeasuredRuns:ledger.filter(entry=>entry.tokens===null).length,executions,correctionCycles:row.correction_cycles,attempts:row.attempt,
   startedAt,completedAt,durationSeconds:completedAt?Math.round((Date.parse(completedAt)-Date.parse(startedAt))/1000):null,outcomes:executionOutcomes(store,id)};
 });
 const testing:TestingMetrics={runs:0,candidates:0,kept:0,essential:0,valuable:0,redundant:0,valuableDiscarded:0,keptRatio:null,byDepth:{}};
 const epicVerification:EpicMetricsReport["epicVerification"]=[],findingsByRole:Record<string,Record<string,number>>={},commandsByKind:Record<string,number>={};
 const turns:Record<string,TurnsByRole>={};
 let reviewerOnStoryCriteria=0,noChangePasses=0,humanCommands=0;
 for(const id of family){
  for(const {role,turns:turnCount} of turnsByRole(store,id))addTurns(turns,role,turnCount);
  for(const {payload} of events("verification.selection",id)){
   testing.runs++;for(const key of ["candidates","kept","essential","valuable","redundant","valuableDiscarded"] as const)testing[key]+=Number(payload[key]??0);
   const depth=String(payload.verificationDepth??"unknown"),bucket=testing.byDepth[depth]??(testing.byDepth[depth]={runs:0,candidates:0,kept:0});bucket.runs++;bucket.candidates+=Number(payload.candidates??0);bucket.kept+=Number(payload.kept??0);
  }
  for(const {payload} of events("epic.verification_scope",id))epicVerification.push({role:String(payload.role),criteria:Number(payload.criteria),verifiedByStories:Number(payload.verifiedByStories),required:Number(payload.required),covered:Number(payload.covered)});
  for(const {payload} of events("command.applied",id)){humanCommands++;count(commandsByKind,String(payload.command??"unknown"));}
  for(const {payload} of events("workflow.transition",id))if((payload.reason as {code?:string}|undefined)?.code==="no-change-pass")noChangePasses++;
  for(const record of store.db.prepare("SELECT payload FROM records WHERE work_item_id=? AND kind='finding'").all(id) as Array<{payload:string}>){
   const finding=JSON.parse(record.payload) as {originRole?:string;severity?:string;criterionId?:string};
   const role=finding.originRole??"unknown";count(findingsByRole[role]??(findingsByRole[role]={}),finding.severity??"unknown");
   if(role==="reviewer"&&id===owner&&finding.criterionId&&storyCriteria.has(finding.criterionId))reviewerOnStoryCriteria++;
  }
 }
 testing.keptRatio=testing.candidates?Math.round(testing.kept*100/testing.candidates)/100:null;
 for(const bucket of Object.values(turns))bucket.avgTurns=bucket.measuredRuns?Math.round(bucket.totalTurns/bucket.measuredRuns*10)/10:null;
 const starts=members.map(member=>Date.parse(member.startedAt??"")).filter(Number.isFinite),ends=members.map(member=>Date.parse(member.completedAt??"")).filter(Number.isFinite);
 const ownerMember=members[0];
 return {
  workItem:{id:owner,issue:ownerMember.issue,kind:stories.length?"epic":"issue"},
  members,
  totals:{tokens:members.reduce((total,member)=>total+member.tokens,0),executions:members.reduce((total,member)=>total+Object.values(member.executions).reduce((a,b)=>a+b,0),0),correctionCycles:members.reduce((total,member)=>total+member.correctionCycles,0),humanCommands,stories:stories.length,storiesCompleted:members.filter(member=>member.kind==="story"&&member.status==="COMPLETED").length,
   wallSeconds:starts.length&&ends.length&&ends.length===members.length?Math.round((Math.max(...ends)-Math.min(...starts))/1000):null,
   unsuccessfulExecutions:members.reduce((total,member)=>total+member.outcomes.unsuccessful,0),
   unsuccessfulSeconds:members.some(member=>member.outcomes.unsuccessfulSeconds!==null)?members.reduce((total,member)=>total+(member.outcomes.unsuccessfulSeconds??0),0):null,
   invalidResults:members.reduce((total,member)=>total+member.outcomes.invalidResults,0),
   longestTimeoutStreak:members.map(member=>member.outcomes.longestTimeoutStreak).reduce((best,streak)=>streak.runs>best.runs?streak:best,{stage:null,runs:0})},
  testing,turnsByRole:turns,epicVerification,
  findings:{byRole:findingsByRole,reviewerOnStoryCriteria,noChangePasses},
  interventions:{commands:humanCommands,byKind:commandsByKind},
 };
}

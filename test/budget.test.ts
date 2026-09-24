import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/storage.js";
import { config } from "../src/config.js";
import { WorkflowIntake } from "../src/workflow-inbox.js";
import { WorkflowRunner } from "../src/workflow-runner.js";
import { WorkflowProjections } from "../src/workflow-projection.js";
import { WorkflowCommands } from "../src/workflow-commands.js";
import { WorkflowRecords } from "../src/workflow-records.js";
import { announceBudgetWarnings, budgetState, holdForBudget, liveBudget } from "../src/budget.js";
import {billableTokenUnits} from "../src/token-usage.js";

test("a running agent gets a 25% grace after the issue budget alert",()=>{
 assert.deepEqual(liveBudget(500000,0,null),{consumed:null,percent:null,alert:false,stop:false});
 assert.equal(liveBudget(500000,0,499999).alert,false);
 assert.deepEqual(liveBudget(500000,0,500000),{consumed:500000,percent:100,alert:true,stop:false});
 assert.equal(liveBudget(500000,100000,524999).stop,false);
 assert.equal(liveBudget(500000,100000,525000).stop,true);
});
test("the issue limit weights provider-reported cache reads instead of charging them as new input",()=>{
 const usage={inputTokens:24,outputTokens:98,cacheReadTokens:587566,cacheWriteTokens:82797,totalTokens:670485};
 const weighted=billableTokenUnits(usage,"claude")!;
 assert.equal(weighted,224865);
 const {store,id}=setup();
 try{
  const execution=run(store,id,"product-architect",usage.totalTokens);
  store.event("execution.started",{selection:{provider:"claude"}},id,execution);
  store.event("execution.finished",{status:"cancelled",usage},id,execution);
  assert.equal(budgetState(store,id,settings(500000)).consumed,weighted);
  assert.equal(budgetState(store,id,settings(500000)).block,null);
 }finally{store.db.close();}
});
test("budget weights provider cache usage and leaves incomplete Cursor reports unmeasured",()=>{
 const usage={inputTokens:10,outputTokens:2,cacheReadTokens:100,cacheWriteTokens:20,totalTokens:132};
 assert.equal(billableTokenUnits(usage,"claude"),70);
 assert.equal(billableTokenUnits(usage,"codex"),50);
 assert.equal(billableTokenUnits(usage,"cursor","composer-2.5"),100);
 assert.equal(billableTokenUnits({inputTokens:10,outputTokens:2,totalTokens:12},"cursor"),null);
});
test("Cursor execution budget uses the reported model and cache breakdown",()=>{
 const {store,id}=setup();try{
  const usage={inputTokens:54057,outputTokens:5486,cacheReadTokens:605442,cacheWriteTokens:0,totalTokens:664985};
  const execution=run(store,id,"designer",usage.totalTokens);
  store.event("execution.started",{selection:{provider:"cursor",model:"composer-2.5"}},id,execution);
  store.event("execution.finished",{status:"succeeded",usage},id,execution);
  assert.equal(budgetState(store,id,settings(2_000_000)).consumed,323664);
 }finally{store.db.close();}
});
import { adoptIssueState, issueStateIndex } from "../src/workflow-state.js";
import { parseFactoryCommand } from "../src/factory-command.js";
import { applyMessageControl, messageActions } from "../src/workflow-chat.js";
import { workflowStatusMarkdown } from "../src/workflow-status.js";
import { result } from "./fixtures.js";
import type { AgentAdapter } from "../src/adapters/agent.js";
import type { WorkspacePort } from "../src/worktrees.js";

const issue={id:300,nodeId:"I_300",number:3,title:"Budgeted",body:"Build it",url:"https://github.com/owner/demo/issues/3",state:"OPEN" as const,createdAt:"2026-09-22T00:00:00Z",updatedAt:"2026-09-22T00:00:00Z",author:{login:"owner",type:"User"}};
const settings=(limit:number,unmetered:Array<"product-architect"|"developer"|"qa"|"reviewer">=[])=>({issueBudgetTokens:limit,budgetUnmeteredRoles:unmetered});

function setup() {
 const store=new Store(":memory:");store.setMetadata("repository_identity",{id:1,nodeId:"R_1",fullName:"owner/demo"});
 const id=new WorkflowIntake(store).start(issue,{actor:"owner",source:"control"}).id;
 return {store,id};
}
function run(store:Store,workItemId:string,role:string,tokens:number|null,options:{status?:string;partial?:boolean;id?:string}={}) {
 const id=options.id??randomUUID();
 store.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at,finished_at,total_tokens) VALUES(?,?,?,?,?,?,?,?)").run(id,workItemId,role,"BUILD",options.status??"succeeded",new Date().toISOString(),new Date().toISOString(),tokens);
 if(options.partial)store.event("execution.finished",{status:options.status??"timed_out",usage:{totalTokens:tokens,partial:true}},workItemId,id);
 return id;
}
function withBudget<T>(limit:number,unmetered:typeof config.budgetUnmeteredRoles,body:()=>T|Promise<T>) {
 const previous={limit:config.issueBudgetTokens,unmetered:config.budgetUnmeteredRoles};config.issueBudgetTokens=limit;config.budgetUnmeteredRoles=unmetered;
 const restore=()=>{config.issueBudgetTokens=previous.limit;config.budgetUnmeteredRoles=previous.unmetered;};
 try{const value=body();if(value instanceof Promise)return value.finally(restore);restore();return value;}catch(error){restore();throw error;}
}
const unused={} as WorkspacePort;
const neverCalled:AgentAdapter={async run(){throw new Error("A held item must not start an agent");}};
const command=(store:Store,id:string,text:string,commentId:number)=>new WorkflowCommands(store).apply(parseFactoryCommand(text)!,{workItemId:id,login:"owner",commentId,specVersion:0});

test("the budget counts every reported token and names unmeasured runs instead of counting them as zero",()=>{
 const {store,id}=setup();
 try {
  run(store,id,"developer",300_000);run(store,id,"qa",120_000,{partial:true});const unknown=run(store,id,"qa",null,{status:"timed_out"});run(store,id,"reviewer",null,{status:"running"});
  const state=budgetState(store,id,settings(500_000));
  assert.deepEqual({consumed:state.consumed,granted:state.granted,remaining:state.remaining,percent:state.percent,runs:state.runs,partialRuns:state.partialRuns,unknownRuns:state.unknownRuns,block:state.block},
   {consumed:420_000,granted:500_000,remaining:80_000,percent:84,runs:3,partialRuns:1,unknownRuns:[unknown],block:"unknown"});
  assert.equal(budgetState(store,id,settings(500_000,["qa"])).block,null,"a role listed as unmetered may run without reported usage");
  assert.equal(budgetState(store,id,settings(400_000,["qa"])).block,"exhausted");
 } finally { store.db.close(); }
});

test("a queued item over budget waits for an approver before anything is prepared, once",async()=>withBudget(1000,[],async()=>{
 const {store,id}=setup();
 try {
  run(store,id,"product-architect",1000);
  const runner=new WorkflowRunner(store,{"product-architect":neverCalled},unused,{ensurePR(){throw new Error("unused");}});
  assert.equal(await runner.run(id),true);
  const projection=new WorkflowProjections(store).get(id),request=new WorkflowRecords(store).activeRequest(id);
  assert.deepEqual({stage:projection.stage,status:projection.status},{stage:"DESIGN",status:"WAITING"});
  assert.equal(request?.payload.kind==="request"&&request.payload.type,"budget");
  assert.equal(request?.payload.kind==="request"&&request.payload.budget,"exhausted");
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM executions").get() as {n:number}).n,1,"no execution was started");
  assert.equal(await runner.run(id),false,"a waiting item is not held twice");
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM records WHERE kind='request'").get() as {n:number}).n,1);
  const status=workflowStatusMarkdown(store,id);
  assert.match(status,/1,000 of its 1,000-token budget/);assert.match(status,/\/factory budget \+<tokens>/);assert.match(status,/\| Token budget \| 100% · 1,000 of 1,000 tokens \|/);
  assert.match((store.db.prepare("SELECT body FROM notifications ORDER BY id DESC LIMIT 1").get() as {body:string}).body,/\/factory budget \+<tokens>/);
 } finally { store.db.close(); }
}));

test("an extension must cover what is missing, is recorded with its approver and resumes the held item",()=>withBudget(1000,[],()=>{
 const {store,id}=setup();
 try {
  run(store,id,"product-architect",1500);holdForBudget(store,id,budgetState(store,id));
  assert.throws(()=>command(store,id,"/factory budget +500",11),/extend by more than 500/);
  assert.equal(new WorkflowProjections(store).get(id).status,"WAITING");
  const extended=command(store,id,"/factory budget +2000 Larger than expected",12);
  assert.equal(extended.projection.status,"QUEUED");
  const grant=store.db.prepare("SELECT actor,source_id,payload FROM records WHERE kind='budget'").get() as {actor:string;source_id:string;payload:string};
  assert.deepEqual({actor:grant.actor,source:grant.source_id,payload:JSON.parse(grant.payload)},{actor:"owner",source:"12",payload:{kind:"budget",tokens:2000,reason:"Larger than expected",acknowledges:[]}});
  assert.deepEqual([budgetState(store,id).granted,budgetState(store,id).block],[3000,null]);
 } finally { store.db.close(); }
}));

test("an unmeasured run holds the next run until acknowledged, and +0 acknowledges without extending",async()=>withBudget(500_000,[],async()=>{
 const {store,id}=setup();
 try {
  run(store,id,"product-architect",null,{status:"cancelled"});
  const runner=new WorkflowRunner(store,{"product-architect":neverCalled},unused,{ensurePR(){throw new Error("unused");}});
  await runner.run(id);
  const request=new WorkflowRecords(store).activeRequest(id);assert.equal(request?.payload.kind==="request"&&request.payload.budget,"unknown");
  assert.match(workflowStatusMarkdown(store,id),/finished without reported token usage/);
  assert.equal(command(store,id,"/factory budget +0",13).projection.status,"QUEUED");
  const state=budgetState(store,id);assert.deepEqual([state.extended,state.unknownRuns.length,state.unacknowledgedRuns.length,state.block],[0,1,0,null]);
 } finally { store.db.close(); }
}));

test("neither answer, pause nor retry gets past a budget hold, and retry does not reset consumption",()=>withBudget(1000,[],()=>{
 const {store,id}=setup();
 try {
  run(store,id,"product-architect",1200);holdForBudget(store,id,budgetState(store,id));
  assert.throws(()=>command(store,id,"/factory answer continue",14),/use \/factory budget/);
  assert.equal(command(store,id,"/factory pause",15).projection.status,"PAUSED");
  assert.equal(command(store,id,"/factory retry",16).projection.status,"WAITING","the open budget request still needs an approver");
  assert.equal(budgetState(store,id).consumed,1200);
 } finally { store.db.close(); }
}));

test("the run in progress finishes and keeps its result; the next stage does not start",async()=>withBudget(1000,[],async()=>{
 const {store,id}=setup();
 try {
  const spec:AgentAdapter={async run(request){store.db.prepare("UPDATE executions SET status='succeeded',finished_at='now',total_tokens=1600 WHERE id=?").run(request.executionId);return result("brief");}};
  const runner=new WorkflowRunner(store,{"product-architect":spec},{ensure(){return "/tmp/factory-budget";},assertBranch(){},sync(){return{before:"a",after:"a",merged:[]};},publish(){},head(){return "a";},diff(){return "";},check(){},commit(){},changeSummary(){return{files:[],stat:""};},prepareReviewerContext(){return{path:"",files:[],stat:""};},cleanupReviewerContext(){}} as unknown as WorkspacePort,{ensurePR(){throw new Error("unused");}});
  assert.equal(await runner.run(id),true);
  assert.equal(new WorkflowProjections(store).get(id).status,"WAITING");
  const request=new WorkflowRecords(store).activeRequest(id);assert.equal(request?.payload.kind==="request"&&request.payload.type,"brief-approval","the overrunning result was applied");
  new WorkflowCommands(store).apply({kind:"approve",version:1,guidance:""},{workItemId:id,login:"owner",commentId:20,specVersion:1});
  const next=new WorkflowRunner(store,{"product-architect":neverCalled},unused,{ensurePR(){throw new Error("unused");}});
  assert.equal(await next.run(id),true);
  const held=new WorkflowProjections(store).get(id);assert.deepEqual({stage:held.stage,status:held.status},{stage:"DESIGN",status:"WAITING"});
 } finally { store.db.close(); }
}));

test("a hold during an Architect consultation extends the request chain and returns to it",()=>withBudget(1000,[],()=>{
 const {store,id}=setup();
 try {
  const records=new WorkflowRecords(store);
  const consultation=records.create({workItemId:id,specVersion:0,scope:"spec",payload:{kind:"request",type:"tactical-decision",owner:"architect",originatingStage:"BUILD",allowedReturnStages:["BUILD"],openedAfterCommentId:0},sourceType:"orchestrator",sourceId:"c",actor:"qa"});
  store.db.prepare("UPDATE work_items SET active_request_id=? WHERE id=?").run(consultation.id,id);
  run(store,id,"qa",1000);holdForBudget(store,id,budgetState(store,id));
  assert.equal(records.activeRequest(id)?.parentId,consultation.id);
  assert.equal(command(store,id,"/factory budget +1000",21).projection.status,"QUEUED");
  assert.equal(records.activeRequest(id)?.id,consultation.id);
 } finally { store.db.close(); }
}));

test("a hold while the Designer owns the next step returns to the Designer after the extension",()=>withBudget(1000,[],()=>{
 const {store,id}=setup();
 try {
  const records=new WorkflowRecords(store);
  const prototype=records.create({workItemId:id,specVersion:0,scope:"spec",payload:{kind:"request",type:"prototype",owner:"designer",originatingStage:"DESIGN",allowedReturnStages:["DESIGN"],openedAfterCommentId:0},sourceType:"orchestrator",sourceId:"p",actor:"product-architect"});
  store.db.prepare("UPDATE work_items SET active_request_id=? WHERE id=?").run(prototype.id,id);
  run(store,id,"product-architect",1000);holdForBudget(store,id,budgetState(store,id));
  assert.equal(new WorkflowProjections(store).get(id).status,"WAITING");
  assert.equal(command(store,id,"/factory budget +1000",24).projection.status,"QUEUED");
  assert.equal(records.activeRequest(id)?.id,prototype.id);
 } finally { store.db.close(); }
}));

test("budget warnings are announced once per threshold and re-armed by an extension",()=>withBudget(1000,[],()=>{
 const {store,id}=setup();
 try {
  run(store,id,"developer",650);assert.deepEqual(announceBudgetWarnings(store,id),[60]);assert.deepEqual(announceBudgetWarnings(store,id),[]);
  run(store,id,"qa",200);assert.deepEqual(announceBudgetWarnings(store,id),[80]);
  command(store,id,"/factory budget +500",22);assert.deepEqual(announceBudgetWarnings(store,id),[],"850 of 1,500 is 56%");
  run(store,id,"qa",100);assert.deepEqual(announceBudgetWarnings(store,id),[60],"a new granted amount announces its own thresholds");
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='budget.warning'").get() as {n:number}).n,3);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM notifications WHERE body LIKE '%Token budget at%'").get() as {n:number}).n,3);
 } finally { store.db.close(); }
}));

test("consumption and extensions travel with the published issue state and are never counted twice",()=>withBudget(1000,[],()=>{
 const {store:source,id}=setup(),target=new Store(":memory:");target.setMetadata("repository_identity",{id:1,nodeId:"R_1",fullName:"owner/demo"});
 try {
  run(source,id,"product-architect",400);run(source,id,"developer",null,{status:"timed_out"});command(source,id,"/factory budget +0",23);
  source.db.prepare("UPDATE work_items SET status='PAUSED' WHERE id=?").run(id);
  const before=budgetState(source,id),index=issueStateIndex(source,id);
  assert.equal(index.context.budgetUsage?.length,2);
  adoptIssueState(target,{index,specs:[]},{issue});
  const moved=budgetState(target,id);
  assert.deepEqual([moved.consumed,moved.unknownRuns,moved.block],[before.consumed,before.unknownRuns,null],"the acknowledgement travels with the grant record");
  run(target,id,"developer",300);
  adoptIssueState(source,{index:issueStateIndex(target,id),specs:[]},{issue});
  assert.equal(budgetState(source,id).consumed,700,"runs the source already holds are not added again");
 } finally { source.db.close();target.db.close(); }
}));

test("budget commands parse an explicit signed amount and a reason",()=>{
 assert.deepEqual(parseFactoryCommand("/factory budget +250000 Larger refactor"),{kind:"budget",tokens:250000,reason:"Larger refactor"});
 assert.deepEqual(parseFactoryCommand("/factory budget +0\n\nCancelled on purpose"),{kind:"budget",tokens:0,reason:"Cancelled on purpose"});
 for(const text of ["/factory budget","/factory budget 250000","/factory budget +2.5e5","/factory budget -100"])assert.throws(()=>parseFactoryCommand(text),/token amount/);
});

test("the dashboard offers the extension while the issue waits for it or after a warning, and publishes it as a command",async()=>withBudget(1000,[],async()=>{
 const budgetRequest={payload:{kind:"request",type:"budget",owner:"human"}} as any;
 assert.deepEqual(messageActions({status:"WAITING"},budgetRequest),["budget"]);
 assert.deepEqual(messageActions({status:"RUNNING"},undefined,false,true),["note","interrupt-retry","budget"]);
 assert.deepEqual(messageActions({status:"COMPLETED"},undefined,false,true),[]);
 const {store,id}=setup(),published:string[]=[],previous={repo:config.repo,instance:config.instanceName};config.repo="owner/demo";config.instanceName="mac";
 try {
  run(store,id,"developer",1000);holdForBudget(store,id,budgetState(store,id));
  const github={publishWorkflowComment(_issue:number,_key:string,body:string){published.push(body);return 40;},editComment(){}} as any;
  await assert.rejects(applyMessageControl(store,github,{id:1,target:JSON.stringify({workItemId:id,action:"budget",text:"lots"})},"owner"),/tokens to add/);
  assert.equal(published.length,0,"a malformed extension is never published");
  const applied=await applyMessageControl(store,github,{id:2,target:JSON.stringify({workItemId:id,action:"budget",text:"+5000 Needed for the migration"})},"owner");
  assert.equal(applied.projection.status,"QUEUED");assert.match(published[0],/^\/factory budget \+5000\n\nNeeded for the migration\n\nby @owner from mac/);
  assert.equal((store.db.prepare("SELECT source_type FROM records WHERE kind='budget'").get() as {source_type:string}).source_type,"dashboard");
 } finally { config.repo=previous.repo;config.instanceName=previous.instance;store.db.close(); }
}));

test("an epic and its stories share one budget, and an extension on any of their issues counts for all",()=>withBudget(1000,[],()=>{
 const {store,id:epic}=setup();
 try {
  store.db.prepare("UPDATE specs SET approved_by='owner' WHERE work_item_id=?").run(epic);
  const story=(number:number)=>new WorkflowIntake(store).start({...issue,id:300+number,nodeId:`I_${300+number}`,number,title:`Story ${number}`,url:`https://github.com/owner/demo/issues/${number}`},{actor:"factory",source:"assignment"},{epicWorkItemId:epic,epicBranch:"factory/issue-3",specVersion:1,key:`S${number}`,specification:{body:"Story",criteria:[{id:"AC1",description:"Works"}],assessment:null,approvedBy:"owner",approvalCommentId:1,approvedAt:"now"}}).id;
  store.db.prepare("INSERT INTO specs(work_item_id,version,body,criteria,approved_by) VALUES(?,1,'SPEC','[]','owner')").run(epic);
  const s1=story(4),s2=story(5);
  run(store,epic,"product-architect",300);run(store,s1,"developer",400);run(store,s2,"developer",200);
  for(const member of [epic,s1,s2])assert.deepEqual([budgetState(store,member).consumed,budgetState(store,member).granted],[900,1000],"every member sees the family total");
  run(store,s2,"qa",200);
  assert.equal(budgetState(store,s1).block,"exhausted","a story cannot start once the family spent the epic budget");
  store.db.prepare("UPDATE work_items SET status='WAITING' WHERE id=?").run(s2);
  new WorkflowRecords(store).create({workItemId:s2,specVersion:1,scope:"issue",payload:{kind:"request",type:"budget",owner:"human",originatingStage:"BUILD",allowedReturnStages:["BUILD"],openedAfterCommentId:0,budget:"exhausted"},sourceType:"orchestrator",sourceId:"budget:1",actor:"orchestrator"});
  command(store,s2,"/factory budget +500",30);
  assert.deepEqual([budgetState(store,epic).granted,budgetState(store,s1).block],[1500,null],"the extension granted on a story issue lifts the hold on the family");
 } finally { store.db.close(); }
}));

test("a run a person stopped is acknowledged by that decision, while a run the factory cut short still waits for one",()=>withBudget(500_000,[],()=>{
 const {store,id}=setup();
 try {
  const stopped=(reason:string)=>{const execution=run(store,id,"developer",null,{status:reason==="user-cancel"?"cancelled":"interrupted"});store.db.prepare("UPDATE executions SET interruption_reason=? WHERE id=?").run(reason,execution);return execution;};
  for(const reason of ["interrupted-for-guidance","user-pause","user-cancel"])stopped(reason);
  let state=budgetState(store,id);
  assert.deepEqual([state.unknownRuns.length,state.unacknowledgedRuns.length,state.block],[3,0,null],"unmeasured, but nobody is asked to confirm a stop they made");
  const timeout=stopped("execution-timeout");
  state=budgetState(store,id);
  assert.deepEqual([state.unacknowledgedRuns,state.block],[[timeout],"unknown"],"a timeout nobody decided still needs a person to accept its unknown cost");
 } finally { store.db.close(); }
}));

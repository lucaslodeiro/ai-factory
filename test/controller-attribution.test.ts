import test from "node:test";
import assert from "node:assert/strict";
import {Store} from "../src/storage.js";
import {WorkflowIntake} from "../src/workflow-inbox.js";
import {WorkflowGitHubPublisher,publishTakeoverNotices} from "../src/workflow-github.js";
import {workflowStatusMarkdown} from "../src/workflow-status.js";
import type {LeaseObservation} from "../src/controller-lease.js";

const issue={id:7,nodeId:"I_7",number:1,title:"Demo",body:"Build",url:"https://github.com/owner/demo/issues/1",state:"OPEN" as const,labels:[{name:"factory:build"}],createdAt:"now",updatedAt:"now",author:{login:"owner",type:"User"}};
const instance=(id:string,name:string)=>({schemaVersion:1 as const,instanceId:id,displayName:name,createdAt:"now"});
const observation=(generation:number,id:string,name:string):LeaseObservation=>({state:"active",sha:String(generation).repeat(40).slice(0,40),record:{schemaVersion:1,repositoryId:1,repositoryNodeId:"R_1",instanceId:id,displayName:name,contact:"",generation,engineVersion:"0.2.0",acquiredAt:"2026-09-21T00:00:00Z",heartbeatAt:"2026-09-21T00:00:00Z",activeWorkCount:0},expiresAt:"2026-09-21T00:10:00Z",heartbeatAgeMs:0,instance:instance(id,name)});

test("status and milestone attribution use the controller display name and generation",async()=>{const store=new Store(":memory:"),started=new WorkflowIntake(store).start(issue,{actor:"test",source:"control"}),bodies:string[]=[];try{store.db.prepare("INSERT INTO repository_controller(repository_id,instance_id,generation,state) VALUES(1,?,4,'active')").run("11111111-1111-4111-8111-111111111111");assert.match(workflowStatusMarkdown(store,started.id),/\| Controller \| Factory 111111 \|/);await new WorkflowGitHubPublisher(store,{syncWorkflow(_n,_l,body){bodies.push(body);},publishWorkflowComment(){},assignees(){return[];},assign(){},unassign(){}}).publish(started.id);assert.match(bodies[0],/generation:4/);}finally{store.db.close();}});

test("takeover notice is emitted once per untracked issue and generation",async()=>{const store=new Store(":memory:"),keys=new Set<string>(),comments:string[]=[];const github={listManaged(){return[issue];},publishWorkflowComment(_n:number,key:string,body:string){if(keys.has(key))return;keys.add(key);comments.push(body);}} as any;try{const previous=observation(2,"22222222-2222-4222-8222-222222222222","Factory 222222"),current=observation(3,"33333333-3333-4333-8333-333333333333","Factory 333333");publishTakeoverNotices(store,github,previous,current);publishTakeoverNotices(store,github,previous,current);assert.equal(comments.length,1);assert.match(comments[0],/Factory 222222 to Factory 333333/);assert.match(comments[0],/`\/factory start`/);}finally{store.db.close();}});

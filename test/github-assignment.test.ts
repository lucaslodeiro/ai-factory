import test from "node:test";
import assert from "node:assert/strict";
import {GitHubAdapter} from "../src/adapters/github.js";

test("GitHub discovers only open assigned issues and excludes pull requests",()=>{
 const calls:string[][]=[];
 const adapter=new GitHubAdapter(args=>{
  calls.push(args);
  if(args.at(-1)==="user")return JSON.stringify({login:"factory-bot"});
  return JSON.stringify([[{id:1,node_id:"I_1",number:1,title:"Issue",body:"",html_url:"https://example/1",state:"open",labels:[{name:"bug"}],assignees:[{login:"factory-bot"}],created_at:"now",updated_at:"now",user:{login:"owner",type:"User"}},{id:2,node_id:"I_2",number:2,title:"PR",body:"",html_url:"https://example/2",state:"open",pull_request:{},labels:[],created_at:"now",updated_at:"now",user:{login:"owner",type:"User"}}]]);
 },"owner/demo");
 assert.equal(adapter.authenticatedLogin(),"factory-bot");
 const issues=adapter.assignedIssues("factory-bot");
 assert.deepEqual(issues.map(issue=>issue.number),[1]);
 assert.deepEqual(issues[0].assignees,["factory-bot"]);
 assert.ok(calls.some(args=>args.at(-1)==="repos/owner/demo/issues?assignee=factory-bot&state=open&per_page=100"));
});

test("moving work replaces foreign instance labels in one issue edit",()=>{
 const calls:string[][]=[],adapter=new GitHubAdapter(args=>{calls.push(args);if(args[0]==="api")return JSON.stringify({id:1,node_id:"I_1",number:1,title:"Issue",body:"",html_url:"https://example/1",state:"open",labels:[{name:"factory-instance:other"},{name:"bug"}],created_at:"now",updated_at:"now",user:{login:"owner",type:"User"}});return "";},"owner/demo");
 adapter.replaceInstanceLabel(1,"factory-instance:here");
 const edit=calls.find(args=>args[0]==="issue"&&args[1]==="edit")!;assert.ok(edit.includes("--add-label"));assert.ok(edit.includes("factory-instance:here"));assert.ok(edit.includes("--remove-label"));assert.ok(edit.includes("factory-instance:other"));assert.equal(calls.filter(args=>args[0]==="issue"&&args[1]==="edit").length,1);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { Store } from "../src/storage.js";
import { deliverNotifications, workflowNotificationText, slackPayload } from "../src/notifications.js";
import { SlackAdapter } from "../src/adapters/slack.js";
import { config } from "../src/config.js";
import {WorkflowRecords} from "../src/workflow-records.js";

function fixture(filename=":memory:"){
 const store=new Store(filename);store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',7,'a/b','now','now',?,'DESIGN','WAITING')").run(JSON.stringify({title:"Demo",url:"https://github.com/a/b/issues/7"}));
 new WorkflowRecords(store).create({workItemId:"w",specVersion:2,scope:"spec",payload:{kind:"request",type:"spec-approval",owner:"human",originatingStage:"DESIGN",allowedReturnStages:["BUILD"],openedAfterCommentId:3},sourceType:"agent-result",sourceId:"run",actor:"product-architect"});
 return store;
}

test("Slack delivery persists, backs off and survives restart; no resend after success",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-slack-")),db=path.join(root,"state.db");let store=fixture(db),attempts=0;
 const port={enabled:true,async notify(){attempts++;if(attempts===1)throw new Error("SECRET-WEBHOOK-URL");}};
 try{
  const body=workflowNotificationText(store,"w",{stage:"DESIGN",status:"WAITING",attempt:0},{summary:"SPEC ready"});store.db.prepare("INSERT INTO notifications(body,work_item_id) VALUES(?,?)").run(body,"w");
  await deliverNotifications(store,{...port,enabled:false},0);assert.equal(attempts,0);await deliverNotifications(store,port,0);assert.equal(attempts,1);assert.equal((store.db.prepare("SELECT sent FROM notifications").get() as any).sent,0);assert.doesNotMatch(JSON.stringify(store.db.prepare("SELECT * FROM notifications").all()),/SECRET/);
  store.db.close();store=new Store(db);await deliverNotifications(store,port,999);assert.equal(attempts,1);await deliverNotifications(store,port,1000);await deliverNotifications(store,port,2000);assert.equal(attempts,2);assert.equal((store.db.prepare("SELECT sent FROM notifications").get() as any).sent,1);
 }finally{store.db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("real Slack HTTP adapter sends actionable V3 issue link and reports HTTP failures",async()=>{
 const old=config.slackWebhook;let status=500;const payloads:any[]=[];const server=createServer((req,res)=>{let body="";req.on("data",c=>body+=c);req.on("end",()=>{payloads.push(JSON.parse(body));res.writeHead(status);res.end("ok");});});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const store=fixture();try{config.slackWebhook=`http://127.0.0.1:${(server.address() as any).port}/hook`;const adapter=new SlackAdapter(),text=workflowNotificationText(store,"w",{stage:"DESIGN",status:"WAITING",attempt:0},{summary:"SPEC ready"});await assert.rejects(adapter.notify(text),/HTTP 500/);status=200;await adapter.notify(text);assert.equal(payloads.length,2);assert.match(payloads[1].text,/approve v<version>/);assert.match(payloads[1].text,/https:\/\/github.com\/a\/b\/issues\/7/);assert.equal(payloads[1].blocks[0].type,"header");}finally{store.db.close();config.slackWebhook=old;await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("V3 Slack messages prioritize status, cause and next action",()=>{
 const store=fixture();try{
  const waiting=workflowNotificationText(store,"w",{stage:"DESIGN",status:"WAITING",attempt:0},{summary:"SPEC ready"});assert.match(waiting,/Action required/);assert.match(waiting,/Design · Waiting for you/);assert.match(waiting,/\/factory approve/);
  const failed=workflowNotificationText(store,"w",{stage:"TEST",status:"FAILED",attempt:2},{summary:"Tests failed"});assert.match(failed,/Workflow failed/);assert.match(failed,/\/factory retry/);
  const completed=workflowNotificationText(store,"w",{stage:"DELIVERY",status:"COMPLETED",attempt:2},{summary:"PR merged"});assert.match(completed,/Delivery completed/);assert.match(completed,/No further factory action/);
  const payload=slackPayload(waiting);assert.equal(payload.text,waiting);assert.equal(payload.blocks[0].type,"header");assert.equal(payload.blocks[1].type,"section");
 }finally{store.db.close();}
});

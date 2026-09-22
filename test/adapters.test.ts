import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage.js";
import { ExecutionManager } from "../src/execution-manager.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { CursorAdapter, extractCursorResult } from "../src/adapters/cursor.js";
import { selectModel } from "../src/model-policy.js";
import { result } from "./fixtures.js";
import { config } from "../src/config.js";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-adapters-"));
config.dataDir=root;
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test("real subprocess provider adapters deliver prompt via stdin and parse native output envelopes", async()=>{
 const script=path.join(root,"provider");
 fs.writeFileSync(script,`#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2), input=fs.readFileSync(0,'utf8');
if(!input.startsWith('prompt from orchestrator')) process.exit(8);
const codex=args[0]==='exec', cursor=args.includes('--trust');
const automatic=/prompt from orchestrator auto(\\n|$)/.test(input), modelIndex=args.indexOf('--model');
if(automatic ? modelIndex!==-1 : args[modelIndex+1] !== (codex?'test-codex':cursor?'test-cursor':'test-claude')) process.exit(10);
const claudeDelivery=!codex&&!cursor&&args[args.indexOf('--tools')+1].includes('Edit');
const cursorDelivery=cursor&&args.includes('--force');
const result=codex||claudeDelivery||cursorDelivery?${JSON.stringify(result("pass"))}:${JSON.stringify(result("spec"))};
if(codex) {
 if(!args.includes('--output-schema')||args.includes('--full-auto')) process.exit(9);
 const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
 const check=s=>{if(s.properties){if(s.additionalProperties!==false||JSON.stringify([...(s.required??[])].sort())!==JSON.stringify(Object.keys(s.properties).sort()))throw new Error('invalid_json_schema');Object.values(s.properties).forEach(check);}if(s.items)check(s.items);};check(schema);
 fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));
 console.log(JSON.stringify({type:'progress'}));
 console.error('tokens used\\n1,234');
} else if(cursor) {
 if(args[0]!=='-p'||args[args.indexOf('--output-format')+1]!=='json'||args.includes('--json-schema'))process.exit(9);
 if(!input.includes('OUTPUT CONTRACT')||!input.includes('"additionalProperties":false'))process.exit(11);
 if(cursorDelivery===(args.includes('--mode')&&args[args.indexOf('--mode')+1]==='ask'))process.exit(12);
 const fence=String.fromCharCode(96).repeat(3);
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,duration_ms:5,result:'Done.\\n'+fence+'json\\n'+JSON.stringify(result)+'\\n'+fence}));
} else {
 if(!args.includes('--json-schema')||args.includes('--dangerously-skip-permissions'))process.exit(9);
 console.log(JSON.stringify({is_error:false,structured_output:result,usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:5}}));
}
`,{mode:0o755});
 config.codexCommand=script;config.claudeCommand=script;config.cursorCommand=script;
 const s=new Store(":memory:"), m=new ExecutionManager(s);
 assert.equal((await new ClaudeAdapter(m).run({workItemId:'w',role:'product-architect',cwd:root,instructions:'prompt from orchestrator',selection:{...selectModel('product-architect'),provider:'claude',model:'test-claude'}})).outcome,'spec');
 assert.equal((await new CodexAdapter(m).run({workItemId:'w',role:'developer',cwd:root,instructions:'prompt from orchestrator',selection:{...selectModel('developer'),provider:'codex',model:'test-codex'}})).outcome,'pass');
 assert.equal((await new ClaudeAdapter(m).run({workItemId:'w',role:'developer',cwd:root,instructions:'prompt from orchestrator',selection:{...selectModel('developer'),provider:'claude',model:'test-claude'}})).outcome,'pass');
 assert.equal((await new CodexAdapter(m).run({workItemId:'w',role:'developer',cwd:root,instructions:'prompt from orchestrator auto',selection:{...selectModel('developer'),provider:'codex',model:'auto'}})).outcome,'pass');
 assert.equal((await new ClaudeAdapter(m).run({workItemId:'w',role:'product-architect',cwd:root,instructions:'prompt from orchestrator auto',selection:{...selectModel('product-architect'),provider:'claude',model:'auto'}})).outcome,'spec');
 s.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at) VALUES('precreated','w2','product-architect','DESIGN','running','now')").run();
 assert.equal((await new ClaudeAdapter(m).run({workItemId:'w2',role:'product-architect',cwd:root,instructions:'prompt from orchestrator',selection:{...selectModel('product-architect'),provider:'claude',model:'test-claude'},executionId:'precreated'})).outcome,'spec');
 await assert.rejects(new ClaudeAdapter(m).run({workItemId:'w',role:'product-architect',cwd:root,instructions:'unused',selection:{...selectModel('developer'),provider:'codex'}}), /mismatch/);
 assert.equal((await new CursorAdapter(m).run({workItemId:'w',role:'product-architect',cwd:root,instructions:'prompt from orchestrator',selection:{...selectModel('product-architect'),provider:'cursor',model:'test-cursor'}})).outcome,'spec');
 assert.equal((await new CursorAdapter(m).run({workItemId:'w',role:'developer',cwd:root,instructions:'prompt from orchestrator auto',selection:{...selectModel('developer'),provider:'cursor',model:'auto'}})).outcome,'pass');
 await assert.rejects(new CursorAdapter(m).run({workItemId:'w',role:'developer',cwd:root,instructions:'unused',selection:{...selectModel('developer'),provider:'claude'}}), /mismatch/);
 assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM executions WHERE status=?').get('succeeded') as any).n,8);
 assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM executions WHERE id='precreated'").get() as any).n,1);
 assert.deepEqual(s.db.prepare("SELECT role,stage,total_tokens FROM executions ORDER BY rowid LIMIT 2").all(),[
  {role:"product-architect",stage:"DESIGN",total_tokens:125},{role:"developer",stage:"BUILD",total_tokens:1234},
 ]);
 assert.deepEqual(s.db.prepare("SELECT total_tokens FROM executions WHERE status='succeeded' ORDER BY rowid DESC LIMIT 2").all(),[{total_tokens:null},{total_tokens:null}]);
 assert.equal((s.db.prepare("SELECT payload FROM events WHERE type='execution.started'").all() as Array<{payload:string}>).map(row=>JSON.parse(row.payload).selection.model).includes("auto"),true);
 const finished=(s.db.prepare("SELECT payload FROM events WHERE type='execution.finished'").all() as Array<{payload:string}>).map(row=>JSON.parse(row.payload));
 assert.equal(finished.length,8);
 assert.ok(finished.every(event=>event.activity && event.activity.events>=1),"every provider run records what it did inside the run");
 assert.deepEqual(finished[1].activity.eventTypes,{progress:1},"Codex stream events are counted by their own type");
 assert.ok(finished.every(event=>event.usage===null||event.usage.cacheReadTokens!==undefined),"cache reads are recorded apart from writes");
 s.db.close();
});

test('Claude requires the configured structured output instead of accepting an old result envelope',async()=>{
 const execution={async run(){return {stdout:JSON.stringify({is_error:false,result:JSON.stringify(result('spec'))})};}};
 await assert.rejects(new ClaudeAdapter(execution as any).run({workItemId:'w',role:'product-architect',cwd:root,instructions:'test',selection:{...selectModel('product-architect'),provider:'claude',model:'auto'}}),/missing structured_output/);
});

test("Codex sandbox follows each role's write contract",async()=>{
 for(const role of ["product-architect","reviewer","developer","qa"] as const){
  let args:string[]=[];const execution={async run(_id:string,_role:string,_command:string,argv:string[]){args=argv;fs.writeFileSync(argv[argv.indexOf("--output-last-message")+1],JSON.stringify(result(role==="product-architect"?"spec":"pass")));}};
  await new CodexAdapter(execution as any).run({workItemId:"w",role,cwd:root,instructions:"test",selection:{...selectModel(role),provider:"codex"}});
  const writable=["developer","qa"].includes(role);assert.equal(args[args.indexOf("--sandbox")+1],writable?"workspace-write":"read-only");assert.equal(args.includes("sandbox_workspace_write.network_access=true"),writable);
 }
});

test("Cursor final message is extracted from fences or prose and validated as the role result",()=>{
 assert.deepEqual(extractCursorResult('```json\n{"a":1}\n```'),{a:1});
 assert.deepEqual(extractCursorResult('Here is the result:\n{"a":{"b":[1,2]}} thanks'),{a:{b:[1,2]}});
 assert.throws(()=>extractCursorResult('no object here'),/does not contain a JSON object/);
 assert.throws(()=>extractCursorResult('{"a":}'),/not valid JSON/);
});

test("Cursor rejects error envelopes, missing final messages and results that break the role contract",async()=>{
 const reply=(stdout:string)=>({async run(){return {stdout};}});
 const request={workItemId:'w',role:'product-architect' as const,cwd:root,instructions:'test',selection:{...selectModel('product-architect'),provider:'cursor' as const,model:'auto'}};
 await assert.rejects(new CursorAdapter(reply(JSON.stringify({type:'result',is_error:true,result:'boom'})) as any).run(request),/error result/);
 await assert.rejects(new CursorAdapter(reply(JSON.stringify({type:'result',is_error:false})) as any).run(request),/missing the final message/);
 await assert.rejects(new CursorAdapter(reply('not json at all') as any).run(request),/JSON result envelope/);
 await assert.rejects(new CursorAdapter(reply(JSON.stringify({is_error:false,result:JSON.stringify({...result('spec'),outcome:'pass'})})) as any).run(request),/outcome/);
 assert.equal((await new CursorAdapter(reply('{"type":"progress"}\n'+JSON.stringify({is_error:false,result:JSON.stringify(result('spec'))})) as any).run(request)).outcome,'spec');
});

test("Cursor access flags follow each role's write contract",async()=>{
 for(const role of ["product-architect","reviewer","developer","qa"] as const){
  let args:string[]=[];const execution={async run(_id:string,_role:string,_command:string,argv:string[]){args=argv;return {stdout:JSON.stringify({is_error:false,result:JSON.stringify(result(role==="product-architect"?"spec":"pass"))})};}};
  await new CursorAdapter(execution as any).run({workItemId:"w",role,cwd:root,instructions:"test",selection:{...selectModel(role),provider:"cursor"}});
  const writable=["developer","qa"].includes(role);assert.equal(args.includes("--force"),writable);assert.equal(args[args.indexOf("--mode")+1]==="ask",!writable);
 }
});

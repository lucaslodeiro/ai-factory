import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage.js";
import { ExecutionManager,providerFailureMessage } from "../src/execution-manager.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { CursorAdapter, extractCursorResult } from "../src/adapters/cursor.js";
import { selectModel } from "../src/model-policy.js";
import { result } from "./fixtures.js";
import { config } from "../src/config.js";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-adapters-"));
config.dataDir=root;
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test("provider error envelopes preserve a bounded, sanitized cause",()=>{
 assert.match(providerFailureMessage({type:"result",is_error:true,result:"You've hit your session limit · resets 7:20pm (America/Buenos_Aires)"},"claude")??"",/session limit.*resets 7:20pm/);
 assert.match(providerFailureMessage({type:"result",is_error:true,errors:["Failed to provide valid structured output after 5 attempts"]},"claude")??"",/structured output after 5 attempts/);
 assert.match(providerFailureMessage({type:"result",is_error:true,result:"token=hidden-value failed"},"cursor")??"",/token=\[REDACTED\]/);
 assert.equal(providerFailureMessage({type:"result",is_error:false,result:"secret"},"claude"),undefined);
 assert.match(providerFailureMessage({type:"turn.failed",error:{message:"rate limit exceeded"}},"codex")??"",/rate limit exceeded/);
});
test("an error result fails the execution even when the provider exits zero",async()=>{
 const script=path.join(root,"error-result-provider");
 fs.writeFileSync(script,`#!${process.execPath}\nconsole.log(JSON.stringify({type:'result',is_error:true,result:"You've hit your session limit · resets 7:20pm"}));\n`,{mode:0o755});
 const store=new Store(":memory:");try{
  await assert.rejects(new ExecutionManager(store).run("w","developer",script,[],root,"",30_000,{provider:"claude",model:"auto"} as any),/session limit.*resets 7:20pm/);
  assert.deepEqual(store.db.prepare("SELECT status,exit_code FROM executions").get(),{status:"failed",exit_code:0});
 }finally{store.db.close();}
});
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
 if(!args.includes('--output-schema')||!args.includes('--json')||args.includes('--full-auto')) process.exit(9);
 const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
 const check=s=>{if(s.properties){if(s.additionalProperties!==false||JSON.stringify([...(s.required??[])].sort())!==JSON.stringify(Object.keys(s.properties).sort()))throw new Error('invalid_json_schema');Object.values(s.properties).forEach(check);}if(s.items)check(s.items);};check(schema);
 fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));
 console.log(JSON.stringify({type:'thread.started',thread_id:'codex-thread'}));
 console.log(JSON.stringify({type:'turn.started'}));
 console.log(JSON.stringify({type:'item.completed',item:{id:'item_1',type:'command_execution',command:'npm test',aggregated_output:'ok',exit_code:0,status:'completed'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1100,cached_input_tokens:300,cache_write_input_tokens:0,output_tokens:134,reasoning_output_tokens:20}}));
} else if(cursor) {
 if(args[0]!=='-p'||args[args.indexOf('--output-format')+1]!=='stream-json'||args.includes('--json-schema'))process.exit(9);
 if(!input.includes('OUTPUT CONTRACT')||!input.includes('"additionalProperties":false'))process.exit(11);
 if(cursorDelivery===(args.includes('--mode')&&args[args.indexOf('--mode')+1]==='ask'))process.exit(12);
 const fence=String.fromCharCode(96).repeat(3);
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,duration_ms:5,result:'Done.\\n'+fence+'json\\n'+JSON.stringify(result)+'\\n'+fence}));
} else {
 if(!args.includes('--json-schema')||args[args.indexOf('--output-format')+1]!=='stream-json'||!args.includes('--verbose')||args.includes('--dangerously-skip-permissions'))process.exit(9);
 if(process.env.MAX_STRUCTURED_OUTPUT_RETRIES!=='2')process.exit(13);
 // The real stream: the result envelope is not the last line, a task summary follows it.
 console.log(JSON.stringify({type:'system',subtype:'init',session_id:'claude-session'}));
 console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'t1',name:'Read',input:{file_path:'a.txt'}}]}}));
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,num_turns:2,structured_output:result,usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:5}}));
 console.log(JSON.stringify({type:'system',subtype:'task_summary',detail:null}));
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
 assert.deepEqual(finished[1].activity.eventTypes,{"thread.started":1,"turn.started":1,"item.completed":1,"turn.completed":1},"Codex stream events are counted by their own type");
 assert.deepEqual([finished[0].sessionId,finished[1].sessionId],["claude-session","codex-thread"],"each run records the provider session a later run could continue");
 assert.deepEqual(finished[0].activity.eventTypes,{system:2,assistant:1,result:1},"Claude stream events are counted by their own type");
 assert.equal(finished[0].activity.turns,2);
 assert.deepEqual(finished[1].usage,{inputTokens:800,outputTokens:134,cachedTokens:300,cacheReadTokens:300,cacheWriteTokens:0,totalTokens:1234},"Codex usage comes from its turn events, cached input counted once");
 assert.ok(finished.every(event=>event.usage===null||event.usage.cacheReadTokens!==undefined),"cache reads are recorded apart from writes");
 s.db.close();
});

test('Claude requires the configured structured output instead of accepting an old result envelope',async()=>{
 const execution={async run(){return {finalEvent:{type:'result',is_error:false,result:JSON.stringify(result('spec'))}};}};
 await assert.rejects(new ClaudeAdapter(execution as any).run({workItemId:'w',role:'product-architect',cwd:root,instructions:'test',selection:{...selectModel('product-architect'),provider:'claude',model:'auto'}}),/missing structured_output/);
 await assert.rejects(new ClaudeAdapter({async run(){return {};}} as any).run({workItemId:'w',role:'product-architect',cwd:root,instructions:'test',selection:{...selectModel('product-architect'),provider:'claude',model:'auto'}}),/did not return a result event/);
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
 const reply=(event:Record<string,unknown>|undefined)=>({async run(){return {finalEvent:event};}});
 const request={workItemId:'w',role:'product-architect' as const,cwd:root,instructions:'test',selection:{...selectModel('product-architect'),provider:'cursor' as const,model:'auto'}};
 await assert.rejects(new CursorAdapter(reply({type:'result',is_error:true,result:'boom'}) as any).run(request),/error result/);
 await assert.rejects(new CursorAdapter(reply({type:'result',is_error:false}) as any).run(request),/missing the final message/);
 await assert.rejects(new CursorAdapter(reply(undefined) as any).run(request),/did not return a result event/);
 await assert.rejects(new CursorAdapter(reply({is_error:false,result:JSON.stringify({...result('spec'),outcome:'pass'})}) as any).run(request),/outcome/);
 assert.equal((await new CursorAdapter(reply({type:'result',is_error:false,result:JSON.stringify(result('spec'))}) as any).run(request)).outcome,'spec');
});

test("Cursor access flags follow each role's write contract",async()=>{
 for(const role of ["product-architect","reviewer","developer","qa"] as const){
  let args:string[]=[];const execution={async run(_id:string,_role:string,_command:string,argv:string[]){args=argv;return {finalEvent:{type:"result",is_error:false,result:JSON.stringify(result(role==="product-architect"?"spec":"pass"))}};}};
  await new CursorAdapter(execution as any).run({workItemId:"w",role,cwd:root,instructions:"test",selection:{...selectModel(role),provider:"cursor"}});
  const writable=["developer","qa"].includes(role);assert.equal(args.includes("--force"),writable);assert.equal(args[args.indexOf("--mode")+1]==="ask",!writable);
 }
});

test("Claude, Codex and Cursor keep a brief's session only when asked, and a resumed run continues that session",async()=>{
 const claudeArgs=async(session?:{persist?:boolean;resume?:string})=>{let args:string[]=[];await new ClaudeAdapter({async run(_id:string,_role:string,_command:string,argv:string[]){args=argv;return {finalEvent:{type:"result",is_error:false,structured_output:result("brief")}};}} as any).run({workItemId:"w",role:"product-architect",cwd:root,instructions:"test",selection:{...selectModel("product-architect"),provider:"claude",model:"auto"},session});return args;};
 assert.ok((await claudeArgs()).includes("--no-session-persistence"),"a run nobody continues leaves no session behind");
 const persisted=await claudeArgs({persist:true});assert.ok(!persisted.includes("--no-session-persistence"));assert.ok(!persisted.includes("--resume"));
 const resumedClaude=await claudeArgs({resume:"session-1"});assert.equal(resumedClaude[resumedClaude.indexOf("--resume")+1],"session-1");assert.ok(resumedClaude.includes("--json-schema"));
 const codexArgs=async(session?:{persist?:boolean;resume?:string})=>{let args:string[]=[];await new CodexAdapter({async run(_id:string,_role:string,_command:string,argv:string[]){args=argv;fs.writeFileSync(argv[argv.indexOf("--output-last-message")+1],JSON.stringify(result("spec")));}} as any).run({workItemId:"w",role:"product-architect",cwd:root,instructions:"test",selection:{...selectModel("product-architect"),provider:"codex"},session});return args;};
 assert.ok((await codexArgs()).includes("--ephemeral"));
 const kept=await codexArgs({persist:true});assert.ok(!kept.includes("--ephemeral"));assert.equal(kept[kept.indexOf("--sandbox")+1],"read-only");
 const resumedCodex=await codexArgs({resume:"thread-1"});
 assert.deepEqual(resumedCodex.slice(-3),["resume","thread-1","-"]);
 assert.ok(resumedCodex.indexOf("--sandbox")<resumedCodex.indexOf("resume"),"--sandbox is not global, so it precedes the resume subcommand");assert.equal(resumedCodex[resumedCodex.indexOf("--sandbox")+1],"read-only");assert.ok(!resumedCodex.includes("--ephemeral"));
 assert.ok(resumedCodex.includes("--output-schema")&&resumedCodex.includes("--json"));
 const cursorArgs=async(session?:{persist?:boolean;resume?:string})=>{let args:string[]=[];await new CursorAdapter({async run(_id:string,_role:string,_command:string,argv:string[]){args=argv;return {finalEvent:{type:"result",is_error:false,result:JSON.stringify(result("brief"))}};}} as any).run({workItemId:"w",role:"product-architect",cwd:root,instructions:"test",selection:{...selectModel("product-architect"),provider:"cursor",model:"auto"},session});return args;};
 assert.ok(!(await cursorArgs({persist:true})).includes("--resume"));
 const resumedCursor=await cursorArgs({resume:"chat-1"});assert.equal(resumedCursor[resumedCursor.indexOf("--resume")+1],"chat-1");assert.equal(resumedCursor[resumedCursor.indexOf("--mode")+1],"ask","the Architect stays read-only when resumed");
});

test("a resumed Codex run is measured from where its thread left off, not from the thread's running total",async()=>{
 // Real reports from the correction check: the resumed turn.completed repeats the first run's usage.
 const script=path.join(root,"codex-thread");
 fs.writeFileSync(script,`#!${process.execPath}
const resumed=process.argv.includes('resume');
console.log(JSON.stringify({type:'thread.started',thread_id:'thread-1'}));
if(process.argv.includes('killed'))process.exit(0);
console.log(JSON.stringify({type:'turn.completed',usage:resumed?{input_tokens:169773,cached_input_tokens:145792,output_tokens:452}:{input_tokens:147031,cached_input_tokens:124672,output_tokens:328}}));
`,{mode:0o755});
 const store=new Store(":memory:"),manager=new ExecutionManager(store),selection={provider:"codex",model:"auto"} as any;
 try{
  await manager.run("w","developer",script,["exec","-"],root,"",30_000,selection);
  // A run cut short before its turn completed reports nothing, and must not reset the base.
  await manager.run("w","developer",script,["exec","resume","thread-1","killed"],root,"",30_000,selection,{},undefined,undefined,"thread-1");
  await manager.run("w","developer",script,["exec","resume","thread-1","-"],root,"",30_000,selection,{},undefined,undefined,"thread-1");
  const finished=(store.db.prepare("SELECT payload FROM events WHERE type='execution.finished' ORDER BY id").all() as Array<{payload:string}>).map(row=>JSON.parse(row.payload));
  assert.equal(finished[0].usage.totalTokens,147359);
  assert.equal(finished[1].usage,null);
  assert.deepEqual(finished[2].usage,{inputTokens:1622,outputTokens:124,cachedTokens:21120,cacheReadTokens:21120,cacheWriteTokens:0,totalTokens:22866});
  assert.equal(finished[2].sessionUsage.totalTokens,170225,"what the provider reported is kept beside it");
  assert.deepEqual((store.db.prepare("SELECT total_tokens FROM executions ORDER BY rowid").all() as Array<{total_tokens:number|null}>).map(row=>row.total_tokens),[147359,null,22866]);
 }finally{store.db.close();}
});

test("a provider that goes silent with no tool running is stopped as stalled, and a long command is left alone",async()=>{
 const {providerStall,providerStalled}=await import("../src/execution-manager.js");
 const t0=Date.parse("2026-09-24T15:08:52Z"),minute=60_000;
 assert.equal(providerStalled({tool:null,lastEventAt:"2026-09-24T15:08:52Z"},t0,t0+4*minute),false,"a long answer written without streaming is not silence yet");
 assert.equal(providerStalled({tool:null,lastEventAt:"2026-09-24T15:08:52Z"},t0,t0+5*minute),true,"silent after its last thought, as Cursor was on factory-demo#20");
 assert.equal(providerStalled({tool:"shellToolCall",lastEventAt:"2026-09-24T15:08:52Z"},t0,t0+30*minute),false,"a command still running is not silence");
 const script=path.join(root,"silent-provider");
 fs.writeFileSync(script,`#!${process.execPath}\nconsole.log(JSON.stringify({type:'system',subtype:'init',session_id:'silent-session'}));\nsetTimeout(()=>{},60_000);\n`,{mode:0o755});
 const saved=providerStall.ms;providerStall.ms=1500;
 const store=new Store(":memory:");
 try{
  await assert.rejects(new ExecutionManager(store).run("w","designer",script,[],root,"",30_000,{provider:"cursor",model:"auto"} as any),/interrupted/);
  assert.deepEqual(store.db.prepare("SELECT status,interruption_reason FROM executions").get(),{status:"interrupted",interruption_reason:"provider-stalled"});
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='execution.provider_stalled'").get() as {n:number}).n,1);
  assert.equal(JSON.parse((store.db.prepare("SELECT payload FROM events WHERE type='execution.finished'").get() as {payload:string}).payload).sessionId,"silent-session","the session is kept for the retry to continue");
 }finally{providerStall.ms=saved;store.db.close();}
});

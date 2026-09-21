import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage.js";
import { ExecutionManager } from "../src/execution-manager.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
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
const codex=args[0]==='exec';
const automatic=input.endsWith(' auto'), modelIndex=args.indexOf('--model');
if(automatic ? modelIndex!==-1 : args[modelIndex+1] !== (codex?'test-codex':'test-claude')) process.exit(10);
const claudeDelivery=!codex&&args[args.indexOf('--tools')+1].includes('Edit');
const result=codex||claudeDelivery?${JSON.stringify(result("pass"))}:${JSON.stringify(result("spec"))};
if(codex) {
 if(!args.includes('--output-schema')||args.includes('--full-auto')) process.exit(9);
 const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
 const check=s=>{if(s.properties){if(s.additionalProperties!==false||JSON.stringify([...(s.required??[])].sort())!==JSON.stringify(Object.keys(s.properties).sort()))throw new Error('invalid_json_schema');Object.values(s.properties).forEach(check);}if(s.items)check(s.items);};check(schema);
 fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));
 console.log(JSON.stringify({type:'progress'}));
 console.error('tokens used\\n1,234');
} else {
 if(!args.includes('--json-schema')||args.includes('--dangerously-skip-permissions'))process.exit(9);
 console.log(JSON.stringify({is_error:false,structured_output:result,usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:5}}));
}
`,{mode:0o755});
 config.codexCommand=script;config.claudeCommand=script;
 const s=new Store(":memory:"), m=new ExecutionManager(s);
 assert.equal((await new ClaudeAdapter(m).run({workItemId:'w',role:'product-architect',cwd:root,instructions:'prompt from orchestrator',selection:{...selectModel('product-architect'),provider:'claude',model:'test-claude'}})).outcome,'spec');
 assert.equal((await new CodexAdapter(m).run({workItemId:'w',role:'developer',cwd:root,instructions:'prompt from orchestrator',selection:{...selectModel('developer'),provider:'codex',model:'test-codex'}})).outcome,'pass');
 assert.equal((await new ClaudeAdapter(m).run({workItemId:'w',role:'developer',cwd:root,instructions:'prompt from orchestrator',selection:{...selectModel('developer'),provider:'claude',model:'test-claude'}})).outcome,'pass');
 assert.equal((await new CodexAdapter(m).run({workItemId:'w',role:'developer',cwd:root,instructions:'prompt from orchestrator auto',selection:{...selectModel('developer'),provider:'codex',model:'auto'}})).outcome,'pass');
 assert.equal((await new ClaudeAdapter(m).run({workItemId:'w',role:'product-architect',cwd:root,instructions:'prompt from orchestrator auto',selection:{...selectModel('product-architect'),provider:'claude',model:'auto'}})).outcome,'spec');
 s.db.prepare("INSERT INTO executions(id,work_item_id,role,stage,status,started_at) VALUES('precreated','w2','product-architect','DESIGN','running','now')").run();
 assert.equal((await new ClaudeAdapter(m).run({workItemId:'w2',role:'product-architect',cwd:root,instructions:'prompt from orchestrator',selection:{...selectModel('product-architect'),provider:'claude',model:'test-claude'},executionId:'precreated'})).outcome,'spec');
 await assert.rejects(new ClaudeAdapter(m).run({workItemId:'w',role:'product-architect',cwd:root,instructions:'unused',selection:{...selectModel('developer'),provider:'codex'}}), /mismatch/);
 assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM executions WHERE status=?').get('succeeded') as any).n,6);
 assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM executions WHERE id='precreated'").get() as any).n,1);
 assert.deepEqual(s.db.prepare("SELECT role,stage,total_tokens FROM executions ORDER BY rowid LIMIT 2").all(),[
  {role:"product-architect",stage:"DESIGN",total_tokens:125},{role:"developer",stage:"BUILD",total_tokens:1234},
 ]);
 assert.equal((s.db.prepare("SELECT payload FROM events WHERE type='execution.started'").all() as Array<{payload:string}>).map(row=>JSON.parse(row.payload).selection.model).includes("auto"),true);s.db.close();
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

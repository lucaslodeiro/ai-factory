import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage.js";
import { ExecutionManager } from "../src/execution-manager.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { config } from "../src/config.js";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-adapters-"));
config.dataDir=root;
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test("real subprocess provider adapters deliver prompt via stdin and parse native output envelopes", async()=>{
 const script=path.join(root,"provider");
 fs.writeFileSync(script,`#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2), input=fs.readFileSync(0,'utf8');
if(input!=='prompt from orchestrator') process.exit(8);
const codex=args[0]==='exec';
const result={outcome:codex?'pass':'spec',summary:'executed',spec:codex?'':'# Spec',questions:[],findings:[]};
if(codex) {
 if(!args.includes('--output-schema')||args.includes('--full-auto')) process.exit(9);
 fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));
 console.log(JSON.stringify({type:'progress'}));
} else {
 if(!args.includes('--json-schema')||args.includes('--dangerously-skip-permissions'))process.exit(9);
 console.log(JSON.stringify({is_error:false,structured_output:result}));
}
`,{mode:0o755});
 config.codexCommand=script;config.claudeCommand=script;
 const s=new Store(":memory:"), m=new ExecutionManager(s);
 assert.equal((await new ClaudeAdapter(m).run({workItemId:'w',role:'product-architect',cwd:root,instructions:'prompt from orchestrator'})).outcome,'spec');
 assert.equal((await new CodexAdapter(m).run({workItemId:'w',role:'developer',cwd:root,instructions:'prompt from orchestrator'})).outcome,'pass');
 assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM executions WHERE status=?').get('succeeded') as any).n,2);s.db.close();
});

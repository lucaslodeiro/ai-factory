import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import { promptContract, promptContractParts } from "../src/prompts.js";

test("delivery outcome instructions distinguish fixes, decisions and deferred observations", () => {
 const output=promptContract("developer","codex");
 assert.match(output,/Return changes only with at least one auto-fix finding/);
 assert.match(output,/Return decision for an unresolved choice.*environment-blocked/);
 assert.match(output,/A blocker produces FAILED, not an architectural consultation/);
 assert.match(output,/defer finding is non-blocking and cannot be the sole reason for changes/);
 assert.match(output,/Never return changes merely to report progress/);
 assert.match(output,/If human guidance prevents one validation method, use a permitted equivalent/);
 assert.match(output,/Do not put setup, server lifecycle, process cleanup, diagnostic inspection, or other auxiliary commands in tests/);
 assert.match(output,/optional research or validation limitation belongs in summary/);
});

test("every role receives the concise summary contract",()=>{
 for(const role of ["product-architect","developer","qa","reviewer"] as const)assert.match(promptContract(role,"codex"),/summary is at most three sentences and 600 characters/);
});

test("Reviewer acknowledges already resolved findings in the summary",()=>{
 const output=promptContract("reviewer","codex");
 assert.match(output,/When an open finding is already resolved in the code you inspected, say so in the summary; do not return a finding for it\. Return findings only for problems that still exist\./);
});

test("the orchestrator owns Git synchronization because worktree metadata is protected",()=>{
 const output=promptContract("developer","codex");
 assert.match(output,/orchestrator synchronizes the assigned branch and remote base immediately before this execution/i);
 assert.match(output,/Do not run git fetch, pull, merge, rebase, worktree, commit or push/i);
 assert.match(output,/not an environment blocker/i);
});

test("workers use transient verification servers instead of registering host services",()=>{
 const output=promptContract("developer","codex");
 assert.match(output,/Do not register, bootstrap, restart, or manage a system service from the worktree/i);
 assert.match(output,/launchctl, systemctl, service managers and persistent process managers are host-owned/i);
 assert.match(output,/transient child process.*does not need to survive the worker/i);
});

test("Architect distinguishes a required Design blocker from an optional research limitation",()=>{
 const output=promptContract("product-architect","codex");
 assert.match(output,/initial Architect pairs a real blocker with outcome questions/);
 assert.match(output,/optional research or validation limitations in the summary/);
 assert.match(output,/If outcome is spec, questions must be \[\]/);
 assert.match(output,/Return `outcome: "questions"` only when a decision has no defensible recommendation/);
});

test("Architect proposes a brief the human approves instead of reading the SPEC",()=>{
 const output=promptContract("product-architect","claude");
 assert.match(output,/# BRIEF — <Work Item>/);
 assert.match(output,/## Decisions for you/);
 assert.match(output,/Ask no more than 5 questions and put no more than 5 human decisions in the brief/);
 assert.match(output,/At most 5, most irreversible first/);
 assert.match(output,/brief targeting 4000 characters and a spec targeting 20000 characters/);
 assert.match(output,/A complete proposal remains valid if either target is exceeded/);
 assert.match(output,/the human approves the brief and does not read the spec/);
 assert.match(output,/Never ask what the repository, the issue or an earlier decision already answers/);
 assert.match(output,/Never put a human-level decision only in the SPEC/);
 assert.doesNotMatch(promptContract("developer","claude"),/# BRIEF — <Work Item>/);
});

test("installed limit overrides reach the Architect prompt and result schema",()=>{
 const script=`import {promptContract} from './src/prompts.ts'; import {resultSchemaFor} from './src/results.ts'; const prompt=promptContract('product-architect','claude'); const schema=resultSchemaFor('product-architect'); console.log(JSON.stringify({brief:prompt.includes('brief targeting 3200 characters'),spec:prompt.includes('spec targeting 18000 characters'),decisions:prompt.includes('At most 3, most irreversible first'),stories:prompt.includes('list 1 to 4 stories'),questions:schema.properties.questions.maxItems,items:schema.properties.findings.maxItems}));`;
 const run=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",script],{cwd:process.cwd(),env:{...process.env,FACTORY_BRIEF_TARGET_CHARS:"3200",FACTORY_SPEC_TARGET_CHARS:"18000",FACTORY_MAX_HUMAN_DECISIONS:"3",FACTORY_MAX_STORIES:"4",FACTORY_MAX_QUESTIONS:"2",FACTORY_RESULT_MAX_ITEMS:"8"},encoding:"utf8"});
 assert.equal(run.status,0,run.stderr);
 assert.deepEqual(JSON.parse(run.stdout.trim()),{brief:true,spec:true,decisions:true,stories:true,questions:2,items:8});
});

test("Reviewer rejects product decisions the approved brief does not contain",()=>{
 assert.match(promptContract("reviewer","claude"),/No product decision the human did not approve/);
});

test("architect receives an explicit, machine-aligned tactical return route", () => {
 const output=promptContract("product-architect","claude",{tacticalRoute:{from:"BUILD",allowedNextRoles:["developer"]}});
 assert.doesNotMatch(output,/additional architectural review of an unapproved draft/);
 assert.match(output,/TACTICAL RETURN ROUTE — REQUIRED/);
 assert.match(output,/originated in Build/);
 assert.match(output,/Allowed nextRole value: developer/);
 assert.doesNotMatch(output,/Allowed nextRole values?: qa/);
});

test("the prompt prefix is deterministic per role and provider, and keeps its section order",()=>{
 // Roles deliberately no longer share one byte-identical prefix. Issue #6 showed a single Builder
 // execution moving 4.88M cached tokens against 110 uncached input tokens: the prompt sits at the
 // head of an agentic conversation and is re-read on every turn, so a byte that a role cannot act
 // on is paid hundreds of times per execution, while a prefix shared across roles saves one cache
 // write of about 2000 tokens, once, and only inside the cache TTL.
 const tester=promptContractParts("qa","codex");
 assert.equal(tester.prefix,promptContractParts("qa","codex").prefix);
 assert.notEqual(promptContractParts("product-architect","codex").prefix,tester.prefix);
 assert.notEqual(promptContractParts("product-architect","codex").roleContract,tester.roleContract);
 assert.ok(promptContract("qa","codex").startsWith(tester.prefix));
 assert.ok(tester.prefix.indexOf("AI Factory worker rules")<tester.prefix.indexOf("Codex Worker Instructions"));
 assert.ok(tester.prefix.indexOf("Codex Worker Instructions")<promptContract("qa","codex").indexOf("Verification Engineer (Tester) Contract"));
});

test("the result contract drops the rows and rules a role cannot act on",()=>{
 const builder=promptContract("developer","codex"),architect=promptContract("product-architect","codex");
 for (const field of ["`spec`","`acceptanceCriteria`","`taskAssessment`","`nextRole`"]) assert.ok(!builder.includes(`| ${field}`),`${field} row must not reach a delivery role`);
 assert.ok(architect.includes("| `spec`, `acceptanceCriteria` |")&&architect.includes("| `taskAssessment` |"));
 assert.ok(builder.includes("| `coverage` |")&&builder.includes("| `tests` |")&&builder.includes("| `reviewChecks` |"),"rows the schema still allows stay");
 assert.ok(!builder.includes("complexity/risk low, medium or high")&&architect.includes("complexity/risk low, medium or high"));
 assert.ok(!architect.includes("Delivery reports need coverage")&&builder.includes("Delivery reports need coverage"));
 assert.ok(!builder.includes("must report each review dimension")&&promptContract("reviewer","codex").includes("must report each review dimension"));
 for (const role of ["product-architect","developer","qa","reviewer"] as const) assert.ok(promptContract(role,"codex").includes("Never claim a test passed without executing it."));
});

test("Cursor prompts carry the Cursor worker instructions instead of another provider's file",()=>{
 const output=promptContract("developer","cursor");
 assert.ok(output.includes("Cursor Worker Instructions"));
 assert.ok(!output.includes("Codex Worker Instructions")&&!output.includes("Claude Worker Instructions"));
 assert.ok(output.includes("OUTPUT CONTRACT"));
});

test("only a provider without schema enforcement is told in prose which fields are forbidden",()=>{
 assert.ok(promptContract("developer","cursor").includes("delivery roles cannot return"));
 assert.ok(!promptContract("developer","codex").includes("delivery roles cannot return"));
 assert.ok(!promptContract("developer","claude").includes("delivery roles cannot return"));
 // The rest of that paragraph is guidance the schema cannot express, so it stays for every provider.
 for (const provider of ["codex","claude","cursor"] as const) assert.ok(promptContract("developer",provider).includes("A failed required verification blocks PASS."));
});

test("only the Builder is told how to read the repository map",()=>{
 const builder=promptContract("developer","codex");
 assert.ok(builder.includes("Repository map section")&&builder.includes("never a substitute for reading the files"));
 for (const role of ["product-architect","qa","reviewer"] as const) assert.ok(!promptContract(role,"codex").includes("Repository map section"));
});

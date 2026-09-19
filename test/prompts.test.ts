import test from "node:test";
import assert from "node:assert/strict";
import { prompt, promptParts } from "../src/prompts.js";
import type { AgentRole, WorkItem } from "../src/types.js";

const item: WorkItem = {
 id:"work-1",issue_number:1,repo:"owner/demo",branch:"factory/issue-1",state:"DEVELOPMENT",
 context:{title:"Demo",body:"Build it",url:"https://example.test/issues/1",version:1,cursor:7,cycles:1,
  feedback:["qa: deferred browser suggestion","owner retry guidance: Do not use Chromium for validation."],reports:{},
  spec:"Approved spec",criteria:[{id:"AC-1",description:"Works"}],approvedVersion:1,
  approval:{login:"owner",commentId:3},retryGuidance:{login:"owner",commentId:7,text:"Do not use Chromium for validation."}},
};

test("human retry guidance is a final mandatory instruction for every delivery role", () => {
 for (const role of ["developer","qa","reviewer"] as AgentRole[]) {
  const output=prompt(item,role,"codex");
  assert.match(output,/HUMAN RETRY GUIDANCE — REQUIRED FOR THIS DELIVERY/);
  assert.match(output,/@owner in GitHub comment 7/);
  assert.match(output,/Do not use Chromium for validation\./);
  assert.match(output,/takes precedence over suggestions and deferred findings from earlier agents/);
  assert.ok(output.lastIndexOf("HUMAN RETRY GUIDANCE") > output.lastIndexOf('"feedback"'));
 }
});

test("legacy saved retry guidance is promoted without a data migration", () => {
 const legacy:WorkItem=structuredClone(item); delete legacy.context.retryGuidance;
 assert.match(prompt(legacy,"qa","claude"),/Do not use Chromium for validation\./);
});

test("delivery outcome instructions distinguish fixes, decisions and deferred observations", () => {
 const output=prompt(item,"developer","codex");
 assert.match(output,/Return changes only with at least one auto-fix finding/);
 assert.match(output,/Return decision only with at least one decision-required finding/);
 assert.match(output,/defer finding is non-blocking and cannot be the sole reason for changes/);
 assert.match(output,/Never return changes merely to report progress/);
 assert.match(output,/If human guidance prevents one validation method, use a permitted equivalent/);
 assert.match(output,/Do not put setup, server lifecycle, process cleanup, diagnostic inspection, or other auxiliary commands in tests/);
});

test("architect receives an explicit, machine-aligned tactical return route", () => {
 const consultation=structuredClone(item);
 consultation.state="SPEC";
 consultation.context.consultation={from:"DEVELOPMENT"};
 const output=prompt(consultation,"product-architect","claude");
 assert.match(output,/TACTICAL RETURN ROUTE — REQUIRED/);
 assert.match(output,/originated in Build/);
 assert.match(output,/Allowed nextRole value: developer/);
 assert.match(output,/"allowedNextRoles": \[\s*"developer"\s*\]/);
 assert.doesNotMatch(output,/Allowed nextRole values?: qa/);
});

test("roles on one provider share a byte-identical common prefix",()=>{
 const architect=promptParts(item,"product-architect","codex");
 const tester=promptParts(item,"qa","codex");
 assert.equal(architect.prefix,tester.prefix);
 assert.notEqual(architect.roleContract,tester.roleContract);
 assert.ok(prompt(item,"qa","codex").startsWith(tester.prefix));
 assert.ok(tester.prefix.indexOf("AI Factory worker rules")<tester.prefix.indexOf("Codex Worker Instructions"));
 assert.ok(tester.prefix.indexOf("Codex Worker Instructions")<prompt(item,"qa","codex").indexOf("Verification Engineer (Tester) Contract"));
});

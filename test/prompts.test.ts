import test from "node:test";
import assert from "node:assert/strict";
import { prompt } from "../src/prompts.js";
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

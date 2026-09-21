import test from "node:test";
import assert from "node:assert/strict";
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

test("Architect distinguishes a required Design blocker from an optional research limitation",()=>{
 const output=promptContract("product-architect","codex");
 assert.match(output,/initial Architect pairs a real blocker with outcome questions/);
 assert.match(output,/optional research or validation limitations in the summary/);
});

test("architect receives an explicit, machine-aligned tactical return route", () => {
 const output=promptContract("product-architect","claude",{tacticalRoute:{from:"BUILD",allowedNextRoles:["developer"]}});
 assert.match(output,/TACTICAL RETURN ROUTE — REQUIRED/);
 assert.match(output,/originated in Build/);
 assert.match(output,/Allowed nextRole value: developer/);
 assert.doesNotMatch(output,/Allowed nextRole values?: qa/);
});

test("roles on one provider share a byte-identical common prefix",()=>{
 const architect=promptContractParts("product-architect","codex");
 const tester=promptContractParts("qa","codex");
 assert.equal(architect.prefix,tester.prefix);
 assert.notEqual(architect.roleContract,tester.roleContract);
 assert.ok(promptContract("qa","codex").startsWith(tester.prefix));
 assert.ok(tester.prefix.indexOf("AI Factory worker rules")<tester.prefix.indexOf("Codex Worker Instructions"));
 assert.ok(tester.prefix.indexOf("Codex Worker Instructions")<promptContract("qa","codex").indexOf("Verification Engineer (Tester) Contract"));
});

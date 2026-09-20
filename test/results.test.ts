import test from "node:test";
import assert from "node:assert/strict";
import { InvalidResultError,parseResult, validateCoverage, resultSchemaFor } from "../src/results.js";
import { result } from "./fixtures.js";
test("reports require evidence fields, tests, dependency rationale and review dimensions", () => {
 const missing = result("pass") as any; delete missing.dependencies;
 assert.throws(() => parseResult(missing, "developer"), /dependencies: required/);
 for (const exitCode of [1, null]) assert.throws(() => parseResult(result("pass", { tests: [{ command: "npm test", exitCode, evidence: "failed or not run" }] }), "qa"), /successful executed tests/);
 assert.throws(() => parseResult(result("pass", { tests: [{ command: "kill -TERM 20325", exitCode: 1, evidence: "operation not permitted" }] }), "developer"), /kill -TERM 20325 \(exit 1\)/);
 assert.throws(() => parseResult(result("pass", { tests: [] }), "developer"), /successful executed tests/);
 assert.throws(() => parseResult(result("pass", { dependencies: [{ name: "library", change: "added", rationale: "" }] }), "developer"), /rationale/);
 assert.throws(() => parseResult(result("pass", { reviewChecks: [] }), "reviewer"), /all review dimensions/);
 const review = result("pass"); review.reviewChecks[0].status = "failed";
 assert.throws(() => parseResult(review, "reviewer"), /all review dimensions/);
 assert.throws(() => parseResult(result("changes", { findings:[{classification:"defer",evidence:"Not checked now"}] }), "developer"), /auto-fix finding/);
 assert.throws(() => parseResult(result("changes", { findings:[{classification:"decision-required",evidence:"Human choice needed"}] }), "developer"), /auto-fix finding/);
});
test("spec/coverage IDs are unique and correspond to the immutable approved criteria", () => {
 const spec = result("spec"); spec.acceptanceCriteria.push(spec.acceptanceCriteria[0]);
 assert.throws(() => parseResult(spec, "product-architect"), /Duplicate/);
 assert.throws(() => parseResult(result("spec", { acceptanceCriteria: [{ id: "AC404", description: "Missing from markdown" }] }), "product-architect"), /named acceptance criteria/);
 const report = result("pass"); report.coverage.push(report.coverage[0]);
 assert.throws(() => parseResult(report, "qa"), /Duplicate/);
 assert.throws(() => validateCoverage(result("pass"), []), /lacks structured/);
 assert.throws(() => validateCoverage(result("pass", { coverage: [{ criterionId: "AC1", status: "not-run", evidence: "No execution" }] }), [{ id: "AC1", description: "Return value" }]), /every approved/);
});

test("provider schemas prevent delivery roles from respecifying or selecting their next stage", () => {
 for (const role of ["developer", "qa", "reviewer"] as const) {
  const schema = resultSchemaFor(role).properties!;
  assert.deepEqual(schema.spec.enum, [""]);
  assert.equal(schema.acceptanceCriteria.maxItems, 0);
  assert.equal(schema.taskAssessment.type, "null"); assert.equal(schema.nextRole.type, "null");
  assert.deepEqual(schema.outcome.enum, ["pass", "changes", "decision"]);
 }
 assert.deepEqual(resultSchemaFor("product-architect").properties!.outcome.enum, ["spec", "questions", "resolved"]);
});

test("architect consultation schema and validation enforce the exact tactical return route", () => {
 const schema=resultSchemaFor("product-architect",["developer"]).properties!;
 assert.deepEqual(schema.nextRole.enum,["developer",null]);
 const resolved=result("resolved",{
  nextRole:"reviewer",
  decisions:[{kind:"tactical",decision:"Human confirmed the UI",rationale:"AC-6 is satisfied",conflictsWithHuman:false}],
 });
 assert.throws(
  () => parseResult(resolved,"product-architect",["developer"],"BUILD"),
  /selected nextRole=reviewer after a Build consultation; allowed nextRole value is: developer/,
 );
});

test("delivery reports discard provider attempts to populate architect-owned fields", () => {
 const parsed = parseResult(result("pass", {
  spec:"replacement scope", acceptanceCriteria:[{id:"NEW",description:"Injected criterion"}],
  taskAssessment:{complexity:"high",risk:"high",rationale:"Override"}, nextRole:"reviewer",
 }),"developer");
 assert.equal(parsed.spec,"");
 assert.deepEqual(parsed.acceptanceCriteria,[]);
 assert.equal(parsed.taskAssessment,null);
 assert.equal(parsed.nextRole,null);
});

test("Architect results accept optional tactical supersession ids",()=>{
 const parsed=parseResult(result("resolved",{nextRole:"qa",decisions:[{kind:"tactical",decision:"Use cache v2",rationale:"Replaces the earlier tactic",conflictsWithHuman:false,supersedes:["decision-1"]}]}),"product-architect",["qa"],"TEST");
 assert.deepEqual(parsed.decisions[0].supersedes,["decision-1"]);
});

test("result contract failures use a typed error",()=>{
 assert.throws(()=>parseResult({},"developer"),error=>error instanceof InvalidResultError&&error.failureClass==="invalid-result");
 assert.throws(()=>validateCoverage(result("pass"),[]),error=>error instanceof InvalidResultError);
});

test("every provider result schema requires all object properties recursively",()=>{
 const inspect=(schema:ReturnType<typeof resultSchemaFor>,location="result")=>{
  if(schema.properties){assert.equal(schema.additionalProperties,false,location);assert.deepEqual([...(schema.required??[])].sort(),Object.keys(schema.properties).sort(),location);for(const [key,value] of Object.entries(schema.properties))inspect(value,`${location}.${key}`);}
  if(schema.items)inspect(schema.items,`${location}[]`);
 };
 for(const role of ["product-architect","developer","qa","reviewer"] as const)inspect(resultSchemaFor(role));
 for(const next of ["developer","qa","reviewer"] as const)inspect(resultSchemaFor("product-architect",[next]));
});
test("legacy decisions gain empty supersedes without mutating the saved report",()=>{
 const raw=result("resolved",{nextRole:"qa",decisions:[{kind:"tactical",decision:"Keep the cache",rationale:"Within scope",conflictsWithHuman:false}]});
 const parsed=parseResult(raw,"product-architect",["qa"],"TEST");
 assert.deepEqual(parsed.decisions[0].supersedes,[]);assert.equal(raw.decisions[0].supersedes,undefined);
 assert.throws(()=>parseResult({...raw,decisions:[{...raw.decisions[0],supersedes:null}]},"product-architect",["qa"],"TEST"),/supersedes/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { InvalidResultError,parseResult, validateCoverage, resultSchemaFor, requiredVerificationDepth, normalizePrototypePaths } from "../src/results.js";
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
 assert.throws(() => parseResult(result("changes", { findings:[{classification:"defer",severity:"minor",evidence:"Not checked now"}] }), "developer"), /auto-fix finding/);
 assert.throws(() => parseResult(result("changes", { findings:[{classification:"decision-required",severity:"major",evidence:"Human choice needed"}] }), "developer"), /auto-fix finding/);
});
test("spec/coverage IDs are unique and correspond to the immutable approved criteria", () => {
 const spec = result("spec"); spec.acceptanceCriteria.push(spec.acceptanceCriteria[0]);
 assert.throws(() => parseResult(spec, "product-architect"), /Duplicate/);
 assert.throws(() => parseResult(result("spec", { acceptanceCriteria: [{ id: "AC404", description: "Missing from markdown" }] }), "product-architect"), /named acceptance criteria/);
 const withOpenQuestions=result("spec",{questions:["Which hosting provider should we use?"]});
 assert.throws(() => parseResult(withOpenQuestions,"product-architect"),/questions: \[\].*in the brief with your recommendation/);
 assert.doesNotThrow(() => parseResult({...withOpenQuestions,questions:[]},"product-architect"));
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
  decisions:[{kind:"tactical",decision:"Human confirmed the UI",rationale:"AC-6 is satisfied",conflictsWithHuman:false,supersedes:[]}],
 });
 assert.throws(
  () => parseResult(resolved,"product-architect",["developer"],"BUILD"),
  /selected nextRole=reviewer after a Build consultation; allowed nextRole value is: developer/,
 );
});

test("delivery reports discard provider attempts to populate architect-owned fields", () => {
 const parsed = parseResult(result("pass", {
  spec:"replacement scope", acceptanceCriteria:[{id:"NEW",description:"Injected criterion"}],
  taskAssessment:{complexity:"high",risk:"high",verificationDepth:"thorough",uxImpact:"none",rationale:"Override"}, nextRole:"reviewer",
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

test("a complete result is not rejected for narrative length",()=>{
 const long="x".repeat(81000);
 assert.equal(parseResult(result("pass",{summary:long}),"developer").summary.length,long.length);
 assert.equal(parseResult(result("changes",{findings:[{classification:"auto-fix",severity:"major",evidence:long}]}),"qa").findings[0].evidence.length,long.length);
 assert.equal(resultSchemaFor("product-architect").properties?.summary?.maxLength,undefined);
});

test("every provider result schema requires all object properties recursively",()=>{
 const inspect=(schema:ReturnType<typeof resultSchemaFor>,location="result")=>{
  if(schema.properties){assert.equal(schema.additionalProperties,false,location);assert.deepEqual([...(schema.required??[])].sort(),Object.keys(schema.properties).sort(),location);for(const [key,value] of Object.entries(schema.properties))inspect(value,`${location}.${key}`);}
  if(schema.items)inspect(schema.items,`${location}[]`);
 };
 for(const role of ["product-architect","developer","qa","reviewer"] as const)inspect(resultSchemaFor(role));
 for(const next of ["developer","qa","reviewer"] as const)inspect(resultSchemaFor("product-architect",[next]));
});
test("decisions must include supersedes in the current result format",()=>{
 const raw=result("resolved",{nextRole:"qa",decisions:[{kind:"tactical",decision:"Keep the cache",rationale:"Within scope",conflictsWithHuman:false,supersedes:[]}]});
 delete (raw.decisions[0] as Partial<typeof raw.decisions[0]>).supersedes;
 assert.throws(()=>parseResult(raw,"product-architect",["qa"],"TEST"),/supersedes/);
 assert.throws(()=>parseResult({...raw,decisions:[{...raw.decisions[0],supersedes:null}]},"product-architect",["qa"],"TEST"),/supersedes/);
});

test("verification depth cannot be declared below what complexity and risk require",()=>{
 const spec=(complexity:string,risk:string,verificationDepth:string)=>({...result("spec"),taskAssessment:{complexity,risk,verificationDepth,uxImpact:"none",rationale:"Assessed against the change"}});
 assert.equal(parseResult(spec("low","low","minimal"),"product-architect").taskAssessment?.verificationDepth,"minimal");
 assert.equal(parseResult(spec("low","low","thorough"),"product-architect").taskAssessment?.verificationDepth,"thorough","declaring more than required is allowed");
 assert.throws(()=>parseResult(spec("low","high","standard"),"product-architect"),/below thorough/);
 assert.throws(()=>parseResult(spec("high","low","minimal"),"product-architect"),/below thorough/);
 assert.throws(()=>parseResult(spec("medium","low","minimal"),"product-architect"),/below standard/);
 assert.equal(requiredVerificationDepth({complexity:"medium",risk:"low"}),"standard");
 assert.equal(requiredVerificationDepth({complexity:"low",risk:"high"}),"thorough");
});

test("a minor finding is recorded instead of sending the Builder another cycle",()=>{
 const withFinding=(classification:string,severity:string,outcome:"changes"|"pass"="changes")=>
  ({...result(outcome),findings:[{classification,severity,evidence:"Naming could be clearer"}]});
 assert.throws(()=>parseResult(withFinding("auto-fix","minor"),"qa"),/minor finding cannot send work back/);
 assert.throws(()=>parseResult(withFinding("defer","major"),"qa"),/major finding cannot be deferred/);
 assert.throws(()=>parseResult(withFinding("defer","critical"),"qa"),/critical finding cannot be deferred/);
 assert.equal(parseResult(withFinding("auto-fix","major"),"qa").outcome,"changes");
 // A deferred minor finding does not block the delivery, which is the whole point.
 assert.equal(parseResult(withFinding("defer","minor","pass"),"qa").findings[0].severity,"minor");
});

test("a proposed specification needs a brief the human can read in place of the SPEC",()=>{
 assert.throws(()=>parseResult(result("spec",{brief:""}),"product-architect"),error=>error instanceof InvalidResultError&&/needs a brief/.test(error.message));
 assert.equal(parseResult(result("spec",{brief:"x".repeat(6001)}),"product-architect").brief.length,6001);
 assert.equal(resultSchemaFor("product-architect").properties?.brief?.maxLength,undefined);
 assert.equal(parseResult(result("spec",{spec:`# Spec\nAC1\n${"x".repeat(25001)}`}),"product-architect").spec.length>25000,true);
 assert.equal(resultSchemaFor("product-architect").properties?.spec?.maxLength,undefined);
 assert.equal(resultSchemaFor("product-architect").properties?.questions?.maxItems,5);
 assert.throws(()=>parseResult(result("questions",{questions:["Which plan?"],brief:"Decisions"}),"product-architect"),/Only a new specification may contain brief/);
 assert.equal(parseResult(result("spec"),"product-architect").brief.startsWith("## Decisions for you"),true);
 assert.equal(parseResult(result("pass",{brief:"injected"}),"developer").brief,"");
 assert.deepEqual(resultSchemaFor("developer").properties?.brief,{type:"string",enum:[""]});
});

test("a Designer result is the prototype and its screenshots, or an environment blocker",()=>{
 const pass=(changedFiles:string[])=>result("pass",{tests:[],coverage:[],changedFiles});
 assert.deepEqual(parseResult(pass([".factory/prototype/01-main.png",".factory/prototype/README.md"]),"designer").changedFiles.length,2);
 assert.throws(()=>parseResult(pass(["src/app.tsx",".factory/prototype/01-main.png"]),"designer"),/all under \.factory\/prototype\//);
 assert.throws(()=>parseResult(pass([".factory/prototype/README.md"]),"designer"),/at least one screenshot/);
 assert.throws(()=>parseResult(result("changes",{findings:[{classification:"auto-fix",severity:"major",evidence:"x"}]}),"designer"),/Invalid designer outcome/);
 assert.throws(()=>parseResult(result("decision"),"designer"),/only for an environment blocker/);
 assert.equal(parseResult(result("decision",{findings:[{classification:"environment-blocked",severity:"major",evidence:"No browser"}]}),"designer").outcome,"decision");
 assert.deepEqual(resultSchemaFor("designer").properties?.outcome,{type:"string",enum:["pass","decision"]});
 assert.deepEqual(resultSchemaFor("designer").properties?.brief,{type:"string",enum:[""]});
 assert.throws(()=>parseResult({...result("spec"),taskAssessment:{...result("spec").taskAssessment!,uxImpact:"large"}},"product-architect"),/uxImpact: invalid value/);
});

test("a split into stories is a small acyclic graph over the specification's own criteria",()=>{
 const criteria=[{id:"AC1",description:"Tokens"},{id:"AC2",description:"Hero"},{id:"AC3",description:"Whole page a11y"}];
 const spec=(stories:unknown)=>result("spec",{acceptanceCriteria:criteria,spec:"# Spec\nAC1 AC2 AC3",stories:stories as never});
 const story=(key:string,criteria:string[],dependsOn:string[]=[],assessment:{complexity:"low"|"medium"|"high";risk:"low"|"medium"|"high";verificationDepth:"minimal"|"standard"|"thorough"}={complexity:"low",risk:"low",verificationDepth:"minimal"})=>({key,title:`Story ${key}`,scope:`Deliver ${key}`,criteria,dependsOn,assessment});
 const parsed=parseResult(spec([story("A",["AC1"]),story("B",["AC2"],["A"])]),"product-architect");
 assert.deepEqual(parsed.stories.map(s=>s.key),["A","B"]);
 assert.equal(parseResult(result("spec"),"product-architect").stories.length,0,"no split by default");
 assert.equal(parseResult(spec([story("A",["AC1"])]),"product-architect").stories.length,1);
 assert.throws(()=>parseResult(spec([story("A",["AC1"]),story("B",["AC2"]),story("C",["AC3"]),story("D",["AC1"]),story("E",["AC2"]),story("F",["AC3"])]),"product-architect"),/At most 5 stories/);
 assert.throws(()=>parseResult(spec([story("A",["AC1"]),story("A",["AC2"])]),"product-architect"),/Duplicate story key/);
 assert.throws(()=>parseResult(spec([story("A",["AC1"]),story("B",["AC1"])]),"product-architect"),/AC1 belongs to both A and B/);
 assert.throws(()=>parseResult(spec([story("A",["AC1"]),story("B",["AC9"])]),"product-architect"),/unknown acceptance criterion AC9/);
 assert.throws(()=>parseResult(spec([story("A",[]),story("B",["AC2"])]),"product-architect"),/owns no acceptance criterion/);
 assert.throws(()=>parseResult(spec([story("A",["AC1"],["Z"]),story("B",["AC2"])]),"product-architect"),/unknown story Z/);
 assert.throws(()=>parseResult(spec([story("A",["AC1"],["A"]),story("B",["AC2"])]),"product-architect"),/depends on itself/);
 assert.throws(()=>parseResult(spec([story("A",["AC1"],["C"]),story("B",["AC2"],["A"]),story("C",["AC3"],["B"])]),"product-architect"),/cycle: A -> C -> B -> A/);
 assert.throws(()=>parseResult(spec([story("A",["AC1"],[],{complexity:"low",risk:"high",verificationDepth:"minimal"}),story("B",["AC2"])]),"product-architect"),/Story A verification depth minimal is below thorough/);
 assert.throws(()=>parseResult(result("questions",{questions:["Split?"],stories:[story("A",["AC1"]),story("B",["AC1"])]}),"product-architect"),/Only a new specification may contain/);
 // Delivery roles cannot introduce a split: the schema pins the field and the parser drops it.
 assert.deepEqual(resultSchemaFor("developer").properties?.stories?.maxItems,0);
 assert.deepEqual(parseResult(result("pass",{stories:[story("A",["AC1"]),story("B",["AC1"])]}),"developer").stories,[]);
});

test("a Tester PASS is a minimum sufficient test set: essentials kept, redundant discarded, every passed criterion covered",()=>{
 const candidate=(name:string,value:"essential"|"valuable"|"redundant",kept:boolean,covers=["AC1"])=>({name,covers,value,kept,reason:`${value} because`});
 const pass=parseResult(result("pass",{testCandidates:[candidate("happy path","essential",true),candidate("boundary","valuable",false),candidate("duplicate","redundant",false)]}),"qa");
 assert.equal(pass.testCandidates.length,3);
 assert.throws(()=>parseResult(result("pass",{testCandidates:[]}),"qa"),/lists the test candidates it considered/);
 assert.throws(()=>parseResult(result("pass",{testCandidates:[candidate("happy path","essential",false)]}),"qa"),/Essential test candidate "happy path" must be kept/);
 assert.throws(()=>parseResult(result("pass",{testCandidates:[candidate("happy path","essential",true),candidate("twice","redundant",true)]}),"qa"),/Redundant test candidate "twice" must not be kept/);
 assert.throws(()=>parseResult(result("pass",{testCandidates:[candidate("happy path","essential",true,[])]}),"qa"),/covers no acceptance criterion/);
 assert.throws(()=>parseResult(result("pass",{testCandidates:[candidate("other","essential",true,["AC2"])]}),"qa"),/No kept test candidate covers AC1/);
 assert.throws(()=>parseResult(result("pass",{testCandidates:[candidate("same","essential",true),candidate("same","valuable",true)]}),"qa"),/Duplicate test candidate/);
 // A Tester reporting changes may still list what it considered; other roles never carry candidates.
 assert.equal(parseResult(result("changes",{findings:[{classification:"auto-fix",severity:"major",evidence:"AC1 fails"}],testCandidates:[candidate("happy path","essential",true)]}),"qa").testCandidates.length,1);
 assert.deepEqual(parseResult(result("pass"),"developer").testCandidates,[]);
 assert.deepEqual(parseResult(result("spec",{testCandidates:[candidate("x","essential",true)]}),"product-architect").testCandidates,[]);
 assert.equal(resultSchemaFor("reviewer").properties?.testCandidates?.maxItems,0);assert.equal(resultSchemaFor("qa").properties?.testCandidates?.maxItems,100);
});

test("a Designer file list is normalized before it is judged: ./, absolute paths and the directory itself do not reject a prototype",()=>{
 const pass=(changedFiles:string[])=>result("pass",{tests:[],coverage:[],testCandidates:[],changedFiles});
 assert.deepEqual(parseResult(pass([".factory/prototype","./.factory/prototype/README.md","/Users/me/ai-factory/data/worktrees/w/.factory/prototype/screenshots/01.png",".factory/prototype/screenshots/","./.factory/prototype/README.md"]),"designer").changedFiles,[".factory/prototype/README.md",".factory/prototype/screenshots/01.png"]);
 assert.deepEqual(normalizePrototypePaths([".factory\\prototype\\a.png"]),[".factory/prototype/a.png"]);
 // A file genuinely outside the prototype is still a contract violation, and the worktree check blocks the write itself.
 assert.throws(()=>parseResult(pass(["./src/app.tsx",".factory/prototype/01.png"]),"designer"),/all under \.factory\/prototype\//);
});

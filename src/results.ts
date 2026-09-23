import type { AgentResult, AgentRole, Criterion, DeliveryStage, Story, TaskAssessment, VerificationDepth } from "./types.js";
import { tacticalRouteError, type TacticalNextRole } from "./tactical-routing.js";
export const reviewDimensions = ["specification", "code-quality", "security", "performance", "product-ui-copy", "test-quality", "dependencies"];
type Schema = { type?: string | string[]; enum?: unknown[]; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; minLength?: number; maxLength?: number; maxItems?: number; };
export class InvalidResultError extends Error { readonly failureClass="invalid-result" as const; }
const text = (maxLength = 5000): Schema => ({ type: "string", minLength: 1, maxLength });
const enumeration = (...values: string[]): Schema => ({ type: "string", enum: values });
const list = (items: Schema): Schema => ({ type: "array", items, maxItems: 100 });
const object = (properties: Record<string, Schema>): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
// Depth cannot be chosen freely: an Architect that declared everything minimal would make every
// run cheap and the product worse. It is floored by the worse of complexity and risk, and the
// human approves it with the spec.
const levels=["low","medium","high"] as const, depths=["minimal","standard","thorough"] as const;
export function requiredVerificationDepth(assessment:Pick<TaskAssessment,"complexity"|"risk">):VerificationDepth {
 return depths[Math.max(levels.indexOf(assessment.complexity),levels.indexOf(assessment.risk))];
}
// The Designer's disposable prototype. It is committed so the human can see its screenshots on
// GitHub, and moved out of the branch before the Builder starts so it never reaches the PR.
export const prototypeDirectory=".factory/prototype";
// The brief replaces reading the spec, so it only works while it stays short enough to be read.
export const briefMaxLength=4000;
// A split costs a Builder and a Tester run per story, so it stays small enough to read in the
// brief and to reason about as a graph.
export const maxStories=4;
const decisionSchema=object({ kind: enumeration("tactical", "major"), decision: text(), rationale: text(), conflictsWithHuman: { type: "boolean" }, supersedes:list(text(100)) });
export const resultSchema = object({
  taskAssessment: { ...object({ complexity: enumeration("low", "medium", "high"), risk: enumeration("low", "medium", "high"), verificationDepth: enumeration("minimal", "standard", "thorough"), uxImpact: enumeration("none", "minor", "significant"), rationale: text() }), type: ["object", "null"] },
  outcome: enumeration("spec", "questions", "resolved", "pass", "changes", "decision"),
  summary: text(1500), brief: { type: "string", maxLength: briefMaxLength }, spec: { type: "string", maxLength: 30000 }, questions: list(text()),
  findings: list(object({ classification: enumeration("auto-fix", "decision-required", "defer", "environment-blocked"), severity: enumeration("critical", "major", "minor"), evidence: text() })),
  acceptanceCriteria: list(object({ id: text(100), description: text() })),
  stories: list(object({ key: text(40), title: text(200), scope: text(2000), criteria: list(text(100)), dependsOn: list(text(40)), assessment: object({ complexity: enumeration("low", "medium", "high"), risk: enumeration("low", "medium", "high"), verificationDepth: enumeration("minimal", "standard", "thorough") }) })),
  coverage: list(object({ criterionId: text(100), status: enumeration("passed", "failed", "not-run"), evidence: text() })),
  tests: list(object({ command: text(), exitCode: { type: ["integer", "null"] }, evidence: text() })),
  testCandidates: list(object({ name: text(200), covers: list(text(100)), value: enumeration("essential", "valuable", "redundant"), kept: { type: "boolean" }, reason: text(1000) })),
  dependencies: list(object({ name: text(200), change: enumeration("added", "updated", "removed"), rationale: text() })),
  changedFiles: list(text(1000)),
  decisions: list(decisionSchema),
  nextRole: { type: ["string", "null"], enum: ["developer", "qa", "reviewer", null] },
  reviewChecks: list(object({ dimension: enumeration(...reviewDimensions), status: enumeration("passed", "failed", "not-applicable"), evidence: text() })),
});
// A field whose role schema admits exactly one value cannot be chosen by the agent, so naming it
// in the prompt only describes an impossible action.
export function pinnedResultFields(role: AgentRole, allowedNextRoles?: TacticalNextRole[]): string[] {
 const properties=resultSchemaFor(role,allowedNextRoles).properties ?? {};
 const pinned=(schema: Schema) => schema.type === "null" || schema.maxItems === 0 || (Array.isArray(schema.enum) && schema.enum.length === 1);
 return Object.entries(properties).filter(([,schema])=>pinned(schema)).map(([name])=>name);
}
// Constrain provider generation by role as well as validating it afterwards.
export function resultSchemaFor(role: AgentRole, allowedNextRoles?: TacticalNextRole[]): Schema {
 const candidates=role === "qa" ? resultSchema.properties!.testCandidates : { ...resultSchema.properties!.testCandidates, maxItems: 0 };
 if (role === "product-architect") return { ...resultSchema, properties: { ...resultSchema.properties, testCandidates: candidates,
  outcome: enumeration("spec", "questions", "resolved"),
  nextRole: allowedNextRoles ? { type: ["string", "null"], enum: [...allowedNextRoles, null] } : resultSchema.properties!.nextRole,
 } };
 return { ...resultSchema, properties: { ...resultSchema.properties,
  outcome: role === "designer" ? enumeration("pass", "decision") : enumeration("pass", "changes", "decision"),
  brief: { type: "string", enum: [""] }, spec: { type: "string", enum: [""] }, acceptanceCriteria: { ...resultSchema.properties!.acceptanceCriteria, maxItems: 0 }, stories: { ...resultSchema.properties!.stories, maxItems: 0 }, testCandidates: candidates,
  taskAssessment: { type: "null" }, nextRole: { type: "null" },
 } };
}
// Validate the same deliberately small JSON Schema vocabulary sent to both CLIs.
function validate(value: unknown, schema: Schema, location = "result"): void {
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some(t => t === kind || t === "integer" && typeof value === "number" && Number.isSafeInteger(value))) throw new Error(`${location}: invalid type`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${location}: invalid value`);
  if (typeof value === "string" && ((schema.minLength && !value.trim()) || value.length > (schema.maxLength ?? Infinity))) throw new Error(`${location}: invalid text length`);
  if (Array.isArray(value)) {
    if (value.length > (schema.maxItems ?? Infinity)) throw new Error(`${location}: too many items`);
    value.forEach((v, i) => validate(v, schema.items!, `${location}[${i}]`));
  } else if (kind === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) throw new Error(`${location}.${key}: required`);
    for (const key of Object.keys(record)) {
      if (!schema.properties?.[key]) throw new Error(`${location}.${key}: unexpected field`);
      validate(record[key], schema.properties[key], `${location}.${key}`);
    }
  }
}
// A split is only worth its cost when it is a real graph: at least two stories, every dependency
// a story of the same epic, no cycle, and each criterion owned by at most one story. Criteria no
// story owns stay with the epic, whose own Tester verifies them once the stories are integrated.
export function validateStories(stories: Story[], criteria: Criterion[]) {
  if (stories.length < 2) throw new Error("A split needs at least two stories; deliver the issue whole otherwise");
  if (stories.length > maxStories) throw new Error(`At most ${maxStories} stories per specification`);
  unique(stories.map(s => s.key), "story key"); unique(stories.map(s => s.title.trim()), "story title");
  const keys = new Set(stories.map(s => s.key)), known = new Set(criteria.map(c => c.id)), owner = new Map<string, string>();
  for (const story of stories) {
    if (!story.criteria.length) throw new Error(`Story ${story.key} owns no acceptance criterion`);
    const floor=requiredVerificationDepth(story.assessment);
    if (depths.indexOf(story.assessment.verificationDepth) < depths.indexOf(floor)) throw new Error(`Story ${story.key} verification depth ${story.assessment.verificationDepth} is below ${floor}, which its ${story.assessment.complexity} complexity and ${story.assessment.risk} risk require`);
    for (const id of story.criteria) {
      if (!known.has(id)) throw new Error(`Story ${story.key} names unknown acceptance criterion ${id}`);
      if (owner.has(id)) throw new Error(`Acceptance criterion ${id} belongs to both ${owner.get(id)} and ${story.key}`);
      owner.set(id, story.key);
    }
    for (const dependency of story.dependsOn) {
      if (dependency === story.key) throw new Error(`Story ${story.key} depends on itself`);
      if (!keys.has(dependency)) throw new Error(`Story ${story.key} depends on unknown story ${dependency}`);
    }
  }
  const state = new Map<string, "visiting" | "done">(), byKey = new Map(stories.map(s => [s.key, s]));
  const visit = (key: string, path: string[]) => {
    if (state.get(key) === "done") return;
    if (state.get(key) === "visiting") throw new Error(`Stories depend on each other in a cycle: ${[...path, key].join(" -> ")}`);
    state.set(key, "visiting"); for (const next of byKey.get(key)!.dependsOn) visit(next, [...path, key]); state.set(key, "done");
  };
  for (const story of stories) visit(story.key, []);
}
// The Tester's selection is checked, not trusted: an essential candidate that was not executed or
// a redundant one that was would make the "minimum sufficient" claim meaningless, and the metrics
// built on it would measure nothing.
export function validateTestSelection(r: Pick<AgentResult, "outcome" | "testCandidates" | "coverage">) {
  unique(r.testCandidates.map(c => c.name.trim()), "test candidate");
  if (r.outcome === "pass" && !r.testCandidates.length) throw new Error("A Tester PASS lists the test candidates it considered, with the ones it kept and why the rest were discarded");
  for (const candidate of r.testCandidates) {
    if (!candidate.covers.length) throw new Error(`Test candidate "${candidate.name}" covers no acceptance criterion`);
    if (candidate.value === "essential" && !candidate.kept) throw new Error(`Essential test candidate "${candidate.name}" must be kept`);
    if (candidate.value === "redundant" && candidate.kept) throw new Error(`Redundant test candidate "${candidate.name}" must not be kept`);
  }
  if (r.outcome === "pass") {
    const kept=new Set(r.testCandidates.filter(c => c.kept).flatMap(c => c.covers));
    const uncovered=r.coverage.filter(c => c.status === "passed" && !kept.has(c.criterionId)).map(c => c.criterionId);
    if (uncovered.length) throw new Error(`No kept test candidate covers ${uncovered.join(", ")}; a passed criterion needs at least one kept test`);
  }
}
function unique(ids: string[], label: string) {
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label}`);
}
function parseResultUnchecked(raw: unknown, role: AgentRole, allowedNextRoles?: TacticalNextRole[], consultationFrom?: DeliveryStage): AgentResult {
  const serialized = JSON.stringify(raw);
  if (serialized && serialized.length > 80000) throw new Error("Agent result exceeds publication limits");
  // Provider structured-output implementations do not all enforce enum/maxItems
  // constraints consistently. Delivery roles never own these fields, so force
  // their inert values rather than letting a report attempt rewrite approved scope.
  const candidate = role !== "product-architect" && raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>), brief:"", spec:"", acceptanceCriteria:[], stories:[], taskAssessment:null, nextRole:null, ...(role === "qa" ? {} : { testCandidates: [] }) }
    : role === "product-architect" && raw !== null && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>), testCandidates: [] } : raw;
  validate(candidate, resultSchema);
  const r = candidate as AgentResult;
  unique(r.acceptanceCriteria.map(c => c.id), "acceptance criterion");
  unique(r.coverage.map(c => c.criterionId), "coverage criterion");
  unique(r.reviewChecks.map(c => c.dimension), "review dimension");
  if (role === "qa") validateTestSelection(r);
  const allowed = role === "product-architect" ? ["spec", "questions", "resolved"] : role === "designer" ? ["pass", "decision"] : ["pass", "changes", "decision"];
  if (!allowed.includes(r.outcome)) throw new Error(`Invalid ${role} outcome: ${r.outcome}`);
  if (r.outcome === "spec" && r.questions.length) throw new Error('A proposed specification must return questions: []. Put decisions that need the human in the brief with your recommendation, and your own assumptions under its assumptions; if a decision has no defensible recommendation is required before proposing it, return outcome "questions" without a SPEC');
  if (r.outcome === "spec" && (!r.spec.trim() || !r.acceptanceCriteria.length || r.acceptanceCriteria.some(c => !r.spec.includes(c.id)))) throw new Error("Specification needs named acceptance criteria in markdown and structured form");
  if (r.outcome === "spec" && !r.brief.trim()) throw new Error("A proposed specification needs a brief: the decisions that need the human, the solution in at most five lines and the acceptance criteria. The human approves the brief instead of reading the SPEC");
  if (r.outcome !== "spec" && (r.brief !== "" || r.spec !== "" || r.acceptanceCriteria.length || r.stories.length)) throw new Error("Only a new specification may contain brief/spec/acceptanceCriteria/stories");
  if (r.stories.length) validateStories(r.stories, r.acceptanceCriteria);
  if (r.outcome === "spec" && !r.taskAssessment) throw new Error("Specification requires a taskAssessment");
  if (r.taskAssessment) {
    const floor=requiredVerificationDepth(r.taskAssessment);
    if (depths.indexOf(r.taskAssessment.verificationDepth) < depths.indexOf(floor))
      throw new Error(`Verification depth ${r.taskAssessment.verificationDepth} is below ${floor}, which ${r.taskAssessment.complexity} complexity and ${r.taskAssessment.risk} risk require`);
  }
  for (const finding of r.findings) {
    if (finding.classification === "defer" && finding.severity !== "minor") throw new Error(`A ${finding.severity} finding cannot be deferred; fix it now or raise it as a decision`);
    if (finding.classification === "auto-fix" && finding.severity === "minor") throw new Error("A minor finding cannot send work back to the Builder; defer it so it is recorded without a correction cycle");
  }
  if (r.outcome !== "spec" && r.taskAssessment !== null) throw new Error("Only a new specification may change taskAssessment");
  if (r.outcome === "questions" && !r.questions.length) throw new Error("No clarification questions");
  if (r.outcome === "resolved") {
    if (!r.nextRole || !r.decisions.length || r.decisions.some(d => d.kind !== "tactical" || d.conflictsWithHuman) || r.questions.length || r.findings.some(f => f.classification === "decision-required")) throw new Error("Tactical resolution cannot require a human decision");
    if (allowedNextRoles && !allowedNextRoles.includes(r.nextRole)) throw new Error(tacticalRouteError(r.nextRole, allowedNextRoles, consultationFrom));
  } else if (r.nextRole !== null) throw new Error("Only a tactical resolution may select nextRole");
  if (r.outcome === "changes" && !r.findings.some(f => f.classification === "auto-fix")) throw new Error("Changes require an auto-fix finding");
  if (r.outcome === "decision" && !r.findings.some(f => ["decision-required","environment-blocked"].includes(f.classification))) throw new Error("Decision requires an explicit finding");
  if(r.findings.some(f=>f.classification==="environment-blocked")&&!["decision","resolved"].includes(r.outcome)&&!(role==="product-architect"&&r.outcome==="questions"))throw new Error("Environment blockers require Architect questions, a delivery decision or a tactical resolution");
  if (role === "designer") {
    if (r.outcome === "decision" && r.findings.some(f => f.classification !== "environment-blocked")) throw new Error("Designer returns decision only for an environment blocker; put UX concerns for the human in the summary and the prototype notes");
    if (r.outcome === "pass" && (!r.changedFiles.length || r.changedFiles.some(file => !file.startsWith(`${prototypeDirectory}/`)))) throw new Error(`Designer PASS lists the prototype files it wrote, all under ${prototypeDirectory}/`);
    if (r.outcome === "pass" && !r.changedFiles.some(file => /\.(png|jpe?g|webp)$/i.test(file))) throw new Error("Designer PASS needs at least one screenshot (.png, .jpg or .webp) of the prototype for the human to approve");
  }
  if (r.outcome === "pass") {
    if (r.findings.some(f => f.classification !== "defer") || r.questions.length || r.decisions.some(d => d.kind === "major" || d.conflictsWithHuman)) throw new Error("PASS contradicts a blocking finding or decision");
    if (role === "developer" || role === "qa") {
      if (!r.tests.length) throw new Error("PASS requires successful executed tests with exit codes");
      const unsuccessful=r.tests.filter(t=>t.exitCode !== 0);
      if (unsuccessful.length) {
        const commands=unsuccessful.slice(0,3).map(t=>`${t.command.slice(0,200)} (exit ${t.exitCode ?? "not executed"})`).join("; ");
        throw new Error(`PASS requires successful executed tests with exit codes; failing or unexecuted commands: ${commands}`);
      }
    }
    if (role === "reviewer" && (r.reviewChecks.length !== reviewDimensions.length || r.reviewChecks.some(c => c.status === "failed"))) throw new Error("Delivery Reviewer PASS requires all review dimensions");
  }
  return r;
}
export function parseResult(raw: unknown,role:AgentRole,allowedNextRoles?:TacticalNextRole[],consultationFrom?:DeliveryStage):AgentResult {
 try{return parseResultUnchecked(raw,role,allowedNextRoles,consultationFrom);}catch(error){if(error instanceof InvalidResultError)throw error;throw new InvalidResultError(error instanceof Error?error.message:String(error));}
}
// `required` is the subset a PASS must cover: every criterion, except on an epic whose stories
// already verified their own, where only the criteria no completed story owns remain.
export function validateCoverage(r: AgentResult, criteria: Criterion[], required: Criterion[] = criteria) {
  try {
   if (!criteria.length) throw new Error("Approved specification lacks structured acceptance criteria; regenerate it");
   const ids = new Set(criteria.map(c => c.id)), needed = new Set(required.map(c => c.id)), covered = new Set(r.coverage.map(c => c.criterionId));
   if (r.coverage.some(c => !ids.has(c.criterionId))) throw new Error("Report references an unknown acceptance criterion");
   if (r.outcome === "pass" && ([...needed].some(id => !covered.has(id)) || r.coverage.some(c => c.status !== "passed"))) throw new Error("PASS must cover every approved acceptance criterion with evidence");
  } catch(error){if(error instanceof InvalidResultError)throw error;throw new InvalidResultError(error instanceof Error?error.message:String(error));}
}

import type { AgentResult, AgentRole, Criterion } from "./types.js";
export const reviewDimensions = ["specification", "code-quality", "security", "performance", "product-ui-copy", "test-quality", "dependencies"];
type Schema = { type?: string | string[]; enum?: unknown[]; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; minLength?: number; maxLength?: number; maxItems?: number; };
const text = (maxLength = 5000): Schema => ({ type: "string", minLength: 1, maxLength });
const enumeration = (...values: string[]): Schema => ({ type: "string", enum: values });
const list = (items: Schema): Schema => ({ type: "array", items, maxItems: 100 });
const object = (properties: Record<string, Schema>): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const resultSchema = object({
  taskAssessment: { ...object({ complexity: enumeration("low", "medium", "high"), risk: enumeration("low", "medium", "high"), rationale: text() }), type: ["object", "null"] },
  outcome: enumeration("spec", "questions", "resolved", "pass", "changes", "decision"),
  summary: text(10000), spec: { type: "string", maxLength: 30000 }, questions: list(text()),
  findings: list(object({ classification: enumeration("auto-fix", "decision-required", "defer"), evidence: text() })),
  acceptanceCriteria: list(object({ id: text(100), description: text() })),
  coverage: list(object({ criterionId: text(100), status: enumeration("passed", "failed", "not-run"), evidence: text() })),
  tests: list(object({ command: text(), exitCode: { type: ["integer", "null"] }, evidence: text() })),
  dependencies: list(object({ name: text(200), change: enumeration("added", "updated", "removed"), rationale: text() })),
  changedFiles: list(text(1000)),
  decisions: list(object({ kind: enumeration("tactical", "major"), decision: text(), rationale: text(), conflictsWithHuman: { type: "boolean" } })),
  nextRole: { type: ["string", "null"], enum: ["developer", "qa", "reviewer", null] },
  reviewChecks: list(object({ dimension: enumeration(...reviewDimensions), status: enumeration("passed", "failed", "not-applicable"), evidence: text() })),
});
// Constrain provider generation by role as well as validating it afterwards.
export function resultSchemaFor(role: AgentRole): Schema {
 if (role === "product-architect") return { ...resultSchema, properties: { ...resultSchema.properties, outcome: enumeration("spec", "questions", "resolved") } };
 return { ...resultSchema, properties: { ...resultSchema.properties,
  outcome: enumeration("pass", "changes", "decision"),
  spec: { type: "string", enum: [""] }, acceptanceCriteria: { ...resultSchema.properties!.acceptanceCriteria, maxItems: 0 },
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
function unique(ids: string[], label: string) {
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label}`);
}
export function parseResult(raw: unknown, role: AgentRole): AgentResult {
  validate(raw, resultSchema);
  const r = raw as AgentResult;
  if (JSON.stringify(r).length > 80000) throw new Error("Agent result exceeds publication limits");
  unique(r.acceptanceCriteria.map(c => c.id), "acceptance criterion");
  unique(r.coverage.map(c => c.criterionId), "coverage criterion");
  unique(r.reviewChecks.map(c => c.dimension), "review dimension");
  const allowed = role === "product-architect" ? ["spec", "questions", "resolved"] : ["pass", "changes", "decision"];
  if (!allowed.includes(r.outcome)) throw new Error(`Invalid ${role} outcome: ${r.outcome}`);
  if (r.outcome === "spec" && (r.questions.length || !r.spec.trim() || !r.acceptanceCriteria.length || r.acceptanceCriteria.some(c => !r.spec.includes(c.id)))) throw new Error("Specification needs named acceptance criteria in markdown and structured form");
  if (r.outcome !== "spec" && (r.spec !== "" || r.acceptanceCriteria.length)) throw new Error("Only a new specification may contain spec/acceptanceCriteria");
  if (r.outcome === "spec" && !r.taskAssessment) throw new Error("Specification requires a taskAssessment");
  if (r.outcome !== "spec" && r.taskAssessment !== null) throw new Error("Only a new specification may change taskAssessment");
  if (r.outcome === "questions" && !r.questions.length) throw new Error("No clarification questions");
  if (r.outcome === "resolved") {
    if (!r.nextRole || !r.decisions.length || r.decisions.some(d => d.kind !== "tactical" || d.conflictsWithHuman) || r.questions.length || r.findings.some(f => f.classification === "decision-required")) throw new Error("Tactical resolution cannot require a human decision");
  } else if (r.nextRole !== null) throw new Error("Only a tactical resolution may select nextRole");
  if (r.outcome === "changes" && !r.findings.some(f => f.classification !== "defer")) throw new Error("Changes require actionable findings");
  if (r.outcome === "decision" && !r.findings.some(f => f.classification === "decision-required")) throw new Error("Decision requires an explicit finding");
  if (r.outcome === "pass") {
    if (r.findings.some(f => f.classification !== "defer") || r.questions.length || r.decisions.some(d => d.kind === "major" || d.conflictsWithHuman)) throw new Error("PASS contradicts a blocking finding or decision");
    if ((role === "developer" || role === "qa") && (!r.tests.length || r.tests.some(t => t.exitCode !== 0))) throw new Error("PASS requires successful executed tests with exit codes");
    if (role === "reviewer" && (r.reviewChecks.length !== reviewDimensions.length || r.reviewChecks.some(c => c.status === "failed"))) throw new Error("Reviewer PASS requires all review dimensions");
  }
  return r;
}
export function validateCoverage(r: AgentResult, criteria: Criterion[]) {
  if (!criteria.length) throw new Error("Approved specification lacks structured acceptance criteria; regenerate it");
  const ids = new Set(criteria.map(c => c.id));
  if (r.coverage.some(c => !ids.has(c.criterionId))) throw new Error("Report references an unknown acceptance criterion");
  if (r.outcome === "pass" && (r.coverage.length !== ids.size || r.coverage.some(c => c.status !== "passed"))) throw new Error("PASS must cover every approved acceptance criterion with evidence");
}

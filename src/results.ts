import type { AgentResult, AgentRole } from "./types.js";
export const resultSchema = {
 type: "object", additionalProperties: false,
 properties: {
  outcome: { type: "string", enum: ["spec", "questions", "pass", "changes", "decision"] },
  summary: { type: "string" }, spec: { type: "string" }, questions: { type: "array", items: { type: "string" } },
  findings: { type: "array", items: { type: "object", additionalProperties: false,
   properties: { classification: { type: "string", enum: ["auto-fix", "decision-required", "defer"] }, evidence: { type: "string" } }, required: ["classification", "evidence"] } },
 }, required: ["outcome", "summary", "spec", "questions", "findings"],
};
export function parseResult(raw: unknown, role: AgentRole): AgentResult {
 const r = raw as AgentResult;
 if (!r || typeof r.summary !== "string" || !r.summary.trim() || typeof r.spec !== "string" || !Array.isArray(r.questions) || r.questions.some(q => typeof q !== "string") || !Array.isArray(r.findings)
  || r.findings.some(f => !f || !["auto-fix", "decision-required", "defer"].includes(f.classification) || typeof f.evidence !== "string" || !f.evidence.trim())) throw new Error("Invalid agent result");
 if (r.spec.length > 30000 || r.summary.length > 10000 || JSON.stringify(r).length > 50000) throw new Error("Agent result exceeds publication limits");
 const allowed = role === "product-architect" ? ["spec", "questions"] : ["pass", "changes", "decision"];
 if (!allowed.includes(r.outcome)) throw new Error(`Invalid ${role} outcome: ${r.outcome}`);
 if (r.outcome === "spec" && !r.spec.trim()) throw new Error("Empty specification");
 if (r.outcome === "questions" && !r.questions.length) throw new Error("No clarification questions");
 if (r.outcome === "changes" && !r.findings.some(f => f.classification === "auto-fix" || f.classification === "decision-required")) throw new Error("Changes require actionable findings");
 if (r.outcome === "pass" && r.findings.some(f => f.classification !== "defer")) throw new Error("PASS contradicts blocking findings");
 return r;
}

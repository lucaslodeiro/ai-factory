# Execution result contract

The machine-readable source of truth is `resultSchema` in `src/results.ts`, used by both provider adapters and validated locally. Every field is required; use empty arrays, empty `brief` and `spec`, and null `taskAssessment` and `nextRole` when inapplicable.

| Field | Meaning |
|---|---|
| `outcome` | Architect: spec/questions/resolved. Designer: pass (prototype ready) or decision (environment blocker only). Delivery roles: pass/changes/decision. |
| `taskAssessment` | New spec only: complexity/risk low, medium or high, verificationDepth, uxImpact none/minor/significant and concrete rationale. Human approves this with the spec; all other outcomes use null. |
| `summary` | Concise role conclusion and evidence summary. |
| `brief` | Only for a new specification: the short document the human approves instead of reading the SPEC (decisions with recommendations, solution, criteria, assumptions, assessment). At most 4000 characters. |
| `spec`, `acceptanceCriteria` | Only for a new specification: markdown plus unique IDs/descriptions. |
| `stories` | Only for a new specification, and empty unless the issue is an epic: 2 to 4 stories with a unique `key` and `title`, a `scope`, the `criteria` ids the story owns (each id in at most one story), `dependsOn` keys forming no cycle and an `assessment` (complexity, risk, verificationDepth floored by the worse of the two) that governs that story's Tester. Builder and Tester deliver each story on its own branch from the epic branch; criteria no story owns are verified on the whole once every story is integrated. |
| `coverage` | Each criterion's ID, passed/failed/not-run status and evidence. PASS covers every approved ID. |
| `tests` | Final verification commands used as acceptance evidence, with numeric exit code and evidence. Builder/Tester PASS requires every listed command to succeed. Setup, diagnostics and process lifecycle commands belong in the summary or findings. |
| `testCandidates` | Tester only: every test it considered, with `name`, the criterion ids it `covers`, its `value` (essential/valuable/redundant), whether it was `kept` and the `reason`. Essential is always kept, redundant never; a PASS needs at least one candidate and a kept candidate for every passed criterion. Other roles leave it empty. |
| `dependencies` | Name, added/updated/removed and rationale; empty means none reported. |
| `changedFiles` | Explicit list of changed paths. |
| `findings` | auto-fix/decision-required/defer/environment-blocked classification and concrete evidence. |
| `questions` | Blocking questions only with Architect outcome `questions`; use `[]` with outcome `spec`. Put decisions with a recommendation in the brief and your own assumptions under its "Assumed without asking". |
| `decisions` | tactical/major, decision, rationale and whether it conflicts with a human decision. |
| `nextRole` | Non-null only for an approved-spec tactical resolution; cannot bypass gates. |
| `reviewChecks` | Evidence per review dimension, including reasons for not-applicable. |

A tactical resolution does not contain a replacement spec or criteria. Major decisions and conflicts cannot use that outcome. All new specs require human approval of their brief. The orchestrator stores full reports and rejects contradictions such as PASS with a failing test or a blocking finding. Reported evidence remains an agent assertion to be independently checked by Tester/Reviewer.

Provider schemas are specialized by role: delivery roles cannot return a replacement spec, acceptance criteria, task assessment or nextRole. In `tests`, report only final acceptance verification for the current files; disclose historical failures, setup, diagnostics, server lifecycle and cleanup commands in `summary` or an appropriate finding. A failed required verification blocks PASS. A read-only Delivery Reviewer may cite explicitly attributed Tester execution evidence while independently inspecting code and test quality; its own `tests` list stays empty if it ran no commands. Missing or insufficient execution evidence must block PASS.

Execution environment failures (browser launch, permissions, unavailable runtime or network required to complete the current stage) use `environment-blocked`, with evidence and the prerequisite to fix before Retry. An optional research or validation limitation belongs in `summary` and must not block the stage. An initial Architect pairs a real blocker with `questions`; delivery agents return `decision`; a consulting Architect returns `resolved` with its permitted nextRole. A blocker stops the workflow as Failed without routing through another architectural consultation. `defer` is only for optional, non-blocking follow-up.

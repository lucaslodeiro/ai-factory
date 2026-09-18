# Execution result contract

The machine-readable source of truth is `resultSchema` in `src/results.ts`, used by both provider adapters and validated locally. Every field is required; use empty arrays, empty `spec`, and null `taskAssessment` and `nextRole` when inapplicable.

| Field | Meaning |
|---|---|
| `outcome` | Architect: spec/questions/resolved. Delivery roles: pass/changes/decision. |
| `taskAssessment` | New spec only: complexity/risk low, medium or high and concrete rationale. Human approves this with the spec; all other outcomes use null. |
| `summary` | Concise role conclusion and evidence summary. |
| `spec`, `acceptanceCriteria` | Only for a new specification: markdown plus unique IDs/descriptions. |
| `coverage` | Each criterion's ID, passed/failed/not-run status and evidence. PASS covers every approved ID. |
| `tests` | Actual command, numeric exit code (null if not executed) and evidence. Developer/QA PASS requires successful executed tests. |
| `dependencies` | Name, added/updated/removed and rationale; empty means none reported. |
| `changedFiles` | Explicit list of changed paths. |
| `findings` | auto-fix/decision-required/defer classification and concrete evidence. |
| `questions` | Questions requiring human input. |
| `decisions` | tactical/major, decision, rationale and whether it conflicts with a human decision. |
| `nextRole` | Non-null only for an approved-spec tactical resolution; cannot bypass gates. |
| `reviewChecks` | Evidence per review dimension, including reasons for not-applicable. |

A tactical resolution does not contain a replacement spec or criteria. Major decisions and conflicts cannot use that outcome. All new specs require human approval. The orchestrator stores full reports and rejects contradictions such as PASS with a failing test or a blocking finding. Reported evidence remains an agent assertion to be independently checked by QA/Reviewer.

Provider schemas are specialized by role: delivery roles cannot return a replacement spec, acceptance criteria, task assessment or nextRole. In `tests`, report final verification for the current files; disclose historical failures and their fixes in `summary`. A read-only Reviewer may cite explicitly attributed QA execution evidence while independently inspecting code and test quality; its own `tests` list stays empty if it ran no commands. Missing or insufficient execution evidence must block PASS.

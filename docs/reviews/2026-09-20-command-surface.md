# Human command surface review and implementation

## Decisions

- **C1 — agree, different fix.** Newly observed applied, rejected, stale, deferred and expired commands need a visible durable outcome. An already consumed comment edit cannot produce a new outcome because the cursor deliberately prevents reprocessing and issue-comment polling supplies no edit event; the implementation therefore covers every newly observed command and leaves edits inert.
- **C2 — agree.** An open merge request currently rejects `/factory answer`; routing explicit human review feedback to Builder as an `auto-fix` finding is the minimal safe transition.
- **C3 — agree.** One first-line command grammar removes surprising differences and prevents prose or quoted commands from firing.
- **C4 — agree.** Guidance belongs in instruction records while pause/cancel reasons belong only to transition evidence; retry should share the scoped-guidance grammar.
- **C5 — agree.** The complete command surface needs an idempotent help comment, an always-available collapsed reference and complete user documentation.
- **C6 — agree.** The existing record rules already permit GitHub-authored human decisions to supersede one another; replace/revoke should expose that supported lifecycle without touching tactical decisions.
- **C7 — agree, different fix.** Ordinals are assigned by rank across all human guidance ever created, including inactive records, and only active entries are actionable/displayed. This preserves `#2` after `#1` is revoked; numbering only the current active subset would renumber entries and contradict the no-reuse requirement.
- **C8 — agree.** Every workflow state should expose the exact valid commands and explain how optional text is stored.

## Changes

Implementation details and commit hashes are recorded below as each item lands.

### C1 — visible command outcomes

- Files: `src/workflow-inbox.ts`, `src/workflow-status.ts`, `test/workflow-inbox.test.ts`, `test/execution.test.ts`, `docs/CONTEXT_AND_WORKFLOW_DESIGN.md`.
- Change: persisted the latest newly observed command outcome in work-item context, advanced presentation for non-applied outcomes and rendered the outcome/reason in the authoritative status table. Comment-origin starts begin with an applied outcome. The pre-existing cancellation fixture now waits for worker readiness instead of a fixed delay so required full-suite runs are deterministic.
- Tests: `command outcomes are persisted and visible in the status comment` covers wrong-version approval, typo, trailing text and unknown replacement; `applied answers and stale commands render their outcome` covers stale and applied states.
- Commit: `3f3acaf`.

### C2 — pull request feedback

- Files: `src/workflow-commands.ts`, `src/workflow-status.ts`, `test/workflow-commands.test.ts`, `docs/CONTEXT_AND_WORKFLOW_DESIGN.md`.
- Change: `/factory answer <feedback>` now resolves an open merge request, creates a human `auto-fix` finding for Builder and returns the item to `BUILD/QUEUED` without incrementing correction cycles. The merge CTA advertises both merge and request-changes paths.
- Test: `merge feedback returns delivery to Builder as an open human auto-fix finding` verifies the transition, record ownership/content and Builder context.
- Commit: `7276796`.

### C3 — uniform first-line grammar

- Files: `src/factory-command.ts`, `test/factory-command.test.ts`, `docs/CONTEXT_AND_WORKFLOW_DESIGN.md`.
- Change: all commands are now recognized only on the first non-empty line. Text commands consume inline and following text; no-text commands ignore following prose. Commands after prose and quoted commands remain inert, and the former last-line answer/retry form was removed.
- Tests: `parses lifecycle commands strictly` covers trailing prose and inert embedded commands; `answer and retry accept inline or following multiline guidance` covers the shared payload rule.
- Commit: `f6ff018`.

### C4 — command guidance and reasons

- Files: `src/factory-command.ts`, `src/workflow-inbox.ts`, `src/workflow-orchestrator.ts`, `src/workflow-commands.ts`, `src/workflow-status.ts`, `src/daemon.ts`, affected typed tests, `docs/CONTEXT_AND_WORKFLOW_DESIGN.md`.
- Change: start guidance is stored before Design begins; approval guidance becomes a spec instruction; retry shares note's scope/role selectors; pause and cancel text is transition evidence only. Retry CTAs explain guidance lifetime and visibility.
- Tests: `start guidance exists before the first Architect execution`; `approval guidance becomes a spec-scoped instruction`; `retry guidance accepts role and issue scopes`; `pause and cancel reasons are transition evidence rather than guidance records`; parser assertions cover every new form.
- Commit: recorded after commit creation.

## Removed or changed behavior

To be completed after implementation.

## Not changed

- Editing an already consumed GitHub comment remains inert. Post a new comment to receive a command outcome and trigger workflow behavior.

## Verification

- Before changes: `npm test` — 113 tests, 112 passed, 1 failed. The pre-existing timing-sensitive test `explicit cancellation escalates an in-progress interruption` observed `interrupted` before its later cancel under concurrent suite load.
- After C1: `npm test` — 115 tests, 115 passed, 0 failed.
- After C2: `npm test` — 116 tests, 116 passed, 0 failed.
- After C3: focused parser tests — 3 passed; `npm test` — 116 tests, 116 passed, 0 failed.
- After C4: focused command/parser/inbox tests — 27 passed; `npm test` — 120 tests, 120 passed, 0 failed.

## Documentation

To be completed after implementation.

## Open questions

None at validation time.

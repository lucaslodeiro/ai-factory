# Issue content review — 2026-09-20

Baseline: `main` at `282396c`; 144 tests passed before changes.

## Decisions

- **I1 — agree.** The harness rendered `# Specification v0`, followed by questions and “Review the specification”; no specification existed.
- **I2 — agree.** The tactical resolution rendered `# Specification v1` with “Review the specification”, while the status still showed the preceding Tester summary.
- **I3 — agree.** The SPEC milestone rendered a second top-level heading from the raw SPEC and referred the reader to another comment instead of showing concrete approval and feedback commands.
- **I4 — agree.** The Reviewer milestone omitted the stored pull-request URL, and the Tester decision used the static “next workflow stage” copy.
- **I5 — agree.** Status rows exposed `clarification`, `spec-approval`, `tactical-decision` and `merge`; terminal actionable states could show `Current actor | None`.
- **I6 — agree.** Pausing a merge request kept the merge CTA; cancellation rendered a generic resume CTA without the actor or transition reason.
- **I7 — agree.** The transition history included `RUNNING` bookkeeping, raw ids such as `product-architect` and `qa`, and ISO timestamps.
- **I8 — agree, different fix.** A `timed_out` execution still received the generic “rejected the stage result” diagnosis. The separate claim that its process result renders as `running` no longer applies: current `main` rendered `Process result: timed_out`. The fix will classify from failure class and final execution status while preserving the already-correct status row.
- **I9 — agree.** `/factory answer` without guidance rendered only the generic malformed-command message even though the parser produced a specific reason.
- **I10 — agree.** No assignment operation exists in the publisher or GitHub port, so entering a human-action state only edits the status comment and labels. Assignment is an appropriate idempotent GitHub-native notification; no mention comment will be added.

## Changes

Pending implementation.

## Rendered samples

Pending final harness output.

## Not changed

- I8's process-result row already uses the persisted final execution status and will not be changed.

## Verification

- Before changes: `npm test` — 144 passed, 0 failed.
- Harness on current `main`: `node --import tsx --test test/issue-content.test.ts` — 1 passed, 0 failed.

## Documentation

Pending implementation.

## Open questions

None at validation time.

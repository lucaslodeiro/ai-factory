# Workflow follow-ups — 2026-09-20

Reviewed against `main` at `57545d6`. The changes are on `fix/workflow-followups` and were not pushed, merged, tagged or proposed as a pull request.

## Decisions

- **F1 — agree.** `WorkflowInbox.poll` advanced the comment cursor before `WorkflowCommands.apply` called `assertExecutionStopped`. A transient live execution therefore produced `command.rejected` and permanently consumed the retry. The minimal fix is a typed transient error and bounded inbox deferral.
- **F2 — agree.** `workflowStatusMarkdown` inserted the complete latest delivery summary although the result schema permits 10,000 characters. The minimal fix is to clip that projection and point to its execution when clipped.

## Changes

### F1 — `082160f`

- Files: `src/execution-manager.ts`, `src/workflow-inbox.ts`, `test/workflow-inbox.test.ts`, `docs/CONTEXT_AND_WORKFLOW_DESIGN.md`.
- `assertExecutionStopped` now raises `ExecutionNotStoppedError` for a running execution, live recovered process group, or an indeterminate process check.
- The inbox records `command.deferred` once, restores the previous cursor, stops processing later comments and retries the same comment on the next poll.
- Once `config.timeoutMs` has elapsed, the command becomes `command.rejected` with a clear timeout message and the cursor advances, preventing a stuck process from blocking intake forever.
- Test **retry waits for a paused execution to exit without consuming the comment** proves the cursor and `PAUSED` state remain unchanged while the row is `running`, then the next poll applies the same retry after it becomes `interrupted`, producing `QUEUED` and `attempt + 1`.
- Test **retry deferral expires instead of pinning the comment cursor forever** proves an expired deferral is rejected and consumed with an explicit message.

### F2 — `5f1bd89`

- Files: `src/workflow-status.ts`, `test/workflow-github.test.ts`, `docs/CONTEXT_AND_WORKFLOW_DESIGN.md`.
- The latest delivery summary is clipped to 1,450 characters, keeping the complete rendered section near 1,600 characters after its heading, role and follow-up line.
- A clipped summary ends with an ellipsis and identifies the execution to open in the dashboard for the complete result.
- Test **status clips a verbose delivery summary and preserves one authoritative next action** renders a 10,000-character summary, asserts the section is at most 1,600 characters, verifies the execution direction, and confirms exactly one `## Next action` block.

## Not changed

Nothing. Both observations were confirmed and fixed.

## Verification

- Baseline: `npm test` — **106 total, 106 pass, 0 fail, 0 skipped**.
- F1 red-before: `node --import tsx --test test/workflow-inbox.test.ts` — **7 total, 6 pass, 1 fail**; cursor was `3` instead of remaining at `2`.
- F1 green focused: `node --import tsx --test test/workflow-inbox.test.ts` — **8 total, 8 pass, 0 fail**.
- After F1: `npm test` — **108 total, 108 pass, 0 fail, 0 skipped**.
- F2 first focused run: `node --import tsx --test test/workflow-github.test.ts` — **7 total, 6 pass, 1 fail** because a 1,500-character payload made the complete section 1,643 characters. The payload limit was adjusted to 1,450 so the rendered section satisfies the requested bound.
- F2 green focused: `node --import tsx --test test/workflow-github.test.ts` — **7 total, 7 pass, 0 fail**.
- After F2: `npm test` — **109 total, 109 pass, 0 fail, 0 skipped**.
- First `npm run build` attempt inside the filesystem sandbox failed with `TS5033 EPERM` while writing existing `dist` files. This was an environment permission failure, not a TypeScript diagnostic.
- Final `npm run build` outside that restriction — passed (`tsc` and asset copy).
- Final `git diff --check` — passed.
- Final `git status --short --branch` — clean branch, two finding commits ahead of `origin/main` before adding this report.

No live GitHub or provider execution was performed; validation used the repository's focused and integration tests.

## Documentation

- **§5.4 Scope:** documents deferred retry, preservation of the cursor, later polling and bounded timeout rejection.
- **§8.2 Status comment:** documents the approximate 1,500-character delivery-summary limit and execution pointer for clipped content.

## Open questions

None.

---

## F3 — Cancel bypass for a deferred retry

### Decision

**Agree with a different fix.** The deferred retry did block every later comment, including `/factory cancel`. The proposed inbox bypass was necessary but insufficient: after `/factory pause`, `ExecutionManager.cancel()` ignored cancellation when its run was already marked `interrupted`, the supervisor ignored a second termination request while stopping, and final status preferred `interrupted`. F3 therefore also includes the smallest change that upgrades an in-progress interrupt to forced explicit cancellation.

### Changes — `9c436a0`

- Files: `src/workflow-inbox.ts`, `src/workflow-commands.ts`, `src/execution-manager.ts`, `src/worker-supervisor.mjs`, `test/workflow-inbox.test.ts`, `test/execution.test.ts`, `docs/CONTEXT_AND_WORKFLOW_DESIGN.md`.
- The inbox continues scanning after a deferred retry but permits only an authorized `/factory cancel` to execute.
- A bypassing cancel uses the normal command path, records `command.superseded` once in the same transaction, advances the cursor to the cancel and counts intervening comments as observed without applying them.
- Without a later cancel, the deferred cursor behavior is unchanged.
- Cancel now finds the most recent still-running execution when a pause has cleared `activeRunId`.
- Explicit cancel upgrades an existing interrupt, arms the supervisor's SIGKILL escalation and records execution status `cancelled` with reason `user-cancel`.
- Tests:
  - **cancel bypasses a deferred retry and supersedes it atomically**.
  - **comments between deferred retry and cancel are consumed only as observed**.
  - **non-cancel commands remain blocked behind a deferred retry**.
  - **explicit cancellation escalates an in-progress interruption**.

### Verification

- Baseline: `npm test` — **109 total, 109 pass, 0 fail, 0 skipped**.
- Red inbox run: `node --import tsx --test test/workflow-inbox.test.ts` — **11 total, 9 pass, 2 fail**. Both cancel-bypass cases remained `PAUSED`; the non-cancel preservation case passed.
- Red escalation run: `node --import tsx --test test/execution.test.ts` — **6 total, 5 pass, 1 fail**. The execution completed as `interrupted` instead of `cancelled`.
- Green focused run: `node --import tsx --test test/workflow-inbox.test.ts test/execution.test.ts` — **17 total, 17 pass, 0 fail**.
- Final `npm test` — **113 total, 113 pass, 0 fail, 0 skipped**.
- Final `npm run build` — passed (`tsc` and asset copy).
- Final `git diff --check` — passed.

### Documentation

- **§5.4 Scope:** now states that authorized cancel bypasses and supersedes a deferred retry, consumes intervening comments as observed, cancels the workflow and upgrades the live interruption to forced cancellation.

### Open questions

None.

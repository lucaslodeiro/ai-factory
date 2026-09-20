# Workflow conformance fixes — 2026-09-20

Reviewed against `main` at `168eb14` (`v0.2.0`). The work is on `fix/workflow-conformance`; it was not pushed, merged, tagged or proposed as a pull request.

## Decisions

- **H1 — agree.** A control-origin start stored cursor `0`, so old unguarded commands could be replayed.
- **H2 — agree.** Comment-driven cancellation changed the projection without cancelling the live execution.
- **H3 — disagree.** The current `WorkflowResults.architect` spec branch already calls `supersedeSpec(workItemId, specVersion)` before creating `spec-approval`, within the same projection transaction. `supersedeSpec` closes every active/open `scope: spec` record for that version, including the tactical request and its `decision-required` findings, so the alleged open-request-chain rejection is not present at `168eb14`.
- **M1 — agree.** `publishResults` emitted an immutable comment for every agent result.
- **M2 — agree.** Factory-authored marker comments were presented as ordinary approver observations.
- **M3 — agree.** The maintenance barrier was checked before the scheduling transaction.
- **M4 — agree, option (a).** `/factory pause` is now an issue command for queued, running and waiting work. It preserves requests and interrupts a live run with reason `user-pause`.
- **L1 — disagree.** Design decision 12 explicitly requires deletion of `completion.json` after retention. The existing removable list conforms to the current specification.
- **L2 — agree.** The result contract could not carry tactical supersession ids even though record creation already validates them.
- **L3 — agree.** Message-text regex classification could misclassify provider failures.
- **L4 — agree.** Reviewer context cleanup did not cover a refusal from `scheduler.begin()`.

## Changes

### H1 — `07b1b3e`

- Files: `src/workflow-inbox.ts`, `src/workflow-orchestrator.ts`, `test/workflow-orchestrator.test.ts`, `docs/CONTEXT_AND_WORKFLOW_DESIGN.md`.
- Change: dashboard/CLI intake snapshots the newest existing issue comment as the initial cursor; comment-origin starts retain their command id as the cursor.
- Test: **dashboard start snapshots historical comments instead of replaying commands** proves that an old `/factory cancel` does not cancel a newly started item.

### H2 — `11f8ad5`

- Files: `src/workflow-commands.ts`, `src/workflow-inbox.ts`, `src/workflow-orchestrator.ts`, `src/daemon.ts`, `test/workflow-inbox.test.ts`.
- Change: cancellation returns an execution action, the inbox invokes the injected execution controller after the state transaction commits, and the daemon supplies its `ExecutionManager`.
- Test: **GitHub cancel stops the active execution after cancelling the workflow** proves the cancel control is invoked, the work item becomes `CANCELLED`, and the execution row ends `cancelled`.

### M1 — `6a85199`

- Files: `src/workflow-github.ts`, `src/workflow-status.ts`, `test/workflow-github.test.ts`.
- Change: immutable result comments are limited to Architect specification/questions/resolution, Reviewer pass, decision requests and correction-limit milestones. Intermediate result events are marked published without creating comments; the latest delivery summary appears in the mutable status comment.
- Test: **publisher keeps intermediate delivery results in status and publishes only milestone comments** proves Builder pass is not published, Architect spec is published, idempotency is retained, and the delivery summary is visible in status.

### M2 — `3c18c84`

- Files: `src/workflow-inbox.ts`, `src/workflow-status.ts`, `test/workflow-inbox.test.ts`, `docs/CONTEXT_AND_WORKFLOW_DESIGN.md`.
- Change: `<!-- ai-factory:... -->` comments only advance the cursor. Ordinary authorized prose increments a persisted counter, the status comment explains `/factory note`, and an applied human command resets the counter.
- Test: **factory comments do not revise presentation while approver observations are counted** proves a factory marker does not bump presentation while plain approver prose does and increments the counter.

### M3 — `2a9024c`

- Files: `src/workflow-scheduler.ts`, `test/workflow-scheduler.test.ts`.
- Change: the maintenance lookup now executes inside the same immediate transaction and mutation callback as execution creation and `QUEUED → RUNNING`.
- Test: **scheduler rechecks the maintenance barrier inside the scheduling transaction** injects a confirmed operation immediately before the transaction and proves scheduling throws with no execution row.

### M4 — `5749376`

- Files: `src/factory-command.ts`, `src/workflow-commands.ts`, `src/workflow-inbox.ts`, `test/factory-command.test.ts`, `test/workflow-inbox.test.ts`, `docs/CONTEXT_AND_WORKFLOW_DESIGN.md`.
- Change: `/factory pause` accepts `QUEUED`, `RUNNING` and `WAITING`, preserves open requests, and dispatches `interrupt(runId, "user-pause")` for a live run. Retry derives `WAITING` or `QUEUED` as before.
- Test: **pause preserves a waiting request and retry restores the human gate without a new attempt** proves a spec approval remains open through pause and retry restores `DESIGN/WAITING` without incrementing `attempt`. Parser coverage also asserts the exact pause command.

### L2 — `c5fa070`

- Files: `src/types.ts`, `src/results.ts`, `src/workflow-results.ts`, `test/results.test.ts`, `test/workflow-results.test.ts`.
- Change: Architect decisions accept optional `supersedes`, the provider schema validates it, and tactical record creation passes the ids to the existing record-level validation.
- Tests: **Architect results accept optional tactical supersession ids** validates the envelope; **a delivery decision routes through Architect and returns only to an allowed stage** now also proves the named earlier tactical decision becomes `superseded`.

### L3 — `433a67f`

- Files: `src/results.ts`, `src/workflow-results.ts`, `src/workflow-runner.ts`, `test/results.test.ts`, `test/workflow-runner.test.ts`.
- Change: `InvalidResultError` covers parse, coverage and result-contract failures; the runner classifies by error type instead of a message regex.
- Tests: **result contract failures use a typed error** covers parsing and coverage; **runner classifies failures by typed result errors rather than message text** proves ordinary provider text containing “result” remains `execution` while the typed error is `invalid-result`.

### L4 — `b073bc0`

- Files: `src/workflow-runner.ts`, `test/workflow-runner.test.ts`.
- Change: `scheduler.begin()` is inside the Reviewer context cleanup `try/finally`; a barrier refusal is rethrown without creating a workflow failure.
- Test: **reviewer context is cleaned when maintenance blocks scheduler begin** proves cleanup runs once and the item remains `REVIEW/QUEUED`.

## Not changed

- **H3:** no code or documentation change. The stated failure path is already prevented by transactional `supersedeSpec`; the existing transition row in §7.2 describes the implemented behavior.
- **L1:** no code or documentation change. Removing `completion.json` from retention cleanup would contradict §11 decision 12.

## Verification

- Baseline: `npm test` — **96 total, 96 pass, 0 fail**.
- H1 red test: `node --import tsx --test test/workflow-orchestrator.test.ts` — **3 total, 2 pass, 1 fail**; the historical cancel was replayed. After the fix, `npm test` — **97/97**.
- H2 red test: `node --import tsx --test test/workflow-inbox.test.ts` — **4 total, 3 pass, 1 fail**; the execution cancel control was not called. After the fix, `npm test` — **98/98**.
- M1 focused test passed. The first sandboxed full `npm test` reported **99 total, 97 pass, 2 fail** because the dashboard and Slack HTTP tests could not bind `127.0.0.1` (`EPERM`). The same command outside the restricted network sandbox passed **99/99**.
- M2 red test: `node --import tsx --test test/workflow-inbox.test.ts` — **5 total, 4 pass, 1 fail**; the marker comment incorrectly increased presentation revision. After the fix, `npm test` — **100/100**.
- After M3: focused scheduler tests **4/4**; `npm test` **101/101**.
- After M4: focused parser/inbox tests **9/9**; `npm test` **102/102**.
- After L2: focused results tests **11/11**; `npm test` **103/103**.
- After L3: focused results/runner tests **10/10**; `npm test` **105/105**.
- After L4: focused runner tests **4/4**; `npm test` **106/106**.
- Final: `npm run build` — passed (`tsc` and asset copy). `npm test` — **106 total, 106 pass, 0 fail, 0 skipped**. `git diff --check` — passed.
- No live GitHub or provider execution was performed; the validation used the repository's integration suites and fakes.

## Documentation

- **§5.4 Scope:** documents `/factory pause`, eligible states, request preservation and derived retry behavior.
- **§7.2 Transition table:** makes pause states and `interrupted/user-pause` explicit.
- **§7.6 Maintenance:** distinguishes issue-local pause from batch maintenance operations.
- **§8.2 Status comment:** documents the observed approver-comment counter, `/factory note` hint and factory-marker suppression.
- **§10 Cutover:** states that no importer or GitHub recovery path exists, manual start on a fresh data directory is the supported cutover, and initial cursor snapshotting prevents historical command replay.

§8.3 and §11 decisions 5, 9 and 12 were rechecked. They already describe the intended M1, L2 and L1 behavior, so no wording change was needed there.

## Open questions

None required for these fixes. M4 uses option (a), and the importer remains deliberately unscheduled per the clean-cutover decision.

# Issue state follow-ups — 2026-09-21

## Decisions recorded before implementation

- **F3.7 — agree.** `issueStateIndex` reconstructs markers only from local `agent.result` events and invents `result-spec-vN` when none exists. Adopted work has no source events, so its next index points to no GitHub comment and breaks a second continuation hop.
- **F3.8 — agree.** `WorkflowRunner.latestResult` reads only local events. Adopted state therefore loses the Reviewer pass needed by Delivery and the Tester evidence needed by Reviewer.
- **F3.9 — agree.** The no-local-item path rejects a valid state solely because its published instance name equals the current name. A reinstall commonly preserves that name while starting with an empty database, so the rule prevents recovery.

## Changes

### F3.7 — specification markers survive every continuation hop

- Commit: `499b6be` (`fix: F3.7 preserve specification markers across continuations`).
- `src/workflow-state.ts` stores adopted specification markers in work-item context, prefers those markers when rebuilding the state index, and refuses to invent a marker when neither persisted state nor a local result event identifies the published comment.
- `src/workflow-github.ts` stores the real marker after publishing a specification milestone. An incomplete state publishes the readable status without a payload and records `github.state_incomplete` once.
- `test/workflow-state.test.ts` verifies A → B → C continuation and return to A while keeping the original marker. `test/workflow-github.test.ts` verifies marker persistence and safe omission of an incomplete index.

### F3.8 — latest role evidence is portable

- Commit: `38d853e` (`fix: F3.8 preserve latest role results across continuations`).
- `src/workflow-state.ts` publishes and strictly validates one bounded `latestResults` entry per role, persists it when continuing, and lets later local events replace adopted evidence.
- `src/workflow-runner.ts` prefers local result events and falls back to adopted evidence. Delivery recreates its worktree when a continued item has no local `cwd`.
- `test/workflow-runner.test.ts` verifies that a continued Delivery retry reaches pull-request creation with the published Reviewer pass, a continued Review prompt includes Tester evidence, and a newer local Tester result wins over the adopted result.

### F3.9 — same-instance reinstall continues published work

- Commit: `56d664e` (`fix: F3.9 continue same-instance state after reinstall`).
- `src/workflow-orchestrator.ts` no longer treats the published instance name as proof that local state exists. With no local item, stable state is continued even when the preserved instance name matches; an existing local item remains the ownership boundary.
- `test/assignment-ownership.test.ts` verifies that a reinstall with the same instance name and an empty database adopts a stable item and resumes it on the next poll.

### Documentation

- Commit: `0647d01` (`docs: describe complete issue continuation state`).
- `docs/CONTEXT_AND_WORKFLOW_DESIGN.md` documents persisted specification markers, the bounded latest-result subset, local-result precedence, incomplete-state handling and same-instance reinstall continuation.
- `INSTALL.md` explains that reinstalling with the same `FACTORY_INSTANCE_NAME` and an empty data directory continues stable published state.

## Verification

- Before these fixes, the existing suite passed `235/235` after F3.7. The focused F3.8 tests initially exposed that Delivery had no local worktree after continuation; after the fix, the focused state/runner run passed `17/17`.
- `PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" npm test` outside the sandbox: `239` tests, `239` passed, `0` failed.
- An earlier sandboxed `npm test` run reported `233/238` with five `EPERM` failures from tests that bind `127.0.0.1`; the same tests passed on the required unrestricted run. This was an execution-environment restriction, not a retry of a flaky test.
- `PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" rm -rf dist && PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" npm run test:all`: exit `0`; unit/integration suite `239/239`, clean TypeScript build, and all macOS script suites passed.
- `git diff --check`: exit `0`, no whitespace errors.

## Limitations

- No live GitHub issue was mutated. GitHub publication, continuation hops and ownership reconciliation were exercised through the repository's real workflow modules and deterministic fake ports.
- Remotely `RUNNING` or `QUEUED` state still requires the existing explicit **Continue anyway** action; this round changes only stable-state continuation and evidence completeness.

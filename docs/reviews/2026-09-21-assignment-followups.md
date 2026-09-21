# Assignment ownership follow-ups

## F2.8 — Reassigning after an unassignment never resumes

**Decision: agree.** An assigned issue with a local non-terminal work item and no instance label fell through to `pauseOwned(..., "moved")`; because the item was already paused after unassignment, subsequent polls neither claimed nor resumed it.

Changed:

- `src/workflow-orchestrator.ts` now claims an assigned local non-terminal item with no instance label, records `issue.claimed`, and waits for the next poll before resuming.
- `test/assignment-ownership.test.ts` now proves that unassign → reassign → two polls restores the own label, queues the item and increments the attempt. It also proves that when the second installation claims first, the original installation stays paused and reports `other-instance`.
- `docs/GITHUB_SETUP.md` and `INSTALL.md` now state that reassignment alone is enough; the Factory restores the instance label.

Commit: `b718f2f` (`fix: F2.8 resume reassigned work automatically`).

## F2.9 — Terminal items call GitHub on every poll

**Decision: agree.** Both terminal release paths called `unassign` and `removeLabel` without durable evidence that release had already happened.

Changed:

- `src/workflow-orchestrator.ts` records `context.releasedAt` after releasing assignment and the own instance label, and skips subsequent release calls from either reconciliation path.
- `test/assignment-ownership.test.ts` polls a cancelled open issue three times and asserts exactly one `unassign`, one `removeLabel`, and a stored `releasedAt`.

Commit: `0f50d58` (`fix: F2.9 release terminal ownership once`).

## F2.10 — Small defects

**Decision: agree.** The existing ternary selected `moved` in both branches, so a simultaneous local and foreign instance claim was reported as a move. The ownership test also hardcoded `/usr/bin/git` instead of honoring the configured Git command.

Changed:

- `src/workflow-orchestrator.ts` pauses a locally owned item with `claim-conflict` and summary `Another Factory instance also claims this issue` when another instance label is present. Restoring the sole own label resumes `claim-conflict` in the same way as `unassigned` and `moved`.
- `test/assignment-ownership.test.ts` asserts the conflict code and summary, restoration after the conflict, and uses `config.gitCommand` without replacing it with a machine-specific path.
- `docs/CONTEXT_AND_WORKFLOW_DESIGN.md` §7.2 now includes the claim-conflict pause and its resume transition.

Commit: `e204d53` (`fix: F2.10 distinguish assignment claim conflicts`).

## Verification

- Baseline `npm test` inside the restricted sandbox could not run correctly because loopback listeners were denied (`listen EPERM 127.0.0.1`); 221 of 226 tests passed and five network-bound tests failed for that environment reason. The same unchanged baseline dependencies were then used outside the restricted sandbox for all authoritative runs.
- After F2.8: `node --import tsx --test test/assignment-ownership.test.ts` — 1 passed, 0 failed. `npm test` — 226 passed, 0 failed.
- After F2.9: `node --import tsx --test test/assignment-ownership.test.ts` — 1 passed, 0 failed. `npm test` — 226 passed, 0 failed.
- After F2.10: `node --import tsx --test test/assignment-ownership.test.ts` — 1 passed, 0 failed. `npm test` — 226 passed, 0 failed.
- Final macOS clean-build gate: `rm -rf dist && npm run test:all` — 226 unit/integration tests passed, 0 failed; TypeScript build completed; all six script suites printed `PASS` (macOS installer, maintenance, uninstall, configure, dashboard config, installation validation).
- `git diff --check` — clean.

No test was skipped, disabled, loosened or retried after a product failure.

## Limitations

The isolated worktree did not contain its own `node_modules`; it reused the already installed dependency tree from the main checkout through a local ignored symlink. The final clean-build gate rebuilt `dist/` and exercised the complete macOS script suite. No remote GitHub live check was performed; ownership behavior is covered by the shared two-instance fake and local bare Git repository.

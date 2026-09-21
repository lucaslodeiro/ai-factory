# Code always on GitHub review

## Decisions

- **F1.1 — agree.** The random suffix made the same GitHub issue resolve to different branches on different installations. The existing worktree logic could already restore a remote-only branch, so a deterministic name was the minimal fix.
- **F1.2 — agree.** Builder and Tester commits were durable only on the Factory host until Delivery. Publishing each commit with the existing non-force refspec closes that loss window. A publication failure remains recoverable and must not discard a valid stage result.
- **F1.3 — agree.** The runner did not incorporate human work-branch commits or newer base commits before invoking an agent. Merge-based synchronization preserves both sides and makes conflicts explicit without destructive resolution.
- **F1.4 — agree.** A pass without its verified commit could become stale silently. Keeping the SHA in work-item context avoids a schema change and lets Review and Delivery return changed code to Test.
- **F1.5 — agree.** Branch durability depends on never overwriting human commits. A source guard makes that invariant visible and executable.

## Changes

### F1.1 — `1d36fce`

- `src/workflow-inbox.ts` now assigns `factory/issue-<number>`.
- `test/workflow-inbox.test.ts` checks the deterministic name and reuse after an archived item for a recreated issue.
- `test/workspaces.test.ts` checks restoration when the branch exists only in a bare origin.

### F1.2 — `a750fb9`

- `src/workflow-runner.ts` publishes after every Builder and Tester commit through `publishAsync`. It records `workflow.push_failed` with sanitized evidence and still applies the agent result when the push fails.
- `test/workflow-runner.test.ts` checks invocation, result preservation and removal of credentials from failure evidence.
- `test/workspaces.test.ts` exercises asynchronous publication against a bare origin and verifies its branch head.

### F1.3 — `a670d00`

- `src/worktrees.ts` adds `Workspaces.sync` and `SyncConflictError`. Synchronization commits interrupted dirt, fetches the work and base branches, merges new commits, aborts conflicts and reports their file names.
- `src/workflow-runner.ts` synchronizes before every agent execution and before Delivery publication. Preparation conflicts become integration failures and Retry runs synchronization again.
- `test/workspaces.test.ts` uses bare origins to verify work-branch merges, base merges, preserved interrupted files, conflict reporting and a clean post-abort worktree.
- `test/workflow-runner.test.ts` checks integration classification and successful preparation after Retry.
- `test/git-safety.test.ts` rejects destructive conflict-resolution commands in `src/` and `scripts/`.

### F1.4 — `45f74ed`

- `src/workflow-results.ts` records `context.verifiedHeads.TEST` or `.REVIEW` inside the successful result transition.
- `src/workflow-runner.ts` passes the actual post-commit HEAD and returns stale Review or Delivery work to `TEST/QUEUED` with reason `code-changed`.
- `test/workflow-results.test.ts` checks the exact Tester and Reviewer SHAs.
- `test/workflow-runner.test.ts` checks that changed code returns to Test once, the new Tester pass replaces the SHA, and unchanged code proceeds to Reviewer.
- `docs/CONTEXT_AND_WORKFLOW_DESIGN.md` §7.2 records the new invalidation transition.

### F1.5 — `bd4c5c8`

- `test/git-safety.test.ts` scans Git command arrays and shell commands and rejects `--force`, `--force-with-lease` or `-f` when publishing under `refs/heads/`.

### Operator documentation — `292b103`

- `README.md` summarizes deterministic branches, continuous publication, merge synchronization, conflict handling and verification invalidation.
- `INSTALL.md` explains the same behavior and the operator action for conflicts.

## Verification

- After F1.1, `npm test`: **220 tests, 220 passed, 0 failed**.
- After F1.2, focused command `node --import tsx --test test/workflow-runner.test.ts test/workspaces.test.ts`: **9 tests, 9 passed**. The first full run inside the restricted sandbox produced **221 tests, 216 passed, 5 failed** because macOS denied test listeners on `127.0.0.1` with `EPERM`; the same tests passed when run with local-port access in all subsequent full runs.
- After F1.3, `npm test`: **225 tests, 225 passed, 0 failed**.
- After F1.4, `npm test`: **227 tests, 227 passed, 0 failed**.
- After F1.5, `npm test`: **228 tests, 228 passed, 0 failed**.
- Final `rm -rf dist && npm run test:all` on macOS: unit/integration suite **228 tests, 228 passed, 0 failed**; build completed; script suites printed PASS for installer, maintenance/update, uninstall, configure, dashboard configuration and installation validation.
- Final `git diff --check`: clean.

No flaky test was retried into green. The only failed run was the explicitly reported sandbox networking limitation above.

## Limitations

- The work remains on `feat/code-on-github`; it was not pushed, merged, tagged or submitted as a pull request.
- No live GitHub repository was modified. Git behavior was verified against disposable bare origins.

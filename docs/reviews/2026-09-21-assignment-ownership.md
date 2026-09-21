# Assignment ownership review

## Decisions

- **F1.6 — agree.** Preserving interrupted work must apply the same secret and role path policies as a completed run.
- **F1.7 — agree.** A temporary fetch failure must be observable but must not turn an otherwise runnable local stage into a workflow failure.
- **F1.8 — agree.** The source guard must recognize the array argument form used by the Git helpers.
- **F2.1 — agree.** A stable, label-safe instance name is required after the earlier lease/instance model was removed.
- **F2.2 — agree.** GitHub assignment is the intake boundary, and repository-wide issue/comment scans plus `/factory start` are removed.
- **F2.3 — agree.** Claiming is a two-poll operation; conflicts and foreign published state stop execution.
- **F2.4 — agree.** Unassignment and label movement pause and preserve work; reassignment resumes; terminal work releases GitHub ownership.
- **F2.5 — agree.** Dashboard and CLI actions now manipulate assignment and instance labels, while KPIs remain local.
- **F2.6 — agree.** Mutable and milestone issue content identifies its originating instance.
- **F2.7 — agree.** Multi-installation behavior needs one shared-GitHub, real-remote integration test.

## Changes

### F1.6 — `ed65939`

`src/worktrees.ts` validates dirty paths by role before creating a work-in-progress commit; `src/workflow-runner.ts` passes the prepared role. `sync enforces the prepared role policy before preserving interrupted work` verifies secrets, Architect/Reviewer dirt and Tester path boundaries, while allowing Builder work.

### F1.7 — `b2ad744`

`src/worktrees.ts` returns a skipped synchronization result for unavailable fetches and `src/workflow-runner.ts` records sanitized `workflow.sync_skipped` evidence. `a fetch failure skips remote synchronization without failing the execution` verifies the local stage still runs.

### F1.8 — `84b9e12`

`test/git-safety.test.ts` detects destructive Git operations expressed as argument arrays as well as shell-like strings. `workflow synchronization never uses destructive conflict resolution` names the prohibited pre-production safety invariant.

### F2.1 — `6e4a3b8`

`src/config.ts`, `.env.example`, dashboard settings/header and Doctor add normalized `FACTORY_INSTANCE_NAME`, defaulting to the hostname. `instance names are label-safe, bounded and never empty` covers normalization and fallback.

### F2.2 — `7dca029`

`src/adapters/github.ts`, the GitHub worker/runtime and daemon add authenticated-account and paginated assigned-issue APIs. Repository-wide issue/comment discovery, start hints and `/factory start` parsing/help/tests were removed. The daemon refuses startup without an authenticated login and publishes it in runtime metadata. `GitHub discovers only open assigned issues and excludes pull requests` covers the adapter query and filtering.

### F2.3 — `5d841b8`

`src/workflow-orchestrator.ts` creates the fixed instance label, claims unlabelled assigned issues without starting them, verifies the surviving label on the next poll, and records idempotent conflict/continuation events. `assignment claim waits one poll, then starts; conflicts and foreign status wait` covers all four states.

### F2.4 — `5e456e1`

`src/workflow-orchestrator.ts` pauses moved/unassigned work, interrupts active execution, waits for shutdown, preserves through `WorkflowRunner.preserve`, resumes only from ownership pauses and releases completed/cancelled issues. `unassignment pauses and preserves local work; reassignment resumes; terminal work releases ownership` covers the state transitions and cleanup.

### F2.5 — `eb925f4`

`src/dashboard.ts`, `dashboard/app.js`, `src/cli.ts` and `src/daemon.ts` make Add Issue/start-issue assign and label the issue, add `claim-issue`/Work here, and render local, foreign, conflict and unclaimed ownership. `moving work replaces foreign instance labels in one issue edit`, dashboard control coverage and the unified issue list test cover the operator surface. `src/workflow-github.ts` no longer assigns configured approvers for waiting states.

### F2.6 — `872f4e7`

`src/workflow-status.ts` adds the Instance row. `src/workflow-github.ts` adds `<sub>instance:<name></sub>` to mutable status and milestone comments. Issue-content and publisher tests assert both surfaces.

### F2.7 — `dbe95e0`

`test/assignment-ownership.test.ts` runs two orchestrators over one shared GitHub fake and one bare Git origin. It verifies simultaneous claim conflict, sole-label start, movement, pause, work-in-progress commit and push, reassignment with attempt increment, and terminal release.

### Documentation — `5eae9cb`

`README.md`, `INSTALL.md`, `docs/GITHUB_SETUP.md` and `docs/CONTEXT_AND_WORKFLOW_DESIGN.md` describe assignment ownership, instance labels, new transitions and attribution. Obsolete controller/ownership design documents were deleted. `docs/reviews/2026-09-21-lease-removal.md` records `0e40fbc`, `bd579eb`, `0bc9208` and `979f54e` and the tests retained by those changes.

## Verification

- Baseline `npm test`: **228 passed, 0 failed**.
- `npm test` after F1.6: **229 passed, 0 failed**.
- `npm test` after F1.7/F1.8: **230 passed, 0 failed**.
- `npm test` after F2.1: **231 passed, 0 failed**.
- Intermediate full suites stayed green after each ownership item; obsolete repository-scan tests were removed with the feature, and focused ownership coverage was added.
- Final `rm -rf dist && npm run test:all` on macOS: unit suite **226 passed, 0 failed**; installer, maintenance, uninstall, configure, dashboard-config and installation-validation script suites all printed `PASS`.
- Final `npm run build`: TypeScript compilation and dashboard asset copy succeeded.
- Final `git diff --check`: clean.

During development one sandboxed run failed because local loopback listeners were denied with `EPERM`; the required macOS runs were performed outside that sandbox. One intermediate full run exposed missing ownership methods in test fakes; those fixtures were corrected before the green runs. No flaky test was retried into green without recording its cause.

## Limitations

Cross-installation context import is intentionally outside this round. If an assigned issue already has a Factory status marker but no local work item, the installation reports **continuation pending** and does not start it. SQLite history remains local to each installation.

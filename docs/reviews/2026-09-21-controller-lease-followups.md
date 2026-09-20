# Controller lease follow-up review

## Decisions recorded before changes

- **Q1 — agree.** The daemon fence calls `ControllerLease.assertController`, which performs `ls-remote`, `fetch` and `cat-file`. This contradicts the ten-minute uncertainty model and makes normal workflow mutations depend on a live network round trip.
- **Q2 — agree.** Both v2 discovery cursors begin at epoch zero and neither path excludes issues carrying `factory:*` labels. A fresh controller can therefore import work that the previous controller processed, contradicting the explicit takeover boundary.
- **Q3 — agree, preferred portable fix.** `uninstall.mjs` calls `launchctl` only on Darwin while the test always expects its stub log. An explicit test-only opt-in keeps both script gates portable without pretending Linux has launchd.
- **Q4 — agree.** The installer suite obtains an empty branch in detached HEAD, and its retry PATH includes machine-specific Homebrew paths. Pull-request validation can fail before checking product behavior.
- **Q5 — agree.** `readOrCreateInstance()` defaults to the developer checkout and the root `.gitignore` does not exclude `instance.json`; tests that omit an explicit home leave an untracked file.
- **Q6 — agree.** The v1 branch-based specification contradicts the implemented custom-ref protocol. The current standby loop rereads an absent ref but deliberately remains standby until explicit acquisition or restart; the documentation is ambiguous about that outcome.
- **Q7 — agree.** The out-of-series changes are material operator behavior and need a durable review record. `prepareRepository` and environment seeding also need explicit installation documentation.

## Q1 — Local mutation fence

`src/controller-runtime.ts` now owns the local fence assertion, and `src/daemon.ts` compares only controller mode, cached generation and the generation acquired or last renewed. Remote reads remain in renewal and explicit CLI lease operations. `docs/REPOSITORY_CONTROLLER_LEASE.md` records that split.

Tests `a transient renewal read failure leaves the next tick active before the uncertainty deadline` and `daemon mutation fence is local and rejects only mode or cached-generation changes` cover the behavior. Commit: `c47bdcd`.

## Q2 — Historical discovery ownership boundary

`src/workflow-orchestrator.ts` marks an initial comment scan as historical. Historical start comments and every description start on issues carrying a `factory:*` label are audited once as `command.rejected` with reason `already processed by a controller`, without public hint or local workflow creation. After that historical scan, a newly posted authorized `/factory start` comment may explicitly reclaim the issue. Unlabelled historical starts retain their previous behavior.

Tests `historical discovery skips controller-labelled issues but accepts an unlabelled start`, `a fresh start comment can reclaim a controller-labelled issue after historical discovery`, and the extended two-factory end-to-end scenario cover the boundary. Commit: `304c6de`.

## Q3 — Portable uninstall gates

`scripts/uninstall.mjs` executes its launchctl path on Darwin by default or on any platform when `AI_FACTORY_UNINSTALL_LAUNCHCTL=1`. `scripts/test-uninstall.mjs` sets that explicit flag, so its stub and assertions run identically on Linux and macOS. Commit: `d7f1cd0`.

## Q4 — Detached-head installer validation

`scripts/test-macos-installer.sh` derives the fixture branch from `GITHUB_HEAD_REF` or `git rev-parse --abbrev-ref HEAD`. A detached checkout creates a temporary local branch at the tested commit and deletes it in the exit trap. The retry fixture builds `PATH` from the active Node and Git executables rather than host-specific Homebrew directories.

The suite passed both on the review branch and from a separate detached worktree at `95365e5`. Commit: `95365e5`.

## Q5 — Developer checkout identity hygiene

`.gitignore` excludes developer-checkout `instance.json`. The doctor test that reaches controller construction now supplies a temporary controller home and local remote, and asserts that the checkout root remains untouched. The focused controller/home tests passed 17/17 and the full suite left no `instance.json`. Commit: `127ceda`.

## Q6 — Specification housekeeping

Deleted `docs/REPOSITORY_CONTROLLER_LEASE_SPEC.md`, the superseded branch-based v1 design, and corrected `ARCHITECTURE.md` to link to the implemented v2.2 specification. `docs/REPOSITORY_CONTROLLER_LEASE.md` §12 and `INSTALL.md` now state that standby rereads every two minutes for visibility but remains standby when the ref disappears until explicit acquire or daemon restart. Commit: `ced2db0`.

## Q7 — Out-of-series changes

Added `docs/reviews/2026-09-21-out-of-series-fixes.md` with motivation, change and coverage for every commit in the requested ancestry range. Git contains fourteen commits in that range, not twelve, so all fourteen are recorded. `INSTALL.md` now explicitly describes target cloning and empty-remote bootstrap at daemon start, plus fresh `.env` seeding from exported `FACTORY_*` and `GITHUB_*` values. No behavior changed. Commit: `dbbc372`.

## Verification

- `PATH=/Users/lucaslodeiro/.local/bin:$PATH npm test` — 209 tests, 209 passed, 0 failed after rebasing onto the current remote `main`.
- `rm -rf dist && PATH=/Users/lucaslodeiro/.local/bin:$PATH npm run test:all` on macOS — product suite 206/206; build and all script gates completed. The installer gate printed `PASS: user-local preflight, verified tool installation, non-interactive providers and argument forwarding`; the remaining gates were also rerun directly and printed PASS for maintenance, uninstall, configure and dashboard configuration.
- Detached-head reproduction: a temporary detached worktree at `7bf894d` ran `scripts/test-macos-installer.sh` successfully and removed its temporary fixture branch.
- Linux arm64 container, Node 22: `node scripts/test-uninstall.mjs` printed its PASS line and `uninstall-exit=0`; `node scripts/test-maintenance.mjs` printed its PASS line and `maintenance-exit=0`.
- `git status --porcelain` immediately after `npm test` contained only the in-progress review document and the local `node_modules` worktree symlink; `instance.json` was absent. After removing the symlink and committing this report, the worktree was clean.
- `PATH=/Users/lucaslodeiro/.local/bin:$PATH npm run build` — passed.
- `git diff --check` — passed.
- After the owner authorized publication, GitHub Actions **Product validation** passed on both [`main`](https://github.com/lucaslodeiro/ai-factory/actions/runs/35530336834) and [`develop`](https://github.com/lucaslodeiro/ai-factory/actions/runs/35530336347) at `36757e3`. This confirms the detached-checkout installer gate in the hosted macOS runner.

## Limitations

No pull request was opened. Before publication, the detached-HEAD condition was reproduced locally with the complete macOS installer suite; the later branch pushes also passed their hosted macOS workflows. An initial sandboxed `npm test` run could not bind the dashboard test server (`listen EPERM`) and reported 204/206; it was rerun once outside the network sandbox and passed 206/206. This was an environment restriction, not a flaky test or product failure.

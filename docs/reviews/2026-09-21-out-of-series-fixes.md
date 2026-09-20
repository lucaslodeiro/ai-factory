# Out-of-series fixes review — 2026-09-21

The requested range from `0a99e8a` through `7dd2603` contains fourteen commits, rather than twelve. This record includes every commit in ancestry order so no published change is left undocumented.

## `0a99e8a` — isolate dashboard test factory home

**Motivation.** Installer validation exports its destination as `AI_FACTORY_HOME`, which made the dashboard test read another installation's logs.

**Change.** `test/dashboard.test.ts` gives the test its own temporary factory home and restores the caller's environment.

**Coverage.** `dashboard serves readable state and queues daemon controls` exercises the isolated log and settings paths.

## `ec99ace` — explain installer validation isolation

**Motivation.** A failed installation validation preserved an incomplete engine without explaining that tests run under the destination home.

**Change.** `INSTALL.md` and the home-layout follow-up review document the validation environment, marker timing, retained logs and retry path.

**Coverage.** Documentation-only; the behavior is covered by `scripts/test-macos-installer.sh` and `scripts/test-maintenance.mjs`.

## `f95e0f1` — seed fresh install from exported settings

**Motivation.** A reinstallation with no saved `.env` could appear preconfigured in the invoking shell but lose those values when the service started.

**Change.** `scripts/initialize-environment.mjs` imports recognized exported keys into a new `.env`, validates them, and preserves any existing file.

**Coverage.** `scripts/test-maintenance.mjs` verifies recognized values are imported; the installer fixture supplies built settings validation.

## `9f6858e` — stop existing services during install and uninstall

**Motivation.** Old daemon, dashboard and updater processes could survive file replacement and keep operating stale code.

**Change.** Install and uninstall stop every AI Factory LaunchAgent and verify it is unloaded before continuing.

**Coverage.** `scripts/test-macos-installer.sh` checks normal and stubborn services; `scripts/test-uninstall.mjs` checks daemon, dashboard and updater removal.

## `7f035ee` — specify repository controller lease

**Motivation.** Separate factory homes could process the same repository concurrently.

**Change.** Added the first controller-lease design for review. It was later superseded by the implemented v2.2 document.

**Coverage.** Documentation-only at that commit; implementation coverage is recorded in `docs/reviews/2026-09-21-controller-lease.md`.

## `2f3e3df` — keep unconfigured daemon unloaded after install

**Motivation.** The installer loaded a daemon that could not work until required setup was complete.

**Change.** A not-ready installation leaves the daemon unloaded after starting the dashboard.

**Coverage.** `scripts/test-maintenance.mjs` asserts the unconfigured daemon remains stopped.

## `e472d9d` — verify service lifecycle operations

**Motivation.** Service commands could report success before launchd reached the requested state.

**Change.** `scripts/services.sh` waits for start, stop and restart outcomes and prints actionable failures.

**Coverage.** `test/services.test.ts` exercises successful transitions and launchd state failures.

## `293dfd8` — preserve purge after basic uninstall

**Motivation.** Basic uninstall preserved configuration and repositories but removed the only convenient command that could later purge them.

**Change.** It keeps a minimal uninstall helper and launcher until `uninstall --purge` removes the remaining home.

**Coverage.** `scripts/test-uninstall.mjs` performs basic uninstall followed by purge; launcher help and service routing are covered by `test/services.test.ts`.

## `c4041ab` — prepare target repository and discover historical start commands

**Motivation.** A fresh install required a manually prepared clone and could miss `/factory start` posted while the daemon was offline.

**Change.** Daemon startup prepares or clones the target, bootstraps an empty remote, and discovery begins from repository history before becoming incremental.

**Coverage.** `test/repository-setup.test.ts` covers clone, empty-remote bootstrap, retry and safety refusals; workflow orchestrator tests cover historical issue and comment discovery.

## `cf555b3` — require decision supersedes in structured output schemas

**Motivation.** The runtime accepted tactical decisions without the field needed to identify replaced decisions.

**Change.** Agent result schemas and prompts require `supersedes` for decision output while accepting an omitted field from older provider envelopes as an empty list at the parse boundary.

**Coverage.** `test/results.test.ts` and adapter tests validate the structured result contract.

## `b1d999d` — separate product tests from installation and update validation

**Motivation.** Installer/update validation recursively ran platform suites and mixed product failures with packaging failures.

**Change.** Added a bounded installation validator, separated `test` from `test:all`, and introduced the macOS validation workflow.

**Coverage.** `scripts/test-installation-validation.mjs`, `scripts/test-macos-installer.sh`, `scripts/test-maintenance.mjs` and adapter configuration tests exercise the split.

## `1172ad3` — keep daemon stopped after failed update activation

**Motivation.** A candidate that failed activation could accidentally restore the daemon even though the update did not complete.

**Change.** Added regression coverage that a failed activation leaves the daemon stopped.

**Coverage.** The added scenario in `scripts/test-maintenance.mjs` asserts the post-failure service state.

## `b8a37b0` — reconnect background dashboard polls quietly during updates

**Motivation.** Expected dashboard restarts produced misleading API-unavailable toasts from background requests.

**Change.** All background polling shares interruption-aware fetch handling and preserves the last useful UI while reconnecting.

**Coverage.** `test/dashboard-reconnection.test.ts` covers reload, transport failure, HTTP failure, interrupted bodies and recovery.

## `7dd2603` — recover abandoned update barriers blocking queued work

**Motivation.** Repeated update preparation could leave an earlier maintenance barrier active and permanently block queued work.

**Change.** Finished update state reconciles older abandoned barriers; confirmation rejects another active maintenance operation; the dashboard prevents duplicate preparation clicks.

**Coverage.** `test/update-maintenance.test.ts`, `test/workflow-maintenance.test.ts` and `test/dashboard-reconnection.test.ts` cover reconciliation, exclusion and click deduplication.

## Operator documentation

`INSTALL.md` now states that daemon startup clones the configured target when absent and bootstraps an empty remote with a README and base-branch push. It also states that a fresh `.env` imports recognized exported `FACTORY_*` and `GITHUB_*` settings, while an existing file remains authoritative.

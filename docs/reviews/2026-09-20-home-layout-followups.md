# Home layout follow-up review

## Decisions recorded before implementation

- **O1 — agree.** The retry hints move `engine/` to `engine.incomplete-<timestamp>` inside the home, while the destination guard rejects that entry and marker-less `data/`. I will accept `engine.incomplete-*` and marker-less `data/`, preserving failure evidence and keeping the documented retry command valid.
- **O2 — agree.** Purge validates the home itself but does not prove that the recognized engine is contained by that home, so an overridden `AI_FACTORY_HOME` can broaden deletion beyond the installation.
- **O3 — agree.** Both the readiness probe and daemon start are nested under the browser-opening condition, so `AI_FACTORY_NO_OPEN=1` suppresses daemon startup for a ready preserved configuration.
- **O4 — agree.** Managed-repository purge checks invoke literal `git`, unlike the work-item publication check, which uses `GIT_COMMAND` from the saved environment.
- **O5 — agree.** The npm `configure` script has no pre-script build even though `configure.mjs` imports from `dist/`; a fresh developer checkout therefore needs an undocumented manual build.

## O1 — Installer retry leftovers

**Agree.** I chose the first proposed fix. `scripts/install-core.sh` now accepts directories named `engine.incomplete-*` and a `data/` directory only when `data/install.json` is absent. All other unexpected entries remain rejected. `scripts/install-macos.sh` now preserves `--branch` and `--repo` in its retry command, matching the already complete hint from `install-core.sh`.

Evidence is in `scripts/test-macos-installer.sh` and `scripts/test-maintenance.mjs`: both hint forms are asserted, the tests preserve an incomplete engine plus `data/service-logs/`, rerun the installer and require a new `engine/` and `data/install.json` without deleting the leftovers. Commit: `408c5e2` (`fix: O1 accept installer retry leftovers`).

## O2 — Purge containment guard

**Agree.** `scripts/uninstall.mjs` now refuses `--purge` unless the recognized engine is the factory home or its immediate `engine/` child. It compares real paths so macOS aliases such as `/var` and `/private/var` do not cause false refusals. The error names both the engine and requested home.

`scripts/test-uninstall.mjs` sets a mismatched `AI_FACTORY_HOME`, runs `--purge --yes --force`, and asserts that both the real engine and a sentinel under the mismatched home remain. Commit: `7f3dd97` (`fix: O2 constrain purge to installation home`).

## O3 — Daemon start without browser opening

**Agree.** `scripts/install-core.sh` now probes `/api/settings` and starts the daemon before deciding whether to call macOS `open`. `AI_FACTORY_NO_OPEN=1` suppresses only browser opening; it no longer suppresses daemon startup or changes the setup suffix decision.

`scripts/test-maintenance.mjs` starts a ready loopback dashboard fixture, installs with `AI_FACTORY_NO_OPEN=1`, asserts `start dashboard` followed by `start daemon`, and verifies that no additional URL was opened. Commit: `4210913` (`fix: O3 start ready daemon without opening browser`).

## O4 — Configured Git in repository preflight

**Agree.** `scripts/uninstall.mjs` resolves `GIT_COMMAND` once and uses it for active-work publication checks and for both managed-repository commands: `status --porcelain` and `log --branches --not --remotes --oneline`.

`scripts/test-uninstall.mjs` clears the configured Git stub's log before purge and asserts that both repository-preflight commands pass through that stub. Commit: `3db04ef` (`fix: O4 use configured git for purge preflight`).

## O5 — Developer configure build prerequisite

**Agree.** `package.json` now defines `preconfigure: npm run build`, so `npm run configure` works from a fresh developer checkout. The installed `ai-factory configure` launcher remains unchanged and does not rebuild. `INSTALL.md` documents that distinction in the terminal recovery section.

The focused check removed `dist/`, ran `npm run configure -- --help`, observed `preconfigure` execute the build, printed the configurator usage and confirmed `dist/src/dashboard-settings.js` existed. Commit: `32a36bf` (`fix: O5 build before developer configure`).

## Verification

Baseline, before implementation:

```text
PATH=/usr/local/Cellar/node/26.4.0/bin:/usr/local/git/bin:$PATH npm test
tests 149; pass 149; fail 0; skipped 0
```

Final code suite:

```text
PATH=/usr/local/Cellar/node/26.4.0/bin:/usr/local/git/bin:$PATH npm test
tests 149; pass 149; fail 0; skipped 0
```

Fresh-build macOS gate:

```text
rm -rf dist && PATH=/usr/local/Cellar/node/26.4.0/bin:/usr/local/git/bin:$PATH npm run test:all
tests 149; pass 149; fail 0; skipped 0
PASS: user-local preflight, verified tool installation, non-interactive providers and argument forwarding
PASS: dashboard-first install, existing destination, fast-forward, config/worktree preservation, backup, dirty checkout, daemon lock, local-only commit, persisted update state and dashboard availability.
PASS: basic uninstall preserves configuration and repos; purge preflights dirty clones and removes the complete home only with force
```

Focused developer-checkout check:

```text
rm -rf dist && PATH=/usr/local/Cellar/node/26.4.0/bin:/usr/local/git/bin:$PATH npm run configure -- --help
> ai-factory@0.2.0 preconfigure
> npm run build
Usage: ai-factory configure [--defaults]
```

The throwaway retry lifecycle used a temporary `HOME`, `AI_FACTORY_SKIP_SERVICES=1`, `AI_FACTORY_NO_OPEN=1`, `AI_FACTORY_INSTALL_TESTS=0`, this checkout as `--repo`, and `fix/home-layout-followups` as `--branch`. After the first install I removed the final marker to model an interrupted install, created `data/service-logs/`, obtained this hint, executed its `mv` and retry command verbatim, and received a successful installation:

```text
Preserve it and retry with:
  cd "/var/folders/74/0s5tj_ms4d5gdnfcf3l9ds_m0000gn/T/tmp.qqbdNDrhFE/ai-factory"
  mv "/var/folders/74/0s5tj_ms4d5gdnfcf3l9ds_m0000gn/T/tmp.qqbdNDrhFE/ai-factory/engine" "/var/folders/74/0s5tj_ms4d5gdnfcf3l9ds_m0000gn/T/tmp.qqbdNDrhFE/ai-factory/engine.incomplete-20260920-113034"
  bash /tmp/ai-factory-install-macos.sh --dir "/var/folders/74/0s5tj_ms4d5gdnfcf3l9ds_m0000gn/T/tmp.qqbdNDrhFE/ai-factory" --branch "fix/home-layout-followups" --repo "/Users/lucaslodeiro/Source/ai-factory"
```

Resulting top-level layout:

```text
.env
data/
data/install.json
data/service-logs/
engine/
engine.incomplete-20260920-113034/
```

Final whitespace verification:

```text
git diff --check
(no output; exit 0)
```

No test was retried to turn a flaky result green. One initial sandboxed invocation of `scripts/test-maintenance.mjs` could not bind its loopback fixture (`listen EPERM`); the same command was then run once with the required local-loopback permission and passed. The machine's default `npm` belongs to an obsolete Node runtime and failed before running tests with `Cannot find module 'node:path'`, so every reported npm verification explicitly used the installed Node 26 toolchain. The manual lifecycle used a temporary `curl` shim to serve the current unpushed branch's `install-core.sh` to the public bootstrap script; all filesystem guards, hint arguments and retry commands were the real scripts under review.

## Limitations

The lifecycle did not contact GitHub for the then-unpushed review branch; it cloned the local repository and kept all generated state under a temporary home. The completed review was subsequently published to `main` and `develop` at `2fbae63`.

## Post-publication installer validation fix

An installation from `main` exposed an environment-dependent test failure after the review: the installer correctly exported its destination as `AI_FACTORY_HOME`, but `test/dashboard.test.ts` wrote daemon-log fixtures under its own temporary settings root without overriding that inherited home. The dashboard endpoint therefore read the installation home's logs and returned an empty fixture result. This affected only the test harness; installed dashboard path resolution was correct.

Commit `0a99e8a` (`fix: isolate dashboard test factory home`) makes the dashboard test set `AI_FACTORY_HOME` to its temporary root and restore the caller's value in `finally`. The failure was reproduced before the change with an external temporary `AI_FACTORY_HOME`, then the isolated test passed `1/1` and the complete suite passed `149/149` under the same inherited-variable condition. `INSTALL.md` now states that installer validation runs with the destination home active and that a failure preserves the incomplete engine and logs for the printed retry flow.

# Installer polish review

Date: 2026-09-20  
Branch: `fix/installer-polish`  
Starting revision: `8c82bbf` (current `main`, later than `9749342`)

## L1 — `services.sh uninstall` rejects `--force`

**Decision: agree.** `scripts/services.sh` accepted only zero arguments or one `--yes`, even though the public launcher advertised `--force` and `scripts/uninstall.mjs` already owned validation for both supported flags.

Commit: `bb2eadc` (`fix: L1 forward uninstall force option`)

Changes:

- `scripts/services.sh` now documents `uninstall [--yes] [--force]` and forwards all uninstall arguments unchanged to `scripts/uninstall.mjs`.
- `scripts/test-uninstall.mjs` invokes the service wrapper against a stub uninstaller and asserts that `--yes --force` reaches it exactly. The fixture cannot remove a real installation.

Evidence: an additional throwaway installation ran the exact public command and printed:

```text
> bash scripts/services.sh uninstall --yes --force
mock uninstall.mjs reached with: --yes --force
```

## L2 — `test:scripts` depends on `dist/` without building it

**Decision: agree.** `scripts/test-macos-installer.sh` invokes `scripts/ai-factory help`, which executes `dist/src/cli.js`, while `test:scripts` previously had no build lifecycle hook.

Commit: `f6387df` (`fix: L2 build before script tests`)

Change: `package.json` adds `pretest:scripts: npm run build`. `test:all` still contains no second explicit build; npm runs the lifecycle hook when it reaches `test:scripts`.

Evidence: after deleting `dist`, `npm run test:all` ran `npm test`, then `pretest:scripts`, rebuilt with `tsc && node scripts/copy-assets.mjs`, and completed `test:scripts`.

## L3 — `test-macos-installer.sh` silently depends on macOS

**Decision: agree.** The suite intentionally exercises macOS commands and had no platform gate, so a non-macOS host could report a missing macOS utility as if an installer assertion had failed.

Commit: `2504202` (`fix: L3 report non-macOS installer test skip`)

Changes:

- `scripts/test-macos-installer.sh` checks `uname -s` before setup. A non-Darwin host writes `test-macos-installer: skipped, requires macOS` to stderr and exits 3.
- `README.md` documents `test:scripts`, `test:all`, the macOS-only requirement and exit code 3. It identifies `npm test` as the portable suite.

Evidence: with a test-only `uname` returning `Linux`:

```text
test-macos-installer: skipped, requires macOS
exit_code=3
```

## L4 — Keep a valid configuration when the first daemon start fails

**Decision: agree.** The first automatic daemon start shared the rollback catch used for restarting an active daemon. A service launch failure therefore restored the old environment even after the new values had validated and saved successfully.

Commit: `fbeeeb1` (`fix: L4 preserve configuration after first start failure`)

Changes:

- `src/dashboard.ts` handles only the first-time start failure locally. It stops a loaded failed service, fails the maintenance operation when present, preserves `.env`, and returns HTTP 200 with an empty `startedServices`, `daemonStartError`, and the requested recovery message. The existing exception and rollback path for a failed restart remains unchanged.
- The same code prefers an error from the current service launch over stale historical log content; a readiness timeout still uses the last daemon error line when available.
- `dashboard/app.js` keeps setup mode active, preserves rendered saved settings, reloads and scrolls to Services, and highlights the existing daemon Start control. It continues to call the existing `serviceAction('daemon','start')` path.
- `dashboard/index.html` gives the Services panel a stable scroll target.
- `test/dashboard.test.ts`, in `dashboard serves readable state and queues daemon controls`, now asserts that a failed first start returns 200, retains the saved polling interval in `.env`, reports `daemonStartError`, returns no started services, and leaves the daemon unloaded. The pre-existing failed-restart assertions still verify HTTP 400, environment rollback, and restoration of the prior daemon.

Focused-test evidence:

- First run failed because the implementation selected an old `daemon.error.log` line (`retry scheduled`) instead of the current simulated launch error. This was not retried silently; the selection rule was corrected.
- Second run: 1 test, 1 pass, 0 fail.

## Verification

### TypeScript test suite

Command:

```sh
npm test
```

Result: exit 0; 139 tests, 139 pass, 0 fail, 0 skipped.

### Fresh-build and script gate on macOS

Command:

```sh
rm -rf dist && npm run test:all
```

Result: exit 0. The TypeScript suite passed 139/139, `pretest:scripts` rebuilt `dist`, and all script gates completed:

```text
PASS: user-local preflight, verified tool installation, non-interactive providers and argument forwarding
PASS: dashboard-first install, existing destination, fast-forward, config/worktree preservation, backup, dirty checkout, daemon lock, local-only commit, persisted update state and dashboard availability.
PASS: service passthrough reaches uninstall with --yes --force; uninstall preflights unpublished work, requires force, removes factory services, installation and data while preserving targets and shared tools
PASS: installation defaults, GitHub-derived required defaults, private demo provisioning, saved defaults, edits, clearing, validation/retry, secret masking, unknown settings, backups, permissions, EOF cancellation and daemon guard.
PASS: dashboard host/port selection and occupied-port fallback
```

### Uninstall passthrough without removing a real installation

Command, run in a throwaway directory whose `uninstall.mjs` only prints and validates its arguments:

```sh
npm run service -- uninstall --yes --force
```

Result: exit 0.

```text
> bash scripts/services.sh uninstall --yes --force
mock uninstall.mjs reached with: --yes --force
```

### Non-macOS gate behavior

Command: `env PATH=<mock-uname>:/usr/bin:/bin bash scripts/test-macos-installer.sh`, where the test-only `uname` prints `Linux`.

Result: exit 3 with `test-macos-installer: skipped, requires macOS` on stderr.

### Diff validation

Command:

```sh
git diff --check
```

Result: exit 0 with no output before the report commit. It was run again after the report commit with the same result.

## Limitations

- The full installer suite is intentionally macOS-only and was run on macOS for this review.
- The explicit uninstall passthrough verification used a throwaway stub. It proves routing and argument preservation without risking the working installation; the full uninstall fixture in `scripts/test-uninstall.mjs` separately exercises preflight, force, removal and preservation boundaries.
- No live installation was uninstalled.

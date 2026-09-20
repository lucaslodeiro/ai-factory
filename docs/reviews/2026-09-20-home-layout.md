# Home layout review

## Decisions recorded before implementation

- **N1 — agree.** The current checkout owns `.env`, `.factory/` and the install marker; configuration loading also depends on the working directory. A distinct home with an `engine/` checkout removes updater and uninstall ambiguity while an explicit developer-checkout fallback preserves source development.
- **N2 — agree.** The current uninstaller has one destructive scope and its preservation message would become false once factory-managed clones live below the installation home.
- **N3 — agree.** The readiness check is narrower than the 27-field first-run form, so setup currently asks the operator to review settings that already have safe defaults.
- **N4 — agree.** The configured branch is checked against GitHub but is still presented as an initial choice. Keeping the variable and auto-filling it is the smaller safe change because worktree, maintenance and doctor code already consume it.
- **N5 — agree.** Both dashboard and terminal setup currently suggest `~/Source/<repo>` instead of a location owned by the new home.
- **N6 — agree.** Split provider defaults require two credentials and explicit model defaults age; both adapters already implement `auto` by omitting their model argument.
- **N7 — agree.** The terminal and dashboard validators are duplicated and already differ for artifact retention and executable normalization.
- **N8 — agree.** `config.timeoutMs` currently controls both provider execution and retry deferral, coupling two operational decisions that should be independent.

## N1 — Installation home

**Agree.** Commit `d87f9d0` adds `src/home.ts`, explicitly loads `<home>/.env`, resolves relative data paths from the home, and moves installed code, managed repositories, data and configuration to `engine/`, `repos/`, `data/` and `.env`. The launcher, LaunchAgents, dashboard, credential state, installer, updater and terminal configurator now distinguish home from engine. The installer preserves an existing `.env`, accepts a home containing only configuration/backups/repos, writes `data/install.json`, and starts the daemon immediately only when the dashboard's readiness response is already valid. `test/home.test.ts`, `test/dashboard.test.ts`, `scripts/test-maintenance.mjs`, `scripts/test-dashboard-config.mjs` and `scripts/test-macos-installer.sh` cover the three resolution rules and installed layout.

## N2 — Uninstall modes

**Agree.** Commit `cd75951` adds `--purge`. Basic uninstall removes LaunchAgents, `engine/` and runtime data while preserving `.env`, backups and `repos/`. Purge inspects every Git repository below `repos/` for dirty files and commits absent from all remotes, requires `--force` when needed, and removes the complete home. `scripts/test-uninstall.mjs` verifies argument forwarding, the basic preserved paths, purge refusal and forced purge.

## N3 — First-time setup

**Agree.** Commit `55e9ce7` marks only repository, checkout and approvers as setup fields and makes the client show Credentials, Project and Access first. All remaining settings are placed behind a collapsed **Advanced settings** disclosure with an explanation that defaults are safe. The normal configuration page still exposes every category. `test/dashboard.test.ts` asserts the server-side setup field contract.

## N4 — Default branch

**Agree.** Commit `65b0447` keeps `GITHUB_DEFAULT_BRANCH` because removing it would spread changes across worktree, maintenance and doctor behavior. When a different repository is saved and GitHub is connected, the dashboard fetches `repository().defaultBranch`; terminal configuration does the same through `gh api`. Later direct edits remain untouched and doctor continues to detect drift. Dashboard and terminal tests verify `main`/`trunk` auto-fill.

## N5 — Managed clone location

**Agree.** Commit `bcd70b0` changes dashboard and terminal suggestions to `<home>/repos/<name>`. Existing absolute paths remain valid, and repository restore continues to clone into the configured missing directory. `scripts/test-configure.mjs` and `test/dashboard.test.ts` assert the new default. `INSTALL.md` recommends an existing external clone for normal projects.

## N6 — Provider and model defaults

**Agree.** Commit `53149b2` adds the setup-only **Agent provider** choice. Saving it expands atomically to all four role provider variables. Explicit per-role routing remains advanced/normal configuration. Every model default and runtime fallback is `auto`; provider changes in terminal setup also select `auto`. Dashboard and configure tests verify all four provider values and four automatic model defaults. Existing adapter tests verify that `auto` omits a provider model override.

## N7 — Shared validation

**Agree.** Commit `20482a6` exports `validateSetting` from `src/dashboard-settings.ts` and imports its built implementation from `configure.mjs`. The terminal-specific validator and `which` normalization were removed, so both surfaces now validate artifact retention and preserve bare `git`, `codex` and `claude` command names. `scripts/test-configure.mjs` exercises invalid retention followed by a valid value and asserts the bare Git command.

## N8 — Retry deferral

**Agree.** Commit `53ab71e` introduces the internal 30-minute `RETRY_DEFERRAL_MS` in `src/workflow-inbox.ts`. Agent execution timeout changes no longer alter command intake behavior. `retry deferral expires after its fixed internal window` asserts the independent 1,800,000 ms limit.

## Verification

- Baseline before changes: `npm test` — **146 tests, 146 passed, 0 failed**.
- During final integration, the first `npm test` exposed one stale launcher-help expectation: **149 tests, 148 passed, 1 failed** (`service launcher installs and controls daemon and dashboard independently`). The expectation was updated for `--purge`; this was an assertion drift, not a flaky test.
- `rm -rf dist && npm run test:all` on macOS — **passed**. Portable suite: **149 tests, 149 passed, 0 failed**. Script output:
  - `PASS: user-local preflight, verified tool installation, non-interactive providers and argument forwarding`
  - `PASS: dashboard-first install, existing destination, fast-forward, config/worktree preservation, backup, dirty checkout, daemon lock, local-only commit, persisted update state and dashboard availability.`
  - `PASS: basic uninstall preserves configuration and repos; purge preflights dirty clones and removes the complete home only with force`
  - `PASS: installation defaults, GitHub-derived required defaults, private demo provisioning, saved defaults, edits, clearing, validation/retry, secret masking, unknown settings, backups, permissions, EOF cancellation and daemon guard.`
  - `PASS: dashboard host/port selection and occupied-port fallback`
- Throwaway macOS lifecycle used `AI_FACTORY_SKIP_SERVICES=1 AI_FACTORY_NO_OPEN=1 AI_FACTORY_INSTALL_TESTS=0` and the local `feat/home-layout` branch. After install, the listing contained `.env`, `data/install.json`, `engine/.git` and `repos/sample`. After basic uninstall it contained only `.env` and `repos/sample`. Reinstall recreated `engine/` and `data/install.json` while `cat .env` still returned `GITHUB_REPOSITORY=owner/demo` and `FACTORY_DATA_DIR=data`. Purge ended with `PURGE_CONFIRMED home removed`.
- `npm run build` — passed during focused N3, N4, N5, N6 and N7 validation and again through `pretest:scripts` from an absent `dist/`.
- `git diff --check` — clean.
- No test was retried to turn an unexplained failure green; no flaky test was observed.

## Documentation

`README.md` and `INSTALL.md` now document the home layout, `AI_FACTORY_HOME`, developer-checkout fallback, managed clone default, basic/purge uninstall, selected-provider setup, automatic models, new log locations and incomplete-engine recovery. `docs/CONTEXT_AND_WORKFLOW_DESIGN.md` §10 records the filesystem layout and the reinstall-only cutover. `.env.example` explains home-relative paths and uses `auto` models.

## Existing installation instructions

There is deliberately no migration or compatibility path:

1. Save the values you want from the old `.env` outside the old installation.
2. Run the old installation's supported uninstaller. Use its force option only after reviewing unpublished work.
3. Install this version into the desired home; the default is `$HOME/ai-factory`.
4. Re-enter the saved values through first-time setup or `ai-factory configure`. Prefer an existing target clone outside the home for a real project.
5. Run doctor and start the daemon. Old SQLite state, worktrees and workflow cursors are not imported.

## Limitations and open questions

No product decision remains open. The live lifecycle skipped LaunchAgents and browser opening by design, while the macOS script suite separately exercised the service and installer paths. Provider authentication was not changed or removed by the lifecycle.

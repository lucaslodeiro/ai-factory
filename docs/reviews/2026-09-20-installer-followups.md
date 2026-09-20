# Installer follow-ups — 2026-09-20

Baseline: `main` at `9c3cea5`. Implementation branch: `fix/installer-followups`.

## Decisions

- **J1 — agree.** The public installer inspected only `--dir`; help and invalid options could reach tool installation.
- **J2 — agree.** `.git` plus `package.json` existed immediately after clone and could not prove installation completion.
- **J3 — agree.** The bootstrap URL was fixed to `main`, independently of `--branch` and `--repo`.
- **J4 — agree.** CLI uninstall did not inspect active workflow rows or remote branch publication before removing runtime worktrees.
- **J5 — agree.** The launcher, operation scripts, summaries and documentation exposed inconsistent commands and incomplete help.
- **J6 — agree.** The five script fixtures were outside the named npm test gates.
- **J7 — agree, evidence-driven fix.** Codex documents `CODEX_NON_INTERACTIVE`; Claude's wrapper documents no corresponding CI/non-interactive variables. Unsupported variables were removed while closed stdin was retained.
- **J8 — agree.** The internal destination message duplicated the public layer, a removed installation mode still controlled output, installer curl calls lacked a TLS floor, and install-time runtime tests had no explicit opt-out.

## Changes

- **First-time daemon startup — `d0eaa53`.** `src/dashboard.ts` and `dashboard/app.js` let the installer-opened setup page start and verify the daemon after a valid Save and apply. Later saves still preserve an intentionally stopped daemon. `test/dashboard.test.ts` covers the stopped-to-running onboarding path. `README.md`, `INSTALL.md` and the installer summary describe it.
- **J1 — `6029a0a`.** `scripts/install-macos.sh` parses every public option before platform or network work and prints complete defaults, prerequisites, environment controls and next commands. `scripts/install-core.sh` points to public help. `scripts/test-macos-installer.sh` proves help/unknown options invoke no curl.
- **J2 — `e21b8f3`.** Both installer layers recognize only `.factory/install.json` as complete. `scripts/install-core.sh` writes it last, reports the failed step and preserves partial directories; `scripts/update.sh` refreshes it only after a successful update. `scripts/test-maintenance.mjs` covers a failed npm test, missing marker and second-run incomplete diagnosis; the public fixture covers the same classification.
- **J3 — `16096bc`.** `scripts/install-macos.sh` derives the raw bootstrap URL from GitHub repository plus requested branch, with an explicit stable-main fallback for non-GitHub repositories. The installer fixture asserts the `develop` URL.
- **J4 — `f3728d6`.** `scripts/uninstall.mjs` reads active work items, checks their branches with bounded `git ls-remote`, lists unpublished/unverifiable work and requires `--force` with `--yes` or a second typed confirmation. `scripts/test-uninstall.mjs` seeds a paused Build item and proves refusal followed by forced removal.
- **J5 — `f8a37c0`.** `scripts/ai-factory` now exposes unified operation plus Commander help, version forwarding and correct update modes. All operation scripts accept help in any position and point back to `ai-factory help`; summaries and installed-operation documentation use launcher commands. `scripts/test-macos-installer.sh`, `scripts/test-maintenance.mjs` and `test/services.test.ts` cover the unified surface.
- **J6 — `b778aba`.** `package.json` adds `test:scripts` for all five fixtures and `test:all` as the release gate. `docs/VALIDATION.md` documents the gate and current runtime total.
- **J7 — `9363248`.** `scripts/install-macos.sh` keeps the documented Codex flag and closed stdin, removes unsupported CI/color/terminal assignments and keeps Claude on its native `stable` install path with closed stdin. The fixture verifies no provider can read terminal input and that unrelated environment values are not overwritten. `INSTALL.md` records the provider behavior and paths.
- **J8 — `33089dd`.** The internal guard is one bounded line, the one-mode summary is unconditional, all installer network curl calls require HTTPS/TLS 1.2, the local dashboard health probe uses Node fetch, and `AI_FACTORY_INSTALL_TESTS=0` is supported and tested.

## J7 upstream and real-run evidence

The official installers were downloaded on 2026-09-20 from `https://chatgpt.com/codex/install.sh` and `https://claude.ai/install.sh` and inspected before changing the wrapper.

### Codex

- Its help documents: `CODEX_NON_INTERACTIVE  Set to 1, true, or yes to skip prompts.`
- Its default binary directory is `CODEX_INSTALL_DIR` or `$HOME/.local/bin`.
- In non-interactive mode its yes/no helper declines prompts, including `Start Codex now?`; it does not start login or the Codex console.
- It installs a visible `~/.local/bin/codex` symlink to the standalone package under `~/.codex/packages/standalone/current`.

### Claude

- The downloaded wrapper documents the release argument and `CLAUDE_INSTALL_ALLOW_SUDO`; it does not document `CI`, `NO_COLOR`, `TERM` or a non-interactive variable.
- The wrapper downloads a verified native binary and invokes its `install` subcommand. It does not invoke `login`, `auth` or the Claude console afterward.
- The real run created `~/.local/bin/claude` pointing to `~/.local/share/claude/versions/2.1.267`.

Both locations are on the installer's active `PATH`. `scripts/services.sh` also places `$HOME/.local/bin` in each LaunchAgent `PATH`, so fresh shells and services resolve the same commands once the documented profile line is loaded.

The requested real check ran with a newly created temporary `HOME`, `AI_FACTORY_SKIP_SERVICES=1`, `AI_FACTORY_NO_OPEN=1`, and a restricted PATH that forced both provider installations. It returned control after installing Codex 0.155.1 and Claude 2.1.267; no provider console or login flow opened. The bootstrap came from then-current public `main`, because the reviewed branch had not yet been pushed. Relevant installer output was:

```text
Installing Codex CLI non-interactively with its official native installer...
==> Installing Codex CLI
==> /tmp/ai-factory-j7-home.CriJJA/.local/bin is already on PATH
Codex CLI 0.155.1 installed successfully.
Installing Claude Code stable non-interactively with its official native installer...
Setting up Claude Code...
✔ Claude Code successfully installed!
  Version: 2.1.267
  Location: ~/.local/bin/claude
✅ Installation complete!
```

Tail of that real run:

```text
AI Factory installation completed successfully
============================================================
Engine:        /tmp/ai-factory-j7-home.CriJJA/ai-factory
Configuration: continue in the dashboard
Daemon:        not started
Dashboard:     started; health check pending at http://127.0.0.1:4174 (see .factory/service-logs/dashboard.error.log)
Services:      daemon and dashboard definitions installed
Launcher:      /tmp/ai-factory-j7-home.CriJJA/.local/bin/ai-factory
Toolchain:     /tmp/ai-factory-j7-home.CriJJA/.local (no Homebrew)

Persist the tool path once before opening a new terminal:
  grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.zprofile" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zprofile"
  source "$HOME/.zprofile"
```

## Verification

- `npm run build` — passed (`tsc` plus asset copy).
- `npm test` — the first final run exposed one stale service-summary assertion: 125 total, 124 passed, 1 failed. The assertion was updated in J5. The repeated final run passed: 125 total, 125 passed, 0 failed, 0 skipped.
- `npm run test:scripts` — passed all five fixtures: macOS installer, maintenance/update, uninstall, terminal configuration and dashboard configuration.
- `bash scripts/test-macos-installer.sh` — passed after the consolidated commits.
- `git diff --check` — clean before the report commit.
- Live throwaway-home provider/install check — completed; both provider versions and both `~/.local/bin` symlinks were verified directly.

## Documentation

- `README.md` and `INSTALL.md` now explain automatic daemon startup after valid first-time setup and use installed launcher commands for normal operations.
- `INSTALL.md` documents the public options, install-time test control, provider non-interactive evidence, binary locations, update/recovery and uninstall force behavior.
- `docs/VALIDATION.md` names `npm run test:all` as the release gate and records the 125-test runtime suite.

## Open questions

None. The installer continues to require Apple Command Line Tools as a manual macOS prerequisite and intentionally does not authenticate GitHub, Codex or Claude during installation.

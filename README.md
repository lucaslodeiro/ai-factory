# AI Software Factory

Locally executed multi-agent software factory orchestrated from a developer Mac.

## MVP

A GitHub Issue becomes a work item. The local orchestrator coordinates four independent roles:

1. **Product / Architect — Claude**: clarifies the request, challenges assumptions, proposes alternatives, and produces the specification.
2. **Developer — Codex**: implements the approved specification in an isolated Git worktree.
3. **QA — Codex**: independently derives tests from the specification, may create/modify test code, and reports findings without modifying production code.
4. **Reviewer — Claude**: reviews specification compliance, code quality, security, performance, and product/UI/copy consistency.

The human remains the authority for major product/architecture decisions and any change that contradicts a previously approved human decision.

## Core principles

- Orchestration runs **locally on macOS**.
- GitHub is the visible/auditable collaboration surface, not the execution engine.
- Every role runs in a fresh, independent agent context.
- Agent providers are adapters and can be replaced.
- Approved specs are versioned contracts.
- Every execution and state transition is observable and cancellable.
- Slack is notification-only; decisions happen in GitHub.
- Agents may use the Internet. Secrets are exposed only when explicitly configured.

The consolidated requirements and traceability matrix are in [SPEC.md](SPEC.md).

See [ARCHITECTURE.md](ARCHITECTURE.md) and [INSTALL.md](INSTALL.md).

## Install and run the MVP

On a new Mac, download the installer from the current MVP branch:

```sh
curl -fsSL https://raw.githubusercontent.com/lucaslodeiro/ai-factory/main/scripts/install.sh -o /tmp/ai-factory-install.sh
bash /tmp/ai-factory-install.sh --dir "$HOME/ai-factory"
```

On a Mac without Homebrew, use the alternative installer. It places Node 22 and GitHub CLI under `~/.local`, uses Apple's Command Line Tools for Git, installs the provider CLIs through their native installers, verifies downloaded Node/GitHub CLI checksums, and then runs the standard installer:

```sh
curl -fsSL https://raw.githubusercontent.com/lucaslodeiro/ai-factory/main/scripts/install-macos-no-brew.sh \
  -o /tmp/ai-factory-install-no-brew.sh
bash /tmp/ai-factory-install-no-brew.sh --dir "$HOME/ai-factory"
```

The installer prepares the engine and opens the configuration wizard. The wizard authenticates GitHub when needed and derives usable defaults from that account: `<login>/ai-factory-demo`, `$HOME/Source/ai-factory-demo`, and the same login as approver. If the target does not exist, it asks before creating a private repository and local clone. It never starts the daemon. In an existing source checkout:

Its final summary clearly distinguishes a successful engine installation from optional target-project setup. If required project fields are left blank, it reports **saved for later** and gives a numbered first-run checklist instead of treating that choice as an installation error.

```sh
npm ci
npm run build
npm test
npm run configure
# Authenticate Codex and Claude if needed, then:
npm run factory -- doctor
npm run service -- start daemon
npm run service -- start dashboard
```

`npm run configure` can be run at any time while the daemon is stopped. Existing non-empty `.env` values are shown as defaults; empty required target values receive GitHub-derived defaults, and settings added in a newer version use `.env.example` defaults. Installation and update invoke this same wizard. Use `--defaults` with the scripts for unattended operation; that mode performs no authentication or repository provisioning.

The factory engine and target application are separate repositories. `GITHUB_REPOSITORY` selects where issues are read and PRs are created; `FACTORY_REPO_DIR` selects the local clone used for worktrees. Open issues enter the factory only when labelled `factory:queued`.

Queue an issue with `factory:queued`. Answer `/factory answer <text>` and approve the posted version with `/factory approve vN`. The daemon runs independent role processes, routes findings, and creates a pull request after passing QA and review. Human merge remains required.

Configuration command: `npm run configure`. The installer creates separate macOS services for the orchestrator and local dashboard. Control them with `npm run service -- <start|stop|restart|status|logs> <daemon|dashboard|all>`. The dashboard defaults to [http://127.0.0.1:4173](http://127.0.0.1:4173), supports persistent light/dark themes, and updates issue badges, the issue list, metrics, executions and events over a near-real-time local stream. Its service cards can start, restart or stop either service. The global update area shows the package version and Git revision, checks the current branch on `origin`, and only offers Update Factory when a fast-forward version is available. Updating stops both services, downloads and validates the current branch in a background process, refreshes their LaunchAgents, and restores the services that were running. Persistent update state keeps the UI at Updating through the dashboard restart, then a revision change reloads the frontend automatically. Output is written to `.factory/service-logs/update.log`. The dashboard also includes a configuration editor for `.env`; stop the daemon before saving and restart affected services afterward. Factory commands remain available directly: `doctor`, `start`, `dashboard`, `status [id]`, `events [id]`, `cancel <item-or-run-id>`, `retry <item-id>`, `stop`, `notifications`, `slack-test`, `models [id]`, `sync`.

One instance executes agent stages sequentially for one target repository. To run two projects at once, use two installations with separate target clones, `.env` files and data directories. Multiple instances targeting the same repository are not supported.

This repository uses two long-lived branches: `develop` for ongoing work and `main` for stable releases. The installer defaults to `main`; pass `--branch develop` only when intentionally testing unreleased factory changes.

See [installation and operations](INSTALL.md), [GitHub setup](docs/GITHUB_SETUP.md), and [validation evidence and operational boundaries](docs/VALIDATION.md).

Model routing balances quality, cost and time using an approved complexity/risk assessment, role floors and correction escalation. See [model selection policy](docs/MODEL_POLICY.md).

GitHub issues show the workflow through colored state labels and an updatable progress comment. Reports use readable Markdown; full JSON evidence stays in the local audit. The issue remains open until the delivered PR is merged.

Merged PRs reconcile to `MERGED`; closed unmerged PRs to `PR_CLOSED`. Run `npm run factory -- sync` when the daemon is stopped to refresh delivery state without running agents.

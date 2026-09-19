# AI Software Factory

Locally executed multi-agent software factory orchestrated from a developer Mac.

## MVP

A GitHub Issue becomes a work item. The local orchestrator coordinates four independent roles:

1. **Product / Architect**: clarifies the request, challenges assumptions, proposes alternatives, and produces the specification. Default provider: Claude.
2. **Developer**: implements the approved specification in an isolated Git worktree. Default provider: Codex.
3. **QA**: independently derives tests from the specification, may create/modify test code, and reports findings without modifying production code. Default provider: Codex.
4. **Reviewer**: reviews specification compliance, code quality, security, performance, and product/UI/copy consistency. Default provider: Claude.

Each role can use Codex or Claude independently. In **Configuration → Agent roles**, the operator chooses the provider and either a concrete model or **Auto**, which lets that provider use its recommended model.

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

The installer prepares the engine, installs both macOS services, starts the local dashboard and opens its first-time setup page. Credentials and environment settings are completed in the browser. The daemon remains stopped until you start it from Services after configuring the target. In an existing source checkout:

```sh
npm ci
npm run build
npm test
npm run service -- start dashboard
# Complete Dashboard → Configuration, then:
npm run service -- start daemon
```

Use **Dashboard → Configuration** whenever settings or credentials change. Every option with a safe universal value opens with a default; after GitHub connects, the dashboard suggests the account's demo repository, local clone and approver for any empty required fields. Optional secrets and allowlists remain empty. **Save and apply** validates the full candidate configuration before writing, restarts affected running services automatically and leaves stopped services stopped. The installer accepts `--dashboard-host` and `--dashboard-port`; when the selected port is occupied it saves and opens the next available port automatically. Changing the address later in Configuration shows the new URL and reconnects after restarting the dashboard. `npm run configure` remains a supported terminal recovery path when the dashboard is unavailable; installation and update do not invoke it. Existing settings are preserved during updates.

For a clean installer retest, `npm run uninstall` removes both factory services, the engine checkout and its local runtime data after showing the exact paths and asking for confirmation. It preserves the target repository, provider credentials and shared command-line tools. The launcher also advertises the alias `npm run service -- uninstall`; see every action with `npm run service -- --help`. Use `--yes` only for an automated disposable-machine run.

The factory engine and target application are separate repositories. `GITHUB_REPOSITORY` selects where issues are read and PRs are created; `FACTORY_REPO_DIR` selects the local clone used for worktrees. Open issues enter the factory only when labelled `factory:queued`.

Queue an issue with `factory:queued`. Answer `/factory answer <text>` and approve the posted version with `/factory approve vN`. The daemon runs independent role processes, routes findings, and creates a pull request after passing QA and review. Human merge remains required.

Configuration is managed from the dashboard. The installer creates separate macOS services for the orchestrator and local dashboard. Control them with `npm run service -- <start|stop|restart|status|logs> <daemon|dashboard|all>`. The dashboard defaults to [http://127.0.0.1:4173](http://127.0.0.1:4173), supports persistent light/dark themes, and updates issue badges, the issue list, metrics, executions and events over a near-real-time local stream. Its service cards can start, restart or stop either service. The global update area shows the package version and Git revision, checks the current branch on `origin`, and only offers Update Factory when a fast-forward version is available. Updating runs in an independent transient `launchd` job, stops both services, downloads and validates the current branch, refreshes their LaunchAgents, and restores the services that were running. Persistent update state keeps the UI at Updating through the expected dashboard disconnect, verifies that any saved PID still belongs to the updater, then reloads the frontend after a revision change. Output is written to `.factory/service-logs/update.log`. The Configuration panel organizes `.env` into conceptual categories, uses selects for closed values such as model IDs and dashboard host, preserves existing custom model IDs, and identifies the service affected by every field. Credentials reports GitHub, Claude, Codex and Slack connection state. Notifications securely saves or removes the Slack Incoming Webhook, sends an explicit test message, and shows pending, failed and sent delivery counts without exposing the webhook. Saving validates all settings before touching disk and automatically restarts affected running services. If the dashboard cannot start, stop both services and use `npm run configure`, then `npm run factory -- doctor` and `npm run service -- start all`. Factory commands remain available directly: `doctor`, `start`, `dashboard`, `status [id]`, `events [id]`, `cancel <item-or-run-id>`, `retry <item-id>`, `stop`, `notifications`, `slack-test`, `models [id]`, `sync`.

One instance executes agent stages sequentially for one target repository. To run two projects at once, use two installations with separate target clones, `.env` files and data directories. Multiple instances targeting the same repository are not supported.

This repository uses two long-lived branches: `develop` for ongoing work and `main` for stable releases. The installer defaults to `main`; pass `--branch develop` only when intentionally testing unreleased factory changes.

See [installation and operations](INSTALL.md), [GitHub setup](docs/GITHUB_SETUP.md), and [validation evidence and operational boundaries](docs/VALIDATION.md).

Product/Architect records a complexity/risk assessment and the deterministic orchestrator uses it for workflow safeguards such as additional architectural review. Configuration → Agent roles chooses Codex or Claude and one direct model for Product/Architect, Developer, QA and Reviewer. Each model can also be **Auto**, which delegates model choice to its provider. See [model selection policy](docs/MODEL_POLICY.md).

GitHub issues show the workflow through colored state labels and an updatable progress comment. Reports use readable Markdown; full JSON evidence stays in the local audit. The issue remains open until the delivered PR is merged.

Merged PRs reconcile to `MERGED`; closed unmerged PRs to `PR_CLOSED`. Run `npm run factory -- sync` when the daemon is stopped to refresh delivery state without running agents.

# AI Software Factory

Locally executed multi-agent software factory orchestrated from a developer Mac.

## MVP

A GitHub Issue becomes a work item. The local orchestrator coordinates four independent roles:

| Role | Short name | Stage | Responsibility | Default provider |
|---|---|---|---|---|
| **Product Architect** | **Architect** | **Design** | Clarifies the request, challenges assumptions, proposes alternatives, and produces the specification. | Claude |
| **Implementation Engineer** | **Builder** | **Build** | Implements the approved specification in an isolated Git worktree. | Codex |
| **Verification Engineer** | **Tester** | **Test** | Independently derives tests from the specification, may change test code, and reports findings without modifying production code. | Codex |
| **Delivery Reviewer** | **Reviewer** | **Review** | Reviews specification compliance, code quality, security, performance, and product/UI/copy consistency. | Claude |

The internal identifiers (`product-architect`, `developer`, `qa`, `reviewer`; `SPEC`, `DEVELOPMENT`, `QA`, `REVIEW`) remain stable for existing `.env`, SQLite data and automation. Human-facing surfaces use the names in the table.

Each role can use Codex or Claude independently. In **Configuration → Agent roles**, the operator chooses the provider and either a concrete model or **Auto**, which lets that provider use its recommended model.

The human remains the authority for major product/architecture decisions and any change that contradicts a previously approved human decision.

## Core principles

- Orchestration runs **locally on macOS**.
- GitHub is the visible/auditable collaboration surface, not the execution engine.
- Every role runs in a fresh, independent agent context.
- Agent providers are adapters and can be replaced.
- Approved specs are versioned contracts.
- Every execution and state transition is observable and cancellable.
- Slack sends structured workflow updates with direct links and clear actions; decisions happen in GitHub.
- Agents may use the Internet. Secrets are exposed only when explicitly configured.

The consolidated requirements and traceability matrix are in [SPEC.md](SPEC.md).

See [ARCHITECTURE.md](ARCHITECTURE.md) and [INSTALL.md](INSTALL.md).

The draft [context and workflow evolution specification](docs/CONTEXT_AND_WORKFLOW_DESIGN.md) documents the current context/state limitations and a candidate architecture for design review. It is not an implemented requirement baseline.

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

For an interrupted update that already unloaded both services, run `AI_FACTORY_UPDATE_STATE_FILE="$PWD/.factory/update-state.json" bash scripts/update.sh --start-services` from the installation directory. This explicit recovery mode starts both services after a successful update. Normal dashboard updates persist each service's original loaded state before the background job begins and restore that recorded intent after success or failure.

For a clean installer retest, keep the parent terminal outside the checkout: run `cd "$HOME"` and then `ai-factory uninstall`. The installer places that launcher in `~/.local/bin`, so factory, service, update, configuration and uninstall commands work from any directory. If the current shell has not loaded that path yet, use `npm --prefix "$HOME/ai-factory" run uninstall`. It removes both factory services, the engine checkout and its local runtime data after showing the exact paths and asking for confirmation. It preserves the target repository, provider credentials and shared command-line tools. Use `--yes` only for an automated disposable-machine run. If an older uninstall left the terminal pointing at the removed directory, run `cd "$HOME"`; both installers also recover automatically from that stale working directory.

If a failed attempt leaves a destination that is not a valid factory checkout, the installer reports `An incomplete or unrelated destination already exists` and prints the safe recovery commands. Preserve it with `mv "$HOME/ai-factory" "$HOME/ai-factory.incomplete-$(date +%Y%m%d-%H%M%S)"`, then rerun the downloaded installer. The installer never deletes or overwrites an unrecognized directory automatically. See [installation and operations](INSTALL.md) for the complete command sequence.

The factory engine and target application are separate repositories. `GITHUB_REPOSITORY` selects where issues are read and PRs are created; `FACTORY_REPO_DIR` selects the local clone used for worktrees. Start an open issue from the dashboard, with `factory start-issue <number-or-url>`, or by posting a standalone `/factory start` comment from an authorized approver. The daemon creates and manages workflow labels automatically after ingestion.

Start an issue with `/factory start`. Answer `/factory answer <text>` and approve the posted version with `/factory approve vN`. If an item is failed, paused or cancelled, an authorized approver can resume it by posting `/factory retry` on the same issue. The command may be the whole comment or the first/last line of a multiline comment; surrounding text is preserved as guidance for the next agent. Every factory comment ends with a consistent **Next action** section: commands appear in copyable code blocks, alternative actions are shown separately, and automatic stages explicitly say that no human action is required. The daemon runs independent role processes, routes findings, and creates a pull request after passing Test and Review. Human merge remains required.

FAILED issues receive a readable troubleshooting comment containing the stage, matching execution metadata, sanitized failure reason, a human-readable diagnosis with evidence and a recommended action, a bounded `stderr` tail when available, and exact retry instructions. Full logs stay local in the dashboard. Guidance written above or below `/factory retry` is echoed in the acceptance comment and becomes an explicit human instruction for every remaining agent in that delivery; it takes priority over conflicting suggestions from earlier agent reports.

Configuration is managed from the dashboard. The installer creates separate macOS services for the orchestrator and local dashboard. Control them with `npm run service -- <start|stop|restart|status|logs> <daemon|dashboard|all>`. The dashboard defaults to [http://127.0.0.1:4173](http://127.0.0.1:4173), supports persistent light/dark themes, and updates issue badges, the issue list, metrics, executions and events over a near-real-time local stream. Its Issues toolbar starts work by number or URL. Recent executions identify the issue, workflow stage, role, provider/model, duration, provider-reported tokens and outcome. **Time and tokens by issue** aggregates every attempt, including retries, and breaks totals down by workflow stage and agent; each issue keeps its totals visible while its responsive breakdown can be expanded or collapsed, and runs whose CLI does not report usage are marked unavailable instead of estimated. Recent events translate the audit into plain-language workflow activity with severity, evidence and issue links. Its **Daemon logs** section tails standard output and errors while open, offers 100–1,000 recent lines, and supports refresh and **Copy visible logs** without loading complete log files. Clipboard copy uses the browser API when available and a user-gesture fallback for HTTP/Tailscale access. The daemon writes timestamped, single-line operational records for lifecycle, controls, workflow transitions, model selection, agent execution and recoverable integration failures; prompts, complete agent responses and secrets are excluded. The daemon polls new comments normally and processes valid start, answer, approval and retry commands in the appropriate workflow state. **Refresh issue list** performs global reconciliation: it discovers missing managed issues, updates known issue metadata, moves every tracked issue to its newest GitHub comment and evaluates only that newest comment for the current state. Older unread comments are deliberately skipped and work already completed is never replayed. A managed issue found after local state was lost is restored as `PAUSED`; if its newest comment is a valid retry, it restarts safely at Design with Architect, otherwise it remains paused with the latest human answer available as context. Paused, cancelled, recovered, ready-to-merge, PR-closed and merged transitions publish readable facts, preserved-work details and exact next actions. Service cards can start, restart or stop either service. The global update area shows the installed version, checks the current branch on `origin`, and only offers Update Factory for a valid fast-forward. Updating runs in an independent transient `launchd` job: it stops the daemon, waits for its runtime lock to be released, and keeps the dashboard online while downloading, building, and testing. A successful update refreshes both services and briefly restarts the dashboard. A failed update restores every service that was running before the attempt, including the daemon. Persistent state reports progress, verifies that any saved PID still belongs to the updater, and reloads the frontend after the brief final restart. Output is written to `.factory/service-logs/update.log`. The Configuration panel organizes `.env` into conceptual categories, uses selects for closed values such as model IDs and dashboard host, preserves existing custom model IDs, and identifies the service affected by every field. A required-setup notice appears only while credentials selected by agent roles, repository settings, approvers, the target checkout, Git identity or its origin prevent the factory from processing work. Credentials reports GitHub, Claude, Codex and Slack connection state. Notifications shows Slack delivery status first, then edits the write-only webhook through the same global **Save and apply** action as every other setting; clearing it uses the field's explicit secret-clear option. It can also send an explicit test message and shows pending, failed and sent delivery counts without exposing the webhook. Saving validates all settings before touching disk and automatically restarts affected running services. If the dashboard cannot start, stop both services and use `npm run configure`, then `npm run factory -- doctor` and `npm run service -- start all`. Factory commands remain available directly: `doctor`, `start`, `start-issue <number-or-url>`, `dashboard`, `status [id]`, `events [id]`, `cancel <item-or-run-id>`, `retry <item-id>`, `refresh-list`, `stop`, `notifications`, `slack-test`, `models [id]`, `sync`.

One instance executes agent stages sequentially for one target repository. To run two projects at once, use two installations with separate target clones, `.env` files and data directories. Multiple instances targeting the same repository are not supported.

This repository uses two long-lived branches: `develop` for ongoing work and `main` for stable releases. The installer defaults to `main`; pass `--branch develop` only when intentionally testing unreleased factory changes.

See [installation and operations](INSTALL.md), [GitHub setup](docs/GITHUB_SETUP.md), and [validation evidence and operational boundaries](docs/VALIDATION.md).

Product Architect records a complexity/risk assessment and the deterministic orchestrator uses it for workflow safeguards such as additional architectural review. Configuration → Agent roles chooses Codex or Claude and one direct model for Product Architect, Implementation Engineer, Verification Engineer and Delivery Reviewer. Each model can also be **Auto**, which delegates model choice to its provider. See [model selection policy](docs/MODEL_POLICY.md).

Configuration → Runtime also sets the byte budget for agent context. Optional JSON overrides can target an exact role or `provider/model`; the most specific matching value is recorded with each persisted prompt. Protected specification, decision and instruction context is never silently clipped.

GitHub issues show the workflow through colored state labels and an updatable progress comment. Reports use readable Markdown; full JSON evidence stays in the local audit. The issue remains open until the delivered PR is merged.

Merged PRs reconcile to `MERGED`; closed unmerged PRs to `PR_CLOSED`. Run `npm run factory -- sync` when the daemon is stopped to refresh delivery state without running agents.

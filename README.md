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

The role identifiers are `product-architect`, `developer`, `qa` and `reviewer`. Workflow projections store stage (`DESIGN`, `BUILD`, `TEST`, `REVIEW`, `DELIVERY`) independently from status (`QUEUED`, `RUNNING`, `WAITING`, `FAILED`, `PAUSED`, `CANCELLED`, `COMPLETED`). Human-facing surfaces use the names in the table.

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

The implemented [context and workflow specification](docs/CONTEXT_AND_WORKFLOW_DESIGN.md) defines context lifecycle, workflow state, maintenance safety and repository recovery.

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

Commands must be the first non-empty line of a new comment from an authorized approver. Text may continue on following lines; quoted commands and commands after prose are ignored.

- `/factory start [guidance]` starts an open issue.
- `/factory help` publishes the complete command reference once.
- `/factory approve vN [guidance]` approves the posted SPEC version.
- `/factory answer <text>` answers a question or requests PR changes.
- `/factory retry [--issue] [--for <roles>] [guidance]` resumes failed, paused or cancelled work.
- `/factory note [--issue] [--for <roles>] <text>` adds guidance without changing state.
- `/factory replace <#N|id-prefix> [--issue] [--for <roles>] <text>` replaces guidance.
- `/factory revoke <#N|id-prefix>` revokes guidance.
- `/factory pause [reason]` pauses active work.
- `/factory cancel [reason]` cancels work.

Roles accepted by `--for` are `architect`, `builder`, `tester` and `reviewer`. Every factory comment ends with a consistent **Next action** section: commands appear in copyable code blocks, alternative actions are shown separately, and automatic stages explicitly say that no human action is required. The daemon runs independent role processes, routes findings, and creates a pull request after passing Test and Review. Human merge remains required.

FAILED issues receive a readable troubleshooting comment containing the stage, matching execution metadata, sanitized failure reason, a human-readable diagnosis with evidence and a recommended action, a bounded `stderr` tail when available, and exact retry instructions. Full logs stay local in the dashboard. Guidance written on the `/factory retry` line or below it becomes an explicit human instruction for applicable agents; it takes priority over conflicting suggestions from earlier agent reports.

Configuration is managed from the dashboard. The installer creates separate macOS services for the orchestrator and local dashboard. Control them with `npm run service -- <start|stop|restart|status|logs> <daemon|dashboard|all>`. The dashboard defaults to [http://127.0.0.1:4173](http://127.0.0.1:4173), supports persistent light/dark themes, and updates issue stage/status badges, metrics, executions and events over a near-real-time local stream. Recent executions show role, provider/model, duration, provider-reported tokens and interruption reason; exact prompts require an explicit sensitive-content acknowledgement. **Time and tokens by issue** aggregates retries and offers a responsive per-stage breakdown. **Daemon logs** tails bounded output and supports copy.

The daemon polls new comments normally. **Refresh issue list** reconciles only already tracked issues, advances each to its newest comment and evaluates that comment for the current request; it never imports an issue implicitly or replays old work. Closed issues disappear from operational views. The editable GitHub status comment carries current stage, condition and exactly one action; labels use independent stage and condition dimensions.

Update, daemon stop/restart and daemon-affecting configuration changes first list active tasks and require confirmation. Confirmed tasks are interrupted as maintenance, preserved as `PAUSED` and offered through **Resume paused tasks** after services return. Explicit Cancel remains `CANCELLED`. Configuration → Project also exposes bounded repository Check, clean fast-forward Sync, selected factory-branch Publish, confirmed Clear and empty-directory Restore actions.

The global update area checks `origin` before enabling update and runs through an independent job while the dashboard reconnects. Configuration groups credentials, project, runtime, dashboard, direct role model selection, tools, access and notifications. Slack uses the global **Save and apply** flow, durable delivery retry and a test action. If the dashboard cannot start, use `npm run configure`, `npm run factory -- doctor` and `npm run service -- start all`.

Factory commands include `doctor`, `start`, `start-issue`, `status`, `events`, `cancel`, `retry`, `refresh-list`, `stop --pause-active`, `notifications`, `slack-test`, `models`, `sync`, and `repo <check|sync|publish|clear|restore>`.

One instance executes agent stages sequentially for one target repository. To run two projects at once, use two installations with separate target clones, `.env` files and data directories. Multiple instances targeting the same repository are not supported.

This repository uses two long-lived branches: `develop` for ongoing work and `main` for stable releases. The installer defaults to `main`; pass `--branch develop` only when intentionally testing unreleased factory changes.

See [installation and operations](INSTALL.md), [GitHub setup](docs/GITHUB_SETUP.md), and [validation evidence and operational boundaries](docs/VALIDATION.md).

Product Architect records a complexity/risk assessment and the deterministic orchestrator uses it for workflow safeguards such as additional architectural review. Configuration → Agent roles chooses Codex or Claude and one direct model for Product Architect, Implementation Engineer, Verification Engineer and Delivery Reviewer. Each model can also be **Auto**, which delegates model choice to its provider. See [model selection policy](docs/MODEL_POLICY.md).

Configuration → Runtime also sets the byte budget for agent context. Optional JSON overrides can target an exact role or `provider/model`; the most specific matching value is recorded with each persisted prompt. Protected specification, decision and instruction context is never silently clipped.

The V3 workflow starts from a fresh factory data directory. It intentionally provides no importer or compatibility reader for earlier workflow databases. Reinstalling preserves the target application repository and the locally stored GitHub, Claude and Codex credentials.

GitHub issues show the workflow through colored stage/condition labels and an updatable status comment. Structured evidence stays in the local audit. The issue remains open until the delivered PR is merged.

Merged PRs reconcile to `DELIVERY/COMPLETED`; a closed unmerged PR remains `DELIVERY/WAITING` with its merge request marked closed until reopened. Run `npm run factory -- sync` when the daemon is stopped to refresh delivery state without running agents.

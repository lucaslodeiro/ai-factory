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

On a new Mac, use the single supported installer. It never installs or uses Homebrew. It places Node 22 and GitHub CLI under `~/.local`, uses Apple's Command Line Tools for Git, installs the provider CLIs non-interactively through their native installers, verifies downloaded Node/GitHub CLI checksums, and then installs the factory:

```sh
curl -fsSL https://raw.githubusercontent.com/lucaslodeiro/ai-factory/main/scripts/install-macos.sh \
  -o /tmp/ai-factory-install-macos.sh
bash /tmp/ai-factory-install-macos.sh --dir "$HOME/ai-factory"
```

The installer prepares the engine, installs both macOS services, starts the local dashboard and opens its first-time setup page. Credentials and environment settings are completed in the browser. The daemon remains stopped while required setup is incomplete; the first valid **Save and apply** starts and verifies it automatically. In an existing source checkout:

```sh
npm ci
npm run build
npm test
npm run test:scripts
npm run test:all
npm run service -- start dashboard
# Complete Dashboard → Configuration, then:
npm run service -- start daemon
```

Starting the daemon prepares the configured target repository: it clones a missing or empty checkout directory, fills missing local Git author settings from the authenticated GitHub account, and creates and pushes an initial README commit only when the remote has no refs and the checkout has no commits or changes. Existing origins, commits and author settings are preserved; mismatched origins and nonempty remotes without the configured base branch fail with a diagnostic. A failed initial push can be retried without creating another commit. `doctor` remains a diagnostic command. Managed startup failures stop instead of repeatedly restarting; fix the reported cause and start the service again.


The `npm run …` examples above are only for a source checkout. In an installed
factory, `$HOME/ai-factory` is the installation home and has no `package.json`;
use `ai-factory service …`, `ai-factory update` and `ai-factory uninstall` from
any directory.

The installer script suite intentionally exercises real macOS tooling and runs only on macOS. On another platform `test-macos-installer.sh` reports the skip and exits 3, so the gate cannot appear green. Because `test:all` includes that suite, `npm run test:all` is also macOS-only; use `npm test` for the portable TypeScript suite.

Use **Dashboard → Configuration** whenever settings or credentials change. Every option with a safe universal value opens with a default; after GitHub connects, the dashboard suggests the account's demo repository, local clone and approver for any empty required fields. Optional secrets and allowlists remain empty. **Save and apply** validates the full candidate configuration before writing and restarts affected running services automatically. On the installer-opened first-time setup page, a valid save also starts and verifies the stopped daemon; later saves preserve an intentional stopped state. The installer accepts `--dashboard-host` and `--dashboard-port`; when the selected port is occupied it saves and opens the next available port automatically. Changing the address later in Configuration shows the new URL and reconnects after restarting the dashboard. `ai-factory configure` remains a supported terminal recovery path when the dashboard is unavailable; installation and update do not invoke it. Existing settings are preserved during updates.

An installed factory uses `$HOME/ai-factory` as its home by default: source code is isolated in `engine/`, factory-managed target clones in `repos/`, runtime state and logs in `data/`, and configuration in `.env`. `AI_FACTORY_HOME` overrides that home. A developer checkout whose directory is not named `engine` remains self-contained and uses its own root as the home. Existing installations are not migrated; uninstall the old layout and reinstall.

For an interrupted update that already unloaded both services, run `AI_FACTORY_UPDATE_STATE_FILE="$HOME/ai-factory/data/update-state.json" ai-factory update --start-services`. This explicit recovery mode starts both services after a successful update. Normal dashboard updates persist each service's original loaded state before the background job begins and restore that recorded intent after success or failure.

For a clean installer retest, keep the parent terminal outside the checkout. `cd "$HOME" && ai-factory uninstall` removes services, `engine/` and `data/` while preserving `.env`, backups and `repos/`. A small uninstall-only helper keeps the launcher available, so `ai-factory uninstall --purge` can later remove the preserved home after checking managed clones for dirty or unpushed work. You may also use `--purge` directly on the first invocation. Provider credentials and shared command-line tools remain installed in both modes. Use `--yes` only for automated disposable-machine runs and `--force` only after reviewing unpublished work.

Because purge removes `.env`, a reinstall after purge remembers provider login
credentials but not the repository, checkout or approvers. The dashboard starts
for setup and the daemon remains stopped until those required values validate.
Service commands report success only after launchd reaches the requested state;
daemon start additionally waits for the runtime lock created after preflight.

If a failed attempt leaves an incomplete engine, the installer prints safe recovery commands. Move only `$HOME/ai-factory/engine` to an `engine.incomplete-*` sibling, then rerun the installer; preserved `.env` and `repos/` remain in place. The installer never deletes an unrecognized engine automatically. See [installation and operations](INSTALL.md) for the complete command sequence.

The factory engine and target application are separate repositories. `GITHUB_REPOSITORY` selects where issues are read and PRs are created; `FACTORY_REPO_DIR` selects the local clone used for worktrees. A data directory binds to the repository's stable GitHub id on first use and cannot be reused for another or recreated repository. Assign an open issue to the authenticated Factory account, or use the dashboard or `factory start-issue <number-or-url>` to assign it and add this installation's `factory-instance:<name>` label. The daemon starts only after a later poll verifies that this is the sole instance label. Each `factory/issue-<n>` work branch is pushed after every Factory commit; external work-branch and base-branch commits are merged before execution, conflicts stop for human resolution and Retry, and code changed after Test returns to Test before Review or Delivery.

Commands must be the first or last non-empty line of a comment from an authorized approver. Every other line becomes command text. Quoted commands and commands in the middle are ignored. If both the first and last lines are commands, the first wins and the last is treated as text.

An observed prose comment or near-miss such as `/fatcory note` may be edited into a valid command until a later command is applied. Once a comment is processed as a command, later edits never change its outcome. If an issue or repository is deleted and recreated, the old issue work is archived; use an empty data directory for a recreated repository and explicitly assign a recreated issue again.

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

Configuration is managed from the dashboard. The installer creates separate macOS services for the orchestrator and local dashboard. Control them with `ai-factory service <start|stop|restart|status|logs> <daemon|dashboard|all>`. The dashboard defaults to [http://127.0.0.1:4173](http://127.0.0.1:4173), supports persistent light/dark themes, and updates issue stage/status badges, metrics, executions and events over a near-real-time local stream. Recent executions show role, provider/model, duration, provider-reported tokens and interruption reason; exact prompts require an explicit sensitive-content acknowledgement. **Time and tokens by issue** aggregates retries and offers a responsive per-stage breakdown. **Daemon logs** tails bounded output and supports copy.

The local scheduler checks for runnable work every 200 ms and runs one execution at a time. Stage completion does not wait for the GitHub polling interval. GitHub reads and status publication use a separate worker, while workflow state remains owned by the daemon. GitHub-originated comments and merges still depend on the configured polling interval. Dashboard controls show a pending acknowledgement until the daemon records success or failure; queue labels distinguish capacity, maintenance and delivery publication.

The daemon polls new comments normally. **Refresh issue list** reconciles only already tracked issues, advances each to its newest comment and evaluates that comment for the current request; it never imports an issue implicitly or replays old work. Closed issues disappear from operational views. The editable GitHub status comment carries current stage, condition and exactly one action; labels use independent stage and condition dimensions.

Update, daemon stop/restart and daemon-affecting configuration changes first list active tasks and require confirmation. Confirmed tasks are interrupted as maintenance, preserved as `PAUSED` and offered through **Resume paused tasks** after services return. Explicit Cancel remains `CANCELLED`. Configuration → Project also exposes bounded repository Check, clean fast-forward Sync, selected factory-branch Publish, confirmed Clear and empty-directory Restore actions.

The global update area checks `origin` before enabling update and runs through an independent job while the dashboard reconnects. Configuration groups credentials, project, runtime, dashboard, direct role model selection, tools, access and notifications. Slack uses the global **Save and apply** flow, durable delivery retry and a test action. If the dashboard cannot start, use `ai-factory configure`, `ai-factory doctor` and `ai-factory service start all`.

Factory commands include `doctor`, `start`, `start-issue`, `status`, `events`, `cancel`, `retry`, `refresh-list`, `stop --pause-active`, `notifications`, `slack-test`, `models`, `sync`, and `repo <check|sync|publish|clear|restore>`.

Each installation executes agent stages sequentially and is identified by `FACTORY_INSTANCE_NAME`, which defaults to its hostname. Multiple installations may share a repository and GitHub account: assignment to that account offers work, while the single `factory-instance:<name>` label selects the installation. Unassign to pause for a human, reassign to resume, or change the instance label to move work. The local daemon lock still prevents duplicate processes using the same data directory; databases remain local and cross-installation continuation of an existing status comment is reported as pending until context import is implemented.

This repository uses two long-lived branches: `develop` for ongoing work and `main` for stable releases. The installer defaults to `main`; pass `--branch develop` only when intentionally testing unreleased factory changes.

See [installation and operations](INSTALL.md), [GitHub setup](docs/GITHUB_SETUP.md), and [validation evidence and operational boundaries](docs/VALIDATION.md).

Product Architect records a complexity/risk assessment and the deterministic orchestrator uses it for workflow safeguards such as additional architectural review. Configuration → Agent roles chooses Codex or Claude and one direct model for Product Architect, Implementation Engineer, Verification Engineer and Delivery Reviewer. Each model can also be **Auto**, which delegates model choice to its provider. See [model selection policy](docs/MODEL_POLICY.md).

Configuration → Runtime also sets the byte budget for agent context. Optional JSON overrides can target an exact role or `provider/model`; the most specific matching value is recorded with each persisted prompt. Protected specification, decision and instruction context is never silently clipped.

The V3 workflow starts from a fresh factory data directory. It intentionally provides no importer or compatibility reader for earlier workflow databases. Reinstalling preserves the target application repository and the locally stored GitHub, Claude and Codex credentials.

GitHub issues show the workflow through colored stage/condition labels and an updatable status comment. Structured evidence stays in the local audit. The issue remains open until the delivered PR is merged.

Merged PRs reconcile to `DELIVERY/COMPLETED`; a closed unmerged PR remains `DELIVERY/WAITING` with its merge request marked closed until reopened. Run `ai-factory sync` when the daemon is stopped to refresh delivery state without running agents.

### Product tests and installation checks

CI runs `npm run test:all` on macOS for pull requests and pushes to `develop` and `main`. Product tests use controlled configuration and simulated providers; they do not depend on the operator's role settings. Installation and updates never run `npm test` or the functional suite, including when `AI_FACTORY_INSTALL_TESTS` was set by an older installer.

`node scripts/validate-installation.mjs` checks the local Node runtime, compiled assets, writable storage, native SQLite and CLI loading without calling providers or GitHub. During updates it checks database compatibility on a backup copy, not the live database. The updater builds and validates a detached candidate before activating it; preparation failures preserve the installed checkout and dependencies. If service restoration fails after activation, the update remains failed and the daemon is left stopped rather than reporting success or restarting it repeatedly. The backup path remains in the log for recovery.

### Managed browser verification

For Builder and Tester executions whose root package declares Playwright, Puppeteer, Lighthouse or chrome-launcher, the host worker supervisor starts a dedicated headless Chrome/Chromium before the agent. It verifies the debugging endpoint and a browser request to a temporary loopback page. The agent keeps its existing sandbox; the browser uses a fresh temporary profile and loopback-only debugging. No personal browser profile or authenticated session is reused.

The worker receives `FACTORY_BROWSER_STATUS`, `FACTORY_BROWSER_REPORT`, and, on success, `FACTORY_BROWSER_CDP_URL` and `FACTORY_BROWSER_DEBUG_PORT`. Use Playwright `chromium.connectOverCDP(process.env.FACTORY_BROWSER_CDP_URL)` or Puppeteer `connect({browserURL: process.env.FACTORY_BROWSER_CDP_URL})`; pass the debugging port directly to Lighthouse instead of launching another Chrome. Test scripts should support these variables and retain standalone launch as a fallback outside Factory. The supervisor closes the browser and deletes its profile on completion, cancellation, timeout or daemon disconnection. `data/runs/<execution>/browser.json` records readiness or the actual failure. Readiness is not acceptance evidence for the application.

Chrome is discovered in the standard macOS application paths or Linux PATH. Set `FACTORY_BROWSER_EXECUTABLE` to an absolute executable path for a custom installation. No browser installation or permissions change is performed automatically. Missing or unusable browsers are reported to the worker; required browser checks must produce `environment-blocked` rather than an architectural consultation. Projects that add browser dependencies during their first run, or declare them only in nested workspace packages, need a subsequent execution with a root dependency declaration for automatic provisioning. This is a browser capability, not an unrestricted host command runner.

### Tester writes and verification evidence

Factory captures file contents, modes and index state before each agent execution. Restricted-role checks compare that baseline with the final workspace, and Tester commits include only its validated changes. The Builder retains ownership of the complete pending implementation across retries, with credential checks covering every file it commits. Existing files are preserved; an unchanged artifact from an earlier attempt is not attributed to the new agent. Pre-existing uncommitted code/configuration that has not been reviewed blocks acceptance with a separate diagnostic rather than being silently committed or treated as new Tester edits.

The Tester may modify test paths (`test/`, `tests/`, `__tests__/`, `spec/`, `specs/`, or `*.test.*` / `*.spec.*`) and write passive artifacts under the default `evidence/` directory. Artifacts are limited to JSON, Markdown, text, CSV and raster screenshots. Executables, links, hidden paths, manifests, lockfiles, credentials and policy changes are rejected, with the offending filenames included in the error.

Projects can declare other artifact directories and additional test entrypoints in `.factory/verification.json`, before the Tester runs:

```json
{
  "evidenceDirectories": ["evidence", "reports/qa"],
  "testFiles": ["scripts/verify.mjs", "scripts/performance.mjs"]
}
```

Paths are explicit repository-relative names, without glob patterns or parent/hidden segments. The policy is pinned at execution start; the Tester cannot expand its own permissions. Review this file as part of project configuration. Artifact directories must be dedicated to verification, not application assets or configuration. Evidence from prior executions is not proof that the current execution passed its acceptance criteria.

### Current-format policy

Factory accepts only the current database schema, workflow identities and structured agent result contract. It does not migrate stored workflows, repair results from older formats, or republish unchanged GitHub comments on version upgrades. Unsupported data is reported rather than silently converted. Update no longer accepts the deprecated `--defaults` option; `configure --defaults` remains a supported non-interactive configuration action. The installation validator checks a disposable database copy and never migrates the live database.

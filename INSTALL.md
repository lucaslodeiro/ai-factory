# macOS installation

## Installation and updates from GitHub

Download the installer and run it on the destination Mac (Homebrew is needed if Git, Node or gh are missing):

```sh
curl -fsSL https://raw.githubusercontent.com/lucaslodeiro/ai-factory/main/scripts/install.sh -o /tmp/ai-factory-install.sh
bash /tmp/ai-factory-install.sh --dir "$HOME/ai-factory"
```

The installer defaults to the stable `main` branch. The repository has only two long-lived branches: `develop` for ongoing work and `main` for stable releases. Pass `--branch develop` only when intentionally testing unreleased factory changes. The installer installs missing tools, clones the engine, installs locked npm dependencies, builds and tests. It creates a private `.env` from safe defaults, installs both user services, starts the dashboard, waits for its health check and opens the first-time setup page in the default browser. Credentials and environment settings are completed there. The daemon stays stopped, so no agent runs before setup is complete. Existing destinations are rejected. `--skip-tools` skips machine tool installation; Node 22+, npm and Git must already work. Automatic tool installation is macOS-only. Provider installers: [Codex](https://developers.openai.com/codex/cli), [Claude](https://code.claude.com/docs/en/setup).

The opened dashboard expands **Configuration** and displays a first-time guide. Every setting with a safe universal value starts with an installation default. After GitHub connects, empty target fields receive editable suggestions for `<login>/ai-factory-demo`, `$HOME/Source/ai-factory-demo`, and the same login as approver. Optional secrets and allowlists remain empty intentionally. Review and save the configuration, then start the daemon from **Services**. The guide can be dismissed without changing configuration.

Installer options:

| Option | Default | Purpose |
|---|---|---|
| `--dir PATH` | `$HOME/ai-factory` | Engine installation directory |
| `--repo URL` | This GitHub repository | Engine source repository |
| `--branch NAME` | `main` | Engine branch to install (`develop` opts into unreleased changes) |
| `--dashboard-host LOOPBACK` | `127.0.0.1` | Initial dashboard address: `127.0.0.1`, `localhost` or `::1` |
| `--dashboard-port PORT` | `4173` | Initial dashboard port |
| `--skip-tools` | off | Require existing tools instead of installing missing ones |

`--defaults` is accepted temporarily as a deprecated no-op so older automated install commands do not break.
If the selected port is already occupied, installation chooses the next available port, saves it in `.env`, prints the change and opens the effective URL. For example:

```sh
bash /tmp/ai-factory-install.sh --dashboard-host localhost --dashboard-port 5173
```

## Alternative macOS installation without Homebrew

This installer keeps user-managed binaries under `~/.local` and never installs Homebrew:

```sh
curl -fsSL https://raw.githubusercontent.com/lucaslodeiro/ai-factory/main/scripts/install-macos-no-brew.sh \
  -o /tmp/ai-factory-install-no-brew.sh
bash /tmp/ai-factory-install-no-brew.sh --dir "$HOME/ai-factory"
```

It supports Apple Silicon and Intel Macs. It downloads the latest Node 22 archive from Node.js and the latest GitHub CLI macOS archive from GitHub Releases, verifies both SHA-256 checksums published by their projects, and links their executables into `~/.local/bin`. Codex and Claude are installed with their official native installers. It then invokes the standard factory installer with `--skip-tools`, forwarding options such as `--dir` and `--branch`.

Git comes from Apple's Command Line Tools. If they are absent, the script runs `xcode-select --install`, exits, and asks you to rerun it after completing Apple's graphical installation. It does not accept an Xcode license or request administrator credentials itself. Existing regular files in `~/.local/bin` are never overwritten. Add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile for later terminals.

## Uninstall and clean reinstall

Run the uninstaller while the parent shell remains outside the directory that
will be removed:

```sh
cd "$HOME"
ai-factory uninstall
```

The installer places `ai-factory` in `~/.local/bin`, so service, update,
configuration and factory commands work from any directory. If that directory
is not yet on the current shell's `PATH`, use
`npm --prefix "$HOME/ai-factory" run uninstall` instead.

The uninstaller prints the exact installation, runtime-data and LaunchAgent paths, then requires typing `uninstall`. It cancels any transient factory update before stopping the two services and removing files. For an automated disposable-machine test, use `ai-factory uninstall --yes`.

If an older uninstall left a terminal pointing at the removed checkout, run
`cd "$HOME"` before using that terminal again. Both installers now recover
automatically from that stale working directory, but other commands cannot.

If installation reports `An incomplete or unrelated destination already
exists`, preserve that directory and retry from a clean destination:

```sh
cd "$HOME"
mv "$HOME/ai-factory" "$HOME/ai-factory.incomplete-$(date +%Y%m%d-%H%M%S)"
bash /tmp/ai-factory-install-no-brew.sh --dir "$HOME/ai-factory"
```

The installer prints these same recovery commands with the resolved paths. It
does not remove or overwrite an unrecognized directory automatically.

The service launcher exposes the same operation in its help and can be used as an alias: `npm run service -- uninstall` or `npm run service -- uninstall --yes`. Run `npm run service -- --help` to see every launcher action.

It stops and removes both factory LaunchAgents, the engine checkout, `.env` and backups, SQLite, logs and retained worktrees. A configured external data directory is removed only when it contains the factory database marker; unsafe paths are rejected. The target application repository is preserved, as are global GitHub/Codex/Claude credentials and shared Node, Git, `gh`, Codex and Claude installations. This leaves the Mac ready to exercise the installer again without deleting unrelated development data.

To update an existing installation, first stop its daemon and wait for it to exit:

```sh
cd "$HOME/ai-factory"
npm run factory -- stop
# After the daemon has exited:
bash scripts/update.sh
npm run factory -- doctor
npm run service -- restart all
```

The updater requires the existing built runtime and dependencies. It adds `~/.local/bin` to `PATH`, uses the current branch on `origin`, refuses local changes/local-only commits and holds the daemon lock throughout the update. It backs up SQLite and `.env` under `FACTORY_DATA_DIR/update-backup-*`, applies a fast-forward, installs locked dependencies, builds and tests, and preserves configuration without prompting. It never opens a terminal wizard, authenticates accounts or provisions a repository. A failed build/test leaves the daemon stopped and prints the backup and previous revision for diagnosis; there is no destructive automatic rollback. Backups contain private data: keep them local.

`--restart-services` preserves the service state it observes when the command starts. If a previous interrupted update already unloaded both services, use the explicit recovery mode so both are started after a successful update:

```sh
cd "$HOME/ai-factory"
AI_FACTORY_UPDATE_STATE_FILE="$PWD/.factory/update-state.json" \
  bash scripts/update.sh --start-services
```

## Configuration lifecycle

Installation opens `http://127.0.0.1:4173/?setup=1` by default, or the effective custom/fallback address selected during installation. The dashboard reads installation defaults plus any saved `.env` and groups them by purpose. **Save and apply** validates the complete candidate configuration before changing `.env`, temporarily stops affected running services, writes atomically with owner-only permissions, and restores those services. Stopped services remain stopped. Updates preserve `.env` without asking questions.

Connect GitHub, Claude and Codex from **Configuration → Credentials**. Once GitHub reports Connected, the dashboard fills editable defaults for the target repository, clone and authorized approver when those fields are empty. The clone must already exist and have its `origin`, default branch, and Git author configured. Then save and start the daemon from **Services**.

`npm run configure` remains a supported terminal recovery path when the dashboard cannot start or its address is misconfigured. It is not called by installation or update.

| Setting | Meaning | Example |
|---|---|---|
| `GITHUB_REPOSITORY` | GitHub repository used for issues, comments and PRs | `owner/application` |
| `FACTORY_REPO_DIR` | Absolute path to a local clone of that repository | `/Users/me/Source/application` |
| `GITHUB_DEFAULT_BRANCH` | PR/worktree base branch | `main` |
| `FACTORY_APPROVERS` | Comma-separated GitHub users allowed to answer/approve | `alice,bob` |
| `FACTORY_DATA_DIR` | SQLite, logs and retained worktrees for this target | `/Users/me/.ai-factory/application` |
| `FACTORY_DASHBOARD_HOST` | Dashboard bind address; loopback only | `127.0.0.1` |
| `FACTORY_DASHBOARD_PORT` | Dashboard HTTP port | `4173` |

Run `npm run factory -- doctor` after configuring. It validates the required values, target clone, Git/GitHub access, provider authentication and writable database.

## macOS services and dashboard

Installation and update generate two user LaunchAgents under `~/Library/LaunchAgents`: `com.ai-factory.daemon` runs the orchestrator and `com.ai-factory.dashboard` serves the local administration UI. They use the same installation directory and `.env`, but remain independently controllable. No administrator access is required.

```sh
npm run service -- start daemon
npm run service -- start dashboard
npm run service -- status all
npm run service -- restart dashboard
npm run service -- stop daemon
npm run service -- stop all
npm run service -- logs daemon
npm run service -- logs dashboard
npm run service -- logs all
npm run service -- uninstall
```

The `logs` action prints the last 100 stdout/error lines and continues following both files until `Ctrl+C`. Installation, update, service start and service restart print the configured dashboard URL plus the status, restart, log and stop commands so the next operational step is visible without reopening this document.

Open `http://127.0.0.1:4173` after starting the dashboard. It shows daemon health, the issue queue, recent agent executions and readable audit events. Its persistent theme selector follows the operating-system preference initially and switches between light and dark modes. Issue status badges, the complete issue list, metrics, executions and events update through a local Server-Sent Events stream every two seconds; a visible Live/Reconnecting badge reports stream health and a 15-second poll remains as fallback. Retry, Cancel and Stop actions write to the same durable control queue as the CLI.

**Recent executions** identifies the issue, agent role, provider/model, current result, elapsed time, start time and exit code for each run. **Recent events** translates the internal audit into workflow, agent, approval, recovery, GitHub and delivery activity with plain-language titles, relevant evidence, severity and a link back to the affected issue.

Open **Daemon logs** below Services to inspect recent standard output and errors without using a terminal. While the section is open it refreshes every two seconds, preserves your scroll position unless you are following the bottom, and can show or copy the last 100, 200, 500 or 1,000 lines. The endpoint reads only `.factory/service-logs/daemon.log` and `daemon.error.log` and caps each read, so it never accepts arbitrary file paths or loads an entire large log.

The daemon polls comments normally; no manual refresh is needed for `/factory answer`, `/factory approve` or `/factory retry`. It evaluates commands only in the workflow states where they apply and advances past non-actionable comments in other stages so they cannot be replayed later.

**Refresh issue list** is the single manual reconciliation action. It asks the running daemon to fetch open issues carrying a managed workflow-state label and updates the title, body and URL of known items. For every tracked issue it advances the saved position to the newest GitHub comment, skips any older unread comments and evaluates only that newest comment according to the current state: `answer` or `approve` while waiting for a person, and `retry` while failed, paused or cancelled. It never starts an unlabeled issue or reruns completed stages. The dashboard reports when the request is queued and then shows the found, added and updated counts or the concrete GitHub error; if the daemon is stopped, it tells you to start it instead of silently leaving a request pending. If an issue has a managed state label but its local database record is missing, the factory restores it as `PAUSED`, records the latest human answer and evaluates the newest comment. A valid newest retry restarts at Product Architect because GitHub labels and comments do not contain enough evidence to resume a later agent stage safely. The CLI equivalent is `ai-factory refresh-list` or `npm run factory -- refresh-list`.

The service cards start, restart and stop the daemon or dashboard independently. Above them, the global update area shows the installed package version and Git revision. It fetches the checked-out branch from `origin` on load and every five minutes; **Update Factory** is offered only when the remote commit is a valid fast-forward. The server repeats that check immediately before starting the update.

The update action records which services are loaded and submits an independent one-shot `launchd` job. That job stops the daemon while leaving the dashboard available, waits for its graceful shutdown to release the runtime lock, runs `scripts/update.sh --restart-services`, and downloads, builds and tests the new revision. Its small wrapper uses only macOS base tools until `update.sh` establishes the installed toolchain path, and remains compatible with jobs submitted by the preceding version while its own files are replaced. It refuses to run again after the persisted state becomes completed or failed and explicitly removes its own transient label on exit. Only after validation succeeds does it refresh both LaunchAgents and briefly restart the dashboard; it then restores the daemon when it was previously running. Progress is persisted on disk, and a stale PID is verified as an updater process before it can keep the UI locked. The dashboard reports the active checkout, daemon-shutdown wait, download, backup, dependency, build and validation phase plus elapsed time. Network, dependency, build and test commands have bounded execution times; a timeout or command failure replaces **Updating…** with the concrete failing stage. When the restarted dashboard reports a different revision, the browser reloads the new frontend automatically. Follow details with `tail -f .factory/service-logs/update.log`. If any phase fails, the dashboard remains available to show the failure and every service that was running before the attempt is restored; inspect the log before retrying.

The **Configuration** panel has eight categories. **Credentials** reports authentication for GitHub, Claude and Codex plus the Slack connection state. **Connect** starts that provider's official CLI login in the background and opens its browser flow on the Mac running the dashboard. For an active GitHub account, **Reconnect** uses `gh auth refresh --reset-scopes` so it opens a fresh authorization flow without the terminal confirmation required by a second `gh auth login`; Claude and Codex use their normal login command. Complete the provider page and use **Refresh status** if the card has not updated yet. CLI credentials stay in each provider's local secure store. The dashboard never receives or displays their tokens. Login output is available in `.factory/service-logs/credentials.log`. The Slack card opens its dedicated **Notifications** configuration.

The other seven categories edit the installation's `.env` without exposing secrets to the browser. They cover project and GitHub, runtime, dashboard, agent roles, agent tools, access and secrets, and notifications. A required-setup notice appears only when a missing credential selected by an agent role, repository setting, approver, target checkout, Git identity or matching origin prevents the factory from processing a project; it disappears automatically after the configuration becomes usable. **Agent roles** has a card for Product Architect, Developer, QA and Reviewer. Each card selects Codex or Claude and one direct model. **Auto** omits the model argument and lets that provider use its recommended/default model; choosing a concrete model passes that exact ID on every invocation of the role. Changing the provider refreshes the choices, and existing custom model IDs remain selectable. Every field shows its environment-variable name and which service must restart. **Notifications** shows Slack delivery state and counters first, then accepts an HTTPS Slack Incoming Webhook through the same global **Save and apply** action. It can send a test notification. The webhook is write-only: the API reports only whether it is configured and never sends its value back to the browser. Leaving the input blank preserves it; selecting **Clear configured secret** and saving removes it. Values are validated with the same constraints as the terminal configurator. Each save creates a private `.env.backup-*` and atomically replaces `.env` with owner-only permissions. Unknown existing settings are preserved.

The configuration form remains editable while the daemon is running. On save, the server validates every value first; invalid input leaves both `.env` and service state untouched. It then stops only affected running services, saves, and starts them again. When the dashboard itself must restart, the page displays the effective URL and reconnects there automatically.

If broken configuration prevents the dashboard from starting, recover from a terminal:

```sh
cd "$HOME/ai-factory"
npm run service -- stop all
npm run configure
npm run factory -- doctor
npm run service -- start all
```

The terminal configurator also validates before replacing `.env`, creates a private backup, and preserves unknown settings. It intentionally requires services to be stopped because it cannot coordinate a dashboard restart while repairing it.

The HTTP server accepts only a loopback bind address. For private remote access, keep it on `127.0.0.1` and publish it inside your tailnet with Tailscale Serve:

```sh
tailscale serve --bg http://127.0.0.1:4173
tailscale serve status
```

On a Mac where the Tailscale application is installed but its CLI is not in `PATH`, use `/Applications/Tailscale.app/Contents/MacOS/Tailscale` in place of `tailscale`. Open the HTTPS `.ts.net` URL printed by Serve; `http://100.x.y.z:4173` does not work because the dashboard deliberately does not bind to the Tailscale interface. Tailnet access rules determine who can reach the administrative UI. Do not use Tailscale Funnel, which would publish it to the public internet. Service stdout and stderr are stored under `.factory/service-logs`.

`install` and `update` refresh both service definitions. Existing loaded services are reloaded so path/runtime changes take effect; stopped services remain stopped. Stop the daemon before updating because the updater refuses to modify an installation with an active orchestration lock.

## Projects and concurrency

The engine repository and target application repository are separate. Set `GITHUB_REPOSITORY=owner/application` and `FACTORY_REPO_DIR=/absolute/path/to/application`; issues and PRs belong to that target. Start an open issue from the dashboard, with `ai-factory start-issue <number-or-url>`, or with a standalone `/factory start` comment from a configured approver.

For two projects, use two factory installations with separate `.env`, target clones and `FACTORY_DATA_DIR` values, and start each in its own terminal. Within one instance, agent stages run sequentially; another issue can advance while one is waiting for human approval. Simultaneous agents within one project and multiple instances targeting the same repository are not supported. Locks protect a data directory on one host, not a repository across hosts.

## Manual installation

Use Node 22 or newer (Node 22 LTS recommended), Git, GitHub CLI, Codex CLI and Claude Code. Authenticate from Dashboard → Configuration → Credentials, or run `gh auth login`, `codex login`, and `claude auth login` before starting.

```sh
git clone --branch main https://github.com/lucaslodeiro/ai-factory.git
cd ai-factory
npm ci
npm run build
npm test
cp .env.example .env
npm run service -- start dashboard
```

Open Dashboard → Configuration. Set `FACTORY_REPO_DIR` to a clone of the **target application**, `GITHUB_REPOSITORY` to its owner/name, `GITHUB_DEFAULT_BRANCH` to its base branch and `FACTORY_APPROVERS` to the comma-separated GitHub logins who can make decisions. Use a different `FACTORY_DATA_DIR` per target. The local target clone needs origin configured, the base branch pushed, and Git author name/email configured. Worktrees start at the fetched remote base; uncommitted changes in the source checkout are not included.

The daemon reads `.env` from its working directory. Run commands from the factory checkout. `CODEX_COMMAND`, `CLAUDE_COMMAND` and `GIT_COMMAND` accept absolute executable paths (not shell command strings). Ensure Node 22+ and the working Git executable are first in PATH so worker tools find them too. On Macs with multiple Git installations, an Xcode license error can be avoided by selecting a separately installed Git.

```sh
npm run factory -- doctor
npm run factory -- start
# In another terminal, in the same directory:
npm run factory -- status
npm run factory -- events <work-item-id>
npm run factory -- cancel <work-item-id-or-run-id>
npm run factory -- retry <work-item-id>
npm run factory -- stop
```

`start` runs in the foreground. A lock prevents a second daemon for the same data directory. `cancel`, `retry` and `stop` persist requests; the running daemon acknowledges them in `events`. If stopped, run `start` to process queued requests. Stop pauses active items and terminates their agents; restart then retry each paused item explicitly. Status and events never perform recovery. Cancelled/failed/paused items preserve their retry stage. Retry only after the previous process has stopped and its worktree has been inspected.

An authorized approver can also retry from the same GitHub issue by posting this as a new standalone comment:

```text
/factory retry
```

The daemon validates the author, consumes each comment only once and resumes the saved stage. Bot comments, quoted commands and comments from users outside `FACTORY_APPROVERS` cannot trigger a retry. The dashboard Retry action and the CLI command use the same safety checks. Factory-authored issue comments end with **Next action** or **Next actions**. Copyable commands use fenced blocks, each alternative is labeled, and automatic workflow messages explicitly state when no response is needed. The persistent `WAITING_HUMAN` progress comment explains whether it needs specification approval, clarification, or guidance after the correction limit.

Agent timeouts are configurable. SIGTERM escalates to SIGKILL after one second for a process group that does not exit. After a crash, interrupted executions are recorded as interrupted and the work item becomes FAILED. A stage checkpoint also detects crashes after provider exit but before the workflow state was committed. Each new run has a supervisor connected to the daemon by IPC. If the daemon dies, the supervisor terminates its worker group. Retry checks that any interrupted group is gone before proceeding, without signalling saved PIDs. Old bootstrap runs without a supervisor may still require manual process inspection. Worktrees and logs are retained for diagnosis.

When a workflow enters FAILED, its issue receives a structured troubleshooting comment with the failed stage, matching agent execution, provider/model, process result, sanitized reason and up to 30 recent `stderr` lines. Common credential patterns, configured secret environment values, ANSI control codes and local checkout paths are removed or replaced before publication. The full local logs remain available in the dashboard and under `FACTORY_DATA_DIR`.

When an issue is recovered after its previous worktree directory disappeared, Retry prunes stale Git worktree registrations and reuses the issue's existing local or remote `factory/issue-*` branch. A branch is never recreated over existing work; if Git reports that the branch is actively checked out elsewhere, inspect that checkout before retrying.

## First end-to-end run

Create an open feature issue, then post this standalone comment as a configured approver:

```text
/factory start
```

You can instead enter its number or URL in the dashboard's **Start issue** field or run `ai-factory start-issue <number-or-url>`. The daemon validates the issue and caller, creates the workflow labels itself, and starts Product Architect in a fresh process using its configured provider. Questions are posted on the issue; answer with a standalone command:

```text
/factory answer
<your answer or requested changes, which may span multiple lines>
```

Always post the command as a new comment. Editing a comment the factory already read does not create a new GitHub comment ID and will not reactivate the workflow.

The proposed spec is versioned in SQLite and posted to GitHub. Approve its exact version:

```text
/factory approve v1
```

Only configured approvers with GitHub user accounts can approve. Quoted commands, stale versions and bot comments are ignored. Every role runs in a separate fresh provider process using its configured Codex or Claude mapping. Passing review pushes the work branch and creates a PR. The factory never merges it.

Findings route automatically to Developer or Product Architect. Product Architect can resolve tactical consultations under the same approved spec without human interruption. Major changes and revised specs require a new approval. After the configured correction limit, human guidance is required. QA may change files under test/tests/spec directories or files named `.test.*` / `.spec.*`; other changes fail the run for inspection. Adjust your test layout to this MVP policy.

## Credentials and isolation

Dashboard credential actions invoke only the installed `gh`, Claude and Codex login commands. They do not accept a command or token from the browser. GitHub login also runs `gh auth setup-git` after authentication so HTTPS Git operations use the stored account. A detached login can continue while the dashboard refreshes; its card remains **Connecting…** until the CLI exits or authentication becomes valid.

Worker environments contain only basic OS variables, provider config location and explicitly allowlisted variables. Local provider credential stores remain available for CLI authentication. This is an environment filter, not a security boundary against malicious code running as your user. Use trusted repositories or an external sandbox/account for untrusted code. Codex uses its workspace sandbox with network access. Claude receives edit/write/shell tools only for Developer and QA; Product Architect and Reviewer remain read-only. Provider-independent role mutation checks reject unexpected worktree edits before committing, including every Product Architect or Reviewer edit and QA production-code edits. The orchestrator owns commits, pushes and PR creation. It verifies the assigned branch before executing agents and before committing, rejects detached HEAD, and checks both source and destination of renames against role restrictions.

GitHub comments use a durable, idempotent delivery queue. If reading human replies fails, the item remains waiting and retries on the next poll without losing its approval cursor. Slack is optional and uses its own persistent queue. Failures retry with backoff up to five minutes without blocking the workflow. Human-action messages contain an issue link, question/spec summary and response command. Delivery is at least once, so a crash during acknowledgement can cause a duplicate. SQLite, specs, reports and execution logs live under `FACTORY_DATA_DIR`. Do not commit them or `.env`.

## Provider references

- [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude programmatic execution](https://code.claude.com/docs/en/headless)
- [Claude installation and authentication](https://code.claude.com/docs/en/setup)

## Current boundaries

One foreground daemon per target/data directory, sequential work-item execution, no automatic merge, and no remote execution service. Claude and Codex accounts must be authenticated locally. Old bootstrap items without issue context are rejected explicitly; use a fresh data directory for the first run. Unit/integration tests simulate provider reasoning and GitHub; a live provider demo is a separate acceptance check.

## Slack configuration and diagnosis

In the dashboard, open **Configuration → Notifications**, paste the Slack Incoming Webhook and choose **Save connection**. The URL is validated before saving and a running daemon is restarted automatically. **Send test notification** uses the saved value immediately. The same screen shows pending, failed and sent counts plus the most recent delivery error. Slack also appears in **Credentials** as a connection summary.

The terminal alternative is to set `SLACK_WEBHOOK_URL` only in your local `.env` and run `npm run factory -- slack-test`. Use `npm run factory -- notifications` to inspect individual pending/sent deliveries, attempts and retry times. Notifications use Slack Block Kit and identify the project, issue, readable workflow status, relevant evidence and direct GitHub link. Human gates emphasize the required action and exact command; failures include the recorded cause and retry command. The daemon retries pending notifications after restart. If Slack is disabled, messages remain pending until it is configured. Do not put webhook secrets into GitHub issues or tracked files.

## Structured reports and upgrades

All provider results now require coverage, test evidence, changed files, dependency rationale, decisions and review checks. See `templates/EXECUTION_RESULT.md`. Schemas migrate transactionally when opening SQLite, including concurrent CLI/daemon startup. Previously approved specs without structured acceptance criteria are not silently grandfathered into PASS: regenerate and approve a new spec. Existing raw agent outputs remain in the audit history.

Delivery roles cannot alter the approved specification. The provider schema requests inert values for `spec`, `acceptanceCriteria`, `taskAssessment` and `nextRole`; the orchestrator also forces those fields to inert values before validating Developer, QA and Reviewer reports because provider structured-output implementations may not enforce every enum or zero-length-array constraint. Coverage, test evidence, findings and all other delivery requirements remain strictly validated.

`status` shows the saved retry stage and any interrupted stage checkpoint. Partial work is retained; retry reruns the stage and asks the worker to inspect and verify it. Processes that deliberately detach into other groups and legacy pre-supervisor runs may require manual inspection.

## Models per task

Run `npm run factory -- models` to inspect each role's provider and direct model selection. Use the dashboard or `npm run configure` to choose the eight role settings in `.env` (provider and model for four roles); `.env.example` remains the installation-default template. `npm run factory -- models <work-item-id>` previews the configured selections and workflow assessment without running providers. New specs include a complexity/risk assessment for your approval. See [model policy](docs/MODEL_POLICY.md) for workflow safeguards, audit events and legacy migration. Model availability is checked by the actual provider invocation, not by `doctor`; a rejected model requires configuration correction and explicit retry.

Worker prompts include the actual daemon Node executable and configured Git, plus an explicit PATH prefix for shell commands: login-shell startup files may otherwise select an older Node or Xcode Git. Verify the tool versions in run logs. Reviewer receives QA commands/results as attributed evidence and does not claim to have executed them personally.

## After PR delivery

The daemon reconciles READY_TO_MERGE and PR_CLOSED items against GitHub. Merge records MERGED with timestamp/commit; closing without merging records PR_CLOSED; reopening resumes READY_TO_MERGE tracking. GitHub handles issue closure via the PR closing reference. With the daemon stopped, `npm run factory -- sync` performs one synchronization and flushes pending reports/notifications without running agents. The shared singleton lock prevents concurrent daemon/sync execution.

To exercise installer/updater safeguards using temporary local repositories and a stub npm (no CLI installations or agents), run `node scripts/test-maintenance.mjs` after `npm run build`. The regular `npm test` suite validates the actual runtime.

## Configuration details and safeguards

The dashboard is the normal configuration interface. The terminal wizard remains a supported recovery interface for a headless Mac or a dashboard that cannot start:

```sh
npm run configure
# equivalent: bash scripts/configure.sh
```

Installation and update do not invoke this wizard. Dashboard fields cover every option in `.env.example`, including target repository/clone, approvers, data directory, polling, timeouts, correction limits, CLI executables, models and optional Slack. Invalid values are explained when saving; `doctor` must pass before the daemon can operate correctly.

Slack webhook input/defaults are hidden. Unknown existing environment settings are preserved. Saving through the terminal recovery flow or dashboard creates a private `.env.backup-*` and replaces `.env` atomically with owner-only permissions; these files are ignored by Git. The dashboard coordinates affected services automatically; stop all services before using terminal recovery. Changing paths/repositories does not migrate existing data or clone a target repository. Use a separate installation/data directory for a different project.

The fallback supports `npm run configure -- --defaults` to save existing/template values without questions. It never runs during installation or update. Check configuration with `npm run factory -- doctor`.

Configuration regression checks: `node scripts/test-configure.mjs`.
Uninstall regression check: `node scripts/test-uninstall.mjs`.

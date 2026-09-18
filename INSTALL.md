# macOS installation

## Installation and updates from GitHub

Download the installer and run it on the destination Mac (Homebrew is needed if Git, Node or gh are missing):

```sh
curl -fsSL https://raw.githubusercontent.com/lucaslodeiro/ai-factory/main/scripts/install.sh -o /tmp/ai-factory-install.sh
bash /tmp/ai-factory-install.sh --dir "$HOME/ai-factory"
```

The installer defaults to the stable `main` branch. The repository has only two long-lived branches: `develop` for ongoing work and `main` for stable releases. Pass `--branch develop` only when intentionally testing unreleased factory changes. The installer installs missing tools, clones the engine, installs locked npm dependencies, builds, tests and opens the interactive configurator to create a private `.env`. Enter accepts each displayed default. Use `--defaults` to write installation defaults without prompting (target settings remain blank). It does not authenticate accounts or start agents. Existing destinations are rejected. `--skip-tools` skips machine tool installation; Node 22+, npm and Git must already work. Automatic tool installation is macOS-only. Provider installers: [Codex](https://developers.openai.com/codex/cli), [Claude](https://code.claude.com/docs/en/setup).

Installer options:

| Option | Default | Purpose |
|---|---|---|
| `--dir PATH` | `$HOME/ai-factory` | Engine installation directory |
| `--repo URL` | This GitHub repository | Engine source repository |
| `--branch NAME` | `main` | Engine branch to install (`develop` opts into unreleased changes) |
| `--skip-tools` | off | Require existing tools instead of installing missing ones |
| `--defaults` | off | Save configuration defaults without interactive questions |

## Alternative macOS installation without Homebrew

This installer keeps user-managed binaries under `~/.local` and never installs Homebrew:

```sh
curl -fsSL https://raw.githubusercontent.com/lucaslodeiro/ai-factory/main/scripts/install-macos-no-brew.sh \
  -o /tmp/ai-factory-install-no-brew.sh
bash /tmp/ai-factory-install-no-brew.sh --dir "$HOME/ai-factory"
```

It supports Apple Silicon and Intel Macs. It downloads the latest Node 22 archive from Node.js and the latest GitHub CLI macOS archive from GitHub Releases, verifies both SHA-256 checksums published by their projects, and links their executables into `~/.local/bin`. Codex and Claude are installed with their official native installers. It then invokes the standard factory installer with `--skip-tools`, forwarding options such as `--dir`, `--branch` and `--defaults`.

Git comes from Apple's Command Line Tools. If they are absent, the script runs `xcode-select --install`, exits, and asks you to rerun it after completing Apple's graphical installation. It does not accept an Xcode license or request administrator credentials itself. Existing regular files in `~/.local/bin` are never overwritten. Add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile for later terminals.

To update an existing installation, first stop its daemon and wait for it to exit:

```sh
cd "$HOME/ai-factory"
npm run factory -- stop
# After the daemon has exited:
bash scripts/update.sh
npm run factory -- doctor
npm run factory -- start
```

The updater requires the existing built runtime and dependencies. It uses the current branch on `origin`, refuses local changes/local-only commits and holds the daemon lock throughout the update. It backs up SQLite and `.env` under `FACTORY_DATA_DIR/update-backup-*`, applies a fast-forward, installs locked dependencies, builds and tests, and then opens the same configurator used by installation. Existing settings are its defaults and newly added settings use the installation defaults. It preserves configuration, logs and worktrees; it never restarts the daemon or updates provider CLIs. A failed build/test leaves the daemon stopped and prints the backup and previous revision for diagnosis; there is no destructive automatic rollback. Backups contain private data: keep them local. Use the same Node/Git PATH as for running the daemon. Use `bash scripts/update.sh --defaults` for a non-interactive update that accepts all existing/default values.

## Configuration lifecycle

Installation, update and direct configuration all use the same wizard:

```sh
# Inspect or change configuration without installing/updating:
npm run configure

# Install without questions, leaving required target values blank:
bash /tmp/ai-factory-install.sh --defaults

# Update without questions, retaining existing values:
bash scripts/update.sh --defaults
```

For each known option, the displayed/effective value is selected in this order:

1. The value saved in `.env`, including an intentionally empty value.
2. For Codex, Claude and Git commands, a locally discovered executable when no saved value exists.
3. The installation default in `.env.example` for every other missing value.

Shell environment variables are not imported into `.env`. In the interactive wizard, Enter retains the displayed value and `-` clears an optional setting. Each save creates an ignored, owner-readable `.env.backup-*` file and atomically replaces `.env`. Stop the daemon before configuring. Changing target paths does not move data, migrate worktrees or clone another repository.

The target repository, local clone and approvers intentionally have no installation default. Configure these before starting:

| Setting | Meaning | Example |
|---|---|---|
| `GITHUB_REPOSITORY` | GitHub repository used for issues, comments and PRs | `owner/application` |
| `FACTORY_REPO_DIR` | Absolute path to a local clone of that repository | `/Users/me/Source/application` |
| `GITHUB_DEFAULT_BRANCH` | PR/worktree base branch | `main` |
| `FACTORY_APPROVERS` | Comma-separated GitHub users allowed to answer/approve | `alice,bob` |
| `FACTORY_DATA_DIR` | SQLite, logs and retained worktrees for this target | `/Users/me/.ai-factory/application` |

Run `npm run factory -- doctor` after configuring. It validates the required values, target clone, Git/GitHub access, provider authentication and writable database.

## Projects and concurrency

The engine repository and target application repository are separate. Set `GITHUB_REPOSITORY=owner/application` and `FACTORY_REPO_DIR=/absolute/path/to/application`; issues and PRs belong to that target. Only open issues labeled `factory:queued` are ingested.

For two projects, use two factory installations with separate `.env`, target clones and `FACTORY_DATA_DIR` values, and start each in its own terminal. Within one instance, agent stages run sequentially; another issue can advance while one is waiting for human approval. Simultaneous agents within one project and multiple instances targeting the same repository are not supported. Locks protect a data directory on one host, not a repository across hosts.

## Manual installation

Use Node 22 or newer (Node 22 LTS recommended), Git, GitHub CLI, Codex CLI and Claude Code. Authenticate `gh auth login`, `codex login`, and `claude auth login` before starting.

```sh
git clone --branch main https://github.com/lucaslodeiro/ai-factory.git
cd ai-factory
npm ci
npm run build
npm test
npm run configure
```

Set `FACTORY_REPO_DIR` to a clone of the **target application**, `GITHUB_REPOSITORY` to its owner/name, `GITHUB_DEFAULT_BRANCH` to its base branch and `FACTORY_APPROVERS` to the comma-separated GitHub logins who can make decisions. Use a different `FACTORY_DATA_DIR` per target. The local target clone needs origin configured, the base branch pushed, and Git author name/email configured. Worktrees start at the fetched remote base; uncommitted changes in the source checkout are not included.

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

Agent timeouts are configurable. SIGTERM escalates to SIGKILL after one second for a process group that does not exit. After a crash, interrupted executions are recorded as interrupted and the work item becomes FAILED. A stage checkpoint also detects crashes after provider exit but before the workflow state was committed. Each new run has a supervisor connected to the daemon by IPC. If the daemon dies, the supervisor terminates its worker group. Retry checks that any interrupted group is gone before proceeding, without signalling saved PIDs. Old bootstrap runs without a supervisor may still require manual process inspection. Worktrees and logs are retained for diagnosis.

## First end-to-end run

Create the `factory:queued` label in the target repository, then create a feature issue carrying that label. Product/Architect runs in a fresh Claude process. Questions are posted on the issue; answer with a standalone command:

```text
/factory answer <your answer or requested changes>
```

The proposed spec is versioned in SQLite and posted to GitHub. Approve its exact version:

```text
/factory approve v1
```

Only configured approvers with GitHub user accounts can approve. Quoted commands, stale versions and bot comments are ignored. Editing an old comment is not a new decision: post a new comment. After approval, Developer and QA run in separate Codex processes; Reviewer runs in a separate Claude process. Passing review pushes the work branch and creates a PR. The factory never merges it.

Findings route automatically to Developer or Product/Architect. Product/Architect can resolve tactical consultations under the same approved spec without human interruption. Major changes and revised specs require a new approval. After the configured correction limit, human guidance is required. QA may change files under test/tests/spec directories or files named `.test.*` / `.spec.*`; other changes fail the run for inspection. Adjust your test layout to this MVP policy.

## Credentials and isolation

Worker environments contain only basic OS variables, provider config location and explicitly allowlisted variables. Local provider credential stores remain available for CLI authentication. This is an environment filter, not a security boundary against malicious code running as your user. Use trusted repositories or an external sandbox/account for untrusted code. Codex uses workspace-write sandbox with network access. Claude Product/Reviewer receive read/search/web tools only. Role mutation checks reject unexpected worktree edits before committing. The orchestrator owns commits, pushes and PR creation. It verifies the assigned branch before executing agents and before committing, rejects detached HEAD, and checks both source and destination of renames against role restrictions.

GitHub comments use a durable, idempotent delivery queue. If reading human replies fails, the item remains waiting and retries on the next poll without losing its approval cursor. Slack is optional and uses its own persistent queue. Failures retry with backoff up to five minutes without blocking the workflow. Human-action messages contain an issue link, question/spec summary and response command. Delivery is at least once, so a crash during acknowledgement can cause a duplicate. SQLite, specs, reports and execution logs live under `FACTORY_DATA_DIR`. Do not commit them or `.env`.

## Provider references

- [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude programmatic execution](https://code.claude.com/docs/en/headless)
- [Claude installation and authentication](https://code.claude.com/docs/en/setup)

## Current boundaries

One foreground daemon per target/data directory, sequential work-item execution, no automatic merge, and no remote execution service. Claude and Codex accounts must be authenticated locally. Old bootstrap items without issue context are rejected explicitly; use a fresh data directory for the first run. Unit/integration tests simulate provider reasoning and GitHub; a live provider demo is a separate acceptance check.

## Slack configuration and diagnosis

Set `SLACK_WEBHOOK_URL` only in your local `.env`. Run `npm run factory -- slack-test` to send one explicitly requested test message. Use `npm run factory -- notifications` to inspect pending/sent deliveries, attempts and retry times. The daemon retries pending notifications after restart. If Slack is disabled, messages remain pending until it is configured. Do not put webhook secrets into GitHub issues or tracked files.

## Structured reports and upgrades

All provider results now require coverage, test evidence, changed files, dependency rationale, decisions and review checks. See `templates/EXECUTION_RESULT.md`. Schemas migrate transactionally when opening SQLite, including concurrent CLI/daemon startup. Previously approved specs without structured acceptance criteria are not silently grandfathered into PASS: regenerate and approve a new spec. Existing raw agent outputs remain in the audit history.

`status` shows the saved retry stage and any interrupted stage checkpoint. Partial work is retained; retry reruns the stage and asks the worker to inspect and verify it. Processes that deliberately detach into other groups and legacy pre-supervisor runs may require manual inspection.

## Models per task

Run `npm run factory -- models` to inspect the balanced policy's explicit model mappings. Use `npm run configure` to change the six model settings in `.env` to match your account; `.env.example` remains the installation-default template. `npm run factory -- models <work-item-id>` previews the next selections without running providers. New specs include a complexity/risk assessment for your approval. See [model policy](docs/MODEL_POLICY.md) for routing, correction escalation, audit events and legacy behavior. Model availability is checked by the actual provider invocation, not by `doctor`; a rejected model requires configuration correction and explicit retry.

Worker prompts include the actual daemon Node executable and configured Git, plus an explicit PATH prefix for shell commands: login-shell startup files may otherwise select an older Node or Xcode Git. Verify the tool versions in run logs. Reviewer receives QA commands/results as attributed evidence and does not claim to have executed them personally.

## After PR delivery

The daemon reconciles READY_TO_MERGE and PR_CLOSED items against GitHub. Merge records MERGED with timestamp/commit; closing without merging records PR_CLOSED; reopening resumes READY_TO_MERGE tracking. GitHub handles issue closure via the PR closing reference. With the daemon stopped, `npm run factory -- sync` performs one synchronization and flushes pending reports/notifications without running agents. The shared singleton lock prevents concurrent daemon/sync execution.

To exercise installer/updater safeguards using temporary local repositories and a stub npm (no CLI installations or agents), run `node scripts/test-maintenance.mjs` after `npm run build`. The regular `npm test` suite validates the actual runtime.

## Configuration details and safeguards

Run this directly from your installation whenever you want to inspect or change settings, without installing or updating:

```sh
npm run configure
# equivalent: bash scripts/configure.sh
```

The installer and updater run the same wizard automatically. Every option in `.env.example` is offered, including target repository/clone, approvers, data directory, polling, timeouts, correction limits, CLI executables, models and optional Slack. Invalid values are explained and prompted again. Target repository, clone and approvers can remain blank to finish setup later; `doctor` must pass before starting.

Slack webhook input/defaults are hidden. Unknown existing environment settings are preserved. Saving creates a private `.env.backup-*` and replaces `.env` atomically with owner-only permissions; these files are ignored by Git. Ctrl+C or incomplete input cancels without saving. Stop the daemon before reconfiguring; do not start another instance while the wizard is open. Changing paths/repositories does not migrate existing data or clone a target repository. Use a separate installation/data directory for a different project.

`npm run configure -- --defaults` saves existing/default values without questions. The equivalent direct command is `bash scripts/configure.sh --defaults`. No configuration command authenticates accounts, clones a target or starts agents. Check configuration with `npm run factory -- doctor`.

Configuration regression checks: `node scripts/test-configure.mjs`.

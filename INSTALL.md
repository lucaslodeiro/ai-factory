# macOS installation

## Installation and updates from GitHub

Download and run the single supported macOS installer. It does not require, install or use Homebrew:

```sh
curl -fsSL https://raw.githubusercontent.com/lucaslodeiro/ai-factory/main/scripts/install-macos.sh \
  -o /tmp/ai-factory-install-macos.sh
bash /tmp/ai-factory-install-macos.sh --dir "$HOME/ai-factory"
```

The installer defaults to the stable `main` branch, which is the repository's only long-lived branch. It installs missing user-local tools, clones the engine without credential prompts, installs locked npm dependencies in CI mode, builds and tests. It creates a private `.env` from safe defaults, installs both user services, starts the dashboard, waits for its health check and opens the first-time setup page in the default browser. Credentials and environment settings are completed there. The daemon stays stopped until the first valid **Save and apply**, which starts and verifies it automatically, so no agent runs before setup is complete. Existing destinations are rejected. Codex's installer receives its documented `CODEX_NON_INTERACTIVE=1`; both provider installers receive closed stdin. Claude's wrapper exposes no non-interactive environment flag and runs only its native `install` subcommand, which installs the launcher without starting login. Both verified launchers live in `~/.local/bin`, which the installer exports and the generated LaunchAgents include. Provider installers: [Codex](https://developers.openai.com/codex/cli), [Claude](https://code.claude.com/docs/en/setup).

The opened dashboard expands **Configuration** and displays a first-time guide in the same six groups used every day. Required fields are marked. Every setting with a safe universal value starts with an installation default. After GitHub connects, empty target fields receive editable suggestions for `<login>/ai-factory-demo`, `<home>/repos/ai-factory-demo`, and the same login as approver. Optional secrets and allowlists remain empty intentionally. Review the configuration and choose **Save and apply**. If every required credential and project check passes, the dashboard starts and verifies the daemon; otherwise it keeps the daemon stopped and shows the missing requirements. The setup layout ends automatically once every requirement is met. The guide can be dismissed without changing configuration.

Installer options:

| Option | Default | Purpose |
|---|---|---|
| `--dir PATH` | `$HOME/ai-factory` | Installation home; the engine checkout is created under `engine/` |
| `--repo URL` | This GitHub repository | Engine source repository |
| `--branch NAME` | `main` | Engine branch to install; only for testing an unmerged branch |
| `--dashboard-host LOOPBACK` | `127.0.0.1` | Initial dashboard address: `127.0.0.1`, `localhost` or `::1` |
| `--dashboard-port PORT` | `4173` | Initial dashboard port |
If the selected port is already occupied, installation chooses the next available port, saves it in `.env`, prints the change and opens the effective URL. For example:

```sh
bash /tmp/ai-factory-install-macos.sh --dashboard-host localhost --dashboard-port 5173
```

## Tool installation behavior

The installer supports Apple Silicon and Intel Macs. It downloads the latest Node 22 archive from Node.js and the latest GitHub CLI macOS archive from GitHub Releases, verifies both SHA-256 checksums published by their projects, and links their executables into `~/.local/bin`. Codex and Claude are installed with their official native installers in non-interactive mode. It then invokes the private installation stage and forwards options such as `--dir` and `--branch`. There is no Homebrew installer or compatibility entry point.

Installation runs the required validation gates; there is no supported environment variable to skip them.

Git comes from Apple's Command Line Tools. Installing those tools is an operating-system action that can require an administrator and a graphical confirmation, so the factory installer never launches it automatically. If they are absent, installation stops before downloading anything and prints the one-time `xcode-select --install` prerequisite; rerun the same factory command afterward. Existing regular files in `~/.local/bin` are never overwritten. Add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile for later terminals.

## Uninstall and clean reinstall

Run the uninstaller while the parent shell remains outside the directory that
will be removed. The basic mode can be followed by purge later:

```sh
cd "$HOME"
# Preserve .env and repos/:
ai-factory uninstall
# Or remove the entire factory home:
ai-factory uninstall --purge
```

The installer stops and verifies any daemon, dashboard or background update
LaunchAgents from an earlier installation before it validates or replaces the
engine. The uninstaller performs the same verified shutdown before removing
files and aborts if launchd still reports a service as loaded.

Service start and restart commands wait for a stable launchd process; daemon
actions additionally wait for the runtime lock that proves the orchestrator
finished its preflight. Stop waits for launchd to unload the job. A failed
verification returns an error instead of reporting a transient service command
as successful.

The installer places `ai-factory` in `~/.local/bin`, so service, update,
configuration and factory commands work from any directory. If that directory
is not yet on the current shell's `PATH`, use
`$HOME/.local/bin/ai-factory uninstall` instead.

The basic uninstaller removes the services, `engine/` and `data/` after its unpublished-work preflight. It preserves `.env`, `.env.backup-*` and `repos/`, so reinstalling into the same home reuses configuration and managed clones. It also leaves a small uninstall-only helper behind the `ai-factory` launcher. That launcher can run `ai-factory uninstall --purge` later, while other commands ask you to reinstall. Purge removes the helper and complete home, and blocks on dirty or unpushed managed clones unless `--force` is supplied. Provider credentials always remain outside the home. For an automated disposable-machine test, use `--yes`.

`$HOME/ai-factory` is the installation home, not an npm package. Do not run
`npm run service` or `npm --prefix "$HOME/ai-factory" …` there. Installed
operations always use the launcher:

```sh
cd "$HOME"
ai-factory service status all
ai-factory uninstall --yes
# Or remove configuration and managed repositories too:
ai-factory uninstall --purge --yes
```

A purge removes `.env` but preserves provider credentials stored by GitHub,
Claude and Codex. After reinstalling, the dashboard therefore asks again for
the repository, checkout and approvers; the daemon remains stopped until the
new project configuration passes readiness.

If an older uninstall left a terminal pointing at the removed checkout, run
`cd "$HOME"` before using that terminal again. Both installers now recover
automatically from that stale working directory, but other commands cannot.

If installation reports `An incomplete or unrelated destination already
exists`, preserve that directory and retry from a clean destination:

```sh
cd "$HOME/ai-factory"
mv engine "engine.incomplete-$(date +%Y%m%d-%H%M%S)"
bash /tmp/ai-factory-install-macos.sh --dir "$HOME/ai-factory"
```

The installer prints these same recovery commands with the resolved paths. It
does not remove or overwrite an unrecognized directory automatically.
The validation suite runs with the destination `AI_FACTORY_HOME` active. If a
validation fails, installation stops before writing `data/install.json`, keeps
the incomplete engine and prints a retry command that preserves its logs.

The service launcher exposes the same operation and flags: `ai-factory service uninstall [--purge] [--yes] [--force]`. Shared Node, Git, `gh`, Codex and Claude installations are never removed.

To update an existing installation, let the updater stop services and restore their previous running state:

```sh
ai-factory update
ai-factory doctor
```

The installation home contains `engine/` (the removable Git checkout), `repos/` (factory-managed target clones), `data/` (SQLite, logs, worktrees and the install marker), `.env` and `.env.backup-*`. Set `AI_FACTORY_HOME` to override the default `$HOME/ai-factory`. A developer checkout not named `engine` treats its own root as the home, so source development remains self-contained. Existing installations are not migrated: uninstall the old installation, reinstall, and enter saved configuration values again.

On a fresh installation, the installer creates `.env` from `.env.example` and imports recognized exported `FACTORY_*` and `GITHUB_*` settings, together with any other key defined by the template. Unknown environment variables are ignored. An existing `<home>/.env` always wins and is preserved unchanged. After the dashboard starts, the installer evaluates the saved configuration and credentials; when every readiness check passes it starts the daemon automatically, even when browser opening is disabled.

The updater requires the existing built runtime and dependencies. It adds `~/.local/bin` to `PATH`, uses the current branch on `origin`, refuses local changes/local-only commits and holds the daemon lock throughout the update. It backs up SQLite and `.env` under `FACTORY_DATA_DIR/update-backup-*`, applies a fast-forward, installs locked dependencies, builds and tests, and preserves configuration without prompting. It never opens a terminal wizard, authenticates accounts or provisions a repository. A failed build/test leaves the daemon stopped and prints the backup and previous revision for diagnosis; there is no destructive automatic rollback. Backups contain private data: keep them local.

`--restart-services` preserves the service state it observes when the command starts. If a previous interrupted update already unloaded both services, use the explicit recovery mode so both are started after a successful update:

```sh
AI_FACTORY_UPDATE_STATE_FILE="$HOME/ai-factory/data/update-state.json" \
  ai-factory update --start-services
```

## Configuration lifecycle

Installation opens `http://127.0.0.1:4173/?setup=1` by default, or the effective custom/fallback address selected during installation. First-time setup uses the same six Configuration groups, with required fields marked, and asks for one agent provider that it applies to Architect, Builder, Tester and Reviewer. Models default to `auto`, which lets each provider choose its current recommended model; explicit per-role routing remains in Agents. **Save and apply** validates the complete candidate configuration before changing `.env`, temporarily stops affected running services, writes atomically with owner-only permissions, and restores those services. On this first-time setup URL, it also starts the daemon once the saved configuration passes every readiness check; the setup layout ends automatically when there are no missing requirements. Outside first-time setup, stopped services remain stopped. Updates preserve `.env` without asking questions.

Connect GitHub and the selected agent provider from **Configuration → Connections**. Once GitHub reports Connected, the dashboard fills editable defaults for the target repository, clone and authorized approver when those fields are empty. Factory-created clones default to `<home>/repos/<repository-name>`. A real project normally points `FACTORY_REPO_DIR` at an existing clone outside the factory home; custom absolute paths remain supported. The clone must have its `origin`, default branch, and Git author configured. Then save; the first-time setup flow starts the daemon automatically after validation succeeds.

`ai-factory configure` remains a supported terminal recovery path when the dashboard cannot start or its address is misconfigured. It is not called by installation or update. In a developer checkout, `npm run configure` builds the required runtime automatically before starting the terminal configurator.

| Setting | Meaning | Example |
|---|---|---|
| `GITHUB_REPOSITORY` | GitHub repository used for issues, comments and PRs | `owner/application` |
| `FACTORY_REPO_DIR` | Absolute path to a local clone of that repository | `/Users/me/Source/application` |
| `GITHUB_DEFAULT_BRANCH` | PR/worktree base branch | `main` |
| `FACTORY_APPROVERS` | Comma-separated GitHub users allowed to answer/approve | `alice,bob` |
| `FACTORY_DATA_DIR` | SQLite, logs and retained worktrees; relative paths use the installation home | `data` |
| `FACTORY_DASHBOARD_HOST` | Dashboard bind address; loopback only | `127.0.0.1` |
| `FACTORY_DASHBOARD_PORT` | Dashboard HTTP port | `4173` |

Run `ai-factory doctor` after configuring. It validates the required values, target clone, Git/GitHub access, provider authentication and writable database.

## macOS services and dashboard

Installation and update generate two user LaunchAgents under `~/Library/LaunchAgents`: `com.ai-factory.daemon` runs the orchestrator and `com.ai-factory.dashboard` serves the local administration UI. They use the same installation directory and `.env`, but remain independently controllable. No administrator access is required.

```sh
ai-factory service start daemon
ai-factory service start dashboard
ai-factory service status all
ai-factory service restart dashboard
ai-factory service stop daemon
ai-factory service stop all
ai-factory service logs daemon
ai-factory service logs dashboard
ai-factory service logs all
ai-factory service uninstall
```

The `logs` action prints the last 100 stdout/error lines and continues following both files until `Ctrl+C`. Start and restart wait for a stable launchd PID; daemon actions also wait for the runtime lock written only after preflight succeeds. Stop waits until launchd no longer reports the job. If verification fails, the command returns an error and unloads a failed start instead of printing a false success. Installation, update, service start and service restart print the configured dashboard URL plus the status, restart, log and stop commands so the next operational step is visible without reopening this document.

Open `http://127.0.0.1:4173` after starting the dashboard. It shows daemon health, the issue queue, recent agent executions and readable audit events. Each issue detail has a workflow conversation containing agent prompt metadata, results, state transitions, failures and human interventions; exact prompts are collapsed and require the sensitive-content acknowledgement before loading. The composer offers only actions valid for the current workflow state. Its operator is the account authenticated in `gh`, and it is read-only unless that login belongs to `FACTORY_APPROVERS`. A submitted turn is published as an idempotent GitHub comment with the operator and instance attribution before the existing command engine applies it, so a rejection also remains visible in the issue. Its persistent theme selector follows the operating-system preference initially and switches between light and dark modes. Issue status badges, the complete issue list, metrics, executions, events and open conversations update through a local Server-Sent Events stream every two seconds; a visible Live/Reconnecting badge reports stream health and a 15-second poll remains as fallback. Retry, Cancel and Stop actions write to the same durable control queue as the CLI.

**Recent executions** identifies the issue, workflow stage, agent role, provider/model, current result, elapsed time, provider-reported token count, start time and exit code for each run. **Time and tokens by issue** aggregates all attempts, including retries, and breaks elapsed agent time and tokens down by workflow stage and agent. Each issue shows compact totals and an expandable breakdown that becomes a stacked card layout on narrow screens. Token usage remains unavailable when the provider CLI does not report it; the factory never estimates it. **Recent events** translates the internal audit into workflow, agent, approval, recovery, GitHub and delivery activity with plain-language titles, relevant evidence, severity and a link back to the affected issue.

Open **Daemon logs** below Services to inspect recent standard output and errors without using a terminal. While the section is open it refreshes every two seconds, preserves your scroll position unless you are following the bottom, and can show or copy the last 100, 200, 500 or 1,000 lines. **Copy visible logs** copies the selected tab and falls back to a temporary selection when the modern Clipboard API is unavailable over HTTP/Tailscale. The endpoint reads only `data/service-logs/daemon.log` and `daemon.error.log` and caps each read, so it never accepts arbitrary file paths or loads an entire large log. Daemon output uses timestamped one-line records with level, event, work item/run identifiers and relevant status fields for lifecycle, controls, state transitions, model selection, executions and integration errors. It does not log prompts, complete provider results or credentials.

The daemon polls comments normally; no manual refresh is needed for `/factory answer`, `/factory approve` or `/factory retry`. It evaluates commands only in the workflow states where they apply and advances past non-actionable comments in other stages so they cannot be replayed later.

**Refresh issue list** is the single manual reconciliation action. It asks the running daemon to fetch open issues carrying a managed workflow-state label and updates the title, body and URL of known items. For every tracked issue it advances the saved position to the newest GitHub comment, skips any older unread comments and evaluates only that newest comment according to the current state: `answer` or `approve` while waiting for a person, and `retry` while failed, paused or cancelled. It never starts an unlabeled issue or reruns completed stages. The dashboard reports when the request is queued and then shows the found, added and updated counts or the concrete GitHub error; if the daemon is stopped, it tells you to start it instead of silently leaving a request pending. If an issue has a managed state label but its local database record is missing, the factory restores it as `PAUSED`, records the latest human answer and evaluates the newest comment. A valid newest retry restarts at Design with Architect because GitHub labels and comments do not contain enough evidence to resume a later agent stage safely. The CLI equivalent is `ai-factory refresh-list`.

The service cards start, restart and stop the daemon or dashboard independently. Above them, the global update area shows the installed package version and Git revision. It fetches the checked-out branch from `origin` on load and every five minutes; **Update Factory** is offered only when the remote commit is a valid fast-forward. The server repeats that check immediately before starting the update.

The update action records which services are loaded in the durable update state **before** submitting an independent one-shot `launchd` job. That job stops the daemon while leaving the dashboard available, waits for its graceful shutdown to release the runtime lock, runs `scripts/update.sh --restart-services`, and downloads, builds and tests the new revision. The updater restores the recorded intent instead of checking service status again after shutdown. Its small wrapper uses only macOS base tools until `update.sh` establishes the installed toolchain path, and remains compatible with jobs submitted by the preceding version while its own files are replaced. It refuses to run again after the persisted state becomes completed or failed and explicitly removes its own transient label on exit. Only after validation succeeds does it refresh both LaunchAgents and briefly restart the dashboard; it then restores the daemon when it was previously running. Progress is persisted on disk, and a stale PID is verified as an updater process before it can keep the UI locked. The dashboard reports the active checkout, daemon-shutdown wait, download, backup, dependency, build and validation phase plus elapsed time. Network, dependency, build and test commands have bounded execution times; a timeout or command failure replaces **Updating…** with the concrete failing stage. When the restarted dashboard reports a different revision, the browser reloads the new frontend automatically. Follow details with `tail -f data/service-logs/update.log`. If any phase fails, the dashboard remains available to show the failure and every service that was running before the attempt is restored; inspect the log before retrying.

The **Configuration** panel has eight categories. **Credentials** reports authentication for GitHub, Claude and Codex plus the Slack connection state. **Connect** starts that provider's official CLI login in the background and opens its browser flow on the Mac running the dashboard. For an active GitHub account, **Reconnect** uses `gh auth refresh --reset-scopes` so it opens a fresh authorization flow without the terminal confirmation required by a second `gh auth login`; Claude and Codex use their normal login command. Complete the provider page and use **Refresh status** if the card has not updated yet. CLI credentials stay in each provider's local secure store. The dashboard never receives or displays their tokens. Login output is available in `data/service-logs/credentials.log`. The Slack card opens its dedicated **Notifications** configuration.

The other seven categories edit the installation's `.env` without exposing secrets to the browser. They cover project and GitHub, runtime, dashboard, agent roles, agent tools, access and secrets, and notifications. Runtime includes a default prompt-context byte budget and an optional JSON object of overrides keyed by exact role (`developer`) or provider/model (`codex/gpt-6-astra`); provider/model wins, then role, then the default, while `auto` never uses a model-specific override. A required-setup notice appears only when a missing credential selected by an agent role, repository setting, approver, target checkout, Git identity or matching origin prevents the factory from processing a project; it disappears automatically after the configuration becomes usable. **Agent roles** has a card for Product Architect, Implementation Engineer, Verification Engineer and Delivery Reviewer. Their compact names and stages are Architect / Design, Builder / Build, Tester / Test and Reviewer / Review. Each card selects Codex or Claude and one direct model. **Auto** omits the model argument and lets that provider use its recommended/default model; choosing a concrete model passes that exact ID on every invocation of the role. Changing the provider refreshes the choices, and existing custom model IDs remain selectable. Every field shows its environment-variable name and which service must restart. **Notifications** shows Slack delivery state and counters first, then accepts an HTTPS Slack Incoming Webhook through the same global **Save and apply** action. It can send a test notification. The webhook is write-only: the API reports only whether it is configured and never sends its value back to the browser. Leaving the input blank preserves it; selecting **Clear configured secret** and saving removes it. Values are validated with the same constraints as the terminal configurator. Each save creates a private `.env.backup-*` and atomically replaces `.env` with owner-only permissions. Unknown existing settings are preserved.

The configuration form remains editable while the daemon is running. On save, the server validates every value first; invalid input leaves both `.env` and service state untouched. It then stops only affected running services, saves, and starts them again. When the dashboard itself must restart, the page displays the effective URL and reconnects there automatically.

If broken configuration prevents the dashboard from starting, recover from a terminal:

```sh
ai-factory service stop all
ai-factory configure
ai-factory doctor
ai-factory service start all
```

The terminal configurator also validates before replacing `.env`, creates a private backup, and preserves unknown settings. It intentionally requires services to be stopped because it cannot coordinate a dashboard restart while repairing it.

The HTTP server accepts only a loopback bind address. For private remote access, keep it on `127.0.0.1` and publish it inside your tailnet with Tailscale Serve:

```sh
tailscale serve --bg http://127.0.0.1:4173
tailscale serve status
```

On a Mac where the Tailscale application is installed but its CLI is not in `PATH`, use `/Applications/Tailscale.app/Contents/MacOS/Tailscale` in place of `tailscale`. Open the HTTPS `.ts.net` URL printed by Serve; `http://100.x.y.z:4173` does not work because the dashboard deliberately does not bind to the Tailscale interface. Tailnet access rules determine who can reach the administrative UI. Do not use Tailscale Funnel, which would publish it to the public internet. Service stdout and stderr are stored under `data/service-logs`.

`install` and `update` refresh both service definitions. Existing loaded services are reloaded so path/runtime changes take effect; stopped services remain stopped. Stop the daemon before updating because the updater refuses to modify an installation with an active orchestration lock.

## Projects and concurrency

The engine repository and target application repository are separate. Set `GITHUB_REPOSITORY=owner/application` and `FACTORY_REPO_DIR=/absolute/path/to/application`; issues and PRs belong to that target. Assign an open issue to the authenticated Factory account, or use the dashboard or `ai-factory start-issue <number-or-url>` to assign it and add this installation's instance label.

At daemon start, `prepareRepository` verifies the target checkout and clones it when the configured path does not exist. If the remote repository is empty, it creates a README, makes the bootstrap commit and pushes the configured base branch before orchestration begins. A nonempty path, a mismatched origin or local changes are refused rather than overwritten.

Multiple installations can share a repository and authenticated GitHub account. Give each one a distinct `FACTORY_INSTANCE_NAME` (hostname by default), target clone and data directory. Assignment to the Factory account offers an issue; the sole `factory-instance:<name>` label selects the installation. Unassigning pauses and preserves work. Reassigning is enough to continue because the previous installation restores its label automatically; changing the instance label moves the issue instead. The status comment carries a compact validated state index and specification milestone comments carry each version once. A new installation continues stable published work automatically. A reinstall with the same `FACTORY_INSTANCE_NAME` and an empty data directory continues its own stable published state by the same mechanism. If the published state is `RUNNING` or `QUEUED`, the dashboard waits because the source may still be active and offers **Continue anyway**. Use `ai-factory issue show <number>` to inspect the published index.

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

The daemon reads `.env` from the factory home (`AI_FACTORY_HOME`, or the parent of an installed `engine/` checkout). A developer checkout uses its root as the factory home. `CODEX_COMMAND`, `CLAUDE_COMMAND` and `GIT_COMMAND` accept absolute executable paths (not shell command strings). Ensure Node 22+ and the working Git executable are first in PATH so worker tools find them too. On Macs with multiple Git installations, an Xcode license error can be avoided by selecting a separately installed Git.

```sh
npm run factory -- doctor
npm run factory -- start
# In another terminal, in the same directory:
npm run factory -- status
npm run factory -- events <work-item-id>
npm run factory -- cancel <work-item-id-or-run-id>
npm run factory -- retry <work-item-id>
npm run factory -- stop --pause-active
npm run factory -- repo check
```

`start` runs in the foreground. A lock prevents a second daemon for the same data directory. `cancel`, `retry` and `stop` persist requests; the running daemon acknowledges them in `events`. Non-interactive stop refuses active work unless `--pause-active` is explicit. Planned interruption records the execution as interrupted, keeps the same stage as `PAUSED`, and preserves context/worktrees. Explicit cancellation alone produces `CANCELLED`. The dashboard offers batch resume after maintenance.

An authorized approver can also retry from the same GitHub issue by posting:

```text
/factory retry
```

The retry command may be the entire comment or the first/last line of a multiline comment. Any surrounding text becomes a typed instruction in the next applicable agent context. The daemon validates the author, consumes each comment once and resumes the stored stage. Bot comments, quoted commands and comments from users outside `FACTORY_APPROVERS` cannot trigger it. The single editable status comment always contains exactly one **Next action** block and explains approval, clarification, correction-limit, retry or merge gates.

Agent timeouts are configurable. SIGTERM escalates to SIGKILL after one second for a process group that does not exit. After a crash, interrupted executions are recorded as interrupted and the work item becomes FAILED. A stage checkpoint also detects crashes after provider exit but before the workflow state was committed. Each new run has a supervisor connected to the daemon by IPC. If the daemon dies, the supervisor terminates its worker group. Retry checks that any interrupted group is gone before proceeding, without signalling saved PIDs. Old bootstrap runs without a supervisor may still require manual process inspection. Worktrees and logs are retained for diagnosis.

When a workflow enters FAILED, its issue receives a structured troubleshooting comment with the failed stage, matching agent execution, provider/model, process result, sanitized reason and up to 30 recent `stderr` lines. Common credential patterns, configured secret environment values, ANSI control codes and local checkout paths are removed or replaced before publication. The full local logs remain available in the dashboard and under `FACTORY_DATA_DIR`.

Every issue uses the deterministic work branch `factory/issue-<n>`. The orchestrator publishes it when Design is first prepared and pushes it again after each Builder or Tester commit, without force. Before every execution it commits preserved partial work, fetches and merges human commits from the work branch and new commits from the configured base. A merge conflict is reported as an integration failure with the affected files; resolve it in the preserved branch and Retry. Tester and Reviewer passes record the exact verified commit, and any later code change returns Review or Delivery to Test before work continues.

When an issue is recovered after its previous worktree directory disappeared, Retry prunes stale Git worktree registrations and reuses the issue's existing local or remote `factory/issue-*` branch. A branch is never recreated over existing work; if Git reports that the branch is actively checked out elsewhere, inspect that checkout before retrying.

## First end-to-end run

Create an open feature issue and assign it to the GitHub account authenticated in `gh`. Add this installation's `factory-instance:<name>` label, or enter the issue number/URL in Dashboard **Add Issue** or run `ai-factory start-issue <number-or-url>` to perform both operations. The daemon claims on one poll and begins only after a later poll verifies that its label is the sole instance label. Questions are posted on the issue; answer with a standalone command:

```text
/factory answer
<your answer or requested changes, which may span multiple lines>
```

A comment already processed as a command is frozen and must be replaced by a new comment. A prose or unrecognized comment may be edited into a valid command until a later command is applied. Assignment and the instance label are the only intake mechanism; editing issue text does not start work.

Each `FACTORY_DATA_DIR` is bound to one stable GitHub repository id. If the target repository is deleted and recreated, stop both services and select an empty data directory before starting again. If only an issue is deleted and recreated with the same number, the factory archives the old work item and leaves the replacement untracked until you start it explicitly.

The proposed spec is versioned in SQLite and posted to GitHub. Approve its exact version:

```text
/factory approve v1
```

Only configured approvers with GitHub user accounts can approve. Quoted commands, stale versions and bot comments are ignored. Every role runs in a separate fresh provider process using its configured Codex or Claude mapping. Passing review pushes the work branch and creates a PR. The factory never merges it.

Findings route automatically to Builder or Architect. Architect can resolve tactical consultations under the same approved spec without human interruption. Major changes and revised specs require a new approval. After the configured correction limit, human guidance is required. The Verification Engineer (Tester) may change files under test/tests/spec directories or files named `.test.*` / `.spec.*`; other changes fail the run for inspection. Adjust your test layout to this MVP policy.

## Credentials and isolation

Dashboard credential actions invoke only the installed `gh`, Claude and Codex login commands. They do not accept a command or token from the browser. GitHub login also runs `gh auth setup-git` after authentication so HTTPS Git operations use the stored account. A detached login can continue while the dashboard refreshes; its card remains **Connecting…** until the CLI exits or authentication becomes valid.

Worker environments contain only basic OS variables, provider config location and explicitly allowlisted variables. Local provider credential stores remain available for CLI authentication. This is an environment filter, not a security boundary against malicious code running as your user. Use trusted repositories or an external sandbox/account for untrusted code. Codex uses its workspace sandbox with network access. Claude receives edit/write/shell tools only for Implementation Engineer and Verification Engineer; Product Architect and Delivery Reviewer remain read-only. Provider-independent role mutation checks reject unexpected worktree edits before committing, including every Product Architect or Delivery Reviewer edit and Verification Engineer production-code edits. The orchestrator owns commits, pushes and PR creation. It verifies the assigned branch before executing agents and before committing, rejects detached HEAD, and checks both source and destination of renames against role restrictions.

GitHub comments use a durable, idempotent delivery queue. If reading human replies fails, the item remains waiting and retries on the next poll without losing its approval cursor. Slack is optional and uses its own persistent queue. Failures retry with backoff up to five minutes without blocking the workflow. Human-action messages contain an issue link, question/spec summary and response command. Delivery is at least once, so a crash during acknowledgement can cause a duplicate. SQLite, specs, reports and execution logs live under `FACTORY_DATA_DIR`. Do not commit them or `.env`.

## Provider references

- [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude programmatic execution](https://code.claude.com/docs/en/headless)
- [Claude installation and authentication](https://code.claude.com/docs/en/setup)

## Safe maintenance and repository recovery

The dashboard previews every `QUEUED` or `RUNNING` task before update, daemon stop/restart or a daemon-affecting configuration apply. Confirmation is tied to exact workflow revisions. The daemon pauses those tasks, interrupts active agents without recording cancellation, waits for their processes to exit and only then permits the service operation. Use **Resume paused tasks** afterward, or Retry items individually.

Configuration → Project exposes the same bounded repository operations as the CLI:

```sh
ai-factory repo check
ai-factory repo sync
ai-factory repo publish <work-item-id>
ai-factory repo clear --confirm "$FACTORY_REPO_DIR" --repeat "$FACTORY_REPO_DIR"
ai-factory repo restore
```

Check is read-only. Sync refuses dirt, divergence and local-only commits. Publish accepts only the selected `factory/*` worktree. Clear is irreversible, refuses protected/symlinked paths and requires the exact configured path twice. Restore requires an empty target directory and never resumes paused work automatically.

Exact prompts, stdout, stderr and supervisor completion files are retained for `FACTORY_ARTIFACT_RETENTION_DAYS` after a work item reaches `COMPLETED` or `CANCELLED` (30 days by default; 0 disables pruning). Prompt manifests, hashes, execution metadata, records, failures, events and SPECs remain. Dashboard prompt reveal requires an explicit sensitive-content acknowledgement and is available only on the loopback dashboard.

## Current boundaries

One foreground daemon per target/data directory, sequential work-item execution, no automatic merge, and no remote execution service. Claude and Codex accounts must be authenticated locally. V3 requires a fresh factory data directory and does not import or read databases created by earlier workflow versions. Use the supported uninstaller and reinstall, or select an empty `FACTORY_DATA_DIR`; the target application repository and provider credentials are preserved. Unit/integration tests simulate provider reasoning and GitHub; a live provider demo is a separate acceptance check.

## Slack configuration and diagnosis

In the dashboard, open **Configuration → Notifications**, paste the Slack Incoming Webhook and choose the global **Save and apply** action. The URL is validated before saving and a running daemon is restarted automatically. **Send test notification** uses the saved value immediately. The same screen shows pending, failed and sent counts plus the most recent delivery error. Slack also appears in **Credentials** as a connection summary.

The terminal alternative is to set `SLACK_WEBHOOK_URL` only in your local `.env` and run `ai-factory slack-test`. Use `ai-factory notifications` to inspect individual pending/sent deliveries, attempts and retry times. Notifications use Slack Block Kit and identify the project, issue, readable workflow status, relevant evidence and direct GitHub link. Human gates emphasize the required action and exact command; failures include the recorded cause and retry command. The daemon retries pending notifications after restart. If Slack is disabled, messages remain pending until it is configured. Do not put webhook secrets into GitHub issues or tracked files.

## Structured reports and upgrades

All provider results require coverage, test evidence, changed files, dependency rationale, decisions and review checks. See `templates/EXECUTION_RESULT.md`. A fresh schema is initialized transactionally and stamped with the current version; any other stored version is refused before mutation and requires uninstalling and reinstalling with an empty data directory. The updater never migrates data.

Delivery roles cannot alter the approved specification. The provider schema requests inert values for `spec`, `acceptanceCriteria`, `taskAssessment` and `nextRole`; the orchestrator also forces those fields to inert values before validating Implementation Engineer, Verification Engineer and Delivery Reviewer reports because provider structured-output implementations may not enforce every enum or zero-length-array constraint. Coverage, test evidence, findings and all other delivery requirements remain strictly validated.

`status` shows V3 stage, status, attempt, revision, SPEC and PR. Partial work is retained; retry reruns the stored stage with active decisions, instructions, requests and failures assembled deterministically.

## Models per task

Run `ai-factory models` to inspect each role's provider and direct model selection. Use the dashboard or `ai-factory configure` to choose the eight role settings in `.env` (provider and model for four roles); `.env.example` remains the installation-default template. `ai-factory models <work-item-id>` previews the configured selections and workflow assessment without running providers. New specs include a complexity/risk assessment for your approval. See [model policy](docs/MODEL_POLICY.md) for workflow safeguards and audit events. Model availability is checked by the actual provider invocation, not by `doctor`; a rejected model requires configuration correction and explicit retry.

Worker prompts include the actual daemon Node executable and configured Git, plus an explicit PATH prefix for shell commands: login-shell startup files may otherwise select an older Node or Xcode Git. Verify the tool versions in run logs. Delivery Reviewer receives Tester commands/results as attributed evidence and does not claim to have executed them personally.

## After PR delivery

The daemon reconciles `DELIVERY/WAITING` items against GitHub. Merge records `DELIVERY/COMPLETED` with timestamp/commit; closing without merge remains waiting and reopening resumes the same merge request. With the daemon stopped, `ai-factory sync` performs one reconciliation and flushes pending GitHub/Slack deliveries without running agents. The shared singleton lock prevents concurrent daemon/sync execution.

To exercise installer/updater safeguards using temporary local repositories and a stub npm (no CLI installations or agents), run `node scripts/test-maintenance.mjs` after `npm run build`. The regular `npm test` suite validates the actual runtime.

## Configuration details and safeguards

The dashboard is the normal configuration interface. The terminal wizard remains a supported recovery interface for a headless Mac or a dashboard that cannot start:

```sh
ai-factory configure
```

Installation and update do not invoke this wizard. Dashboard fields cover every option in `.env.example`, including target repository/clone, approvers, data directory, polling, timeouts, correction limits, CLI executables, models and optional Slack. Invalid values are explained when saving; `doctor` must pass before the daemon can operate correctly.

Slack webhook input/defaults are hidden. Unknown existing environment settings are preserved. Saving through the terminal recovery flow or dashboard creates a private `.env.backup-*` and replaces `.env` atomically with owner-only permissions; these files are ignored by Git. The dashboard coordinates affected services automatically; stop all services before using terminal recovery. Changing paths/repositories does not migrate existing data or clone a target repository. Use a separate installation/data directory for a different project.

The fallback supports `ai-factory configure --defaults` to save existing/template values without questions. It never runs during installation or update. Check configuration with `ai-factory doctor`.

Configuration regression checks: `node scripts/test-configure.mjs`.
Uninstall regression check: `node scripts/test-uninstall.mjs`.

### Database schema

The current schema is 7. It no longer stores the redundant issue node ID or the creation-date fallback for issue identity. Numeric GitHub issue identity remains authoritative. Earlier schema versions are rejected without modification; no upgrade migration is shipped. Use a fresh data directory for this schema. An update from an earlier schema fails candidate validation and preserves the installed version and data.

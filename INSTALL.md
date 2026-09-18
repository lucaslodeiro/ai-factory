# macOS installation

Use Node 22 or newer (Node 22 LTS recommended), Git, GitHub CLI, Codex CLI and Claude Code. Authenticate `gh auth login`, `codex login`, and `claude auth login` before starting.

```sh
git clone --branch bootstrap/mvp https://github.com/lucaslodeiro/ai-factory.git
cd ai-factory
npm ci
npm run build
npm test
cp .env.example .env
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

Agent timeouts are configurable. SIGTERM escalates to SIGKILL after one second for a process group that does not exit. After a crash, interrupted executions become failed rather than successful. The daemon does not blindly signal saved PIDs, which could have been reused; inspect and terminate any orphan worker manually before retrying. Worktrees and logs are retained for diagnosis.

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

Findings route automatically to Developer or Product/Architect. Revised specs require a new approval. After the configured correction limit, human guidance is required. QA may change files under test/tests/spec directories or files named `.test.*` / `.spec.*`; other changes fail the run for inspection. Adjust your test layout to this MVP policy.

## Credentials and isolation

Worker environments contain only basic OS variables, provider config location and explicitly allowlisted variables. Local provider credential stores remain available for CLI authentication. This is an environment filter, not a security boundary against malicious code running as your user. Use trusted repositories or an external sandbox/account for untrusted code. Codex uses workspace-write sandbox with network access. Claude Product/Reviewer receive read/search/web tools only. Role mutation checks reject unexpected worktree edits before committing. The orchestrator owns commits, pushes and PR creation.

GitHub comments use a durable, idempotent delivery queue. Slack is optional and best-effort: notification failures are audited without blocking the workflow. SQLite, specs, reports and execution logs live under `FACTORY_DATA_DIR`. Do not commit them or `.env`.

## Provider references

- [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude programmatic execution](https://code.claude.com/docs/en/headless)
- [Claude installation and authentication](https://code.claude.com/docs/en/setup)

## Current boundaries

One foreground daemon per target/data directory, sequential work-item execution, no automatic merge, and no remote execution service. Claude and Codex accounts must be authenticated locally. Old bootstrap items without issue context are rejected explicitly; use a fresh data directory for the first run. Unit/integration tests simulate provider reasoning and GitHub; a live provider demo is a separate acceptance check.

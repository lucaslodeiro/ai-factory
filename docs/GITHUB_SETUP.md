# GitHub setup

Authenticate `gh` with issue, content and pull-request write access to the target repository. Configure `GITHUB_REPOSITORY`, `FACTORY_REPO_DIR`, `GITHUB_DEFAULT_BRANCH` and `FACTORY_APPROVERS` in the dashboard, then validate them with Doctor. The terminal configurator remains available as a recovery path with `npm run configure`.

Create an open issue and put `/factory start [guidance]` on the first or last non-empty line of either its description or a comment. A description start is accepted only when the issue author is listed in `FACTORY_APPROVERS`; a comment start uses the comment author. The daemon validates the approver, fetches the issue and creates the work item exactly once. Every other line becomes guidance. Quoted commands and commands in the middle do not start work. If both boundary lines are commands, the first wins. Bots, closed issues and unauthorized users do not start work. The dashboard and `ai-factory start-issue <number-or-url>` provide equivalent explicit entry points.

Workflow labels are projections created and changed automatically. Users never need to create or move them manually. The V4 runtime has no legacy label intake or compatibility behavior.

Available commands are:

- `/factory start [guidance]`
- `/factory help`
- `/factory approve vN [guidance]`
- `/factory answer <text>`
- `/factory retry [--issue] [--for <roles>] [guidance]`
- `/factory note [--issue] [--for <roles>] <text>`
- `/factory replace <#N|id-prefix> [--issue] [--for <roles>] <text>`
- `/factory revoke <#N|id-prefix>`
- `/factory pause [reason]`
- `/factory cancel [reason]`

`start` and `approve` guidance becomes an agent instruction. `answer` becomes a human decision except when it requests PR changes. `note`, `retry` and `replace` accept `--issue` for issue-wide guidance and `--for architect,builder,tester,reviewer` to target roles. Active guidance is numbered in creation order; those ordinals never shift or get reused, and the displayed id prefix remains accepted. Pause/cancel reasons are audit evidence and never enter prompts. A label is never a start, approval or retry command. Commands, spec versions and comment IDs are audited in SQLite.

Comments already processed as commands are frozen: editing them cannot change their outcome. Authorized prose and unrecognized near misses can be edited into a command until a later command is applied. On untracked issues, edits to comments or the description are reevaluated for start. Near-miss spellings and misplaced starts from approvers receive a hint; unauthorized users receive no public feedback.

The data directory records the target repository's stable GitHub id. If a repository is deleted and recreated under the same name, select an empty `FACTORY_DATA_DIR`. If an issue is deleted and recreated with the same number, the old work item is archived without projecting stale state onto the replacement; start the new issue explicitly.

The daemon reads new comments during normal polling. **Refresh issue list** is a global reconciliation tool for recovering missing managed issues, updating issue metadata and advancing each saved cursor to the newest comment. It evaluates only that newest comment when it is valid for the current state and never replays completed work.

The delivered pull request contains `Closes #N`, the approved specification and Review evidence. A human performs the merge; GitHub closes the issue after that merge.

## Visible workflow state

The status model is the product of a stage and a condition:

| Dimension | Values |
|---|---|
| Stage | Design, Build, Test, Review, Delivery |
| Condition | Queued, Running, Waiting for you, Failed, Paused, Cancelled, Completed |

The factory projects the current stage as `factory:design`, `factory:build`, `factory:test`, `factory:review` or `factory:delivery`. Waiting, failed, paused and cancelled add a second condition label. Completion replaces them with `factory:done`.

One updatable **AI Factory** issue comment contains the stage, condition, current actor, approved spec version, attempt, active request, failure summary, active human instructions and recent transition history. It ends with exactly one authoritative next-action section. Presentation delivery is idempotent and is retried after GitHub outages; SQLite remains authoritative.

Only managed workflow labels are replaced. Unrelated labels remain intact. Generated specs and role reports use readable Markdown with expandable evidence while full structured results remain in SQLite and execution logs.

Lifecycle reconciliation runs during normal polling. A manually closed issue disappears from factory operation. Reopening it restores a paused item without processing comments written while it was closed. With the daemon stopped, `npm run factory -- sync` reconciles pending GitHub projections without invoking an agent and refuses to race an active daemon.

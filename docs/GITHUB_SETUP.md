# GitHub setup

Authenticate `gh` with issue, content and pull-request write access to the target repository. Run `npm run configure` and set `GITHUB_REPOSITORY`, `FACTORY_REPO_DIR`, `GITHUB_DEFAULT_BRANCH` and `FACTORY_APPROVERS`. The wizard uses existing `.env` values as defaults and installation defaults for missing settings. Run it only while the daemon is stopped, then validate with `npm run factory -- doctor`.

Create an open issue and post `/factory start` as a new standalone comment from a login listed in `FACTORY_APPROVERS`. The daemon reads the repository-wide recent-comment stream, validates the human approver, fetches the issue and creates the work item exactly once. Quoted commands, edited comments, bots and unauthorized users do not start work. The dashboard and `ai-factory start-issue <number-or-url>` provide equivalent explicit entry points.

Workflow labels are outputs of the orchestrator. They are created and changed automatically after an explicit start command; users do not need to create or administer labels. An obsolete `factory:queued` label is removed if encountered while synchronizing an already tracked issue, but it never starts work.

Use `/factory answer <text>` and `/factory approve vN` as standalone comments from a configured human approver. For an item in FAILED, PAUSED or CANCELLED, post a new standalone `/factory retry` comment to resume its saved stage. The same configured-approver, human-account and one-time cursor checks apply; quoted commands and edits to an already-read comment do not execute. A label is not a start, approval or retry command. Spec versions and command comment IDs are audited in SQLite. Comments are read with pagination. GitHub outage delivery is retried using hidden idempotency markers; SQLite remains authoritative.

The daemon reads new comments during normal polling; no manual per-issue refresh is required. **Refresh issue list** is a global reconciliation tool for discovering missing managed issues, updating title/body/URL metadata and moving each issue's saved position to its newest comment. It deliberately skips older unread comments and evaluates only the newest comment when it is valid for the current state (`answer`/`approve` while waiting for a person or `retry` while stopped). It does not replay completed work.

The final PR includes the approved spec, QA/review evidence and deferred findings. Merge is always performed by a human.

## Visible workflow state

GitHub issue Open/Closed tracks whether the work is still outstanding. The issue stays open through specification, implementation, QA, review and ready-to-merge. The delivered PR includes `Closes #N`; GitHub closes the issue when that PR merges into the default branch. The orchestrator polls delivered PRs: a confirmed merge records MERGED, merge time and commit; a closed unmerged PR records PR_CLOSED; reopening restores READY_TO_MERGE. These updates never execute agents or merge anything. GitHub outages retain the previous state for a later retry.

Workflow progress is mirrored in a colored label and one updatable **AI Factory** status comment with milestones and the next human action:

| Orchestrator | Label | Meaning |
|---|---|---|
| SPEC | factory:spec | Designing the specification |
| WAITING_HUMAN | factory:waiting-human | Approval or answer needed |
| DEVELOPMENT | factory:development | Implementing |
| QA | factory:qa | Independent testing |
| REVIEW | factory:review | Reviewing |
| READY_TO_MERGE | factory:ready-to-merge | Human merge pending |
| MERGED | factory:merged | GitHub confirmed completed delivery |
| PR_CLOSED | factory:pr-closed | Closed without integration; can be reopened |
| FAILED | factory:failed | Inspect and retry |
| PAUSED | factory:paused | Paused |
| CANCELLED | factory:cancelled | Cancelled |

Only known workflow labels are replaced; unrelated labels, including other `factory:*` labels, remain intact. The progress comment is updated only when its content changes. During GitHub outages, the next daemon flush retries reconciliation from SQLite. This does not create or manage a GitHub Projects board.

Spec and role reports are Markdown with summaries, findings, and expandable criteria/test/review evidence. Long evidence is abbreviated for readability (up to 20 rows per section); the complete structured report remains in SQLite and execution logs. Human commands remain standalone new comments. Formatting changes to an existing generated spec do not change the approved version or overwrite human approval comments.

Lifecycle reconciliation runs during normal daemon polling. With the daemon stopped, run `npm run factory -- sync` to reconcile PR state and publish pending status/reports without authenticating or running agent providers. It uses the same singleton lock and refuses to race an active daemon. MERGED is terminal; ordinary retry cannot restart it.

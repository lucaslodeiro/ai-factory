# GitHub setup

Authenticate `gh` with issue, content and pull-request write access to the target repository. Configure `GITHUB_REPOSITORY`, `FACTORY_REPO_DIR`, `GITHUB_DEFAULT_BRANCH` and `FACTORY_APPROVERS` in `.env`.

```sh
gh label create factory:queued --repo OWNER/REPO --color 7057ff
```

Create an open issue labelled `factory:queued`. The daemon discovers up to 100 queued issues per poll and deduplicates by repository/issue number. It removes the queue label when mirroring its persisted state. Other `factory:*` labels are managed by the daemon; unrelated labels are preserved.

Use `/factory answer <text>` and `/factory approve vN` as standalone comments from a configured human approver. A label is not an approval. Spec versions and approval comment IDs are audited in SQLite. Comments are read with pagination. GitHub outage delivery is retried using hidden idempotency markers; SQLite remains authoritative.

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

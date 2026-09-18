# GitHub setup

Authenticate `gh` with issue, content and pull-request write access to the target repository. Configure `GITHUB_REPOSITORY`, `FACTORY_REPO_DIR`, `GITHUB_DEFAULT_BRANCH` and `FACTORY_APPROVERS` in `.env`.

```sh
gh label create factory:queued --repo OWNER/REPO --color 7057ff
```

Create an open issue labelled `factory:queued`. The daemon discovers up to 100 queued issues per poll and deduplicates by repository/issue number. It removes the queue label when mirroring its persisted state. Other `factory:*` labels are managed by the daemon; unrelated labels are preserved.

Use `/factory answer <text>` and `/factory approve vN` as standalone comments from a configured human approver. A label is not an approval. Spec versions and approval comment IDs are audited in SQLite. Comments are read with pagination. GitHub outage delivery is retried using hidden idempotency markers; SQLite remains authoritative.

The final PR includes the approved spec, QA/review evidence and deferred findings. Merge is always performed by a human.

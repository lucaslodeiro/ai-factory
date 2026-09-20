# Repository Controller Lease

**Version:** 2.2 (revised after architecture review; remote issues view and controller attribution added)  
**Status:** Implemented
**Scope:** Prevent multiple AI Factory installations from operating the same GitHub repository concurrently  
**Implementation status:** Implemented on `feat/controller-lease`; validation evidence is recorded in `docs/reviews/2026-09-21-controller-lease.md`.

## 1. Purpose

AI Factory stores workflow state, execution history, context, worktrees and maintenance state locally. A local daemon lock prevents two daemon processes from sharing one data directory, and repository identity prevents one data directory from being reused for a different GitHub repository. Neither control protects a repository from factories running on different hosts or from separate installations on the same host.

This specification introduces one remote **repository controller lease**. Exactly one installation may mutate factory-owned state for a repository at a time. Other configured installations remain available for administration and run in standby.

The design favors safety and explicit recovery over automatic failover. It does not make local SQLite state portable between machines.

## 2. Problem

Two installations configured with the same `GITHUB_REPOSITORY` independently poll the same issues and comments, interpret the same `/factory` commands, update the same labels and status comment, create unrelated local work items, publish overlapping branches and pull requests, and show different states in their dashboards. Both usually share the same `gh` credentials, so on GitHub the duplicate activity appears to come from one user.

### 2.1 Observed failure

An older factory remained active on one Mac while a fresh installation was created on another. The older daemon consumed commands for a newly created issue, reused historical local workflow state for the same issue number, edited the GitHub issue and continued an obsolete Review stage. The new dashboard showed nothing because its own database was empty.

Stopping services during install and uninstall prevents a stale daemon on the same host. It cannot stop or discover a daemon on another host.

### 2.2 Existing protections and their boundary

| Protection | Prevents | Does not prevent |
| --- | --- | --- |
| Local `daemon_lock` | Two daemons using one SQLite database | Separate data directories or hosts |
| Stored GitHub repository id | Reusing a data directory for a different or recreated repository | Multiple databases bound to the same repository |
| Issue id and node id | Treating a recreated issue as the previous one | A second factory processing the same current issue |
| Deterministic GitHub projection | Duplicate publications from one database | Conflicting projections from different databases |

## 3. Goals

1. At most one lease-aware factory processes or mutates a GitHub repository.
2. Acquisition is atomic across hosts.
3. A standby factory stays visible and diagnosable in its dashboard, and shows which factory-managed issues another installation is processing.
4. Loss of ownership stops new work and prevents later publication of stale agent results.
5. Restart, stop, update and uninstall have explicit lease semantics.
6. Recovery from a lost host is possible without an external database.
7. The mechanism adds no branches to the application repository, no commits to its default branch, and no hosted coordination service.
8. Operator-facing state identifies which installation owns the repository without exposing secrets.

## 4. Non-goals

- Running multiple workers concurrently against one repository.
- Moving SQLite state or worktrees between hosts.
- Resuming an in-progress workflow on a different installation.
- Electing a new controller automatically after an outage.
- Stopping a legacy daemon that does not implement this protocol.
- Renewing the lease while the daemon is stopped for an update (see §12).

## 5. Core decision

Each GitHub repository has one controller lease stored in a **dedicated Git ref outside the branch namespace**:

```text
refs/ai-factory/lease
```

It is not a branch. It does not appear in the branch list or pull-request base selector, is not fetched by the default refspec, is not covered by branch rulesets, cannot be deleted from the GitHub UI, and does not trigger GitHub Actions `push` workflows. The ref points to an orphan commit whose tree contains only `lease.json`.

Acquisition, renewal, release and takeover update the ref through Git's server-side compare-and-swap:

```text
git push origin <commit>:refs/ai-factory/lease --force-with-lease=refs/ai-factory/lease:<expected-sha>
```

For initial acquisition the expected value is empty, which means the ref must not exist. For renewal and takeover it is the exact SHA previously read. If the ref changed first, the push is rejected and ownership is not granted. A forced push without an expected value is forbidden everywhere in the codebase.

Lease commits are created with plumbing commands (`hash-object`, `mktree`, `commit-tree`) in a dedicated bare repository at `<home>/data/controller.git`, which shares the `gh auth setup-git` credential. Lease operations never touch the application checkout or its working tree. `git ls-remote origin refs/ai-factory/lease` reads the current record without a fetch.

The same compare-and-swap is enforced by any Git server, so the race tests in §20 run against a local bare repository, not GitHub.

## 6. Installation identity

Every factory home receives a stable identity at installation:

```text
<home>/instance.json
```

```json
{
  "schemaVersion": 1,
  "instanceId": "3a7d31bc-14c9-4e78-a2ab-1490d96055cf",
  "displayName": "Factory 3a7d31",
  "createdAt": "2026-09-20T16:00:00.000Z"
}
```

`instanceId` is random and never reused. `displayName` is editable in the dashboard. The default contains no username, hostname or path. The file lives next to `.env`, so basic uninstall preserves it and a reinstalled factory reclaims its own lease; only purge uninstall removes it.

## 7. Remote lease record

```json
{
  "schemaVersion": 1,
  "repositoryId": 123456789,
  "repositoryNodeId": "R_kgDOExample",
  "instanceId": "3a7d31bc-14c9-4e78-a2ab-1490d96055cf",
  "displayName": "Factory 3a7d31",
  "contact": "",
  "generation": 8,
  "engineVersion": "0.3.0",
  "acquiredAt": "2026-09-20T16:00:00.000Z",
  "heartbeatAt": "2026-09-20T16:08:00.000Z",
  "activeWorkCount": 1
}
```

Rules:

- Repository identity uses GitHub's stable numeric and node ids, never only `owner/name`.
- `generation` increments on acquisition and takeover; renewal keeps it.
- `contact` is optional operator-supplied free text (a name, a chat handle). It is never filled automatically.
- Heartbeat interval and lease duration are protocol constants in the first version: **2 minutes** and **10 minutes**. Expiry is derived by the reader as `heartbeatAt + 10 min` on its own clock; the record carries no `expiresAt`. Clock skew between hosts of up to a minute is tolerated by design because takeover is manual.
- Renewal replaces the commit; the ref shows only the current record. GitHub may retain unreachable objects temporarily.
- The record never contains tokens, local paths, usernames, prompts, issue content or agent output.

## 8. Controller states

| State | Meaning | Allowed behavior |
| --- | --- | --- |
| `unconfigured` | Repository identity unavailable | Dashboard and configuration only |
| `acquiring` | Atomic acquisition in progress | No issue processing or remote mutation |
| `active` | This instance owns the current generation | Normal orchestration |
| `standby` | Another instance owns the repository | Read-only diagnostics, takeover UI |
| `uncertain` | Ownership could not be verified recently | No intake, scheduling or remote mutation; running work finishes and is held (§10) |
| `fenced` | A different owner or generation was observed | Running work interrupted; results discarded; standby afterwards |
| `releasing` | Local work checked before release | No new executions |

`standby` is a healthy daemon state. Service health and the dashboard distinguish "daemon running, controller standby" from "daemon stopped".

## 9. Acquisition protocol

When a configured daemon starts:

1. Resolve and verify the repository's stable GitHub identity.
2. Read `refs/ai-factory/lease` and validate the record.
3. If the ref does not exist, create generation 1 with an absent-ref expectation.
4. If the record belongs to this `instanceId`, renew it and become active, whether or not it is expired. This is how restart and update keep ownership.
5. If another owner exists and is not expired, enter standby.
6. If another owner exists and is expired, stay standby and offer explicit takeover. There is no automatic failover.
7. If the compare-and-swap fails, reread the ref and become active only if the new value proves this instance owns it.

The daemon acquires ownership before recovering executions, polling commands, scheduling agents or publishing a projection.

## 10. Renewal, uncertainty and fencing

The active daemon renews every 2 minutes, each time expecting the last SHA it observed.

**Uncertain.** If 10 minutes pass on the daemon's own monotonic clock without a successful renewal, it becomes `uncertain`:

1. it stops polling and scheduling;
2. it records `controller.ownership_uncertain`;
3. it performs no GitHub mutation of any kind;
4. a running execution is allowed to finish; its result is stored locally as **held**, not applied;
5. it keeps trying to renew.

If renewal later succeeds with the same generation, held results are applied normally and the daemon returns to `active`. Nothing was lost.

**Fenced.** If any read or renewal shows a different `instanceId` or a higher `generation`, the daemon becomes `fenced`:

1. it interrupts a running execution through the planned-interruption path with reason `controller-lost`;
2. the affected work item becomes `PAUSED` locally;
3. held and in-flight results are discarded as local evidence;
4. it records `controller.lost` and enters standby.

**Fencing points.** Every remote mutation passes through one of three places. Each performs a local fence immediately before acting: the daemon must still be `active`, and the last successfully verified cached generation must equal the generation acquired at startup or takeover. Remote verification belongs only to the two-minute renewal loop; a transient network failure does not fail an otherwise active tick before the ten-minute uncertainty deadline.

- `WorkflowCommands.apply`, before a command changes workflow state;
- the orchestrator, before `runner.run` starts an execution or the delivery publication;
- the orchestrator, before `flush()` publishes labels, comments, assignments, branches or pull requests.

The check-then-act window between the last successful renewal, the local fence and the GitHub call is accepted: GitHub cannot verify a fencing token. Manual takeover plus the 10-minute expiry bound that window in practice. This is cooperative fencing; a legacy daemon that ignores the lease must be stopped during cutover (§18).

## 11. Release and takeover

### 11.1 Release

Release is refused while the local database has `QUEUED`, `RUNNING`, `WAITING`, `FAILED` or `PAUSED` work unless the operator explicitly abandons it with `--force`. Release deletes the ref with a compare-and-swap against the current SHA and only when this instance owns it.

Both uninstall modes attempt a release after local maintenance has paused work and before engine files are removed. If GitHub is unavailable, uninstall reports that the remote claim could not be released and prints the takeover command another installation will need. It never claims success silently.

Stopping the daemon does not release. The lease expires on its own. Restarting the same installation reclaims it (§9.4).

### 11.2 Takeover

Another installation takes over only through an explicit operator action. The dashboard and `controller status` show the current owner, contact, heartbeat age, expiry, generation and last reported active-work count.

- **Takeover** is available once the lease is expired.
- **Force takeover** before expiry requires typing the repository name and acknowledging that another factory may still be running.

Both use compare-and-swap against the displayed SHA and increment `generation` exactly once. Two concurrent attempts cannot both succeed.

Takeover imports nothing. If the previous owner reported active work, the new controller lists factory-labelled issues as requiring reconciliation, requires a fresh authorized `/factory start` before creating local state, and warns that worktrees and unpublished commits remain on the old host.

## 12. Maintenance lifecycle

- **Update or restart:** the daemon stops renewing while down and reclaims its own lease on return (§9.4). The lease may expire during a long update; that is expected and only matters if an operator performs a takeover meanwhile.
- **Daemon stop / stop all:** renewal stops and the lease expires. No standby takes over automatically.
- **Dashboard stop:** no effect.
- **Uninstall:** release as in §11.1.
- **Install:** never overwrites an existing lease. A new installation configured for an owned repository starts in standby.

A standby daemon re-reads the lease every two minutes for visibility. If the ref becomes absent, it remains in standby; acquiring control still requires `ai-factory controller acquire` or a daemon restart. Standby never promotes itself automatically.

The local maintenance barrier keeps preserving work-item state. The lease is a repository-wide barrier in front of local scheduling and publication; it does not replace maintenance.

## 13. Dashboard and CLI

### 13.1 Dashboard

A **Repository controller** card in Services and in Project configuration.

Active:

```text
Active controller
Factory 3a7d31 · generation 8
Verified 34 seconds ago
1 active work item
```

Standby:

```text
Standby
Factory b912aa controls this repository.
Last heartbeat 3 minutes ago; expires in 7 minutes.
This installation does not process issues or modify GitHub.
```

In standby the local issue list states that it shows this installation's local database and may be empty; it must not imply that GitHub has no factory issues. The remote issues view in §13.3 shows what the repository actually contains.

Actions: **Refresh**, **Release control** (active, no unsafe work), **Take over** (expired lease), **Force takeover** (typed confirmation).

### 13.2 CLI

```text
ai-factory controller status
ai-factory controller acquire
ai-factory controller release [--force]
ai-factory controller takeover [--force]
```

`doctor` reports controller ownership separately from GitHub authentication and the local daemon lock. Starting a configured daemon in standby succeeds and prints the owning installation.

### 13.3 Remote issues view

Visibility does not require state synchronization. The GitHub adapter already lists open issues carrying `factory:*` labels (`listManaged()`); the dashboard uses it to show a read-only **Repository issues** list in every controller state:

| Column | Source |
| --- | --- |
| Issue number, title, link | GitHub issue |
| Stage and status | derived from the `factory:*` labels, rendered with the public names |
| Pull request | link from the status comment when present |
| Processed by | the controller lease: this installation, or `Factory b912aa`, or "no controller" |
| Local state | "Tracked here" when a local work item exists for the same issue id, otherwise "Not tracked here" |

Rules:

- In standby, every row reads "Processed by Factory b912aa" and offers only **Open in GitHub**. No start, retry, pause or cancel action is available; the list explains that commands must be posted on the issue and will be processed by the active controller.
- In active state the list doubles as a reconciliation view: a row that is "Not tracked here" while carrying factory labels is work that another installation started, typically before a takeover. It offers **Open in GitHub** and the existing start-issue field; it never infers or imports the other installation's state.
- The list is refreshed on the same cadence as the controller status and never writes to GitHub.
- Executions, records, prompts and logs of another installation are not shown; they live in that installation's database.

### 13.4 Controller attribution on the issue

The issue itself records which installation processed it, using only the lease `displayName`; never a hostname, username or path.

1. **Status comment.** A `Controller | Factory 3a7d31` row in the status table, and `generation` in the existing `<sub>` footer next to the revisions. Because the comment is edited in place, GitHub's edit history shows when control changed hands. The remote issues view (§13.3) falls back to this row for "Processed by" when the lease cannot be read.
2. **Milestone comments.** Every immutable comment (questions, SPEC, tactical decision, delivery reports, failure) ends with `<sub>Factory 3a7d31</sub>`, so the origin of each result is permanent.
3. **Takeover notice.** After a takeover, the new controller posts one immutable comment on each open issue that carries factory labels and has no local work item:

   > Control of this repository moved from Factory 3a7d31 to Factory b912aa. The status above was written by the previous controller and is no longer maintained. Post `/factory start` to continue this issue here.

   The notice is idempotent through the usual `<!-- ai-factory:... -->` marker keyed by issue id and generation. It is the only comment a newly active controller writes on an issue it does not track, and it replaces the silent "Not tracked here" situation with an explicit call to action. The new controller does not edit or remove the previous controller's status comment.

## 14. Events and observability

Local events: `controller.acquire_requested`, `controller.acquired`, `controller.renewed` (only when the SHA changes hands or after a failure, not every 2 minutes), `controller.standby`, `controller.ownership_uncertain`, `controller.lost`, `controller.release_requested`, `controller.released`, `controller.takeover`, `controller.takeover_rejected`.

Recent events use display names and the repository name; SHAs, generation and instance ids go in troubleshooting details. The daemon log records acquisition, renewal failures, fencing decisions and takeovers as single structured lines and never logs credentials or the authenticated remote URL.

## 15. Failure behavior

| Failure | Required result |
| --- | --- |
| Two factories acquire an absent ref concurrently | One compare-and-swap succeeds; the other becomes standby |
| Active factory loses GitHub connectivity | Uncertain after 10 minutes; no mutation; running work held, applied on recovery with the same generation |
| Standby loses connectivity | Stays standby; cannot take over |
| Record malformed or repository id differs | Refuse acquisition; show a configuration error |
| Renewal sees another owner or a higher generation | Fenced immediately; running work interrupted as `controller-lost` |
| Long update | Lease may expire; same instance reclaims on return |
| Owner host disappears | Lease expires; explicit takeover becomes available |
| Old owner returns after takeover | Sees the new generation, becomes fenced, then standby |
| Ref deleted by an administrator | Owner becomes fenced on next read; any instance may acquire fresh |
| Legacy daemon online | Not protected; cutover must stop or upgrade it |

## 16. Security and permissions

The GitHub credential needs push access to `refs/ai-factory/*` in addition to its existing issue, pull-request and contents permissions; `repo` scope covers it. Branch rulesets are unaffected. The ref is readable by anyone with read access, so the record carries a neutral display name and no host information by default. Deleting the ref requires a Git push and counts as ownership loss, not as a silent reset.

## 17. Data changes

```text
repository_controller
  repository_id
  instance_id
  generation
  remote_sha
  state
  last_verified_at
  last_error
```

One row for the configured repository. The remote ref is the source of truth; the local row is never sufficient to authorize a mutation.

`executions.interruption_reason` adds `controller-lost`. A held result body remains only in the running daemon's bounded in-memory buffer; the event log records a content-free `agent.result.held` marker. Recovery or ownership loss records `agent.result.held_applied` or `agent.result.held_discarded`. A daemon crash discards the in-memory result instead of persisting agent output outside the normal result transaction.

## 18. Cutover

No compatibility mode exists for daemons that do not honor the lease.

1. Stop every factory daemon targeting the repository.
2. Upgrade or reinstall each factory with controller support.
3. Choose the intended active installation and acquire.
4. Start the others; verify they show standby.
5. Reconcile old labels and comments; restart only the issues intended to continue.

## 19. Acceptance criteria

1. Two fresh instances racing to acquire one repository produce exactly one active and one standby controller.
2. A standby daemon applies no command, schedules no agent, publishes no projection, pushes no branch and opens no pull request.
3. A standby dashboard names the active controller and explains why the local issue list may be empty.
4. Ten minutes without renewal move the active daemon to uncertain with no remote mutation; a running execution finishes and its result is held.
5. A held result is applied when renewal succeeds with the same generation, and discarded when a higher generation is observed.
6. Observing a higher generation interrupts the running execution as `controller-lost` and pauses the work item.
7. Restart and update keep ownership for the same instance, even after expiry, unless a takeover happened meanwhile.
8. Uninstall releases only after local work and services are handled; a failed release is reported with the takeover command.
9. Expiry alone never triggers takeover.
10. Takeover is atomic; two attempts cannot both succeed.
11. Force takeover requires typed confirmation and records both owners in the local event.
12. Repository rename does not change ownership; a recreated repository with the same name is rejected by id.
13. Lease operations never modify the application checkout, its branches or its default branch, and never trigger a GitHub Actions push workflow.
14. The lease record and logs contain no credentials, local paths, usernames, prompts or issue content.
15. A standby dashboard lists the repository's factory-labelled issues with their label-derived stage and status, marked as processed by the active controller, and offers no workflow action on them.
16. An active dashboard marks factory-labelled issues without a local work item as "Not tracked here" and offers no automatic import.
17. Status and milestone comments identify the controlling installation by display name, and the status footer carries the generation.
18. A takeover posts exactly one notice per open factory-labelled issue the previous controller tracked, naming both installations and the `/factory start` command; repeated takeovers with the same generation post nothing.

## 20. Required tests

Against a local bare repository as `origin`:

- Absent-ref acquisition race from two isolated homes.
- Renewal with the correct and an incorrect expected SHA.
- Standby guards on poll, scheduler and publisher.
- Uncertain: held result applied after recovery with the same generation.
- Fenced: ownership change during each agent stage and immediately before delivery publication.
- Same-instance restart after expiry; cross-instance takeover; force takeover.
- Release with and without unsafe work; forced local uninstall with the remote unavailable.
- Malformed record, repository-id mismatch, deleted ref.
- Dashboard and CLI content for active, standby, uncertain, fenced and expired states.
- Remote issues view: label-derived stage and status, "Processed by" from the lease, "Tracked here" versus "Not tracked here", and absence of workflow actions in standby.
- Controller attribution: status row and footer, milestone footer, takeover notice idempotency by issue id and generation.
- End to end: one `/factory start` produces one work item and one projection while two factories are online.

## 21. Decisions closed in this revision

1. Storage: a custom ref, not a branch, and no external service.
2. Timing: 2-minute heartbeat, 10-minute expiry, protocol constants.
3. Daemon stop lets the lease expire; takeover stays manual.
4. Force takeover with active work is allowed after typed confirmation; refusing it would block the lost-host case.
5. `displayName` plus optional free-text `contact`; no dashboard URL, which is loopback-only.
6. The ref is not protected from administrators; deletion is treated as ownership loss.
7. Cooperative fencing is sufficient for this product; legacy daemons are handled by cutover.

## 22. Implementation order

1. Instance identity in `<home>/instance.json` and read-only `controller status`.
2. Atomic acquire, renew, release and takeover client with local bare-repository tests.
3. Daemon startup gate; standby state in dashboard, doctor and service summary; remote issues view.
4. Fencing at the three points; uncertain with held results; fenced with `controller-lost` interruption.
5. Uninstall release and CLI takeover with typed confirmation; controller attribution on status and milestone comments; takeover notice.
6. Dashboard controller card with actions.
7. Cutover documentation and the two-factory end-to-end test.

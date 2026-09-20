# Repository Controller Lease

**Status:** Draft for external review  
**Scope:** Prevent multiple AI Factory installations from operating the same GitHub repository concurrently  
**Implementation status:** Not implemented

## 1. Purpose

AI Factory stores its workflow state, execution history, context, worktrees and
maintenance state locally. A local daemon lock prevents two daemon processes
from sharing one data directory, and repository identity prevents one data
directory from being reused for a different GitHub repository. Neither control
protects a repository from factories running on different hosts or from
separate installations on the same host.

This specification introduces one remote repository-controller lease. Exactly
one installation may mutate factory-owned state for a repository at a time.
Other configured installations remain available for administration but operate
in standby mode.

The design favors safety and explicit recovery over automatic failover. It does
not attempt to make local SQLite state portable between machines.

## 2. Problem

Two installations configured with the same `GITHUB_REPOSITORY` independently:

- poll the same issues and comments;
- interpret the same `/factory` command;
- update the same labels and status comment;
- create unrelated local work-item ids and context histories;
- create or publish overlapping branches and pull requests; and
- report different states in their local dashboards.

The GitHub actor does not identify the machine because both installations often
use the same `gh` credentials. From the issue, duplicate publications appear to
come from the same user.

### 2.1 Observed failure

An older factory remained active on one Mac while a fresh installation was
created on another. The older daemon consumed commands for a newly created
issue, reused historical local workflow state associated with the same issue
number, edited the GitHub issue and continued an obsolete Review stage. The new
dashboard showed no issue because its own database was empty.

Stopping services during install and uninstall prevents a stale daemon on the
same host. It cannot stop or even discover a daemon running on another host.

### 2.2 Existing protections and their boundary

| Protection | What it prevents | What it does not prevent |
| --- | --- | --- |
| Local `daemon_lock` | Two daemons using one SQLite database | Separate data directories or hosts |
| Stored GitHub repository id | Reusing one data directory for a different or recreated repository | Multiple databases bound to the same repository |
| Issue id and node id | Treating a recreated issue as the previous issue | A second factory processing the same current issue |
| Deterministic GitHub projection | Duplicate publications from one database | Conflicting projections from different databases |

## 3. Goals

1. At most one lease-aware factory may process or mutate a GitHub repository.
2. Acquisition must be atomic across hosts.
3. A standby factory must remain visible and diagnosable in its dashboard.
4. Loss of ownership must stop new work and prevent later publication of stale
   agent results.
5. Update, restart, stop and uninstall must have explicit lease semantics.
6. Recovery from a lost host must be possible without an external database.
7. The mechanism must not add commits to the application default branch or
   require a new hosted coordination service.
8. Operator-facing state must identify which installation owns the repository
   without exposing secrets.

## 4. Non-goals

- Running multiple workers concurrently against one repository.
- Moving SQLite workflow state or worktrees between hosts.
- Seamlessly resuming an in-progress workflow on a different installation.
- Electing a new controller automatically after an outage.
- Stopping a legacy daemon that does not implement this protocol.
- Becoming a general distributed scheduler.

## 5. Core decision

Each GitHub repository has one **controller lease** stored on a dedicated remote
branch. The proposed branch name is:

```text
ai-factory-control
```

The branch is independent of `main`, `develop` and factory delivery branches.
Its current commit contains only `lease.json`. Lease acquisition and takeover
update the branch through Git's compare-and-swap behavior:

```text
git push --force-with-lease=<control-ref>:<expected-sha>
```

For initial acquisition, the expected value is an absent ref. For renewal or
takeover, the expected value is the exact SHA previously read. If another
installation changes the ref first, the push fails and ownership is not
granted. A normal forced push without an expected SHA is forbidden.

A dedicated bare control repository under `<factory-home>/data/controller.git`
creates and pushes control commits. Lease operations never check out or modify
the target application's working tree.

## 6. Installation identity

Every factory home receives a stable identity at installation:

```text
<factory-home>/data/instance.json
```

Example:

```json
{
  "schemaVersion": 1,
  "instanceId": "3a7d31bc-14c9-4e78-a2ab-1490d96055cf",
  "displayName": "Factory 3a7d31",
  "createdAt": "2026-09-20T16:00:00.000Z"
}
```

`instanceId` is random and never reused. `displayName` is editable in the
dashboard. The default does not contain the operating-system username, hostname
or a filesystem path. The identity is removed only by purge uninstall.

## 7. Remote lease record

`lease.json` contains:

```json
{
  "schemaVersion": 1,
  "repositoryId": 123456789,
  "repositoryNodeId": "R_kgDOExample",
  "instanceId": "3a7d31bc-14c9-4e78-a2ab-1490d96055cf",
  "displayName": "Factory 3a7d31",
  "generation": 8,
  "mode": "active",
  "engineVersion": "0.3.0",
  "acquiredAt": "2026-09-20T16:00:00.000Z",
  "heartbeatAt": "2026-09-20T16:08:00.000Z",
  "expiresAt": "2026-09-20T16:18:00.000Z",
  "activeWorkCount": 1
}
```

Rules:

- Repository identity uses GitHub's stable numeric and node ids, not only
  `owner/name`.
- `generation` increments on acquisition and takeover. Renewal keeps it.
- `mode` is `active` or `maintenance`.
- The initial proposal is a two-minute heartbeat and a ten-minute expiry. These
  are internal protocol constants in the first version, not environment
  settings.
- Renewal force-replaces the control commit without preserving a visible commit
  history. GitHub may temporarily retain unreachable objects; the branch shows
  only the current record.
- No token, local path, username, prompt, issue content or agent output may be
  stored in the lease.

## 8. Controller states

Each configured installation derives one controller state:

| State | Meaning | Allowed behavior |
| --- | --- | --- |
| `unconfigured` | Repository identity is unavailable | Dashboard/configuration only |
| `acquiring` | Atomic acquisition is in progress | No issue processing or remote mutation |
| `active` | This instance owns the current generation | Normal orchestration |
| `standby` | Another instance owns the repository | Read-only diagnostics and takeover UI |
| `uncertain` | Ownership cannot be verified | Stop intake and remote mutation; interrupt running work safely |
| `releasing` | Local work is being checked before release | No new executions |

`standby` is a healthy daemon state, not a crash. Service health and the
dashboard must distinguish “daemon running, controller standby” from “daemon
stopped”.

## 9. Acquisition protocol

When a configured daemon starts:

1. Resolve and verify the repository's stable GitHub identity.
2. Read `refs/heads/ai-factory-control` and validate its record.
3. If the ref does not exist, create generation 1 with an atomic absent-ref
   expectation.
4. If the ref belongs to this `instanceId`, renew it and become active. This
   supports ordinary restart and update.
5. If another unexpired owner exists, enter standby.
6. If another expired owner exists, remain standby and offer explicit takeover.
   There is no automatic cross-instance failover.
7. If compare-and-swap fails, reread the ref. Become active only if the new
   value proves this instance owns it.

The daemon must acquire ownership before recovering executions, polling issue
commands, scheduling agents or publishing a GitHub projection.

## 10. Renewal and self-fencing

The active daemon renews the lease every two minutes. Each renewal uses the
last observed control-ref SHA as its expected value.

The daemon becomes `uncertain` when it cannot prove ownership before the local
expiry deadline. In that state it:

1. stops polling and scheduling;
2. records a local `controller.ownership_uncertain` event;
3. interrupts a running execution through the planned-interruption path;
4. keeps the workflow locally `PAUSED` with reason `controller-lost`; and
5. performs no GitHub comment, label, assignment, branch, PR or merge mutation.

Before every externally visible mutation, the responsible boundary calls
`assertController(generation)`. Required boundaries include:

- command application that will change workflow state;
- GitHub status, milestone comment, label and assignee publication;
- delivery branch push;
- pull-request creation or update; and
- merge detection that will finalize a workflow.

Agent computation may finish after ownership is lost, but its result is stored
only as discarded local evidence and is never applied or published.

This is cooperative fencing. A legacy factory that ignores the lease remains a
risk and must be stopped during cutover.

## 11. Takeover and release

### 11.1 Normal release

Release is refused while the local database has `QUEUED`, `RUNNING`, `WAITING`,
`FAILED` or `PAUSED` work unless the operator explicitly resolves or abandons
that work. The release action uses compare-and-swap against the current SHA and
deletes the control ref only when this instance still owns it.

Basic uninstall and purge uninstall both attempt a normal release after local
maintenance has safely paused work and before credentials or engine files are
removed. If GitHub is unavailable, uninstall reports that the remote claim
could not be released; it does not silently claim success. A force option may
remove local files, but the output must give the exact takeover recovery path.

Stopping only the daemon does not release ownership. It lets the lease expire.
Restarting the same installation reclaims its own lease. This prevents a
routine restart from unintentionally handing the repository to another host.

### 11.2 Takeover

Another installation may take over only through an explicit operator action.
The dashboard shows the current owner, heartbeat, expiry, generation and last
reported active-work count.

Normal takeover is available after expiry. Force takeover before expiry
requires typing the repository name and acknowledging that another factory may
still be running. Both use compare-and-swap against the displayed lease SHA;
the generation increments exactly once.

Takeover does not import workflow state. If the previous owner reported active
work, the new controller:

- does not infer or resume that work from GitHub comments;
- lists affected factory-labelled issues as requiring reconciliation;
- requires a new authorized `/factory start` before creating local state; and
- warns that previous worktrees and unpublished commits remain on the old host.

## 12. Maintenance lifecycle

- **Update/restart:** keep the same instance identity and generation. Set the
  lease to `maintenance` before pausing work. The dashboard or one-shot updater
  renews it while the daemon is unavailable. Return to `active` only after the
  daemon is healthy.
- **Daemon stop:** stop renewal and leave the claim to expire. No standby
  instance takes over automatically.
- **Dashboard stop:** no effect while the daemon can renew.
- **Stop all:** renewal stops and the lease eventually expires.
- **Uninstall:** perform the release described in §11.1.
- **Install:** never overwrites an existing remote lease. A newly configured
  installation becomes standby when another owner exists.

The existing local maintenance barrier remains responsible for preserving
work-item state. The controller lease adds a repository-wide barrier before
local scheduling and publication; it does not replace maintenance.

## 13. Dashboard and CLI

### 13.1 Dashboard

Add a **Repository controller** card to Services and Project configuration.

Active example:

```text
Active controller
Factory 3a7d31 · generation 8
Last verified 34 seconds ago
1 active work item
```

Standby example:

```text
Standby
Factory b912aa controls this repository.
Last heartbeat 3 minutes ago; lease expires in 7 minutes.
This installation will not process issues or modify GitHub.
```

The issue list in standby must explain that it reflects this installation's
local database and may be empty. It must not imply that GitHub has no factory
issues.

Actions:

- **Refresh controller status**
- **Release control** when locally active and safe
- **Take over** when another lease is expired
- **Force takeover** behind typed confirmation

### 13.2 CLI

```text
ai-factory controller status
ai-factory controller acquire
ai-factory controller release
ai-factory controller takeover
ai-factory controller takeover --force
```

`doctor` reports repository-controller ownership separately from GitHub
authentication and local daemon locking. Starting a configured daemon in
standby returns success and prints the owning installation.

## 14. Events and observability

Local events:

- `controller.acquire_requested`
- `controller.acquired`
- `controller.renewed`
- `controller.standby`
- `controller.ownership_uncertain`
- `controller.lost`
- `controller.release_requested`
- `controller.released`
- `controller.takeover`
- `controller.takeover_rejected`

Recent events use the display name and repository name. Raw ref SHAs,
generation and instance id belong in expandable troubleshooting details.

The daemon log records acquisition, renewal failures, fencing decisions and
takeovers as single-line structured entries. It never logs credentials or the
authenticated remote URL.

## 15. Failure behavior

| Failure | Required result |
| --- | --- |
| Two factories acquire an absent ref concurrently | One compare-and-swap succeeds; the other becomes standby |
| Active factory loses GitHub connectivity | It becomes uncertain before local expiry and stops mutation |
| Standby loses GitHub connectivity | It stays standby and cannot take over |
| Lease record is malformed or repository id differs | Refuse acquisition and show a configuration/integration error |
| Renewal sees a different owner or generation | Fence immediately and pause local running work |
| Update exceeds the ordinary lease duration | Updater/dashboard renews maintenance ownership |
| Owner host disappears | Lease expires; explicit takeover becomes available |
| Old owner returns after takeover | Its next verification sees the new generation and remains fenced |
| Legacy daemon remains online | Not protected; cutover must stop or upgrade every legacy daemon |

## 16. Security and permissions

The GitHub credential needs permission to read and update the control branch in
addition to its existing issue, PR and contents permissions. Branch protection
must allow the factory identity to update `ai-factory-control`; force pushes to
application branches remain unnecessary.

The control branch is visible to repository readers. Its record therefore uses
a neutral display name and contains no host information by default. Repository
administrators can delete the branch manually as an emergency release, but the
dashboard should identify that as ownership loss rather than silently
recreating it.

## 17. Data changes

The local schema needs durable cached controller state sufficient for restart
and diagnostics:

```text
repository_controller
  repository_id
  instance_id
  generation
  remote_sha
  state
  last_verified_at
  expires_at
  last_error
```

Only one row exists for the configured repository. The remote ref is the source
of truth; the local row is never sufficient to authorize a mutation.

`executions.interruption_reason` adds `controller-lost`. Maintenance and
workflow status continue to use the existing `PAUSED` projection.

## 18. Cutover

There is no compatibility mode for daemons that do not honor the lease.

1. Stop every existing factory daemon targeting the repository.
2. Upgrade or reinstall each factory with controller support.
3. Choose the intended active installation and acquire the repository.
4. Start other installations; verify they show Standby.
5. Reconcile old GitHub labels/comments and explicitly restart only the issues
   intended to continue.

The lease feature must not be enabled while an older daemon remains active.

## 19. Acceptance criteria

1. Two fresh instances racing to acquire one repository produce exactly one
   active controller and one standby controller.
2. A standby daemon performs no issue-command application, agent scheduling,
   GitHub projection, branch push or PR operation.
3. A second installation's dashboard identifies the active controller and
   explains why its local issue list may be empty.
4. Losing renewal moves the active daemon to uncertain, interrupts its active
   execution as `controller-lost` and produces no later remote publication.
5. A stale agent result is discarded after another instance increments the
   generation.
6. Restart and update retain ownership for the same instance without allowing a
   standby instance to process work.
7. Uninstall releases ownership only after local work and launchd services are
   safely handled; release failure is reported explicitly.
8. Expiry alone never triggers automatic takeover.
9. Explicit takeover is atomic; two takeover attempts cannot both succeed.
10. Force takeover requires typed confirmation and records both previous and
    new owners in the local event.
11. Repository rename does not change ownership because the stable GitHub id is
    used.
12. Recreated repositories with the same `owner/name` are rejected because the
    repository id differs.
13. Lease operations never modify the application checkout or its default
    branch.
14. The lease record and logs contain no credentials, local paths, usernames,
    prompts or issue content.

## 20. Required tests

- Atomic absent-ref acquisition race using two isolated data directories.
- Renewal with the correct and incorrect expected SHA.
- Standby poll/scheduler/publisher guards.
- Ownership loss during each agent stage and immediately before branch/PR
  publication.
- Same-instance restart and cross-instance takeover.
- Maintenance renewal during a long update.
- Graceful release, release with active work and forced local uninstall when
  GitHub is unavailable.
- Malformed record, repository-id mismatch and deleted control branch.
- Dashboard and CLI content for active, standby, uncertain and expired states.
- End-to-end test proving that one GitHub command produces one work item and one
  projection while two factories are online.

## 21. Open questions for review

1. Is a force-updated orphan control branch acceptable, or should coordination
   use a small external service despite the additional operational dependency?
2. Are a two-minute heartbeat and ten-minute expiry appropriate, given that
   takeover is always manual?
3. Should daemon stop reserve ownership indefinitely, or is expiry plus manual
   takeover the preferred behavior?
4. Should force takeover be refused whenever the last lease reported active
   work, or is a strong warning sufficient?
5. Is `displayName` enough to locate the owning installation, or should an
   optional operator-supplied dashboard URL be allowed in the public lease?
6. Should the control branch be protected from human deletion, and can the
   expected GitHub permission model support that consistently?
7. Is cooperative fencing sufficient for this product, given that a legacy or
   modified daemon cannot be prevented from writing with valid credentials?

## 22. Recommended implementation order

1. Instance identity and read-only controller status.
2. Atomic acquire/renew/release client with integration tests.
3. Daemon startup gate and standby dashboard state.
4. Mutation-boundary fencing and ownership-loss interruption.
5. Maintenance and uninstall integration.
6. Explicit takeover UX and CLI.
7. Cutover documentation and multi-instance acceptance test.


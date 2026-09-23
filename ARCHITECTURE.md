# Architecture

## End-to-end flow

The workflow stores **stage** and **status** independently. Stage is one of `DESIGN`, `BUILD`, `TEST`, `REVIEW`, `DELIVERY`; status is one of `QUEUED`, `RUNNING`, `WAITING`, `FAILED`, `PAUSED`, `CANCELLED`, `COMPLETED`.

```text
Open GitHub issue + /factory start
  → DESIGN/QUEUED → Architect
  → [significant UX impact: DESIGN/QUEUED → Designer prototype]
  → DESIGN/WAITING → exact SPEC approval, read through its brief (and prototype)
  → BUILD/QUEUED → Builder
  → TEST/QUEUED → Tester
  → REVIEW/QUEUED → Reviewer
  → DELIVERY/WAITING → human PR merge
  → DELIVERY/COMPLETED
```

The Architect returns two documents in one run. The brief holds only what needs the human: decisions with a recommendation and the consequence of getting them wrong, the solution in a few lines, the acceptance criteria and the assessment. The SPEC is the full technical contract for Builder, Tester and Reviewer. The human approves the brief; the SPEC is folded under it in the same comment and approved with it as one version. The stored specification body leads with the brief, so delivery roles see what the human decided, and the Reviewer flags product decisions the brief does not contain. Changing a decision is `/factory answer`, which produces a new version.

The Architect assesses `uxImpact` as none, minor or significant. Only significant (a new screen or flow, or a changed interaction) opens a Designer-owned `prototype` request instead of the human approval. The Designer builds a disposable prototype in the project's stack with mock data under `.factory/prototype/`, with a screenshot per relevant state and a README; it may write nothing else. The orchestrator commits and pushes it, publishes the screenshots linked at that exact commit, and only then opens the human approval: one gate for brief and prototype. When the Builder first starts, the orchestrator moves the prototype to the Git-excluded `.factory-prototype/` in the worktree and removes it from the branch, so Builder, Tester and Reviewer can consult it and the pull request diff never contains it.

## Epics and stories

The Architect may split an issue into two to four stories with the SPEC; the human approves the split with the brief. On approval the epic moves to `BUILD/WAITING` with a `stories` request instead of queueing a Builder, and the orchestrator creates each story as a GitHub sub-issue of the epic, blocked by the stories it waits for, through the native relationship APIs rather than text or labels. The local `stories` table is the ledger that keeps this idempotent: a story whose issue already exists under the epic with the same title, created by the Factory account, is adopted rather than created again.

A story starts when nothing it is blocked by remains open as anything but completed: the orchestrator assigns it to the Factory account, labels it with the epic's instance, and creates its work item at `BUILD/QUEUED` with the epic branch as its base and a specification that is its slice of the epic contract, approved by the epic's approval. Builder and Tester run on the story branch; there is no Review of a story. After Test the story is integrated into the epic branch through one merge commit, its issue is closed as completed, and its work item completes. Once every story of the current plan is integrated, the epic resumes at Review on its own branch: because its head moved, the runner sends it through Test first, so the criteria no story owned and the whole are verified once, and the Reviewer sees the complete diff before the single pull request to the repository default branch. Reviewer findings are corrected on the epic branch.

Findings can return to Builder, request an Architect tactical decision, or be explicitly deferred. A tactical decision retains the approved SPEC and can return only to an allowed unfinished stage. Automatic correction cycles are bounded.

Each issue has a token budget. `WorkflowRunner` checks it before preparing a run; an exhausted budget, or a finished run without reported usage that nobody acknowledged, moves the queued item to `WAITING` with a human `budget` request instead of starting an agent. A run in progress always finishes. Approvers extend the budget with `/factory budget +<tokens>`, stored as a `budget` record; consumption is the sum of each execution's provider-reported total and travels with the published issue state keyed by execution id. An epic and its stories share one budget: consumption is summed over the family and an extension granted on any of their issues counts for all of them, so a split never multiplies what an issue may spend.

## Authoritative data

SQLite is authoritative. `work_items` stores the current projection and monotonic revision. Typed `records` store instructions, decisions, findings and requests with provenance and lifecycle. `failures`, immutable SPEC versions, executions, maintenance operations, outboxes and audit events remain separate durable concepts. Runtime never rebuilds state by replaying events.

Every accepted projection change atomically writes one `workflow.transition`, refreshes derived active request/failure pointers and queues its Slack notification. A stale expected revision fails rather than overwriting concurrent work.

GitHub mirrors the projection with one stage label, an optional condition label and one editable status comment containing exactly one current next action. It is not the execution engine. Closed issues are removed from operational views; reopening returns the same item paused without replaying comments posted while closed.

## Agent context

Each invocation starts a fresh provider process. `ContextAssembler` selects active records by lifecycle, SPEC version and role. Approved SPEC, active human decisions, active instructions, relevant open findings, active request chain and active failure are protected from budget pruning. Optional history is deterministic and byte-bounded.

Every execution persists the exact `prompt.md`, a permanent `prompt.json` inclusion manifest, byte count and SHA-256. Tester receives changed-file manifest plus diff stat without Builder conclusions. Reviewer receives the same stat, attributed Tester evidence and a full diff in an owner-marked, Git-excluded `.factory-context` directory that is deleted after the run.

## Execution and recovery

`ExecutionManager` starts each provider below a per-run supervisor. Explicit cancellation records `cancelled` and may escalate TERM to KILL. Planned interruption uses supervisor IPC, records `interrupted` with a reason and does not use the cancellation escalation timer. Unexpected daemon loss terminates the worker group; restart converts the same stage to `FAILED` with a recovery failure and preserves its worktree for explicit Retry.

Disruptive update, daemon stop/restart and daemon-affecting configuration changes use a durable maintenance handshake. Preflight captures exact runnable item revisions, confirmation revalidates them, the scheduler barrier prevents a new run, active work becomes `PAUSED`, and service work begins only after processes exit. Tasks remain paused until individual Retry or batch resume.

The service launcher treats launchd acceptance and runtime readiness as
different states. Start/restart wait for a stable service PID; daemon readiness
also requires the local runtime lock created after doctor succeeds. Stop and
uninstall verify that launchd no longer reports the job before claiming
completion.

## Repository and delivery

Each work item owns a `factory/*` branch and isolated worktree, and records the base branch it grew from: the repository default branch for an issue, so that an epic can later give its stories its own branch as their base. The worktree is created from that base, every stage merges it in, the diff the Tester and Reviewer see is measured against it, and the pull request targets it. Agents cannot commit or push; the orchestrator verifies role mutation boundaries, creates commits and publishes only the assigned branch. Reviewer pass creates or reuses a PR. Human merge is mandatory.

Repository recovery exposes only Check, Sync from remote, Publish branch, Clear local copy and Restore from remote. Check is read-only; Sync is clean fast-forward only; Publish refuses unrelated/default branches; Clear requires the exact configured path twice and pauses affected work; Restore requires an empty directory.

Multiple Factory installations can share a repository through per-issue `factory-instance:<name>` labels. Each installation processes its assigned issues and can continue published issue state explicitly. The local daemon lock prevents duplicate processes sharing a data directory, and stored repository identity prevents reusing that directory for another repository. There is no repository-wide remote lease or standby mode.

## Adapters and observability

Claude, Codex, Cursor, GitHub and Slack are isolated behind adapters. Each role selects one provider and direct model ID or `auto`; the policy uses that configured routing directly. Architect records complexity and risk for human approval of the specification.

The dashboard and CLI read the same V3 projection. Recent executions expose stage, role, model, duration, token usage and interruption reason. `execution.finished` additionally carries what the run did inside itself: how many JSON objects the provider wrote, a histogram keyed by the event types it reported, the turn count, wall and API duration and the cost estimate when the provider states them, and cache reads recorded apart from cache writes. These ride the event payload rather than the executions table, so the database schema is unchanged. `factory activity` groups them per role, and `factory benchmark` turns one run of the fixed issue in `docs/BENCHMARK.md` into a saved baseline that a later run is compared against, refusing the comparison when an independent oracle did not confirm the run resolved the issue. Prompt content requires an explicit local sensitive-content acknowledgement. Exact prompts and logs are pruned 30 days after completion/cancellation by default while manifests and hashes remain. Slack and GitHub delivery use independent durable queues. For browser checks the orchestrator starts the target repository's preview script and waits for a loopback origin in `.local/url`, reading that file as a list so a repository that also announces LAN or tunnel addresses still works. The issue carries a machine-readable state index that lets the work item be recovered from GitHub; when it would exceed the issue body limit the publisher sheds narrative text until it fits rather than dropping the index, because recovery reads identifiers and statuses and never prose.

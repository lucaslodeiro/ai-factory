# Architecture

## End-to-end flow

The workflow stores **stage** and **status** independently. Stage is one of `DESIGN`, `BUILD`, `TEST`, `REVIEW`, `DELIVERY`; status is one of `QUEUED`, `RUNNING`, `WAITING`, `FAILED`, `PAUSED`, `CANCELLED`, `COMPLETED`.

```text
Open GitHub issue + /factory start
  → DESIGN/QUEUED → Architect → DESIGN/WAITING
  → exact SPEC approval
  → BUILD/QUEUED → Builder
  → TEST/QUEUED → Tester
  → REVIEW/QUEUED → Reviewer
  → DELIVERY/WAITING → human PR merge
  → DELIVERY/COMPLETED
```

Findings can return to Builder, request an Architect tactical decision, or be explicitly deferred. A tactical decision retains the approved SPEC and can return only to an allowed unfinished stage. Automatic correction cycles are bounded.

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

Each work item owns a `factory/*` branch and isolated worktree. Agents cannot commit or push; the orchestrator verifies role mutation boundaries, creates commits and publishes only the assigned branch. Reviewer pass creates or reuses a PR. Human merge is mandatory.

Repository recovery exposes only Check, Sync from remote, Publish branch, Clear local copy and Restore from remote. Check is read-only; Sync is clean fast-forward only; Publish refuses unrelated/default branches; Clear requires the exact configured path twice and pauses affected work; Restore requires an empty directory.

Multiple Factory installations can share a repository through per-issue `factory-instance:<name>` labels. Each installation processes its assigned issues and can continue published issue state explicitly. The local daemon lock prevents duplicate processes sharing a data directory, and stored repository identity prevents reusing that directory for another repository. There is no repository-wide remote lease or standby mode.

## Adapters and observability

Claude, Codex, GitHub and Slack are isolated behind adapters. Each role selects one provider and direct model ID or `auto`; the policy uses that configured routing directly. Architect records complexity and risk for human approval of the specification.

The dashboard and CLI read the same V3 projection. Recent executions expose stage, role, model, duration, token usage and interruption reason. Prompt content requires an explicit local sensitive-content acknowledgement. Exact prompts and logs are pruned 30 days after completion/cancellation by default while manifests and hashes remain. Slack and GitHub delivery use independent durable queues.

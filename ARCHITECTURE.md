# Architecture

## End-to-end flow

```text
GitHub Issue
    |
    v
Design — Product Architect (Architect; configured provider; Claude by default)
    |  <---- clarification / human feedback loop
    v
WAITING_SPEC_APPROVAL
    |
    | human approves
    v
Build — Implementation Engineer (Builder; configured provider; Codex by default)
    |
    v
Test — Verification Engineer (Tester; configured provider; independent context; Codex by default)
    |
    +-- auto-fix ----------> Implementation Engineer
    +-- decision-required -> Product Architect -> human only when major
    +-- defer -------------> record issue/finding and continue
    |
    v
Review — Delivery Reviewer (Reviewer; configured provider; independent context; Claude by default)
    |
    +-- changes required --> appropriate upstream role
    |
    v
READY_TO_MERGE
    |
    v
Human merge
```

## Components

### Local Orchestrator
A TypeScript daemon/CLI owns workflow state. GitHub labels/comments are events and a visible mirror; they are not the authoritative state machine.

### State Store
SQLite stores work items, executions, transitions, decisions, agent outputs, durations, retries, and audit events.

### Execution Manager
Each agent invocation receives a run ID and tracked OS process. It supports cancellation, timeout, retry, pause, and crash recovery. After orchestrator restart, an interrupted execution is never assumed successful.

### Workspaces
Each work item gets an isolated Git worktree and branch. Agents cannot push directly to the default branch.

### Adapters
Provider-specific adapters isolate Claude CLI, Codex CLI, GitHub, and Slack from orchestration logic. Each role maps independently to a provider and fast/balanced/strong model set. The deterministic router selects a profile from approved task complexity/risk and correction context, then dispatches through that role's configured adapter.

### Observability
Structured event logs contain timestamps, work-item ID, run ID, role, transition, duration, exit status, and references to inputs/outputs. Human-readable logs are retained alongside them.

## Human authority

Product Architect may make tactical decisions autonomously and document them. It must escalate decisions that materially change product behavior, architecture, scope, risk, or contradict an explicit human decision. It may challenge human proposals and present alternatives, but never silently override an explicit human decision.

Implementation Engineer does not escalate directly to the human. Ambiguities go to Product Architect first.

## Finding policy

- `auto-fix`: safe correction consistent with approved decisions; automatically return to Implementation Engineer.
- `decision-required`: Product Architect evaluates; escalate to human only under the human-authority rules.
- `defer`: record explicitly and continue when it does not block acceptance.
- Repeated loops automatically escalate rather than retry forever.

## Implemented tactical and recovery paths

A decision-required result enters Product Architect with the approved spec and the originating role. `resolved` records a tactical decision and returns to an allowed delivery stage without revising the spec or approval. Major questions/revisions enter WAITING_HUMAN. No route may skip unfinished Test or Review.

Each agent process now runs under a per-run supervisor that detects daemon IPC disconnection and terminates its process group. A persisted stage checkpoint prevents a process exit being mistaken for a completed workflow transaction after a crash. Retry waits for interrupted groups to exit and preserves partial work for revalidation.

Slack has a separate durable queue, independent of GitHub delivery, with retry backoff and actionable issue links. See [SPEC.md](SPEC.md) for the acceptance criteria and limitations.

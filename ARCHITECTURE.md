# Architecture

## End-to-end flow

```text
GitHub Issue
    |
    v
Product / Architect (Claude)
    |  <---- clarification / human feedback loop
    v
WAITING_SPEC_APPROVAL
    |
    | human approves
    v
Developer (Codex)
    |
    v
QA (independent Codex context)
    |
    +-- auto-fix ----------> Developer
    +-- decision-required -> Product / Architect -> human only when major
    +-- defer -------------> record issue/finding and continue
    |
    v
Reviewer (independent Claude context)
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
Provider-specific adapters isolate Claude CLI, Codex CLI, GitHub, and Slack from orchestration logic.

### Observability
Structured event logs contain timestamps, work-item ID, run ID, role, transition, duration, exit status, and references to inputs/outputs. Human-readable logs are retained alongside them.

## Human authority

Product/Architect may make tactical decisions autonomously and document them. It must escalate decisions that materially change product behavior, architecture, scope, risk, or contradict an explicit human decision. It may challenge human proposals and present alternatives, but never silently override an explicit human decision.

Developer does not escalate directly to the human. Ambiguities go to Product/Architect first.

## Finding policy

- `auto-fix`: safe correction consistent with approved decisions; automatically return to Developer.
- `decision-required`: Product/Architect evaluates; escalate to human only under the human-authority rules.
- `defer`: record explicitly and continue when it does not block acceptance.
- Repeated loops automatically escalate rather than retry forever.

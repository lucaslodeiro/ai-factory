# AI Factory — consolidated MVP specification

Version: 1.1, 2026-09-19. This document is the implemented MVP requirements baseline. Superseded suggestions (cloud execution, GitHub Actions orchestration, a combined provider context and legacy state compatibility) are excluded.

## Objective

Run a software factory on the user's Mac that turns a GitHub Issue into a tested, independently reviewed pull request. The human owns significant product/architecture decisions and merge. Agents work on versioned artifacts; the local TypeScript orchestrator owns workflow state and execution lifecycle.

## Decisions retained from the design

| ID | Decision |
|---|---|
| D01 | Orchestration and agent processes always execute locally. GitHub is the collaboration UI, not the execution engine. Initial platform: macOS, without Docker. |
| D02 | Four independent roles: Product Architect (Architect) in Design, Implementation Engineer (Builder) in Build, Verification Engineer (Tester) in Test and Delivery Reviewer (Reviewer) in Review. Each invocation starts a fresh context. The operator configures Codex or Claude independently for every role, then selects the direct model ID or `auto`; defaults remain Claude, Codex, Codex and Claude respectively. |
| D03 | GitHub Issues accept requests and human feedback; comments and labels mirror progress. SQLite is authoritative for workflow state and audit history. |
| D04 | Initial specs and material revisions need explicit human approval. Approved specs are immutable versioned contracts with verifiable acceptance criteria. |
| D05 | Product Architect may challenge a human decision and propose alternatives, but cannot silently override it. Major product, architecture, scope, risk or conflicting decisions go to the human. |
| D06 | Tactical questions consistent with approved constraints are resolved and documented by Product Architect, without another human approval. Implementation Engineer consults this role first. |
| D07 | Verification Engineer derives verification from the approved spec independently. It may create/modify tests and run commands, but must not change production code. |
| D08 | Delivery Reviewer checks specification compliance, quality, security, performance, product/UI/copy consistency, tests and dependencies. |
| D09 | Internet is allowed for documentation and dependencies. Extra environment secrets require an explicit allowlist. Local provider authentication remains available. |
| D10 | Slack notifies; decisions happen in GitHub. Required notices include state changes and human action, with a direct link and explanation. |
| D11 | Runs must be observable, cancellable, subject to timeout and recoverable. Interrupted work must never be assumed successful. |
| D12 | The factory repository and target demo/application repository are separate. Human merge is required. |

## Actors and artifacts

- Human: submits work, answers questions, approves an exact spec version, resolves major choices and merges.
- Product Architect (**Architect**, Design): reads the request and repository; proposes requirements, alternatives and architecture; produces specs or tactical decision records.
- Implementation Engineer (**Builder**, Build): implements the approved contract in the assigned worktree; declares changes, tests, coverage and dependency rationale.
- Verification Engineer (**Tester**, Test): independently verifies each approved criterion; reports evidence and classified findings; only test edits are permitted.
- Delivery Reviewer (**Reviewer**, Review): independently reviews the delivered implementation/diff and all required review dimensions.
- Orchestrator: controls identity, state, approvals, role routing, execution, persistence, commits, pushes and PR creation.

Artifacts: immutable spec markdown plus structured acceptance criteria; approval login/comment ID; tactical decisions with rationale; structured per-role reports; run logs/completion records; Git commits/work branches; GitHub comments/PR; durable notification queues.

## Functional requirements and acceptance criteria

### F01 — Issue ingestion

An authorized standalone `/factory start` comment, dashboard action or CLI action accepts one open issue and creates one work item and branch name. Ordinary polling never imports unrequested issues. Repeated starts or daemon restarts cannot duplicate the repository/issue identity. The factory owns only its stage and condition labels; unrelated labels remain unchanged.

### F02 — Fresh role contexts

Each role invocation receives its common contract, provider-specific instructions, applicable template and current approved artifacts. Verification Engineer/Delivery Reviewer do not inherit Implementation Engineer conversation or conclusions. Documented Product Architect decisions are shared, since they are part of the authoritative work contract. Delivery Reviewer receives the implementation diff and attributed Verification Engineer test commands/results and criterion evidence, without Verification Engineer summary conclusions. It independently inspects code and test quality, and never claims Verification Engineer executions as its own.

### F03 — Clarification and human authority

Only configured GitHub human logins can issue `/factory answer <text>` and `/factory approve vN`. Bot comments, quoted commands, wrong versions and commands preceding the newly generated spec are not approval. Human feedback returns to Product Architect. Changes to old comments are not treated as new commands; post a new comment.

### F04 — Versioned specification gate

A proposal contains nonempty markdown and unique structured criterion IDs also appearing in the markdown. Unresolved questions use the questions outcome, not a ready-to-approve proposal. A human approves the exact current version before delivery starts. Revisions append a new immutable snapshot and invalidate previous approval and delivery evidence.

### F05 — Tactical consultation

Given an approved spec and a question raised from Implementation Engineer, Verification Engineer or Delivery Reviewer, Product Architect can return a `resolved` result with only tactical decisions, rationale, no human conflicts and a permitted return role. The spec, criterion set, version and original approval remain unchanged. No new approval notice is generated. Decisions are recorded and supplied to later roles.

The return route cannot skip a gate: an Implementation Engineer consultation returns to Implementation Engineer; Verification Engineer can return to Implementation Engineer or Verification Engineer; Delivery Reviewer can return to Implementation Engineer, Verification Engineer or Delivery Reviewer. Returning upstream invalidates affected downstream reports. An initial spec cannot be self-approved through this route. A revised spec or unresolved major question must return to the human gate.

### F06 — Build / Implementation Engineer report

Before passing to Verification Engineer, an Implementation Engineer result must contain evidence for every approved criterion, at least one successful executed test command with numeric zero exit code, explicit changed-file and dependency arrays, and no blocking findings or human conflicts. Added/updated/removed dependencies require a rationale. Empty dependency arrays explicitly mean none reported.

### F07 — Test / Verification Engineer

Verification Engineer receives approved requirements and decisions, derives tests independently, and reports criterion-level evidence. Passing requires all criteria covered and successful executed tests. Non-test file edits fail the stage before the orchestrator commits. The MVP recognizes `test`, `tests`, `spec`, `specs`, `__tests__` directories and `.test.*` / `.spec.*` filenames; other test layouts need an explicit future policy extension.

### F08 — Review / Delivery Reviewer gate

Delivery Reviewer PASS requires evidence for every approved criterion and each review dimension: specification, code quality, security, performance, product/UI/copy, test quality and dependencies. Not-applicable checks require evidence too. Missing checks, failed dimensions, unresolved major decisions or blocking findings prevent readiness.

### F09 — Finding routing

- `auto-fix`: return to Implementation Engineer, preserving the approved contract, then rerun downstream verification.
- `decision-required`: consult Product Architect; tactical resolution follows F05, otherwise the human gate applies.
- `defer`: record the finding in the full report; it does not block a PASS when all acceptance criteria pass.

Correction cycles are bounded by configuration. Reaching the limit requires human guidance instead of an infinite retry loop.

### F10 — Pull request delivery

After Builder, Tester and Reviewer pass for the current approved work, push only the work item's `factory/*` branch and create or reuse its open PR against the configured base. Do not merge automatically or push to the default branch. The item remains `DELIVERY/WAITING` until merge. Merge records `DELIVERY/COMPLETED` with timestamp/commit; an unmerged closed PR remains waiting with a closed merge request and can resume tracking on reopen. API errors never alter the projection.

### F11 — Execution, cancellation and recovery

Every invocation has a run ID, role, supervisor PID/process group, timestamps, exit code, stdout/stderr and completion record. The CLI can cancel an item/run or stop the daemon from another process. Timeouts terminate the group, escalating to SIGKILL. Status is read-only with respect to execution recovery.

A per-run supervisor detects loss of its daemon IPC channel and terminates its worker group. On restart, interrupted runs become the same stage with `FAILED`, preserve their worktree, and require explicit retry. Planned service maintenance is distinct from cancellation: it records `interrupted/planned-maintenance`, leaves work `PAUSED`, blocks new execution starts and supports batch resume. Confirmation is bound to exact item revisions. Partial work is retained and recovery never silently approves it.

A transactional singleton lock prevents simultaneous daemons for a data directory. Schema migrations are serialized across daemon and CLI startup.

### F12 — Notifications and external outages

Every persisted state transition queues a Slack message atomically with state. Messages use Slack Block Kit with a clear heading, project, issue, readable status and a direct GitHub link. Human-action messages identify the required action, spec version, relevant question, assessment or report summary, and the exact response command. Failure messages preserve the actionable cause and retry command. Slack HTTP failures are retained with exponential retry backoff up to five minutes. They do not block workflow execution or GitHub delivery. Disabled Slack retains pending notifications for later configuration.

GitHub comments use their own durable idempotent outbox. Slack webhooks have no transactional acknowledgement with SQLite: delivery is at least once, so a crash after Slack accepts but before local acknowledgement can duplicate a message. No real Slack channel is required for local tests.

### F13 — Auditability

Retain versioned specs/criteria, approval identity, tactical decisions, full structured reports, transitions, control requests, execution events and logs. Publish human-readable Markdown reports to GitHub with summaries and expandable evidence; preserve complete structured artifacts in SQLite. Mirror the workflow using known state labels and one updatable progress comment; Open/Closed remains the issue lifecycle, with closure on PR merge. `status`, `events` and `notifications` provide inspection. A result schema validates shape and internal consistency; it does not independently prove that an agent's claimed evidence is true.

### F14 — Installation and acceptance demo

Provide reproducible Node 22+ installation, explicit repo/data directories, provider executable overrides, Git/GitHub author/auth checks and `factory doctor`. A separate demo issue must complete the live four-role flow and produce a PR before the MVP is accepted end-to-end. Unit/integration fixtures do not substitute for this live check.

### F15 — Task-aware model selection

Use the direct-v1 policy in `docs/MODEL_POLICY.md`: Product Architect reports complexity, risk and rationale with each new spec; the human approves that assessment with the exact spec version. Each role has a configured Codex/Claude provider and one direct model, or `auto` to omit the model override and let the provider use its recommended/default model. The deterministic orchestrator uses the approved assessment and correction context for workflow safeguards, without translating them into another model. A high-complexity or high-risk draft receives a fresh Architect review before a version is published for approval; questions and retries preserve that requirement. Every provider call records its configured selection and internal workflow tier. No silent provider or model fallback.

## Requirements traceability

| Requirement | Implementation | Automated evidence |
|---|---|---|
| F01 | `src/workflow-inbox.ts`, `src/workflow-orchestrator.ts` | `test/workflow-inbox.test.ts`, `test/daemon.test.ts` |
| F02 | `src/context-assembly.ts`, `src/workflow-records.ts`, provider contracts | `test/context-assembly.test.ts`, `test/worktree-context.test.ts` |
| F03–F05 | `src/workflow-commands.ts`, `src/workflow-results.ts`, `specs` and `records` | `test/workflow-commands.test.ts`, `test/workflow-results.test.ts` |
| F06–F08 | `src/results.ts`, `src/worktrees.ts` | `test/results.test.ts`, `test/workspaces.test.ts` |
| F09–F10 | `src/workflow-results.ts`, `src/workflow-github.ts` | Result routing, GitHub projection and full daemon tests |
| F11 | `src/execution-manager.ts`, `src/worker-supervisor.mjs`, `src/daemon.ts` | `test/execution.test.ts`, `test/recovery.test.ts`, `test/storage.test.ts`, cross-process cancel/retry/stop in `test/daemon.test.ts` |
| F12 | `src/notifications.ts`, `src/adapters/slack.ts`, SQLite queues | `test/notifications.test.ts`, GitHub-outage notification case |
| F13 | `src/workflow-projection.ts`, `src/workflow-status.ts`, `src/cli.ts`, `src/dashboard.ts` | Projection, publisher, dashboard and daemon tests |
| F15 | `src/model-policy.ts`, adapters, spec snapshots and execution events | `test/model-policy.test.ts`, workflow routing and subprocess argument/audit assertions |
| F14 | `INSTALL.md`, `src/doctor.ts`, demo repository | Historical real four-role demo reached delivery readiness and created demo PR #2; see `docs/VALIDATION.md` |

## Operational boundaries and remaining acceptance work

The orchestrator runs locally, sequentially, one target repository/data directory per daemon. The installed local dashboard is the normal control plane. Docker, a remote runner, automatic merge and a multi-repository scheduler remain outside this MVP.

The environment allowlist and role mutation checks are implemented. Worktrees, provider sandboxes and prompts are **not a complete OS security boundary** against malicious code running as the local user. Strong read isolation from unrelated repositories/credential files is not established by these checks; trusted repositories are the operational assumption. Provider auth stores remain accessible. Detached processes that deliberately leave the managed process group are outside supervisor cleanup guarantees.

The real four-role demo completed through explicit human approval and all providers, producing demo PR #2 for human review/merge. Remaining optional operational checks: real Slack delivery and live complex-task model escalation. GitHub Actions activation is optional and currently blocked by the OAuth credential's workflow scope. See `docs/VALIDATION.md` for actual evidence rather than treating this specification as a completion claim.

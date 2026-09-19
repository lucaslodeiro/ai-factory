# AI Factory — Context and Workflow Evolution Specification (v3)

**Status:** Draft for design review — supersedes v1 and v2 (2026-09-19)
**Date:** 2026-09-19
**Audience:** Product and architecture reviewers, AI agents, future implementers
**Scope:** Agent context management, workflow state, audit events, GitHub issue projection
**Implementation status:** Describes the current system (verified against `src/` at commit `5c8baaf`) and the reviewed candidate evolution. Not implemented or approved.

## 0. What changed in v3

V1 diagnosed the right problems but proposed more machinery than the current factory needs. V2 corrected that design after inspecting the implementation at commit `5c8baaf`. V3 keeps V2's reduced architecture and resolves the contradictions found during review.

| Area | V3 decision |
| --- | --- |
| Durable memory | One typed `records` table. Instructions, decisions, findings and requests have identity, provenance, scope and lifecycle. |
| Requests | More than one request may be open. A request may block or temporarily interrupt another through `parent_id`; exactly one is the active human CTA. |
| Instruction replacement | Instructions accumulate until revoked, explicitly superseded or invalidated by a new SPEC. A later unrelated instruction never silently replaces an earlier one. |
| Prompt evidence | Persist the exact prompt and a deterministic inclusion manifest. Protect both as local execution artifacts. |
| Context budgets | Configure one default byte budget with optional overrides by role and exact provider/model, consistent with direct model selection. |
| Workflow | Store stage and status independently. The active request or failure record explains the condition. |
| Events | Keep an authoritative projection and append one transactional transition event for every accepted projection change. Runtime does not replay events. |
| GitHub | Publish only changed revisions. Maintain one authoritative status comment and immutable milestone comments only when a human acts, must act, or the contract changes. |
| Diff delivery | Place reviewer artifacts inside an ignored, read-only worktree context directory so both providers can access them without external-path permissions. |
| Migration | A mandatory one-shot importer preserves active stage, status, SPEC, approval, comment cursor, worktree and pending human action. A fresh recovery path is reserved for items that cannot be imported safely. |
| Summaries | No AI-generated memory summaries. Structured active records make relevance deterministic. |

The central principle remains: context is selected by lifecycle and applicability. Information disappears from a prompt because it was resolved or superseded, never merely because it became old.

## 1. System purpose

AI Factory is a locally executed delivery orchestrator. It turns a GitHub issue into an approved, versioned specification, an implementation in an isolated worktree, independent verification, an independent delivery review, and a pull request for human merge. Four roles (Architect, Builder, Tester, Reviewer) run on Claude or Codex; the deterministic orchestrator owns routing, approvals, transitions, retries, commits, publication and PR creation.

Authority model, unchanged:

- The human owns product, architecture, scope, risk and merge decisions.
- Architect may resolve tactical choices inside an approved SPEC.
- Builder, Tester and Reviewer identify decisions; they never silently change the contract.
- SQLite is authoritative for execution and workflow state. GitHub is the collaboration surface and a readable projection. Slack is a notification channel.

Operational boundary, unchanged: one daemon, one repository, macOS, sequential agent stages, fresh provider invocations (`--no-session-persistence`); the provider conversation is not memory.

## 2. Current implementation (corrected)

This section fixes the v1 description where the code disagrees.

### 2.1 Work-item context

All workflow memory is one `Context` JSON on `work_items` (`src/types.ts:26-35`): issue fields, SPEC/criteria/assessment, `decisions`, `consultation.from`, approval, comment `cursor`, `waiting`, `feedback: string[]`, `cycles`, `resume`, `retryGuidance`, `lastFailure`, `pendingStage`, `reports` (latest per role), `pr`, `merge`. Immutable SPEC snapshots live in `specs`; run records in `executions` (with token counts); telemetry in `events`.

### 2.2 How a prompt is built today (`src/prompts.ts`)

1. Role contract (`agents/common/<role>.md`), provider file, report template, common rules, runtime PATH rule, role-specific rules — about 10 KB of static text, **role first**, so the prefix differs per role.
2. A JSON block with issue, SPEC, criteria, `decisions`, approval, and role-conditional fields.
3. `feedback`: for Architect and Builder, `conciseFeedback(context.feedback)` — the **last 20** entries, each clipped to 4 KB, total capped at 24 KB counted from the newest. Tester and Reviewer receive `[]`.
4. `retryGuidance` (single field, last writer wins) appended to **every** role, including Tester and Reviewer.
5. For Reviewer, the **complete, unbounded** `git diff` of the worktree (`src/orchestrator.ts:284`).

`context.feedback` mixes three kinds of strings: human answers (`"login: text"`), retry guidance (`"login retry guidance: text"`), and full agent reports serialized as JSON (`"Tester: {…}"`, `src/orchestrator.ts:341`). Relevance is recency.

### 2.3 Facts v1 got wrong or omitted

| # | Fact | Where |
| --- | --- | --- |
| F1 | **The exact prompt is not retained anywhere.** It is piped to the supervisor's stdin; only stdout/stderr are kept under `runs/<id>/`. | `src/worker-supervisor.mjs:30-33`, `src/execution-manager.ts` |
| F2 | Events are already a repair source: comment cursor high-water is rebuilt from events, and retry rebuilds approval and the consultation route by scanning `spec.approved` events and `reports`. | `src/storage.ts:41`, `src/retry.ts:20-40` |
| F3 | The v1 example for C1 is already patched by a special case (`consultationQuestion`). | `src/orchestrator.ts:314-320` |
| F4 | Retry guidance reaches Tester and Reviewer; only `feedback` is withheld. | `src/prompts.ts:56-60` |
| F5 | `cycles` increments on `decision` outcomes as well as `changes`; a legitimate decision request consumes a correction cycle. | `src/orchestrator.ts:341` |
| F6 | A new SPEC version replaces `decisions` wholesale and resets `reports`; human answers survive only as feedback strings. | `src/orchestrator.ts:329-331` |
| F7 | Routes missing from v1's transition table: architectural draft review (`architectDraft`, `spec.review_required`), correction-limit resolution through `/factory answer` (resets `cycles`, keeps the consultation), recovery from GitHub (`recoverManagedIssue` → `PAUSED`, `resume: "SPEC"`), and silent discard of a result when the state changed during execution. | `src/orchestrator.ts:291,300-306,187-201`; `processHumanComment` |
| F8 | GitHub is a fallback source of truth: `recoverManagedIssue` rebuilds a work item from labels and comments and restarts at Architect. That is the bar the current system already sets for "migration does not replay work". | `src/orchestrator.ts:187-201` |
| F9 | `NEW` is a dead state: `ingest` inserts directly in `SPEC`. | `src/orchestrator.ts:203-213` |
| F10 | Claude restricts tools per role (Architect/Reviewer read-only); Codex uses `--sandbox workspace-write` for every role and the mutation boundary is enforced after the fact by `worktrees.check`. | `src/adapters/claude.ts:9-11`, `src/adapters/codex.ts:17`, `src/worktrees.ts:53` |
| F11 | `flush()` calls `syncState` for every work item on every tick; `syncState` does `issue view` + a full comment listing + possible label edits and a PATCH. There is no "publish only if changed" guard. | `src/orchestrator.ts:268-272`, `src/adapters/github.ts` |
| F12 | The comment cursor jumps to the latest comment after each Architect output so stale commands are ignored. Any request model must preserve that property. | `src/orchestrator.ts:313` |

## 3. Problems

v1 ids are kept; new ones are added.

### Context

- **C1** One object with many responsibilities (canonical facts, transient state, checkpoints, prompt memory).
- **C2** Decisions lack id, source, actor, SPEC version, scope, status, supersession.
- **C3** Human guidance has no explicit scope or roles.
- **C4** Feedback is chronological: relevance is inferred from recency, so resolved reports survive and old constraints fall off.
- **C5** Latest reports are overwritten in `context.reports`; history only survives in events.
- **C6** No prompt provenance. Sharpened by F1: not "incomplete", absent.
- **C7** Coarse token control: the 24 KB cap covers one input; Reviewer diff, SPEC and static text are unbounded or repeated.
- **C8** Ordinary approver comments are observed and ignored; users are surprised.
- **C9 (new)** Tester independence and human constraints share one switch: withholding `feedback` from Tester also withholds human answers (F4).
- **C10 (new)** A new SPEC version erases tactical decisions and demotes human answers to strings (F6).
- **C11 (new)** Static prefix is role-first, defeating provider prompt caching across consecutive role executions.

### Workflow

- **W1** One enum mixes stage, condition, control and PR lifecycle.
- **W2** `FAILED` hides the stage; `resume` reconstructs it.
- **W3** `WAITING_HUMAN` subtype lives in `context.waiting`.
- **W4** Tactical return route is a mutable field (`consultation.from`) with repair heuristics in `retry.ts` (F2).
- **W5** `state.changed` carries `from/to` only; reason, actor, run and comment are separate events.
- **W6** Immutable comments accumulate old CTAs and failure messages.
- **W7** One label cannot express stage and condition.
- **W8** Technical failures, invalid results, human decisions and correction limits look the same.
- **W9 (new)** Correction cycles count decisions (F5).
- **W10 (new)** Real routes are undocumented (F7) and a discarded result leaves no domain trace.
- **W11 (new)** GitHub publication cost is proportional to work items × ticks, not to changes (F11).

## 4. Goals and non-goals

### Goals

- Every role receives the complete set of **active** records that apply to it, and nothing that is resolved or superseded.
- Human instructions and decisions have identity, scope, roles, status and provenance; an active one cannot be dropped by any budget.
- Every execution's exact prompt is retained and its inclusions are listed.
- Stage survives failure, pause and retry without inference.
- Requests (clarification, approval, tactical decision, correction limit, merge) are durable rows, not context fields.
- One transition event per accepted change, in the same transaction as the projection.
- GitHub shows current stage, condition and one valid CTA; publication happens only when the projection revision changed.
- Cutover is a single, guarded operation.

### Non-goals

- Event sourcing or replay at runtime.
- AI-generated summaries of context.
- Token estimation before execution.
- Dual-write or compatibility readers for the legacy `Context` shape.
- Auto-merge, multi-repository, AI-driven routing, sending prompts or logs to GitHub.

## 5. Records: the unit of memory

### 5.1 Table

```sql
CREATE TABLE records(
  id            TEXT PRIMARY KEY,          -- uuid
  work_item_id  TEXT NOT NULL REFERENCES work_items(id),
  kind          TEXT NOT NULL,             -- 'instruction' | 'decision' | 'finding' | 'request'
  spec_version  INTEGER NOT NULL,          -- version in force when created (0 before first SPEC)
  scope         TEXT NOT NULL,             -- 'spec' | 'issue'
  status        TEXT NOT NULL,             -- see 5.3
  topic         TEXT,                      -- stable semantic topic for instructions/decisions
  applies_to    TEXT NOT NULL DEFAULT '[]',-- JSON array of AgentRole; [] = all roles
  payload       TEXT NOT NULL,             -- JSON, per kind (5.2)
  source_type   TEXT NOT NULL,             -- 'github-comment' | 'agent-result' | 'orchestrator'
  source_id     TEXT NOT NULL,             -- comment id | execution id | event id
  actor         TEXT NOT NULL,             -- login | role
  parent_id     TEXT REFERENCES records(id),      -- requests: causal/interrupted parent
  superseded_by TEXT REFERENCES records(id),      -- records.id
  resolved_by   TEXT REFERENCES executions(id),   -- executions.id
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX records_active ON records(work_item_id, kind, status, spec_version);
```

One table, one insert path, one query path. TypeScript types it as a discriminated union on `kind`.

### 5.2 Payload per kind

```ts
type RecordPayload =
  | { kind: "instruction"; text: string; supersedes?: string[] }                                   // human, unstructured
  | { kind: "decision"; category: "human" | "tactical"; decision: string;
      rationale: string; supersedes: string[] }                             // structured
  | { kind: "finding"; classification: "auto-fix" | "decision-required" | "defer";
      originRole: AgentRole; criterionId?: string; evidence: string }
  | { kind: "request"; type: "clarification" | "spec-approval" | "tactical-decision"
        | "correction-limit" | "merge"; originatingStage: Stage;
      allowedReturnStages: Stage[]; openedAfterCommentId: number;
      questions?: string[]; findingIds?: string[]; prClosed?: boolean };
```

### 5.3 Status and who changes it

| Kind | Statuses | Transition owner and trigger |
| --- | --- | --- |
| instruction | `active` → `superseded` \| `revoked` | Orchestrator: only explicit `supersedes` ids or `/factory replace <id> <text>` supersede an instruction; a new SPEC version supersedes `scope: spec`; `/factory revoke <id>` revokes. Author and overlapping roles alone never imply replacement. |
| decision | `active` → `superseded` | Orchestrator, from `supersedes` in an Architect result (tactical) or a new SPEC version (`scope: spec`). Human decisions are never superseded by an agent (`category: human` may only be superseded by a record whose `source_type` is `github-comment`). |
| finding | `open` → `resolved` \| `accepted-defer` \| `superseded` | Orchestrator: when the next role returns `pass` for the same version, open `auto-fix` findings of the previous role → `resolved` with `resolved_by`; `defer` → `accepted-defer` on `pass`; new SPEC version → `superseded`. `decision-required` → `resolved` when the request it opened is resolved. |
| request | `open` → `resolved` \| `cancelled` \| `superseded` | Orchestrator: resolved by the matching command or Architect result; cancelled by `/factory cancel`; superseded only when the new request explicitly replaces it. A nested clarification points to the interrupted request through `parent_id`; resolving it restores the parent as the active CTA. |

Comment edits never change a record; a new comment creates a new record. Open requests for a work item form one chain, never a branching tree: a request may have at most one open child, and the orchestrator rejects a transition that would create a sibling. Exactly one request is selected as the active human request. Other open requests remain durable but blocked by their child. The active request is the deepest open record in the chain; resolving it exposes its nearest open ancestor, if one exists.

### 5.4 Scope

Two values only. `spec` dies with the next SPEC version; `issue` survives until explicitly superseded or revoked. v1's `attempt` and `stage` scopes are removed: a hint like "rerun the failing test" carried with `spec` scope is harmless because the role contract already says "when compatible with the approved specification".

Defaults: `/factory answer` → decision `category: human`, `scope: spec`. `/factory retry <text>` → a new instruction, `scope: spec`, `applies_to: []`; it does not replace prior instructions. `/factory note <text>` behaves the same. `--issue` sets `scope: issue`; `--for builder,tester` sets `applies_to`; `--topic <name>` adds a stable classification. Replacement is explicit through `/factory replace <record-id> <text>` and removal through `/factory revoke <record-id>`. The status comment lists short record ids for active human instructions so these commands are usable.

### 5.5 Tester and human instructions

An instruction reaches Tester when `applies_to` is empty or names `qa`. The Tester contract keeps its existing rule: if an instruction forbids a verification method, use an equivalent; if none exists for a required criterion, return `decision`. This decouples independence (never send Builder narrative or findings text to Tester) from constraints (always send active human instructions that apply).

## 6. Prompt assembly

### 6.1 Order (stable prefix first)

1. Common rules and the common result envelope, identical across roles and providers.
2. Provider-specific runtime rules.
3. Role contract, role-specific result schema and template.
4. Dynamic block.

Static text precedes dynamic text. Only the common envelope is shared across every role; role-specific schemas stay with their contracts. This preserves schema correctness while maximizing prefix reuse for consecutive executions on the same provider.

### 6.2 Dynamic block as queries

```
spec, criteria, assessment           = specs WHERE version = current (approved for delivery roles)
instructions                         = records WHERE kind='instruction' AND status='active'
                                       AND (scope='issue' OR spec_version=current) AND role ∈ applies_to
decisions                            = records WHERE kind='decision' AND status='active'
                                       AND (scope='issue' OR spec_version=current)
openFindings                         = records WHERE kind='finding' AND status='open' AND spec_version=current
openRequests                        = records WHERE kind='request' AND status='open'
activeRequest                        = deepest open request in the parent chain; the only current human CTA
recovery                             = executions WHERE status='interrupted' AND work_item_id=? (latest)
```

### 6.3 Sections per role

| Section | Architect | Builder | Tester | Reviewer |
| --- | --- | --- | --- | --- |
| Issue title and body | full | full | summary (title + first 2 KB) | summary |
| SPEC, criteria, assessment | yes | yes | yes | yes |
| Active human decisions | yes | yes | yes | yes |
| Active tactical decisions | yes | yes | yes | yes |
| Active instructions (filtered by role) | yes | yes | yes | yes |
| Open requests | full active request plus parent chain | active request if it originated in Build | active request if it originated in Test | active request if it originated in Review |
| Open `auto-fix` findings (full text) | if `decision-required` refers to them | yes | no | ids and status only |
| Open `decision-required` findings | yes | no | no | no |
| Builder summary (last `agent.result`) | if consultation originated in Build | previous attempt only | **no** | no |
| Changed-file manifest + `git diff --stat` | on consultation | yes | yes | yes |
| Full diff | no | no | no | **on disk**, path in prompt (6.5) |
| Tester execution evidence (tests, coverage) | if consultation originated in Test | no | own | yes, attributed |
| Resolved / superseded records | no | no | no | no |
| Recovery note | if interrupted | if interrupted | if interrupted | if interrupted |

### 6.4 Budget

The configuration has one `contextBudgetBytes` default plus optional overrides keyed by exact role and by `provider/model`. Provider/model overrides take precedence, then role overrides, then the default. `auto` uses the role override or global default because the selected model may not be known before invocation. The design does not expose `fast`, `balanced` or `strong` as context-budget categories.

Sections are **protected** (contracts, approved SPEC and criteria, active decisions and instructions, the active request and its parent chain, and open findings required by the role) or **optional** (previous-attempt report, diff stat and historical evidence tables). Optional sections are clipped in a fixed documented order until the total fits. If protected sections alone exceed the budget, the stage fails with class `invalid-context` (§7.5) and no provider is invoked. The factory does not estimate tokens: `executions.input_tokens` is the measurement, while `prompt.json` records prompt bytes and the rule that selected the budget.

### 6.5 Diff delivery

Before Reviewer starts, the orchestrator writes the full diff to `<worktree>/.factory-context/reviewer/diff.patch` and includes `git diff --stat` plus that relative path in the prompt. `.factory-context/` is created with owner-only permissions, ignored by Git and explicitly excluded from mutation guards and commits. The Reviewer contract instructs the provider to read the artifact with read-only tools. Because the file is inside the worktree, Claude and Codex do not need access to an external factory-data path. Tester receives the changed-file manifest and stat and inspects the worktree independently.

### 6.6 Prompt persistence

For every execution the orchestrator writes, before spawning the provider:

- `runs/<id>/prompt.md` — the exact `instructions` string.
- `runs/<id>/prompt.json` — `{ executionId, role, provider, model, specVersion, includedRecordIds, activeRequestId, sectionBytes: {name: bytes}, budgetBytes, budgetSource }`.

`executions` gains `prompt_bytes INTEGER` and `prompt_sha256 TEXT`. Prompt, completion and diff artifacts are written with owner-only permissions, are never served by a public route, and are retained according to §11. The dashboard exposes prompt content only through an explicit reveal action. A remotely bound dashboard must require authentication before that action is available. Configured secrets are redacted and these artifacts are never published to GitHub or Slack.

## 7. Workflow projection

### 7.1 Columns on `work_items`

```ts
type Stage  = "DESIGN" | "BUILD" | "TEST" | "REVIEW" | "DELIVERY";
type Status = "QUEUED" | "RUNNING" | "WAITING" | "FAILED" | "PAUSED" | "CANCELLED" | "COMPLETED";
interface Projection { stage: Stage; status: Status; attempt: number; revision: number;
                       activeRunId?: string; activeRequestId?: string; publishedRevision?: number; }
```

- The reason for `WAITING` is `activeRequestId`, derived from the open request parent chain. The reason for `FAILED` is the current `failures` row (§7.5). No third enum is stored.
- `NEW` and `DONE` do not exist. Ingestion starts at `DESIGN/QUEUED`; merge is `DELIVERY/COMPLETED`; PR closed without merge is `DELIVERY/WAITING` with an open `merge` request flagged `prClosed`.
- Retry: `FAILED|PAUSED|CANCELLED → QUEUED`, same stage, `attempt + 1`. `resume`, `waiting`, `consultation`, `pendingStage`, `retryGuidance`, `feedback`, `reports`, `cycles`, `lastFailure` are removed from `Context`.
- `correction_cycles INTEGER` counts only accepted `changes` outcomes. For a configured maximum `N`, the `changes` outcome increments the counter first; when the new value is `N`, the factory opens `correction-limit` instead of scheduling another automatic correction. Decisions do not consume the counter. `/factory answer` resets it, as today.

### 7.2 Transition table (complete)

| From | Trigger | To | Records | Human-visible |
| --- | --- | --- | --- | --- |
| — | `/factory start` or dashboard | DESIGN/QUEUED | — | Started milestone |
| DESIGN/RUNNING | Architect `questions` (no open tactical request) | DESIGN/WAITING | request `clarification` opened; prior approval invalid | Questions milestone with `/factory answer` |
| DESIGN/RUNNING | Architect `questions` during open tactical request | DESIGN/WAITING | child request `clarification` opened with `parent_id` pointing to the tactical request; tactical request stays open but is blocked; approval kept | Questions milestone |
| DESIGN/RUNNING | Architect `spec`, complexity/risk high, profile ≠ strong | DESIGN/QUEUED | draft stored on execution; next selection forced `strong` | Status comment: architectural review |
| DESIGN/RUNNING | Architect `spec` | DESIGN/WAITING | new `specs` row v+1; `scope: spec` records of v → superseded; request `spec-approval` opened | SPEC milestone with approve/change CTAs |
| DESIGN/WAITING | `/factory answer` (comment id > request.openedAfterCommentId) | DESIGN/QUEUED | decision `human` created; clarification resolved; correction_cycles = 0 | Answer acknowledged in status |
| DESIGN/WAITING | `/factory approve v<N>` exact | BUILD/QUEUED | request resolved; approval recorded | Status update |
| DESIGN/RUNNING | Architect `resolved` for open tactical request | allowed return stage/QUEUED | tactical decisions created (with `supersedes`); request resolved; `decision-required` findings resolved | Decision milestone |
| BUILD/RUNNING | `pass` | TEST/QUEUED | commit; Builder findings `defer` → accepted-defer | Status update |
| TEST/RUNNING | `pass` | REVIEW/QUEUED | commit; open Builder `auto-fix` → resolved | Status update |
| TEST/RUNNING | `changes` | BUILD/QUEUED | findings `auto-fix` opened; correction_cycles + 1 | Status update with findings |
| REVIEW/RUNNING | `changes` | BUILD/QUEUED | findings opened; correction_cycles + 1 | Status update |
| REVIEW/RUNNING | `pass` | DELIVERY/WAITING | publish branch, ensure PR; request `merge` opened | Ready-to-merge milestone |
| BUILD/TEST/REVIEW RUNNING | `decision` | DESIGN/QUEUED | findings `decision-required` opened; request `tactical-decision` opened with `originatingStage` | Decision-request milestone |
| BUILD/TEST/REVIEW RUNNING | `changes` and `correction_cycles + 1 >= max` | same stage/WAITING | request `correction-limit` opened with originatingStage after storing the incremented counter | Correction-limit milestone |
| any/WAITING (`correction-limit`) | `/factory answer` | DESIGN/QUEUED | decision human created; `correction-limit` → resolved; child `tactical-decision` opened with the same originatingStage and the appropriate parent chain; cycles = 0 | Status |
| any active/RUNNING | execution error, timeout, invalid result, invalid context | same stage/FAILED | `failures` row with class | Failure milestone with retry CTA |
| any active | daemon restart during run | same stage/FAILED | failure `recovery`; execution `interrupted` | Failure milestone |
| any active/RUNNING | state changed by control during run | unchanged | event `execution.discarded` | none |
| FAILED/PAUSED/CANCELLED | `/factory retry [text]` | same stage/QUEUED, attempt + 1 | instruction created if text | Retry accepted in status |
| any active | `/factory pause` | same stage/PAUSED | — | Paused milestone |
| any | `/factory cancel` | same stage/CANCELLED | open requests → cancelled | Cancelled milestone |
| DELIVERY/WAITING | PR merged | DELIVERY/COMPLETED | merge request resolved | Merged milestone |
| DELIVERY/WAITING | PR closed | DELIVERY/WAITING | merge request flagged `prClosed` | PR-closed milestone |
| DELIVERY/WAITING (prClosed) | PR reopened | DELIVERY/WAITING | flag cleared | Status |
| — | recovery from GitHub (no local row) | DESIGN/PAUSED | failure `recovery`; clarification request if questions were pending | Recovered milestone |

Guard on every command: a comment resolves a request only when `comment.id > request.openedAfterCommentId` (preserves F12). Older commands are recorded as `command.stale` and ignored.

### 7.3 Transition event

```ts
interface WorkflowTransitionV1 {
  schemaVersion: 1; eventId: string; type: "workflow.transition"; workItemId: string; occurredAt: string;
  actor: { type: "human" | "agent" | "orchestrator" | "github"; id: string };
  source: { commentId?: number; executionId?: string; controlId?: number };
  from: Projection; to: Projection;
  reason: { code: string; summary: string };     // e.g. "spec-approval", "changes", "execution-error"
  recordIds: string[];                            // records created or changed in this transition
  activeRequestId?: string;
  specVersion: number;
}
```

Projection update, records, transition event, notification row and outbox row are written in one SQLite transaction. External delivery stays asynchronous and idempotent. Low-level telemetry events (`execution.*`, `github.*`) remain as they are.

### 7.4 Repair, not replay

The two existing repair heuristics (cursor high-water, approval/consultation recovery in `retry.ts`) are removed from runtime. `factory doctor --repair` reads `events` and `records` to diagnose and, on explicit confirmation, rebuild a projection. Runtime never infers.

### 7.5 Failure classes

Table `failures(id, work_item_id, execution_id, class, message, stage, attempt, created_at)`.

| Class | Example | Owner | Default action |
| --- | --- | --- | --- |
| `execution` | CLI exit, timeout | operator | retry same stage |
| `invalid-result` | schema or routing contradiction | agent/prompt | retry same stage |
| `invalid-context` | protected sections exceed budget | operator/config | fix budget or SPEC size, retry |
| `recovery` | daemon restart | operator | retry same stage; worktree preserved |
| `integration` | GitHub/Slack unavailable | orchestrator | no workflow change; outbox retries |
| `configuration` | missing credential/repository | operator | daemon readiness blocked (`doctor`), no per-issue failure |

Acceptance failures (a criterion proven failed) and human decisions are **not** failures: they are findings and requests.

## 8. GitHub projection

### 8.1 Publish only on change

`work_items.publishedRevision` records the last projection revision published. `flush()` calls `syncState` only when `revision > publishedRevision`, and sets `publishedRevision` after success. This removes the per-tick `issue view` + comment listing per item (W11) and is a prerequisite for anything below.

### 8.2 Status comment (mutable, one per issue)

Stage and status, current actor (agent or human), SPEC version, attempt, open request, latest evidence summary, **exactly one** "Next action" block, PR and dashboard links, and a collapsed `<details>` with the last 10 transitions. Old immutable comments keep their historical CTA text but the editable status comment is authoritative; every milestone comment links back to it and states that it contains the current action.

### 8.3 Milestone comments (immutable)

Only when a human acted or must act, or the contract changed: started, questions, SPEC proposed, SPEC approved, decision request opened, decision resolved, correction limit, failure needing retry, paused, cancelled, ready to merge, PR closed, recovered, merged. Role `pass` reports and intermediate `changes` reports go to the status comment (and the PR body for the final ones), not to immutable comments.

### 8.4 Labels

Two dimensions: exactly one stage label (`factory:design|build|test|review|delivery`) while tracked, plus zero or one condition label (`factory:waiting|failed|paused|cancelled`). `factory:done` replaces the stage label on `COMPLETED`. The filtering case ("what waits on me") justifies the second label; 8.1 keeps its cost proportional to transitions.

### 8.5 Comment markers

Markers keep the current `Work item: <id>` form (recovery depends on it, F8) and add `rev:<revision>` and `event:<eventId>`. `recoverManagedIssue`'s regex must accept both.

## 9. Invariants

1. A delivery role never runs without an approved current SPEC.
2. A human decision is never superseded by an agent-originated record.
3. A tactical decision never broadens scope or routes past an unfinished gate (`allowedReturnStages`).
4. Retry requeues the stored stage; nothing infers a stage at runtime.
5. Failure, pause and cancellation never change `stage` or touch the worktree.
6. A new SPEC version supersedes every `scope: spec` record and resets downstream evidence.
7. Tester never receives Builder narrative or finding text.
8. Reviewer evidence is attributed: its own `tests` versus Tester's.
9. Protected sections are never truncated; an active instruction or decision that applies to the role is always in its prompt.
10. Every execution initially has `prompt.md` and `prompt.json`; after content retention expires, `prompt.json`, byte count and SHA-256 remain as permanent provenance.
11. GitHub delivery failure never changes the projection.
12. Exactly one "Next action" block is current, derived from `activeRequestId`.
13. No projection change without a `workflow.transition` in the same transaction.
14. A comment resolves only a request opened before it.
15. Cutover never replays completed work and never duplicates a GitHub comment.

## 10. Cutover

No long-running dual-write and no legacy readers remain after migration. A mandatory, transactional one-shot importer prevents active work from being reset to Design.

1. Add `metadata.schema_version = 3`. A v3 daemon refuses to operate on an older database and prints the exact migration command.
2. Stop the daemon. `factory migrate --from <v1-data-dir>` reads a snapshot and maps every work item to `{ projection, records[], failures[], specs[] }`. It preserves issue identity, stage, status, approved SPEC and version, approval actor, comment cursor, correction count, worktree and branch references, PR/merge data, retry guidance, active consultation route and the latest role evidence.
3. The importer writes into a new data directory, validates all invariants, and atomically marks it schema v3 only after every row succeeds. It emits a machine-readable migration report and never mutates the source database.
4. Items whose route cannot be proven are imported at their known stage with status `PAUSED`, a `recovery` failure and a clarification request describing the missing fact. They are not reset to Design and do not run automatically.
5. Start v3 against the migrated directory, run `factory doctor`, then `factory refresh`. GitHub publication uses the imported comment cursor and marker ids, so completed work and old commands are not replayed and comments are not duplicated.
6. Recovery from GitHub into `DESIGN/PAUSED` remains an explicit fallback only for an issue absent from both the source database and migration report.

The importer is a pure transformation covered by fixture databases from every supported legacy schema. It may be removed only after the following release and after the documented rollback window closes.

## 11. Resolved decisions

| # | Decision |
| --- | --- |
| 1 | Retry guidance and notes default to `scope: spec`. Instructions accumulate; replacement and revocation are explicit and address stable record ids. |
| 2 | Ordinary comments never enter agent context. `/factory note` is the explicit path; the status comment counts unprocessed approver comments and explains the command. |
| 3 | Tester receives manifest plus `diff --stat`. Reviewer receives the full diff from the protected in-worktree context directory plus the stat inline. |
| 4 | GitHub uses one stage label plus an optional condition label, and publishes only on projection revision changes. |
| 5 | Immutable milestones are limited to human action, contract changes and terminal delivery events. Intermediate reports live in the authoritative status comment and final PR body. |
| 6 | Runtime does not replay events. Projection, records, transition event, notification and outbox write occur in one transaction; `doctor --repair` is explicit diagnosis and repair. |
| 7 | AI summaries are not built. Active structured records are the memory model. |
| 8 | Context uses a global byte budget with exact role and provider/model overrides. Protected context never truncates. |
| 9 | Decisions are superseded through explicit ids. Agent-originated decisions can never supersede a human decision. |
| 10 | Multiple requests may remain open through one non-branching parent chain, but only the deepest open request is the active human CTA. |
| 11 | Schema migration is mandatory and preserves active stage and worktree; GitHub-only recovery is the fallback, not the normal upgrade path. |
| 12 | Records, events, failures and specs are retained. By default, 30 days after `COMPLETED` or `CANCELLED`, exact prompt/completion content, diffs, stdout and stderr are deleted; `prompt.json`, prompt byte count, SHA-256, inclusion ids and execution metadata remain. Operators may increase or disable this retention period. |

Still open:

- Whether Codex should receive a read-only sandbox for Architect and Reviewer. Recommended yes; outside this document's scope.
- Whether prompt content should be visible in the dashboard by default or require an explicit local reveal action. Recommended explicit reveal with a warning that issue content may contain sensitive material.

## 12. Acceptance tests

Style: `node:test` with the existing GitHub, workspace and agent fakes in `test/fixtures.ts`.

1. **Prompt persistence.** Every execution writes `runs/<id>/prompt.md` byte-identical to the supervisor `input`, and `prompt.json` lists included record ids, active request, section bytes and budget source; `executions.prompt_bytes` and SHA-256 match; files have owner-only permissions. Retention deletes content but preserves the manifest and hash.
2. **Consultation survives questions.** Tester `decision` → tactical request open; Architect `questions` → child clarification request whose `parent_id` references the tactical request, approval intact; `/factory answer` resolves the child and restores the tactical request as active; Architect `resolved` returns to `TEST/QUEUED`.
3. **Restart during Build.** Kill during `BUILD/RUNNING` → `BUILD/FAILED` with failure class `recovery`; `/factory retry` → `BUILD/QUEUED`, `attempt + 1`, same worktree path, prompt contains the recovery note.
4. **New SPEC version supersedes.** Records with `scope: spec` of v1 become `superseded` and are absent from the v2 Builder prompt; a `scope: issue` instruction remains.
5. **Protected sections cannot be dropped.** With optional history above the role/model budget, every applicable active instruction remains in the prompt. With protected sections alone above budget, the stage fails with `invalid-context` and no adapter call is made. `auto` uses the role or global budget.
6. **Instruction supersession.** Two unrelated `/factory retry <text>` comments remain active and both appear in the next applicable prompt. `/factory replace <first-id> <text>` activates the replacement and sets the first record's `superseded_by`.
7. **Role filtering.** An instruction with `applies_to: ["developer"]` is absent from the Tester prompt and present in the Builder prompt.
8. **Tester independence.** Tester prompt contains manifest and stat and no Builder summary or finding text; Reviewer prompt contains the stat, the diff file path and Tester evidence under an attribution key.
9. **Finding lifecycle.** Tester `changes` opens `auto-fix` findings; Builder `pass` then Tester `pass` marks them `resolved` with `resolved_by` = Tester's execution id.
10. **Cycle accounting.** With `maxCycles = 2`, Tester `decision` leaves `correction_cycles` unchanged; the first `changes` stores 1 and schedules correction; the second stores 2, opens `correction-limit` and leaves the stage `WAITING`.
11. **Stale command.** An `/factory approve v2` comment with id lower than the `spec-approval` request's `openedAfterCommentId` is ignored and recorded as `command.stale`.
12. **Transactional transition.** Each projection change writes exactly one `workflow.transition` with `from`, `to`, `actor`, `source`, `reason`, `recordIds`; a forced outbox insert failure rolls back projection, records and event.
13. **Publish on change only.** Two consecutive ticks without transitions make zero GitHub calls for that item; one transition produces one label sync and one status-comment update, and `publishedRevision` equals `revision`.
14. **Single CTA.** The status comment body contains exactly one "Next action" heading and reflects stage, status, version, attempt and open request.
15. **Delivery failure isolation.** A GitHub outage during `flush` leaves the outbox row unsent and the projection unchanged; the next tick delivers once (delivery key) with no duplicate comment.
16. **Cutover guard.** A v3 daemon refuses an older schema; the importer preserves stage, approval, cursor, worktree and pending route in fixture databases, and its failure leaves the source untouched; recovery regex matches old and new markers.
17. **Discarded result.** A result arriving after `/factory cancel` leaves projection and records untouched and appends `execution.discarded`.
18. **Prefix stability.** For two roles on the same provider, common rules, common result envelope and provider rules form a byte-identical prefix; role-specific schemas remain different.

19. **Nested request selection.** With a tactical request and child clarification both open, only clarification is `activeRequestId`; resolving it restores the tactical request without losing its originating stage. Attempting to open a sibling request is rejected transactionally.
20. **Protected artifact placement.** Reviewer diff is inside `.factory-context`, readable by both provider adapters, excluded from commits and mutation checks, and created with owner-only permissions.
21. **No accidental supersession.** Instructions with different text, topics or role sets remain active until an explicit replacement, revocation or SPEC-version supersession occurs.
22. **Migration preservation.** Every legacy workflow state fixture maps to the same logical stage and condition, with approved SPEC, cursor, branch/worktree and pending human action preserved; ambiguous routes become paused at the known stage.

## 13. Related documents

- `../ARCHITECTURE.md`, `../SPEC.md`, `MODEL_POLICY.md`, `VALIDATION.md`.
- V1 and V2 are retained in repository history and external review artifacts.

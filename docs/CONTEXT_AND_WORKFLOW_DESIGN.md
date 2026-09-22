# AI Factory — Context and Workflow Evolution Specification (v3.4)

**Status:** Implemented — supersedes v1 through v3.3 (2026-09-19)
**Date:** 2026-09-19
**Audience:** Product and architecture reviewers, AI agents, future implementers
**Scope:** Agent context management, workflow state, audit events, GitHub issue projection
**Implementation status:** Complete. The daemon, dashboard and CLI use the V3 projection; context records, prompt provenance, GitHub projection, maintenance handshake, retention and bounded repository recovery are implemented and covered by automated unit and integration tests.

## 0. What changed in v3

V1 diagnosed the right problems but proposed more machinery than the current factory needs. V2 corrected that design after inspecting the implementation at commit `5c8baaf`. V3 keeps V2's reduced architecture and resolves the contradictions found during review.

| Area | V3 decision |
| --- | --- |
| Durable memory | One typed `records` table. Instructions, decisions, findings and requests have identity, provenance, scope and lifecycle. |
| Requests | More than one request may be open. A request may block or temporarily interrupt another through `parent_id`; exactly one is causally active, and its owner determines whether Architect or a human acts next. |
| Instruction replacement | Instructions accumulate until revoked, explicitly superseded or invalidated by a new SPEC. A later unrelated instruction never silently replaces an earlier one. |
| Prompt evidence | Persist the exact prompt and a deterministic inclusion manifest. Protect both as local execution artifacts. |
| Context budgets | Configure one default byte budget with optional overrides by role and exact provider/model, consistent with direct model selection. |
| Workflow | Store stage and status independently. The active request or failure record explains the condition. |
| Events | Keep an authoritative projection and append one transactional transition event for every accepted projection change. Runtime does not replay events. |
| GitHub | Publish only changed revisions. Maintain one authoritative status comment and immutable milestone comments only when a human acts, must act, or the contract changes. |
| Diff delivery | Place reviewer artifacts inside an ignored, owner-only worktree context directory so both providers can access them without external-path permissions; permissions are hygiene rather than a sandbox boundary. |
| Cutover | V3 requires a new data directory. There is no importer, dual-read path or legacy rollback. |
| Summaries | No AI-generated memory summaries. Structured active records make relevance deterministic. |

The central principle remains: context is selected by lifecycle and applicability. Information disappears from a prompt because it was resolved or superseded, never merely because it became old.

### 0.1 What changed in v3.1

Six corrections from the v3 review, each verified against the code:

| # | Change | Reason |
| --- | --- | --- |
| 1 | `topic` column removed; `PRAGMA foreign_keys = ON` required for the `REFERENCES` clauses (§5.1). | Nothing used `topic`; SQLite ignores foreign keys unless the pragma is set (`src/storage.ts` sets only `busy_timeout` and `journal_mode`). |
| 2 | Conflict rule for accumulated instructions and an operator warning in the status comment (§5.6). | Accumulation replaced "lost instruction" with "contradictory instructions"; the contract must say which wins. |
| 3 | `.factory-context/` mechanism specified: `info/exclude` of the clone, deleted after Reviewer, stat over the same range as the diff, permissions as hygiene (§6.5). | The factory cannot edit the target repository's `.gitignore`; `worktrees.check` relies on `--exclude-standard`; Codex runs every role with `workspace-write`. |
| 4 | Remote-dashboard sentence replaced (§6.6). | `FACTORY_DASHBOARD_HOST` only accepts loopback (`src/config.ts:19-20`); the sentence described an unsupported mode. |
| 5 | `activeRequestId` is stored and must equal its derivation from the request chain (§7.1, test 23). | v3 both stored and derived it without saying which is authoritative. |
| 6 | Replaced by v3.4: the project deliberately requires a fresh V3 data directory and provides no importer (§10). | The operator can uninstall and restart; compatibility code would add risk without product value. |

### 0.2 What changed in v3.2

V3.2 resolves the remaining review findings and defines coordinated maintenance before an operation interrupts agent work:

| # | Change | Reason |
| --- | --- | --- |
| 1 | Requests identify their `owner` (`human` or `architect`); the active request is causal, while `WAITING` is reserved for a human-owned request (§5.2, §7.1). | A tactical-decision request queues Architect and is not a human CTA. V3.1 used `activeRequestId` for both meanings. |
| 2 | The projection stores `activeFailureId`; failures have an explicit lifecycle (§7.1, §7.5). | “The current failure row” was ambiguous after multiple attempts. |
| 3 | Records receive a monotonic per-item sequence (§5.1, §5.6). | Timestamps can tie and therefore cannot define deterministic instruction precedence alone. |
| 4 | Superseded by v3.4: no legacy data is imported. | A clean start removes ambiguous mapping entirely. |
| 5 | GitHub publication uses a presentation revision distinct from workflow revision (§8.1). | Evidence and observed comments may change the status comment without changing stage or status. |
| 6 | `.factory-context/` rejects tracked, pre-existing or symlinked paths before writing (§6.5). | `info/exclude` protects only untracked content and must not hide or overwrite repository-owned files. |
| 7 | Planned maintenance performs preflight, explicit confirmation, a daemon-side execution barrier, safe pause and manual batch resume (§7.6). | Update, restart, stop and configuration apply must not interrupt work without informed consent. |
| 8 | Execution `cancelled` is reserved for an explicit work cancellation; maintenance produces `interrupted` with reason `planned-maintenance` (§7.6). | The current dashboard can show an execution as Cancelled while its issue is Paused, which is technically consistent but misleading. |

### 0.3 What changed in v3.3

V3.3 applies the final implementation-readiness review without changing the architecture:

| # | Change | Reason |
| --- | --- | --- |
| 1 | Planned interruption uses a distinct `ExecutionManager.interrupt(id, reason)` IPC path; explicit cancellation retains forced escalation (§7.6). | The existing `cancel()` path always produces `cancelled` and force-kills, contradicting maintenance invariants. |
| 2 | `QUEUED → RUNNING` is an explicit transactional transition and the maintenance barrier lives in it (§7.2, §7.6). | A scheduler that already read a queued item could otherwise spawn it after maintenance confirmation. |
| 3 | Retry and resume derive `resumeStatus`: human-owned active request → `WAITING`, otherwise `QUEUED` (§7.1). | Requeuing an item with an open human request would hide its CTA and run an agent incorrectly. |
| 4 | Operator signals outside an explicit operation create durable implicit maintenance; only death without the stop handler is unexpected (§7.6). | Direct service stop and Ctrl-C need deterministic pause and resume semantics. |
| 5 | Superseded by v3.4: no legacy database or worktree is imported. | Clean installation is the only cutover path. |
| 6 | `.factory-context/OWNER` distinguishes a stale factory artifact from repository-owned content (§6.5). | A daemon crash must not leave Reviewer permanently blocked, while foreign paths remain protected. |
| 7 | Imported requests use `context.cursor` as `openedAfterCommentId`, and nested tactical clarification preserves its parent (§10). | Using zero can replay an old command; using the latest remote id can lose a maintenance-window answer. |
| 8 | Record sequence assignment, presentation-only transactions, configuration revalidation order and retained execution artifacts are explicit (§5.1, §8.1, §7.6, §11). | These details remove remaining implementation ambiguity. |

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
| F8 | GitHub can recover a missing managed issue from labels and comments, but V3 clean start does not adopt legacy factory items automatically. New work starts explicitly. | Historical V1 behavior; removed in the V4 cutover |
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
- GitHub shows current stage, condition and one valid CTA; publication happens only when its presentation revision changed.
- Cutover is a single, guarded operation.

### Non-goals

- Event sourcing or replay at runtime.
- AI-generated summaries of context.
- Token estimation before execution.
- Dual-write or compatibility readers for the legacy `Context` shape.
- Auto-merge, multi-repository, AI-driven routing, sending prompts or logs to GitHub.

### Complexity boundary and delivery slices

The design remains product-specific. It does not introduce a generic workflow engine, event replay, a plugin framework, arbitrary request graphs or a general Git/GitHub client. Each durable concept answers an observed failure: records prevent lost context, stage/status removes retry inference, presentation revision prevents redundant GitHub writes, and maintenance tables make disruptive operations resumable.

Implementation is released in three independently useful slices:

1. **Core workflow and context:** schema foundation, records, deterministic prompt assembly, stage/status projection, request/failure lifecycle, closed-issue visibility and GitHub projection. Acceptance tests 1–25 and 32.
2. **Safe service maintenance:** transactional start barrier, interrupt versus cancel, confirmation, pause and resume. Acceptance tests 26–31.
3. **Repository recovery:** the five fixed repository actions in §7.7. Acceptance test 33.

No slice adds abstraction for a hypothetical provider, workflow or repository operation. Slice 1 must ship and stabilize before slices 2 and 3. Cutover accepts only a fresh V3 database.

## 5. Records: the unit of memory

### 5.1 Table

```sql
CREATE TABLE records(
  id            TEXT PRIMARY KEY,          -- uuid
  work_item_id  TEXT NOT NULL REFERENCES work_items(id),
  sequence      INTEGER NOT NULL,          -- monotonic within one work item
  kind          TEXT NOT NULL,             -- 'instruction' | 'decision' | 'finding' | 'request'
  spec_version  INTEGER NOT NULL,          -- version in force when created (0 before first SPEC)
  scope         TEXT NOT NULL,             -- 'spec' | 'issue'
  status        TEXT NOT NULL,             -- see 5.3
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
CREATE UNIQUE INDEX records_sequence ON records(work_item_id, sequence);
```

One table, one insert path, one query path. TypeScript types it as a discriminated union on `kind`. Every insert assigns `MAX(sequence) + 1` for that work item inside the same transaction. `Store` enables `PRAGMA foreign_keys = ON` at open; without it SQLite does not enforce the `REFERENCES` clauses above, and the guarantee would be documentation only.

### 5.2 Payload per kind

```ts
type RecordPayload =
  | { kind: "instruction"; text: string; supersedes?: string[] }                                   // human, unstructured
  | { kind: "decision"; category: "human" | "tactical"; decision: string;
      rationale: string; supersedes: string[] }                             // structured
  | { kind: "finding"; classification: "auto-fix" | "decision-required" | "defer";
      originRole: AgentRole; criterionId?: string; evidence: string }
  | { kind: "request"; type: "clarification" | "spec-approval" | "tactical-decision"
        | "correction-limit" | "merge"; owner: "human" | "architect"; originatingStage: Stage;
      allowedReturnStages: Stage[]; openedAfterCommentId: number;
      questions?: string[]; findingIds?: string[]; prClosed?: boolean };
```

### 5.3 Status and who changes it

| Kind | Statuses | Transition owner and trigger |
| --- | --- | --- |
| instruction | `active` → `superseded` \| `revoked` | Orchestrator: only explicit `supersedes` ids or `/factory replace <id> <text>` supersede an instruction; a new SPEC version supersedes `scope: spec`; `/factory revoke <id>` revokes. Author and overlapping roles alone never imply replacement; conflicts between active instructions are resolved by the rule in §5.6. |
| decision | `active` → `superseded` \| `revoked` | Orchestrator, from `supersedes` in an Architect result (tactical), a new SPEC version (`scope: spec`) or an explicit human replacement/revocation. Human decisions are never superseded by an agent (`category: human` may only be superseded or revoked through a GitHub command). |
| finding | `open` → `resolved` \| `accepted-defer` \| `superseded` | Orchestrator: when the next role returns `pass` for the same version, open `auto-fix` findings of the previous role → `resolved` with `resolved_by`; `defer` → `accepted-defer` on `pass`; new SPEC version → `superseded`. `decision-required` → `resolved` when the request it opened is resolved. |
| request | `open` → `resolved` \| `cancelled` \| `superseded` | Orchestrator: a human-owned request is resolved by the matching command; an Architect-owned request by the corresponding Architect result. `/factory cancel` cancels; explicit replacement supersedes. A nested clarification points to the interrupted request through `parent_id`; resolving it restores the parent as the active causal request. |

A comment already processed as a command is immutable workflow evidence; later edits are inert. Authorized prose and unrecognized near-miss commands remain in `context.observedComments` as `{id, updatedAt}` and may be reevaluated when their `updatedAt` changes, until a later command is applied. Applying a command clears that list and freezes those earlier observations. On an untracked issue, each new `updatedAt` of a comment or description is evaluated for start, while issue identity makes starting idempotent. Open requests for a work item form one chain, never a branching tree: a request may have at most one open child, and the orchestrator rejects a transition that would create a sibling. Exactly one request is selected as the active causal request. Other open requests remain durable but blocked by their child. The active request is the deepest open record in the chain; resolving it exposes its nearest open ancestor, if one exists. `owner: human` means the workflow waits and publishes a human CTA. `owner: architect` means Architect is queued or running; it is never described as waiting for the human.

### 5.4 Scope

Two values only. `spec` dies with the next SPEC version; `issue` survives until explicitly superseded or revoked. v1's `attempt` and `stage` scopes are removed: a hint like "rerun the failing test" carried with `spec` scope is harmless because the role contract already says "when compatible with the approved specification".

A command is recognized when `/factory ...` is the first or last non-empty line. Text-taking commands combine inline text with every other line in its original order. Commands embedded in prose, quoted commands and commands in the middle are inert. If both boundary lines are commands, the first wins and the last becomes payload text.

Workflow intake is controlled by GitHub assignment. Assigning an open issue to the authenticated Factory account offers it for work; the sole `factory-instance:<name>` label selects the installation. Dashboard **Add Issue** and `factory start-issue` perform those writes. The daemon claims an unlabelled assigned issue on one poll and starts only after the next poll verifies its label is still the only instance label. `/factory start` is not a command.

`/factory help` is state-neutral. It publishes one idempotent immutable command reference per work item. The authoritative status comment always ends with the same reference in a collapsed **All commands** block.

Defaults: `/factory answer` → decision `category: human`, `scope: spec`. `/factory approve vN <guidance>` records approval and an optional spec-scoped instruction atomically. `/factory retry [--issue] [--for <roles>] <guidance>` and `/factory note [--issue] [--for <roles>] <guidance>` create instructions; without options they use `scope: spec`, `applies_to: []`, and do not replace prior instructions. `/factory pause <reason>` pauses `QUEUED`, `RUNNING` or `WAITING` work in place, preserves open requests and interrupts a live execution with reason `user-pause`; `/factory cancel <reason>` cancels it. Pause/cancel reasons are transition evidence only and never enter an agent prompt. `/factory retry` restores the derived queued or waiting status. When that execution has not exited yet, retry remains at the comment cursor as `command.deferred` and is tried by later polls; after the execution timeout it becomes a clear rejection so a stuck process cannot pin intake forever. An authorized `/factory cancel` may bypass that deferred retry: it supersedes the retry, consumes intervening comments as observed, cancels the workflow and upgrades the live interruption to forced cancellation. Every other later comment remains blocked behind the retry. `--issue` sets `scope: issue`; `--for builder,tester` sets `applies_to`. Replacement is explicit through `/factory replace <#N|id-prefix> <text>` and removal through `/factory revoke <#N|id-prefix>`. Both commands accept active instructions and human decisions; tactical decisions remain agent-owned and inaccessible. The status comment lists both kinds under **Active human guidance**. `#N` is the stable creation rank among all human guidance, including inactive history, so it never shifts or gets reused; id prefixes remain supported. A warning appears when more than three entries are active (§5.6).

### 5.5 Tester and human instructions

An instruction reaches Tester when `applies_to` is empty or names `qa`. The Tester contract keeps its existing rule: if an instruction forbids a verification method, use an equivalent; if none exists for a required criterion, return `decision`. This decouples independence (never send Builder narrative or findings text to Tester) from constraints (always send active human instructions that apply).

### 5.6 Conflicts between active instructions

Instructions accumulate (§5.3), so two active instructions can contradict each other ("use Chromium" / "do not use Chromium"). The design does not detect contradictions; it defines who resolves them:

- The prompt lists active instructions **oldest first** by `sequence`, with their record id and `created_at`. Sequence, rather than timestamp or UUID order, is authoritative when two records are created at the same instant.
- Every role contract states: when two active instructions conflict, the most recent one applies; the agent names both ids and the choice in `summary`. When the agent cannot determine which applies to the work at hand, it returns `decision` with a `decision-required` finding quoting both ids.
- The status comment shows the active instructions with their short ids and, when more than three are active, adds "Consider `/factory replace` or `/factory revoke` to keep guidance current." The threshold is a warning, not a limit.
- The orchestrator never merges, rewrites or ranks instruction text.

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
activeRequest                        = deepest open request in the parent chain; owner determines the next actor
activeFailure                        = unresolved failure named by projection.activeFailureId
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
| Open requests | full active request plus parent chain | no | no | no |
| Open `auto-fix` findings (full text) | if `decision-required` refers to them | yes | no | ids and status only |
| Open `decision-required` findings | yes | no | no | no |
| Builder summary (last `agent.result`) | if consultation originated in Build | previous attempt only | **no** | no |
| Repository map (tracked directories, counts, extensions) | no | yes | no | no |
| Changed-file manifest + `git diff --stat` | on consultation | yes | yes | yes |
| Full diff | no | no | no | **on disk**, path in prompt (6.5) |
| Tester execution evidence (outcome, tests, coverage) | if consultation originated in Test | no | own | yes, attributed and **protected** |
| Resolved / superseded records | no | no | no | no |
| Recovery note | if interrupted | if interrupted | if interrupted | if interrupted |
| Previous attempt | after dashboard interrupt/retry | after dashboard interrupt/retry | after dashboard interrupt/retry | after dashboard interrupt/retry |

`Previous attempt` is an optional section assembled after **Interrupt and retry with this**. It records the interruption time and reason, the file list and `diff --stat` from the interrupted stage's starting commit to the preserved HEAD, the latest result for that stage when one exists, and the guidance record id. It is scoped to the stage and attempt created by that retry, included only for that matching execution and removed atomically when the execution starts, so later stages and attempts cannot receive stale recovery context. Builder also receives **Changed files** when `attempt > 1`, so it can distinguish preserved code from the next requested delta. Both sections are unprotected and may be omitted by the deterministic context budget; active human guidance itself remains protected.

**The Repository map is unprotected and Builder-only.** Every role starts with fresh context, so the Builder rediscovers the target repository's layout on every execution before it can act. The map states that layout once: the tracked directories from `git ls-files`, how many files each holds and their most common extensions, rendered densely as `path count kinds` because the prompt is re-read on every turn of an agentic run. It carries no file contents, is bounded to 40 directories and 25 root files, and declares when it truncated. The Builder's contract says plainly that it is a starting point and never a substitute for reading the files it is about to change.

It is given to the Builder alone on purpose. The Tester and the Reviewer run the same issue without it, so the `activity` histogram on `execution.finished` compares a role that has the map against roles that do not, on the same work, without a feature flag or a code revert.

**Tester execution evidence is protected for the Delivery Reviewer.** It is projected to the Tester's outcome, `coverage` and `tests` before assembly: its `summary`, `findings`, `decisions` and `dependencies` never reach the Reviewer, which must reach an independent verdict from the code and the executed evidence. The projection also keeps the section small, so protecting it does not realistically exhaust the budget. Leaving it unprotected made the Reviewer's contract unsatisfiable: that contract requires returning `decision` or `changes` when Tester evidence is missing, so an omitted section produced a rejection whose stated reason was not the real one.

### 6.4 Budget

The configuration has one `contextBudgetBytes` default plus optional overrides keyed by exact role and by `provider/model`. Provider/model overrides take precedence, then role overrides, then the default. `auto` uses the role override or global default because the selected model may not be known before invocation. The design does not expose `fast`, `balanced` or `strong` as context-budget categories.

Sections are **protected** (contracts, approved SPEC and criteria, active decisions and instructions, the active request and its parent chain, and open findings required by the role) or **optional** (previous-attempt report, diff stat and historical evidence tables). Optional sections are clipped in a fixed documented order until the total fits. If protected sections alone exceed the budget, the stage fails with class `invalid-context` (§7.5) and no provider is invoked. The factory does not estimate tokens: `executions.input_tokens` is the measurement, while `prompt.json` records prompt bytes and the rule that selected the budget.

### 6.5 Diff delivery

Before Reviewer starts, the orchestrator writes the full diff to `<worktree>/.factory-context/reviewer/diff.patch` and includes `git diff --stat` plus that relative path in the prompt. Because the file is inside the worktree, Claude and Codex do not need access to an external factory-data path. Tester receives the changed-file manifest and stat and inspects the worktree independently.

Mechanism, verified against `src/worktrees.ts`:

- **Exclusion.** The factory cannot edit the target repository's `.gitignore`. `worktrees.check` detects untracked files with `git ls-files --others --exclude-standard` and `commit` uses `git add --all`; both honour `$GIT_COMMON_DIR/info/exclude`, which linked worktrees share. `Workspaces.ensure` appends `.factory-context/` to `<repoDir>/.git/info/exclude` once, idempotently. This also affects the operator's own checkout of the same clone; that is harmless and documented in `INSTALL.md`.
- **Ownership and collision guard.** At creation the factory writes `.factory-context/OWNER` containing the execution id. Before every Reviewer attempt it rejects tracked paths, symlinks and any directory without a valid factory OWNER marker. A pre-existing directory may be removed and recreated only when it is untracked, no path component is a symlink and its OWNER marker identifies a prior factory execution for the same work item. Anything else fails as `invalid-context`; repository-owned content is never deleted, hidden or overwritten. The same ownership checks run immediately before cleanup.
- **Range.** `Workspaces.diff` uses `origin/<default>...HEAD`, i.e. committed changes only (the orchestrator commits Builder and Tester output before Review). The inline `--stat` uses the same range so the Reviewer sees one set of numbers.
- **Lifetime.** The directory is created immediately before the Reviewer execution and removed immediately after it finishes, succeeds or fails. Recovery also removes and recreates a verified stale factory-owned directory left by a crash, so no stale diff is visible and a crash cannot permanently block Review.
- **Permissions.** Files are created owner-only as hygiene, not as a boundary: the provider runs as the same user, and Codex runs every role with `--sandbox workspace-write` (`src/adapters/codex.ts:17`). A Reviewer that modifies `.factory-context/` is not detected by `worktrees.check` (the path is excluded); the deletion after the run is what makes that harmless.

### 6.6 Prompt persistence

For every execution the orchestrator writes, before spawning the provider:

- `runs/<id>/prompt.md` — the exact `instructions` string.
- `runs/<id>/prompt.json` — `{ executionId, role, provider, model, specVersion, includedRecordIds, activeRequestId, sectionBytes: {name: bytes}, budgetBytes, budgetSource }`.

`executions` gains `prompt_bytes INTEGER` and `prompt_sha256 TEXT`. Prompt, completion and diff artifacts are written with owner-only permissions, are never served by a public route, and are retained according to §11. The dashboard exposes prompt content only through an explicit reveal action. The dashboard remains restricted to loopback addresses (`FACTORY_DASHBOARD_HOST`, `src/config.ts:19-20`); relaxing that restriction would require authentication first and is outside this document. Configured secrets are redacted and these artifacts are never published to GitHub or Slack.

## 7. Workflow projection

### 7.1 Columns on `work_items`

```ts
type Stage  = "DESIGN" | "BUILD" | "TEST" | "REVIEW" | "DELIVERY";
type Status = "QUEUED" | "RUNNING" | "WAITING" | "FAILED" | "PAUSED" | "CANCELLED" | "COMPLETED";
interface Projection { stage: Stage; status: Status; attempt: number; revision: number;
                       presentationRevision: number; publishedPresentationRevision?: number;
                       activeRunId?: string; activeRequestId?: string; activeFailureId?: string; }
```

- Open request records are authoritative. `activeRequestId` is their denormalized projection: the transition function derives it as the deepest open request in the parent chain and never accepts a caller-provided value. `factory doctor` reports stored drift. `WAITING` requires that active request to have `owner: human`; an Architect-owned active request is `QUEUED` or `RUNNING` and produces no human CTA.
- `activeFailureId` points to the one unresolved failure that explains `FAILED`. Failure creation, projection update and transition event are transactional. Retry resolves that failure and clears the pointer. No “latest row” inference is allowed.
- `revision` increments for a workflow transition. `presentationRevision` increments whenever the GitHub status projection changes, including a workflow transition, new evidence or an observed ordinary approver comment. `publishedPresentationRevision` records the last successfully published value (§8.1).
- `NEW` and `DONE` do not exist. Ingestion starts at `DESIGN/QUEUED`; merge is `DELIVERY/COMPLETED`; PR closed without merge is `DELIVERY/WAITING` with an open `merge` request flagged `prClosed`.
- `resumeStatus` is derived transactionally from the request chain: `WAITING` when the active request is human-owned, otherwise `QUEUED`. Retry, individual resume and batch resume preserve the stage and use `resumeStatus`; `attempt` increments only when the result is `QUEUED`. A paused human gate therefore returns to the same CTA without starting an agent. `resume`, `waiting`, `consultation`, `pendingStage`, `retryGuidance`, `feedback`, `reports`, `cycles`, `lastFailure` are removed from `Context`.
- `correction_cycles INTEGER` counts only accepted `changes` outcomes. For a configured maximum `N`, the `changes` outcome increments the counter first; when the new value is `N`, the factory opens `correction-limit` instead of scheduling another automatic correction. Decisions do not consume the counter. `/factory answer` resets it, as today.

### 7.2 Transition table (complete)

| From | Trigger | To | Records | Human-visible |
| --- | --- | --- | --- | --- |
| — | assigned to the Factory account with this installation as the sole instance label | DESIGN/QUEUED | none | Started status |
| any/QUEUED | scheduler selects item; adapter exists; no confirmed maintenance blocks it | same stage/RUNNING | execution row created; `activeRunId` set; revision + 1 | none |
| DESIGN/RUNNING | Architect `questions` (no open tactical request) | DESIGN/WAITING | human-owned request `clarification` opened; prior approval invalid | Questions milestone with `/factory answer` |
| DESIGN/RUNNING | Architect `questions` during open tactical request | DESIGN/WAITING | human-owned child request `clarification` opened with `parent_id` pointing to the Architect-owned tactical request; tactical request stays open but is blocked; approval kept | Questions milestone |
| DESIGN/RUNNING | Architect `spec`, complexity/risk high, profile ≠ strong | DESIGN/QUEUED | draft stored on execution; next selection forced `strong` | Status comment: architectural review |
| DESIGN/RUNNING | Architect `spec` | DESIGN/WAITING | new `specs` row v+1; `scope: spec` records of v → superseded; human-owned request `spec-approval` opened | SPEC milestone with approve/change CTAs |
| DESIGN/WAITING | `/factory answer` (comment id > request.openedAfterCommentId) | DESIGN/QUEUED | decision `human` created; clarification resolved; correction_cycles = 0 | Answer acknowledged in status |
| DESIGN/WAITING | `/factory approve v<N> [guidance]` | BUILD/QUEUED | request resolved; approval recorded; optional spec instruction | Status update |
| DESIGN/RUNNING | Architect `resolved` for open tactical request | allowed return stage/QUEUED | tactical decisions created (with `supersedes`); request resolved; `decision-required` findings resolved | Decision milestone |
| BUILD/RUNNING | `pass` | TEST/QUEUED | commit; Builder findings `defer` → accepted-defer | Status update |
| TEST/RUNNING | `pass` | REVIEW/QUEUED | commit; open Builder `auto-fix` → resolved | Status update |
| REVIEW or DELIVERY/QUEUED | synchronized HEAD differs from the last Tester pass | TEST/QUEUED | invalidate stale verification before running another agent or publishing | Status update |
| any active status | Factory account unassigned | same stage/PAUSED | execution interrupted; partial work committed and pushed | Status update |
| any active status | instance label moved elsewhere | same stage/PAUSED | execution interrupted; partial work committed and pushed | Status update |
| any active status | local and another instance label both present | same stage/PAUSED | execution interrupted with `claim-conflict`; partial work committed and pushed | Status update |
| PAUSED after unassigned, moved or claim conflict | assigned with the sole local instance label | same stage/QUEUED or WAITING | attempt +1 only when queued | Status update |
| no local item; another instance published a stable state | sole local instance label | published stage/status under the same workflow id | published specifications, active/open records and active failure adopted; local execution references omitted | Status identifies source instance and revision |
| no local item; another instance published RUNNING or QUEUED | sole local instance label | no local transition | wait for explicit **Continue anyway**; forced continuation begins PAUSED | Dashboard warning |
| continued local PAUSED item | next assignment poll | same stage/QUEUED or WAITING | attempt +1 only when queued | Status update |
| TEST/RUNNING | `changes` | BUILD/QUEUED | findings `auto-fix` opened; correction_cycles + 1 | Status update with findings |
| REVIEW/RUNNING | `changes` | BUILD/QUEUED | findings opened; correction_cycles + 1 | Status update |
| REVIEW/RUNNING | `pass` | DELIVERY/QUEUED | Reviewer result and evidence stored; no provider work remains | Status shows deterministic Delivery next |
| DELIVERY/QUEUED | orchestrator publishes successfully | DELIVERY/WAITING | branch pushed, PR ensured; human-owned request `merge` opened | Ready-to-merge milestone |
| DELIVERY/QUEUED | publication or PR integration error | DELIVERY/FAILED | integration failure opened; successful Reviewer result preserved | Failure milestone explains the repository/PR cause |
| DELIVERY/FAILED | `/factory retry [guidance]` | DELIVERY/QUEUED | integration failure resolved; no Reviewer execution created | Retry repeats only deterministic publication |
| DELIVERY/WAITING | `/factory answer <feedback>` | BUILD/QUEUED | merge request resolved; human `auto-fix` finding opened; correction_cycles unchanged | Status shows Builder next |
| BUILD/TEST/REVIEW RUNNING | `decision` | DESIGN/QUEUED | findings `decision-required` opened; Architect-owned request `tactical-decision` opened with `originatingStage` | Decision-request milestone; no human CTA unless Architect asks a question |
| BUILD/TEST/REVIEW RUNNING | `changes` and `correction_cycles + 1 >= max` | same stage/WAITING | findings from the result persisted; human-owned request `correction-limit` opened with their ids and originatingStage after storing the incremented counter | Correction-limit milestone |
| any/WAITING (`correction-limit`) | `/factory answer` | DESIGN/QUEUED | human decision created; `correction-limit` → resolved; Architect-owned child `tactical-decision` opened with the same originatingStage and parent history; cycles = 0 | Status shows Architect as next actor |
| any active/RUNNING | execution error, timeout, invalid result, invalid context | same stage/FAILED | unresolved `failures` row created and selected as `activeFailureId` | Failure milestone with retry CTA |
| any/FAILED (`invalid-result`) | `/factory answer <revision>` | DESIGN/QUEUED | failure resolved; human decision recorded for Architect; attempt + 1 | Architect proposes a new SPEC; prior criteria remain effective until approval |
| any active/RUNNING | daemon dies without its stop handler (for example SIGKILL) | same stage/FAILED | failure `recovery`; execution `interrupted/unexpected-shutdown` | Failure milestone |
| any active/QUEUED or RUNNING | SIGTERM/SIGINT without confirmed maintenance | same stage/PAUSED | implicit `signal` maintenance operation; running execution `interrupted/signal` | Paused by operator signal |
| any active/RUNNING | state changed by control during run | unchanged | event `execution.discarded` | none |
| any active/RUNNING | dashboard **Interrupt and retry with this** | same stage/QUEUED | execution interrupted with `interrupted-for-guidance`; partial work committed and pushed; guidance instruction created; attempt + 1 | GitHub comment and dashboard thread show the human guidance |
| any/QUEUED or RUNNING | confirmed disruptive maintenance | same stage/PAUSED | maintenance item linked; running execution becomes `interrupted/planned-maintenance` | Maintenance pause with Resume CTA |
| any/PAUSED by maintenance | individual or batch Resume | same stage/`resumeStatus`; attempt + 1 only if QUEUED | maintenance item marked resumed | Resume acknowledged or original human CTA restored |
| FAILED/PAUSED/CANCELLED | `/factory retry [--issue] [--for <roles>] [guidance]` | same stage/`resumeStatus`; attempt + 1 only if QUEUED | active failure resolved if present; scoped instruction created if text | Retry accepted or original human CTA restored |
| QUEUED, RUNNING or WAITING | `/factory pause [reason]` | same stage/PAUSED | open requests preserved; running execution becomes `interrupted/user-pause`; reason is transition evidence only | Paused milestone |
| any | `/factory cancel [reason]` | same stage/CANCELLED | open requests → cancelled; reason is transition evidence only | Cancelled milestone |
| DELIVERY/WAITING | PR merged | DELIVERY/COMPLETED | merge request resolved | Merged milestone |
| DELIVERY/WAITING | PR closed | DELIVERY/WAITING | merge request flagged `prClosed` | PR-closed milestone |
| DELIVERY/WAITING (prClosed) | PR reopened | DELIVERY/WAITING | flag cleared | Status |
| any nonterminal | GitHub issue manually closed | same stage/PAUSED and hidden from operational views | open requests and worktree preserved; close cursor recorded | none; no further comments, labels or agents |
| hidden issue | GitHub issue reopened | same stage/PAUSED | comment cursor advances past comments made while closed | Visible again with explicit Retry CTA |
| tracked issue | remote GitHub issue id changes for the same number | same stage/PAUSED, archived | pending notifications suppressed; old records and worktree preserved | none on the replacement issue; it must be started explicitly |
| tracked open issue | title/body/URL changes | same state | context refreshed; title change increments presentation revision | status title refresh only when title changed |
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
  activeFailureId?: string;
  specVersion: number;
}
```

Projection update, records, transition event, notification row and outbox row are written in one SQLite transaction. External delivery stays asynchronous and idempotent. Low-level telemetry events (`execution.*`, `github.*`) remain as they are.

### 7.4 Repair, not replay

The two existing repair heuristics (cursor high-water, approval/consultation recovery in `retry.ts`) are removed from runtime. `factory doctor --repair` reads `events` and `records` to diagnose and, on explicit confirmation, rebuild a projection. Runtime never infers.

### 7.5 Failure classes

Table `failures(id, work_item_id, execution_id, class, message, stage, attempt, created_at, resolved_at, resolved_by)`. A partial unique index permits at most one row with `resolved_at IS NULL` per work item. The projection's `activeFailureId` must name that row or be null when none exists.

| Class | Example | Owner | Default action |
| --- | --- | --- | --- |
| `execution` | CLI exit, timeout | operator | retry same stage |
| `invalid-result` | schema or routing contradiction | agent/prompt | retry same stage |
| `invalid-context` | protected sections exceed budget | operator/config | fix budget or SPEC size, retry |
| `environment` | required browser, runtime, permission or network capability unavailable | operator/environment | restore the capability or name an acceptable equivalent, retry same stage |
| `recovery` | daemon restart | operator | retry same stage; worktree preserved |
| `integration` | GitHub/Slack unavailable | orchestrator | no workflow change; outbox retries |
| `configuration` | missing credential/repository | operator | daemon readiness blocked (`doctor`), no per-issue failure |

Acceptance failures (a criterion proven failed) and human decisions are **not** failures: they are findings and requests.

`environment-blocked` is reserved for a capability required to complete the current stage. An optional research or validation limitation stays in the result summary and does not stop the workflow. During initial Design, Architect may return clarification questions together with `environment-blocked`; the result and questions are preserved, the item becomes `DESIGN/FAILED`, and retry guidance can both resolve the capability and answer the questions.

### 7.6 Planned maintenance

Any operation that can stop the daemon performs a coordinated maintenance handshake before changing services: global update, daemon stop or restart, uninstall, and configuration apply when at least one changed field requires a daemon restart. Starting a service, checking for updates, restarting only the dashboard and dashboard-only configuration changes do not use this handshake.

1. **Validation and preflight.** Inputs are validated before work is paused; an invalid configuration or unavailable update changes nothing. For configuration apply, `.env` validation completes first, then affected-work revalidation occurs immediately before service stop; the existing `.env` rollback remains in force if restart fails. The control plane lists every work item in `QUEUED` or `RUNNING`, including issue, title, stage, current role, elapsed execution time and whether an execution process is active. If the set is empty, the operation proceeds without confirmation.
2. **Confirmation.** The dashboard displays that list and offers **Cancel** or **Pause tasks and continue**. The CLI asks the equivalent question when interactive; non-interactive commands refuse and name the explicit `--pause-active` flag. Confirmation is bound to an expiring maintenance id and the exact affected-item revision set.
3. **Revalidation.** The daemon recomputes the set before mutating anything. If an item or revision changed, confirmation expires and the caller must show the new set. This closes the race between preflight and acceptance.
4. **Barrier and interruption primitive.** The barrier is the transactional `QUEUED → RUNNING` transition itself: it re-reads the projection and maintenance tables and refuses to create an execution while confirmed maintenance is active. The provider is spawned only after that transaction commits. After acceptance, one transaction per affected work item records the maintenance id and moves `QUEUED|RUNNING → PAUSED`, preserving stage, SPEC, request chain, instructions, branch and worktree. A running execution is stopped through a new `ExecutionManager.interrupt(id, reason)`, which sends supervisor IPC `{type:"interrupt", reason}`. The supervisor forwards SIGTERM to the process group and records `{status:"interrupted", reason}` in `completion.json` only after the group exits; it does not arm the cancellation SIGKILL timer. `cancel()` keeps its forced escalation and is reserved for explicit cancellation.
5. **Ready.** Maintenance is `ready` only when every affected item is `PAUSED`, no execution row is `running` and no affected process group remains alive. The external service operation starts only after this acknowledgement. A timeout aborts the operation, leaves services available and items paused, and reports the blocking issue; a late result is discarded. Forced termination requires a separate explicit cancellation and is outside the normal update path.
6. **Resume.** Tasks remain paused after services return. The dashboard offers **Resume paused tasks** for that maintenance id plus individual Retry actions. Resume uses `resumeStatus` at the stored stage, increments `attempt` only when the result is `QUEUED`, and does not increment `correction_cycles`.

The confirmation copy states the consequence without calling the work cancelled:

> **3 tasks are currently being processed**
>
> This operation will interrupt their agent executions. Stage, context and worktrees will be preserved. The tasks will remain paused until you resume them.
>
> **Cancel** · **Pause tasks and continue**

Execution outcome and workflow status deliberately describe different objects, but their language must agree:

| Cause | Execution status | Workflow status | Dashboard wording |
| --- | --- | --- | --- |
| Explicit `/factory cancel` or issue Cancel action | `cancelled` | `CANCELLED` | Cancelled by user |
| Confirmed update/restart/stop/configuration maintenance | `interrupted`, reason `planned-maintenance` | `PAUSED` | Interrupted for maintenance |
| SIGTERM/SIGINT with no confirmed maintenance | `interrupted`, reason `signal` | `PAUSED` under an implicit `signal` maintenance operation | Stopped by operator signal |
| Unexpected daemon death found during recovery | `interrupted`, reason `unexpected-shutdown` | `FAILED` with recovery failure | Interrupted unexpectedly |
| Provider timeout | `timed_out` | `FAILED` | Timed out |

The current implementation explains the observed mismatch: `ExecutionManager.cancelAll()` records the process as `cancelled`, while the daemon stop handler transitions its work item to `PAUSED`. V3.3 adds the separate interrupt path and durable implicit operations for direct signals; `cancelled` is reserved for an explicit user decision to cancel the work.

Maintenance emits `maintenance.requested`, `maintenance.confirmed`, `maintenance.task_paused`, `maintenance.ready`, `maintenance.started`, `maintenance.completed`, `maintenance.failed` and `maintenance.tasks_resumed`. Each event contains the maintenance id, actor, operation and affected work-item ids. A planned interruption is never recorded as a workflow failure.

Maintenance intent survives a dashboard or service restart in two durable tables:

```sql
CREATE TABLE maintenance_operations(
  id            TEXT PRIMARY KEY,
  operation     TEXT NOT NULL, -- update | daemon-stop | daemon-restart | uninstall | configuration-apply | signal | user-pause
  actor         TEXT NOT NULL,
  status        TEXT NOT NULL, -- requested | confirmed | pausing | ready | running | completed | failed | cancelled
  requested_at  TEXT NOT NULL,
  confirmed_at  TEXT,
  finished_at   TEXT,
  error         TEXT
);

CREATE TABLE maintenance_items(
  maintenance_id   TEXT NOT NULL REFERENCES maintenance_operations(id),
  work_item_id     TEXT NOT NULL REFERENCES work_items(id),
  confirmed_revision INTEGER NOT NULL,
  paused_at        TEXT,
  resumed_at       TEXT,
  PRIMARY KEY(maintenance_id, work_item_id)
);
```

`executions` adds nullable `interruption_reason` and `maintenance_id`. A SIGTERM/SIGINT handler with no confirmed operation creates an implicit `signal` operation with actor `os` before pausing work, so batch resume remains available after a direct service stop. `/factory pause` is an issue-local transition and records `user-pause` directly as the live execution's interruption reason. Batch resume selects only unresolved `maintenance_items` whose work item is still `PAUSED`; it never captures an item that was already paused before confirmation. The dashboard can therefore recover the “Resume paused tasks” action after updating itself.

### 7.7 Repository maintenance and extreme recovery

The dashboard and CLI expose five simple actions for the configured target repository. Factory source updates remain under the global Update action.

Daemon startup and Doctor also verify that the configured base matches GitHub's default branch and that `refs/heads/<base>` exists on the remote. A missing or mismatched base blocks work before an agent runs; Check reports the same inconsistency and tells the operator to create/push the base or correct the configuration.

| Action | Behavior | Safety boundary |
| --- | --- | --- |
| **Check** | Validate the configured path and Git repository; show origin match, current/default/upstream branches, local HEAD, dirty and untracked files, unpushed commits, factory worktrees and inconsistencies. Query the live remote branch hash with `git ls-remote`; compare ahead/behind against the last locally fetched tracking ref and clearly say when a full comparison requires Sync. End with one recommended next action. | Strictly read-only: no fetch, checkout, ref/object update, commit or worktree mutation. |
| **Sync from remote** | Fetch with prune, then fast-forward the clean local default branch to `origin/<default>`. | Refuses dirty state, divergence and non-fast-forward updates. Never merges, rebases or stashes. |
| **Publish branch** | For one selected work item, preview its diff, create a factory-authored commit when needed, and push that exact factory branch. | Refuses default/protected/unrelated branches, detached HEAD, invalid worktree context and every force update. Does not create or merge a PR. |
| **Clear local copy** | Remove every entry inside the configured target-repository directory, including `.git`, and remove only factory-owned worktree directories registered to that clone under the configured factory data directory; keep the configured repository root itself. | Irreversible. Requires no active process, the §7.6 pause barrier, a preview of dirty files and unpushed commits, and a second confirmation that repeats the absolute configured path. It refuses `/`, the user's home, the factory install/data directories, a symlinked root, an empty/unresolved path or any path other than the exact configured repository root. All nonterminal items remain `PAUSED` with `recovery` evidence and no worktree path. |
| **Restore from remote** | Clone the configured origin into the empty target directory, verify origin and default branch, then leave affected work items paused for explicit retry and worktree recreation. | Available only when the target directory is empty. It never clears a non-empty directory implicitly. |

Before any mutation, the backend constructs a plan from validated repository and work-item ids; browser text is never executed as a shell command. It lists affected paths, refs, commits and work items. `QUEUED` or `RUNNING` work uses the maintenance confirmation and barrier in §7.6. Clear also pauses `WAITING` and stopped nonterminal items because their worktrees become invalid. Every action rechecks origin, HEAD, status and worktrees where applicable and writes `repository.operation.*` events with actor, before/after state and result. Secrets and credential-bearing URLs are redacted.

CLI equivalents are `factory repo check`, `factory repo sync`, `factory repo publish <work-item-id>`, `factory repo clear` and `factory repo restore`. The dashboard places them under **Project → Repository maintenance** and shows **Restore from remote** as the primary action whenever the configured directory is empty.

Explicitly unsupported: arbitrary Git commands, credential editing, interactive merge/rebase, conflict resolution, force push, branch deletion, PR creation/edit/merge, issue administration and remote repository settings. The factory links to the terminal or provider UI when one of those operations is required.

## 8. GitHub projection

### 8.1 Publish only on change

`work_items.publishedPresentationRevision` records the last status presentation successfully published. `flush()` writes labels and the status comment only when `presentationRevision > publishedPresentationRevision`, then advances the published value after success. Workflow transitions increment both `revision` and `presentationRevision`; presentation-only changes increment only the latter. When `observeComments` notices an ordinary approver comment that changes the displayed unprocessed-comment count, advancing its cursor and incrementing `presentationRevision` occur in one small transaction.

This eliminates unchanged per-item writes and full synchronization. It does **not** eliminate inbound GitHub polling: assigned-issue discovery, tracked issue comments and PR reconciliation still perform the minimum reads required to observe external actions. “No change” means zero GitHub writes and zero per-item `syncState` calls, not zero GitHub API reads for the whole daemon.

### 8.2 Status comment (mutable, one per issue)

The status table includes the active Factory instance name. Its footer includes `<sub>instance:<name></sub>` beside the workflow attribution, so ownership remains visible when several installations share the repository. Continued work also shows the source instance and source revision.

Before the visible status and its marker, the comment carries one hidden `ai-factory:payload:v1` state index. The index contains repository and issue identity, workflow id, instance, publication time, deterministic branch, projection, the safe context subset, one persisted `specMarkers` pointer per specification version, the latest result subset for each role, active/open records and the active failure. Each latest-result entry is limited to role, execution id, outcome, summary, coverage, tests, changed files, findings and decisions. It excludes working directories, prompts, logs, notifications and credentials. Unknown keys and invalid identities are refused. A continued installation preserves the original specification markers, republishes them unchanged and uses local result events in preference to adopted latest-result evidence. If a specification marker is unknown, the visible status is published without an index and `github.state_incomplete` is recorded once. If the encoded status would exceed 60,000 characters, the visible status is still published without the index and `github.state_too_large` is recorded once for that presentation revision; facts are never split across chunk comments.

Stage and status, current actor (agent or human), SPEC version, attempt, open request, latest command outcome, latest evidence summary, **exactly one** "Next action" block, PR and dashboard links, and a collapsed `<details>` with the last 10 meaningful transitions. The history excludes transitions into `RUNNING`, uses public short role names and formats times as `YYYY-MM-DD HH:MM UTC`; storage ids and enum values are not rendered. Open requests use human phrases such as “Waiting for your answer”, “Waiting for approval of SPEC vN”, “Architect is deciding” and “Waiting for merge”. Failed, paused and cancelled states identify Human as the current actor when their CTA requires a command. Applied, rejected, stale, deferred and expired newly observed commands are stored in `work_items.context.lastCommand`; parse rejections retain the parser's specific reason and tell the author that a new comment is required because edits are frozen. Non-applied outcomes advance the presentation revision so rejection reasons are visible without creating another comment. The latest delivery summary is clipped to approximately 1,500 characters; a clipped summary identifies the execution to open in the dashboard for the complete result. The status also shows the number of ordinary approver comments observed since the last applied human command and directs the author to `/factory note` when that prose should become agent guidance. Factory-authored comments carrying an `<!-- ai-factory:... -->` marker only advance the comment cursor; they never increment this counter or cause another presentation write. Old immutable comments keep their historical CTA text but the editable status comment is authoritative; every milestone comment links back to it and states that it contains the current action.

The Next action block prints the exact valid syntax for the current state and explains what optional text becomes. Approval guidance is an instruction, answers are human decisions except merge feedback (a Builder auto-fix finding), and retry guidance is an instruction. Queued and running states require no action but expose pause/cancel syntax. Paused and cancelled states name the last transition actor and reason before showing scoped retry syntax; a paused human request remains visible as the preserved action after resume. Failed states expose scoped retry syntax and the sanitized validation message that stopped the stage. Failure diagnosis starts from the stored failure class and, for execution failures, the supervisor's final process status; message-pattern diagnosis is only a refinement for a process recorded as failed. Environment failures show the unavailable capability, the last agent report and a retry action both in the issue status and in the dashboard's expandable **Why this failed** section. Historical invalid-result failures caused by the former Architect blocker contradiction receive a specific diagnosis instead of the generic schema-error explanation.

The issue remains assigned to the authenticated Factory account while work is active, including human-owned waiting states. Human attention is signalled by `factory:waiting` and the status comment; approvers are never assigned temporarily. Completion and cancellation remove the Factory assignment and the local instance label.

The dashboard issue detail presents one ordered conversation derived from existing execution and workflow events. Prompt turns expose role, provider, model and the bounded manifest; exact prompt text remains local and requires explicit acknowledgement. Result turns reuse the GitHub result renderer, event turns show transitions and failure evidence, and human turns identify whether they came from an issue comment or the dashboard. Turns carry explicit Agent input, Agent output, Workflow and Human guidance labels. Live refresh does not replace an unchanged issue list or unchanged conversation; when data changes it preserves open issue panels, open prompt summaries, the conversation scroll position and unsent guidance. Every command successfully applied by the GitHub inbox emits `command.applied` with its comment id, login, command label, carried text and `source: "comment"`, so approvals, answers and notes appear in that conversation just like dashboard messages. The composer derives its buttons only from the current projection and active request. The authenticated `gh` login must be an approver. For every dashboard message the daemon publishes an idempotent command-form comment first, including the login and instance, then applies the same `WorkflowCommands` path with the real GitHub comment id. Factory markers prevent the inbox from applying that comment twice. A rejected command is appended to that published comment and recorded as a failed control.

### 8.3 Milestone comments (immutable)

Each milestone comment ends with `<sub>instance:<name></sub>` so its origin remains visible after ownership moves. Before the visible content and marker it may carry one hidden `ai-factory:payload:v1` fact. An Architect specification stores `{kind:"spec", version, body, criteria, assessment}`. Other published milestones store their role, execution id, outcome, findings, decisions, coverage, tests, changed files and summary. Tester and Reviewer pass results remain out of immutable comments; their verified heads are part of the state index.

Only when a human acted or must act, or the contract changed: started, questions, SPEC proposed, SPEC approved, decision request opened, decision resolved, correction limit, failure needing retry, paused, cancelled, ready to merge, PR closed, recovered, merged. A failure comment is published once per unresolved failure and names the saved stage, the diagnosis, the sanitized exact validation message and the retry command. Architect question comments are titled as questions, number each question and include a ready-to-copy `/factory answer` template; they never describe nonexistent content as a specification. A proposed SPEC comment identifies that approval is pending, demotes its internal headings below the comment title, renders the structured acceptance criteria, and includes concrete approve and feedback commands with their semantics. Tactical-resolution comments are titled as Architect decisions, name the role that continues and require no human action; while that result is current, its summary replaces the earlier delivery-role question in the mutable status. A delivery-role decision says Architect continues without human action, and the ready-to-merge Reviewer milestone includes the pull-request URL. Role `pass` reports and intermediate `changes` reports go to the status comment (and the PR body for the final ones), not to immutable comments.

### 8.4 Labels

Ownership adds exactly one `factory-instance:<name>` label for the selected installation. If concurrent claims temporarily create more than one instance label, no installation works the issue until a single label remains. Workflow state has two dimensions: exactly one stage label (`factory:design|build|test|review|delivery`) while tracked, plus zero or one condition label (`factory:waiting|failed|paused|cancelled`). `factory:done` replaces the stage label on `COMPLETED`. The filtering case ("what waits on me") justifies the second label; 8.1 keeps its cost proportional to transitions.

### 8.5 Comment markers

Visible markers use `Work item: <id>` and add `workflow-rev:<revision>`, `presentation-rev:<presentationRevision>` and `event:<eventId>`. A hidden payload is serialized with `JSON.stringify`, validates against schema version 1 and escapes every `--` so it cannot close its HTML comment. To continue work, the reader validates the status index, resolves every referenced specification marker and refuses the whole read if any referenced fact is missing. Stable states are adopted transactionally under the same workflow id, including when a reinstalled Factory has the same instance name but no local item; remotely `RUNNING` or `QUEUED` states require explicit **Continue anyway** and start locally as `PAUSED`.

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
12. Exactly one "Next action" block is current. A human CTA exists only when the active request is human-owned; an Architect-owned request names Architect as the next actor without asking the human to respond.
13. No projection change without a `workflow.transition` in the same transaction.
14. A comment resolves only a request opened before it.
15. Cutover never replays completed work and never duplicates a GitHub comment.
16. `activeRequestId` equals the deepest open request; `activeFailureId` equals the only unresolved failure. The records and failure rows are authoritative.
17. No confirmed maintenance operation starts while an affected execution is running or before every affected runnable item is paused.
18. Planned maintenance never produces execution status `cancelled` or workflow status `FAILED`.
19. A maintenance timeout aborts the service operation instead of silently escalating to forced termination.
20. Only open GitHub issues are operational: a manually closed issue is hidden, receives no agent execution, comment, label or notification, and reopening leaves it paused until an explicit retry.
21. Repository recovery never force-pushes or runs browser-supplied shell text. Clearing local content is the only destructive path: it shows dirty files and unique commits, requires path-bound double confirmation, pauses every affected item and never runs as an implicit part of Restore.

## 10. Cutover

No dual-write, importer or compatibility reader is implemented.

The installed filesystem uses one home (`$HOME/ai-factory` by default, or `AI_FACTORY_HOME`): `engine/` contains this repository, `repos/` contains factory-managed application clones, `data/` contains runtime state, and `.env` contains configuration. A checkout not named `engine` is treated as a self-contained developer home. Existing layouts are not migrated; the supported cutover is uninstall and reinstall with configuration restored by hand.

1. A newly created database is initialized atomically with `metadata.schema_version = 7` only after the complete schema exists. Work items persist GitHub issue id, node id and creation time; the active `(repo, issue_number)` uniqueness constraint is partial so an archived item can coexist with a recreated issue.
2. The daemon and mutating CLI commands refuse a database without schema version 5. The error tells the operator to stop services and either run the supported uninstaller or select an empty `FACTORY_DATA_DIR`.
3. Installation into an empty data directory starts with no work items, records, requests, failures, executions or retained worktrees. On first doctor or daemon startup, the directory is bound to the target repository's stable GitHub id. Reusing it with a deleted/recreated or different repository is refused even when the `owner/name` string is unchanged. The operator assigns desired open issues to the Factory account and selects the installation with its instance label, or uses the dashboard/CLI to do both.
   Assignment intake snapshots the issue's newest existing comment as its initial cursor, so commands from discarded runtime history are never replayed.
4. An existing target application checkout may be reused; factory runtime state may not. Uninstall continues to preserve provider credentials and the target application repository.
5. There is no rollback or reverse conversion. The previous data directory may be copied aside for manual audit, but V3 never reads it.
6. Deleting and recreating an issue with the same number does not reuse its work item. Reconciliation archives the stale item without publishing stale labels or comments; the replacement stays untracked until explicitly started and receives a new work item and branch.

This clean cutover is an explicit product decision: the operator can uninstall and start again, so compatibility machinery would add implementation and operational risk without preserving required behavior.

## 11. Resolved decisions

| # | Decision |
| --- | --- |
| 1 | Retry guidance and notes default to `scope: spec`. Instructions accumulate; replacement and revocation are explicit and address stable record ids; conflicts resolve to the most recent instruction (§5.6). |
| 2 | Ordinary comments never enter agent context. `/factory note` is the explicit path; the status comment counts unprocessed approver comments and explains the command. |
| 3 | Tester receives manifest plus `diff --stat`. Reviewer receives the full diff from the protected in-worktree context directory plus the stat inline. |
| 4 | GitHub uses one stage label plus an optional condition label, and publishes only on presentation revision changes. Inbound polling remains independent. |
| 5 | Immutable milestones are limited to human action, contract changes and terminal delivery events. Intermediate reports live in the authoritative status comment and final PR body. |
| 6 | Runtime does not replay events. Projection, records, transition event, notification and outbox write occur in one transaction; `doctor --repair` is explicit diagnosis and repair. |
| 7 | AI summaries are not built. Active structured records are the memory model. |
| 8 | Context uses a global byte budget with exact role and provider/model overrides. Protected context never truncates. |
| 9 | Decisions are superseded through explicit ids. Agent-originated decisions can never supersede a human decision. |
| 10 | Multiple requests may remain open through one non-branching parent chain. The deepest open request is causally active; only a human-owned active request creates a human CTA. |
| 11 | V3 uses a fresh database only. There is no importer, compatibility reader or rollback path; uninstall preserves the target repository and provider credentials. |
| 12 | Records, events, failures and specs are retained. By default, 30 days after `COMPLETED` or `CANCELLED`, exact prompt/completion content, diffs, stdout, stderr and `completion.json` are deleted; `prompt.json`, prompt byte count, SHA-256, inclusion ids and execution metadata remain. Operators may increase or disable this retention period. |
| 13 | Disruptive maintenance requires affected-work preflight and explicit confirmation, pauses runnable work behind a daemon-side barrier, and leaves it paused for manual individual or batch resume. |
| 14 | Execution `cancelled` means explicit cancellation. Planned service maintenance records `interrupted/planned-maintenance` and leaves the workflow `PAUSED`. |
| 15 | Retry and resume use `resumeStatus`: a human-owned active request restores `WAITING`; every other resumable item becomes `QUEUED`, and only that path increments `attempt`. |
| 16 | A manually closed GitHub issue is archived from operational views and ignored. Reopening restores it as paused and never replays comments posted while it was closed. |
| 17 | Repository maintenance is intentionally bounded to Check, Sync from remote, Publish branch, Clear local copy and Restore from remote. Clear is explicit and irreversible; Restore requires an empty directory. Merge/rebase, force push, branch deletion, PR/issue administration and remote settings remain external. |
| 18 | Codex runs Architect and Reviewer with a read-only repository sandbox plus their required network policy; Builder and Tester retain workspace write. Provider result files remain orchestrator-owned outside the agent mutation boundary. |
| 19 | Exact prompt content is hidden by default. A local explicit reveal action shows a sensitive-content warning; prompt artifacts are never exposed by a remotely reachable unauthenticated dashboard. |

## 12. Acceptance tests

Style: `node:test` with the existing GitHub, workspace and agent fakes in `test/fixtures.ts`.

1. **Prompt persistence.** Every execution writes `runs/<id>/prompt.md` byte-identical to the `input` field of the JSON envelope sent to the supervisor, and `prompt.json` lists included record ids, active request, section bytes and budget source; `executions.prompt_bytes` and SHA-256 match; files have owner-only permissions. Retention deletes content but preserves the manifest and hash.
2. **Consultation survives questions.** Tester `decision` → tactical request open; Architect `questions` → child clarification request whose `parent_id` references the tactical request, approval intact; `/factory answer` resolves the child and restores the tactical request as active; Architect `resolved` returns to `TEST/QUEUED`.
3. **Restart during Build.** The daemon dies by SIGKILL without running its stop handler during `BUILD/RUNNING` → `BUILD/FAILED` with failure class `recovery`; `/factory retry` → `BUILD/QUEUED`, `attempt + 1`, same worktree path, prompt says it was interrupted unexpectedly.
4. **New SPEC version supersedes.** Records with `scope: spec` of v1 become `superseded` and are absent from the v2 Builder prompt; a `scope: issue` instruction remains.
5. **Protected sections cannot be dropped.** With optional history above the role/model budget, every applicable active instruction remains in the prompt. With protected sections alone above budget, the stage fails with `invalid-context` and no adapter call is made. `auto` uses the role or global budget.
6. **Instruction supersession.** Two unrelated `/factory retry <text>` comments remain active and both appear in the next applicable prompt. `/factory replace <first-id> <text>` activates the replacement and sets the first record's `superseded_by`.
7. **Role filtering.** An instruction with `applies_to: ["developer"]` is absent from the Tester prompt and present in the Builder prompt.
8. **Tester independence.** Tester prompt contains manifest and stat and no Builder summary or finding text; Reviewer prompt contains the stat, the diff file path and Tester evidence under an attribution key.
9. **Finding lifecycle.** Tester `changes` opens `auto-fix` findings; Builder `pass` then Tester `pass` marks them `resolved` with `resolved_by` = Tester's execution id.
10. **Cycle accounting.** With `maxCycles = 2`, Tester `decision` leaves `correction_cycles` unchanged; the first `changes` stores 1 and schedules correction; the second stores 2, opens `correction-limit` and leaves the stage `WAITING`.
11. **Stale command.** An `/factory approve v2` comment with id lower than the `spec-approval` request's `openedAfterCommentId` is ignored and recorded as `command.stale`.
12. **Transactional transition.** Each projection change writes exactly one `workflow.transition` with `from`, `to`, `actor`, `source`, `reason`, `recordIds`; a forced outbox insert failure rolls back projection, records and event.
13. **Publish on change only.** Two consecutive ticks without presentation changes make zero GitHub writes and zero per-item `syncState` calls; inbound polling may still read. One transition produces one label sync and one status-comment update, and `publishedPresentationRevision` equals `presentationRevision` after success. A presentation-only evidence change updates the comment without incrementing workflow `revision`.
14. **Single CTA.** The status comment body contains exactly one "Next action" heading and reflects stage, status, version, attempt and open request. A human-owned request contains a command CTA; an Architect-owned request states that Architect is next and asks no human action.
15. **Delivery failure isolation.** A GitHub outage during `flush` leaves the outbox row unsent and the projection unchanged; the next tick delivers once (delivery key) with no duplicate comment.
16. **Cutover guard.** A V3 daemon refuses a database without schema version 7 and tells the operator to uninstall or select an empty data directory. A fresh database receives the version only after schema creation succeeds. No legacy rows are read or changed.
17. **Discarded result.** A result arriving after `/factory cancel` leaves projection and records untouched and appends `execution.discarded`.
18. **Prefix stability.** For two roles on the same provider, common rules, common result envelope and provider rules form a byte-identical prefix; role-specific schemas remain different.

19. **Nested request selection.** With an Architect-owned tactical request and human-owned child clarification both open, only clarification is `activeRequestId` and status is `WAITING`; resolving it restores the tactical request, status becomes `QUEUED`, and its originating stage survives. A sibling request is rejected transactionally.
20. **Protected artifact placement.** Reviewer diff is inside `.factory-context`, readable by both provider adapters, absent from `git ls-files --others --exclude-standard` and from the commit after `git add --all` because `info/exclude` names it, created owner-only with an OWNER marker, and removed after the Reviewer execution whether it succeeds or fails. A stale, untracked, non-symlink factory directory with a valid marker is safely recreated after a crash; tracked, foreign, missing-marker and symlinked fixtures fail before any deletion. The inline stat and file cover the same commit range.
21. **No accidental supersession.** Instructions with different text or role sets remain active until an explicit replacement, revocation or SPEC-version supersession occurs; the prompt lists them by monotonic sequence with ids; equal timestamps still produce deterministic precedence; with four active instructions the status comment shows the pruning hint.
22. **Clean start.** A fresh database has schema version 7 and no runtime rows. Opening a fixture database without version 7 fails before schema or data changes. Reinstalling preserves the configured target repository and provider credentials but creates no work item until an open issue is explicitly started.
23. **Active request consistency.** After every transition, stored `activeRequestId` equals the deepest open request derived inside the transaction. Callers cannot provide or override it; `doctor` detects manually introduced drift.
24. **Foreign keys enforced.** Inserting a record with an unknown `work_item_id`, `parent_id`, `superseded_by` or `resolved_by` fails at the database.
25. **Active failure consistency.** A second unresolved failure for one item is rejected; `FAILED` always points to it; Retry resolves it and atomically clears `activeFailureId`.
26. **Maintenance confirmation and barrier.** With two runnable items, the first update request returns their exact preflight list and changes nothing. Confirmation with the same revisions pauses both, prevents a queued third execution from starting, waits for active process groups to exit and only then invokes the update command. A changed revision invalidates confirmation. A `QUEUED → RUNNING` transaction that commits after preflight increments revision and invalidates the captured confirmation; after confirmation, that transition refuses to commit.
27. **Maintenance execution semantics.** Confirmed daemon restart during Builder records execution `interrupted` with reason `planned-maintenance`, leaves the issue `BUILD/PAUSED`, preserves its worktree and never renders Cancelled in Recent executions. Explicit issue Cancel records execution and workflow as `cancelled`/`CANCELLED`.
28. **Maintenance timeout.** A TERM-resistant execution handled through `interrupt()` that exceeds the maintenance deadline prevents update/restart/stop from starting, leaves services available and the item paused, and reports the blocking issue; it never silently force-stops the daemon.
29. **Batch resume.** Resume by maintenance id touches only items paused by that maintenance. Each uses `resumeStatus` at its stored stage; waiting, failed and previously paused items are untouched, `attempt` increments only for a QUEUED result, and correction cycles do not change.
30. **Resume-status derivation.** Pause and retry an item with a human-owned spec-approval request: it returns to `WAITING`, preserves the request and CTA, and does not increment `attempt`. Pause and retry an Architect-owned tactical request: it returns to `QUEUED` and increments `attempt` once.
31. **Interrupt versus cancel.** `interrupt(id,"planned-maintenance")` sends supervisor IPC, records `interrupted/planned-maintenance` and has no SIGKILL timer; an explicit `cancel(id)` records `cancelled` and retains TERM-to-KILL escalation. A direct SIGTERM creates an implicit `signal` maintenance operation and supports batch resume.
32. **Closed issue visibility.** Closing an issue manually while queued, waiting or running stops further application of its result, suppresses outbound issue updates and removes it from operational dashboard lists. Comments posted while closed are skipped. Reopening exposes the same item as `PAUSED` with an explicit Retry CTA and does not automatically execute an agent.
33. **Repository maintenance boundaries.** Check preserves all refs and files. Sync refuses dirty, divergent and non-fast-forward bases. Publish accepts only the selected factory branch and rejects default/protected branches and force updates. Clear refuses unsafe or mismatched roots, displays dirty files and unique commits, requires the exact configured path twice, removes hidden and visible contents, and leaves affected items paused without worktree paths. Restore refuses a non-empty directory, clones and verifies origin/default branch, and never auto-resumes work. Every mutation records before/after state and its actor.

## 13. Related documents

- `../ARCHITECTURE.md`, `../SPEC.md`, `MODEL_POLICY.md`, `VALIDATION.md`.
- V1, V2, V3, V3.1 and V3.2 are retained in repository history and external review artifacts.

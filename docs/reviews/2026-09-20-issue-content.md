# Issue content review — 2026-09-20

Baseline: `main` at `282396c` (newer than the requested minimum); 144 tests passed before changes.

## Decisions

- **I1 — agree.** The harness rendered `# Specification v0`, followed by questions and “Review the specification”; no specification existed.
- **I2 — agree.** The tactical resolution rendered `# Specification v1` with “Review the specification”, while the status still showed the preceding Tester summary.
- **I3 — agree.** The SPEC milestone rendered a second top-level heading from the raw SPEC and referred the reader to another comment instead of showing concrete approval and feedback commands.
- **I4 — agree.** The Reviewer milestone omitted the stored pull-request URL, and the Tester decision used the static “next workflow stage” copy.
- **I5 — agree.** Status rows exposed `clarification`, `spec-approval`, `tactical-decision` and `merge`; terminal actionable states could show `Current actor | None`.
- **I6 — agree.** Pausing a merge request kept the merge CTA; cancellation rendered a generic resume CTA without the actor or transition reason.
- **I7 — agree.** The transition history included `RUNNING` bookkeeping, raw ids such as `product-architect` and `qa`, and ISO timestamps.
- **I8 — agree, different fix.** A `timed_out` execution still received the generic “rejected the stage result” diagnosis. The separate claim that its process result renders as `running` no longer applies: current `main` rendered `Process result: timed_out`. The fix classifies from failure class and final execution status while preserving the already-correct status row.
- **I9 — agree.** `/factory answer` without guidance rendered only the generic malformed-command message even though the parser produced a specific reason.
- **I10 — agree.** No assignment operation existed in the publisher or GitHub port, so entering a human-action state only edited the status comment and labels. Assignment is an appropriate idempotent GitHub-native notification; no mention comment was added.

## Changes

Harness and validation record: `809bb0e` (`test/issue-content.test.ts` and this report).

- **I1 — `65cf2b7`.** `src/workflow-github.ts`, `test/issue-content.test.ts`, §8.3. Questions use an Architect title, numbered list and copyable answer template. The harness asserts all three and rejects specification wording.
- **I2 — `a765b9b`.** `src/workflow-github.ts`, `src/workflow-status.ts`, harness, §8.3. Tactical decisions have their own title and continuation CTA; the mutable status selects Architect's resolved summary. The harness asserts both surfaces.
- **I3 — `3cfe753`.** `src/workflow-github.ts`, harness, §8.3. SPEC headings are demoted, structured criteria are tabulated and both concrete commands are local to the milestone. The harness asserts heading hierarchy, criteria, commands and one CTA.
- **I4 — `094c96f`.** `src/workflow-github.ts`, harness, §8.3. Tester decisions route visibly to Architect and Reviewer milestones include the PR URL. The harness asserts both sentences.
- **I5 — `634cbbd`.** `src/workflow-status.ts`, `test/workflow-github.test.ts`, harness, §8.2. Open requests and actionable ownership use human phrases. The harness rejects all four storage request ids and asserts Human on cancelled and failed states.
- **I6 — `43678bc`.** `src/workflow-status.ts`, harness, §8.2. Pause/cancel CTAs use the last transition actor and reason; paused human requests remain visible. The harness asserts the actor, reason, retry command and preserved merge request.
- **I7 — `3f9d6ea`.** `src/workflow-scheduler.ts`, `src/workflow-results.ts`, `src/workflow-status.ts`, harness, §8.2. Public role names replace ids, RUNNING transitions are excluded, stage/status are humanized and timestamps use UTC minutes. The harness rejects ids/RUNNING/ISO output and asserts the replacements.
- **I8 — `5fa276a`.** `src/failure-report.ts`, harness, §8.2. Diagnosis starts from failure class and final process status; inconsistent finished/running rows display as failed. The harness asserts the timeout diagnosis and the persisted `timed_out` result.
- **I9 — `f4900ec`.** `src/workflow-inbox.ts`, `test/workflow-inbox.test.ts`, harness, §8.2. Parse errors retain the parser message and append the immutable-comment instruction. The harness asserts the exact `/factory answer requires guidance` message.
- **I10 — `18cfb5e`.** `src/adapters/github.ts`, `src/workflow-github.ts`, `test/workflow-github.test.ts`, `test/workflow-orchestrator.test.ts`, harness, §8.2. Publisher assignment follows human-attention states, diffs current approvers and preserves unrelated assignees. The harness asserts assignment for Design/Waiting, Delivery/Waiting and Design/Failed, removal on approval and human pause, and the adapter's CLI arguments.

## Rendered samples

The following bodies were printed verbatim by the final harness run. UUIDs and timestamps are evidence from that run.

### DESIGN/WAITING status — SPEC approval

````markdown
# Issue content audit

| Detail | Value |
| --- | --- |
| Stage | Design |
| Status | Waiting for you |
| Current actor | Human |
| SPEC version | v1 |
| Attempt | 0 |
| Open request | Waiting for approval of SPEC v1 |
| Last command | `answer` by @owner — applied |

### Active human guidance

- **#1** · `2fa02b97` — 1. Support fans.
2. Cache for five minutes.

<details><summary>Last 4 workflow transitions</summary>

- 2026-09-20 05:21 UTC — Design/Waiting for you: SPEC v1 proposed
- 2026-09-20 05:21 UTC — Design/Queued: Human guidance recorded
- 2026-09-20 05:21 UTC — Design/Waiting for you: Architect needs human input
- 2026-09-20 05:21 UTC — Design/Queued: Issue accepted into the factory

</details>

## Next action

> Review the proposed specification and post one new comment.
>
> **Approve**
>
> ```text
> /factory approve v1 [guidance]
> ```
> Optional guidance becomes a spec-scoped instruction.
>
> **Request changes**
>
> ```text
> /factory answer <feedback>
> ```
> Feedback becomes a human decision for Architect.

<details><summary>All commands</summary>

- `/factory start [guidance]` — start an open issue; optional guidance is issue-wide. Example: `/factory start Keep the API small`.
- `/factory help` — publish this command reference. Example: `/factory help`.
- `/factory approve vN [guidance]` — approve SPEC vN; optional guidance applies to that SPEC. Example: `/factory approve v2 Preserve the public API`.
- `/factory answer <text>` — answer the active question or request PR changes. Example: `/factory answer Use SQLite`.
- `/factory retry [--issue] [--for <roles>] [guidance]` — resume failed, paused or cancelled work and optionally add guidance. Example: `/factory retry --for tester Do not use Chromium`.
- `/factory note [--issue] [--for <roles>] <text>` — add guidance without changing state. Example: `/factory note --issue Keep dependencies minimal`.
- `/factory replace <#N|id-prefix> [--issue] [--for <roles>] <text>` — replace active guidance. Example: `/factory replace #2 Use WebKit`.
- `/factory revoke <#N|id-prefix>` — revoke active guidance. Example: `/factory revoke #2`.
- `/factory pause [reason]` — pause active work; the reason is audit evidence only. Example: `/factory pause Waiting for product review`.
- `/factory cancel [reason]` — cancel work; the reason is audit evidence only. Example: `/factory cancel Product direction changed`.

</details>

<sub>workflow-rev:5 · presentation-rev:5 · event:578088ab-a153-41fc-827a-0eb8ad3ecaf2</sub>
````

### DESIGN/WAITING milestone — SPEC approval

````markdown
# Specification v1 — awaiting approval

## Summary

A small read-only football dashboard

## Football dashboard

### AC1
Shows current standings.

## Acceptance criteria

| ID | Criterion |
| --- | --- |
| AC1 | Shows current standings |

## Next action

**Approve SPEC v1**

`/factory approve v1 [guidance]`

Optional guidance becomes a SPEC-scoped instruction.

**Request changes**

`/factory answer <feedback>`

Feedback becomes a human decision for Architect.
````

### DESIGN/QUEUED status — tactical resolution

````markdown
# Issue content audit

| Detail | Value |
| --- | --- |
| Stage | Test |
| Status | Queued |
| Current actor | Tester |
| SPEC version | v1 |
| Attempt | 0 |
| Last command | `approve v1` by @owner — applied |

### Active human guidance

- **#1** · `2fa02b97` — 1. Support fans.
2. Cache for five minutes.

### Latest delivery summary

**Architect:** Show postponed matches with a status badge

<details><summary>Last 10 workflow transitions</summary>

- 2026-09-20 05:21 UTC — Test/Queued: Architect resolved the decision; Tester continues
- 2026-09-20 05:21 UTC — Design/Queued: Tester requested an architectural decision
- 2026-09-20 05:21 UTC — Test/Queued: Builder passed
- 2026-09-20 05:21 UTC — Build/Queued: Changes requested from Builder
- 2026-09-20 05:21 UTC — Test/Queued: Builder passed
- 2026-09-20 05:21 UTC — Build/Queued: SPEC v1 approved
- 2026-09-20 05:21 UTC — Design/Waiting for you: SPEC v1 proposed
- 2026-09-20 05:21 UTC — Design/Queued: Human guidance recorded
- 2026-09-20 05:21 UTC — Design/Waiting for you: Architect needs human input
- 2026-09-20 05:21 UTC — Design/Queued: Issue accepted into the factory

</details>

## Next action

> The next agent is queued. No human action is required. You can pause or cancel the workflow.
>
> ```text
> /factory pause [reason]
> ```
>
> ```text
> /factory cancel [reason]
> ```

<details><summary>All commands</summary>

- `/factory start [guidance]` — start an open issue; optional guidance is issue-wide. Example: `/factory start Keep the API small`.
- `/factory help` — publish this command reference. Example: `/factory help`.
- `/factory approve vN [guidance]` — approve SPEC vN; optional guidance applies to that SPEC. Example: `/factory approve v2 Preserve the public API`.
- `/factory answer <text>` — answer the active question or request PR changes. Example: `/factory answer Use SQLite`.
- `/factory retry [--issue] [--for <roles>] [guidance]` — resume failed, paused or cancelled work and optionally add guidance. Example: `/factory retry --for tester Do not use Chromium`.
- `/factory note [--issue] [--for <roles>] <text>` — add guidance without changing state. Example: `/factory note --issue Keep dependencies minimal`.
- `/factory replace <#N|id-prefix> [--issue] [--for <roles>] <text>` — replace active guidance. Example: `/factory replace #2 Use WebKit`.
- `/factory revoke <#N|id-prefix>` — revoke active guidance. Example: `/factory revoke #2`.
- `/factory pause [reason]` — pause active work; the reason is audit evidence only. Example: `/factory pause Waiting for product review`.
- `/factory cancel [reason]` — cancel work; the reason is audit evidence only. Example: `/factory cancel Product direction changed`.

</details>

<sub>workflow-rev:16 · presentation-rev:16 · event:d1f6def7-c7a5-4c79-917f-14922f012f93</sub>
````

### DELIVERY/WAITING status

````markdown
# Issue content audit

| Detail | Value |
| --- | --- |
| Stage | Delivery |
| Status | Waiting for you |
| Current actor | Human |
| SPEC version | v1 |
| Attempt | 0 |
| Open request | Waiting for merge |
| Pull request | https://github.com/owner/demo/pull/7 |
| Last command | `approve v1` by @owner — applied |

### Active human guidance

- **#1** · `2fa02b97` — 1. Support fans.
2. Cache for five minutes.

### Latest delivery summary

**Reviewer:** Delivery is ready for human review

<details><summary>Last 10 workflow transitions</summary>

- 2026-09-20 05:21 UTC — Delivery/Waiting for you: Branch published and pull request ready
- 2026-09-20 05:21 UTC — Delivery/Queued: Reviewer passed
- 2026-09-20 05:21 UTC — Review/Queued: Tester passed
- 2026-09-20 05:21 UTC — Test/Queued: Architect resolved the decision; Tester continues
- 2026-09-20 05:21 UTC — Design/Queued: Tester requested an architectural decision
- 2026-09-20 05:21 UTC — Test/Queued: Builder passed
- 2026-09-20 05:21 UTC — Build/Queued: Changes requested from Builder
- 2026-09-20 05:21 UTC — Test/Queued: Builder passed
- 2026-09-20 05:21 UTC — Build/Queued: SPEC v1 approved
- 2026-09-20 05:21 UTC — Design/Waiting for you: SPEC v1 proposed

</details>

## Next action

> Review and merge the pull request in GitHub when it is ready, or request changes.
>
> **Merge** in GitHub.
>
> **Request changes**
>
> ```text
> /factory answer <changes>
> ```
> The text becomes a human auto-fix finding for Builder.

<details><summary>All commands</summary>

- `/factory start [guidance]` — start an open issue; optional guidance is issue-wide. Example: `/factory start Keep the API small`.
- `/factory help` — publish this command reference. Example: `/factory help`.
- `/factory approve vN [guidance]` — approve SPEC vN; optional guidance applies to that SPEC. Example: `/factory approve v2 Preserve the public API`.
- `/factory answer <text>` — answer the active question or request PR changes. Example: `/factory answer Use SQLite`.
- `/factory retry [--issue] [--for <roles>] [guidance]` — resume failed, paused or cancelled work and optionally add guidance. Example: `/factory retry --for tester Do not use Chromium`.
- `/factory note [--issue] [--for <roles>] <text>` — add guidance without changing state. Example: `/factory note --issue Keep dependencies minimal`.
- `/factory replace <#N|id-prefix> [--issue] [--for <roles>] <text>` — replace active guidance. Example: `/factory replace #2 Use WebKit`.
- `/factory revoke <#N|id-prefix>` — revoke active guidance. Example: `/factory revoke #2`.
- `/factory pause [reason]` — pause active work; the reason is audit evidence only. Example: `/factory pause Waiting for product review`.
- `/factory cancel [reason]` — cancel work; the reason is audit evidence only. Example: `/factory cancel Product direction changed`.

</details>

<sub>workflow-rev:21 · presentation-rev:21 · event:9710705a-9115-4114-84d8-a9c01d2e9389</sub>
````

### DELIVERY/PAUSED status

````markdown
# Issue content audit

| Detail | Value |
| --- | --- |
| Stage | Delivery |
| Status | Paused |
| Current actor | Human |
| SPEC version | v1 |
| Attempt | 0 |
| Open request | Waiting for merge |
| Pull request | https://github.com/owner/demo/pull/7 |
| Last command | `pause` by @owner — applied |

### Active human guidance

- **#1** · `2fa02b97` — 1. Support fans.
2. Cache for five minutes.

### Latest delivery summary

**Reviewer:** Delivery is ready for human review

<details><summary>Last 10 workflow transitions</summary>

- 2026-09-20 05:21 UTC — Delivery/Paused: Human paused work: lunch
- 2026-09-20 05:21 UTC — Delivery/Waiting for you: Branch published and pull request ready
- 2026-09-20 05:21 UTC — Delivery/Queued: Reviewer passed
- 2026-09-20 05:21 UTC — Review/Queued: Tester passed
- 2026-09-20 05:21 UTC — Test/Queued: Architect resolved the decision; Tester continues
- 2026-09-20 05:21 UTC — Design/Queued: Tester requested an architectural decision
- 2026-09-20 05:21 UTC — Test/Queued: Builder passed
- 2026-09-20 05:21 UTC — Build/Queued: Changes requested from Builder
- 2026-09-20 05:21 UTC — Test/Queued: Builder passed
- 2026-09-20 05:21 UTC — Build/Queued: SPEC v1 approved

</details>

## Next action

> Paused by @owner — Human paused work: lunch. Post `/factory retry` to resume.
>
> ```text
> /factory retry [--issue] [--for <roles>] [guidance]
> ```
> Optional guidance stays active for the current SPEC by default.
>
> **Preserved request after resuming**
>
> Review and merge the pull request in GitHub when it is ready, or request changes.
>
> **Merge** in GitHub.
>
> **Request changes**
>
> ```text
> /factory answer <changes>
> ```
> The text becomes a human auto-fix finding for Builder.

<details><summary>All commands</summary>

- `/factory start [guidance]` — start an open issue; optional guidance is issue-wide. Example: `/factory start Keep the API small`.
- `/factory help` — publish this command reference. Example: `/factory help`.
- `/factory approve vN [guidance]` — approve SPEC vN; optional guidance applies to that SPEC. Example: `/factory approve v2 Preserve the public API`.
- `/factory answer <text>` — answer the active question or request PR changes. Example: `/factory answer Use SQLite`.
- `/factory retry [--issue] [--for <roles>] [guidance]` — resume failed, paused or cancelled work and optionally add guidance. Example: `/factory retry --for tester Do not use Chromium`.
- `/factory note [--issue] [--for <roles>] <text>` — add guidance without changing state. Example: `/factory note --issue Keep dependencies minimal`.
- `/factory replace <#N|id-prefix> [--issue] [--for <roles>] <text>` — replace active guidance. Example: `/factory replace #2 Use WebKit`.
- `/factory revoke <#N|id-prefix>` — revoke active guidance. Example: `/factory revoke #2`.
- `/factory pause [reason]` — pause active work; the reason is audit evidence only. Example: `/factory pause Waiting for product review`.
- `/factory cancel [reason]` — cancel work; the reason is audit evidence only. Example: `/factory cancel Product direction changed`.

</details>

<sub>workflow-rev:22 · presentation-rev:22 · event:5c2650f3-2769-4b1d-aa49-4722593a188d</sub>
````

### DESIGN/FAILED status

````markdown
# Timed out work

| Detail | Value |
| --- | --- |
| Stage | Design |
| Status | Failed |
| Current actor | Human |
| SPEC version | Not proposed |
| Attempt | 0 |
| Failure | Provider stopped before returning a result |

### Failure details

- **Failure class:** execution
- **Stage:** DESIGN
- **Attempt:** 0
- **Agent:** Architect
- **Execution:** `60db8aaf-e2ce-45cf-b38d-c9b6621a178b`
- **Process result:** timed_out

#### What happened

Provider stopped before returning a result

#### Diagnosis

**Summary:** The agent execution exceeded its configured time limit.

**Evidence:** The execution supervisor recorded the process as timed out before the stage completed.

**Recommended action:** Inspect the last command in the evidence below, correct a stalled dependency or increase the execution timeout when the work is expected to take longer, then retry.

_No stderr output was available. Use **Daemon logs** in the dashboard for additional context._

<details><summary>Last 1 workflow transitions</summary>

- 2026-09-20 05:21 UTC — Design/Failed: Provider stopped before returning a result

</details>

## Next action

> Resolve the reported cause, then retry this stage.
>
> ```text
> /factory retry [--issue] [--for <roles>] [guidance]
> ```
>
> Optional guidance stays active for the current SPEC by default and appears above with its id.

<details><summary>All commands</summary>

- `/factory start [guidance]` — start an open issue; optional guidance is issue-wide. Example: `/factory start Keep the API small`.
- `/factory help` — publish this command reference. Example: `/factory help`.
- `/factory approve vN [guidance]` — approve SPEC vN; optional guidance applies to that SPEC. Example: `/factory approve v2 Preserve the public API`.
- `/factory answer <text>` — answer the active question or request PR changes. Example: `/factory answer Use SQLite`.
- `/factory retry [--issue] [--for <roles>] [guidance]` — resume failed, paused or cancelled work and optionally add guidance. Example: `/factory retry --for tester Do not use Chromium`.
- `/factory note [--issue] [--for <roles>] <text>` — add guidance without changing state. Example: `/factory note --issue Keep dependencies minimal`.
- `/factory replace <#N|id-prefix> [--issue] [--for <roles>] <text>` — replace active guidance. Example: `/factory replace #2 Use WebKit`.
- `/factory revoke <#N|id-prefix>` — revoke active guidance. Example: `/factory revoke #2`.
- `/factory pause [reason]` — pause active work; the reason is audit evidence only. Example: `/factory pause Waiting for product review`.
- `/factory cancel [reason]` — cancel work; the reason is audit evidence only. Example: `/factory cancel Product direction changed`.

</details>

<sub>workflow-rev:2 · presentation-rev:2 · event:20f87126-4acf-4cb0-96d1-d7867210ad7a</sub>
````

### Architect questions milestone

````markdown
# Architect — questions

## Summary

I need two product choices

## Questions

1. Which audience is primary?
2. Should results be cached?

## Next action

Reply with:

```text
/factory answer
1. <answer 1>
2. <answer 2>
```
````

## Not changed

- I8's process-result row already used the persisted final execution status on current `main`; it rendered `timed_out`, so that output was retained.
- No cosmetic findings from the earlier audit were reintroduced.
- No workflow state, record model or GitHub polling behavior changed.

## Verification

- Baseline: `PATH=/usr/local/Cellar/node/26.4.0/bin:/usr/local/git/bin:$PATH npm test` — 144 passed, 0 failed.
- Baseline harness: `PATH=/usr/local/Cellar/node/26.4.0/bin:/usr/local/git/bin:$PATH node --import tsx --test test/issue-content.test.ts` — 1 passed, 0 failed.
- Final suite: `PATH=/usr/local/Cellar/node/26.4.0/bin:/usr/local/git/bin:$PATH npm test` — 146 passed, 0 failed.
- Final build: `PATH=/usr/local/Cellar/node/26.4.0/bin:/usr/local/git/bin:$PATH npm run build` — completed successfully.
- `git diff --check` — clean, no output.
- No test was retried to turn a failure green and no flaky test was observed. Intermediate focused failures were expectation changes made deliberately during red/green development and are represented by the per-item commits.

## Documentation

- **§8.2:** human request labels, actionable ownership, pause/cancel provenance, meaningful transition history, class/status failure diagnosis, specific parse errors and approver assignment.
- **§8.3:** Architect questions, self-contained SPEC approval, tactical decisions, decision routing and PR links.
- **§8.5:** reviewed; unchanged because comment-marker format and recovery identity did not change.

## Open questions

None.

# Issue identity follow-up review

Date: 2026-09-20  
Branch: `fix/issue-identity-followups`  
Starting revision: `e29d950` (current `main`, later than `8c82bbf`)

## Decisions recorded before implementation

### M1 — Agree

Description hint identity includes `issue.updatedAt`, and the GitHub fake does not model the parent issue timestamp change caused by publishing a comment. On GitHub, each hint comment therefore changes the next key while the faulty description remains identical.

### M2 — Agree

`discoverStartIssues` records the evaluation timestamp and parses every returned issue before checking whether the same immutable issue identity is already tracked. Moving the existing identity check to the start of the loop avoids work and the extra `startIssue` lookup while preserving recreated-issue handling.

### M3 — Agree

`startComment` lacks the marker guard already present in `WorkflowInbox.poll`. Factory-authored comments should be excluded before parsing so future comment formats cannot accidentally become operator commands.

### M4 — Agree

Parse failures are durably rejected and therefore frozen, but the current reason only says that the command is malformed. The requested text accurately explains that editing the rejected comment cannot retry it.

### M5 — Agree

The cost is avoidable even for a modestly active repository: discovery currently fetches the same issue once per comment in the window. A tick-local map is a small bounded change, preserves freshness between ticks, and can also supply the already-fetched issue to start intake.

## Changes and evidence

### M1 — Stable description hint identity

Commit: `fe57460` (`fix: M1 stabilize description hint identity`)

- `src/workflow-orchestrator.ts` derives description hint identity from the issue id and the first 16 hexadecimal characters of SHA-256 over the description body. The same key feeds the public marker and metadata guard.
- `test/workflow-orchestrator.test.ts` now makes both `publishWorkflowComment` and `syncWorkflow` advance the fake issue's `updatedAt`, matching GitHub's parent-issue behavior.
- `misplaced approver starts in comments and descriptions receive one idempotent hint` performs second and third ticks after hint publication and proves that an unchanged body creates no additional hint.

Red-before/green-after evidence:

```text
# Before the production fix
✖ misplaced approver starts in comments and descriptions receive one idempotent hint
Expected values to be strictly equal: 3 !== 2

# After the production fix
✔ misplaced approver starts in comments and descriptions receive one idempotent hint
tests 1; pass 1; fail 0
```

An edit changes the body hash and may receive one new hint if the edited description is still a near miss or misplaced start. An edit that fixes the description produces no hint.

### M2 — Skip tracked issue rediscovery

Commit: `39a64fd` (`fix: M2 skip tracked issue rediscovery`)

- `src/workflow-orchestrator.ts` records the evaluated timestamp and immediately skips an issue whose number and immutable `issue_id` already match active work.
- The early check still lets a recreated issue through because `tracked()` requires the new issue id to match.
- `an approver-authored description start is discovered once with guidance and a comment snapshot` now returns the tracked issue with a newer timestamp, directly runs discovery, and asserts zero detail `issue()` calls and no new events.

Evidence: the assertion was red before the early check. The fake was then adjusted so constructing a `repositoryIssues` result is not counted as the separate detail endpoint; with the production fix the focused test passes and observes zero detail calls.

### M3 — Ignore factory-authored start comments

Commit: `30610ca` (`fix: M3 ignore factory-authored start comments`)

- `src/workflow-orchestrator.ts` returns from `startComment` before parsing when the body contains `<!-- ai-factory:`.
- `factory-authored comments cannot start an untracked issue` supplies a marker-bearing comment with `/factory start` at the boundary and asserts that no work item and no rejection/start event are created.

Evidence: focused test passed, 1/1.

### M4 — Explain malformed command immutability

Commit: `5598f56` (`fix: M4 explain malformed command immutability`)

- `src/workflow-inbox.ts` records parse failures as `Unknown or malformed /factory command. Post a new comment; edits to this one are not re-read.`
- `test/workflow-inbox.test.ts` asserts the complete reason in both the status projection and persisted `command.rejected` event.
- Rejected commands remain frozen; no reevaluation behavior changed.

Evidence: focused `command outcomes are persisted and visible in the status comment` test passed, 1/1.

### M5 — Cache issue lookups within discovery

Commit: `01efcf9` (`fix: M5 cache issue lookups during discovery`)

- `src/workflow-orchestrator.ts` creates one tick-local `Map<number, Issue>` in `discoverStartCommands`.
- `startComment` passes the cached issue to `startIssue`, which accepts it as an optional already-read identity. Dashboard, CLI and description starts retain their existing fetch behavior.
- `comment discovery caches issue identity within one tick` supplies two comments for one untracked issue, ending in `/factory start`, and asserts one issue lookup and one work item.

Evidence: focused test passed, 1/1.

## Verification

Baseline focused suite before changes: 32 tests, 32 pass, 0 fail.

### Required focused suite

Command:

```sh
node --import tsx --test test/workflow-orchestrator.test.ts test/workflow-inbox.test.ts test/factory-command.test.ts
```

Result: exit 0; 34 tests, 34 pass, 0 fail, 0 skipped.

### Full suite

Command:

```sh
npm test
```

Result: exit 0; 141 tests, 141 pass, 0 fail, 0 skipped.

Relevant output:

```text
✔ misplaced approver starts in comments and descriptions receive one idempotent hint
✔ factory-authored comments cannot start an untracked issue
✔ comment discovery caches issue identity within one tick
ℹ tests 141
ℹ pass 141
ℹ fail 0
```

### Build

Command:

```sh
npm run build
```

Result: exit 0; `tsc && node scripts/copy-assets.mjs` completed without errors.

### Diff validation

Command:

```sh
git diff --check
```

Result: exit 0 with no output before the report commit. It was repeated after the report commit with the same result.

## Limitations

- The GitHub timestamp side effect is modeled deterministically in the fake; no live issue was modified during this review.
- `docs/CONTEXT_AND_WORKFLOW_DESIGN.md` §5.4 was not changed. It promises idempotent hints but does not describe the key construction, so replacing the timestamp component with a body hash does not alter its documented contract.
- No test was skipped, disabled or loosened. No flaky failure occurred.

# Metrics for tuning the factory

The factory records what it did so the process can be adjusted from data rather than from
impressions. Everything here is read from rows and events the workflow already writes; nothing is
estimated, and a value nobody measured is reported as `null`, never as zero.

```sh
ai-factory metrics <work-item-id-or-issue-number>   # one issue, or an epic with its stories
ai-factory activity <id>                             # per-role provider activity and cache split
ai-factory benchmark <id> --verify                   # the fixed benchmark issue, graded by the oracle
```

`metrics` given a story resolves to its epic and reports the whole family.

## What is recorded, and where

| Event | Written by | Fields | Question it answers |
| --- | --- | --- | --- |
| `execution.finished` | execution manager | provider usage (uncached input, cache reads, cache writes, output, total), turns, event histogram, duration, cost estimate | What did each run cost and do |
| `model.selected` | runner | role, provider, model, policy reason, context budget | Which model ran and why |
| `verification.selection` | results, on every Tester result | `verificationDepth`, `candidates`, `kept`, `essential`, `valuable`, `redundant`, `valuableDiscarded`, `commands` | Is the Tester choosing the minimum sufficient set at the approved depth |
| `epic.verification_scope` | results, on an epic after its stories | `role`, `criteria`, `verifiedByStories`, `required`, `covered` | How much of the epic's verification was already done by its stories |
| `workflow.transition` | projections | from, to, reason code | Path, correction cycles, `no-change-pass` (a correction request that found nothing to change: a false blocker) |
| `command.applied` | inbox | command, login | Human interventions per issue and per epic |
| `story.issue_created` / `story.issue_adopted` / `story.started` / `stories.integrated` | orchestrator | epic, key, issue | Story lifecycle and the polls between one story closing and the next starting |
| `budget.*` and `budget` records | budget | consumed, granted, acknowledged runs | Spend against the approved cap, per family |

Findings live in `records` (`kind = finding`) with severity, classification, origin role and, when
known, the criterion. Tokens live on `executions` and travel in the published issue state.

## What `metrics` reports

- **members**: the epic and each story with tokens, unmeasured runs, executions per role, correction
  cycles, attempts, start, completion and duration.
- **totals**: tokens, executions, correction cycles, human commands, stories planned and completed,
  wall time when every member completed.
- **testing**: Tester runs, candidates considered, kept, essential, valuable, redundant, valuable
  discarded, kept ratio, and the same per approved depth.
- **epicVerification**: each epic Tester or Reviewer run with criteria total, verified by stories,
  required and covered.
- **findings**: by role and severity; Reviewer findings on a criterion a story owned (a defect the
  story's Tester should have caught); `no-change-pass` count (false blockers).
- **interventions**: human commands by kind.

## Reading it

- **Was the split worth it?** Compare `totals.tokens` and `wallSeconds` of the epic with a
  single-issue run of a comparable change (`benchmark --baseline` for the fixed issue). A split pays
  when stories ran on more than one installation or when a failure stayed inside one story.
- **Is testing sized to risk?** `testing.byDepth`: a `minimal` story whose kept ratio matches a
  `thorough` one is being over-tested, or the depths are wrong. `valuableDiscarded` at zero on every
  run means the Tester never says no.
- **Did the epic re-verify its stories?** `epicVerification.required` should be small against
  `criteria`; `covered` far above `required` means the epic Tester repeated story work.
- **Is the Reviewer catching what the Tester missed?** `findings.reviewerOnStoryCriteria` above zero
  is a story Tester that passed something it should not have; look at that story's depth.
- **Is anything sending work back for nothing?** `findings.noChangePasses` counts correction cycles
  where the Builder found nothing to change. Each one cost a Builder run.
- **How much human time?** `interventions.byKind`: approvals are the floor; answers, retries and
  budget extensions are the cost of an unclear brief, a fragile environment or an under-sized cap.

## Not yet measured

- **Stories reopened after Done** and **bugs found after the gate**: nothing reopens a completed
  story today; when a follow-up issue references one, that link will be the measure.
- **Decision override rate** for a rules-based decision engine: no such engine runs yet. When one
  does, record each of its decisions with the outcome the LLM or the human reached for the same
  question, so a decision type with a high override rate stops being delegated.
- **Per-turn prompt cost**: the providers now stream per-turn usage; the benchmark does not read it
  yet (see `docs/BENCHMARK.md`).

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
| `executions` rows | execution manager | `status` (`succeeded`, `failed`, `timed_out`, `interrupted`, `cancelled`, `running`), `interruption_reason`, start and end | How each run ended and how long it took |
| `execution.invalid_result` | runner | validator message | A run that finished but whose result was rejected |
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
- **turnsByRole**: for every role, runs, how many of them reported a turn count, the total and the
  average. Turns are the multiplier a leaner contract is meant to move: every tool call inside a run
  re-reads the whole prompt and everything written or read so far, so fewer turns compounds with a
  smaller prompt while a smaller prompt alone does not.
- **architectPasses**: the Architect's runs split by what each returned (`brief`, `spec`, `questions`,
  `resolved`, or `no-result` when none was applied), each with runs, turns, tokens, runs without
  measured tokens and, for the spec pass, how many resumed the provider session that wrote the brief.
- **interventions**: human commands by kind.
- **outcomes** (per member) and their sums in **totals**: runs per role by how they ended, with an
  interruption keyed by its reason (`interrupted:user-pause`); how many finished runs produced no
  result and their wall time; results the validator rejected; and the longest run of consecutive
  timeouts in one stage.

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
- **Is interrupted work worth recovering?** `totals.unsuccessfulSeconds` is agent time spent on runs
  that produced nothing; the next attempt starts over. `longestTimeoutStreak.runs` of 2 or more means
  a slice does not fit the agent time limit, and a retry will time out again: shrink the story or
  raise the limit before building anything that resumes interrupted work. A Codex run cut before its
  turn ended has no measured usage, so it also shows in `unmeasuredRuns` and costs a
  `/factory budget +0` in `interventions.byKind`.
- **How much human time?** `interventions.byKind`: approvals are the floor; answers, retries and
  budget extensions are the cost of an unclear brief, a fragile environment or an under-sized cap.
- **Did a contract change that targets turns actually cut them?** `turnsByRole.<role>.avgTurns`
  before and after the change, on comparable issues. This is the number to compare when the Designer
  or Tester contract is rewritten to batch mechanical work (one script for every screenshot, one
  command for every kept test) instead of a tool call per state or per command; tokens alone can look
  similar between two runs of very different turn counts, because the prompt itself is a small share
  of what a many-turn run spends.

- **Is the brief really a quick pass, and what does the spec pass cost on top?**
  `architectPasses.brief` should be the small one: a brief whose tokens approach the spec's means the
  Architect is designing before the human validated anything. `architectPasses.spec.resumed` against
  `runs` says how often the spec continued the brief's session; compare `avgTurns` and `tokens` of
  resumed and fresh spec runs across issues to see what not exploring the repository again saves.

## Not yet measured

- **Stories reopened after Done** and **bugs found after the gate**: nothing reopens a completed
  story today; when a follow-up issue references one, that link will be the measure.
- **Decision override rate** for a rules-based decision engine: no such engine runs yet. When one
  does, record each of its decisions with the outcome the LLM or the human reached for the same
  question, so a decision type with a high override rate stops being delegated.
- **Per-turn prompt cost**: the providers now stream per-turn usage; the benchmark does not read it
  yet (see `docs/BENCHMARK.md`).

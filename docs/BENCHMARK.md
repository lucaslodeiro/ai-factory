# Benchmark run

A fixed, cheap issue used to measure the system end to end and to compare one
run against the next. It is not a test of the target application: it is a
repeatable load for the factory itself.

## What it has to be

The benchmark trades realism for comparability. It must be small enough that a
run costs little, yet still cross every gate: a specification with acceptance
criteria, an implementation, independent verification, a review and a pull
request. It must also be **the same task every time**, because comparing two
different issues measures the issues, not the factory.

## The issue

Open it on the target repository with this exact title and body, assign it to
the Factory account, and change nothing between runs.

**Title**

```
Benchmark: add a slugify helper
```

**Body**

```
Add a pure function `slugify(text)` to this project, in a new source file
under the project's existing source directory, following the conventions
already used there.

It must:

1. Lowercase the input.
2. Replace each run of whitespace with a single hyphen.
3. Remove every character that is not a letter, a digit or a hyphen, and
   collapse repeated hyphens into one, with no leading or trailing hyphen.

Add tests for those three behaviours using the test framework this project
already uses. Do not add a dependency, do not change existing files beyond
exporting the new function where the project exports its public API, and do
not change the build configuration.
```

Three numbered behaviours give the Architect three acceptance criteria without
having to invent scope. "Do not add a dependency" and "do not change the build
configuration" keep the Builder from wandering, which is what makes the run
cheap and the turn count comparable.

## Running it

```sh
npm run factory -- start-issue <number-or-url>   # assign and label it
npm run factory -- status                        # follow the stages
```

Let it reach DELIVERY without human guidance. A run where you answered a
question or sent a retry is still worth recording, but it is not comparable to
one where you did not: the extra turns are yours, not the system's.

**Do not update the factory while a benchmark run is in flight.** Every update
stops the daemon, and the execution that was running is recorded as interrupted
and retried on a new attempt. A run carrying interruptions is not comparable to
one without them: the health line counts them, and the retried role's tokens
are spent twice. Interruptions from updates are what put an unrelated issue on
attempt 2 with two dead Builders on 2026-09-22.

Plan for the queue too. The orchestrator runs **one execution at a time and
takes the oldest queued item first** (`workflow-orchestrator.ts`, `runLocal`),
so an older work item reclaims the lane every time it returns to QUEUED. A
benchmark issue queued behind one does not start until that item reaches a
state it cannot be queued out of: Delivery/Waiting, Completed, Paused,
Cancelled or Failed. Start the benchmark when nothing older is in flight.

## The objective, and why it needs a fourth term

The aim is to resolve an issue in the fewest iterations, the fewest tokens and
the least time. Stated on its own, that objective is maximised by doing
nothing, and every role has a cheap path that improves all three numbers while
making the product worse: a vaguer specification has fewer criteria to verify,
a Tester that runs fewer tests passes sooner, a Reviewer that skips dimensions
returns PASS on the first attempt, a Builder that does the minimum still turns
the tests green.

So the objective is **cost and time, subject to the issue actually being
resolved**. Cost in dollars already integrates token count and model price, and
iterations already show up inside it, which leaves two numbers to compare and
iterations as the diagnostic that explains them. Note also that an iteration is
not automatically waste: a correction cycle that caught a real defect prevented
a broken merge and was worth every token. Zero iterations with a wrong result
is the worst outcome available, not the best.

## Measuring it

```sh
npm run factory -- benchmark <issue-number> --verify --save docs/benchmark/<date>.json
```

`--verify` runs `scripts/benchmark-verify.mjs` against the checkout the run
produced. It is an independent oracle: it never reads the tests the Builder or
the Tester wrote and never trusts a reported PASS. It locates the exported
`slugify` function, calls it, and checks the three behaviours the issue stated,
preferring a source file over a test file. The report then prints
`Resolved: yes` or `no` with the failing cases.

`--verify` with no value grades the run's own worktree, which is derived from
the work item id, so there is no path to look up or paste. Pass
`--verify <path>` only to grade a checkout somewhere else. The oracle is a
`.mjs` script that imports the TypeScript the run produced, so it needs `tsx`,
which node resolves from the working directory; the command runs it from the
engine's own directory and makes the checkout absolute before that move.

Without it, the cost figures are the system grading its own homework, so a run
that got cheaper by getting lazier reads as an improvement. `--baseline`
therefore refuses to compare when either side was unverified or unresolved: the
numbers are still printed and still saved, what is refused is calling the
difference a result.

The report prints, per role and in total: executions, turns, provider events,
prompt bytes, input and output tokens, cache reads and cache writes apart,
total tokens, cost in dollars and duration, plus each role's final outcome. It
then prints the workflow's transition path with the reason for each move, and a
health line counting failed executions, invalid results, interruptions and
discarded runs.

The report then prices the prompt the factory assembles, which is the question
"is it worth shrinking". A prompt token is written to cache once and re-read on
every turn, so it costs `cacheWrite + turns x cacheRead`, while what the agent
fetches for itself is read far fewer times. The decisive number is the last
column: how many prompt tokens cost what one more turn costs. On the first
resolved run that was 4,314 for the Builder against a prompt of 7,269 tokens,
so deleting *half* the Builder's prompt did not pay for one extra turn.

Only the bytes-to-tokens conversion is an estimate there, at 4 bytes per token;
everything else is measured. The runs measured here used Claude's
`--output-format json`, which reports usage for the whole run and never for its
first turn, so the prompt cannot be isolated from what the agent pulled in
afterwards. The conclusion was checked across 3.5 to 4.5 bytes per token, where
the prompt's share moves between 10% and 13% of the run and the ranking of the
roles does not change. The Claude adapter now uses `stream-json`, whose
assistant events carry per-turn usage, so a later run can give the exact number
once the benchmark reads it; it does not yet.

Compare a later run against a saved baseline:

```sh
npm run factory -- benchmark <work-item-id> --baseline docs/benchmark/<date>.json
npm run factory -- benchmark <work-item-id> --baseline docs/benchmark/<date>.json --role developer
```

A metric missing on either side compares as null rather than as a delta,
because a value nobody measured is not an improvement.

## Reading it honestly

- **Cost, turns and duration are the performance numbers.** Prompt bytes only
  matter through them: the prompt sits at the head of the conversation and is
  re-read on every turn, so bytes are multiplied by turns. Even so the whole
  prompt budget was 11% of the first resolved run, spread evenly across the
  four roles, so there is no concentrated saving in it. A cut that makes an
  agent go and fetch what was removed loses: it pays the same tokens in again
  and adds turns on top.
- **`Resolved` decides whether the run counts at all.** A run that did not
  resolve the issue has no comparable cost: it did not do the work. Correction
  cycles, invalid results and the transition path then say how expensively it
  got there. A change that halves tokens while adding a correction cycle made
  the system worse.
- **A second run of a role should be cheaper than its first.** When a
  correction cycle happens, `ai-factory activity <work-item-id>` lists each
  role's runs in order. Read `vsPreviousPercent` before `vsFirstPercent`: a
  first run that aborted early is a tiny baseline that makes every later run
  look like a catastrophe. The second Builder already has the findings and the
  code it wrote, so it should cost less. On issue 6 of the demo repository it
  did not, across eight runs, which is the largest open cost problem in the
  system: one cycle re-runs Builder and Tester, about 90% of an issue.
- **One run is not a measurement.** These are agents: the same issue varies
  between runs. Treat a difference under roughly 10% as noise until you have
  run the benchmark three times and seen the spread for yourself.
- **Providers do not report the same things.** Codex streams one JSON object
  per line, so its event histogram is real, but it reports only a token total
  with no cache split and no cost. Claude returns a single envelope, so its
  event count is always 1, but it reports turns, the cache split and a cost
  estimate. Compare a role against itself across runs, never across providers.

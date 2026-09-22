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

## Measuring it

```sh
npm run factory -- benchmark <work-item-id> --save docs/benchmark/<date>.json
```

The report prints, per role and in total: executions, turns, provider events,
prompt bytes, input and output tokens, cache reads and cache writes apart,
total tokens, cost in dollars and duration, plus each role's final outcome. It
then prints the workflow's transition path with the reason for each move, and a
health line counting failed executions, invalid results, interruptions and
discarded runs.

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
  re-read on every turn, so bytes are multiplied by turns.
- **Correction cycles, invalid results and the transition path are the quality
  numbers.** A change that halves tokens while adding a correction cycle made
  the system worse. Read both tables or neither.
- **One run is not a measurement.** These are agents: the same issue varies
  between runs. Treat a difference under roughly 10% as noise until you have
  run the benchmark three times and seen the spread for yourself.
- **Providers do not report the same things.** Codex streams one JSON object
  per line, so its event histogram is real, but it reports only a token total
  with no cache split and no cost. Claude returns a single envelope, so its
  event count is always 1, but it reports turns, the cache split and a cost
  estimate. Compare a role against itself across runs, never across providers.

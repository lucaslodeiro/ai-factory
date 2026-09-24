# MVP validation — 2026-09-19

## Automated checks

`npm run build` and `npm test` pass on macOS with Node 26.4.0. The current suite has 125 passing tests, zero failures and zero skips. Shell syntax validation passes for every `scripts/*.sh`; the isolated configuration, dashboard-address, maintenance/update, macOS installer and uninstall scenarios also pass. `shellcheck` was not installed on the validation host.

The release gate is `npm run test:all`. It runs the runtime suite followed by all five script fixtures: macOS installer, maintenance/update, uninstall, terminal configuration and dashboard-address selection. Installation and update intentionally keep using the faster `npm test` runtime gate so they do not depend on launchd or repeat installer fixtures on an operator machine.

A Node 22/Linux GitHub Actions template is provided in `docs/ci.example.yml`. It is not activated: the current GitHub OAuth credential lacks the workflow scope, and GitHub rejected a push containing `.github/workflows/ci.yml`. Copy the template there using a credential permitted to manage workflows when ready.

The automated suite covers:

- The complete V3 stage/status model: Design, Build, Test, Review and Delivery crossed with queued, running, waiting, failed, paused, cancelled and completed conditions; revision-checked transitions, requests, failures, findings, correction cycles and one authoritative GitHub CTA.
- Context selection, protected budget behavior, role filtering, deterministic ordering, exact prompt/hash persistence, sensitive prompt reveal acknowledgement and 30-day artifact retention.
- Planned maintenance preflight, confirmation revalidation, global scheduler barrier, interrupt-versus-cancel semantics, timeout refusal, batch resume and unexpected-shutdown recovery with the worktree preserved.
- Closed-issue exclusion/reopen behavior, idempotent GitHub projection, sanitized human-readable failure diagnosis and retry guidance, plus durable Slack delivery independent from GitHub availability.
- Bounded repository Check, Sync, Publish, Clear and Restore behavior, including dirty/diverged/protected-branch and unsafe-path refusal.

- Full foreground daemon with real SQLite, separate CLI control processes, real Git worktrees and a local bare remote. Deterministic provider executables consume the actual adapter arguments and stdin; a GitHub executable fixture supplies issues/comments and records the PR. The test approves a version, starts Implementation Engineer, checks status without recovery side effects, cancels, retries, runs Verification Engineer/Delivery Reviewer, publishes a branch and verifies Delivery/Waiting, then stops the daemon.
- Native Claude/Codex output envelopes, role-specific generation schemas and local validation. Read-only Delivery Reviewer receives attributed Verification Engineer execution evidence without Implementation Engineer reasoning or Verification Engineer summary conclusions.
- Per-role provider/model routing in `direct-v1`, including direct model selection, `auto` argument omission for both adapters, and an end-to-end run with every role assigned to the opposite provider from its default (Codex Architect/Delivery Reviewer and Claude Implementation Engineer/Verification Engineer). Claude delivery roles receive editing tools while provider-independent worktree checks preserve read-only and Verification Engineer boundaries.
- Invalid/stale/unauthorized/bot approvals and question/answer loops.
- Explicit issue entry through an authorized, unedited standalone `/factory start` repository comment or dashboard/CLI controls, with persistent comment cursors and deduplication. Pull requests, closed issues, labels, quoted commands, edited comments, bots and unauthorized users cannot start work.
- Verification Engineer auto-fix, decision routing, bounded correction loops and deferred findings.
- Durable GitHub outbox, idempotent delivery and malformed output failure.
- Process success, spawn errors, preserved provider exit codes, timeout and cancellation.
- Forced daemon SIGKILL with TERM-resistant worker/descendant cleanup, live-group retry blocking, and the crash window between successful process exit and workflow commit.
- Tactical resolutions retaining the approved spec/version/approval, routing back to Implementation Engineer or Verification Engineer, and rejection of self-approval, human conflicts and skipped gates.
- Mandatory criteria coverage, executed-test evidence, dependency rationale and review dimensions.
- Durable Slack retries across database reopening, disabled notifications, independent GitHub outages and real local HTTP adapter tests (not a real Slack channel).
- Simultaneous SQLite migrations from four independent processes.
- Single-daemon lock, environment filtering, Verification Engineer file restrictions and branch publication restrictions.
- Assigned-branch checks before agent execution and commits, including same-commit branch switches and detached HEAD. Real Git regression cases preserve raw Unicode/newline/tab/space filenames and reject renaming production files into test paths during Verification Engineer.
- Transient GitHub comment-read failures preserve Design/Waiting and its approval cursor; polling recovers without a manual retry or another agent invocation.
- Dashboard-first installation creates a private default `.env`, accepts a loopback host and port, selects the next available port when occupied, installs both service definitions, starts only the dashboard and opens the effective first-time setup URL. Every setting with a safe universal value has a displayed default; authenticated GitHub identity supplies editable defaults for the otherwise unknown target repository, clone and approver. Dashboard saves validate before service changes, restart affected running services, preserve stopped services, and leave service state untouched on invalid input. Update preserves configuration without invoking the supported terminal recovery wizard.
- Uninstall removes both factory service definitions, the installation checkout and internal or marked external runtime data while preserving the target repository and shared tools. Unsafe removal roots are rejected.

- Direct per-role model selection, immutable approved assessments, explicit and automatic CLI model behavior, provider mismatch rejection and run-linked selection audit.

- High-complexity/high-risk drafts receive an additional Architect review before an approvable version exists; failed reviews and clarification loops retain the draft and review requirement, and premature approvals are ignored. This second-review behavior is tested with deterministic providers, not live Claude.

- Human-readable Markdown spec/reports, actionable progress summaries, enriched pause/cancel/recovery/delivery lifecycle messages, in-place status comment updates, and preservation of unrelated labels.

- PR lifecycle reconciliation: exactly-once transition notices, terminal merge evidence, close-without-merge, reopen, and API outage recovery without agent execution. Standalone sync refuses to race the daemon.

## Completed live four-role demo (historical evidence)

On 2026-09-18, the real pipeline reached **READY_TO_MERGE** and created demo PR #2. The human subsequently merged it; the orchestrator reconciled it to MERGED and the issue closed. The temporary private demo repository was deliberately deleted after validation, so it no longer has browsable GitHub URLs. The retained local SQLite database, logs and clone are the audit evidence for this historical run.

- Target at execution time: private `lucaslodeiro/ai-factory-demo`, issue #1, PR #2.
- Work item: `e3d45eaf-fad3-48c0-8e99-fccc121cecd7`.
- Claude authenticated successfully; doctor passed for both providers, Git/GitHub, target repository and SQLite.
- Product Architect (Sonnet) published SPEC v1 with ten acceptance criteria and low complexity/low risk. The human `lucaslodeiro` approved the exact version in comment `5732900319`.
- Implementation Engineer (Luna) implemented the pure Unicode text-analysis function, stdin/stdout CLI, README, ESM package and nine tests without dependencies.
- Verification Engineer (Terra), in a fresh execution, ran all nine tests successfully with Node 26.4.0 and additional independent function/CLI, exit-status, output and dependency checks.
- Delivery Reviewer (Sonnet), in a fresh read-only execution, independently inspected code, tests and all review dimensions. It explicitly attributed runtime evidence to Verification Engineer, reported no blocking findings and returned PASS.
- The orchestrator committed and pushed `factory/issue-1-e3d45eaf` (commit `63ac9beb12ea1f676ed9a5472741c504849837a2`), created PR #2 against main and delivered all queued GitHub messages. No automatic merge. The daemon was stopped after completion.

### Live integration failures found and corrected

This was not an uninterrupted first-attempt success. Two validation failures were retained in the audit trail and resolved before explicit stage retries:

1. Implementation Engineer's first process completed but returned forbidden spec/criteria/nextRole fields and historical failed commands in its PASS report. Its login shell also selected Node 20 and Xcode Git. Provider output schemas now constrain delivery fields by role; prompts distinguish final verification from historical failures and prepend the configured Node/Git directories to shell commands. Implementation Engineer retried on retained files and verified Node 26.4.0 with nine passing tests.
2. Read-only Delivery Reviewer initially lacked Verification Engineer execution evidence and returned PASS with an execution-dependent criterion marked not-run. The coverage gate rejected it. Delivery Reviewer now receives attributed Verification Engineer test/criterion evidence, without Implementation Engineer reasoning or Verification Engineer summary conclusions, and distinguishes those results from commands it personally ran. The retry passed without weakening the coverage gate or adding shell access.

### Run evidence

| Role/attempt | Run ID | Result |
|---|---|---|
| Architect | `3921aab6-8fa7-4b70-82a2-f16dee7e7c85` | SPEC v1 |
| Implementation Engineer first attempt | `5340fb8d-fc33-456b-96df-32700c6a9a94` | Process succeeded; report rejected |
| Implementation Engineer retry | `226bae67-60ee-4791-a7fc-bf12f9fd442f` | PASS |
| Verification Engineer | `34c5aeb5-0f3a-487c-a4b5-d962cabddf11` | PASS |
| Delivery Reviewer first attempt | `a7250093-7fc1-4d22-b051-9fea2b0dc6f9` | Process succeeded; coverage rejected |
| Delivery Reviewer retry | `e5d80fb7-42a5-480d-91d7-60b38178543f` | PASS |

Logs and SQLite remain under `.factory/demo/` on the original validation machine. Earlier standalone Codex protocol checks also passed, including explicit Terra selection (`d83d51bd-d69f-49da-bed3-97e3baca45a1`).

## Cursor provider — 2026-09-22 (automated only)

The Cursor Agent CLI adapter was added with the same subprocess fixtures as Codex and Claude: prompt delivery on stdin, `--model` and `auto` omission, `--force` for Implementation Engineer and Verification Engineer, `--mode ask` for Product Architect and Delivery Reviewer, extraction of the final message from the JSON envelope (bare, fenced or surrounded by prose), rejection of error envelopes and contract-breaking results, dashboard provider/credential/model catalog coverage, doctor checks limited to selected providers, and the macOS installer mock for `https://cursor.com/install`. The CLI's flags come from its published reference and local `--help`; no run against a real, authenticated Cursor account has been recorded yet. Before relying on Cursor for a delivery, verify with a signed-in account that `--mode ask` refuses file writes, that stdin prompts are accepted, and how often the final message is a clean JSON object.

## Reviewer evidence projection — 2026-09-22

The Delivery Reviewer's Tester evidence is now projected to outcome, `coverage` and `tests` and marked protected. On a representative Tester report the section drops from about three thousand bytes to under three hundred, and the Reviewer no longer receives the Tester's summary conclusions, findings, tactical decisions or dependency rationale, which matches the documented independence requirement that the code did not previously honour. Covered by `test/context-assembly.test.ts` and end to end by `test/workflow-runner.test.ts`.

## Prompt trimmed per role — 2026-09-22

Derived from the cache metrics of issue #6, where Builder and Tester executions moved millions of cached tokens against double-digit uncached input tokens. The per-role prompt contract on Claude drops as follows, and `test/prompts.test.ts` locks both the filtering and the section order.

| Role | Before | After |
|---|---:|---:|
| Architect | 10838 | 10601 |
| Builder | 11073 | 10084 |
| Tester | 12028 | 11039 |
| Reviewer | 12263 | 11366 |

The previous "roles share a byte-identical prefix" invariant was retired with that evidence. It has not been re-measured against a live run: confirm on the next issue that cached tokens per execution fall rather than rise.

To make that confirmation possible, `execution.finished` now records cache reads and cache writes apart from each other. The `cached_tokens` column keeps their sum, so no schema change and no fresh data directory are required. The distinction matters because a write is a miss that populated the cache and a read is a hit: summed, a cache improvement and a cache regression are indistinguishable. Read the split with `npm run factory -- events <work-item-id>`.

The same event now carries `activity`: how many JSON objects the provider wrote to stdout, a histogram keyed by the event type the provider itself reports, and the turn count and API duration when the provider states them. Codex streams one object per line, so its histogram is real; Claude and Cursor return a single result envelope, so they contribute only what that envelope states. The histogram is deliberately not keyed by a fixed vocabulary: a provider renaming or adding an event type shows up in the data instead of being silently dropped, and no event name had to be guessed to write the extractor.

This is the missing measurement behind the largest open cost question. On issue #6 the Builder spent 4.88M cached tokens against the Architect's 164K, and the previous Builder run spent 541K: a ninefold swing between two runs of the same role. Prompt size cannot explain that; turn count can. Nothing here changes it, the point is to be able to see it.

## Repository map for the Builder — 2026-09-22 (unvalidated hypothesis)

The Builder now receives a map of the target checkout's tracked directories. On this repository, 219 tracked files across 14 directories render in 711 bytes. The Builder's prompt contract fell from 11073 to 10363 bytes over the same period, so its total prompt is roughly unchanged while it no longer starts blind.

This is a hypothesis, not a finding: nothing yet shows that a Builder with a map spends fewer turns than one without. The measurement is set up rather than assumed. The map goes to the Builder alone, so on the next issue `execution.finished` compares the Builder against the Tester, which runs the same work without a map. On Codex compare the event histogram; on Claude the event count is always 1 and the comparable number is the reported turn count. If the Builder's event count does not fall relative to the Tester's, the map is costing bytes for nothing and should be removed.

Read the comparison with `npm run factory -- activity <work-item-id>`, which groups the finished executions of one work item by role and prints runs, provider events, events per run, reported turns, cache reads and cache writes apart, output tokens and the event-type histogram. `factory events` dumps raw payload JSON and is not readable for this.

## Benchmark scenario — 2026-09-22

`docs/BENCHMARK.md` defines a fixed, cheap issue that crosses every gate, and `factory benchmark <work-item-id>` measures one run of it: per role and in total, executions, turns, provider events, prompt bytes, input and output tokens, cache reads and writes apart, total tokens, provider-reported cost and duration, and each role's final outcome; then the workflow transition path with the reason for each move, and a health line counting failed executions, invalid results, interruptions and discarded runs. `--save` writes a baseline and `--baseline` prints the deltas.

Cost and wall duration are newly captured. The Claude result envelope was inspected directly rather than taken from documentation: it carries `num_turns`, `duration_ms`, `duration_api_ms` and `total_cost_usd`, all of which the factory previously discarded.

An independent oracle, `scripts/benchmark-verify.mjs`, grades the produced code against the three behaviours the benchmark issue states, without reading the agents' tests or trusting a reported PASS. It was exercised against four checkouts: a correct implementation (resolved, 0 failures), one that only lowercases (7 failures, the shape a run takes when it stops early and still reports PASS), one that throws (8 failures) and one with no slugify at all. A comparison where either side was unverified or unresolved is refused rather than reported, so a run that got cheaper by getting lazier cannot read as an improvement.

Verified against a seeded database covering all four roles, a saved baseline and a comparison run; the aggregation, the null handling and the transition path are covered by `test/benchmark.test.ts`. No real benchmark run has been recorded yet, so there is no baseline in `docs/benchmark/` and no variance figure. Three runs of the same issue are needed before any single difference can be called a result.

## Verification depth and finding severity — 2026-09-22

Two rules aimed at correction cycles, which the issue #6 measurements make the dominant cost: the Implementation Engineer was 60% of the issue's tokens and the Verification Engineer 30%, so one cycle re-runs 90% of an issue, roughly 95 times the value of every prompt-size cut made this session combined.

The Product Architect now declares `verificationDepth` with the specification, floored by the worse of complexity and risk so it cannot become a way to make every run cheap, and approved by the human with the spec. Every finding now carries a severity, and only `critical` or `major` may be `auto-fix`; `minor` must be `defer`. Both are enforced in `parseResult` rather than left to the prompt, and covered by `test/results.test.ts`.

The role contracts grew as a result: Architect 10601 to 11885 bytes, Builder 10084 to 10718, Tester 11039 to 12970, Reviewer 11366 to 12383. That is a deliberate trade. At roughly 100 turns the Tester's extra 1931 bytes cost about 48K cached tokens, around 2% of that role, while a single avoided correction cycle saves about 7.4M. The addition pays for itself if it prevents one cycle in something like 150 issues.

Not yet validated against a live run: nothing shows how often the Tester was returning minor findings before, so the size of the saving is unknown. The benchmark's transition path and reason codes are what will show it.

## Correction-cycle progression — 2026-09-22

`ai-factory activity <work-item-id>` now lists, for each role that ran more than once, its runs in chronological order with turns, tokens, cost, duration and `vsFirstPercent` against that role's own first run. It compares on provider-reported cost when available and on tokens otherwise; a run missing both compares as unknown rather than as an improvement.

This answers the open question behind the largest cost item: a second Builder run already has the findings and the code it wrote, so it should be cheaper than the first. If it is not, the role re-explores on every correction cycle, and that is worth more than any prompt-size work.

**Answered, on a real work item.** Issue 6 of the demo repository ran 18 executions for 15,850,719 tokens and is still Paused. The Implementation Engineer ran eight times for 9,355,388 tokens, 59% of the issue; the Verification Engineer twice for 4,579,818, 28.9%.

Its Implementation Engineer runs above a hundred thousand tokens were 1,402,703, 1,018,648, 1,359,889, 559,191 and 4,933,798: run over run, -27%, +33%, -59% and +782%. There is no downward trend. A correction cycle does not get cheaper, so the role is not carrying forward what it already produced, and the last run alone was 31% of the whole issue. The Verification Engineer also got 13.6% more expensive on its re-run. Only the Delivery Reviewer improved, by 23.3%.

That data also exposed a flaw in the first version of this report. The first two Implementation Engineer runs were 23,698 and 57,461 tokens, together 0.87% of what the role spent: stubs that aborted early. Comparing every later run against that baseline produced figures like +5819% and +20719%, technically correct and useless. The report now prints `vsPreviousPercent` alongside `vsFirstPercent` and says to read the run-over-run figure first. An unmeasured run compares as unknown and is skipped as a baseline rather than breaking the chain.

Covered by `test/execution-activity.test.ts`, including the exact shape issue 6 showed.

## Issue state index compaction — 2026-09-22

Issue 6 of the demo repository emitted `github.state_too_large` four times, at 64,882, 68,496, 71,467 and 76,146 bytes. Above 60,000 bytes the publisher dropped the machine-readable state index and published the issue body without it. The index only grows, so once an issue crossed the limit it never carried recoverable state again, and nothing was visibly wrong: the issue body still rendered correctly while `readIssueState` and `adoptIssueState` had nothing to read.

The publisher now sheds narrative text until the index fits, instead of dropping it whole. Recovery reads identifiers, versions, markers, statuses and criterion ids, never prose, so summaries, evidence, rationales, questions and failure messages are clipped in turn at 2000, 500, 120 and finally 0 characters. Everything recovery depends on is untouched, including `changedFiles`, which is structure rather than prose. The compacted index is revalidated before it is published, so it is adoptable at every budget. `github.state_compacted` records that it happened and at which budget; `github.state_too_large` now fires only when even the smallest form does not fit, which for a typical shape is around 1,300 bytes of pure structure.

On a reconstruction of issue 6's shape, four roles with five criteria each and twelve records, the full index measured 133,227 bytes and compacted to 29,271 at a 500-character budget, keeping all twelve records, all four roles and all five criterion ids. Covered by `test/issue-state-compaction.test.ts`.

## Local runtime multi-origin handling — 2026-09-22

Issue 9 of the demo repository, the benchmark issue, failed at Build before a single agent ran: `Could not prepare workflow execution: Factory local runtime did not become ready`.

The cause was a contract the Factory shares with the target repository. Issue 6 had taught that repository's preview script to publish three origins in `.local/url`, one per line with the LAN address first, and the runtime manager read the whole file as a single URL. `new URL` threw on every poll for fifteen seconds and the stage failed. Even parsing one line would not have helped: the first line is a LAN address, and the manager accepts only loopback.

The manager now reads the file as a list and takes the first loopback entry, ignoring any LAN or tunnel address beside it; `::1` counts as loopback, which it did not before. A file that announces only non-loopback origins now fails with its own message naming the hosts, because that is a different problem from never starting.

Both failures are also diagnosed by name. Before this, `failureDiagnosis` fell through to "The operation failed, but the available evidence does not identify its underlying cause" on a failure whose evidence stated the cause and gave a log path, which tells the operator there is nothing to read when there is.

Covered by `test/local-runtime-url.test.ts`, including the exact three-origin shape issue 6 produced. Not yet confirmed against a live run: issue 9 has not been retried.

**The preview server is no longer allowed to fail a stage.** `browserRequired` still fires on the target repository's dependencies rather than on what the issue asks for, but that is now a cost rather than a hazard: when the preview server does not start, the run continues without it, `runtime.local_failed` records why, and the agent is told the Factory already tried and failed so it does not spend turns rediscovering the same broken server. A role that genuinely cannot proceed reports `environment-blocked`, which is the mechanism the contracts already have.

Narrowing the trigger itself was considered and rejected. Requiring a preview script alongside the dependency would be a regression: a browser test can exercise a static build or an external URL with no preview server at all, and `browserInstructions` already handles that case. Deciding from the issue text or the specification would be a guess in both directions. The honest fix is to make the capability optional, not to predict when it is wanted.

**A second defect surfaced while verifying this.** The Cursor adapter never forwarded `localRuntimeUrl`, so a Cursor-configured Builder or Tester was told to start its own preview server beside the one the Factory had already started and was supervising. Issue 6 ended with exactly that: two runtimes of the same worktree alive at once, which its Tester recorded as the deferred finding QA-1. Codex and Claude forwarded it correctly; only Cursor, added earlier the same day, did not. `test/local-runtime-optional.test.ts` now asserts all three adapters pass it through.

## Work item references — 2026-09-22

`activity` and `benchmark` took a work item UUID and nothing else. Two ordinary mistakes hit the same dead end: naming the issue number, which is what every human-facing surface shows and what an operator reaches for, and pasting a UUID out of a terminal table one character short. Both answered `No finished executions recorded for <reference>`, which reads as a work item that ran nothing rather than an argument that names nothing.

Both commands now accept a work item id, an issue number with or without a leading hash, or an id prefix of at least eight characters, the convention `/factory replace <#N|id-prefix>` already uses. Repository and issue number are unique together, so a number names at most one work item; an ambiguous prefix is refused with the count rather than resolved to one of the matches. Prefix comparison happens in memory rather than through SQL `LIKE`, so a reference containing `%` or `_` matches literally.

Covered by `test/work-item-reference.test.ts`, including the exact truncated UUID that produced the report.

## Update left the daemon stopped — 2026-09-22

Reported from a real run: `ai-factory update` printed `Stopped daemon`, completed, and never brought it back. `ai-factory update` invokes `scripts/update.sh --restart-services`, documented as "stop loaded services, update, then restore them".

The script asked the same question two different ways. It decided what to restore with `grep -Eq "state = (running|active)"` against `services.sh status`, while the restore path itself checks `grep -q '^daemon: loaded'`. Being loaded is the operator's intent and survives a process that is momentarily down; `state = running` is today's weather. A daemon that was loaded but whose process was not running at that instant read as "not meant to be running" and was left stopped. Both places now ask whether the service is loaded.

The update also stayed silent about it. The outcome was one line, `Start it explicitly when ready`, inside a wall of build output, and the service summary that follows lists commands without saying anything is down. The update now names any service that is not loaded when it finishes, on stderr, with the command to start it.

Not reproduced locally: `launchctl` exists only on macOS, so this is reasoned from the script and the reported symptom rather than from a failing test. `scripts/test-maintenance.mjs` still passes, and it does not cover this path.

## Every fix to the updater's tail arrived one update late — 2026-09-22

Three updates in a row left the daemon stopped, and each fix was already
installed when the next one failed. `update.sh` runs `node scripts/update.mjs`,
which activates the new version, and then carried on executing **its own old
self** for everything after that: preserving configuration, installing
services, restoring the daemon, writing `data/install.json`. A correction to
any of those steps could not take effect in the update that shipped it.

After activation the script now hands over with
`exec bash scripts/update.sh --finish-update`, so the tail runs from the
version just installed. The restore intent already travels in the update state
file, which the new process reads on startup, and `exec` replaces the process
so the old EXIT trap cannot also run. The finish phase skips the
"Stopping daemon" state write, which would otherwise clear the
`versionActivated` flag the recovery path depends on.

Verified: `scripts/test-maintenance.mjs`. Upstream marks its updater's tail
with a line the installed updater does not have, so the marker can only be
written by the new version; the test asserts the installed one does not already
carry it. Without the handover the marker file never appears.

## The daemon stayed down: SIGPIPE, not the state predicate — 2026-09-22

The entry above diagnosed this from the symptom and named the wrong cause. The
daemon was left stopped by a third update that was running the corrected
script, and the update then reported both services as down although the
dashboard had just been reinstalled and bootstrapped.

The decision was written as
`bash scripts/services.sh status "$service" | grep -q "^$service: loaded"`
under `set -euo pipefail`. `grep -q` exits at its first match; the producer then
writes into a pipe with no reader, dies of SIGPIPE and reports 141; `pipefail`
makes that the pipeline's status. The `if` is false **because the pattern
matched**. `status_one` prints the service line, forks awk, then prints more,
so the reader is always gone before the later writes: a loaded service read as
stopped every time. Reproduced directly — a producer of that shape piped into
`grep -q` reports 141 with `pipefail` and 0 without it.

That predicate was used in five places: the restore decision, both restore
paths, the dashboard start and the end-of-update warning. The warning inverted
it, which is why a dashboard that was running was announced as down. All five
now call `service_loaded`, which captures the report and matches it in the
shell with no pipeline.

Choosing the predicate by process state rather than by being loaded, fixed
earlier the same day, was a real defect and stays fixed; it was not what left
the daemon stopped.

Verified: `scripts/test-maintenance.mjs`. Its fake `status` now writes its later
lines after forking awk, as the real one does, so a reader that stops early
loses the same race. With the pipeline restored the service log reads
`stop daemon / install all` and stops there, which is the reported symptom
exactly; with `service_loaded` the daemon is started again.

## The benchmark oracle never ran — 2026-09-22

The first clean benchmark run (issue #10) reported `Resolved: no` with
`Cannot find package 'tsx' imported from /Users/<operator>/`. The code the run
produced was never examined; two defects in the verifier's own plumbing made it
impossible to examine.

`benchmark --verify` spawned `node --import tsx <script> <checkout>` with no
`cwd`, so node resolved `tsx` from the operator's shell directory instead of
from the engine, where it is installed. The invocation now lives in
`verifierInvocation()` in `src/benchmark.ts`: it runs from the script's own
directory and resolves the checkout to an absolute path before that move, so a
relative checkout does not shift under it. `test/benchmark-verify.test.ts`
spawns the real oracle against a temporary git checkout from a foreign working
directory and asserts both the resolved and unresolved outcomes.

`scripts/copy-assets.mjs` never copied the oracle into `dist/`, so an installed
engine resolved `../scripts/benchmark-verify.mjs` to a path that does not exist
and every installed run would have reported `Resolved: no` for that reason
alone. It is copied now, and `scripts/validate-installation.mjs` requires
`dist/scripts/benchmark-verify.mjs` among its build assets, so a future
omission fails the installation instead of silently voiding the measurement.

`--verify` now also takes no value, grading the worktree the run used, which is
`<dataDir>/worktrees/<work item id>`. The path that had to be pasted is the
path that was pasted wrong; a missing checkout is reported as such instead of
being handed to the oracle.

A third defect surfaced while testing the fix. The oracle located the produced
function with `git grep -E "(export[^\n]*slugify|slugify[^\n]*=)"`. POSIX ERE
has no escapes inside a bracket expression, so `[^\n]` excluded the letter `n`
and `export function slugify` — the most ordinary form a Builder writes — never
matched. It was found only through the second alternative when the code
happened to be an assignment. The pattern is now `(export.*slugify|slugify.*=)`;
`git grep` is line-oriented, so the class was doing nothing but harm. A correct
implementation was reading as "produced nothing".

Verified: `npm test` (364/364) and a build followed by running
`dist/scripts/benchmark-verify.mjs` from `dist/scripts` against a temporary
checkout, which resolved 8/8 behaviours. The original operator-side failure was
not reproduced from the operator's machine.

## Cost per role, not tokens per role — 2026-09-22

`ai-factory activity` summarized roles by provider events and omitted cost.
With Claude the event count is always 1, so the ordering carried no
information, and token totals are a poor proxy for spend: on issue #10 the
Builder held 40.5% of the tokens but 29.2% of the cost, while the Architect
held 13.9% of the tokens and 21.4% of the cost. The summary now sums
`totalTokens` and `costUsd` per role and orders by cost where the provider
reported it, falling back to tokens and then to events.

## Providers stream their events — 2026-09-22

Codex now runs with `--json` and Claude with `--output-format stream-json --verbose`, so both write every event to `stdout.log` while the run happens instead of one envelope at the end. A run that is stopped keeps what it had done: the last event shows the command still running. This is the input for rebuilding the context of an interrupted attempt; nothing reads it for that yet.

The fixtures under `test/fixtures/providers/` are real output, sanitized only of local paths, session ids and account-level fields:

- `codex-complete.jsonl` and `codex-interrupted.jsonl` come from `codex exec` 0.156.0 pointed at a local Responses API stub that asks for two shell commands and then answers. The CLI, its event stream and its command execution are real; the model is not, so its `item.completed` warning about unknown model metadata is part of the fixture. The interrupted run was stopped with SIGTERM to its process group while `sleep 30` ran.
- `claude-stream.jsonl` and `claude-interrupted.jsonl` come from Claude Code 2.1.280 `-p` against the real model; the second was stopped with SIGTERM during a foreground command, whose result reads `Exit code 137`.

What changed with the format:

- Claude's result envelope is not the last line: a `task_summary` event follows it. The adapter takes the last `type: "result"` event instead of parsing stdout as one object.
- Codex no longer prints `tokens used` on stderr. Usage now comes from its `turn.completed` events, which count cached input inside `input_tokens`; the Factory records uncached input apart from cache reads and counts the total as input plus output. Codex totals recorded before this change came from the CLI's own `tokens used` figure and are not guaranteed to be the same measure.
- Codex's human-readable progress also left stderr, so the stderr tail in a failure diagnosis now holds only the CLI's own warnings and errors.
- The transcript carries tool output and can be much larger than the result. It is read once, in chunks, with no size limit on the file; a single line over 10 MB, or one cut off by a killed process, is skipped and counted.

Cursor was left on its single envelope in this change because its CLI could not be installed from this environment (cursor.com is not reachable). It moved to `--output-format stream-json` later, with the live progress monitor (`f09abf7`). **That Cursor format is still unverified:** no real Cursor stream has been captured. The adapter takes the last `type: "result"` event, and `execution-progress.ts` reads `tool_call` events by `call_id` and `subtype` (`started`/`completed`) with the tool named by the first key of `tool_call`; both follow the fakes in `test/adapters.test.ts`, not a recorded run. Until a stream from a real `cursor-agent -p --output-format stream-json` run is captured into `test/fixtures/providers/`, a Cursor role may run with progress that stays at zero tools, or fail on a result it cannot find.

## Token budget per issue — 2026-09-23

Each issue now has a token budget, 500,000 tokens by default, and the default limits changed with it: the agent timeout is 10 minutes, `FACTORY_MAX_FIX_CYCLES` means automatic Builder corrections and defaults to 1, and the verification command has its own 30-minute timeout. The values are the owner's tolerance, not a calibration: the only issue with published absolute figures, issue 6, had single Builder runs between 1.0M and 4.9M tokens, so the first issues are expected to pause at their first Builder run and be extended.

The budget spends the provider-reported `totalTokens` of every run. Since the providers now stream (see "Providers stream their events" above), that total means the same thing for Codex and Claude: uncached input, cache reads, cache writes and output. What streaming did not yet give was the usage of a Claude run cut before its result. The usage reducer now keeps the usage each assistant event states, one per API response id, and records it as `partial`: a lower bound the budget counts. A Codex run still reports usage only on `turn.completed`, so a cut Codex run, like every Cursor run, has no usage. Those are never counted as zero: the issue waits for an approver's `/factory budget +0` unless the role is listed in `FACTORY_BUDGET_UNMETERED_ROLES`.

Verified here:

- `test/fixtures/providers/claude-interrupted.jsonl`, the real run stopped with SIGTERM, now yields 10,093 partial tokens instead of unknown. It repeats one API response under the same message id, which is counted once.
- `npm test`: 431 tests, 431 passed. `dashboard serves readable state and queues daemon controls` had been failing on `main` since `a2d87a5` wherever no Codex CLI is installed, CI included: provider validation checks every selected role, the other roles stayed on Codex, and the test's `.env` named the real `codex` and `claude` commands instead of its fakes. Its `.env` now points at the fakes, and the test passes with neither CLI on `PATH`.
- The new `test/budget.test.ts` (12 tests) covers the hold before preparation, the overrun that keeps its result, insufficient and sufficient extensions, `+0` acknowledgement, answer/pause/retry not bypassing a hold, the Architect consultation chain, the Designer's pending prototype, warnings once per threshold and re-armed by an extension, continuation to another installation and back without double counting, the command parser and the dashboard action. With the runner's budget check disabled, three of them fail.
- `test/daemon.test.ts` runs the budget end to end: a cancelled Builder run without usage makes the retry wait, and an approver comment `/factory budget +0` resumes it to delivery.

Not verified against a live provider: the budget itself has not run on a real issue. The benchmark issue with Builder or Tester on Codex is the first check; compare `ai-factory activity` with the provider's usage page.

## Epics and stories — 2026-09-23

An issue can now be delivered as an epic: the Architect proposes 2 to 4 stories with the SPEC, the human approves them with the brief, each story becomes a GitHub sub-issue blocked by the stories it waits for, runs Builder and Tester on its own branch from the epic branch and merges into it, and the epic then goes through Test and Review once and opens the single pull request. Every work item records its base branch, and the epic and its stories share one token budget. Schema version 10; a fresh data directory is required.

Verified here:

- `npm test`: 438 tests, 438 passed.
- `test/results.test.ts`: a split of one, more than four, duplicate keys or titles, a criterion owned by two stories or unknown to the spec, a story without criteria, an unknown or self dependency and a cycle are rejected; delivery roles cannot introduce stories.
- `test/workflow-orchestrator.test.ts`: the full epic flow with two dependent stories against the GitHub fake (sub-issues with `parent_issue_id`, `blocked_by`, start only when the blocker is closed as completed, integration instead of Review, the epic resuming at Review and returning through Test, one pull request to `main`), an already existing sub-issue adopted instead of duplicated after a simulated crash, and a blocker closed as *not planned* that does not unblock.
- `test/workspaces.test.ts`: a story worktree created from a remote epic branch, its diff measured against the epic, sync that merges the epic and not `main`, and integration through one merge commit that is not repeated and that stops on a conflict with the worktree clean.
- `test/budget.test.ts`: consumption summed over the family and an extension granted on a story issue that lifts the hold for all.

Not verified: no live run against GitHub. The sub-issue and dependency calls follow the official OpenAPI description (`POST /repos/{o}/{r}/issues` with `parent_issue_id`, `GET …/sub_issues`, `GET|POST …/dependencies/blocked_by`), but they have not been exercised on a real repository, nor has an epic run end to end with real providers. Known limits: a story continued on another installation loses its epic link and would go to Review instead of integrating, so stories must finish on the epic's installation; cancelling the epic leaves its unstarted story issues open; the Designer prototype leaves each story branch when that story's Builder starts and is not copied to the epic worktree for the Reviewer.

## A complete prototype rejected over its own file list — 2026-09-23

On `factory-demo#18` the Designer wrote a complete prototype (four pages, CSS, a README and seven screenshots, all under `.factory/prototype/`, preserved on the branch as a work-in-progress commit), but its reported `changedFiles` contained an entry the validator compared literally and rejected. The automatic retry repeated the same list, and Design failed after 1,395,692 tokens: 184,797 from an Architect run discarded by a configuration apply, 351,489 for the specification, 762,951 for the prototype and 96,455 for the retry that only re-reported it.

The Designer is now judged by what is on disk: the report is normalized first (a leading `./`, an absolute worktree path and the directory itself no longer reject it), and after the run the runner replaces `changedFiles` with the files under `.factory/prototype/`, rejects a PASS with no screenshot there, and records a `designer.files_reconciled` event when report and disk differ. The worktree check still blocks any write outside the prototype. The status comment also names the Designer while it works and a person once an item has failed. Verified by `npm test` (459 passed); not yet verified on a live retry.

## Batching Designer and Tester work to cut turns — 2026-09-23

The Designer's 762,951 tokens on `factory-demo#18` (see above) came mostly from taking seven screenshots one state at a time — navigate, screenshot, look, repeat — where every one of those turns re-reads the whole accumulated prompt. The Designer and Tester contracts now ask for the mechanical part of the work in one pass: the Designer plans every screenshot before taking the first one and captures all of them with a single Playwright script run once, never re-opening a screenshot to check it; the Tester runs its whole kept test selection as one command or script instead of one call per candidate, and the same batching applies to any evidence screenshot it takes. Both also drop states or diagnostic exploration the brief and acceptance criteria give no reason to need.

`ai-factory metrics` now reports `turnsByRole`: runs, measured runs, total and average turns per role, read from the `turns` field `execution.finished` already recorded. This is the number to compare before and after the contract change, since tokens alone can look similar between a many-turn and a few-turn run of comparable size. Verified by `test/epic-metrics.test.ts` (a run with no reported turns still counts toward `runs`, never toward `avgTurns`) and `npm test` (459 passed). Not yet verified: no live Designer or Tester run has been measured against this contract; `avgTurns` before and after needs a comparable retry to mean anything.

## Trimming the Designer's context to the brief — 2026-09-24

The Designer prototypes UI from the human-approved decisions and the acceptance criteria; it never touches the full technical SPEC (Given/When/Then detail, backend rationale, tactical decisions aimed at the Builder). Before this change it received the whole stored specification body — brief and full spec concatenated — and re-read all of it on every turn of a run already paying for every screenshot in one pass (see batching, above). `ContextAssembler` now cuts the specification section at the brief/spec separator for the Designer role only; every other role is unaffected. Verified by `test/context-assembly.test.ts` (the Designer's markdown contains the brief's decisions and not the spec's Given/When/Then; the Builder's still contains both) and `npm test`. Not yet verified: no live Designer run has been measured with the trimmed context; the token/turn delta on a real issue is unmeasured.

## A quick brief before the specification and the prototype — 2026-09-24

The Architect used to write the brief, the full SPEC, the acceptance criteria and the stories in one run, and on `factory-demo#19` the Designer then prototyped that proposal before the human had approved a single decision. A changed decision would have discarded all of it: 436,436 tokens of Architect run plus a prototype, which cost 762,951 tokens on `#18`. Design is now two Architect runs around one quick validation. The first returns `outcome: "brief"` (decisions, solution, scope, assumptions, a proposed split, assessment; no criteria, no SPEC) and opens `brief-approval`. `/factory approve vN` records the approval on that version and opens an Architect-owned `specification` request; the second run returns `outcome: "spec"` under it, with brief `""` and taskAssessment `null` (it keeps the approved one), and fills in the body, criteria and stories of the same version. Nobody reads the SPEC, so it is not approved again: without significant UX impact the Builder starts (or the epic waits for its stories); with it, the Designer prototypes the written SPEC and the human approves the prototype (`spec-approval`). A spec returned without an approved brief is rejected as an invalid result, and feedback on a brief or a prototype asks for a new brief. Consultations stay limited to `tactical-decision` requests, so the spec pass gets no tactical return route.

Cost of the choice: the Architect now explores the repository twice, once lightly for the brief and once for the SPEC, and a significant UX change has two human gates instead of one. It pays when the human changes a decision the brief put to them; the brief contract asks for a light first pass to keep the common case cheap.

Verified by `npx tsc --noEmit` and `npm test` (466 passed), including `test/workflow-results.test.ts` (brief, approval, spec and the UX, split and rejection branches), `test/workflow-runner.test.ts` (both gates with the Designer), `test/workflow-orchestrator.test.ts` (end to end through GitHub polling, and an epic whose sub-issues are created on the poll after the spec) and the daemon integration test with a provider that answers each pass. An item already waiting on the old single-pass flow, like `#19` waiting for its prototype, finishes on it: its prototype is approved through `spec-approval` and delivery starts (`test/workflow-results.test.ts`). Not yet verified: no live run with a real provider against the two-pass contract, and no measurement of what the extra Architect run costs against what a changed decision saves.

## The spec pass continues the brief's session, and each pass is measured apart — 2026-09-24

Splitting Design into a brief and a spec made the Architect explore the repository twice. The spec run now continues the provider session of the run that wrote the approved brief, when the provider can and the provider and model are unchanged: the brief run drops `--no-session-persistence` (Claude) or `--ephemeral` (Codex), the session id is read from the stream (`session_id` on Claude events, `thread.started.thread_id` on Codex) into `execution.finished`, and the spec run uses `claude -p --resume <id>`, `codex exec … --sandbox read-only … resume <id> -` or `cursor-agent -p --resume <id>`. In Codex `--sandbox` is an `exec` option that is not global, so it must come before `resume`: after it the parser rejects it, and the `-c sandbox_mode=` alternative is the legacy syntax the Codex source says `--sandbox` overrides. Only a brief run that kept its session (`sessionPersisted` on its `model.selected` event) is resumed, so a brief written before this change, whose Claude stream still carried a session id, is not. A resumed run receives a short continuation note plus the current context sections instead of the whole contract, which is already in the session; `architect.session_resumed` records it. A resumed run that fails records `architect.session_unavailable`, marks that session unusable and retries once fresh with the full contract. If the stream shows no usage and no model event, the provider refused the resume before spending anything, and the run is recorded at zero tokens so the fresh retry is not held for a budget acknowledgement; a failed resume that reached the model stays unmeasured and waits like any other. Cursor keeps its chats by default and is resumed with `--resume <id>` from its documentation; its binary could not be downloaded here, so if the flag or the `session_id` on its stream events turns out different, the first resume fails before reaching the model, costs nothing and the retry runs fresh.

`ai-factory metrics` reports `architectPasses`: runs, turns, tokens and unmeasured runs per Architect outcome, and how many spec runs resumed.

The Claude flags were checked against `claude --help` (2.1.281). The Codex ones were checked against the source at tag `rust-v0.156.1` (`codex-rs/exec/src/cli.rs`: `--sandbox` not global, `--json`, `--output-schema` and `-o` global; `lib.rs`: a resumed thread takes its sandbox from the current configuration; `exec_events.rs`: `thread.started` carries `thread_id`) and against the 0.156.1 binary's parser with the adapter's exact argument order; the official page on developers.openai.com was not reachable from this environment. Cursor's were not checked against its binary or its documentation site, both unreachable here. Verified by `npx tsc --noEmit` and `npm test` (469 passed): `test/adapters.test.ts` (persist, resume and default arguments for both providers, and the session id captured from each stream), `test/workflow-runner.test.ts` (the spec pass resumes with the short continuation; a refused resume costs nothing and retries fresh; a resume that reached the model waits for acknowledgement; Cursor never persists or resumes) and `test/epic-metrics.test.ts`. Not yet verified: no live resume against a real provider, so whether a resumed spec run actually spends fewer turns and tokens than a fresh one is exactly what `architectPasses` must show on the next real issues. Session files are left for each provider's own retention; Codex keeps them until removed.

## Remaining operational validation

The happy-path issue-to-PR acceptance flow has completed with real providers and explicit human approval. Human merge was explicitly performed by the user and then observed by the orchestrator. Real Slack delivery is not configured; its retry/HTTP behavior is tested locally. Complex-task Sonnet-to-Opus escalation and Sol routing remain covered by deterministic tests, not by this low-risk live demo. GitHub Actions is optional and remains inactive because of workflow scope. Environment filtering/worktrees are not a complete OS isolation boundary; use trusted repositories.

## Issue presentation follow-up

The demo issue’s four generated spec/report comments were reformatted as Markdown, preserving the approved spec body and the human approval comment. Original comments were backed up locally; raw SQLite/outbox/agent evidence was preserved. A green ready-to-merge label and a single milestone/status comment now make the final stage visible. No agent execution or merge was triggered by this presentation update.

## Live merge reconciliation

After the user merged demo PR #2, `factory sync` confirmed GitHub MERGED at `2026-09-18T16:55:38Z`, commit `81ee5d2094efa4795994b107925abbe915c93671`. SQLite now records MERGED; the issue is CLOSED with `factory:merged`, and its progress comment says completed. No agents were invoked and no merge was performed by the factory. The factory implementation PR #1 remains open.

## Completed V4 clean-install acceptance — 2026-09-19

A new private repository was created and exercised with the clean schema V4 runtime and real GitHub, Claude and Codex credentials: [issue #1](https://github.com/lucaslodeiro/ai-factory-v4-acceptance/issues/1) and [PR #2](https://github.com/lucaslodeiro/ai-factory-v4-acceptance/pull/2). Slack had no webhook configured in this checkout, so real channel delivery was unavailable; durable retry and real HTTP transport remain covered by the automated local-server tests.

- Doctor passed for GitHub, Claude, Codex, Git, the target checkout, SQLite and workflow invariants.
- The issue started through a standalone `/factory start` comment. Claude Architect's first placeholder result was rejected as invalid; a human-guided `/factory retry` produced SPEC v1, which was approved through `/factory approve v1`.
- Build was deliberately interrupted with SIGINT. The execution was recorded as interrupted, the workflow moved to Build/Paused and the worktree and guidance were preserved. The live run exposed a stale signal-maintenance barrier; the runtime now completes signal maintenance and reconciles barriers left by an older daemon before scheduling.
- Builder and Tester ran with Codex; Reviewer ran read-only with Claude. Specs and all three delivery reports were published as rich, idempotent GitHub comments, each with a clear next action.
- The generated application passed 6/6 independent Node tests. The factory published PR #2 with `Closes #1`; squash merge `86201f9084099ffd5b71055d23451bdfd76fc017` closed the issue and the daemon recorded Delivery/Completed.
- The final workflow revision is 18. Its audit includes the rejected result, human retry guidance, approved spec, planned interruption, recovery, four successful role results, PR URL, merge time/commit and per-execution token totals where reported by each provider.

The live run also verified that the V4 runtime can publish results generated before a daemon restart without duplicating comments, and that a manually stopped daemon does not leave a scheduler barrier on its next start.

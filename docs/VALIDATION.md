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

This is a hypothesis, not a finding: nothing yet shows that a Builder with a map spends fewer turns than one without. The measurement is set up rather than assumed. The map goes to the Builder alone, so on the next issue the `activity` histogram on `execution.finished` compares the Builder against the Tester, which runs the same work without a map. If the Builder's event count does not fall relative to the Tester's, the map is costing bytes for nothing and should be removed.

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

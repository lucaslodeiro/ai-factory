# Product audit round 1 review

## Decisions

Validated the findings against local `main` at `0e8098f`, before changing each area. All ten items are accepted, with the qualifications below. Work is on `codex/audit-round-1` in an isolated local clone; the installed engine was not modified.

- **FAC-01 — agree.** `results.ts` validates reported integers, and `WorkflowRunner.run` previously applied QA results without independently executing verification. Agents can execute tests, but those declarations were not independently checked by the factory.
- **FAC-06 — agree.** `CodexAdapter.run` passed `workspace-write` and network access for every role, while the Architect and Reviewer contracts forbid writes.
- **FAC-05 — agree.** `resultMarkdown` interpolated agent strings unchanged. `readIssueState` finds the first comment containing the status marker. Hidden continuation payloads and status summaries also contained agent text and needed the same protection.
- **FAC-02 — agree.** `render` rebuilt the list on each snapshot, and open threads were loaded with `force=true`. That destroyed composers.
- **FAC-08 — agree.** The control endpoint gated only issue synchronization/intake controls on daemon availability. Queue and message controls remained accepted while stopped.
- **FAC-09 — agree.** The queue followed administration sections, the API reversed creation order, and conversations were initially closed regardless of attention state.
- **FAC-07 — agree.** The parser has no `start` verb; per-issue instance labels support multiple installations; no installer implementation reads `AI_FACTORY_INSTALL_TESTS`; updating already manages services; storage uses schema 7; configuration loads from factory home; all role model defaults are `auto`.
- **FAC-12 — agree.** Every computed profile returned the same configured model. No caller enabled `architecturalReview`, so the documented additional review was not implemented.
- **FAC-11/FAC-18 — agree.** An empty/missing checkout resolved to factory home, service readiness required only two settings, and doctor hard-coded `gh`.
- **FAC-04 — agree.** PR bodies repeated the complete specification and omitted Tester evidence; commits described only the role and issue number.

## Changes

### 1. FAC-01 — factory verification

- Commit: `816556d` (`audit: The factory runs a verification command itself`).
- Files: `.env.example`, `src/config.ts`, `src/dashboard-settings.ts`, `src/verification.ts`, `src/workflow-runner.ts`, `test/workflow-runner.test.ts`.
- Added the optional, operator-controlled `FACTORY_VERIFY_COMMAND`, documented beside correction cycles. It runs asynchronously through `sh -c` in the worktree after Tester commit/publication, using the existing execution timeout. The process group is terminated on timeout; its exit code is `null`. Combined output is bounded to its final 4,000 characters.
- The runner records sanitized `verification.completed` evidence on the work item and execution, saves head/command/exit code in context, and converts only a failed Tester `pass` into `changes` with one `auto-fix` finding. Existing `changes`/`decision` outcomes and the correction limit remain intact.
- Tests: `factory verification exit 3 controls the Tester pass path`; `factory verification exit 0 controls the Tester pass path`; `factory verification bounds combined output and times out asynchronously`.
- Left out: new stages, reason codes, timeout settings and schema changes. Empty configuration does not execute verification. The PR wording is handled in item 10.

### 2. FAC-06 — role-specific Codex sandbox

- Commit: `581eeca` (`audit: Codex read-only roles run read-only`).
- Files: `src/adapters/codex.ts`, `test/adapters.test.ts`, `test/adapters-config.test.ts`.
- Architect and Reviewer use `read-only`; Builder and Tester retain `workspace-write` with network enabled. Updated the adapter-suite count asserted by the configuration-isolation tests.
- Test: `Codex sandbox follows each role's write contract`, covering all four roles.
- Left out: the worker instructions already state that Architect and Reviewer are read-only and contain no sandbox sentence to correct.

### 3. FAC-05 — safe publication of agent text

- Commit: `8602b96` (`audit: Agent text is sanitized and cannot forge factory markers`).
- Files: `src/workflow-github.ts`, `src/workflow-status.ts`, `src/failure-report.ts`, `test/workflow-github.test.ts`.
- Added `publishedText`, using the existing sanitizer with a 60,000-character limit and inserting a zero-width space into HTML comment openers. Applied it to agent report fields, machine-readable result/specification payloads, agent record payloads, latest summaries, findings, failure evidence and transition summaries. Factory marker generation remains unchanged.
- Test: `published agent text cannot leak tokens or forge workflow markers`, covering rendering, real-state selection and milestone/status publication.
- Left out: author filtering and status-comment restructuring; neither is needed to address this finding. The existing sanitizer's formatting and redaction behavior is reused.

### 4. FAC-02 — preserve dashboard composers

- Commit: `e89d868` (`audit: Stop rebuilding the issue list every two seconds`).
- Files: `dashboard/app.js`, `dashboard/index.html`, `test/dashboard-snapshot-consistency.test.ts`.
- Skip list replacement for unchanged item/remote fingerprints. A focused or nonempty composer pauses list updates and displays the muted writing note; other snapshot sections still render. Thread caches are invalidated only when the relevant revision changes. An in-flight thread response cannot overwrite a draft. Successfully queued messages clear their submitted text so it does not keep the list paused indefinitely.
- Test: `snapshot preserves a composer draft and skips unchanged issue lists`, asserting retained textarea identity/value, focused empty drafts, unchanged renders and resumed updates.
- Left out: diffing libraries and per-node reconciliation. Tests extend the existing VM/DOM fixtures without new infrastructure.

### 5. FAC-08 — stopped-daemon controls

- Commit: `2987daa` (`audit: Controls are refused while the daemon is stopped`).
- Files: `src/dashboard.ts`, `dashboard/app.js`, `dashboard/index.html`, `test/dashboard.test.ts`, `test/dashboard-snapshot-consistency.test.ts`.
- Every known control except `stop` now receives 409 while stopped, with `Start the daemon before sending controls.` This check precedes target validation. The persistent queue banner and disabled control/composer buttons track daemon availability, including remote-list refreshes; restarting restores prior button eligibility.
- Tests: `dashboard serves readable state and queues daemon controls` now covers stopped `retry`; `stopped daemon banner and controls recover without destroying a draft` covers UI availability restoration, including buttons already disabled for other reasons.
- Left out: service-control redesign. Existing action-validation tests now explicitly establish a running daemon fixture.

### 6. FAC-09 — attention first

- Commit: `504a57b` (`audit: What needs the human is at the top`).
- Files: `src/dashboard.ts`, `dashboard/app.js`, `dashboard/index.html`, `test/dashboard.test.ts`.
- Moved the queue immediately after metrics. API order is WAITING, FAILED, PAUSED, RUNNING, QUEUED, then terminal states, newest update first within each group. WAITING/FAILED conversations open on their first render; subsequent renders preserve the user's open/closed choice.
- Test: the mixed-status ordering case in `dashboard serves readable state and queues daemon controls`, including two WAITING rows and mixed terminal states.
- Left out: new sections, KPI filters and composer redesign.

### 7. FAC-07 — documentation and command help

- Commit: `c19fc61` (`audit: Documentation and help match the code`).
- Files: `src/factory-help.ts`, `ARCHITECTURE.md`, `INSTALL.md`, `docs/CONTEXT_AND_WORKFLOW_DESIGN.md`, `docs/MODEL_POLICY.md`, `test/factory-command.test.ts`.
- Corrected all seven requested topics. Start-work help now describes assignment or Add Issue. Also corrected adjacent stale schema-5/schema-3 references in the same schema documentation so it consistently says 7.
- Test: `every documented factory verb is accepted by the parser`, using minimal valid arguments.
- Left out: installer behavior changes and historical review reports.

### 8. FAC-12 — remove decorative profiles

- Commit: `aa7442c` (`audit: Remove the decorative model profile`).
- Files: `src/types.ts`, `src/model-policy.ts`, `src/prompts.ts`, `src/dashboard.ts`, `ARCHITECTURE.md`, `docs/MODEL_POLICY.md`, `test/model-policy.test.ts`, `test/prompts.test.ts`, `test/dashboard.test.ts`.
- Removed `ModelProfile`, `ModelSelection.profile`, profile computation, dashboard profile output, the unused architectural-review option and its promised safeguard. Selection keeps policy/provider/model and a reason naming configured routing. Assessment remains part of specification approval. Existing call signatures remain compatible; assessment/cycle arguments no longer imply routing effects.
- Tests: `configured routing is unchanged by assessment, corrections or consultations`; `policy uses each role's configured provider and model IDs`; `architect receives an explicit, machine-aligned tactical return route` also excludes the removed review sentence.
- Left out: implementing automatic escalation or an additional review stage.

### 9. FAC-11/FAC-18 — fail early on required configuration

- Commit: `a0b75bc` (`audit: Required configuration fails early`).
- Files: `src/config.ts`, `src/daemon.ts`, `src/repository-setup.ts`, `src/worktrees.ts`, `src/repository-maintenance.ts`, `src/doctor.ts`, `scripts/services.sh`, `test/home.test.ts`, `test/services.test.ts`, `test/repository-identity.test.ts`.
- Missing/blank checkout configuration becomes `undefined`. Daemon startup, repository preparation and checkout-dependent operations refuse it with `FACTORY_REPO_DIR is required`; configuration loading and doctor remain available. Service readiness requires repository, approvers and a nonblank checkout. Doctor uses `GH_COMMAND`.
- Tests: `empty checkout allows configuration loading but daemon startup fails early`; `doctor uses GH_COMMAND and remains callable without a checkout`; `service launcher installs and controls daemon and dashboard independently` now rejects missing checkout configuration. Updated the repository-identity test to supply the newly required path so it reaches its intended identity check.
- Left out: settings-form validation and GitHub permission checks. No migration or schema bump was necessary.

### 10. FAC-04 — delivery evidence and meaningful commits

- Commit: `5ed84c9` (`audit: The PR body says what was delivered and commits say what they did`).
- Files: `src/workflow-runner.ts`, `src/workflow-github.ts`, `test/workflow-runner.test.ts`.
- PR bodies contain issue closure, specification version/approver, Reviewer summary, factory verification, the existing Tester report without its top heading/next-action section, and deferred findings. The full specification is omitted. Context stores a factory spec marker, not a GitHub comment URL/id, so the requested “Specification vN is in the issue” fallback is used.
- Builder/Tester commits use the first trimmed summary line, limited to 72 characters, with the short role and issue number. Empty summaries keep the old fallback; WIP commits are unchanged.
- Test: `delivery body summarizes tests and verification while commits describe the change`, covering configured and unconfigured verification, test/coverage/file/deferred evidence, specification omission and role-specific messages.
- Left out: duplicating the renderer or changing publication stages. A configured command without matching stored head/command evidence is explicitly reported as having no recorded result, rather than falsely attesting verification.

## Verification

- Final `PATH=/Users/lucaslodeiro/.local/bin:$PATH npm test`: **258 tests, 258 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo**.
- Final `PATH=/Users/lucaslodeiro/.local/bin:$PATH npm run build`: **passed**, TypeScript compilation and asset copy both completed, with no compiler diagnostics.
- `git diff --check`: passed before this report; checked again when committing it.
- Both required commands completed successfully before the report commit.
- Disclosed earlier failures: initial runtime attempts used incompatible local Node/native-module combinations; tests were then run with the installation's Node 22 ARM64 runtime. Sandboxed HTTP tests failed with loopback `EPERM` and passed with local-listener access. An intermediate build caught missing type annotations in the new publisher fixture, which were corrected. The first complete compatible full-suite run had **256 tests, 255 passed, 1 failed** because the repository-identity fixture lacked the now-required checkout; that fixture was corrected. Two additional focused regressions cover verification timeout/output and stopped-daemon button restoration, yielding the final 258 tests.
- Targeted renderer, runner, adapter, configuration, service and HTTP tests were also run during implementation. No new test framework was introduced.

## Limitations and scope

- **FAC-10 bonus omitted.** A durable `decisionCycles` counter beside `correctionCycles` would require schema/projection persistence, reset behavior and published-state continuation changes, in addition to the decision routing branch. That exceeds the requested counter-and-comparison/five-line scope. The existing decision loop remains unchanged.
- Factory verification is opt-in and uses only the operator's configured shell command; no real provider acceptance run or project deployment was performed.
- The existing cross-installation state whitelist does not transfer the new local verification context; continued deliveries with a configured command and no matching attestation explicitly report missing evidence.
- Out-of-scope observation: `scripts/install-macos.sh` still advertises the ineffective `AI_FACTORY_INSTALL_TESTS` variable in its own help text; only the requested installation documentation was corrected.
- No schema migration, new stage/status/reason code, token/money budget, status-comment redesign, subprocess cache or `commit --all` behavior change was made. The optional script-test chain was not run.
- The initial audit ended with ten item commits plus this report commit and no push, merge, tag or pull request. A subsequent user instruction authorized publishing to develop and main (see below).

## Follow-up: publish to develop and main

- Both remote branches had advanced to `a4af20f`, including `797683d` and its Design-blocker/conversation improvements. Integrated those changes while retaining the audit's publication sanitization, composer protection, daemon availability controls and initial conversation expansion.
- Integration validation: `npm test` **265 tests, 265 passed, 0 failed, 0 cancelled, 0 skipped**; `npm run build` **passed**. An initial run had 264 passes and one failure because the upstream conversation fixture lacked the new availability helper; adapted that fixture and asserted draft preservation on another render.
- GitHub rejected the first atomic push because both branches require linear history. Neither branch changed. Rebased the eleven audit commits onto `a4af20f` without a merge commit or force push. Verified the rebased tree was identical to the fully tested integration before updating this report; no executable code changed after validation. Commit references above now identify the rebased commits.
- A concurrent remote update then advanced both branches to `f35cb7c` (recoverable configuration loading). Rebased onto it without conflicts and reran validation: **267 tests passed, 0 failed, 0 skipped**; **build passed**. The linear publication includes this upstream change as well.

## Addendum: preserve published code blocks

Confirmed the publication regression on `749318d`: failure-evidence sanitization rewrote code fences, local paths and whitespace in both displayed specifications and continuation payloads. Extracted the existing secret replacements into `redactSecrets`; `publishedText` now only redacts secrets and neutralizes HTML comment openers, without altering fences, paths, whitespace or length. `sanitizeFailureEvidence` retains its previous operations and ordering, and existing failure/status callers remain unchanged. Factory verification failures now append their `auto-fix` finding while retaining the Tester's findings, including `defer`. The new test `published specifications preserve code fences, paths and whitespace through continuation` checks exact specification preservation through rendering, actual publication and `readIssueState`, plus absence of truncation; the existing verification-failure test now checks both retained `defer` and appended `auto-fix`, while token/marker assertions still pass. Validation: `npm test` **268 tests, 268 passed, 0 failed, 0 skipped**; `npm run build` **passed**; `git diff --check` **passed**. This correction and addendum are one commit; the subsequent user instruction authorizes publishing it to develop and main.

## Addendum: FAC-03 — Builder correction context

Confirmed on `15c4e59` that Builder received a changed-file summary only when `attempt > 1`, omitting it during automatic correction cycles. Changed only the `retrySummary` condition to include `projection.correctionCycles > 0`; the existing context assembly plumbing is unchanged. The regression `Builder receives its changed files only when returning for automatic correction` drives Architect → approval → Builder pass → Tester changes → Builder, verifies that the attempt stays at its actual initial value of 0 while the correction count becomes 1, and asserts that only the second Builder prompt contains `src/a.ts` and `1 file changed`; it failed for missing file context before the fix and passes afterward. Preserved the concurrent upstream dashboard commit `7fff949` by fast-forward before final validation. `npm test`: **270 tests, 270 passed, 0 failed, 0 skipped**; `npm run build`: **passed**; `git diff --check`: **passed**. This one-line runtime fix, its test and this addendum form one commit; the subsequent user instruction authorizes publishing it to develop and main. Develop accepted that commit; a concurrent main-only change (`4f2b6a6`) required applying the same correction separately on main, preserving its history. Validation on the updated main: **271 tests passed, 0 failed, 0 skipped**; **build passed**.

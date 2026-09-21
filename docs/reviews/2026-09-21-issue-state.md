# Issue state review — 2026-09-21

## Decisions

- **F3.1 — agree.** Durable facts belong in the Factory comments that introduce them. One escaped, schema-versioned hidden payload preserves a readable issue while making those facts machine-readable.
- **F3.2 — agree.** The mutable status comment should carry a bounded index of current state, references and safe context, without local paths or execution references.
- **F3.3 — agree.** Continuation must validate the complete issue-carried state and every referenced specification before changing local storage, then adopt it atomically under the original workflow id.
- **F3.4 — agree.** Stable states can continue automatically. A remotely `RUNNING` or `QUEUED` state must wait for an explicit operator action because its source installation may still be active.
- **F3.5 — agree.** Operators need the source instance and revision in the issue and dashboard, a deliberate **Continue anyway** control, and a read-only CLI view of the published index.
- **F3.6 — agree.** Documentation must describe the issue as the durable coordination surface and clearly separate published workflow facts from local prompts, logs, credentials and process state.

## Changes

### F3.1 — parseable Factory comments

Commit `1394cb2` (`feat: F3.1 publish parseable workflow comments`).

- `src/workflow-github.ts`: added `withPayload` and `payloadOf`; escaped `--` inside JSON; attached specification facts to specification milestones and result facts to other published milestones.
- `src/adapters/github.ts`: made milestone publication return the stable GitHub comment id.
- `test/workflow-github.test.ts`: verifies an embedded `-->` round-trips and a specification payload matches the stored specification, criteria and assessment.

### F3.2 — bounded state index

Commit `87ddd62` (`feat: F3.2 publish issue state index`).

- `src/workflow-state.ts`: added the exact state-index schema, strict validation and local index construction.
- `src/workflow-github.ts`: publishes the index with the status comment, enforces the 60,000-character bound and records `github.state_too_large` once when it cannot include it.
- `src/workflow-inbox.ts`: stores the stable GitHub issue node id needed for identity validation.
- Workflow fixtures now use complete repository and issue identity.
- `test/workflow-github.test.ts`: asserts index equality, safe context, absence of unknown/local keys and the oversized-index fallback.

### F3.3 — validated continuation state

Commit `f5a5395` (`feat: F3.3 continue from published issue state`).

- `src/workflow-github.ts`: added `readIssueState`, which resolves every specification marker and refuses an incomplete read.
- `src/workflow-state.ts`: added transactional `adoptIssueState`, preserving workflow identity, specifications, approvals, active/open records, active failure and safe context while clearing local-only execution state.
- `src/workflow-projection.ts`: exposes current-projection validation for the adopted state.
- `test/workflow-state.test.ts`: verifies complete continuation, identity refusal, request freshness, safe context, active-work pausing and missing-specification refusal.

### F3.4 — orchestration across installations

Commit `3247425` (`feat: F3.4 continue work from published issue state`).

- `src/workflow-orchestrator.ts`: reads foreign issue state, automatically continues stable states, reports active remote state as `issue.continuation_waiting`, supports explicit continuation and re-adopts a newer published revision when ownership returns.
- `test/assignment-ownership.test.ts`: verifies automatic stable continuation, source/revision preservation, normal resume on the next poll, waiting for remotely active work and explicit continuation into `PAUSED`.

### F3.5 — dashboard and CLI controls

Commit `5657758` (`feat: F3.5 expose issue continuation controls`).

- `src/daemon.ts` and `src/dashboard.ts`: route `continue-issue` through the normal durable control queue and expose continuation metadata.
- `dashboard/app.js`: renders source instance/revision, continuation-waiting state and **Continue anyway**.
- `src/cli.ts`: added `ai-factory issue show <number>` for the validated published index and specification approval summaries.
- `src/workflow-status.ts`: adds the continuity row to the GitHub status comment.
- `test/dashboard.test.ts`, `test/dashboard-snapshot-consistency.test.ts` and `test/workflow-github.test.ts`: cover control acceptance, rendered UI and status provenance.

### F3.6 — operator documentation

Commit `19b39fc` (`docs: F3.6 document issue-native workflow continuity`).

- `README.md`, `INSTALL.md` and `docs/GITHUB_SETUP.md`: describe facts carried by the issue, stable automatic continuation, the active-source safety gate, the dashboard action and the CLI inspection command.
- `docs/CONTEXT_AND_WORKFLOW_DESIGN.md` §7.2, §8.2, §8.3 and §8.5: define continuation transitions, state-index contents and exclusions, milestone facts, escaping, size behavior and complete-read requirements.

## Verification

- `PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" node --import tsx --test test/assignment-ownership.test.ts test/workflow-state.test.ts test/workflow-github.test.ts test/dashboard-snapshot-consistency.test.ts` — **20 passed, 0 failed**.
- First sandboxed `npm test` attempt — **227 passed, 5 failed** because the sandbox refused loopback listeners with `listen EPERM: operation not permitted 127.0.0.1`. The failures were browser, dashboard and Slack HTTP tests that require local ports; this was an execution-environment restriction, not a product assertion failure.
- `PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" npm test` outside that restriction — **233 passed, 0 failed**.
- `PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" rm -rf dist && PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" npm run test:all` on macOS — **233 passed, 0 failed**, followed by successful installer, maintenance, uninstall, configure, dashboard-config and installation-validation suites. Reported passes include dashboard port fallback, preserved install/update state, uninstall modes, configuration validation and incompatible-schema refusal.
- `PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" npm run build` — completed successfully.
- `git diff --check` — clean.

During F3.2, the first full run exposed one incomplete assignment fixture with no repository identity (**227 passed, 1 failed**). The fixture was corrected to satisfy the same identity invariant as production; the following run passed **228/228** at that point in the series.

## Limitations

- When the validated state index would exceed 60,000 characters, the visible status still publishes but another installation cannot continue from that revision. The `github.state_too_large` event makes the condition diagnosable; facts are not split or partially accepted.
- **Continue anyway** intentionally does not prove that the source machine is dead. It is an explicit operator override for a published `RUNNING` or `QUEUED` state and always begins locally as `PAUSED`.

## Open questions

None.

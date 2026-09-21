# Workflow chat review — 2026-09-21

## Decisions recorded before implementation

- **F4.1 — agree.** Dashboard workflow controls currently call `WorkflowCommands.apply` with the literal login `dashboard`; the snapshot exposes no authenticated operator and the control endpoint has no approver authorization gate.
- **F4.2 — agree.** Prompts, manifests, results, transitions, execution outcomes and command events already exist, but there is no ordered per-item thread endpoint. The existing prompt endpoint requires POST acknowledgement, rejects large prompts instead of returning a bounded response, and does not expose availability through a thread.
- **F4.3 — agree.** `/api/control` only queues fixed button controls. There is no state-derived free-text action surface, GitHub-first publication, or real comment-id application path.
- **F4.4 — agree.** Running work can be paused, but there is no atomic interrupt/preserve/retry-with-guidance operation. `ContextAssembler` has no `previousAttempt` input, so a replacement execution cannot see the interrupted attempt summary.
- **F4.5 — agree.** The issue detail has action buttons and execution history but no workflow conversation, composer, state-specific message actions or read-only operator presentation.
- **F4.6 — agree.** Current documentation does not describe the dashboard workflow chat, authenticated operator attribution, GitHub-first audit comments, or the previous-attempt context.

## Changes

### F4.1 — Operator identity (`d1b63d9`)

**Agree.** `src/workflow-controls.ts` now resolves the operator from `runtime:factory-account`, verifies it against `FACTORY_APPROVERS`, and records that login as the transition actor. `src/dashboard.ts` exposes `{login, approver}` in the snapshot and returns HTTP 403 before queueing state-changing controls for an unauthorized login. `test/workflow-controls.test.ts` verifies the real actor and the fail-closed path; `test/dashboard.test.ts` verifies the exposed identity and authorization response.

### F4.2 — Workflow thread (`d32204b`)

**Agree.** New `src/workflow-chat.ts` builds an ordered thread from existing events and records. Prompt turns expose a bounded, path-free manifest and availability; result turns reuse `resultMarkdown`; event turns carry transition and failure evidence; human turns resolve command records and source. `src/dashboard.ts` adds the issue thread route and a 512 KiB prompt route that reports pruning. `test/workflow-chat.test.ts` verifies ordering, all structured fields, path exclusion, pruning and truncation.

### F4.3 — Sending a message (`9bf1aed`)

**Agree.** `messageActions` is a pure state/request action table. Dashboard controls store a bounded message envelope and validate authorization plus the current action before queueing. The daemon validates again, publishes an idempotent command-form GitHub comment first, applies it through `WorkflowCommands` with the returned comment id and authenticated login, marks created records as dashboard-originated, and appends a rejection to the published comment when application fails. `GitHubAdapter.editComment` is available through the background worker. Specification feedback through `answer` now returns Design to the Architect. Tests cover the complete action table, answer/approve/retry/note application, operator attribution, marker preservation, stale approval editing and refusal before publication.

### F4.4 — Interrupt and retry with guidance (`491f4be`)

**Agree.** A running message action publishes its retry comment, transitions to `PAUSED`, interrupts and waits for the active execution, preserves and pushes partial work, then applies retry. `WorkflowRunner` records the starting HEAD and builds a `previousAttempt` object with interruption metadata, diff stat, files, prior result and guidance record. `ContextAssembler` includes it as an optional section; Builder also receives changed files on later attempts. The focused test verifies interruption, preservation/publication, attempt increment, unchanged correction cycles, dashboard guidance and the next prompt content.

### F4.5 — Dashboard (`18e4d5a`)

**Agree.** `dashboard/app.js` adds a live issue conversation with collapsed prompt cards, on-demand prompt reveal, rendered results, compact events, highlighted human turns and a state-derived composer. Unauthorized operators see a read-only explanation and disabled controls. Pending and rejected message controls flow through the existing snapshot/SSE acknowledgement. `dashboard/styles.css` adds responsive thread presentation. `test/dashboard.test.ts` verifies the four renderers and action labels in the shipped client, spec-approval actions from the endpoint, the non-approver 403 before queueing, and surfaced rejection evidence.

### F4.6 — Documentation (`3ce8fd6`)

**Agree.** `README.md` and `INSTALL.md` describe the thread, authenticated operator, read-only mode and GitHub-first audit trail. `docs/CONTEXT_AND_WORKFLOW_DESIGN.md` §6 documents Previous attempt and retried Builder changed files, §7.2 adds `interrupted-for-guidance`, and §8.2 documents thread construction, action derivation, publication order and rejection handling.

## Verification

- `PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" npm test`
  - Baseline before F4.3: **244 tests, 244 passed, 0 failed**.
  - After F4.4 and final F4.5/F4.6 runs: **245 tests, 245 passed, 0 failed**.
  - The first sandboxed F4.3 run produced five environment failures because the sandbox refused loopback listeners (`EPERM 127.0.0.1`); the same unchanged suite passed outside the sandbox. This was not retried silently.
  - The first F4.5 full run found one deterministic VM harness regression (`window is not defined`) introduced by the client function export. The redundant explicit export was removed, the focused snapshot test passed, and the complete suite then passed 245/245.
- `PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" node --import tsx --test test/workflow-chat.test.ts`: **6 passed, 0 failed** after F4.4.
- `PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" node --import tsx --test test/dashboard.test.ts`: **1 passed, 0 failed** after F4.5.
- `rm -rf dist && PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" npm run test:all` on macOS: **245 unit/integration tests passed**, followed by all script suites passing:
  - macOS installer
  - maintenance/update
  - uninstall
  - configure
  - dashboard configuration
  - installation validation
- `PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" npm run build`: passed.
- `git diff --check`: passed with no output.

## Limitations

- Exact prompt text remains deliberately local, sensitive and retention-bound. The thread reports `available:false` after pruning.
- Dashboard messages require GitHub availability because publication is the first durable step. A publication failure leaves the workflow unchanged.
- The conversation is derived from retained events and records rather than a new chat table; this is intentional and keeps one audit model.
- No push, merge, tag or pull request was performed.

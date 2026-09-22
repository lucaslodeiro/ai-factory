# Publication visibility — 2026-09-22

Reviewed the proposal *Sincronizar Workflow conversation y el issue de GitHub* against `main` at `17745de`. The proposal asked for per-milestone publication states in the dashboard, thread reloads on every new event, and a consistency rule between local events and GitHub comments.

## Decisions

- **Scope reduced to the defects.** Marker-based idempotency, confirmation before marking, the published presentation revision, the native edit history of the status comment and the single Reviewer/PR comment already existed. The proposal's GitHub-side changes were not implemented because the issue already behaves as requested.
- **D1 — agree.** `WorkflowOrchestrator.flush` ran help, milestones and status in one `try` and stopped at the first error, so one unpublishable comment blocked the status comment of every work item and the recorded `github.projection_failed` event carried no work item. Fixed by running every pass over every item and rethrowing after the pass.
- **D2 — agree.** The publisher discarded the comment id returned by the adapter and stored a boolean. Replaced by a publication state per key (`published` with id and URL, `failed` with attempts and error, `skipped` for non-milestones). No compatibility path for the old boolean marks: a boolean is read as "not published" and republishes through the same marker, which the adapter already de-duplicates.
- **D3 — agree.** The dashboard reloaded an open conversation only when `revision` changed, which presentation-only events and `execution.started` never do. The issue list now exposes `lastEventId` and the thread reloads on it.
- **Attention threshold:** three consecutive failed attempts on one key (`PUBLICATION_ATTENTION_ATTEMPTS`) record `github.publish_stalled` once and mark the milestone as needing attention. Counted in attempts, not wall time, because retries follow the daemon poll.
- **Reviewer reports:** unchanged, only approved results and correction limits are permanent comments. **Self-recovering failures:** unchanged, no permanent comment; the thread shows the state.

## Changes

- `src/workflow-github.ts`: `WorkflowPublication`, publication keys, `publicationOf`, `commentUrl`, `isMilestoneResult` exported; `attempt()` records every write outcome; `publishChanged`, `publishHelp`, `publishResults` and `publishFailures` visit every row before rethrowing the first error.
- A confirmed write records `github.published` with the work item, key and comment id. Without it an open conversation had no reason to reload after a milestone was confirmed, so a pending badge would have stayed until the next unrelated event. The events feed excludes it.
- `src/adapters/github.ts`: `syncWorkflow` returns the status comment id.
- `src/workflow-orchestrator.ts`: `flush` runs the three passes independently and aggregates errors.
- `src/workflow-chat.ts`: `threadPublication` on milestone result turns and failure turns; `statusPublication` for the status comment.
- `src/dashboard.ts`: `lastEventId` per item, `publication` in the thread response, feed entries for `github.publish_failed` and `github.publish_stalled`.
- `dashboard/app.js`, `dashboard/styles.css`: thread reload keyed on revision plus last event id; publication badge and error detail per milestone; status comment note only when behind or failed.
- `docs/CONTEXT_AND_WORKFLOW_DESIGN.md` §8.1 and §8.2.

## Verification

- Baseline: `npm test` — **368 pass, 0 fail, 0 skipped**.
- New tests: **a milestone that cannot be published keeps its attempts, never blocks other work items and publishes once after recovery** (`test/workflow-github.test.ts`), **workflow thread shows each publishable milestone as pending, published with its link or failed, and the status comment lag** (`test/workflow-chat.test.ts`), **flush still updates the issue status when a milestone comment cannot be published, and publishes it once GitHub recovers** (`test/workflow-orchestrator.test.ts`), plus `lastEventId` and `publication` assertions in `test/dashboard.test.ts`.
- Focused: `node --import tsx --test test/workflow-github.test.ts test/workflow-chat.test.ts test/workflow-orchestrator.test.ts` — **37 pass, 0 fail**.
- Full run after the change: `npm run build && npm test` — **371 total, 371 pass, 0 fail, 0 skipped**. Five vm-based dashboard tests failed on the first full run because the new front-end helpers lived outside the function slice those tests load; the helpers now live inside `renderWorkflowThread`.
- Browser check: the dashboard was started with `startDashboard` over a seeded temporary database (fake `gh` and `git`, one work item with milestones in the three states) and opened in the preinstalled Chromium through Playwright. The badges, the linked comment URL, the error detail and the status-comment note rendered as designed with no console errors; see [workflow-conversation.png](2026-09-22-publication-visibility/workflow-conversation.png) (captured with the conversation's scroll clamp lifted so it fits one image). Live reload: a `command.applied` event inserted into the database while the page was open appeared as the newest turn within 2 seconds, with the workflow revision unchanged and no page navigation.

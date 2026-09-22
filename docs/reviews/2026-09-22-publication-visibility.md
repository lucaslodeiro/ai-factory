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

## Check against the real issue #10 (`lucaslodeiro/factory-demo`)

The local database behind issue #10 lives on the owner's installation and was not available here, so the check used only what the issue publishes. The four real comments were read through the GitHub API and adopted into a fresh database with `readIssueState` and `adoptIssueState`, the official continuation path. The conversation was rebuilt from published facts only: the seven transitions listed in the status comment's history, the latest result of each role from the state index, the specification fact and the `/factory approve v1` dashboard comment. A read-only publisher pass (a port that resolves existing markers and refuses to create anything) then recorded the real comment ids; nothing was written to GitHub.

- Status comment at workflow-rev 10 · presentation-rev 10, published, not behind.
- **Architect · spec** and **Reviewer · pass** show *Published on GitHub* linking to comments `5780994317` and `5781096420`, the two milestone comments the issue really has. Builder and Tester `pass` results carry no badge because they are not milestones.
- The `/factory approve v1` comment (`5781011154`) appears as the human dashboard turn. See [issue-10-conversation.png](2026-09-22-publication-visibility/issue-10-conversation.png) (collapsed) and [issue-10-reviewer-report.png](2026-09-22-publication-visibility/issue-10-reviewer-report.png).
- **Regression found and fixed:** with the Reviewer report open, the acceptance-evidence table (rendered by `5588650`, merged the same day) widened `.markdown-table-wrap` to 3,675 px because `min-width:max-content` on the table propagated through grid items with `min-width:auto`, pushing every badge off the panel. `contain:inline-size` and `min-width:0` on the wrapper, plus `min-width:0` on `.thread-turn`, keep the wrapper at its container width (930 px measured) with the table scrolling inside. Measured before and after in Chromium; `npm test` — **372 pass, 0 fail** after the fix.

### Status comment lag, on the same adopted issue

With the conversation open in Chromium, the adopted issue #10 was driven through the four states of its status comment; every change reached the open page within about 2 seconds and the page never navigated.

| Step | Trigger | Rows | Note shown |
| --- | --- | --- | --- |
| Behind | a human note advanced the presentation revision only | local 11, published 10 | "Issue status comment is pending publication." (muted) |
| Failed once | `syncWorkflow` refused with HTTP 502 | attempts 1 | "…not published: gh: HTTP 502…. Retrying." (muted) |
| Stalled | two more refusals | attempts 3 | "…not published after 3 attempts: …. Retrying." (red) |
| Recovered | read-only port resolved the real status comment | local 11, published 11 | no note; publication holds comment `5780966837` |

Events recorded for the item: `github.publish_failed` once, `github.publish_stalled` once, `github.published` four times. See [issue-10-status-stalled.png](2026-09-22-publication-visibility/issue-10-status-stalled.png).

## Follow-up: one turn per execution, timing, and the status note as a row

Owner feedback on the issue #10 captures: group the prompt and the result of one execution, show start time and duration, and apply the three small fixes to the status note.

- `workflowThread` now emits one `execution` turn per run: the prompt manifest, the result, and a non-successful process outcome share it. Start, finish and duration come from the `executions` row when it exists, otherwise from the event timestamps, so a continued item without local executions still shows them. Status is the row's status (`running` with a finish time reads as failed), else derived from the result or the finish event.
- The dashboard renders the turn as "Agent execution · role · outcome or process state" with the publication badge, provider, model, start time and duration in the header; the result in the body; and the manifest and reveal button under a collapsed Agent input block. A running execution shows how long it has been running.
- The status note is a row with a state dot, the comment link and the next step: "Retries on the next daemon cycle" after a failure, "Check `gh auth status` and the daemon log" once three attempts failed. API URLs are stripped from the visible error and kept in the tooltip; the same applies to the per-turn error. Published badges carry the confirmation time in their tooltip.
- Issue #10 adopted again: the conversation drops from 18 to 14 turns and each execution shows its start and duration. Because the owner's local `executions` rows are not available here, the reconstruction starts each execution at the time its stage was queued in the published history and ends it at its result time; the durations in the captures are those bounds, not measured process times. The status note walkthrough was repeated on the grouped conversation with the same result (behind → failed → stalled → recovered, no navigation).
- Tests: **workflow thread groups the prompt, result and outcome of one execution and reports its start and duration** (`test/workflow-chat.test.ts`); the vm rendering test and the dashboard API test were updated to the new turn shape. `npm test` — **373 pass, 0 fail, 0 skipped**.

## Follow-up: milestones and human guidance filter

- Every thread turn carries `milestone`. An execution is a milestone when its result is published as a permanent comment (the publisher's own rule) or its process did not finish cleanly; human guidance always is; a transition is one when it enters a state that waits on a person or ends the work, except the continuation transition.
- The conversation shows a "Milestones and human guidance only" checkbox with the turn count, off by default and remembered per browser through `localStorage` (read and written inside `try`, so a blocked storage only loses the memory).
- Browser check on the adopted issue #10: 13 turns with the filter off; 5 with it on (pull request ready, Reviewer report, the approval, SPEC v1 proposed, Architect spec); still on after a reload; 13 again when turned off; no console errors. The first click initially did nothing because the conversation skips re-rendering while focus is inside it and the checkbox kept focus; the toggle now blurs before re-rendering. See [issue-10-milestones-only.png](2026-09-22-publication-visibility/issue-10-milestones-only.png).
- Tests: **workflow thread marks milestones with the same rule that publishes them, plus human guidance and states that wait on a person** (`test/workflow-chat.test.ts`) and **the milestones filter hides intermediate turns, keeps the newest milestone open and stays off by default** (`test/dashboard-settings-feedback.test.ts`). `npm test` — **375 pass, 0 fail, 0 skipped**.

## Follow-up: issue card sections

Owner review of the two disclosures on the issue card, with the issue #10 captures:

- **"How to request changes" / "How to respond" removed.** It told people to post a `/factory` command in the issue while the conversation's composer, one line below, sends the same command from the dashboard. The next step now pairs its GitHub link with a dashboard action (Request changes, Approve or request changes, Answer, Give guidance). The action opens the conversation through its own summary, so the existing rule that the client never forces a panel open still holds, and focuses the composer. The command stays as one muted line for people who prefer the issue. `workflowNextStep` drops the prose fields the card no longer shows and adds `respondLabel`.
- **"Activity details" removed.** While waiting it repeated the last transition, which is the newest turn of the conversation and implied by the next step; while queued or running it mostly repeated the state chip. The card now shows one activity line only when it adds information: why queued work is not starting, how long an agent has been running, a recovery need (in red) or a pause reason. A failure keeps its expanded **Failure diagnosis**; a pause lists **Open findings (n)** as its own disclosure.
- Browser check on the adopted issue #10: the waiting card shows the title, Request changes, Review pull request, the command line and the conversation, with no other disclosure; Request changes opened the conversation and focused the composer; running showed "Agent started 4m ago."; a finished execution the workflow had not applied showed the red recovery line; plain queued showed nothing; paused showed the pause reason and "Open findings (1)". Capacity, checked separately on the issue #10 card (selected by issue number, not position): with another item running, the chip read "Build · Waiting for capacity" and the line "Another task is using the execution slot. This task will start when it becomes available."; once that item finished, the same card read "Build · Queued" with no line; no disclosure in either state (see [issue-10-card-capacity.png](2026-09-22-publication-visibility/issue-10-card-capacity.png)). No console errors. See [issue-10-card.png](2026-09-22-publication-visibility/issue-10-card.png), [issue-10-card-request-changes.png](2026-09-22-publication-visibility/issue-10-card-request-changes.png) and [issue-10-card-paused.png](2026-09-22-publication-visibility/issue-10-card-paused.png).
- The first full run failed one guard in `test/dashboard.test.ts` that forbids `panel.open=true` in the client; the action now clicks the panel's summary instead. Tests: **the issue card answers in the dashboard and shows activity only when it adds information** (`test/dashboard-settings-feedback.test.ts`) and the `respondLabel` assertion in `test/workflow-next-step.test.ts`. `npm test` — **376 pass, 0 fail, 0 skipped**.

## Follow-up: continuation as a conversation header note

- The continuation transition is no longer a turn. `workflowContinuations` returns every adoption with its source instance, revision, publication time and whether local turns predate it; the thread API returns it beside the turns. `adoptIssueState` now records `instance`, `revision` and `publishedAt` in the continuation reason; older events still yield their instance from the summary text.
- The conversation header shows "Continued here · From <instance> at revision <n> · <time>". When nothing was recorded locally before the adoption it adds that the earlier turns live on the source installation, and an empty conversation says "No turns on this installation yet." instead of "No workflow turns yet.". Repeated moves are counted. The card heading keeps its one-line ownership summary.
- The turn counter now uses the singular for one turn.
- Browser check on issue #10 adopted from its published state only, without the history reconstructed for the earlier captures (that reconstruction inserted turns after the continuation event and does not reflect a real continued installation): the header note named macbook-pro-7-local and revision 10 and explained where the earlier turns live; the conversation read "No turns on this installation yet."; a dashboard note added afterwards appeared as the only turn below the note, counted as "1 turn". No console errors. See [issue-10-continuation-note.png](2026-09-22-publication-visibility/issue-10-continuation-note.png).
- Tests: **continuations leave the conversation as header context and say whether local history predates them** (`test/workflow-chat.test.ts`) and **the conversation header explains a continuation and whether earlier turns live elsewhere** (`test/dashboard-settings-feedback.test.ts`); the milestone test no longer expects the continuation turn. `npm test` — **378 pass, 0 fail, 0 skipped**.

## Follow-up: "Next attempt in" instead of "Publish now"

- "Publish now" was not built: the daemon already retries on every remote cycle, 15 s by default, so a button would save at most that wait. The note now answers the same question.
- The daemon records `nextAt` in `runtime:github-sync` when each remote cycle ends, and the thread API returns that state with whether a daemon is running. A failed status comment's note ends with a live countdown ("Next attempt in 12 s."), "Retrying now." during a cycle, or "The daemon is stopped; publication resumes when it starts.".
- Later failures record no event, so an open conversation whose status comment is failed or behind also reloads after each GitHub cycle and when the daemon's running state changes; other conversations keep reloading only on new events.
- Browser check on issue #10 adopted from its published state, with a daemon lock held by a live process: 15 s, then 12 s three seconds later; "Retrying now." within 1 s of a cycle starting; a fresh 14 s countdown after it failed again; the stopped-daemon sentence within about 2 s of removing the lock; one navigation, no console errors. The first walkthrough missed the stop, because nothing triggered a reload without a cycle; the daemon's running state joined the reload key. See [issue-10-next-attempt.png](2026-09-22-publication-visibility/issue-10-next-attempt.png).
- Tests: **the status comment note says when the next attempt happens, or that the daemon is stopped** (`test/dashboard-settings-feedback.test.ts`); **an open thread with a lagging status comment reloads after each GitHub cycle and when the daemon stops** (`test/dashboard-snapshot-consistency.test.ts`), shown failing without the daemon-state part of the key; and a `nextAt` assertion in the daemon integration test, shown failing without the daemon change. `npm test` — **383 pass, 0 fail, 0 skipped** (after rebasing onto `404e524`).

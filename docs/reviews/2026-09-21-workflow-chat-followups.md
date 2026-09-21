# Workflow chat follow-ups review

## Decisions

- **F4.7 — agree.** `WorkflowInbox.poll` records rejected, deferred, superseded and unrecognized comment commands, but it does not record a successful comment command. `workflowThread` therefore has no event from which to build the human turn, while dashboard messages explicitly emit `command.applied`.
- **F4.8 — agree.** `WorkflowRunner.recordPreviousAttempt` stores an unscoped `previousAttempt`; every later `run()` passes it to the context assembler and no code removes it.
- **F4.9 — agree.** `applyInterruptRetryControl` moves the item to `PAUSED` before confirming that the execution stopped, so its rejection copy can contradict the applied transition. Specification feedback also creates an instruction although the documented contract and Architect context describe it as a human decision.

## Changes

### F4.7 — applied issue commands in the thread

- Files: `src/workflow-inbox.ts`, `src/workflow-chat.ts`, `test/workflow-inbox.test.ts`, `test/workflow-chat.test.ts`.
- Successful commands from GitHub comments now emit `command.applied` on the normal and deferred-retry cancel paths with the comment id, login, human command label, carried text and `source: "comment"`.
- `workflowThread` uses the event text when a command has no resulting record and preserves the explicit event source. The inbox tests assert that real `approve` and `note` comments become human turns with the right text and login; the dashboard test asserts that its turn remains `source: "dashboard"`.
- Commit: `fd68b1c` (`fix: F4.7 show applied issue commands in workflow chat`).

### F4.8 — consume previous-attempt context once

- Files: `src/workflow-runner.ts`, `test/workflow-runner.test.ts`.
- `previousAttempt` now records its target stage and retry attempt. Context assembly includes it only for that exact execution. Starting any execution removes the value in the same context update that writes `attemptStart`, preventing stale recovery context from leaking into later work.
- Test `previous attempt context is consumed once by only its matching stage and attempt` verifies matching inclusion, atomic removal, absence from the following stage and omission when the stored stage does not match.
- Commit: `eebdf00` (`fix: F4.8 consume previous attempt context once`).

### F4.9 — interruption truthfulness and specification feedback

- Files: `src/workflow-chat.ts`, `src/workflow-runner.ts`, `src/workflow-commands.ts`, `test/workflow-chat.test.ts`, `test/workflow-commands.test.ts`, `test/issue-content.test.ts`.
- Interrupt-and-retry now sends the interruption and waits for the execution row to stop before moving the workflow to `PAUSED`. A timeout leaves the item `RUNNING`, marks the published dashboard comment rejected and performs no preservation or retry. The runner recognizes this planned interruption and does not turn it into a workflow failure while the control completes.
- Specification feedback through `answer` creates a spec-scoped human decision with its author, matching the status and milestone copy and the Architect's protected context.
- Tests assert that a TERM-resistant fake leaves the item `RUNNING` with rejected copy, that a successful retry targets the next Build attempt, that feedback is an active human decision visible to Architect, and that the specification comment describes that behavior.
- Commit: `263a554` (`fix: F4.9 align interruption and specification feedback`).

### Documentation

- `docs/CONTEXT_AND_WORKFLOW_DESIGN.md` §6 now states that previous-attempt context is scoped and consumed once. §8.2 now specifies `command.applied` for commands accepted from issue comments.
- Commit: `070fb0e` (`docs: document workflow chat follow-up behavior`).

## Verification

- `PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" npm test` after F4.7: **245 tests, 245 passed, 0 failed** outside the sandbox. An earlier sandboxed invocation produced five `listen EPERM 127.0.0.1` failures; the same tests passed when local listening was allowed.
- `PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" npm test` after F4.8: **246 tests, 246 passed, 0 failed** after correcting the new fixture to contain structured acceptance criteria.
- `PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" node --import tsx --test test/workflow-chat.test.ts test/workflow-commands.test.ts test/issue-content.test.ts test/workflow-runner.test.ts`: **36 tests, 36 passed, 0 failed**.
- First complete `npm test` after F4.9: **248 tests, 247 passed, 1 failed**. The unrelated test `concurrent CLI processes initialize a new V3 SQLite database exactly once` hit `SqliteError: database is locked`. This intermittent failure is recorded rather than hidden.
- One disclosed rerun of the same `npm test`: **248 tests, 248 passed, 0 failed**.
- `rm -rf dist && PATH="$HOME/.local/bin:/usr/local/git/bin:$PATH" npm run test:all` on macOS: **248 tests, 248 passed, 0 failed**; TypeScript build passed; all six script suites printed `PASS` (installer, maintenance, uninstall, configure, dashboard config and installation validation).
- `git diff --check`: passed with no output before this report; repeated after the report commit.

## Limitations

- The full suite needs local loopback listeners and therefore cannot run successfully in the restricted sandbox. It was run with the required local permissions.
- The SQLite concurrent-initialization test failed once with a transient lock and passed on the one explicitly reported rerun. No production code or test was changed to mask or loosen that test.

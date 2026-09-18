# MVP validation — 2026-09-18

## Automated checks

`npm run build` and `npm test` pass on macOS with Node 26.4.0. A Node 22/Linux GitHub Actions template is provided in `docs/ci.example.yml`. It is not activated: the current GitHub OAuth credential lacks the workflow scope, and GitHub rejected a push containing `.github/workflows/ci.yml`. Copy the template there using a credential permitted to manage workflows when ready.

16 tests cover:

- Full foreground daemon with real SQLite, separate CLI control processes, real Git worktrees and a local bare remote. Deterministic provider executables consume the actual adapter arguments and stdin; a GitHub executable fixture supplies issues/comments and records the PR. The test approves a version, starts Developer, checks status without recovery side effects, cancels, retries, runs QA/Reviewer, publishes a branch and verifies READY_TO_MERGE, then stops the daemon.
- Native Claude/Codex output envelopes and schema validation.
- Invalid/stale/unauthorized/bot approvals and question/answer loops.
- QA auto-fix, decision routing, bounded correction loops and deferred findings.
- Durable GitHub outbox, idempotent delivery and malformed output failure.
- Process success, spawn errors, nonzero exit, timeout, cancellation and crash recovery.
- Single-daemon lock, environment filtering, QA file restrictions and branch publication restrictions.

## Live checks

- Private demo repository created: https://github.com/lucaslodeiro/ai-factory-demo
- Acceptance issue queued: https://github.com/lucaslodeiro/ai-factory-demo/issues/1
- Both repositories cloned locally; `.env` points the factory at the demo.
- Codex was already installed and authenticated. A real invocation through `CodexAdapter` returned the required structured result: `outcome=pass`, `summary=Codex provider connectivity verified`. No demo files changed.
- Claude Code 2.1.267 installed successfully. Authentication is still required; the user was away from the machine. Login was cancelled rather than left waiting.

The real four-role demo has **not** completed. No simulated approval was posted to the real issue, and no real demo PR exists yet. Automated tests use deterministic provider/GitHub substitutes; they do not establish Claude reasoning quality or successful live Claude authentication.

## Resume the live acceptance check

1. Run `~/.local/bin/claude auth login` on the Mac and finish browser authentication.
2. In the factory checkout, use Node 22+ and working Git in PATH; run `npm run factory -- doctor`, then `npm run factory -- start`.
3. Read the SPEC on demo issue #1 and post its exact `/factory approve vN` command (or `/factory answer ...` for changes).
4. Verify independent Developer, QA and Reviewer executions, a pushed work branch and a demo PR. Review and merge manually if desired.

Execution logs and SQLite are retained under `.factory/demo/` on the current machine. The daemon is not left running while authentication is missing.

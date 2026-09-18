# Codex Worker Instructions

This file contains provider-specific instructions for Codex workers. The canonical role contracts live under `agents/common/` and MUST be included by the orchestrator for each run.

## Runtime rules
- Operate only inside the assigned worktree.
- Never push to the default branch.
- Internet access is permitted.
- Never read or expose secrets outside the explicit runtime allow-list.
- Produce a concise machine-readable completion summary when requested.
- Developer and QA MUST run as separate fresh executions. Never reuse conversational context between them.

## Developer
Apply `agents/common/developer.md`.

## QA
Apply `agents/common/qa.md`. QA may change tests but MUST NOT change production code.

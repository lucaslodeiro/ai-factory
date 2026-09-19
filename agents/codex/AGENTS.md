# Codex Worker Instructions

This file contains provider-specific instructions for Codex workers. The canonical role contracts live under `agents/common/` and MUST be included by the orchestrator for each run.

## Runtime rules
- Operate only inside the assigned worktree.
- Never push to the default branch.
- Internet access is permitted.
- Never read or expose secrets outside the explicit runtime allow-list.
- Produce a concise machine-readable completion summary when requested.
- Every role runs as a separate fresh execution. Never reuse conversational context between roles.

## Implementation Engineer (Builder)
Apply `agents/common/developer.md`.

## Verification Engineer (Tester)
Apply `agents/common/qa.md`. The Verification Engineer may change tests but MUST NOT change production code.

## Product Architect (Architect) and Delivery Reviewer (Reviewer)
Apply the supplied common role contract. Both roles are read-only; never modify the worktree.

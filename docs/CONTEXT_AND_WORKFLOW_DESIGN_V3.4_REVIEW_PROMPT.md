# Final review prompt — Context and Workflow Specification V3.4

Review the attached **AI Factory — Context and Workflow Evolution Specification V3.4** as an implementation-consistency check.

## Context

AI Factory is a local deterministic orchestrator that turns a GitHub issue into an approved specification, implementation, independent test, delivery review and pull request. Architect, Builder, Tester and Reviewer run through Claude or Codex. SQLite owns workflow state; GitHub is the collaboration projection; Slack is notification-only.

The specification describes the current implementation and an evolution already in progress. Inspect the repository source when a statement can be verified; do not assume the specification accurately describes the code.

This is a final review, not an invitation to redesign the product or expand scope. Prefer the smallest correction that closes a concrete contradiction, unsafe state, missing invariant or unimplementable requirement.

## Review objectives

Determine whether V3.4 remains internally consistent, implementable and safe. In particular, verify:

1. **Context records**
   - identity, provenance, scope, lifecycle and deterministic sequence;
   - instruction conflict and supersession rules;
   - role filtering and Tester independence;
   - protected context budgets and prompt provenance.

2. **Requests and failures**
   - request ownership (`human` versus `architect`);
   - parent-chain selection and `activeRequestId` derivation;
   - relationship between request owner, workflow status and GitHub CTA;
   - one unresolved failure and `activeFailureId` lifecycle.

3. **Workflow projection**
   - stage/status combinations and every route in the transition table;
   - transactional boundaries and revision semantics;
   - retry, pause, cancel, consultation, correction-limit, merge and recovery behavior;
   - whether any state requires inference that the design claims to remove.

4. **GitHub projection**
   - distinction between workflow `revision`, `presentationRevision` and the published value;
   - inbound polling versus write-on-change behavior;
   - one authoritative CTA and milestone-comment rules;
   - label and marker consistency for newly created V3 work items.

5. **Clean cutover**
   - fresh databases are marked version 3 only after schema creation succeeds;
   - older or unversioned databases are rejected before mutation;
   - the error gives the supported uninstall or empty-data-directory recovery path;
   - no importer, dual-read or legacy fallback remains.

6. **Reviewer artifacts**
   - `.factory-context/` exclusion, collision and symlink protections;
   - diff/stat range consistency, cleanup and provider access;
   - whether the mechanism can hide or commit repository-owned files.

7. **Planned maintenance**
   - validation, preflight, confirmation and revision-bound revalidation;
   - daemon-side barrier that prevents new executions;
   - graceful interruption, timeout and service-operation ordering;
   - durable maintenance state across dashboard/update restarts;
   - batch and individual resume boundaries;
   - execution `interrupted/planned-maintenance` versus explicit `cancelled` and unexpected recovery failure;
   - races involving new work, changed revisions, daemon failure or partial pause.

8. **Acceptance tests**
   - whether every important invariant and failure path has an executable test;
   - whether any test contradicts the normative text;
   - whether the proposed tests are sufficient to implement in phases without hidden cutover risk.

9. **Issue visibility and repository recovery**
   - closed issues cannot execute, publish or remain visible, and reopening cannot replay commands;
   - Check is strictly read-only and distinguishes live remote state from cached tracking refs;
   - Sync and Publish reject divergence, protected branches and force updates;
   - Clear validates the exact configured root, pauses affected work and requires path-bound double confirmation;
   - Restore requires an empty directory and never auto-resumes work;
   - the bounded actions do not become a general Git or GitHub client.

## Required output

Start with exactly one verdict:

- `APPROVE`
- `APPROVE WITH REQUIRED CHANGES`
- `REJECT`

Then provide these sections:

### Blocking findings

Only issues that must be resolved before implementation. For each finding include:

- severity;
- exact specification section;
- relevant source file or current behavior when applicable;
- concrete failure scenario;
- minimal textual correction.

Write `None` if there are no blockers.

### Non-blocking improvements

Clarity, naming or implementation guidance that can be decided during delivery without changing the architecture. Do not promote preferences into blockers.

### Contradiction audit

Explicitly state whether you found contradictions among schema, transition table, invariants, clean cutover and acceptance tests. List each one or write `None`.

### Proposed patch list

A compact table of exact edits:

| Section | Current problem | Replacement or addition |
| --- | --- | --- |

Do not rewrite the whole document. Preserve its architecture unless a demonstrated blocker requires a change.

### Implementation readiness

State whether work can begin after applying the proposed patch list. If yes, suggest a dependency-ordered implementation sequence of no more than six phases. Do not implement code.

## Review rules

- Distinguish current behavior from proposed V3.4 behavior.
- Verify code-referenced claims against the repository.
- Do not infer requirements from superseded documents when V3.4 is explicit.
- Do not propose distributed services, multi-repository support, event sourcing, AI summaries or other scope outside the specification.
- Treat race conditions, silent loss of human guidance, incorrect resume routes, unsafe filesystem behavior and mutation of unsupported databases as blocking.
- Treat wording and naming preferences as non-blocking unless they create operational ambiguity.
- If the specification is ready, say so directly rather than inventing changes.

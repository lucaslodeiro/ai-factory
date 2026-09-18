# Model selection: balanced-v3

The user selected a balance of quality, cost and time. Product/Architect assesses each issue when proposing its spec. The deterministic orchestrator maps that assessment and role to a configured profile, then reads the provider and model configured for that role. The model never supplies a provider or executable model ID. This is per issue and role invocation; the MVP does not decompose an issue into independently routed subtasks.

## Routing rules (in priority order)

| Condition | Profile |
|---|---|
| Architect has an unapproved high-complexity/high-risk draft awaiting review | strong |
| A correction/decision cycle has occurred, or Architect is handling a consultation | strong |
| Approved complexity or risk is high | strong |
| Legacy delivery item without an assessment | strong |
| Developer on low complexity AND low risk | fast |
| All other cases, including initial Architect, QA and Reviewer | balanced |

QA and Reviewer have a balanced floor. Initial Architect starts balanced because complexity is not known yet; if it proposes a high-complexity or high-risk spec, the orchestrator persists that unapproved draft and invokes a fresh strong-profile Architect before creating a spec version or requesting approval. That invocation can finalize/reassess the spec or ask questions. Failures, restarts and clarification answers retain the draft and strong routing. A strong-profile result is not escalated again, preventing a review loop. Only the finalized spec becomes an approvable version. Initial questions without a spec do not trigger this extra review. Corrections escalate subsequent roles for the remaining cycle; timeout/cancellation or transport errors alone do not increase the correction counter. The existing correction limit still applies. Human guidance resets that counter as before.

Complexity considers scope, algorithms, architecture and concurrency. Risk considers authentication/authorization, secrets, payments, destructive migrations and security boundaries. Unknown scope should prompt clarification or a conservative assessment. This semantic classification remains an AI judgment, visible for human correction; the router itself is deterministic. It does not independently prove the assessment correct.

The assessment and its rationale are published with SPEC vN and stored in that immutable spec snapshot. Approving the spec approves the assessment. Use `/factory answer ...` to request a correction before approval. Tactical resolutions and delivery results cannot replace it; a new assessment requires a new spec version and approval.

## Configured role table

| Role | Default provider | fast | balanced | strong |
|---|---|---|---|---|
| Product / Architect | Claude | sonnet | sonnet | opus |
| Developer | Codex | gpt-5.6-luna | gpt-5.6-terra | gpt-5.6-sol |
| QA | Codex | gpt-5.6-luna | gpt-5.6-terra | gpt-5.6-sol |
| Reviewer | Claude | sonnet | sonnet | opus |

Dashboard → Configuration → Agent roles exposes one card per role. Each card selects Codex or Claude and its fast, balanced and strong model IDs. The corresponding environment names are `<ROLE>_PROVIDER` and `<ROLE>_MODEL_FAST|BALANCED|STRONG`, where `<ROLE>` is `PRODUCT_ARCHITECT`, `DEVELOPER`, `QA`, or `REVIEWER`. `CODEX_MODEL_*` and `CLAUDE_MODEL_*` remain provider defaults used to initialize new role settings and migrate existing installations.

Profiles are relative policy tiers, not a provider's premium Fast service tier, a price guarantee or a spending cap. IDs may be the same across profiles when account availability requires it. Claude aliases can resolve to new versions; use full versioned IDs when pinning is required. QA and Reviewer currently have a balanced floor, so their fast setting is reserved for future policy changes.

The Codex defaults follow the [official model catalog](https://learn.chatgpt.com/docs/models). Explicit model arguments follow the [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli); Claude's installed CLI supports `--model`. Availability still depends on account and provider. The factory passes `--model` for every invocation. A rejected model fails the run; the factory never silently falls back to another model or provider. Changing role settings requires restarting the daemon and affects future attempts, with each selection recorded separately. Both providers receive the same canonical role contract. Product/Architect and Reviewer remain read-only; Developer can edit the worktree; QA remains restricted to test files by the orchestrator's mutation checks.

## Inspecting and auditing

- `npm run factory -- models`: show every configured role/provider/profile/model mapping without running an agent.
- `npm run factory -- models <work-item-id>`: preview selections for each role given current context (not historical usage and not authorization to execute).
- `npm run factory -- events <work-item-id>`: inspect `model.selected` and `execution.started`. Each started run records policy version, provider, profile, requested model and reason, linked to its run ID. Requested model/alias is recorded; the provider's resolved backend model is not independently attested.

Existing specs without assessments continue under the strong delivery profile; new spec outputs must contain an assessment. No prices, token budgets or automatic provider switching are inferred. Real live model availability and quality require acceptance runs; subprocess fixtures verify routing and arguments only.

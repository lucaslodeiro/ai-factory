# Model selection: balanced-v1

The user selected a balance of quality, cost and time. Product/Architect assesses each issue when proposing its spec. The deterministic orchestrator maps that assessment and the role to a configured model profile. The model never supplies an executable model ID. This is per issue and role invocation; the MVP does not decompose an issue into independently routed subtasks.

## Routing rules (in priority order)

| Condition | Profile |
|---|---|
| A correction/decision cycle has occurred, or Architect is handling a consultation | strong |
| Approved complexity or risk is high | strong |
| Legacy delivery item without an assessment | strong |
| Developer on low complexity AND low risk | fast |
| All other cases, including initial Architect, QA and Reviewer | balanced |

QA and Reviewer have a balanced floor. Initial Architect starts balanced because complexity is not known yet; a task initially assessed as high does not retroactively rerun that first assessment. Subsequent invocations use the new assessment. Corrections escalate subsequent roles for the remaining cycle; timeout/cancellation or transport errors alone do not increase the correction counter. The existing correction limit still applies. Human guidance resets that counter as before.

Complexity considers scope, algorithms, architecture and concurrency. Risk considers authentication/authorization, secrets, payments, destructive migrations and security boundaries. Unknown scope should prompt clarification or a conservative assessment. This semantic classification remains an AI judgment, visible for human correction; the router itself is deterministic. It does not independently prove the assessment correct.

The assessment and its rationale are published with SPEC vN and stored in that immutable spec snapshot. Approving the spec approves the assessment. Use `/factory answer ...` to request a correction before approval. Tactical resolutions and delivery results cannot replace it; a new assessment requires a new spec version and approval.

## Configured model table

| Provider | fast | balanced | strong |
|---|---|---|---|
| Codex | gpt-5.6-luna | gpt-5.6-terra | gpt-5.6-sol |
| Claude | sonnet (reserved) | sonnet | opus |

Override `CODEX_MODEL_FAST`, `CODEX_MODEL_BALANCED`, `CODEX_MODEL_STRONG`, `CLAUDE_MODEL_FAST`, `CLAUDE_MODEL_BALANCED`, and `CLAUDE_MODEL_STRONG` in the factory environment. No current Claude role uses fast. These profiles are relative policy tiers, not a provider's premium Fast service tier, a price guarantee or a spending cap. IDs may be the same across profiles when account availability requires it. Claude aliases can resolve to new versions; use full versioned IDs when pinning is required.

The Codex defaults follow the [official model catalog](https://learn.chatgpt.com/docs/models). Explicit model arguments follow the [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli); Claude's installed CLI supports `--model`. Availability still depends on account and provider. The factory passes `--model` for every invocation. A rejected model fails the run; the factory never silently falls back to another model or provider. Changing environment settings requires restarting the daemon and affects future attempts, with each selection recorded separately.

## Inspecting and auditing

- `npm run factory -- models`: show the configured model table without running any agent.
- `npm run factory -- models <work-item-id>`: preview selections for each role given current context (not historical usage and not authorization to execute).
- `npm run factory -- events <work-item-id>`: inspect `model.selected` and `execution.started`. Each started run records policy version, provider, profile, requested model and reason, linked to its run ID. Requested model/alias is recorded; the provider's resolved backend model is not independently attested.

Existing specs without assessments continue under the strong delivery profile; new spec outputs must contain an assessment. No prices, token budgets or automatic provider switching are inferred. Real live model availability and quality require acceptance runs; subprocess fixtures verify routing and arguments only.

# Agent model selection: direct-v1

Each agent role has exactly two routing settings: a provider and a model. The model can be a concrete provider model ID or `auto`. A concrete ID is passed to the provider CLI for every invocation of that role. With `auto`, the factory omits the model override and lets the provider choose its recommended default.

The factory does not translate task complexity into `fast`, `balanced`, or `strong` model names. Product Architect still assesses complexity and risk because those values control workflow safeguards and make the human approval explicit; they never replace the model selected for the role.

## Workflow assessment rules

| Condition | Internal workflow tier |
|---|---|
| Architect has an unapproved high-complexity/high-risk draft awaiting review | strong |
| A correction/decision cycle has occurred, or Architect is handling a consultation | strong |
| Approved complexity or risk is high | strong |
| Legacy delivery item without an assessment | strong |
| Builder on low complexity AND low risk | fast |
| All other cases, including initial Architect, Tester and Reviewer | balanced |

These internal tiers describe workflow treatment only. For example, a high-complexity or high-risk draft receives a fresh Architect review before publication for approval. The review uses the same provider and model configured for Product Architect. The tier is retained in audit events so the reason for additional review remains visible.

Complexity considers scope, algorithms, architecture and concurrency. Risk considers authentication/authorization, secrets, payments, destructive migrations and security boundaries. Unknown scope should prompt clarification or a conservative assessment. Product Architect supplies the semantic assessment; the deterministic orchestrator applies the workflow rules.

The assessment and rationale are published with SPEC vN and stored in its immutable snapshot. Approving the spec approves the assessment. Use `/factory answer ...` to request a correction before approval. Tactical resolutions and delivery results cannot replace it; a new assessment requires a new spec version and approval.

## Configured roles

| Role | Short name | Stage | Default provider | Default model |
|---|---|---|---|---|
| Product Architect | Architect | Design | Claude | sonnet |
| Implementation Engineer | Builder | Build | Codex | gpt-5.6-terra |
| Verification Engineer | Tester | Test | Codex | gpt-5.6-terra |
| Delivery Reviewer | Reviewer | Review | Claude | sonnet |

Dashboard → Configuration → Agent roles exposes one card per role. Each card writes `<ROLE>_PROVIDER` and `<ROLE>_MODEL`, where `<ROLE>` is `PRODUCT_ARCHITECT`, `DEVELOPER`, `QA`, or `REVIEWER`. The model selector offers `Auto (provider recommended)`, known model IDs for the selected provider, and preserves an existing custom ID.

When an older installation is loaded, an old `auto` mode migrates to `auto`; otherwise its balanced model becomes the role's single model. Saving removes the retired mode and fast/balanced/strong variables.

The Codex choices follow the [official model catalog](https://developers.openai.com/es-419/docs/models). OpenAI documents that Codex uses a recommended model when none is specified. Claude's [official CLI reference](https://code.claude.com/docs/en/cli-usage) documents `--model` as an override. Availability depends on the account and provider. A rejected model fails the run; the factory never silently changes provider or model. Changing role settings requires restarting the daemon and affects future attempts.

Both providers receive the same canonical role contract. Product Architect and Delivery Reviewer remain read-only; Implementation Engineer can edit the worktree; Verification Engineer remains restricted to test files by the orchestrator's mutation checks.

## Inspecting and auditing

- `npm run factory -- models`: show the configured provider and model for every role without running an agent.
- `npm run factory -- models <work-item-id>`: preview the same configured model with the workflow assessment and reason for each role.
- `npm run factory -- events <work-item-id>`: inspect `model.selected` and `execution.started`. Each run records policy version, provider, configured model, internal workflow tier and reason. With `auto`, the provider's resolved backend model is not independently attested.

Existing specs without assessments retain conservative workflow handling. No prices, token budgets or automatic provider switching are inferred. Real model availability and quality require acceptance runs; subprocess fixtures verify routing and arguments only.

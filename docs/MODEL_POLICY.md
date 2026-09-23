# Agent model selection: direct-v1

Each agent role has exactly two routing settings: a provider and a model. The model can be a concrete provider model ID or `auto`. A concrete ID is passed to the provider CLI for every invocation of that role. With `auto`, the factory omits the model override and lets the provider choose its recommended default.

The factory does not translate task complexity into `fast`, `balanced`, or `strong` model names. Product Architect still assesses complexity and risk because those values inform human approval; they never replace the model selected for the role.

## Workflow assessment rules

Complexity considers scope, algorithms, architecture and concurrency. Risk considers authentication/authorization, secrets, payments, destructive migrations and security boundaries. Unknown scope should prompt clarification or a conservative assessment. Product Architect supplies the semantic assessment; the human approves that assessment with the specification.

The assessment also carries `verificationDepth`, which tells the Verification Engineer how much testing this issue earns instead of leaving it to guess. `minimal` verifies each acceptance criterion once and adds nothing; `standard` adds the obvious boundary and error cases of the changed behaviour; `thorough` adds adversarial cases. It is floored by the worse of complexity and risk, so high in either requires `thorough` and medium requires at least `standard`, and `parseResult` rejects a spec that declares less. Without that floor an Architect could make every run cheap by declaring every issue minimal, which is the cheap path that degrades the product.

The assessment and rationale are published with SPEC vN and stored in its immutable snapshot. Approving the spec approves the assessment. Use `/factory answer ...` to request a correction before approval. Tactical resolutions and delivery results cannot replace it; a new assessment requires a new spec version and approval.

## Configured roles

| Role | Short name | Stage | Default provider | Default model |
|---|---|---|---|---|
| Product Architect | Architect | Design | Claude | auto |
| Product Designer | Designer | Design | Claude | auto |
| Implementation Engineer | Builder | Build | Codex | auto |
| Verification Engineer | Tester | Test | Codex | auto |
| Delivery Reviewer | Reviewer | Review | Claude | auto |

Dashboard → Configuration → Agent roles exposes one card per role. Each card writes `<ROLE>_PROVIDER` and `<ROLE>_MODEL`, where `<ROLE>` is `PRODUCT_ARCHITECT`, `DESIGNER`, `DEVELOPER`, `QA`, or `REVIEWER`. The model selector offers `Auto (provider recommended)`, known model IDs for the selected provider, and preserves an existing custom ID.

The Codex choices follow the [official model catalog](https://developers.openai.com/es-419/docs/models). OpenAI documents that Codex uses a recommended model when none is specified. Claude's [official CLI reference](https://code.claude.com/docs/en/cli-usage) documents `--model` as an override. Cursor's [Agent CLI parameters](https://docs.cursor.com/en/cli/reference/parameters) document `--model` and `cursor-agent models` lists the identifiers the signed-in Cursor account may use; the dashboard offers the identifiers named in that documentation and preserves a custom one. Cursor brokers models from several vendors through a Cursor subscription, so choosing it changes the harness and the billing route rather than adding a model. Availability depends on the account and provider. A rejected model fails the run; the factory never silently changes provider or model. Changing role settings requires restarting the daemon and affects future attempts.

All providers receive the same canonical role contract. Product Architect and Delivery Reviewer remain read-only; Product Designer can write only its disposable prototype under `.factory/prototype/`; Implementation Engineer can edit the worktree; Verification Engineer remains restricted to test files by the orchestrator's mutation checks.

## Provider differences

| Capability | Codex | Claude | Cursor |
|---|---|---|---|
| Structured result | `--output-schema` enforced by the CLI | `--json-schema` enforced by the CLI | No schema flag; the orchestrator appends the schema to the prompt as an output contract and validates the final message locally |
| Result contract prose | role specialization omitted; the schema enforces it | role specialization omitted; the schema enforces it | role specialization kept; prose is the only constraint |

### Why the prompt is trimmed per role

The prompt sits at the head of an agentic conversation, so every byte is re-read on every turn of the run. Issue #6 measured one Builder execution at 4.88M cached tokens against 110 uncached input tokens, and one Tester at 2.40M. Against a contract of roughly 11 KB, that is the prompt being re-read on the order of a hundred turns or more.

The result contract therefore hides the rows and rules a role cannot act on: a delivery role never sees the `spec`, `acceptanceCriteria`, `taskAssessment` or `nextRole` rows, because its schema pins all four to a single value, and the list is derived from that schema rather than maintained by hand, so prompt and schema cannot drift. Roles no longer share one byte-identical prefix. That earlier invariant saved one cache write of about 2000 tokens per execution, once and only inside the cache TTL, while a byte a role cannot use costs a cache read on every turn.
| Read-only roles | `--sandbox read-only` | read-only tool allowlist | `--mode ask` |
| Writing roles | `--sandbox workspace-write` with network | edit, write and shell tools | `--force` |
| Token usage | reported on stderr | reported in the JSON envelope | not reported; executions show Unavailable |
| Authentication check | `codex login status` | `claude auth status` | `cursor-agent status --format json` |

An invalid Cursor final message fails the execution with a readable reason instead of being re-run silently; `/factory retry` restarts it under human control.

## Inspecting and auditing

- `npm run factory -- models`: show the configured provider and model for every role without running an agent.
- `npm run factory -- models <work-item-id>`: preview the configured model and routing reason for each role.
- `npm run factory -- events <work-item-id>`: inspect `model.selected` and `execution.started`. Each run records policy version, provider, configured model, reason. With `auto`, the provider's resolved backend model is not independently attested.

No prices, token budgets or automatic provider switching are inferred. Real model availability and quality require acceptance runs; subprocess fixtures verify routing and arguments only.

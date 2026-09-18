# AI Software Factory

Locally executed multi-agent software factory orchestrated from a developer Mac.

## MVP

A GitHub Issue becomes a work item. The local orchestrator coordinates four independent roles:

1. **Product / Architect — Claude**: clarifies the request, challenges assumptions, proposes alternatives, and produces the specification.
2. **Developer — Codex**: implements the approved specification in an isolated Git worktree.
3. **QA — Codex**: independently derives tests from the specification, may create/modify test code, and reports findings without modifying production code.
4. **Reviewer — Claude**: reviews specification compliance, code quality, security, performance, and product/UI/copy consistency.

The human remains the authority for major product/architecture decisions and any change that contradicts a previously approved human decision.

## Core principles

- Orchestration runs **locally on macOS**.
- GitHub is the visible/auditable collaboration surface, not the execution engine.
- Every role runs in a fresh, independent agent context.
- Agent providers are adapters and can be replaced.
- Approved specs are versioned contracts.
- Every execution and state transition is observable and cancellable.
- Slack is notification-only; decisions happen in GitHub.
- Agents may use the Internet. Secrets are exposed only when explicitly configured.

The consolidated requirements and traceability matrix are in [SPEC.md](SPEC.md).

See [ARCHITECTURE.md](ARCHITECTURE.md) and [INSTALL.md](INSTALL.md).

## Run the MVP

```sh
npm ci
npm run build
npm test
cp .env.example .env
# Configure target repository and approvers, then:
npm run factory -- doctor
npm run factory -- start
```

Queue an issue with `factory:queued`. Answer `/factory answer <text>` and approve the posted version with `/factory approve vN`. The daemon runs independent role processes, routes findings, and creates a pull request after passing QA and review. Human merge remains required.

Available commands: `doctor`, `start`, `status [id]`, `events [id]`, `cancel <item-or-run-id>`, `retry <item-id>`, `stop`, `notifications`, `slack-test`, `models [id]`, `sync`.

See [installation and operations](INSTALL.md), [GitHub setup](docs/GITHUB_SETUP.md), and [validation evidence and operational boundaries](docs/VALIDATION.md).

Model routing balances quality, cost and time using an approved complexity/risk assessment, role floors and correction escalation. See [model selection policy](docs/MODEL_POLICY.md).

GitHub issues show the workflow through colored state labels and an updatable progress comment. Reports use readable Markdown; full JSON evidence stays in the local audit. The issue remains open until the delivered PR is merged.

Merged PRs reconcile to `MERGED`; closed unmerged PRs to `PR_CLOSED`. Run `npm run factory -- sync` when the daemon is stopped to refresh delivery state without running agents.

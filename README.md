# AI Software Factory

Local-first multi-agent software factory orchestrated from a developer Mac.

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

Available commands: `doctor`, `start`, `status [id]`, `events [id]`, `cancel <item-or-run-id>`, `retry <item-id>`, `stop`.

See [installation and operations](INSTALL.md), [GitHub setup](docs/GITHUB_SETUP.md), and [validation evidence and remaining live check](docs/VALIDATION.md).

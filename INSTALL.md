# macOS Installation — MVP

This document describes the target local setup. Commands will be finalized as the implementation lands.

## Prerequisites

Install Homebrew, then:

```bash
brew install git gh node
```

Authenticate GitHub:

```bash
gh auth login
gh auth status
```

Install and authenticate the current supported **Codex CLI** and **Claude Code/CLI** according to their official installation instructions. The factory will invoke both locally; credentials remain in their normal local credential stores rather than in this repository.

## Clone

```bash
git clone git@github.com:lucaslodeiro/ai-factory.git
cd ai-factory
npm install
cp .env.example .env
```

## Configuration

The factory will require:

- GitHub repository/owner configuration.
- Slack webhook/app configuration for notifications.
- Local workspace root.
- Agent command/configuration overrides where necessary.
- Explicit allow-list of secrets an agent may receive.

Never commit `.env`, provider credentials, GitHub tokens, Slack secrets, or application secrets.

## Preflight

Target command:

```bash
npm run factory -- doctor
```

`doctor` will verify Node, Git, GitHub authentication, Claude, Codex, SQLite/storage, workspace permissions, and Slack configuration.

## Run

Target commands:

```bash
npm run factory -- start
npm run factory -- status
npm run factory -- cancel <work-item-or-run-id>
npm run factory -- retry <work-item-or-run-id>
npm run factory -- stop
```

The first end-to-end test will use a separate demo application repository. Create a GitHub Issue there; the local factory discovers it, begins Product/Architect clarification/specification, and pauses when human input is required.

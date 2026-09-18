# GitHub Setup

The MVP uses GitHub Issues as the human collaboration interface. Execution remains local.

## Required labels
Create these labels in the target application repository:

- `factory:queued` — human requests factory pickup.
- `factory:spec` — Product/Architect phase.
- `factory:waiting-human` — explicit human decision required.
- `factory:development`
- `factory:qa`
- `factory:review`
- `factory:ready-to-merge`
- `factory:failed`
- `factory:cancelled`

## Starting a work item
Create a normal Issue describing the desired feature and apply `factory:queued`. The local daemon polls for this label and creates its internal work item.

GitHub comments and labels are an auditable UI/event surface. SQLite remains the authoritative workflow state.

## Human approval
The next implementation slice will consume explicit approval/change-request commands from issue comments rather than inferring approval from conversational language. This keeps transitions deterministic.

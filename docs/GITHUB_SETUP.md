# GitHub setup

Authenticate `gh` with issue, content and pull-request write access to the target repository; issue write access also covers the sub-issue and dependency relationships an epic creates for its stories (the parent must be set by an account with triage access to the repository). Configure `GITHUB_REPOSITORY`, `FACTORY_REPO_DIR`, `GITHUB_DEFAULT_BRANCH`, `FACTORY_APPROVERS` and optionally `FACTORY_INSTANCE_NAME` in the dashboard, then validate them with Doctor. The instance name defaults to the machine hostname and becomes the `factory-instance:<name>` issue label.

The authenticated GitHub account is the Factory account. Assign an open issue to that account to offer it to the Factory. `ai-factory start-issue <number-or-url>` and Dashboard **Add Issue** perform the assignment and add this installation's instance label. The daemon starts work only on a later poll that confirms its label is the sole instance label. A simultaneous claim leaves both labels visible and neither installation starts. Dashboard **Work here** replaces another instance label with this installation's label; the previous installation pauses on its next poll.

Unassigning the Factory account pauses the work and publishes preserved partial changes. Assigning it again is enough to resume: the Factory restores its instance label on one poll and continues on the next. Moving the instance label transfers ownership. While human input is needed, the issue remains assigned to the Factory account and uses `factory:waiting` plus the status comment. On completion or cancellation the Factory account and its instance label are removed. `FACTORY_APPROVERS` still controls approvals, answers and other workflow commands.

Factory-authored comments also carry hidden, validated workflow facts. Specifications live once in their milestone comments; the editable status comment carries only a state index that points to them. Another installation reads the issue and the deterministic work branch to continue the same workflow id. Stable published states continue automatically. A published `RUNNING` or `QUEUED` state is shown as waiting so two installations cannot run it accidentally; use Dashboard **Continue anyway** only after confirming the source installation has stopped. `ai-factory issue show <number>` prints the published index and its specification-version approval summaries. Execution logs, prompts, credentials and local paths are never included.

Available issue commands are:

- `/factory help`
- `/factory approve vN [guidance]` — approves the brief, the SPEC and, when the Architect split the issue, its stories
- `/factory answer <text>`
- `/factory retry [--issue] [--for <roles>] [guidance]`
- `/factory note [--issue] [--for <roles>] <text>`
- `/factory replace <#N|id-prefix> [--issue] [--for <roles>] <text>`
- `/factory revoke <#N|id-prefix>`
- `/factory budget +<tokens> [reason]`
- `/factory pause [reason]`
- `/factory cancel [reason]`

Commands must be the first or last non-empty line of a comment from an authorized approver. Processed commands are immutable; post a new comment to change an instruction. Workflow labels are projections created and changed automatically. The mutable status comment identifies the responsible instance and contains the one current action.

The deterministic branch `factory/issue-<n>` is pushed after every Factory commit. Before each execution the Factory merges human commits on that branch and the work item's base branch: the repository default branch for an issue, the epic branch for a story. A story is a sub-issue of its epic, blocked by the stories it waits for; it starts when every blocker is closed as completed, opens no pull request and is merged into the epic branch by the Factory, which then closes the story issue. Conflicts stop the workflow for human resolution and Retry. If code changes after Test passed, the workflow returns to Test before Review or Delivery.

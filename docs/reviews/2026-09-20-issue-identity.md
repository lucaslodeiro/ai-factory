# Issue identity and command-surface review

## Decisions

1. **Agree.** `Issue` lacked stable GitHub identity and lifecycle fields, `Comment` lacked `updatedAt`, and the adapter did not expose repository identity.
2. **Agree.** Intake and orchestrator reused any `(repo, issue_number)` row, including an item for a deleted and recreated issue.
3. **Agree.** Reconciliation only handled close/reopen and refreshed content in limited paths; it could not identify replacement objects.
4. **Agree.** A last-line start was prose for tracked work, while untracked discovery only recorded an internal rejection for malformed starts.
5. **Agree.** The data directory was bound only to the configured repository name; neither doctor nor daemon validated GitHub repository identity.
6. **Agree.** The parser only inspected the first non-empty line.
7. **Agree.** Start discovery only read repository comments and checkpointed them primarily by comment id; issue descriptions were absent.
8. **Agree.** Tracked comment polling never revisited ids at or below the cursor and stored only an aggregate observation count.

Implementation decisions:

- **K1–K2, K4–K5, K7–K9: agree.** The proposed changes were the smallest coherent fixes for the validated behavior.
- **K3: agree, different implementation detail.** Repository identity validation uses one shared helper so daemon startup, doctor and dashboard configuration use the same comparison and refusal text.
- **K6: agree, with the prompt's explicit test interpretation.** A non-approver description start is silent on GitHub, while an internal `command.rejected` audit event records why it was ignored.

## Changes

### K1 — `5e786d0` (`fix: K1 carry GitHub identifiers`)

- Added issue, comment and repository identity fields to the GitHub port and adapter.
- Bumped the fresh schema to 5, added `issue_id`, `issue_node_id`, `issue_created_at`, and made `issue_identity` unique only for non-archived rows.
- Intake persists the remote identity.
- Storage and intake tests assert the new columns, partial index and persisted values.

### K2 — `4d654b2` (`fix: K2 archive replaced GitHub issues`)

- Files: `src/workflow-orchestrator.ts`, `test/workflow-orchestrator.test.ts`.
- Reconciliation detects a changed issue id, pauses runnable stale work, archives it, suppresses notifications and records `github.issue_replaced` without publishing on the replacement.
- Test `a replaced GitHub issue archives stale work without publishing and can start a distinct item` asserts the archive, event, absence of GitHub publication and second work item.

### K3 — `76368fa` (`fix: K3 bind data directory to repository id`)

- Files: `src/repository-identity.ts`, GitHub adapter, daemon, doctor, dashboard and `test/repository-identity.test.ts`.
- First validation stores `{id,nodeId,fullName}` in metadata. A different id produces the requested empty-data-directory refusal.
- Tests cover first binding, mismatch, daemon lock ordering and doctor output.

### K4 — `d905faa` (`fix: K4 keep issue context current`)

- Every visibility reconciliation refreshes title, body and URL when changed. Only a title change increments presentation revision.
- Test `visibility reconciliation refreshes issue content and presents only title changes` asserts body-only, title and unchanged paths.

### K5 — `ceaf912` (`feat: K5 accept commands on boundary lines`)

- Every command accepts the first or last non-empty line; all other lines form payload in original order. First wins when both boundaries are commands; middle and quoted commands remain inert.
- Parser tests cover start, approve, answer, retry symmetry, first-wins, middle and quoted cases. An inbox test confirms a tracked last-line start is rejected visibly as a command.

### K6 — `823d96f` (`feat: K6 start work from issue descriptions`)

- Added updated-issue discovery with five-minute lookback/five-second overlap and per-issue `updatedAt` evaluation.
- An open, non-PR issue authored by an authorized human can start from its description; guidance is issue-scoped and the initial cursor snapshots existing comments.
- Tests cover successful start, guidance, cursor snapshot, idempotency, unauthorized audit without public feedback and a later valid edit.

### K7 — `730d190` (`feat: K7 explain misplaced start commands`)

- Approver-authored quoted or middle-position starts on untracked issues receive one immutable, per-edit hint; unauthorized text remains silent.
- Test `misplaced approver starts in comments and descriptions receive one idempotent hint` covers both surfaces, idempotency and a corrected edit.

### K8 — `86ff1df` (`fix: K8 reevaluate edited observed comments`)

- `observedComments[{id,updatedAt}]` replaces the count. Changed observations are reevaluated before new ids; applying a later command clears and freezes them. Processed commands are never reread.
- Start discovery checkpoints each untracked comment edit by `(id,updatedAt)` within the lookback window.
- Near-miss factory tokens within edit distance two produce an `unrecognized` outcome and suggestion but never execute.
- Tests: `an observed typo can be edited into a command on the same comment id`, `an applied command is frozen when its comment is edited`, `a later applied command freezes earlier observed prose edits`, and `an untracked typo comment can be edited into start exactly once`.

### K9 — `2cf3ed9` (`docs: K9 document issue identity and command edits`)

- Updated the design specification, README, INSTALL, GitHub setup and dashboard empty-state copy.
- Documented schema 5, repository binding, replaced issue handling, description start, boundary grammar, typo hints and edit/freeze rules.

## Operator-visible behavior

- Schema version is now 5. Existing runtime databases are intentionally refused; use a fresh data directory.
- A data directory belongs to one stable GitHub repository id, even if another repository later uses the same `owner/name`.
- Recreating issue `#N` archives the stale item and does not project old labels, status or SPEC state onto the replacement.
- `/factory` commands work on the first or last non-empty line. `/factory start` also works in an approver-authored issue description.
- Approver-authored misplaced starts and near-miss spellings receive a readable hint.
- Observed prose or a near miss can become a command through an edit until a later command is applied. Any comment already processed as a command is frozen.

## Verification

Baseline on `main` (`9749342`):

- `PATH=/usr/local/Cellar/node/26.4.0/bin:/usr/local/git/bin:$PATH npm test` — 125 passed, 0 failed.

Focused verification included:

- `node --import tsx --test test/workflow-orchestrator.test.ts` — 8 passed, 0 failed after K7.
- `node --import tsx --test test/workflow-inbox.test.ts test/workflow-orchestrator.test.ts` — 28 passed, 0 failed after K8.
- First integrated `npm test` — 137 passed, 2 failed. Both failures were outdated GitHub test executables that lacked repository identity and updated-issue responses.
- `node --import tsx --test test/dashboard.test.ts test/daemon.test.ts` after updating those fakes — 2 passed, 0 failed.

Final verification:

- `PATH=/usr/local/Cellar/node/26.4.0/bin:/usr/local/git/bin:$PATH npm test` — 139 passed, 0 failed, 0 skipped.
- `PATH=/usr/local/Cellar/node/26.4.0/bin:/usr/local/git/bin:$PATH npm run build` — passed.
- `git diff --check` — passed with no output before this report was added.

No live GitHub repository or owner installation was modified.

## Documentation

- `docs/CONTEXT_AND_WORKFLOW_DESIGN.md` §5.3–5.4: boundary grammar, description start, typo feedback and edited-comment lifecycle.
- §7.2: description start, issue replacement and metadata refresh transitions.
- §10: schema 5, fresh-directory cutover, repository-id binding and recreated issue behavior.
- `README.md`, `INSTALL.md`, `docs/GITHUB_SETUP.md`: operator start placement, edits, replacement recovery and repository binding.
- Dashboard empty state: description or comment start guidance.

## Operator recovery for the current incident

Run these steps only after installing a build containing these commits. They deliberately preserve the old data directory for audit.

```bash
cd "$HOME/ai-factory"
ai-factory service stop all

# Keep the old schema-4 data untouched and select a fresh directory.
ai-factory configure
# At FACTORY_DATA_DIR enter: .factory-v5
# Keep GITHUB_REPOSITORY set to: lucaslodeiro/ai-factory-demo

# Load the configured target path, inspect it, then replace its local contents.
set -a
source .env
set +a
ai-factory repo check
ai-factory repo clear --confirm "$FACTORY_REPO_DIR" --repeat "$FACTORY_REPO_DIR"
ai-factory repo restore
ai-factory repo check

ai-factory service start all
ai-factory doctor
```

In GitHub, manually remove every stale `factory:*` label and delete the stale AI Factory status comment from the recreated issue. Then either edit the issue description so `/factory start` is its first or last non-empty line, or post a new comment with `/factory start` on its first or last non-empty line.

If `repo check` shows local work that must be preserved, stop before `repo clear`, move or commit that work manually, and repeat the check. `repo clear` requires the same absolute configured path twice by design.

## Open questions

None. The requested cutover intentionally has no importer or backward-compatibility reader.

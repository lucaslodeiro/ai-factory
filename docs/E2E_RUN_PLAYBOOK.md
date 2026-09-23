# End-to-end run playbook

A guided observation of the whole workflow on a real GitHub issue: assignment, specification, approval from the dashboard, build, factory verification, correction loop, review, pull request and merge. It is not a regression suite; `npm test` is. Use it after a release-scale change, and record what differs from the expectations written here.

Three runs, in order. Run A is the happy path. Run B forces the correction loop with a broken base. Run C forces the correction limit and the human request. Section 5 lists optional interventions to try on top of A or B.

## 0. Preparation (once)

Target repository: a disposable, small Node project whose `npm test` passes on `main` in under two minutes. Do not use a real product for the first run.

Configuration (Dashboard → Configuration, or `.env` in the factory home):

```
GITHUB_REPOSITORY=<owner>/<disposable-repo>
FACTORY_REPO_DIR=/absolute/path/to/clone
GITHUB_DEFAULT_BRANCH=main
FACTORY_APPROVERS=<your login>
FACTORY_INSTANCE_NAME=<short name>
FACTORY_VERIFY_COMMAND=npm test
FACTORY_MAX_FIX_CYCLES=1
FACTORY_EXECUTION_TIMEOUT_MS=600000
FACTORY_ISSUE_BUDGET_TOKENS=500000
```

Before starting:

```sh
ai-factory doctor          # every line ✓, including "Target checkout directory exists"
ai-factory service restart all
```

Keep the dashboard open for the whole run. Note the start time.

## 1. The test issue

Write it yourself. Small, verifiable, with one deliberately ambiguous point to see whether Architect asks or decides. Template:

```
Title: Add `slugify(text)` to utils

We need a `slugify` function in `src/utils.js` that turns a title into a URL slug.

- Lowercase, spaces to hyphens, drop anything that is not a letter, digit or hyphen.
- It must have tests in the existing suite.
- Export it from the package index.

Open point: I do not know whether accents should be removed or transliterated (é → e). Decide, or ask me.
```

The last line is the bait. Record whether Architect asked, or decided and wrote the decision into the specification.

## 2. Run A — happy path

Assign the issue to the Factory account from GitHub. Do not use Add Issue yet: this run observes plain assignment.

| Step | Do | Look at | Expected |
| --- | --- | --- | --- |
| A1 Claim | Wait two polls (~30 s) | Issue labels; dashboard | `factory-instance:<name>` appears; the item enters the queue as Design · Running |
| A2 Spec | Wait for Architect | "Specification v1 — awaiting approval" comment; status comment | Acceptance criteria with IDs; the ambiguous point resolved or asked; exactly one "Next action". If it asked: the item is Waiting and the dashboard thread offers "Send answer" |
| A3 Approval | From the dashboard only: the item is first in the queue with its conversation open; write one line of guidance and click "Approve specification" | The issue | Your `/factory approve v1 <guidance>` comment appears first, under your login, and only then the state changes to Build. Record the seconds between the click and Build |
| A4 Build | Wait for Builder | `git fetch && git log --oneline origin/factory/issue-<n>` | One commit `factory(Builder): <first summary line> (#n)`. Does the message describe the change, or is it generic? |
| A5 Test | Wait for Tester | Tester comment; `ai-factory events <id>` | "Tests" table with the command and exit 0; a `verification.completed` event with `exitCode:0` and the configured command |
| A6 Review | Wait for Reviewer | Reviewer comment | Every review dimension passed; no "I executed" wording (the role is read-only) |
| A7 Delivery | Wait for the PR | `gh pr view --json body` | Sections: Closes, approved spec v1 by you, Summary, Factory verification with the command and exit 0, the Tester tables, no specification body. Item in Delivery · Waiting with a merge request |
| A8 Merge | Merge the PR on GitHub | Dashboard and issue after one poll | Item Completed; the Factory unassigns itself and removes its label; the issue closes through `Closes` |

Record at the end: total duration, duration per stage, tokens per stage (dashboard Usage panel), number of comments the Factory left on the issue.

## 3. Run B — correction loop with factory verification

Same repository, new issue (another small function). Before assigning it, plant a failure on `main`: make an existing test fail with a recognizable message, for example `assert.equal(add(2,2), 5, "SEED-FAIL")`, and push it. This is a realistic situation: a broken base the Factory inherits.

| Step | Look at | Expected |
| --- | --- | --- |
| B1 | Tester comment | Either (a) Tester runs the suite, sees it fail and returns `changes` with an `auto-fix`, or (b) Tester declares pass without running everything and factory verification catches it. Both are informative |
| B2 | `ai-factory events <id>` | In (b): `verification.completed` with `exitCode:1` and `SEED-FAIL` in `outputTail`; transition to Build · Queued with reason `changes`; the `auto-fix` finding carries the command and the output |
| B3 | Second Builder prompt (thread → "Reveal full prompt") | A section with the changed files and `diff --stat` of the previous attempt, plus the finding with the test output |
| B4 | Second Builder commit | Did it fix the planted test, or flag it as out of scope and request a decision? Either is valid; it must be explicit |
| B5 | Second Tester and verification | `verification.completed` with exit 0; `correctionCycles` is 1 in `ai-factory status <id>` |
| B6 | PR | As A7. The issue's transition list shows the whole cycle |

Afterwards revert the planted test on `main`, or note that the PR fixed it and the Factory touched code outside the specification.

## 4. Run C — correction limit and human request

New issue. Change the configuration before assigning it:

```
FACTORY_VERIFY_COMMAND=sh -c 'npm test && exit 1'
FACTORY_MAX_FIX_CYCLES=0
```

Verification now always fails, even when the tests pass.

| Step | Expected |
| --- | --- |
| C1 | With `FACTORY_MAX_FIX_CYCLES=0`, Tester pass → verification exit 1 → **Test · Waiting** with reason `correction-limit` and a human request, before any Builder correction |
| C2 | The issue carries `factory:waiting`; the status comment says the limit was reached and shows the finding with `exited 1`; the item is first in the dashboard queue with its conversation open |
| C3 | Fix the configuration (`FACTORY_VERIFY_COMMAND=npm test`), restart the daemon, and from the dashboard thread click **Send answer** with guidance such as "Verification was misconfigured; change nothing" |
| C4 | The answer is published on the issue before the transition; the item goes to Design · Queued (`human-answer`), Architect resolves the consultation (`tactical-resolved`), and Builder continues with `correctionCycles` back to 0; the rest proceeds as in A |

What matters here is how much it cost you to understand what happened and what to do without opening GitHub. Note every time you had to go to GitHub or the logs to understand something.

## 5. Interventions during a run (optional, pick two)

- **Note in flight**: while Builder runs, send "Add note" with a constraint ("do not add dependencies"). Expected: the comment appears on the issue immediately; the note is in the next agent's prompt; the current execution is not interrupted.
- **Interrupt and retry**: while Builder runs, "Interrupt and retry with this" with a correction. Expected: the execution ends, the item goes Paused `interrupted-for-guidance` and is re-queued; the new Builder prompt has a "Previous attempt" section with the files and diff stat of the cut attempt. If that role runs on Codex, the cut run has no reported usage, so the item then waits for `/factory budget +0`; on Claude the usage streamed before the cut is kept as partial and it does not wait.
- **Human commit on the branch**: between Build and Test, push a commit of yours to `factory/issue-<n>`. Expected: Tester syncs and includes it. Between Test and Review: Review sees a HEAD different from the verified one and returns to Test with reason `code-changed`.
- **Budget hold**: before assigning a new issue, set `FACTORY_ISSUE_BUDGET_TOKENS` to a value below one run (for example `1000`) and restart the daemon. Expected: Architect runs and finishes, its SPEC is published, and after approval the item goes to **Build · Waiting** with reason `budget-exhausted`, a "Token budget" row in the status comment and no Builder execution. From the dashboard thread click **Extend token budget** with `+2000000 test`: the command is published on the issue with your login, and Builder starts on the next tick.
- **Unassign and reassign**: during Build, unassign the issue. Expected: item Paused `unassigned`, instance label removed, no active execution. Reassign: the Factory restores its label and resumes where it was.

## 6. Run D — an epic with two stories (optional)

Use an issue with two deliverables that touch different files and can be verified apart, for example a new data file plus a page that renders it, with one criterion that only holds for the whole. Assign it as in Run A.

| Step | Do | Look at | Expected |
| --- | --- | --- | --- |
| D1 Split | Wait for Architect | Specification comment | A "Stories" table between the criteria and the approval command, and the split named as a decision in the brief; criteria owned by no story listed as verified on the whole |
| D2 Approval | `/factory approve v1` | Epic status; the repository issues | Epic Build · Waiting "stories are being delivered"; on the next poll two sub-issues under the epic, the second showing "blocked by" the first; the first assigned to the Factory account with the epic's instance label |
| D3 Story 1 | Wait for Builder and Tester | `git log --oneline origin/factory/issue-<s1>`; story comments | Commits on the story branch, no Reviewer comment, no pull request; then `origin/factory/issue-<epic>` gains one merge commit "integrate factory/issue-<s1>" and the story issue closes as completed |
| D4 Story 2 | Wait one poll | Second story issue | Assigned and started only after the first closed; same path as D3 |
| D5 Epic | Wait for Tester and Reviewer on the epic | Epic comments; PR | Tester covers every criterion on the epic branch; Reviewer sees the whole diff; one PR against the base branch that closes the epic issue |
| D6 Budget | Dashboard Usage panel on the epic and a story | | The same family total on both; `/factory budget +N` on a story issue also raises the epic's |

Record: tokens per story and for the epic's own runs, the number of polls between a story closing and the next one starting, and whether the split was worth it against a single-issue run of the same change.

## 7. What to record

One row per run:

| Run | Duration | Cycles | Tokens in/out | Comments on the issue | Times I went to GitHub or logs to understand | Surprises |
| --- | --- | --- | --- | --- | --- | --- |

And a critical reading of run A's pull request, the artifact a human teammate would see: would you merge it from the body alone? What is missing?

## 8. What I expect to show up

Written down so they are not surprises, and so they can be confirmed or dismissed:

1. The status comment is still long; after three or four agent reports the issue is heavy to read on a phone (FAC-14 in the audit, noted).
2. The first line of an agent summary may be a poor commit message ("Implemented the requested changes"). If so, the fix is in the prompt, not the code.
3. In run B, if Tester catches the failure first, factory verification is not exercised. That is why run C exists.
4. If Reviewer cites the Tester's evidence rather than the factory verification, its context does not yet include `verification.completed`. That would be the next small item.
5. With the daemon stopped, the dashboard buttons are disabled without an explanation. If that confuses you while restarting in run C, it is worth reopening.

# Repository controller lease implementation review

## P0 — Remote ref reality check

**Decision: agree, with a corrected CAS probe.** GitHub accepts `refs/ai-factory/lease`. The repository previously named `lucaslodeiro/ai-factory-demo` was no longer present, so the probe used `lucaslodeiro/factory-demo`. The request's stale probe reused the current commit; Git treated that as a no-op and returned `Everything up-to-date`. The recorded probe therefore used a second orphan commit for the stale write. GitHub rejected it with `stale info`, proving the intended compare-and-swap behavior. The temporary ref was deleted and the final `ls-remote` returned no row.

```text
$ git push origin "${sha}:refs/ai-factory/lease" --force-with-lease=refs/ai-factory/lease:
To https://github.com/lucaslodeiro/factory-demo.git
 * [new reference]   15d8de60f78bab9bd3f97062be1303ed814534cd -> refs/ai-factory/lease
$ git ls-remote origin refs/ai-factory/lease
15d8de60f78bab9bd3f97062be1303ed814534cd refs/ai-factory/lease
$ git push origin "${sha2}:refs/ai-factory/lease" --force-with-lease=refs/ai-factory/lease:0000000000000000000000000000000000000000
To https://github.com/lucaslodeiro/factory-demo.git
 ! [rejected]        ac76e728494de40da1a27a30feb5db6db81a517a -> refs/ai-factory/lease (stale info)
error: failed to push some refs to 'https://github.com/lucaslodeiro/factory-demo.git'
rejected_status=1
$ git push origin ":refs/ai-factory/lease" --force-with-lease=refs/ai-factory/lease:${sha}
To https://github.com/lucaslodeiro/factory-demo.git
 - [deleted]         refs/ai-factory/lease
$ git ls-remote origin refs/ai-factory/lease
```

## P1 — Instance identity and read-only status

**Decision: agree.** `src/instance.ts` creates and validates the stable installation identity. The installer preserves it across retries and basic uninstall. `src/controller-lease.ts` reads and validates the remote record through `<home>/data/controller.git`; `src/storage.ts` adds the fresh-schema controller cache; `src/cli.ts` and `src/doctor.ts` expose status independently from GitHub authentication and the daemon lock.

Tests: `installation identity is created once and preserved`; `controller read reports absent and validates a current local-bare lease`; `controller read rejects malformed and mismatched records`; installer maintenance and uninstall script suites.

Commit: `ca07995` (`feat: P1 add controller identity and status`).

## P2 — Atomic lifecycle

**Decision: agree.** Acquire, renew, release and takeover use one private ref writer. It first verifies the current remote SHA and then always invokes the exact `--force-with-lease=refs/ai-factory/lease:<expected>` form. Lease commits are created with Git plumbing in the dedicated bare repository. Same-instance reclaim keeps the generation; cross-instance takeover increments it once; expiry never performs an automatic takeover.

Tests: `two isolated homes racing on an absent ref produce one active and one standby`; `renewal requires the exact observed sha and same-instance reclaim keeps generation`; `expired and forced takeovers increment generation and only one stale contender wins`; `release refuses unsafe work unless forced and deletes the ref with CAS`; `all controller ref writes use the single explicit compare-and-swap function`.

Commit: `6766b58` (`feat: P2 add atomic controller lifecycle`).

## P3 — Startup gate, standby and remote visibility

**Decision: agree.** `startDaemon` verifies repository identity and acquires before abandoned-run recovery or orchestration. Standby is a healthy daemon mode and skips the orchestrator. The service API, snapshot, launcher status and dashboard expose cached controller state. The dashboard has controller views in Services and Project configuration, presents remote factory-labelled issues separately from local state, and removes workflow and repository mutations while standby.

Tests: `standby controller cycle performs no polling, scheduling or publication`; `dashboard explains active and standby repository control and removes standby workflow actions`; dashboard API coverage in `dashboard serves readable state and queues daemon controls`.

Commits: `cc05594` (`feat: P3 gate daemon startup with repository control`) and `4255050` (`fix: P6 close standby mutation gaps`).

## P4 — Fencing, uncertainty and held results

**Decision: agree, with an in-memory held-result buffer.** The three mutation boundaries call the controller fence: command application, execution/delivery start and projection flush. A monotonic ten-minute verification window moves active control to `uncertain` and blocks mutations. A completed result is retained only in daemon memory; the event log stores content-free markers. Same-generation recovery applies it. Ownership loss discards it, interrupts active work with `controller-lost`, pauses the projection and records `controller.lost`.

Tests: `controller fencing rejects a human command before workflow state changes`; `publisher flush verifies repository control before any GitHub mutation`; `renewal verification outage becomes uncertain after the lease window and blocks mutations`; `uncertain controller holds a completed result and applies it after ownership recovery`; `a held result is discarded after repository control is lost`; `controller loss interrupts active work and pauses its projection`; the two-factory end-to-end test fences the old generation.

Commits: `d5a313c` (`feat: P4 fence workflow mutations and hold results`), `6c97363` (`fix: P6 verify controller lifecycle boundaries`) and `43ccb2b` (`test: P6 verify controller loss interruption`).

## P5 — Release, attribution and takeover notice

**Decision: agree.** Both uninstall modes attempt release after stopping services and before deleting the engine. Failure preserves the installation and prints the exact takeover command unless `--force` explicitly allows local removal. Status comments carry controller and generation; milestone comments carry the controller display name. A takeover publishes one idempotent notice per open factory-labelled issue lacking local state.

Tests: `scripts/test-uninstall.mjs` asserts release invocation, refusal and forced local removal; `status and milestone attribution use the controller display name and generation`; `takeover notice is emitted once per untracked issue and generation`.

Commits: `8c6bc2a` (`feat: P5 release and attribute repository control`) and `6c97363` for the uninstall boundary assertions.

## P6 — Cutover and two-factory proof

**Decision: agree.** `README.md`, `INSTALL.md` and `docs/GITHUB_SETUP.md` document the guarantee, permissions, standby, explicit takeover and the mandatory stop/upgrade cutover for lease-unaware daemons. The end-to-end test uses two stores and homes, one local bare origin and one shared fake GitHub surface. A true multi-process absent-ref race prevents in-process scheduling from hiding a CAS defect.

Tests: `two factory homes create one workflow, expose standby ownership and fence the old owner after takeover`; `two isolated homes racing on an absent ref produce one active and one standby`; macOS maintenance installer coverage for preserved identity.

Commits: `788d001` (`feat: P6 document and verify controller cutover`), `50a7153` (`fix: P6 preserve controller identity on install retry`), `7968f61` (`test: P6 race isolated controller acquisitions`), `6c97363` and `43ccb2b`.

## Verification

Baseline stated by the request: **149 tests**.

- `npm test` in the final branch-only worktree: **168 passed, 0 failed** in 19.66 seconds.
- `rm -rf dist && npm run test:all` on macOS, from the same commit on a temporary named branch: **168 passed, 0 failed**; build passed; installer, maintenance, uninstall, configure and dashboard-config script suites all printed `PASS`.
- `npm run build`: passed during focused controller validation.
- `node --import tsx --test test/controller-startup.test.ts test/controller-lease.test.ts test/controller-dashboard.test.ts test/workflow-runner.test.ts`: **17 passed, 0 failed**.
- `node --import tsx --test test/controller-fencing.test.ts`: **2 passed, 0 failed**.
- `node scripts/test-uninstall.mjs`: passed, including release failure and `--force` behavior.
- `git diff --check`: clean.

No test was retried to hide a failure. The first clean `test:all` invocation used a detached worktree: its 168 code tests passed, then `test-macos-installer.sh` failed because `git branch --show-current` returned an empty string and the fixture tried to clone an empty branch. The gate was rerun on the identical commit through a temporary named local branch and passed completely. An attempted `git switch` setup command also failed because the host Git does not support that subcommand; `git checkout -b` was used instead. The shared checkout contains unrelated uncommitted startup/configuration work; it is intentionally excluded from every controller commit.

## Acceptance checklist

- [x] **One winner in an absent-ref race.** `two isolated homes racing on an absent ref produce one active and one standby` uses two operating-system processes and isolated homes.
- [x] **Standby performs no workflow mutation.** `standby controller cycle performs no polling, scheduling or publication`, controller command/flush fence tests, and dashboard mutation guards.
- [x] **Standby names the owner and explains empty local state.** `dashboard explains active and standby repository control and removes standby workflow actions`.
- [x] **Ten-minute outage becomes uncertain with no mutation.** `renewal verification outage becomes uncertain after the lease window and blocks mutations` uses a fake monotonic clock.
- [x] **Held result applies or discards correctly.** The two `WorkflowRunner` held-result tests.
- [x] **Higher generation interrupts and pauses.** `controller loss interrupts active work and pauses its projection` and the end-to-end old-owner fence assertion.
- [x] **Restart/update reclaim only the same instance.** `renewal requires the exact observed sha and same-instance reclaim keeps generation` plus the stable identity installer tests.
- [x] **Uninstall release is explicit and safe.** `scripts/test-uninstall.mjs`.
- [x] **Expiry alone never takes over.** `expired and forced takeovers increment generation and only one stale contender wins` first rejects non-forced early takeover; daemon standby only rereads.
- [x] **Takeover race has one winner.** The same takeover test uses two stale observations and requires one `ControllerCasError`.
- [x] **Force takeover is confirmed and audited.** CLI requires typed repository name unless scripted `--yes`; the takeover test proves generation and owner replacement, and `controller.takeover` records both display names.
- [x] **Rename is stable; recreated repository is rejected.** `repository identity is stored once and a different GitHub repository id is refused` and lease record identity validation.
- [x] **Lease never touches the application checkout.** Controller tests operate only on `<home>/data/controller.git`; the source grep test proves one CAS writer and forbids unconditional force pushes.
- [x] **Lease data and controller events contain no secrets or work content.** Strict record validation and content-free held/controller event assertions; only neutral display name, repository identity and counters are emitted.
- [x] **Standby remote issue view is read-only.** Dashboard controller test plus server mutation guards.
- [x] **Active view distinguishes untracked remote work without importing it.** Dashboard API maps GitHub issue id to local state and exposes `Not tracked here`; no state importer exists.
- [x] **Issue attribution includes controller and generation.** `status and milestone attribution use the controller display name and generation`.
- [x] **Takeover notice is exactly once per issue and generation.** `takeover notice is emitted once per untracked issue and generation` and the two-factory end-to-end test.

## Limitations

- The GitHub P0 probe used the renamed `lucaslodeiro/factory-demo` repository because `lucaslodeiro/ai-factory-demo` no longer existed.
- Cooperative fencing cannot stop a legacy daemon that does not implement this protocol. The documented cutover requires stopping all such daemons before upgrade.
- Held result bodies are intentionally memory-only. A daemon crash during `uncertain` discards that result and preserves safety rather than persisting agent output outside the normal transactional path.

## Documentation

- `docs/REPOSITORY_CONTROLLER_LEASE.md`: status changed to Implemented and §17 now describes the memory-only held-result body and content-free event markers.
- `README.md`: repository-level single-controller guarantee and boundary.
- `INSTALL.md`: cutover, standby and takeover operator flow.
- `docs/GITHUB_SETUP.md`: custom-ref permission and controller commands.
- `docs/CONTEXT_AND_WORKFLOW_DESIGN.md` §8.2/§8.3: controller attribution in mutable status and immutable milestone comments.

## Open questions

None. The design deliberately excludes automatic failover and workflow-state synchronization.

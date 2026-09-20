# Repository controller lease implementation review

## P0 — Remote ref reality check

**Decision: agree, with a corrected CAS probe.** GitHub accepts the custom
`refs/ai-factory/lease` namespace. The literal stale-lease command in the
request reused the current commit and Git treated it as a no-op (`Everything
up-to-date`, exit 0), so it did not exercise compare-and-swap. Repeating that
step with a different commit was rejected as `stale info`, which validates the
intended invariant. The repository formerly called `ai-factory-demo` is now
`lucaslodeiro/factory-demo`.

The exact corrected probe output will be recorded in the final verification
section. The temporary ref was deleted and a final `ls-remote` returned no row.

## P1 — Instance identity and read-only status

**Decision: agree.** Stable installation identity, validated remote records,
fresh-schema controller state, CLI status and a separate doctor check are the
minimum observable foundation for all later controller behavior.

## P2 — Atomic lifecycle

**Decision: agree.** Acquire, renew, release and takeover require one shared CAS
writer with an explicit expected SHA. Local bare-origin races are sufficient to
prove the Git invariant without making tests depend on GitHub.

## P3 — Startup gate, standby and remote visibility

**Decision: agree.** The lease must be acquired before abandoned execution
recovery and orchestration. A standby daemon remains healthy but does not run an
orchestrator cycle. The dashboard reads repository issues directly from GitHub
and labels them as tracked or untracked locally; this is visibility, not state
synchronization.

## P4 — Fencing, uncertainty and held results

**Decision: agree, with an in-memory held-result buffer.** A held result exists
only while the daemon remains alive during a temporary verification outage. The
event log stores only its execution id and role, never the result body. Commands,
execution starts and publication each verify the acquired generation. A changed
owner interrupts active executions with `controller-lost`, pauses their work
items and discards held results.

## P5 — Uninstall release and issue attribution

**Decision: agree.** Uninstall attempts a controller release after stopping the
services and refuses local removal on failure unless `--force` was explicit.
Status comments carry controller name and generation, milestone comments keep
the controller name, and takeover notices are idempotent by issue id and
generation for open, labelled issues without local state.

## P6 — Cutover documentation and two-factory proof

**Decision: agree.** The operator documentation now treats the controller lease
as implemented, explains the one-time legacy-daemon cutover, GitHub permission,
standby and explicit takeover. The end-to-end test uses two isolated homes, one
bare origin and one shared fake GitHub surface to prove one workflow is created,
standby stays empty, takeover emits one notice and the prior generation is
fenced.

The clean macOS gate exposed one integration defect: an identity created before
a failed validation was rejected by the retry destination guard. The guard now
accepts the preserved `instance.json`, and the maintenance installer test
asserts that exact retry layout.

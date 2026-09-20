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

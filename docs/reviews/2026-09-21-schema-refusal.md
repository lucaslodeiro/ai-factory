# Schema refusal review

## Decision

**R1 — implemented as requested.** The current code accepted a stored schema version 5, rewrote its metadata to version 6 and kept a fixture and tests specifically for that migration. This contradicted the fresh-schema decision for `repository_controller`. The installation validator also exposed the refusal from `Store` as an uncaught stack trace, so it required the requested one-line operator message.

## Changes

Commit `887b02e` (`fix: R1 refuse older schemas without migration`) contains the behavioral change:

- `src/storage.ts` inspects an existing nonempty database before enabling WAL. Every stored `schema_version` other than the current `schemaVersion` is refused with the existing fresh-data-directory message. The version 5 exception and the metadata `UPDATE` were removed; a fresh database `INSERT` is now the only schema-version write. Performing the check before a persistent pragma also keeps refused database bytes unchanged.
- `test/fixtures/schema-v5.sql` was deleted because older schema snapshots are no longer migration inputs.
- `test/storage-v3.test.ts` replaces the two migration tests with `stored schema versions older or newer than current are refused without changing file bytes`. It checks versions 5 and 7, gives each database a real table, asserts the refusal and compares the complete file bytes before and after. The guard `schema migration is forbidden while there is no production` reads `src/storage.ts` and rejects both schema-version update statements and comparisons against literal schema versions.
- `scripts/test-installation-validation.mjs` removes the version 5 upgrade scenario. It keeps the incompatible-schema check, requires the concise message and verifies that the live database is unchanged. Its PASS line now describes refusal and preservation.
- `scripts/validate-installation.mjs` recognizes the schema-refusal error, prints `Incompatible database schema: uninstall and reinstall with an empty data directory` as one line and exits nonzero. Other unexpected errors still surface normally.
- `INSTALL.md` now says that fresh databases are stamped transactionally with the current version, any other stored version is refused before mutation, and updates never migrate data.

## Test coverage

Before the fix, the focused storage suite passed 6/6 while explicitly exercising the unwanted version 5 migration. After the fix, the same suite passed 6/6 with the two-version refusal and source guard in its place.

The installation validation now proves that its disposable validation database cannot upgrade an incompatible live database, that refusal is concise, and that the live file remains byte-for-byte unchanged.

## Verification

Complete test suite:

```text
PATH=/Users/lucaslodeiro/.local/bin:$PATH npm test
tests 215
pass 215
fail 0
skipped 0
```

Fresh-build macOS validation:

```text
rm -rf dist && PATH=/Users/lucaslodeiro/.local/bin:$PATH npm run test:all
tests 215
pass 215
fail 0
skipped 0
PASS: user-local preflight, verified tool installation, non-interactive providers and argument forwarding
PASS: dashboard-first install, existing destination, fast-forward, config/worktree preservation, backup, dirty checkout, daemon lock, local-only commit, persisted update state and dashboard availability.
PASS: basic uninstall preserves configuration and repos; purge preflights dirty clones and removes the complete home only with force
PASS: installation defaults, GitHub-derived required defaults, private demo provisioning, saved defaults, edits, clearing, validation/retry, secret masking, unknown settings, backups, permissions, EOF cancellation and daemon guard.
PASS: dashboard host/port selection and occupied-port fallback
PASS: installation checks use disposable storage, refuse incompatible schemas cleanly and preserve the live database.
```

Focused installation validation:

```text
PATH=/Users/lucaslodeiro/.local/bin:$PATH node scripts/test-installation-validation.mjs
PASS: installation checks use disposable storage, refuse incompatible schemas cleanly and preserve the live database.
```

Whitespace validation:

```text
git diff --check
(no output; exit 0)
```

No test was skipped, disabled or loosened. No flaky failure occurred and no failed test was retried into green.

## Limitations

The review deliberately provides no importer, migration, compatibility reader or transitional path. Operators with an older database must uninstall and reinstall with an empty data directory, as required by the owner decision.

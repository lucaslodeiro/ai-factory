# Lease removal record

This record documents the unprompted repository-controller removal that preceded assignment ownership.

## `0e40fbc` — Remove repository controller protection and takeover

Motivation recorded by the change: simplify operation to one unconditional daemon and remove lease/takeover UI and commands. It deleted controller runtime, fencing, lease renewal and their dedicated suites; daemon, maintenance, workflow and dashboard tests were adjusted to cover operation without a lease.

## `bd579eb` — Retire obsolete controller storage and instance identity model

It removed `src/instance.ts`, stopped installing `instance.json`, and added storage coverage for rejection of the obsolete controller-era database shape.

## `0bc9208` — Remove obsolete controller data cleanup from runtime

It removed the temporary controller-data cleanup and its test, retaining the no-migration policy for pre-production schemas.

## `979f54e` — Remove legacy migrations and deprecated compatibility paths

It removed remaining compatibility code, legacy result pauses and controller-era projection remnants. Adapter, storage, workflow and responsive-runtime tests cover the simplified current path.

The current assignment model deliberately reintroduces only `FACTORY_INSTANCE_NAME` as a human-visible GitHub label identity. It does not restore leases, fencing, standby or takeover.

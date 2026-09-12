# Task 2 — Fixture-state time boundary and receipt-time split

## Status

Implemented fixture-state future-time rejection, durable terminal ledger state, canonical replay identity, and server receipt-time freshness storage. No database migration or user database operation was run.

## TDD evidence

### RED

```text
$ pnpm --filter @led-control/api exec jest src/mqtt/gateway-event-time.spec.ts --runInBand
FAIL src/mqtt/gateway-event-time.spec.ts
TS2307: Cannot find module './gateway-event-time'
Test Suites: 1 failed, 1 total
Tests: 0 total
```

```text
$ pnpm --filter @led-control/api exec jest src/energy/fixture-state-ingestion.service.spec.ts --runInBand
FAIL src/energy/fixture-state-ingestion.service.spec.ts
TS2554: Expected 2 arguments, but got 3. (two `ingest(..., receivedAt)` calls)
Test Suites: 1 failed, 1 total
Tests: 0 total
```

### GREEN

```text
$ pnpm --filter @led-control/api exec jest src/mqtt/gateway-event-time.spec.ts src/energy/fixture-state-ingestion.service.spec.ts src/energy/fixture-state-ingestion.integration.spec.ts --runInBand
PASS src/energy/fixture-state-ingestion.service.spec.ts
PASS src/mqtt/gateway-event-time.spec.ts
Test Suites: 1 skipped, 2 passed, 2 of 3 total
Tests: 2 skipped, 21 passed, 23 total
```

```text
$ pnpm --filter @led-control/api typecheck && git diff --check
@led-control/shared build: success
@led-control/automation-engine build: success
@led-control/api typecheck: success (tsc --noEmit)
git diff --check: exit 0
```

The disposable PostgreSQL integration suite is guarded by `FIXTURE_STATE_TEST_DATABASE_URL`; this environment left it unset, so both integration tests were skipped. No database was created, migrated, or altered.

## Changed files

- `apps/api/src/mqtt/gateway-event-time.ts` and its unit test: default 300,000 ms policy, inclusive boundary, and strict nonnegative-integer configuration parsing.
- `apps/api/src/energy/fixture-state-ingestion.service.ts`: frozen `receivedAt`, scope-lock-before-future-rejection ordering, future terminal ledger entries, canonical payload hash identity checks, and split `lastSeenAt`/`lastStateOccurredAt` writes.
- `apps/api/src/energy/fixture-state-ingestion.service.spec.ts`: poison isolation, timestamp split, terminal replay, and payload-conflict regressions.
- `apps/api/src/energy/fixture-state-ingestion.integration.spec.ts`: future poison then normal event progress/cursor/aggregate/snapshot regression (environment-gated).

## Self-review

- Future rejection occurs only after the fixture ownership lock and before cursor lookup or `aggregateFixtureStateTransition`.
- Future ledger rows contain the required identity, hash, occurrence/receipt timestamps, and `rejected_future_timestamp`; normal rows explicitly store hash, receipt time, and `accepted`.
- Exact accepted replays return `duplicate`; exact rejected replays return `rejected_future_timestamp`; mismatched canonical payloads reject closed.
- Normal state snapshots use server receipt time for `lastSeenAt` and device occurrence time for ordering/checkpoints.

## Concerns / follow-up

- PostgreSQL evidence requires a disposable `FIXTURE_STATE_TEST_DATABASE_URL` supplied by the controller/CI; it was intentionally not inferred or provisioned here.
- MQTT handler receipt-time capture and future-heartbeat behavior remain Task 3 scope.

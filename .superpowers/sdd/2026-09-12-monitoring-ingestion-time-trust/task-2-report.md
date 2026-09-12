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

## Fix round 1 — concurrent replay and disposable PostgreSQL verification

### Root cause and fix

An accepted replay can read no event before it waits on `Fixture ... FOR UPDATE`. After the first transaction commits, the waiting transaction previously skipped another event-id lookup and treated the row discovered by the sequence query as a generic sequence conflict. The service now re-reads the event-id ledger row immediately after acquiring the fixture lock and classifies the exact canonical identity as `duplicate` (or a stored future rejection as `rejected_future_timestamp`) before sequence/cursor/aggregation work.

### TDD evidence

```text
$ pnpm --filter @led-control/api exec jest src/energy/fixture-state-ingestion.service.spec.ts src/mqtt/gateway-event-time.spec.ts --runInBand
FAIL FixtureStateIngestionService
  returns duplicate when an exact accepted replay commits while this transaction waits for the fixture lock
Expected status: "duplicate"
Received status: "ingested"
Test Suites: 1 failed, 1 passed, 2 total
Tests: 1 failed, 23 passed, 24 total
```

```text
$ pnpm --filter @led-control/api exec jest src/energy/fixture-state-ingestion.service.spec.ts src/mqtt/gateway-event-time.spec.ts --runInBand
PASS src/energy/fixture-state-ingestion.service.spec.ts
PASS src/mqtt/gateway-event-time.spec.ts
Test Suites: 2 passed, 2 total
Tests: 24 passed, 24 total
```

The time-policy regression additionally asserts the boundary minus 1 ms is accepted and `9007199254740992` is rejected as an unsafe integer configuration.

### Isolated PostgreSQL evidence

Docker 29.7.2 was available. The following disposable-only flow used an explicitly named container, local loopback port 55439, database `led_control_task2`, and a shell `trap` that removes the exact named container on success or failure:

```text
$ docker run --detach --name led-control-task2-pg ... --publish 127.0.0.1:55439:5432 postgres:16-alpine
45b2037a6c06...
$ DATABASE_URL=postgresql://task2:***@127.0.0.1:55439/led_control_task2?schema=public pnpm exec prisma migrate deploy --schema prisma/schema.prisma
57 migrations found; all migrations successfully applied.
$ FIXTURE_STATE_TEST_DATABASE_URL=postgresql://task2:***@127.0.0.1:55439/led_control_task2?schema=public DATABASE_URL=... pnpm exec jest src/energy/fixture-state-ingestion.integration.spec.ts --runInBand
PASS src/energy/fixture-state-ingestion.integration.spec.ts
Test Suites: 1 passed, 1 total
Tests: 3 passed, 3 total
$ docker ps --all --filter 'name=^/led-control-task2-pg$'
temporary container removed
```

The integration suite covers sequential duplicate, concurrent exact replay, and future poison followed by normal-event progress. Migrations were never applied to a user-local database; the disposable container was removed after the run.

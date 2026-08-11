# Task 6 Report: Registration Ownership and Real Initial Fixture State

## Scope

- Implemented Task 6 from `.superpowers/sdd/2026-08-11-production-integration-completion/task-6-brief.md`.
- Preserved the `FixtureStatus` enum. A provisioned fixture is initially `offline` with `statusReason = provisioning_waiting_state`, `brightness = 0`, and `lastSeenAt = null`.

## Implementation

- Added the shared `CreateRegistrationSessionInput` schema requiring explicit `siteId`, `floorId`, and `gatewayId`.
- Registration validates operator commission access, floor-to-site ownership, gateway-to-site ownership, and a heartbeat newer than 90 seconds before publishing a scan command.
- Provisioning completion creates an unconfirmed fixture state without inferring online, fault, brightness, RSSI, hop count, command success rate, or last-seen time.
- The first gateway-scoped MQTT `fixture-state` event remains the only path that establishes the reported fixture snapshot.
- Existing `MeshNode.deviceUuid` global uniqueness is retained as the DB concurrency guard. Completion runs in a transaction, rejects a UUID owned by another gateway/site, and conditionally marks only the competing active node failed when a `P2002` race occurs.
- Monitoring receives the `provisioning_waiting_state` API reason and displays `상태 확인 대기` separately from a real offline fixture.

## Database

- No migration was added. The required global `MeshNode.deviceUuid` unique index already exists in `20260702143000_add_registration_flow`, and no column or constraint changed.
- Updated `docs/database-schema.md` with the initial-state, 90-second gateway freshness, and UUID race contracts.

## TDD Evidence

1. Shared schema test initially failed because `createRegistrationSessionSchema` was undefined.
2. API RED run showed automatic gateway selection, stale gateway acceptance, inferred `online/60%`, and cross-site UUID reuse; the focused API suite had 4 failures.
3. The monitoring RED test rendered `오프라인` instead of `상태 확인 대기` for `provisioning_waiting_state`.
4. Focused shared, API, and web tests passed after the implementation.

## Verification

- `pnpm --filter @led-control/shared test`: 3 files, 17 tests passed.
- `pnpm --filter @led-control/shared typecheck`: passed.
- `pnpm --filter @led-control/api test -- --runInBand`: 48 suites passed, 318 tests passed; 6 integration suites and 25 tests skipped by their existing environment gates.
- `pnpm --filter @led-control/api typecheck`: passed.
- `pnpm --filter @led-control/web test`: 16 files, 139 tests passed.
- `pnpm --filter @led-control/web typecheck`: passed.
- `git diff --check`: passed.

## Fix Round1

- RegistrationPanel now requires explicit floor and gateway selection, and its API payload carries the selected `siteId`, `floorId`, and `gatewayId`.
- Shared gateway freshness helpers define the inclusive 90-second boundary once. Registration queries, dashboard/fixture responses, command checks, and the freshness worker use that contract; exactly 90 seconds old remains fresh.
- `provisioning_waiting_state` is excluded from both gateway-offline and fixture-stale worker updates. The first real fixture state clears that reason and returns the fixture to normal freshness handling.
- Completion maps `P2002` to the cross-site device UUID conflict only when Prisma reports the `deviceUuid` unique target. Other unique constraints and transaction errors are rethrown.

### Fix Round1 TDD Evidence

1. Added failing tests for the missing web `gatewayId` payload, the 90-second dashboard boundary, the waiting-state stale filter, the shared helper clock boundary, and non-deviceUuid `P2002`/transaction error propagation.
2. Focused shared, API, and web suites passed after the implementation; final full verification is recorded with this round's commit.

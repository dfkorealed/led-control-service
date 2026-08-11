# Task 5 Fix Round 1 Report

## Status

Complete

## Review Findings Resolved

- Confirmed nodes are reconfigured during startup resync. AppKey already-stored status is accepted, and Composition, Health/OnOff/Lightness bind, and 60-second publication responses are checked before state queries continue.
- BlueZ model messages are partial observations. MQTT fixture-state is emitted only after both actual Generic OnOff and Lightness observations exist, so Health-only, reverse-order, or missing messages cannot synthesize brightness `0` or power-off snapshots.
- Resync uses a four-node bounded queue, busy retry/backoff, a response deadline that begins after Get messages have been accepted, per-run observation totals, and reconnect single-flight protection. The 1,000-node regression test verifies the concurrency bound and busy retry.
- Health Current Fault (`0x04`) is the sole operational fault source. Registered Fault (`0x05`) is ignored for live state, and no-fault byte `0x00` is filtered before fault-state construction.
- ESP32-H2 publication-update handling refreshes only Generic OnOff and Light Lightness publication buffers. The BLE Mesh stack performs the scheduled transmission, preventing duplicate callback-triggered publication. A host static regression test enforces this rule.

## Contracts Preserved

- MQTT v2 source, gateway, tenant/site scope validation, unknown-address drop, durable gateway event sequence, and stale/offline behavior remain unchanged.
- No response during startup resync is recorded as an observation deadline, not an offline fixture-state event.
- Task 2 through Task 4 implementation-plan entries were not changed.

## Verification

- `pnpm --filter @led-control/shared test` - 15 tests passed.
- `pnpm --filter @led-control/gateway test` - 167 tests passed.
- `pnpm --filter @led-control/api test -- --runInBand src/fixtures/fixture-freshness.service.spec.ts` - passed.
- `pnpm typecheck` - passed for shared, gateway, API, web, and mobile workspaces.
- `scripts/esp32-h2-build.sh` - ESP-IDF 5.5 `esp32h2` build and link passed; smallest app partition has 11% free space.
- `git diff --check` - passed before commit.

## Remaining Hardware Evidence

No Raspberry Pi/ESP32-H2 over-the-air capture was run in this fix round. The target firmware build and host static callback regression test pass; physical 2-node HIL remains a separate hardware completion gate.

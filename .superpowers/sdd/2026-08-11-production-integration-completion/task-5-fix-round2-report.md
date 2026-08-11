# Task 5 Fix Round 2 Report

## Status

Complete

## Review Findings Resolved

- Fixture observations now carry a generation, per-model dirty timestamp, and a 65-second coherence window. A snapshot requires current-generation Generic OnOff, Lightness, and Health Current observations; a completed generation, a timed-out counterpart, and every startup resync begin a new generation.
- Health Current is explicitly known or unknown. Registered Fault remains diagnostic-only, and startup cannot publish `online` or clear a real fault until a Current Status (`0x04`) is observed with the two lighting models.
- Startup reconnect consumes the bounded resync report. It writes a structured `mesh_resync` log and persists `meshResync` in appliance health. All-failed, all-timed-out, and no-observation runs remain unhealthy across successful heartbeats; mixed runs log an explicit incomplete event.
- AddAppKey response waiting is correlated to the destination primary unicast and validates returned NetKey/AppKey indexes before configuration proceeds. Concurrent cross-source status responses cannot complete another node's waiter.

## Contracts Preserved

- MQTT v2 tenant/site/gateway scope, exact primary-unicast source mapping, unknown-address drop, durable event sequence, and fixture stale policy are unchanged.
- Resync is still bounded, busy-retried, and reconnect single-flight. Missing status replies do not publish offline state.
- Task 2 through Task 4 plan entries remain unchanged.

## Verification

- `pnpm --filter @led-control/shared test` - passed.
- `pnpm --filter @led-control/gateway test` - passed.
- `pnpm --filter @led-control/api test -- --runInBand src/fixtures/fixture-freshness.service.spec.ts` - passed.
- `pnpm typecheck` - passed.
- `scripts/esp32-h2-build.sh` - ESP-IDF 5.5 `esp32h2` build and link passed.
- `git diff --check` - passed before commit.

## Remaining Hardware Evidence

The host tests and target firmware build pass. Raspberry Pi plus ESP32-H2 over-the-air publication capture and 2-node HIL remain separate hardware evidence gates.

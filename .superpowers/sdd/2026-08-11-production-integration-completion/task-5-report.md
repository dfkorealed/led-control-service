# Task 5 Report

## Status

Complete

## Scope Delivered

- Config Client binds Health Server `0x0002`, Generic OnOff Server `0x1000`, and Light Lightness Server `0x1300`, then configures 60-second publications (`0x86`) to the provisioner address.
- BlueZ decodes unsolicited Generic OnOff, Lightness, Health Current, and Health Fault statuses. Only confirmed primary-unicast mappings produce fixture-state events; unknown addresses are dropped.
- Gateway injects its assigned site and gateway scope into MQTT v2 fixture-state events, preserves the durable event sequence, and labels this source `mesh_publication`.
- MQTT reconnect startup now sends actual OnOff, Lightness, and Health queries for confirmed fixtures. A missing status reply does not create an offline state.
- ESP32-H2 refreshes Health, OnOff, and Lightness payloads on ESP-IDF publication-update events. Health fault clear immediately refreshes Health state.
- Fixture stale detection uses three 60-second publication windows (180 seconds).

## Verification

- `pnpm --filter @led-control/shared test` - 15 tests passed.
- `pnpm --filter @led-control/gateway test` - 162 tests passed.
- `pnpm --filter @led-control/api test -- --runInBand src/fixtures/fixture-freshness.service.spec.ts` - passed.
- `pnpm typecheck` - passed for shared, gateway, API, web, and mobile workspaces.
- `scripts/esp32-h2-build.sh` - ESP-IDF 5.5.1 `esp32h2` build and link passed; smallest app partition has 11% free space.
- `git diff --check` - passed before commit.

## Remaining Hardware Evidence

No Raspberry Pi/ESP32-H2 over-the-air publication capture was run in this task. The implementation is automatically verified and target-built; 2-node HIL remains a separate completion gate.

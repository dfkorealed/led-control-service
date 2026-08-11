# Task 5 Fix Round 3 Report

## Status

Complete

## Final Critical Fix

- Health Fault Get (`0x8031`) returns Registered Fault Status (`0x05`), not Current Fault Status (`0x04`). Startup resync now succeeds when configuration and a same-generation Generic OnOff plus Lightness pair are observed within its response deadline.
- The resync report adds `healthPending`. A node with a lighting pair and no Current Health is `observed`, not `timed_out`; it does not drive appliance health to `mesh_resync_all_timed_out`.
- Fixture-state remains a complete snapshot contract. Until a Current Health publication arrives, no snapshot is emitted, preserving the API's existing status. A late `0x04` completes the coherence generation and emits the correct online or fault snapshot.
- The adapter tracks pending fixture IDs from the latest resync. A late complete Current observation decrements `healthPending`, emits an updated report, and the gateway records it in appliance health through the resync report listener.

## Contracts Preserved

- Tenant/site/gateway MQTT v2 scope, primary-unicast mapping, unknown-address drop, durable event sequence, bounded retry queue, and reconnect single-flight remain unchanged.
- Health Registered Fault remains diagnostic-only. Only Current Fault changes operational fixture state.
- Task 2 through Task 4 implementation-plan entries remain unchanged.

## TDD Evidence

- RED: a protocol-correct Registered Fault response produced `timed_out` because resync waited for a fixture snapshot; the 1,000-node regression test also timed out after replacing its non-standard immediate Current response.
- GREEN: resync now observes the lighting pair, reports `healthPending`, suppresses fixture-state before Current, and emits a fault snapshot plus pending-report recovery after late Current.

## Verification

- `pnpm --filter @led-control/shared test` - passed.
- `pnpm --filter @led-control/gateway test` - passed.
- `pnpm --filter @led-control/api test -- --runInBand src/fixtures/fixture-freshness.service.spec.ts` - passed.
- `pnpm typecheck` - passed.
- `scripts/esp32-h2-build.sh` - ESP-IDF 5.5 `esp32h2` build and link passed.
- `git diff --check` - passed before commit.

## Remaining Hardware Evidence

The target firmware build and host gateway tests pass. Raspberry Pi plus ESP32-H2 over-the-air publication capture and 2-node HIL are separate hardware evidence gates.
## 대규모 큐 관측 시각 보완

- 1,000개 조명의 관측 generation을 큐 등록 시점이 아니라 각 bounded worker가 실제 구성을 마친 직후 생성한다.
- 첫 status가 오기 전에는 coherence window를 소모하지 않아 Busy retry 중 관측 세대가 불필요하게 교체되지 않는다.
- 65초 이상 큐 대기가 누적되는 1,000-node 회귀 테스트와 gateway typecheck를 통과했다.
- 첫 status가 늦게 도착한 경우 coherence 시작 시각을 그 첫 실제 관측 시각으로 갱신해, 바로 이어진 counterpart가 새 generation으로 잘못 분리되지 않게 했다.

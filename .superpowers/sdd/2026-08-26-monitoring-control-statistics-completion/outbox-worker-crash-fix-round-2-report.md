# Outbox Worker Crash Fix Round 2 Report

기준일: 2026-08-26

## Root Cause

Round 1은 각 outbox worker가 자신의 in-flight batch를 drain하도록 만들었지만, 두 worker와 `MqttService`가 같은 Nest module에서 각각 `onModuleDestroy()`를 구현했다. Nest가 provider destroy hooks를 병렬 호출하므로 worker drain과 MQTT `client.end()`가 동시에 시작됐고, active publish가 종료 중인 client와 경쟁할 수 있었다.

## Lifecycle Ruling

`MqttShutdownCoordinator`만 MQTT module의 outbox/MQTT destroy 순서를 소유한다.

1. command outbox와 provisioning scan outbox의 멱등 `stopAndDrain()`을 모두 시작한다.
2. 두 active batch가 모두 끝날 때까지 기다린다. stop 이후 같은 batch의 다음 record publish와 새 tick은 시작하지 않는다.
3. 마지막으로 멱등 `MqttService.close()`를 호출하고 MQTT.js graceful `end` callback 완료를 기다린다.

두 outbox worker와 `MqttService`에는 독립 `onModuleDestroy()`가 없으므로 coordinator와 병렬 종료 경쟁을 만들지 않는다.

## MQTT Close Policy

- 정상 경로는 `client.end(false, callback)`의 callback을 await한다.
- 같은 `close()`를 여러 번 호출하면 하나의 promise와 client close를 재사용한다.
- graceful callback이 5초 안에 오지 않으면 정제된 warning을 남기고 `client.end(true, callback)`로 force close하며 그 callback도 await한다.
- force close callback도 오지 않으면 추가 1초 timeout 뒤 resolve해 Nest close가 영구 hang하지 않는다.
- close가 시작된 뒤에는 새 MQTT client를 만들지 않는다.

## TDD Evidence

RED:

```text
Test Suites: 4 failed, 4 total
TS2307: mqtt-shutdown-coordinator.service does not exist
TS2339: worker.stopAndDrain and MqttService.close do not exist
```

GREEN focused:

```text
Test Suites: 4 passed, 4 total
Tests:       86 passed, 86 total
```

`TestingModule.close()` lifecycle test에서 command와 scan active publish를 순서대로 해제했다. 두 drain 전에는 MQTT client `end`가 호출되지 않았고 최종 순서는 `command-drained`, `scan-drained`, `client-end`였다. MQTT unit tests는 close promise 멱등성, graceful/force callback 대기, 4,999ms 이전 미종료, 5,000ms force close와 6,000ms 최종 bounded 종료를 검증한다.

## Full Verification

```text
API tests: 60 suites passed, 479 tests passed
Skipped by existing environment gates: 9 suites, 31 tests
API typecheck: exit 0
API build: exit 0
git diff --check: exit 0
```

## Changed Files

- `apps/api/src/mqtt/mqtt.module.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/mqtt.service.spec.ts`
- `apps/api/src/mqtt/mqtt-shutdown-coordinator.service.ts`
- `apps/api/src/mqtt/mqtt-shutdown-coordinator.spec.ts`
- `apps/api/src/mqtt/outbox-publisher.service.ts`
- `apps/api/src/mqtt/outbox-publisher.service.spec.ts`
- `apps/api/src/mqtt/provisioning-scan-outbox-publisher.service.ts`
- `apps/api/src/mqtt/provisioning-scan-outbox-publisher.service.spec.ts`
- `docs/menus/control.md`
- `docs/menus/monitoring.md`

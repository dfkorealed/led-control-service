# Outbox Worker Process-Crash Fix Report

기준일: 2026-08-26

## Root Cause

로컬 `pnpm dev` 브라우저 QA에서 `OutboxPublisherService.processBatch()`의 `claimBatch()` interactive Prisma transaction이 `P2028`로 timeout 됐다. 관측된 timeout은 약 6,025ms였고 `MqttOutbox` row는 0건이었다. 이는 transient DB/event-loop delay가 batch 단위 promise를 reject할 수 있음을 보인다.

두 outbox publisher는 초기 실행과 1초 interval callback에서 `void this.processBatch()`를 사용했다. 이 promise에는 top-level catch가 없었으므로 `claimBatch()` reject가 unhandled rejection으로 Node API process 밖으로 탈출했다. 또한 `setInterval`은 async callback 완료를 기다리지 않아 느린 batch가 진행되는 동안 다음 tick이 중첩될 수 있었다.

개별 record의 MQTT publish 실패는 기존 `publishClaimed()` 내부에서 backoff/dead-letter로 처리되므로 변경하지 않았다.

## Fix

- `OutboxPublisherService`와 `ProvisioningScanOutboxPublisherService`에 scheduler 전용 `runScheduledBatch()`를 추가했다.
- worker마다 single-flight 상태를 두어 진행 중인 batch가 있으면 후속 tick을 건너뛴다.
- scheduler 경계에서 batch reject를 잡아 Nest `Logger`에 worker ID와 오류 종류(P2028 또는 Error name)만 남긴다. 원본 error message, payload, secret은 기록하지 않는다.
- destroy 시 `stopped`를 먼저 설정하고 interval을 제거해 이후 새 tick을 차단한다.

## TDD Evidence

RED:

```text
pnpm --filter @led-control/api exec jest src/mqtt/outbox-publisher.service.spec.ts src/mqtt/provisioning-scan-outbox-publisher.service.spec.ts --runInBand
FAIL: payload-secret unhandled rejection reached Jest
FAIL: expected logger containment, received 0 calls
FAIL: slow claim expected 1 call, received 4 calls
```

GREEN:

```text
Focused MQTT publisher specs: 2 suites passed, 29 tests passed
API full test: 58 suites passed, 457 tests passed; 8 suites / 30 tests skipped
pnpm --filter @led-control/api typecheck: exit 0
pnpm --filter @led-control/api build: exit 0
```

The regression tests exercise real `processBatch()` behavior while mocking only `claimBatch()`: initial P2028 rejection is contained without an unhandled rejection, the next interval succeeds, slow claims remain single-flight, and no new claim starts after `onModuleDestroy()`.

## Menu Documentation Handoff

Per the parallel-work conflict instruction, this commit deliberately does not modify `docs/menus/control.md` or `docs/menus/monitoring.md`. Task 4 fix can add the following completed-behavior statements:

- Control: `MQTT command outbox worker는 transient DB batch 실패를 scheduler 경계에서 정제 로그로 격리하고 다음 poll tick에서 재시도한다. 실행 중인 batch에는 single-flight를 적용해 interval 중첩을 막으며 종료 뒤 새 tick을 시작하지 않는다.`
- Monitoring: `Provisioning scan outbox worker는 transient DB batch 실패가 API process 종료로 이어지지 않도록 격리하고 다음 poll tick에서 복구한다. 실행 중인 batch에는 single-flight를 적용하고 종료 뒤 새 tick을 시작하지 않는다.`

## Changed Files

- `apps/api/src/mqtt/outbox-publisher.service.ts`
- `apps/api/src/mqtt/outbox-publisher.service.spec.ts`
- `apps/api/src/mqtt/provisioning-scan-outbox-publisher.service.ts`
- `apps/api/src/mqtt/provisioning-scan-outbox-publisher.service.spec.ts`

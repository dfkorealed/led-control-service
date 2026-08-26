# Outbox Worker Crash Fix Round 3 보고서

기준일: 2026-08-26
기준 HEAD: `ec9011b3b59004fe07b5fc7208ee43cb8811b834`
기준 리뷰: `outbox-worker-crash-fix-round-2-rereview.md`

## Root Cause

Round 2의 `MqttShutdownCoordinator`는 command outbox와 provisioning scan outbox만 drain했다. 같은 production `MqttModule`의 MQTT producer인 `MeshGroupSyncWorker`는 독립 `onModuleDestroy()`에서 timer만 정리했으므로 진행 중 `runOnce()`와 publish를 기다리지 않았다.

동시에 `MqttService`의 MQTT `message` listener는 `void this.handleMessage(...)`로 Promise를 버렸다. Nest close가 MQTT client를 먼저 closing 상태로 바꾸면 진행 중 mesh group resync request handler의 ACK publish가 reject되고, 이 rejection이 최상위에서 처리되지 않아 API process 경계 밖으로 유출될 수 있었다.

## TDD RED

구현 전 아래 focused 명령을 실행했다.

```text
pnpm --filter @led-control/api exec jest \
  src/mesh-control-groups/mesh-group-sync.worker.spec.ts \
  src/mqtt/mqtt.service.spec.ts \
  src/mqtt/mqtt-shutdown-coordinator.spec.ts --runInBand
```

결과는 exit code `1`이었다.

- `MeshGroupSyncWorker.stopAndDrain()` 부재
- `MqttService.stopInboundAndDrain()` 부재
- 신규 lifecycle 계약을 표현한 3개 suite가 compile 단계에서 실패

이 RED는 active mesh publish와 inbound handler를 coordinator가 drain할 수 없는 기존 결함을 직접 고정한다.

## 구현

### Mesh group sync producer

- `MeshGroupSyncWorker`의 독립 destroy hook을 제거했다.
- interval 실행을 single-flight로 만들고 active run Promise를 추적한다.
- 공개 멱등 `stopAndDrain()`이 timer를 먼저 정리하고 active run 종료를 기다린다.
- stop 시작 뒤에는 현재 publish가 끝나더라도 다음 group 또는 다음 interval publish를 시작하지 않는다.
- scheduler 및 record 오류 로그는 Prisma `P` + 숫자 4자리만 허용하고 그 외 code/name/message는 `UNEXPECTED_ERROR`로 정제한다.

### Inbound MQTT consumer/ACK producer

- `connect`와 `message` listener 참조를 보관하고 shutdown 시작 시 모두 분리한다.
- 수신 handler Promise를 Set으로 추적하며 공개 멱등 `stopInboundAndDrain()`이 진행 중 handler를 기다린다.
- 모든 handler rejection은 listener 최상위 catch에서 처리한다.
- 로그에는 topic, payload, error name/message 또는 임의 code를 남기지 않고 Prisma safe code 또는 `UNEXPECTED_ERROR`만 기록한다.
- listener 분리 뒤 도착한 message는 신규 handler나 ACK publish를 시작하지 않는다.

### 단일 shutdown coordinator

`MqttShutdownCoordinator`만 MQTT module 종료 순서를 소유한다.

1. command outbox `stopAndDrain()`
2. provisioning scan outbox `stopAndDrain()`
3. Mesh group sync `stopAndDrain()`
4. inbound listener detach 및 active handler drain
5. 네 drain이 모두 끝난 뒤 `MqttService.close()`

기존 MQTT.js graceful `end` callback 5초 대기, force close callback 추가 1초 대기 정책과 멱등 close는 변경하지 않았다.

## Production Lifecycle 회귀

`mqtt-shutdown-coordinator.spec.ts`가 실제 production `MqttModule`을 import한다. 실제 `MqttService`, `MeshGroupSyncWorker`, 두 outbox worker와 coordinator를 사용하고 외부 경계인 Prisma/Mesh domain 저장 동작과 MQTT client만 제어한다.

동시에 아래 상태를 만든 뒤 `TestingModule.close()`를 호출한다.

- Mesh group subscription sync publish 진행 중
- inbound mesh group resync request transaction/ACK handler 진행 중

검증 결과:

- close 시작 즉시 inbound listener가 분리됨
- close 이후 message가 새 handler를 시작하지 않음
- resync ACK publish rejection이 unhandled rejection으로 유출되지 않음
- ACK 오류 상세가 로그에 노출되지 않음
- active mesh publish와 inbound ACK handler가 모두 끝나기 전 `client.end()`가 호출되지 않음
- drain 완료 뒤에만 `client.end()`가 정확한 순서로 호출됨

## GREEN 및 전체 검증

Focused GREEN:

```text
5 suites passed
94 tests passed
0 failed
```

API 전체 테스트:

```text
60 suites passed, 9 skipped
490 tests passed, 32 skipped
0 failed
```

추가 검증:

- `pnpm --filter @led-control/api typecheck`: exit code `0`
- `pnpm --filter @led-control/api build`: exit code `0`
- `git diff --check`: exit code `0`

전체 API 검증에는 공유 working tree의 병렬 Task 4 변경이 포함되어 있었고 모두 통과했다. 해당 `commands` 및 Web 변경은 이번 작업에서 수정하거나 stage하지 않는다.

## 문서 및 SDD

- `docs/menus/control.md`: outbox뿐 아니라 Mesh sync와 inbound ACK까지 coordinator가 drain한 뒤 MQTT client를 닫는 완료 문구로 갱신
- `docs/menus/monitoring.md`: listener 분리, 진행 중 handler 대기, rejection containment와 종료 순서를 갱신
- SDD `progress.md`: Round 3 구현 및 production lifecycle 검증 기록 추가. 이 파일은 저장소 정책상 `.superpowers/` ignore 대상인 로컬 ledger이므로 commit stage에는 포함하지 않는다.

## 커밋 범위

이번 커밋은 아래 파일만 stage한다.

- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.spec.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/mqtt.service.spec.ts`
- `apps/api/src/mqtt/mqtt-shutdown-coordinator.service.ts`
- `apps/api/src/mqtt/mqtt-shutdown-coordinator.spec.ts`
- `docs/menus/control.md`
- `docs/menus/monitoring.md`
- `.superpowers/sdd/2026-08-26-monitoring-control-statistics-completion/outbox-worker-crash-fix-round-3-report.md`

병렬 작업의 `commands.service*`, `apps/web/**` 파일은 stage하지 않는다.

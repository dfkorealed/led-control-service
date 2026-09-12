# P0/P1 제어 신뢰성 최종 리뷰 수정 보고서

기준일: 2026-09-12

상태: Important 2건과 문서/reclaim 검증 보정을 완료했다. 소프트웨어 검증 범위이며 PostgreSQL 적용 검증과 실장비 HIL은 수행하지 않았다.

작업 경로: `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-control-reliability`

브랜치: `codex/p0p1-control-reliability`

기준 커밋: `465984c8978a998adb0b752a2a14c30d1f8652fa`

변경 커밋 제목: `fix(control): preserve uncertain delivery outcomes`

## 수정 결과

### Important 1: BlueZ Lightness Status 유실

기존 `BluezMeshAdapter.sendFixtureBrightness`는 D-Bus Send 성공 뒤 Lightness Status가 없으면 기본 failed outcome과 `STATUS_TIMEOUT`을 반환했다. Gateway handler는 이를 `failed` ACK로 직렬화했고, API는 미적용으로 판단했다.

신규 Gateway는 같은 원인을 `timed_out`으로 전달한다. API consumer는 기존 `failed + STATUS_TIMEOUT` wire도 처리한다. 먼저 원문 ACK의 fixture 집합과 aggregate를 검증하고 원문 event/hash로 dedupe한 다음, 해당 결과를 `timed_out`으로 정규화한다. 관측하지 못한 밝기를 성공값으로 저장하지 않는다. 원 명령은 `unknown`이 되어 Get 상태 확인을 허용하고 겹치는 새 Set은 거부한다. 유효하지 않은 원문 aggregate는 변환으로 통과시키지 않는다.

Gateway 회귀는 실제 BlueZ 어댑터와 `handleGatewayDimmingCommand`를 연결하고 D-Bus 경계만 fake로 두어 Status 유실의 wire 결과와 관측값 부재를 검증한다. API 회귀는 그 신규 wire와 기존 wire를 실제 MQTT consumer에 넣고 실제 CommandVerificationService/CommandsService의 Get·overlap 결정을 이어서 확인한다.

### Important 2: PUBACK 유실 뒤 terminal outcome

미적용 migration과 Prisma schema에 nullable `MqttOutbox.deliveryAttemptedAt`을 추가했다. Publisher는 실제 MQTT 호출 직전에 lease와 expiry를 재확인한 transaction에서 첫 시도 시각을 commit한다. 이후 재claim에서도 같은 기록과 payload generation을 유지한다. 이 기록은 PUBACK 성공의 `publishedAt`과 별개다.

기록이 있으면 PUBACK 유실 뒤 expiry/dead-letter에서 dimming dispatch/result를 timed_out 증거로 닫고 parent outcome을 `unknown`으로 설정한다. 기록이 없는 사전 validation 거절은 `not_applied`다. 재시도 횟수 `attempts`는 물리 발행 증거로 사용하지 않는다. 기록 직후 MQTT 호출 전 crash는 보수적으로 unknown을 남기는 허용된 경계다.

`CommandTimeoutService`도 pending outbox를 선점한 뒤 이 내구 기록을 조회한다. 그래서 PUBACK을 잃어 dispatch가 pending인 상태로 15분을 넘겨도 `ACCEPTANCE_TIMEOUT`/unknown으로 닫힌다. 발행 시도 전 delivery timeout의 `DELIVERY_TIMEOUT`/not_applied는 유지한다.

Publisher claim/prepare/시도 기록/retry/release/terminal transaction은 automation global lock을 outbox/dispatch/command mutation보다 먼저 획득한다. MQTT Promise를 기다리는 동안 DB transaction은 유지하지 않는다. Terminal outbox를 닫은 뒤에도 dispatch 조건부 전이에 실패하면 results/parent write를 하지 않아 먼저 확정한 ACK를 보존한다.

`MQTT_DEAD_LETTER`, `COMMAND_DELIVERY_EXPIRED`는 terminal 오류 코드로 유지한다. 같은 generation의 이전 발행 후 override 또는 mesh snapshot 검증이 만료될 수도 있으므로 `MANUAL_OVERRIDE_EXPIRED`, `MESH_GROUP_STALE`도 unknown인 dimming의 late ACK 후보에 포함한다. `not_applied`는 재개하지 않는다. 여러 dimming dispatch 결과를 합칠 때에는 publisher 오류 코드만으로 unknown을 만들지 않고 timed_out 증거가 있는지 구분한다. Status-check publisher terminal은 원 Set outcome을 결정하지 않는다.

### Task 2 minor와 배포 문서

이전 `publishClaimed` 직접 호출 fake는 모든 row update를 성공시켰으며, publish 완료한 동일 row를 만료 시각 뒤에도 강제로 다시 전달했다. 실제 reclaim 검증을 닫았다는 계획의 표현을 정정하고 해당 fake의 테스트명과 범위를 줄였다.

신규 stateful persistence 경계는 실제 `processBatch`/`claimBatch`를 실행한다. PUBACK 유실 후 새 publisher 인스턴스가 같은 저장 generation으로 재claim하여 줄어든 TTL로 성공하는 경로, 성공한 published row가 다시 claim되지 않는 경로, 별도 미발행 row가 expiry로 종료되는 경로를 분리 검증했다. PostgreSQL의 실제 SKIP LOCKED나 rollback을 증명한다고 서술하지 않는다.

DB 흐름의 eventId/hash dedupe 표현을 device-status로 한정했다. Coordinated rollout은 구버전 API/publisher stop-and-drain과 migration 적용 뒤 신규 publisher·Gateway·API ACK consumer를 준비하고, 그 다음 status-check producer/API와 UI를 활성화하는 순서다. 기존 component와 혼합 운영은 안전하지 않다. 이 배포 절차는 문서에만 기록했으며 실제 배포는 하지 않았다.

## TDD 및 검증 기록

아래 명령은 모두 지정 worktree 루트에서 실행했다.

### 구현 전 RED

```bash
pnpm --filter @led-control/api exec jest src/commands/command-delivery-reliability.spec.ts --runInBand
```

종료 코드 1. 최초 15개 중 12 failed, 3 baseline passed. 실패 이유는 기존 timeout wire의 `not_applied`, durable attempt 누락, terminal 이후 parent `pending`, late ACK 미수렴, pending worker의 `not_applied`, publisher mutation lock 누락이었다. 기존 신규 timed_out wire·원문 aggregate 거절·상태 조회 retry 정상 경로의 3개는 baseline으로 통과했다.

```bash
pnpm --filter @led-control/gateway exec vitest run src/mesh/bluez-mesh-adapter.test.ts -t 'lost Lightness Status'
```

종료 코드 1. 1 failed, 38 이름 필터 skipped. 실제 Gateway ACK의 aggregate/result가 기대 `timed_out` 대신 `failed`, faultCode는 `STATUS_TIMEOUT`인 것을 확인했다. 이 skipped는 환경 의존 skip과 다르다.

### GREEN과 regression 보강

```bash
pnpm --filter @led-control/api exec jest src/commands/command-delivery-reliability.spec.ts src/mqtt/outbox-publisher.service.spec.ts src/mqtt/mqtt.service.spec.ts src/commands/command-timeout.service.spec.ts src/commands/command-verification.service.spec.ts src/commands/commands.service.spec.ts --runInBand
```

종료 코드 0. 6 suites, 209/209 passed. 신규 lifecycle는 최종 18개다. producer timeout 호환/원문 aggregate 검증, durable record·lease fence, expiry/dead-letter, 사전 validation, 원래 ACK/늦은 ACK/중복 ACK, sibling aggregate, pending timeout, Get/overlap, status-check retry/expiry를 검증했다.

기존 focused 묶음 갱신 과정에서 모의 Prisma 객체에 새 `$executeRaw`/`findUnique`가 없어 실패했으므로 DB 경계를 보완했다. 한 mock의 중복 `$executeRaw` TS1117와 Gateway journal mock의 `undefined` 반환도 수정해 실제 nullable 반환형과 맞췄다. 이 실패들은 아래 최종 typecheck 및 전체 결과에서 모두 해소됐다.

```bash
pnpm --filter @led-control/gateway exec vitest run src/mesh/bluez-mesh-adapter.test.ts src/commands/gateway-command-handler.test.ts src/commands/gateway-status-check-handler.test.ts
```

종료 코드 0. 3 files, 77/77 passed. 초기 producer-only 명령도 수정 뒤 1 passed/38 이름 필터 skipped로 통과했다.

### Dispatch 전이 gate mutation 검증

`if (closed.count !== 1) return`만 잠시 제거한 뒤 실행했다.

```bash
pnpm --filter @led-control/api exec jest src/commands/command-delivery-reliability.spec.ts --runInBand --testNamePattern='preserves the conclusive ACK that wins'
```

종료 코드 1. 1 failed/17 이름 필터 skipped. ACK가 먼저 확정된 뒤 결과·parent write 호출이 각각 1회에서 2회가 되어 정확히 실패했다. 즉시 gate를 복원하고 아래 최종 전체 API 명령을 다시 실행해 GREEN을 확인했다.

### 최종 전체 및 빌드

```bash
pnpm --filter @led-control/api typecheck && pnpm --filter @led-control/api exec jest --runInBand
```

종료 코드 0. Typecheck 성공, 113 suites/1,176 passed, 27 suites/272 environment-gated skipped. 1,448개 중 skipped를 통과로 계산하지 않는다. 최종 전체 Jest 실행 시간은 39.012초였다. 기존 test-data suite의 energy query count 정보 로그가 출력됐다.

```bash
pnpm --filter @led-control/gateway typecheck
pnpm --filter @led-control/gateway exec vitest run
```

각 종료 코드 0. Gateway typecheck 성공, 65 files/625 passed.

```bash
pnpm --filter @led-control/api build
pnpm --filter @led-control/gateway build
```

순차 실행 완료, 종료 코드 0. API Nest build와 Gateway bundle 성공. Gateway 출력은 `573.8kb`다. Shared와 automation-engine build도 이 명령들의 의존성으로 실행됐다.

```bash
pnpm --filter @led-control/shared exec vitest run
```

종료 코드 0. 14 files/200 passed.

### Prisma 및 diff

```bash
pnpm --filter @led-control/api prisma:generate
pnpm --filter @led-control/api exec prisma format --schema prisma/schema.prisma
DATABASE_URL='postgresql://placeholder:placeholder@127.0.0.1:1/placeholder?schema=public' pnpm --filter @led-control/api exec prisma validate --schema prisma/schema.prisma
git diff --check
```

모두 종료 코드 0. Prisma Client v6.19.3 생성 및 schema valid를 확인했다. URL은 이 한 명령에만 전달한 비접속 placeholder다. `deliveryAttemptedAt`의 nullable DateTime과 `TIMESTAMP(3)` DDL, legacy 미추론, 문서 컬럼·배포 순서를 서로 대조했다. 어떠한 `prisma migrate` 명령도 실행하지 않았다.

## 변경 파일

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260912090000_command_outcome_status_check/migration.sql`
- `apps/api/src/commands/command-delivery-reliability.spec.ts`
- `apps/api/src/commands/command-timeout.service.ts`
- `apps/api/src/commands/command-timeout.service.spec.ts`
- `apps/api/src/mqtt/outbox-publisher.service.ts`
- `apps/api/src/mqtt/outbox-publisher.service.spec.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.test.ts`
- `docs/database-schema.md`
- `docs/menus/control.md`
- `docs/project-status.md`
- `docs/lesson_leared.md`
- `docs/superpowers/specs/2026-09-12-p0-p1-control-reliability-design.md`
- `docs/superpowers/plans/2026-09-12-p0-p1-control-reliability.md`
- 이 최종 수정 보고서

## Self-review 및 한계

- 신규 Gateway timeout wire와 기존 producer wire를 구분해 검증했다. 원문 aggregate/hash 이전에 결과를 변환하지 않으며, timeout brightness를 적용 성공으로 만들지 않는다.
- 발행 시도 기록은 MQTT 전에 commit되고 worker lease가 사라지면 MQTT를 호출하지 않는다. Retry와 pending timeout은 메모리의 attempts 대신 저장된 기록을 사용한다.
- Automation lock은 publisher의 outbox/dispatch/command mutation보다 먼저 획득한다. Network wait는 transaction 밖이며 terminal writer가 dispatch 경쟁을 잃었을 때 결과와 parent를 쓰지 않는 것은 mutation 검증으로 확인했다.
- unknown인 dimming만 late ACK로 수렴한다. not_applied/legacy null과 status-check timeout을 임의로 재개하지 않는다. Get 실패는 원 Set outcome을 결정하지 않는다.
- Task 2의 claimBatch-backed stateful retry/expiry split은 구현했다. DB double은 영속 상태와 조건부 update만 모델링하며 실제 PostgreSQL row/advisory lock, concurrent ACK, partial index, rollback이나 migration 적용 증거는 아니다. 환경 의존 272개와 해당 PostgreSQL 검증은 미실행으로 남는다.
- Raspberry Pi/BlueZ/ESP32-H2 실제 RF, 다중 fixture/층/저장 구역/Mesh Group, 전원 차단, broker 단절, Gateway kill HIL은 수행하지 않았다. `scripts/*hil*.test.ts`가 포함된 package test는 스크립트 단위 테스트이지 HIL 실행이 아니다.
- Web 715/715, Chromium 21/21와 Web typecheck/build는 기준 커밋 `465984c`의 이전 검증이다. 이번 수정은 API/Gateway/DB·문서 범위로 Web/Chromium을 재실행하지 않았다.
- 신규 제어를 켜기 전 coordinated rollout이 필요하다. 과거 명령 outcome은 NULL로 유지하고, 기록 commit과 실제 MQTT 호출 사이 crash는 보수적 unknown으로 남긴다. 사용자 DB, 운영 broker, 실장비, 다른 worktree 및 main은 변경하지 않았다.

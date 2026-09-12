# 모니터링 수집 시각 신뢰성 P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 미래 장비 시각이 에너지 집계·freshness·MQTT 처리 진행성을 오염시키지 않도록 durable terminal rejection과 서버 수신 시각 기준을 구현한다.

**Architecture:** Shared ACK 계약과 additive Prisma ledger를 먼저 확정한다. API는 scope 검증 뒤 미래 시각을 energy transition 이전에 격리하고 fixture/heartbeat의 장비 시각과 서버 수신 시각을 분리한다. Gateway는 terminal rejection ACK를 exact ACK로 소비해 outbox head를 제거한다.

**Tech Stack:** TypeScript, NestJS, Prisma 6.19, PostgreSQL, MQTT.js, Jest

**Spec:** `docs/superpowers/specs/2026-09-12-monitoring-ingestion-time-trust-design.md`

## Global Constraints

- 기준 branch/worktree 밖의 파일과 사용자 DB를 변경하지 않는다.
- production 코드 전에 회귀 테스트를 작성하고 예상 원인으로 RED를 확인한다.
- 허용 미래 오차 기본값은 300,000ms, 정확한 경계는 허용, 1ms 초과는 거부한다.
- 장비 `occurredAt`과 API `receivedAt`을 덮어쓰지 않고 각 용도에 맞게 별도 보존한다.
- 정상 out-of-order/replay idempotency 의미를 유지하며 payload-conflicting replay는 fail closed 한다.
- `docs/database-schema.md`, `docs/menus/monitoring.md`, `docs/project-status.md`를 같은 작업에서 갱신한다.

---

### Task 1: Shared 계약과 additive ledger

**Files:**
- Modify: `packages/shared/src/gateway-contracts.ts`
- Modify: `packages/shared/src/gateway-contracts.test.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260912090000_gateway_event_received_time/migration.sql`

**Interfaces:**
- Produces: `rejected_future_timestamp` application ACK, `ProcessedGatewayEvent.receivedAt`, `ingestionStatus`
- Consumes: 기존 v2 state ACK exact identity와 legacy processed-event 행

- [x] 실패 계약 테스트에 terminal future rejection 상태를 추가하고 RED 확인
- [x] Shared ACK enum과 Prisma enum/필드를 최소 구현
- [x] 기존 행을 `createdAt`으로 backfill하는 additive SQL migration 작성
- [x] Shared focused test, Prisma format/validate/generate 통과

### Task 2: Fixture-state 시간 경계와 수신 시각 분리

**Files:**
- Create: `apps/api/src/mqtt/gateway-event-time.ts`
- Create: `apps/api/src/mqtt/gateway-event-time.spec.ts`
- Modify: `apps/api/src/energy/fixture-state-ingestion.service.ts`
- Modify: `apps/api/src/energy/fixture-state-ingestion.service.spec.ts`
- Modify: `apps/api/src/energy/fixture-state-ingestion.integration.spec.ts`

**Interfaces:**
- Consumes: Task 1 ledger fields and Shared ACK status
- Produces: `ingest(gatewayId, input, receivedAt?)`, durable future rejection, exact payload replay identity

- [x] 시간 경계와 invalid config 실패 테스트 작성 후 RED 확인
- [x] 큰 미래 이벤트가 cursor/aggregate 경로에 들어가지 않는 서비스 회귀와 payload conflict 테스트 작성 후 RED 확인
- [x] scope 잠금 뒤 transition 이전에 future rejection을 원자적으로 기록
- [x] 정상 fixture snapshot의 `lastSeenAt=receivedAt`, `lastStateOccurredAt=occurredAt` 분리 저장
- [x] disposable PostgreSQL에서 미래 poison 뒤 정상 event 진행성과 aggregate/checkpoint 비오염 검증
- [x] API focused tests 통과

### Task 3: Heartbeat와 MQTT/Gateway 진행성

**Files:**
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt-v2-state.spec.ts`
- Modify: `apps/gateway/src/state/state-event-outbox.test.ts`

**Interfaces:**
- Consumes: Task 1 Shared ACK와 Task 2 시간 정책
- Produces: future heartbeat durable terminal 처리, 서버 수신 시각 heartbeat freshness, future state ACK 뒤 후속 outbox 진행

- [x] 미래 heartbeat가 Gateway를 갱신하지 않고 ledger만 남기는 RED 테스트 작성
- [x] 정상 heartbeat의 `lastHeartbeatAt=receivedAt`, `lastHeartbeatOccurredAt=occurredAt` 분리 RED 테스트 작성
- [x] heartbeat ledger에 payload hash/receivedAt/status를 저장하고 duplicate conflict를 fail closed
- [x] `rejected_future_timestamp` ACK가 exact head를 제거해 다음 event를 publish하는 Gateway RED/GREEN 회귀 추가
- [x] MQTT/API/Gateway focused tests 통과

### Task 4: Freshness, 문서, 최종 검증

**Files:**
- Modify: `apps/api/src/fixtures/fixture-freshness.service.ts`
- Modify: `apps/api/src/fixtures/fixture-freshness.service.spec.ts`
- Modify: `docs/database-schema.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-12-monitoring-ingestion-time-trust.md`

**Interfaces:**
- Consumes: 서버 수신 시각이 저장된 `Fixture.lastSeenAt`, `Gateway.lastHeartbeatAt`
- Produces: 수신 시각 기반 offline/stale 판정과 검증 증거 문서

- [x] fixture stale query가 `lastSeenAt`을 사용하는 RED/GREEN 회귀 추가 — RED는 기존 `lastStateOccurredAt` query와의 mismatch로 실패했고, GREEN은 fixture freshness 2/2 통과.
- [x] schema/monitoring/status 문서를 실제 구현과 software/HIL 경계에 맞춰 갱신
- [x] Shared/API/Gateway focused와 disposable PostgreSQL integration 실행 — Shared 31/31, API focused 59/59, Gateway outbox 9/9, 빈 disposable PostgreSQL에 57 migrations 적용 후 integration 3/3 통과.
- [x] Prisma validate/generate, typecheck, build, `git diff --check` 실행 — `DATABASE_URL` 없이 실행한 첫 Prisma validate는 P1012 환경변수 누락으로 종료했으며, disposable URL을 명시한 재실행은 validate/generate 성공. API/Gateway typecheck/build와 최종 `git diff --check`를 통과.
- [x] 검증 수치·skip·남은 위험을 기록하고 P0를 별도 커밋 — API 전체 1,095 passed/274 environment-dependent skipped (112 passed/27 skipped suites), Gateway 전체 609/609 (64 suites) 통과. 첫 병렬 Gateway 전체 run의 schedule-runtime 1건 실패는 단독 full run에서 재현되지 않아 software concurrency warning으로 기록한다.
- [x] P1 별도 설계 checkpoint 작성 전에는 P1 production 코드에 착수하지 않음 — P1 production 변경 없음.

### Final Fix: legacy null hash 재전송 진행성

**상태:** 완료(소프트웨어). 총괄의 최종 보완 지시에 따라 API/DB 회귀를 먼저 검증했고 Gateway 경계 회귀와 문서를 같은 새 커밋에 포함한다.

- [x] fixture-state/heartbeat의 null hash replay와 CAS 경합·scope·잠금 회귀를 작성하고 RED 확인 — production 변경 전 8 failed/58 passed, identity conflict·CAS 미호출·PUBACK 누락으로 실패.
- [x] 사전 변경 형태의 null hash 원장에서 시작하는 disposable PostgreSQL 회귀 RED 확인 — production 변경 전 legacy fixture·경합·heartbeat 3 failed/기존 3 passed.
- [x] scope/소유 행 잠금 뒤 exact legacy identity의 첫 인증 replay hash를 `eventId AND payloadHash IS NULL` 조건부 갱신하고, 경합 시 재조회한 exact hash만 허용 — 공통 helper는 hash만 변경하며 기존 terminal 결과를 반환한다.
- [x] MQTT 실제 수집 서비스의 duplicate/PUBACK와 Gateway 실제 publisher 후속 event 진행 회귀 검증 — API focused 80/80, Gateway outbox 10/10. Gateway 소비 로직은 기존 구현 그대로이며 새 검증은 pending head 재시작·duplicate ACK·후속 발행을 확인한다.
- [x] historical freshness 비소급 및 최초 인증 replay 신뢰 한계를 spec/schema/monitoring/status에 반영 — 원본 payload 동등성을 소급 증명하지 않으며 과거 energy 정정은 별도 범위다.
- [x] focused·격리 migration/integration·필수 API/Gateway 검사 후 DB 컨테이너 폐기, self-review와 보고서 작성, 단일 새 커밋 — 57 migrations와 integration/upgrade 7/7; API 전체 1,116 passed/278 환경 의존 skip, Gateway 전체 610/610, API/Gateway typecheck·API build·`git diff --check` 통과. `led-p0p1-finalfix-postgres`와 전용 anonymous volume 제거 및 rehearsal schema rollback을 확인했다. 상세 증거는 보존된 `.superpowers/sdd/2026-09-12-monitoring-ingestion-time-trust/final-fix-report.md`에 기록한다.

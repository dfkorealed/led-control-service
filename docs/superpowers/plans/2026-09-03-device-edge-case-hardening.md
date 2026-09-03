# 실장비 엣지 케이스 보강 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 조명 Status 유실, Gateway 재시작, provisioning 발행·terminal 유실이 사용자 상태와 실제 장비 상태를 어긋나게 하지 않도록 자동 복구한다.

**Architecture:** 기존 command journal과 state outbox 패턴을 유지하면서 개별 Lightness 명령에 bounded 확인 단계를 추가한다. Provisioning은 API DB outbox와 Gateway 로컬 terminal journal/application ACK를 양쪽에 두어 broker PUBACK과 업무 완료를 분리한다.

**Tech Stack:** TypeScript, NestJS, Prisma/PostgreSQL, MQTT v5 QoS 1, BlueZ Mesh D-Bus, React Query, Vitest/Jest/Playwright

**Spec:** `docs/superpowers/specs/2026-08-26-monitoring-control-statistics-completion-design.md`의 12절

## Global Constraints

- 실제 ESP32-H2가 없어도 모든 신규 상태 전이와 장애 경계를 자동 테스트한다.
- deadline 이후 RF 전송, accepted 명령의 무조건 재실행, 미확인 요청 밝기의 Fixture 반영을 금지한다.
- broker PUBACK과 API application ACK를 별도 단계로 취급한다.
- 기존 dirty worktree와 기존 migration을 수정하지 않는다.
- 기능 상태는 `docs/menus/control.md`, `docs/menus/monitoring.md`, `docs/project-status.md`, `docs/lesson_leared.md`에 함께 반영한다.

---

### Task 1: Provisioning v2 공유 계약과 API durable outbox

**Files:**
- Modify: `packages/shared/src/gateway-contracts.ts`, `packages/shared/src/schemas.ts`, 관련 테스트
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_provisioning_device_outbox/migration.sql`
- Create: `apps/api/src/mqtt/provisioning-device-outbox-publisher.service.ts`와 테스트
- Modify: `apps/api/src/registration/registration.service.ts`와 테스트
- Modify: `apps/api/src/mqtt/mqtt.module.ts`, `mqtt-shutdown-coordinator.service.ts`와 테스트

**Interfaces:**
- Produces: strict provisioning command identity, device terminal event/application ACK schemas와 topic
- Produces: node 상태 변경과 같은 transaction에서 생성되는 node별 durable command outbox

- [x] **Step 1: 실패 테스트 작성** — 등록 transaction의 outbox 원자 생성, lease 충돌, publish retry/deadletter와 ACK 계약을 고정한다.
- [x] **Step 2: RED 확인** — shared/API focused test가 새 schema/model/service 부재로 실패하는지 확인한다.
- [x] **Step 3: 최소 구현** — 새 migration/model, worker와 registration transaction을 구현한다.
- [x] **Step 4: GREEN 확인** — shared build/test와 API focused test/typecheck를 실행한다.
- [x] **Step 5: 문서와 상태판 갱신** — software 완료와 HIL 미실행을 구분한다.

### Task 2: Gateway provisioning command/terminal journal

**Files:**
- Create: `apps/gateway/src/state/provisioning-device-journal.ts`와 테스트
- Modify: `apps/gateway/src/index.ts`, `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`와 테스트
- Modify: `apps/gateway/docker/*` 계약 테스트 및 예시 환경

**Interfaces:**
- Consumes: Task 1의 provisioning v2 command/terminal/ACK schema와 topic
- Produces: command 중복 억제, terminal 원자 저장·재발행·exact ACK 삭제

- [x] **Step 1: 실패 테스트 작성** — 중복 command, payload conflict, RF 전후 crash 복구, PUBACK 후 ACK 유실, reconnect replay를 고정한다.
- [x] **Step 2: RED 확인** — focused Gateway test 실패를 확인한다.
- [x] **Step 3: 최소 구현** — journal과 runtime handler/재발행/ACK 소비를 연결한다.
- [x] **Step 4: GREEN 확인** — Gateway focused/full test와 typecheck를 실행한다.
- [x] **Step 5: 문서와 상태판 갱신** — 실제 provisioning HIL은 미실행으로 남긴다.

### Task 3: API provisioning terminal ingest와 application ACK

**Files:**
- Modify: `apps/api/src/mqtt/mqtt.service.ts`와 테스트
- Modify: `apps/api/src/registration/registration.service.ts` 또는 terminal 전용 service와 테스트
- Modify: `apps/api/src/automation/automation-outbox-publisher.service.ts`와 필요한 ACK publisher 테스트

**Interfaces:**
- Consumes: Task 2의 strict provisioning device terminal event
- Produces: `ProcessedGatewayEvent`, node/Fixture 변경과 exact terminal ACK outbox의 단일 transaction

- [ ] **Step 1: 실패 테스트 작성** — success/failure/duplicate/conflict/transaction rollback과 ACK revival을 고정한다.
- [ ] **Step 2: RED 확인** — 새 terminal topic이 처리되지 않고 ACK가 생성되지 않는 실패를 확인한다.
- [ ] **Step 3: 최소 구현** — topic scope 검증, 원자 ingest, legacy 호환과 application ACK outbox를 구현한다.
- [ ] **Step 4: GREEN 확인** — API focused/full test, typecheck와 build를 실행한다.
- [ ] **Step 5: 문서와 상태판 갱신** — 양방향 software 수렴과 HIL 미실행을 구분한다.

### Task 4: Lightness 응답 유실과 accepted-only 재시작 복구

**Files:**
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.ts`와 테스트
- Modify: `apps/gateway/src/commands/gateway-command-handler.ts`, `command-journal.ts`와 테스트
- Modify: `apps/gateway/src/index.ts`와 테스트

**Interfaces:**
- Produces: 동일 TID 1회 재전송, Lightness Get 확인, `verification_required` fault code
- Produces: accepted-only unicast 실제 상태 조회 기반 terminal 복구

- [ ] **Step 1: 실패 테스트 작성** — 첫 Status 유실 후 재전송 성공, Get 성공/불일치/무응답, deadline/abort와 restart recovery를 고정한다.
- [ ] **Step 2: RED 확인** — 기존 단일 Set/즉시 indeterminate 구현에서 실패하는지 확인한다.
- [ ] **Step 3: 최소 구현** — 단계별 확인과 journal recovery를 구현한다.
- [ ] **Step 4: GREEN 확인** — Gateway focused/full test, typecheck와 build를 실행한다.
- [ ] **Step 5: 문서와 상태판 갱신** — 기존 40% HIL 실패와 software 보완 상태를 함께 기록한다.

### Task 5: Web 불확정 결과 표현과 전체 회귀

**Files:**
- Modify: `apps/web/src/features/control/ControlView.tsx`와 테스트
- Modify: `apps/web/src/api/commands.ts`와 테스트
- Modify: `apps/web/e2e/monitoring-control-flow.spec.ts`
- Modify: `docs/menus/control.md`, `docs/menus/monitoring.md`, `docs/project-status.md`, `docs/lesson_leared.md`, `docs/database-schema.md`

**Interfaces:**
- Consumes: `verification_required` fault code와 기존 `timed_out` stage
- Produces: 일반 실패와 적용 여부 확인 불가를 구분하는 사용자 흐름

- [ ] **Step 1: 실패 테스트 작성** — 불확정 문구, 요청값 미표시, 상태 재조회 행동을 고정한다.
- [ ] **Step 2: RED 확인** — 기존 시간 초과 문구에서 실패하는지 확인한다.
- [ ] **Step 3: 최소 구현** — 공통 피드백 UI와 query invalidation/refetch를 연결한다.
- [ ] **Step 4: GREEN 확인** — Web focused/full test, typecheck, build와 관련 Playwright를 실행한다.
- [ ] **Step 5: 전체 검증** — shared/API/Gateway/Web 회귀, migration 검토와 `git diff --check`를 실행한다.

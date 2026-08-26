# 모니터링·제어·통계 완료 구현 계획

> **에이전트 작업자 필수 규칙:** 각 Task는 `superpowers:subagent-driven-development`로 구현하고 구현자와 QA를 분리한다. 모든 단계는 체크박스로 추적한다.

**목표:** 모니터링과 수동 제어의 확인된 누락을 보완하고, MQTT 상태 이력 기반 전력 통계를 실제 브라우저에서 사용할 수 있게 완성한다.

**구조:** 공유 Prisma·MQTT 계약을 먼저 변경하고 API, Gateway, Web이 순차 소비한다. 기능별 자동 테스트 뒤 실제 로컬 API·DB와 Chromium으로 사용자 흐름을 검증하고, 마지막에는 operator 설치부터 admin 운영까지 하나의 E2E로 재검증한다.

**기술 스택:** TypeScript, NestJS, Prisma, PostgreSQL, MQTT 5, React, React Query, Recharts, Playwright, Vitest, Jest

**Spec:** `docs/superpowers/specs/2026-08-26-monitoring-control-statistics-completion-design.md`

## 전역 제약

- 문서와 화면 문구는 한글로 작성한다.
- 테스트를 먼저 작성하고 요구 동작 때문에 실패하는 것을 확인한 뒤 구현한다.
- production 코드에 mock·가짜 조명·자동 성공 경로를 추가하지 않는다.
- 실제 브라우저 QA는 로컬 PostgreSQL·Redis·API·Web을 사용한다. 하드웨어 이벤트는 `e2e` 전용 publisher에서만 주입하고 한계를 결과에 기록한다.
- 스케줄·이벤트 제어, push, 장애 운영, 모바일, 실측 계량은 구현하지 않는다.
- DB 변경은 `docs/database-schema.md`, 메뉴 변경은 해당 `docs/menus/*.md`를 같은 Task에서 갱신한다.
- 실제 Raspberry Pi·ESP32-H2 HIL을 실행하지 않았으면 코드 완료와 실기 완료를 구분한다.

---

### Task 1: 공유 스키마와 Prisma 기반 계약

**Files:**
- Modify: `packages/shared/src/gateway-contracts.ts`
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/mqtt.ts`
- Modify: `packages/shared/src/*.test.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260826_menu_completion_foundation/migration.sql`
- Modify: `docs/database-schema.md`

**Produces:** scan lifecycle event, desired group reconciliation, state-ingested ACK, command `clientRequestId`, energy·group lifecycle 모델.

- [x] 공유 schema에서 scan correlation, found/completed/failed와 application ACK 실패 테스트를 작성한다.
- [x] Prisma schema 검사에서 lifecycle·energy·멱등성 제약 부재로 실패를 확인한다.
- [x] Spec의 필드, enum, unique/index/check/trigger와 legacy backfill migration을 구현한다.
- [x] `pnpm --filter @led-control/shared test && pnpm --filter @led-control/api prisma:generate`를 실행한다.
- [x] `docs/database-schema.md`를 갱신하고 `feat(shared): define menu completion contracts`로 커밋한다.

### Task 2: 검색 lifecycle API와 Gateway 계약

**Files:**
- Modify: `apps/api/src/registration/registration.service.ts`
- Modify: `apps/api/src/registration/registration.controller.ts`
- Modify: `apps/api/src/registration/*.spec.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.spec.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/gateway.ts`
- Modify: `apps/gateway/src/gateway.test.ts`
- Modify: `docs/menus/monitoring.md`

**Produces:** gateway당 active scan 1개, retry endpoint, correlation된 found/completed/failed, 상태를 바꾸지 않는 identify 501.

- [ ] 0건 완료, 실패, 지연 found 무시, retry 충돌과 identify 무상태 변경 테스트를 먼저 작성한다.
- [ ] 테스트가 기존 무한 scanning·허위 identify 동작 때문에 실패하는지 확인한다.
- [ ] API 행 잠금과 Gateway terminal event 발행을 구현한다.
- [ ] API·Gateway 관련 테스트와 typecheck를 실행한다.
- [ ] 모니터링 문서를 갱신하고 `feat(monitoring): complete device scan lifecycle`로 커밋한다.

#### Fix Round 4: 검색 terminal ingestion 확인

- [x] pre-connected startup recovery가 subscription 준비 뒤 정확히 한 번 실행되는 RED/GREEN을 확인한다.
- [x] strict scan-terminal application ACK 계약과 API commit 이후 ACK·duplicate ACK RED/GREEN을 확인한다.
- [x] Gateway가 exact application ACK에서만 terminal을 delivered 처리하고 PUBACK·offline·transaction failure에서는 보존하는 RED/GREEN을 확인한다.
- [x] undelivered terminal retention/capacity 보호와 capacity fail-closed RED/GREEN을 확인한다.
- [x] recovery publish timeout·disconnect cancellation·fresh reconnect·동시 drain 직렬화 RED/GREEN을 확인한다.
- [x] Shared/API/Gateway 전체 검증과 문서·보고서·커밋을 완료한다.

### Task 3: 모니터링 Web과 실제 브라우저 QA

**Files:**
- Modify: `apps/web/src/api/registration.ts`
- Modify: `apps/web/src/features/registration/RegistrationPanel.tsx`
- Modify: `apps/web/src/features/registration/RegistrationPanel.test.tsx`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/features/monitoring/MonitoringView.test.tsx`
- Modify: `apps/web/e2e/monitoring-control-flow.spec.ts`
- Modify: `docs/menus/monitoring.md`

**Produces:** 완료·0건·실패·재검색 UI, identify 제거, 등록 query invalidation, 지도 오류·재시도.

- [ ] 등록·지도 상태 단위 테스트와 Playwright 시나리오를 먼저 실패시킨다.
- [ ] React Query polling 종료·재시작과 invalidation을 구현한다.
- [ ] 지도 오류와 이전 snapshot 유지, 재시도 UI를 구현한다.
- [ ] Web test/typecheck/build를 실행한다.
- [ ] 로컬 API·DB·Web을 띄우고 Chromium에서 scan 0건, 실패, 성공 등록, 지도 오류 복구를 QA한다.
- [ ] 문서와 증거를 갱신하고 `feat(web): finish monitoring registration states`로 커밋한다.

### Task 4: 저장 구역 CRUD와 desired membership

**Files:**
- Create: `apps/api/src/fixture-groups/fixture-groups.module.ts`
- Create: `apps/api/src/fixture-groups/fixture-groups.controller.ts`
- Create: `apps/api/src/fixture-groups/fixture-groups.service.ts`
- Create: `apps/api/src/fixture-groups/fixture-groups.service.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/mesh-control-groups/mesh-control-group.service.ts`
- Modify: `apps/api/src/mesh-control-groups/mesh-group-sync.worker.ts`
- Modify: `apps/api/src/mesh-control-groups/*.spec.ts`
- Modify: `docs/menus/control.md`

**Produces:** operator/admin CRUD, 한 층·gateway 경계, 15개 한도, active/retiring/retired/invalid, desired add/delete sync.

- [ ] 권한·경계·한도·legacy invalid·삭제 실패 테스트를 작성한다.
- [ ] migration 적용 전 실패와 서비스 테스트 RED를 확인한다.
- [ ] transaction 잠금, 전체 membership 교체와 soft delete/resync를 구현한다.
- [ ] API·Mesh group 테스트, typecheck, build를 실행한다.
- [ ] 제어 문서를 갱신하고 `feat(control): add managed fixture groups`로 커밋한다.

### Task 5: Gateway 구독 해제와 ACK 완전성

**Files:**
- Modify: `apps/gateway/src/mesh/bluez-config-client.ts`
- Modify: `apps/gateway/src/mesh/bluez-config-client.test.ts`
- Modify: `apps/gateway/src/mesh/group-subscription-handler.ts`
- Modify: `apps/gateway/src/mesh/group-subscription-handler.test.ts`
- Modify: `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.spec.ts`
- Modify: `docs/menus/control.md`

**Produces:** Model Subscription Add/Delete reconciliation과 완전한 fixture/result-derived ACK 검증.

- [ ] add/delete diff, operation ACK와 누락·중복·외부 fixture/status 불일치 테스트를 작성한다.
- [ ] 기존 add-only·부분 ACK 수락으로 실패하는지 확인한다.
- [ ] Gateway reconcile과 API fail-closed terminal 처리를 구현한다.
- [ ] API·Gateway 전체 관련 테스트와 typecheck를 실행한다.
- [ ] `feat(control): reconcile subscriptions and validate ACKs`로 커밋한다.

### Task 6: 제어 요청 멱등성

**Files:**
- Modify: `apps/api/src/commands/commands.controller.ts`
- Modify: `apps/api/src/commands/commands.service.ts`
- Modify: `apps/api/src/commands/commands.service.spec.ts`
- Modify: `apps/web/src/api/commands.ts`
- Modify: `apps/web/src/api/commands.test.ts`
- Modify: `apps/web/src/features/control/active-command-store.ts`
- Modify: `apps/web/src/features/control/active-command-store.test.ts`
- Modify: `apps/web/src/features/control/ControlView.tsx`

**Produces:** 동일 payload 재시도는 기존 Command, 다른 payload는 409, POST 응답 유실 복구.

- [ ] 동시 unique 충돌, payload conflict, 브라우저 응답 유실 테스트를 작성한다.
- [ ] RED 확인 후 transaction 재조회와 canonical fingerprint를 구현한다.
- [ ] Web sessionStorage에 요청 ID와 canonical payload를 terminal까지 보존한다.
- [ ] API·Web 테스트와 typecheck를 실행한다.
- [ ] `feat(control): make command creation idempotent`로 커밋한다.

### Task 7: 제어 Web과 실제 브라우저 QA

**Files:**
- Create: `apps/web/src/api/fixture-groups.ts`
- Create: `apps/web/src/features/control/FixtureGroupDialog.tsx`
- Create: `apps/web/src/features/control/FixtureGroupDialog.test.tsx`
- Modify: `apps/web/src/features/control/ControlTargetPicker.tsx`
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Modify: `apps/web/src/features/control/ControlView.test.tsx`
- Modify: `apps/web/e2e/monitoring-control-flow.spec.ts`
- Modify: `docs/menus/control.md`

**Produces:** 구역 관리 dialog, floor/group configuring·failed·ready 표시, viewer 읽기 전용.

- [ ] role·준비 상태·CRUD·재동기화 UI 테스트와 Playwright 흐름을 먼저 실패시킨다.
- [ ] 공통 UI 패턴으로 dialog와 target 상태를 구현한다.
- [ ] Web test/typecheck/build를 실행한다.
- [ ] 실제 Chromium에서 admin CRUD, viewer 제한, 개별·다중·층·구역 제어와 terminal 결과를 QA한다.
- [ ] 문서를 갱신하고 `feat(web): complete manual control workflows`로 커밋한다.

### Task 8: 상태 기반 에너지 적산과 전달 보장

**Files:**
- Create: `apps/api/src/energy/energy-aggregation.ts`
- Create: `apps/api/src/energy/energy-aggregation.spec.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt-v2-state.spec.ts`
- Create: `apps/gateway/src/state/state-event-outbox.ts`
- Create: `apps/gateway/src/state/state-event-outbox.test.ts`
- Modify: `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`
- Modify: `apps/gateway/src/runtime/gateway-mqtt-runtime.test.ts`
- Modify: `docs/menus/statistics.md`

**Produces:** 180초 known/unknown 일별 적산, powerOn, 열린 구간 기반, PUBACK 후 application ACK durable outbox.

- [ ] 중복·역순·OFF·첫 상태·180초·자정/DST·Decimal 테스트를 작성한다.
- [ ] durable outbox 재시작·ACK·100k/100MiB fail-closed 테스트를 작성한다.
- [ ] RED 확인 후 transaction 적산과 MQTT 5 ACK 경계를 구현한다.
- [ ] API·Gateway 테스트와 typecheck를 실행한다.
- [ ] 통계 문서를 갱신하고 `feat(energy): persist state based energy usage`로 커밋한다.

### Task 9: 통계 summary와 series API

**Files:**
- Modify: `apps/api/src/energy/energy.service.ts`
- Modify: `apps/api/src/energy/energy.service.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Create: `apps/api/src/energy/energy.integration.spec.ts`
- Modify: `docs/menus/statistics.md`

**Produces:** summary, day/month series, fixture별 forecast, 실제 월 UTC 초 24시간 baseline, coverage gate.

- [ ] 권한, no-data, partial, fixture별 1시간, 현장 80%, DST baseline 테스트를 작성한다.
- [ ] RED 확인 후 열린 구간 projection과 period query를 구현한다.
- [ ] 기존 estimate endpoint는 deprecated 병행한다.
- [ ] API unit/integration/typecheck/build를 실행한다.
- [ ] `feat(energy): add summary forecast and time series`로 커밋한다.

### Task 10: 통계 Web과 실제 브라우저 QA

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/web/src/api/energy.ts`
- Modify: `apps/web/src/features/statistics/StatisticsView.tsx`
- Create: `apps/web/src/features/statistics/StatisticsView.test.tsx`
- Create: `apps/web/e2e/statistics-flow.spec.ts`
- Modify: `docs/menus/statistics.md`

**Produces:** 오늘·월·년 카드, day/month LineChart, forecast·baseline·절감 비용, no-data/partial 상태.

- [ ] Recharts UI와 접근성, null point, empty/partial 테스트를 작성한다.
- [ ] `recharts`를 설치하고 API query와 responsive chart를 구현한다.
- [ ] Web test/typecheck/build를 실행한다.
- [ ] 실제 Chromium에서 데이터 없음, 정상·부분 수집, 탭·tooltip·비용을 QA한다.
- [ ] 문서를 갱신하고 `feat(statistics): add energy history and savings report`로 커밋한다.

### Task 11: 최초 설치부터 고객 운영까지 브라우저 E2E

**Files:**
- Create: `apps/web/e2e/installation-customer-journey.spec.ts`
- Create: `apps/web/e2e/support/real-backend-lab.ts`
- Modify: `apps/web/playwright.config.ts`
- Modify: `docs/project-status.md`

**Produces:** real local backend 기반 operator 설치와 admin 운영 journey 증거.

- [ ] 격리 DB와 test-only gateway publisher를 준비하고 production bundle에 포함되지 않음을 테스트한다.
- [ ] operator 로그인, 현장·층·claim, scan 완료·등록·지도·Health 확인을 자동화한다.
- [ ] admin 로그인, 구역 생성, 개별·다중·층·구역 제어 terminal, 통계 조회를 자동화한다.
- [ ] Chromium trace/screenshot/network 결과를 저장하고 실패 상태를 검토한다.
- [ ] 실제 하드웨어 미검증 경계를 상태판에 기록한다.
- [ ] `test(e2e): cover installation to customer operation`으로 커밋한다.

### Task 12: 전체 회귀와 최종 독립 QA

**Files:**
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/project-status.md`
- Modify: `docs/lesson_leared.md`
- Modify: `docs/superpowers/plans/2026-08-26-monitoring-control-statistics-completion.md`

**Produces:** 구현·문서·브라우저 증거가 일치하는 최종 상태.

- [ ] `pnpm typecheck && pnpm lint && pnpm test`를 실행한다.
- [ ] API/Web build와 관련 Playwright 전체를 실행한다.
- [ ] 실제 브라우저에서 정상 operator/admin/viewer 흐름을 마지막으로 수동 확인한다.
- [ ] 독립 QA가 요구사항, 보안, 회귀, mock 경계와 문서 일치를 검토한다.
- [ ] 모든 체크리스트와 상태판을 실제 증거에 맞춰 갱신한다.
- [ ] `docs: complete monitoring control and statistics`로 커밋한다.

## 완료 조건

- 모니터링 scan과 지도 오류가 종료 상태와 복구 동작을 가진다.
- operator/admin이 구역을 관리하고 ready 상태에서만 제어할 수 있다.
- 개별·다중·층·구역 명령은 중복 생성 없이 terminal 결과로 끝난다.
- 통계가 오늘·월·년, 일·월 LineChart, 월 예상 비용과 24시간 100% 절감 비용을 상태 기반 추정으로 표시한다.
- 기능별 및 전체 실제 Chromium QA가 통과한다.
- Raspberry Pi·ESP32-H2 HIL 미실행은 별도 공백으로 남는다.

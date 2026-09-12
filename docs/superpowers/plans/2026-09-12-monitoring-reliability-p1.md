# 모니터링 신뢰성 P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 30초 polling과 cached stale fallback, 현장별 freshness 기준, incident 확인·담당·해결 이력을 모니터링에 제공한다.

**Architecture:** Site가 freshness 정책의 정본이며 API 응답이 서버 snapshot 시각을 전달한다. 기존 freshness worker가 현재 상태를 반영한 뒤 incident reconciler를 실행한다. Web은 마지막 성공 데이터를 유지하고 SidePanel tab 안에서 상세와 incident workflow를 함께 제공한다.

**Tech Stack:** NestJS, Prisma/PostgreSQL, React 18, TanStack Query, Vitest/Jest, Playwright

**Spec:** `docs/superpowers/specs/2026-09-12-monitoring-reliability-p1-design.md`

## Global Constraints

- P0 커밋과 분리하며 사용자 DB migration/배포/HIL을 수행하지 않는다.
- production 코드 전에 실패 회귀를 작성하고 RED를 확인한다.
- polling 30초, stale 60초, retry 최대 2회, gateway threshold 30–900초, fixture threshold 60–3,600초를 사용한다.
- 모든 tenant 조회/변경은 current Site scope와 capability를 재검증한다.
- incident mutation은 optimistic concurrency와 AuditLog를 적용한다.
- cached dashboard/fixture/map 데이터와 현재 선택은 background failure에서 사라지지 않아야 한다.
- `docs/database-schema.md`, `docs/menus/monitoring.md`, `docs/project-status.md`를 갱신한다.

---

### Task 1: Site 정책과 incident schema/API

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260912100000_monitoring_policy_incidents/migration.sql`
- Create: `apps/api/src/monitoring-incidents/*`
- Modify: `apps/api/src/app.module.ts`

- [x] schema/migration/DTO/권한/optimistic concurrency RED 작성
- [x] Site 정책 GET/PATCH와 incident list/ack/assign/resolve API 구현
- [x] active target unique/check constraints와 AuditLog 구현
- [x] API unit 및 disposable PostgreSQL integration 통과

### Task 2: Site별 freshness와 incident reconcile

**Files:**
- Modify: `apps/api/src/fixtures/fixture-freshness.service.ts`
- Modify: `apps/api/src/fixtures/fixture-freshness.service.spec.ts`
- Modify: `apps/api/src/sites/sites.service.ts`
- Modify: `apps/api/src/sites/sites.service.spec.ts`
- Modify: `apps/api/src/fixtures/fixtures.service.ts`
- Modify: `apps/api/src/fixtures/fixtures.service.spec.ts`
- Modify: `apps/api/src/monitoring-incidents/*`

- [x] 서로 다른 Site threshold와 single-flight/reconcile RED 작성
- [x] freshness sweep과 dashboard/fixture connection 판정을 Site 정책으로 통일
- [x] active condition open/update와 recovery auto-resolve 구현
- [x] dashboard/fixture `generatedAt`과 `monitoringPolicy` metadata 구현
- [x] API focused 및 disposable PostgreSQL lifecycle 통과

### Task 3: Web cached freshness와 상태 원인 통일

**Files:**
- Modify: `apps/web/src/api/queries.ts`
- Modify: `apps/web/src/api/queries.test.tsx`
- Create: `apps/web/src/features/monitoring/fixture-status-presentation.ts`
- Create: `apps/web/src/features/monitoring/fixture-status-presentation.test.ts`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/features/monitoring/MonitoringView.test.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.tsx`

- [x] 30초 polling/2회 retry/focus와 API metadata 타입 RED 작성
- [x] cached dashboard error에서도 화면·선택 유지와 60초 stale banner RED 작성
- [x] statusReason별 label/설명/action presenter RED 작성
- [x] polling/fallback/banner/presenter 최소 구현 및 Web focused 통과

### Task 4: Incident와 정책 Web UI

**Files:**
- Create: `apps/web/src/api/monitoring-incidents.ts`
- Create: `apps/web/src/api/monitoring-incidents.test.ts`
- Create: `apps/web/src/features/monitoring/MonitoringIncidentPanel.tsx`
- Create: `apps/web/src/features/monitoring/MonitoringIncidentPanel.test.tsx`
- Create: `apps/web/src/features/monitoring/MonitoringPolicyDialog.tsx`
- Create: `apps/web/src/features/monitoring/MonitoringPolicyDialog.test.tsx`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/styles.css`

- [x] incident query/mutation path와 cache invalidation RED 작성
- [x] read-only/manage tab, filter/history/ack/assign/resolve RED 작성
- [x] threshold dialog validation/conflict/focus RED 작성
- [x] 공통 SidePanel 내부 구현과 320px overflow 회귀 통과

### Task 5: Browser integration, docs, final convergence

**Files:**
- Modify: `apps/web/e2e/calm-operations-monitoring.spec.ts`
- Modify: `docs/database-schema.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-12-monitoring-reliability-p1.md`

- [x] cached partial failure/exact 60,000ms fresh·60,001ms stale/네 장애 reason/production-valid incident workflow Chromium RED/GREEN (`25/25`)
- [x] 네 viewport incident/policy 전후 layout/overflow와 map selection·120% zoom 보존 검증 (1440/1024/390/320)
- [x] no-floor와 Gateway 1/Fixture 0 및 fixture 최초 조회 실패에서도 site-wide incident/policy 접근 유지, 비활성 floor query 피드백 억제, 지도 3회 실패 뒤 최신 자동 poll 성공의 지도/toolbar 경고 해제·선택/배율 보존 검증
- [x] 빈 disposable PostgreSQL 전체 `59` migrations 및 API lifecycle `69/69`(`37` integration + `32` unit) 실행
- [x] Shared `197`, API `1,153`, Web `733`, Gateway `610`(64 files) tests와 typecheck/build/diff check 실행
- [x] 실제 검증 수치와 실제 MQTT broker/Raspberry Pi/BlueZ/ESP32-H2 HIL/production notification 제외 범위를 문서화

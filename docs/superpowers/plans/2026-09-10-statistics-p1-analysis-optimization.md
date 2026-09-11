# Statistics P1 Usage Analysis Implementation Plan

> **2026-09-11 scope decision:** 사용자 최종 확인에 따라 이번 구현에서는 사용 분석만 진행한다. 기존 Task 6(운영 시간/낭비), Task 7(월 목표/예산), Task 9(최적화 화면)는 구현하지 않으며 `/statistics/optimization`도 노출하지 않는다. 아래 해당 절은 후속 검토를 위한 설계 기록으로만 유지하고 실행 체크리스트에서 제외한다.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 분석 이력과 시간별 집계를 도입하고 조명·층·그룹 사용량 순위를 `/statistics/analysis`에 제공한다.

**Architecture:** Operational Fixture와 분석 identity를 분리하고 유효기간 dimension/group membership으로 변경 이력을 보존한다. 상태 ingest는 기존 daily aggregate와 신규 hourly aggregate를 한 transaction에서 갱신하며, ranking API는 P0 품질 규칙과 동일한 수집률·이력 품질 기준을 사용한다.

**Tech Stack:** TypeScript, Zod, NestJS, Prisma 6/PostgreSQL, Decimal, React 18, React Router 7, TanStack Query 5, Recharts 3, Vitest, Jest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-statistics-analytics-roadmap-design.md`

**UI Reference:** `docs/assets/statistics-analytics/statistics-analysis-ui.png`

## Global Constraints

- P0 구현과 기존 summary·series·comparisons 계약을 유지한다.
- Operational Fixture 삭제 후 daily/hourly 분석 이력이 보존되어야 한다.
- migration 이전 층·그룹 구조를 현재 구조로 소급 생성하지 않는다.
- migration 이전 기간이 포함되면 site 합계는 제공하되 차원 순위에서는 제외한다.
- 그룹은 복수 소속 가능하며 그룹 합계를 현장 총계로 표현하지 않는다.
- 시간별 집계는 활성화 이후만 기록하고 daily aggregate로 가짜 backfill하지 않는다.
- `bucketStartUtc`, `localDate`, `localHour`, `utcOffsetMinutes`를 함께 저장한다.
- 비운영 시간 정책은 조명 제어용 `LightingSchedule`과 분리한다.
- unknown seconds는 낭비나 절감으로 계산하지 않는다.
- 시간별 데이터 7일 미만이면 waste 결과 대신 `hourly_history_insufficient`를 반환한다.
- operating-hours와 target mutation은 assigned admin만 가능하고 viewer는 조회만 가능하다.
- DB schema 변경과 같은 작업에서 `docs/database-schema.md`를 갱신한다.

---

## File Structure

- `packages/shared/src/energy-analytics-contracts.ts`: ranking, operating-hours, waste, target strict schemas.
- `apps/api/prisma/schema.prisma`: analytics identity/history/hourly/policy/target models.
- `apps/api/prisma/migrations/20260911120000_energy_analytics_history_hourly/migration.sql`: 보존형 FK와 backfill.
- `apps/api/src/energy/energy-dimension-history.service.ts`: fixture/floor/group history 변경.
- `apps/api/src/energy/energy-hourly-aggregation.ts`: UTC hour split과 weighted brightness.
- `apps/api/src/energy/energy-rankings.service.ts`: SQL 기반 dimension ranking.
- `apps/api/src/energy/operating-hours.service.ts`: policy CRUD와 effective version.
- `apps/api/src/energy/energy-waste.service.ts`: policy/hourly aggregate 교차 분석.
- `apps/api/src/energy/energy-targets.service.ts`: 현지 월 목표 CRUD와 progress.
- `apps/web/src/features/statistics/analysis/*`: ranking, dimension selector, drilldown.
- `apps/web/src/features/statistics/optimization/*`: waste, operating hours, target/budget.
- `docs/database-schema.md`, `docs/menus/statistics.md`, `docs/project-status.md`: DB·기능 상태.

### Task 1: P1 Shared API 계약

**Files:**
- Create: `packages/shared/src/energy-analytics-contracts.ts`
- Create: `packages/shared/src/energy-analytics-contracts.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: P0 `energyComparisonPresetSchema`, 공통 source/data-status 규칙.
- Produces: `EnergyRankingResponse`, `OperatingHoursPolicy`, `EnergyWasteResponse`, `EnergyMonthlyTargetResponse`와 request schemas.

- [x] **Step 1: strict schema 실패 테스트를 작성한다.**

```ts
expect(energyRankingQuerySchema.parse({ dimension: "floor", metric: "usage", sort: "desc", limit: "10" })).toEqual({
  dimension: "floor", metric: "usage", sort: "desc", limit: 10
});
expect(() => operatingHoursPolicyInputSchema.parse({ weekly: {}, allowedBrightness: 101 })).toThrow();
expect(() => energyMonthlyTargetInputSchema.parse({ targetKwh: null, budgetAmount: null })).toThrow();
```

- [x] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/shared test -- energy-analytics-contracts.test.ts`
  - Expected: FAIL because P1 schemas do not exist.

- [x] **Step 3: exact enum과 response schema를 구현한다.**
  - dimension: `fixture | floor | group`
  - metric: `usage | cost | contribution | per_fixture_average`
  - history quality: `observed | legacy_structure_unknown`
  - waste reason: `available | operating_hours_unavailable | hourly_history_insufficient`
  - target status: `headroom | warning | projected_over | forecast_unavailable | not_configured`
  - operating hours는 0~23 정수 hour와 자정 통과 `startHour > endHour`를 허용한다.

- [x] **Step 4: shared test와 export smoke를 검증한다.**
  - Run: `pnpm --filter @led-control/shared test && pnpm --filter @led-control/shared typecheck`
  - Expected: strict parse, cross-field refine, package exports PASS.

- [x] **Step 5: 커밋한다.**
  - Run: `git add packages/shared/src/energy-analytics-contracts.ts packages/shared/src/energy-analytics-contracts.test.ts packages/shared/src/index.ts && git commit -m "feat(shared): add energy analytics contracts"`

### Task 2: 분석 identity, history, hourly schema

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260911120000_energy_analytics_history_hourly/migration.sql`
- Modify: `apps/api/test/domain-schema.test.ts`
- Modify: `docs/database-schema.md`

**Interfaces:**
- Consumes: existing Fixture, Floor, FixtureGroup, GroupFixture, FixtureEnergyDailyAggregate.
- Produces: `EnergyFixtureIdentity`, `EnergyFixtureDimensionVersion`, `EnergyGroupIdentity`, `EnergyGroupDimensionVersion`, `EnergyGroupMembershipVersion`, `FixtureEnergyHourlyAggregate`.

- [x] **Step 1: schema invariant 실패 테스트를 작성한다.**
  - domain-schema test에서 신규 table, `(energyFixtureId,bucketStartUtc)` unique, daily `energyFixtureId`, old fixture FK `ON DELETE SET NULL`, effective range check를 요구한다.

- [x] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand test/domain-schema.test.ts`
  - Expected: FAIL because migration and models are absent.

- [x] **Step 3: Prisma models와 enum을 추가한다.**

```prisma
model EnergyFixtureIdentity {
  id                String   @id @default(uuid())
  siteId            String
  fixtureId         String?  @unique
  trackingStartedAt DateTime
  retiredAt         DateTime?
  fixture           Fixture? @relation(fields: [fixtureId], references: [id], onDelete: SetNull)
  dailyAggregates   FixtureEnergyDailyAggregate[]
  hourlyAggregates  FixtureEnergyHourlyAggregate[]
  dimensionVersions EnergyFixtureDimensionVersion[]
}
```

  - daily aggregate는 `fixtureId String?`, `energyFixtureId String`을 함께 가지고 신규 unique는 `(energyFixtureId, localDate)`다.
  - hourly은 `brightnessWeightedSeconds Decimal(20,4)`와 known/unknown seconds를 가진다.

- [x] **Step 4: 보존형 migration을 작성한다.**
  - 현재 Fixture마다 identity를 생성한다.
  - dimension/group identity와 membership version은 migration timestamp부터 시작한다.
  - 기존 daily row의 `energyFixtureId`를 fixture mapping으로 backfill한 뒤 NOT NULL로 만든다.
  - 기존 daily fixture FK를 `ON DELETE SET NULL`로 바꾸고 fixtureId를 nullable로 만든다.
  - 유효기간 overlap은 PostgreSQL exclusion constraint 또는 transaction advisory lock+partial unique로 차단하며 migration test가 exact SQL을 고정한다.

- [x] **Step 5: Prisma Client와 schema 문서를 갱신한다.**
  - Run: `pnpm --filter @led-control/api prisma:generate`
  - `docs/database-schema.md`에 신규 모델, retention, operational/analytics 분리, migration 이전 이력 한계를 기록한다.

- [x] **Step 6: schema 검증을 실행한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand test/domain-schema.test.ts`
  - Run: `pnpm --filter @led-control/api typecheck`
  - Expected: schema invariant and typecheck PASS.

- [x] **Step 7: 커밋한다.**
  - Run: `git add apps/api/prisma apps/api/test/domain-schema.test.ts docs/database-schema.md && git commit -m "feat(api): add energy analytics history schema"`

### Task 3: Dimension과 membership 이력 lifecycle

**Files:**
- Create: `apps/api/src/energy/energy-dimension-history.service.ts`
- Create: `apps/api/src/energy/energy-dimension-history.service.spec.ts`
- Modify: `apps/api/src/energy/energy.module.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.spec.ts`
- Modify: `apps/api/src/floor-editor/floor-editor.service.ts`
- Modify: `apps/api/src/floor-editor/floor-editor.service.spec.ts`
- Modify: `apps/api/src/fixture-groups/fixture-groups.service.ts`
- Modify: `apps/api/src/fixture-groups/fixture-groups.service.spec.ts`

**Interfaces:**
- Consumes: Task 2 models and transaction client.
- Produces: `createFixtureIdentity`, `recordFixtureDimensions`, `replaceGroupMemberships`, `retireFixture` transaction methods.

- [x] **Step 1: lifecycle 실패 테스트를 작성한다.**
  - provisioning 완료 transaction이 Fixture와 identity/version을 함께 생성한다.
  - name/floor/ratedW 변경은 old effectiveTo를 닫고 new version을 생성한다.
  - 좌표·placement만 변경하면 version을 만들지 않는다.
  - group update는 removed membership을 닫고 added membership만 생성한다.

- [x] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/energy-dimension-history.service.spec.ts src/registration/registration.service.spec.ts src/floor-editor/floor-editor.service.spec.ts src/fixture-groups/fixture-groups.service.spec.ts`
  - Expected: FAIL because history service is absent.

- [x] **Step 3: transaction-only history service를 구현한다.**

```ts
recordFixtureDimensions(tx: Prisma.TransactionClient, input: {
  fixtureId: string; siteId: string; name: string; floorId: string; floorName: string;
  ratedWatt: Prisma.Decimal; effectiveAt: Date;
}): Promise<void>
```

  - 같은 값이면 no-op, 변경이면 열린 row를 먼저 닫는다.
  - service 내부에서 별도 top-level transaction을 만들지 않는다.

- [x] **Step 4: MQTT provisioning/floor editor/group service에 연결한다.**
  - 모든 history write는 operational mutation과 같은 transaction에 둔다.
  - group rename과 membership replacement는 `FixtureGroupsService.update`의 locked transaction에 넣는다.
  - site cascade delete는 identity도 site FK cascade로 제거한다.

- [x] **Step 5: lifecycle 회귀를 검증한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/energy-dimension-history.service.spec.ts src/registration/registration.service.spec.ts src/floor-editor/floor-editor.service.spec.ts src/fixture-groups/fixture-groups.service.spec.ts`
  - Expected: mutation/history atomicity PASS.

- [x] **Step 6: 커밋한다.**
  - Run: `git add apps/api/src/energy apps/api/src/registration apps/api/src/floor-editor apps/api/src/fixture-groups && git commit -m "feat(api): preserve energy dimension history"`

### Task 4: 시간별 집계와 ingest 원자성

**Files:**
- Create: `apps/api/src/energy/energy-hourly-aggregation.ts`
- Create: `apps/api/src/energy/energy-hourly-aggregation.spec.ts`
- Modify: `apps/api/src/energy/energy-aggregation.ts`
- Modify: `apps/api/src/energy/energy-aggregation.spec.ts`
- Modify: `apps/api/src/energy/fixture-state-ingestion.service.ts`
- Modify: `apps/api/src/energy/fixture-state-ingestion.service.spec.ts`
- Modify: `apps/api/src/energy/fixture-state-ingestion.integration.spec.ts`

**Interfaces:**
- Consumes: state transition intervals and `energyFixtureId`.
- Produces: `HourlyEnergyDelta[]` and atomic daily/hourly persistence.

- [x] **Step 1: hour split 실패 테스트를 작성한다.**

```ts
expect(splitKnownIntervalByUtcHour({
  from: new Date("2026-09-10T00:30:00Z"), to: new Date("2026-09-10T02:15:00Z"),
  brightness: 60, ratedWatt: new Prisma.Decimal(100), timeZone: "Asia/Seoul"
})).toHaveLength(3);
```

  - 30/60/15분 known seconds, brightnessWeightedSeconds, DST repeated local hour를 검증한다.

- [x] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/energy-hourly-aggregation.spec.ts`
  - Expected: FAIL because hourly splitter is absent.

- [x] **Step 3: UTC hour splitter와 delta merge를 구현한다.**
  - bucket은 UTC 정각 경계로 자른다.
  - localDate/localHour/utcOffsetMinutes는 각 bucketStartUtc에서 계산한다.
  - known과 unknown interval 모두 저장하되 unknown은 kWh와 weighted brightness를 증가시키지 않는다.

- [x] **Step 4: ingest dual-write를 구현한다.**
  - locked fixture query에서 identity ID를 함께 읽는다.
  - processed event, daily upsert, hourly upsert, cursor, Fixture 상태를 같은 Prisma transaction에서 처리한다.
  - hourly upsert가 실패하면 daily와 processed event도 rollback되는 integration test를 추가한다.

- [x] **Step 5: replay와 DST 회귀를 검증한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/energy-hourly-aggregation.spec.ts src/energy/energy-aggregation.spec.ts src/energy/fixture-state-ingestion.service.spec.ts`
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/fixture-state-ingestion.integration.spec.ts`
  - Expected: duplicate event does not increment daily/hourly; transaction rollback PASS.

- [x] **Step 6: 커밋한다.**
  - Run: `git add apps/api/src/energy && git commit -m "feat(api): aggregate fixture energy hourly"`

### Task 5: 사용량 순위 API

**Files:**
- Create: `apps/api/src/energy/energy-rankings.service.ts`
- Create: `apps/api/src/energy/energy-rankings.service.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.module.ts`

**Interfaces:**
- Consumes: dimension/group histories and daily aggregates.
- Produces: `GET /energy/sites/:siteId/rankings` returning `EnergyRankingResponse`.

- [x] **Step 1: ranking 실패 테스트를 작성한다.**
  - floor usage descending, group overlapping membership, per-fixture average, low coverage unranked, legacy period excluded cases를 만든다.

- [x] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/energy-rankings.service.spec.ts`
  - Expected: FAIL because ranking service is absent.

- [x] **Step 3: bounded relation query ranking을 구현한다.**
  - 입력 범위 최대 400일, limit 1~100을 shared query schema로 검증한다.
  - effective range intersection을 SQL에서 수행하고 `ORDER BY metric DESC, identityId ASC`로 안정 정렬한다.
  - coverage 미달 row는 `unranked` 배열로 분리한다.
  - group 응답에는 `overlappingMemberships=true`를 항상 포함한다.

- [x] **Step 4: controller와 tenant scope를 연결한다.**
  - access assert가 SQL보다 먼저 수행됨을 call order로 검증한다.
  - other-site dimension ID가 결과에 섞이지 않는 integration fixture를 추가한다.

- [x] **Step 5: ranking 검증 후 커밋한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/energy-rankings.service.spec.ts && pnpm --filter @led-control/api typecheck`
  - Run: `git add apps/api/src/energy && git commit -m "feat(api): add energy usage rankings"`

### Task 6: 운영 시간 정책과 낭비 API

**Files:**
- Create: `apps/api/src/energy/operating-hours.service.ts`
- Create: `apps/api/src/energy/operating-hours.service.spec.ts`
- Create: `apps/api/src/energy/energy-waste.service.ts`
- Create: `apps/api/src/energy/energy-waste.service.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.module.ts`

**Interfaces:**
- Consumes: hourly aggregates, dimension history, shared policy schema.
- Produces: GET/PUT operating-hours and GET waste endpoints.

- [ ] **Step 1: policy 권한과 waste 산식 실패 테스트를 작성한다.**
  - viewer PUT forbidden, admin PUT success, missing policy reason, 자정 통과, 휴일 override, allowed brightness 10% cases를 포함한다.

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/operating-hours.service.spec.ts src/energy/energy-waste.service.spec.ts`
  - Expected: FAIL because services are absent.

- [ ] **Step 3: effective-dated policy CRUD를 구현한다.**
  - mutation은 `siteAccess.assert(...,"manage")`와 transaction 안 재인가를 수행한다.
  - 새 policy는 이전 열린 version을 닫고 weekly hours와 exceptions를 생성한다.

- [ ] **Step 4: waste query를 구현한다.**

```text
wasteKwh = ratedWatt × max(avgBrightness - allowedBrightness, 0) / 100 × knownSeconds / 3,600,000
```

  - 7×24시간보다 짧은 observed history면 `hourly_history_insufficient`를 반환한다.
  - unknownSeconds는 denominator 품질에는 포함하지만 waste kWh에는 포함하지 않는다.

- [ ] **Step 5: API 검증 후 커밋한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/operating-hours.service.spec.ts src/energy/energy-waste.service.spec.ts`
  - Run: `git add apps/api/src/energy && git commit -m "feat(api): detect off-hours energy waste"`

### Task 7: 월 목표·예산 API

**Files:**
- Create: `apps/api/src/energy/energy-targets.service.ts`
- Create: `apps/api/src/energy/energy-targets.service.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.module.ts`

**Interfaces:**
- Consumes: P0 month forecast and `EnergyMonthlyTarget`.
- Produces: GET/PUT/DELETE `/energy/sites/:siteId/targets/:month`.

- [ ] **Step 1: target 산식과 권한 실패 테스트를 작성한다.**
  - target only, budget only, both null invalid, viewer read/admin write, forecast unavailable를 검증한다.

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/energy-targets.service.spec.ts`
  - Expected: FAIL because target service is absent.

- [ ] **Step 3: CRUD와 progress를 구현한다.**
  - month는 site timezone의 `YYYY-MM`만 허용한다.
  - remaining daily allowance는 `(target-current)/remaining local days`, 음수면 0이다.
  - forecast null이면 projected status를 `forecast_unavailable`로 둔다.

- [ ] **Step 4: API 검증 후 커밋한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/energy-targets.service.spec.ts && pnpm --filter @led-control/api typecheck`
  - Run: `git add apps/api/src/energy && git commit -m "feat(api): manage monthly energy targets"`

### Task 8: 사용 분석 route와 ranking UI

**Files:**
- Modify: `apps/web/src/features/statistics/statistics-sections.ts`
- Create: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.tsx`
- Create: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx`
- Create: `apps/web/src/features/statistics/analysis/EnergyRankingList.tsx`
- Create: `apps/web/src/features/statistics/analysis/EnergyRankingList.test.tsx`
- Create: `apps/web/src/features/statistics/analysis/EnergyRankingDetailPanel.tsx`
- Modify: `apps/web/src/api/energy.ts`
- Modify: `apps/web/src/api/energy.test.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 5 ranking endpoint.
- Produces: `/statistics/analysis`, dimension/metric filter, ranking detail panel.

- [x] **Step 1: hook와 route 실패 테스트를 작성한다.**
  - `siteId`, dimension, metric, date range가 query key와 URL에 모두 포함되는지 검사한다.
  - 서브메뉴에 `사용 분석`이 추가되고 active link가 바뀌는지 검사한다.

- [x] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/web test -- src/api/energy.test.tsx StatisticsAnalysisPage.test.tsx EnergyRankingList.test.tsx`
  - Expected: FAIL because route, hook, components are absent.

- [x] **Step 3: strict API hook과 page filter를 구현한다.**
  - dimension/metric/preset을 URLSearchParams로 직렬화한다.
  - site 변경 시 selected ranking identity를 초기화한다.

- [x] **Step 4: ranking list와 detail을 구현한다.**
  - 순위/미순위 영역, coverage, history badge, group overlap notice를 제공한다.
  - row는 button으로 만들고 선택 시 `SidePanel`에 일별 추이와 포함 조명을 표시한다.

- [x] **Step 5: Web 검증 후 커밋한다.**
  - Run: `pnpm --filter @led-control/web test -- StatisticsAnalysisPage.test.tsx EnergyRankingList.test.tsx src/api/energy.test.tsx && pnpm --filter @led-control/web typecheck`
  - Run: `git add apps/web/src && git commit -m "feat(web): add statistics usage analysis"`

### Task 9: 최적화 route와 waste/target UI

**Files:**
- Modify: `apps/web/src/features/statistics/statistics-sections.ts`
- Create: `apps/web/src/features/statistics/optimization/StatisticsOptimizationPage.tsx`
- Create: `apps/web/src/features/statistics/optimization/StatisticsOptimizationPage.test.tsx`
- Create: `apps/web/src/features/statistics/optimization/WasteAnalysisPanel.tsx`
- Create: `apps/web/src/features/statistics/optimization/OperatingHoursDialog.tsx`
- Create: `apps/web/src/features/statistics/optimization/MonthlyTargetPanel.tsx`
- Create: `apps/web/src/features/statistics/optimization/MonthlyTargetDialog.tsx`
- Modify: `apps/web/src/api/energy.ts`
- Modify: `apps/web/src/api/energy.test.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Tasks 6~7 endpoints and current user role.
- Produces: `/statistics/optimization`, admin dialogs, viewer read-only panels.

- [ ] **Step 1: 페이지 상태 실패 테스트를 작성한다.**
  - policy 없음, hourly history 부족, waste available, target 없음, forecast unavailable, viewer read-only를 포함한다.

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/web test -- StatisticsOptimizationPage.test.tsx`
  - Expected: FAIL because optimization page is absent.

- [ ] **Step 3: waste와 운영 시간 UI를 구현한다.**
  - waste 없음과 데이터 없음 copy를 구분한다.
  - admin dialog는 월~일 whole-hour interval, 휴무, 자정 통과, 허용 밝기를 입력한다.
  - viewer는 설정 버튼을 렌더링하지 않는다.

- [ ] **Step 4: 목표·예산 UI를 구현한다.**
  - shared `Card`, `MetricCard`, `Button`, `StatusBadge`를 재사용한다.
  - target/budget progress, forecast status, remaining daily allowance를 표시한다.
  - mutation 성공 후 exact site/month query만 invalidate한다.

- [ ] **Step 5: Web 검증 후 커밋한다.**
  - Run: `pnpm --filter @led-control/web test -- StatisticsOptimizationPage.test.tsx src/api/energy.test.tsx && pnpm --filter @led-control/web typecheck`
  - Run: `git add apps/web/src && git commit -m "feat(web): add statistics optimization"`

### Task 10: P1 Browser 회귀, retention, 문서

**Files:**
- Modify: `apps/web/e2e/statistics-flow.spec.ts`
- Create: `apps/api/src/energy/energy-retention.service.ts`
- Create: `apps/api/src/energy/energy-retention.service.spec.ts`
- Modify: `apps/api/src/energy/energy.module.ts`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-10-statistics-p1-analysis-optimization.md`

**Interfaces:**
- Consumes: Tasks 1~9 P1 기능.
- Produces: 24개월 hourly retention, browser evidence, 동기화된 상태 문서.

- [x] **Step 1: retention 실패 테스트를 작성한다.**
  - site timezone과 무관하게 `bucketStartUtc < now-24months`만 bounded batch delete하는지 검사한다.
  - daily와 dimension history는 삭제하지 않는지 검사한다.

- [x] **Step 2: retention worker를 구현한다.**
  - `OnModuleInit/OnModuleDestroy`, 중복 timer 방지, 1회 10,000행 제한을 사용한다.
  - site 영구 삭제는 FK cascade로 hourly까지 제거한다.

- [x] **Step 3: Playwright P1 흐름을 추가한다.**
  - analysis 직접 URL과 서브메뉴 이동.
  - ranking dimension 전환과 detail.
  - ranking detail과 group overlap notice.
  - 네 viewport submenu internal scroll와 document overflow 없음.

- [x] **Step 4: P1 focused 검증을 실행한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy`
  - Run: `pnpm --filter @led-control/web test && pnpm --filter @led-control/web exec playwright test e2e/statistics-flow.spec.ts --project=chromium`
  - Expected: API/Web/Chromium PASS.

- [x] **Step 5: 문서와 체크리스트를 동기화한다.**
  - `docs/menus/statistics.md`에 software 구현과 migration 이전 이력/7일 warm-up 한계를 기록한다.
  - `docs/project-status.md`에 migration, hourly retention, 실제 HIL 미실행을 기록한다.
  - 실제 완료 step만 `[x]`로 바꾼다.

- [x] **Step 6: 전체 검증 후 커밋한다.**
  - Run: `pnpm test && pnpm lint && pnpm typecheck && git diff --check`
  - Run: `git add apps/api/src/energy apps/web/e2e/statistics-flow.spec.ts docs && git commit -m "test(statistics): verify P1 analysis and optimization"`

## Plan Self-Review

- Spec coverage: identity/history/schema는 Tasks 2~3, hourly/DST/atomicity는 Task 4, ranking은 Tasks 5·8, operating-hours/waste는 Tasks 6·9, target은 Tasks 7·9, retention/E2E/docs는 Task 10이 담당한다.
- Migration safety: daily row는 analytics identity로 영구 연결하고 legacy fixture FK는 nullable `SET NULL`로 유지해 rollback 호환성과 삭제 보존을 함께 확보한다.
- Type consistency: Task 1의 strict contracts를 API Tasks 5~7과 Web Tasks 8~9가 동일하게 소비한다.
- Release navigation: P1에서 `사용 분석`과 `최적화`만 추가하며 `보고서`는 P2까지 노출하지 않는다.

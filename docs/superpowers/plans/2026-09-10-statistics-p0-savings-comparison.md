# Statistics P0 Savings Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 상태 기반 통계에 24시간·100% 기준 절감률, 기준/실제·예상 비교 그래프, 전월·전년 동기간 비교를 추가하고 `/statistics/overview` 서브페이지 구조를 도입한다.

**Architecture:** 기존 summary·series endpoint는 호환 facade로 유지하고 신규 comparison read model을 `EnergyAnalyticsQueryService`에 추가한다. Web은 `StatisticsShell`과 overview route를 먼저 도입한 뒤 comparison endpoint를 strict schema로 parse하여 기존 KPI와 신규 비교 시각화를 같은 페이지에 조합한다.

**Tech Stack:** TypeScript, Zod, NestJS, Prisma/PostgreSQL Decimal, React 18, React Router 7, TanStack Query 5, Recharts 3, Vitest, Jest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-statistics-analytics-roadmap-design.md`

**UI Reference:** `docs/assets/statistics-analytics/statistics-overview-ui.png`

## Global Constraints

- 모든 통계 값은 `상태 기반 추정`으로 표시하고 실제 계측값이라고 표현하지 않는다.
- 기존 `GET /energy/sites/:siteId/summary`와 `series` 계약을 삭제하거나 의미 변경하지 않는다.
- 결측값을 0으로 변환하지 않고 `null`, `partial`, `no_data`를 유지한다.
- 각 조명 월 known time 3,600초 이상, site coverage 80% 이상일 때만 월 forecast를 제공한다.
- 음수 절감률은 0으로 보정하지 않고 `기준 대비 초과 사용`으로 표시한다.
- `/statistics`는 query와 hash를 보존해 `/statistics/overview`로 replace 이동한다.
- P0에서는 `개요` 서브메뉴만 노출하며 P1·P2 route는 만들지 않는다.
- UI 간격은 4/8/12/16/24/32px 토큰, 섹션 24px, 카드 간 16px, 데스크톱 padding 24px, 760px 이하 padding 16px를 사용한다.
- DB schema는 변경하지 않는다.
- 실제 조명 HIL과 상태 기반 소프트웨어 테스트를 같은 증거로 기록하지 않는다.

---

## File Structure

- `packages/shared/src/energy-contracts.ts`: comparison preset, range, summary, prior comparison, point strict schema와 exported type.
- `packages/shared/src/energy-contracts.test.ts`: valid/invalid comparison 계약과 음수·nullable 상태 테스트.
- `packages/shared/src/index.ts`: energy contract export.
- `apps/api/src/energy/energy-analytics-query.service.ts`: baseline, forecast, coverage, prior-period read model.
- `apps/api/src/energy/energy-comparison-query.ts`: preset query parsing과 완료 날짜 범위 계산.
- `apps/api/src/energy/energy.controller.ts`: 신규 comparisons route.
- `apps/api/src/energy/energy.service.ts`: 기존 facade 유지와 analytics service 위임.
- `apps/api/src/energy/energy.module.ts`: provider 등록.
- `apps/web/src/features/statistics/StatisticsShell.tsx`: 통계 서브메뉴와 outlet context.
- `apps/web/src/features/statistics/statistics-sections.ts`: 배포 단계별 route metadata.
- `apps/web/src/features/statistics/StatisticsOverviewPage.tsx`: 기존 통계와 P0 comparison 조합.
- `apps/web/src/features/statistics/EnergyComparisonChart.tsx`: baseline/observed/forecast chart와 접근 가능한 목록.
- `apps/web/src/features/statistics/PeriodComparisonPanel.tsx`: 전월·전년 카드와 데이터 품질.
- `apps/web/src/api/energy.ts`: comparison query hook과 boundary parse.
- `apps/web/src/features/shells/CustomerShell.tsx`: nested statistics routes.
- `apps/web/src/styles.css`: shell, subnavigation, P0 grid와 반응형 규칙.
- `apps/web/e2e/statistics-flow.spec.ts`: redirect, 서브메뉴, 비교 UI, 네 viewport.
- `docs/menus/statistics.md`, `docs/project-status.md`: 구현 상태와 한계.

### Task 1: Shared comparison 계약

**Files:**
- Create: `packages/shared/src/energy-contracts.ts`
- Create: `packages/shared/src/energy-contracts.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: 기존 `energyDataStatusSchema`, `energySourceSchema`와 ISO date/datetime 규칙.
- Produces: `EnergyComparisonPreset`, `EnergyComparisonPoint`, `EnergyComparisonResponse`, `energyComparisonResponseSchema`.

- [x] **Step 1: strict 계약의 실패 테스트를 작성한다.**

```ts
expect(() => energyComparisonResponseSchema.parse({
  ...validComparison,
  summary: { ...validComparison.summary, savingsRatePercent: null, outcome: "saving" }
})).toThrow();
expect(energyComparisonResponseSchema.parse({
  ...validComparison,
  summary: { ...validComparison.summary, savingsKwh: -12, savingsRatePercent: -5, outcome: "overuse" }
}).summary.outcome).toBe("overuse");
```

- [x] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/shared test -- energy-contracts.test.ts`
  - Expected: FAIL because `energyComparisonResponseSchema` is not exported.

- [x] **Step 3: schema와 type을 구현한다.**

```ts
export const energyComparisonPresetSchema = z.enum(["last_7_days", "current_month", "current_year"]);
export const energyComparisonPointSchema = z.object({
  period: z.string().min(1),
  baselineKwh: z.number().nonnegative(),
  estimatedKwh: z.number().nullable(),
  phase: z.enum(["observed", "forecast", "unavailable"]),
  knownSeconds: z.number().int().nonnegative(),
  unknownSeconds: z.number().int().nonnegative(),
  coverageRate: z.number().min(0).max(1).nullable(),
  dataStatus: z.enum(["no_data", "partial", "available"])
}).strict();
```

  - `summary.outcome=saving`이면 savings 값이 null이 아니고 0 이상, `overuse`이면 0 미만, `unavailable`이면 세 savings 값이 모두 null이 되도록 `superRefine`한다.
  - prior kind는 `previous_period | previous_year`, history quality는 P0에서 `legacy_structure_unknown`만 허용한다.

- [x] **Step 4: shared 계약을 검증한다.**
  - Run: `pnpm --filter @led-control/shared test -- energy-contracts.test.ts && pnpm --filter @led-control/shared typecheck`
  - Expected: new tests and typecheck PASS.

- [x] **Step 5: 커밋한다.**
  - Run: `git add packages/shared/src/energy-contracts.ts packages/shared/src/energy-contracts.test.ts packages/shared/src/index.ts && git commit -m "feat(shared): add energy comparison contracts"`

### Task 2: 기간 경계와 절감 계산기

**Files:**
- Create: `apps/api/src/energy/energy-comparison-query.ts`
- Create: `apps/api/src/energy/energy-comparison-query.spec.ts`
- Modify: `apps/api/src/energy/energy-periods.ts`
- Modify: `apps/api/src/energy/energy-periods.spec.ts`

**Interfaces:**
- Consumes: `CalendarDate`, `localDateAt`, `startOfLocalDate`, `addCalendarDays`, `addCalendarMonths`.
- Produces: `parseComparisonPreset(raw: string): EnergyComparisonPreset`, `comparisonRanges(preset, generatedAt, timeZone): ComparisonRanges`.

- [x] **Step 1: 완료 날짜와 leap-day 실패 테스트를 작성한다.**

```ts
expect(comparisonRanges("current_month", new Date("2026-09-10T03:00:00Z"), "Asia/Seoul")).toMatchObject({
  display: { from: "2026-09-01", to: "2026-09-30" },
  completed: { from: "2026-09-01", to: "2026-09-09" },
  previousPeriod: { from: "2026-08-01", to: "2026-08-09" },
  previousYear: { from: "2025-09-01", to: "2025-09-09" }
});
```

- [x] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/energy-comparison-query.spec.ts`
  - Expected: FAIL because comparison range helpers do not exist.

- [x] **Step 3: preset별 범위를 구현한다.**
  - `last_7_days`: 어제 포함 7일과 직전 7일, 전년 동일 월일.
  - `current_month`: 월 전체 display, 어제까지 completed, 이전 월 같은 일수, 이전 연도 같은 월일.
  - `current_year`: 1월 1일부터 어제까지 completed, 직전 연도 동일 길이와 전년 동일 월일을 같은 범위로 반환하되 UI에는 `previous_year` 한 개만 표시한다.
  - 비교 연도에 2월 29일이 없으면 2월 마지막 날로 cap한다.

- [x] **Step 4: timezone 경계를 검증한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/energy-comparison-query.spec.ts src/energy/energy-periods.spec.ts`
  - Expected: Asia/Seoul month boundary and DST reference cases PASS.

- [x] **Step 5: 커밋한다.**
  - Run: `git add apps/api/src/energy/energy-comparison-query.ts apps/api/src/energy/energy-comparison-query.spec.ts apps/api/src/energy/energy-periods.ts apps/api/src/energy/energy-periods.spec.ts && git commit -m "feat(api): define energy comparison periods"`

### Task 3: Analytics read model과 comparison endpoint

**Files:**
- Create: `apps/api/src/energy/energy-analytics-query.service.ts`
- Create: `apps/api/src/energy/energy-analytics-query.service.spec.ts`
- Modify: `apps/api/src/energy/energy.service.ts`
- Modify: `apps/api/src/energy/energy.service.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.module.ts`

**Interfaces:**
- Consumes: Task 1 response type, Task 2 range helper, existing daily aggregates and open-cursor projection.
- Produces: `EnergyAnalyticsQueryService.getComparison(user, siteId, preset): Promise<EnergyComparisonResponse>` and `GET /energy/sites/:siteId/comparisons?preset=...`.

- [x] **Step 1: 절감·초과·forecast 불가 서비스 테스트를 작성한다.**

```ts
expect(result.summary).toMatchObject({
  baselineKwh: 100,
  estimatedKwh: 65,
  savingsKwh: 35,
  savingsRatePercent: 35,
  outcome: "saving"
});
expect(overuse.summary).toMatchObject({ savingsKwh: -10, savingsRatePercent: -10, outcome: "overuse" });
expect(insufficient.summary).toMatchObject({ estimatedKwh: null, savingsRatePercent: null, outcome: "unavailable" });
```

- [x] **Step 2: endpoint 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/energy-analytics-query.service.spec.ts src/energy/energy.service.spec.ts`
  - Expected: FAIL because analytics provider and comparison facade are absent.

- [x] **Step 3: 공통 projection 코드를 read model로 추출한다.**
  - 기존 summary·series 결과 fixture를 먼저 고정한다.
  - `loadSite`, `loadFixtures`, `buildFixtureValues`, `summarizeValues`, rounding helper를 이동한다.
  - 기존 `EnergyService.getSiteSummary/getSiteSeries`는 analytics service에 위임하고 응답 snapshot이 기존 fixture와 동일하게 유지되도록 한다.

- [x] **Step 4: comparison 계산을 구현한다.**
  - baseline은 현재 fixture 정격 W와 각 현지 날짜의 실제 seconds를 사용한다.
  - current month 미래 point는 fixture별 observed kWh/knownSeconds rate를 남은 현지 날짜 seconds에 적용한다.
  - prior comparison은 완료 날짜만 합산하며 분모가 0 또는 데이터 없음이면 change rate를 null로 둔다.
  - 모든 ratio는 Decimal로 계산한 뒤 response boundary에서 반올림한다.

- [x] **Step 5: 접근 검증과 controller query를 연결한다.**

```ts
@Get("sites/:siteId/comparisons")
getSiteComparisons(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string, @Query("preset") preset: string) {
  return this.energyService.getSiteComparisons(user, siteId, parseComparisonPreset(preset));
}
```

  - `SiteAccessService.assert(user, siteId, "read")`가 aggregate query보다 먼저 호출됨을 mock order로 검증한다.
  - 잘못된 preset은 400, 다른 tenant site는 기존 access 정책의 404가 된다.

- [x] **Step 6: API 회귀를 검증한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy`
  - Run: `pnpm --filter @led-control/api typecheck`
  - Expected: comparison tests plus existing summary/series/ingestion tests PASS.

- [x] **Step 7: 커밋한다.**
  - Run: `git add apps/api/src/energy && git commit -m "feat(api): add energy savings comparisons"`

### Task 4: 통계 shell과 overview 호환 route

**Files:**
- Create: `apps/web/src/features/statistics/StatisticsShell.tsx`
- Create: `apps/web/src/features/statistics/StatisticsShell.test.tsx`
- Create: `apps/web/src/features/statistics/StatisticsSubnavigation.tsx`
- Create: `apps/web/src/features/statistics/statistics-sections.ts`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.test.tsx`
- Rename: `apps/web/src/features/statistics/StatisticsView.tsx` to `apps/web/src/features/statistics/StatisticsOverviewPage.tsx`
- Rename: `apps/web/src/features/statistics/StatisticsView.test.tsx` to `apps/web/src/features/statistics/StatisticsOverviewPage.test.tsx`

**Interfaces:**
- Consumes: selected `siteId` from CustomerShell.
- Produces: `StatisticsOutletContext={siteId?: string}`, overview route, query/hash-preserving redirect.

- [x] **Step 1: route와 navigation 실패 테스트를 작성한다.**

```tsx
expect(screen.getByRole("navigation", { name: "통계 메뉴" })).toBeInTheDocument();
expect(screen.getByRole("link", { name: "개요" })).toHaveAttribute("aria-current", "page");
expect(screen.queryByRole("link", { name: "사용 분석" })).not.toBeInTheDocument();
```

  - MemoryRouter에서 `/statistics?siteId=site-2#summary`가 `/statistics/overview?siteId=site-2#summary`로 replace되는 location probe를 추가한다.

- [x] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/web test -- StatisticsShell.test.tsx CustomerShell.test.tsx`
  - Expected: FAIL because nested statistics routes do not exist.

- [x] **Step 3: P0 section metadata와 shell을 구현한다.**

```ts
export const statisticsSections = [
  { path: "/statistics/overview", label: "개요", release: "p0" }
] as const;
```

  - `StatisticsSubnavigation`은 `NavLink end`를 사용한다.
  - `StatisticsShell`은 navigation 다음 `Outlet context={{siteId}}`를 렌더링한다.
  - primary 통계 link 목적지를 `/statistics/overview`로 바꾸고 `/statistics/*`에서 active임을 테스트한다.

- [x] **Step 4: 기존 view를 overview page로 이동한다.**
  - component 이름과 test describe를 변경한다.
  - `useOutletContext<StatisticsOutletContext>()`로 site ID를 받는다.
  - loading/error 상태도 shell 내부에서 상단 정렬을 유지한다.

- [x] **Step 5: route 테스트를 검증한다.**
  - Run: `pnpm --filter @led-control/web test -- StatisticsShell.test.tsx StatisticsOverviewPage.test.tsx CustomerShell.test.tsx App.test.tsx`
  - Expected: redirect, overview render, primary active, 기존 통계 데이터 조회 PASS.

- [x] **Step 6: 커밋한다.**
  - Run: `git add apps/web/src/features/statistics apps/web/src/features/shells/CustomerShell.tsx apps/web/src/features/shells/CustomerShell.test.tsx && git commit -m "feat(web): add statistics overview route"`

### Task 5: Web comparison query와 상태 모델

**Files:**
- Modify: `apps/web/src/api/energy.ts`
- Modify: `apps/web/src/api/energy.test.tsx`
- Create: `apps/web/src/features/statistics/statistics-comparison.ts`
- Create: `apps/web/src/features/statistics/statistics-comparison.test.ts`

**Interfaces:**
- Consumes: `energyComparisonResponseSchema`, `EnergyComparisonPreset`.
- Produces: `useEnergyComparison(siteId, preset)`, `comparisonPresentation(summary)`.

- [x] **Step 1: API parse와 query-key 실패 테스트를 작성한다.**

```ts
expect(apiGet).toHaveBeenCalledWith("/energy/sites/site-2/comparisons?preset=current_month");
expect(client.getQueryCache().find({ queryKey: ["energy-comparison", "site-2", "current_month"] })).toBeDefined();
```

  - malformed response가 schema parse error로 query error가 되는 테스트를 추가한다.

- [x] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/web test -- src/api/energy.test.tsx src/features/statistics/statistics-comparison.test.ts`
  - Expected: FAIL because hook and presenter are absent.

- [x] **Step 3: hook과 presenter를 구현한다.**

```ts
export function useEnergyComparison(siteId: string | undefined, preset: EnergyComparisonPreset) {
  return useQuery({
    queryKey: ["energy-comparison", siteId, preset],
    queryFn: async () => energyComparisonResponseSchema.parse(await apiGet(`/energy/sites/${encodeURIComponent(siteId!)}/comparisons?preset=${preset}`)),
    enabled: Boolean(siteId),
    retry: 1
  });
}
```

  - presenter는 saving/overuse/unavailable의 label, tone, signed value를 반환하고 산식을 다시 계산하지 않는다.

- [x] **Step 4: Web unit을 검증한다.**
  - Run: `pnpm --filter @led-control/web test -- src/api/energy.test.tsx src/features/statistics/statistics-comparison.test.ts`
  - Expected: query key, URL encoding, strict parse, presentation PASS.

- [ ] **Step 5: 커밋한다.**
  - Run: `git add apps/web/src/api/energy.ts apps/web/src/api/energy.test.tsx apps/web/src/features/statistics/statistics-comparison.ts apps/web/src/features/statistics/statistics-comparison.test.ts && git commit -m "feat(web): query energy comparisons"`

### Task 6: 절감 KPI, 비교 그래프, 동기간 패널

**Files:**
- Create: `apps/web/src/features/statistics/EnergyComparisonChart.tsx`
- Create: `apps/web/src/features/statistics/EnergyComparisonChart.test.tsx`
- Create: `apps/web/src/features/statistics/PeriodComparisonPanel.tsx`
- Create: `apps/web/src/features/statistics/PeriodComparisonPanel.test.tsx`
- Modify: `apps/web/src/features/statistics/StatisticsOverviewPage.tsx`
- Modify: `apps/web/src/features/statistics/StatisticsOverviewPage.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 5 hook and presentation, existing `Card`, `MetricCard`, `SidePanel`, `StatusBadge`.
- Produces: preset control, savings KPI, baseline/observed/forecast graph, prior-period panel.

- [ ] **Step 1: UI 상태 실패 테스트를 작성한다.**
  - saving 35%, overuse -10%, unavailable 세 fixture를 만든다.
  - `forecast` point가 점선 series이고 null point가 연결되지 않는지 검사한다.
  - screen-reader list에 `기준 100 kWh, 예상 65 kWh, 절감 35 kWh`가 포함되는지 검사한다.

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/web test -- StatisticsOverviewPage.test.tsx EnergyComparisonChart.test.tsx PeriodComparisonPanel.test.tsx`
  - Expected: FAIL because P0 components are absent.

- [ ] **Step 3: 공통 컴포넌트로 P0 UI를 구현한다.**
  - preset button은 `최근 7일`, `이번 달`, `올해`와 `aria-pressed`를 제공한다.
  - `MetricCard`를 재사용하고 saving/overuse copy를 별도 presenter에서 받는다.
  - chart는 baseline `Bar`, observed `Line`, forecast `Line strokeDasharray="4 4"`를 사용한다.
  - tooltip과 `sr-only` list에서 기준, 실제/예상, 차이, 수집률을 함께 제공한다.
  - prior panel은 현재·비교 기간 수집률과 `조명 구성 변화 미보정`을 표시한다.

- [ ] **Step 4: partial·empty·error를 구현한다.**
  - comparison error는 기존 summary 카드까지 숨기지 않고 comparison section 안에서 retry한다.
  - prior data null은 각 row만 empty state로 둔다.
  - forecast unavailable은 기준 bar를 유지하고 예상 line과 절감 KPI를 대체 설명으로 바꾼다.

- [ ] **Step 5: 반응형 CSS를 구현한다.**
  - desktop은 chart 8 columns, comparison 4 columns.
  - 1120px 이하는 한 열, 760px 이하는 16px padding.
  - 서브메뉴만 내부 overflow-x를 사용하고 `.content`/document overflow는 만들지 않는다.

- [ ] **Step 6: focused Web test를 검증한다.**
  - Run: `pnpm --filter @led-control/web test -- StatisticsOverviewPage.test.tsx EnergyComparisonChart.test.tsx PeriodComparisonPanel.test.tsx`
  - Run: `pnpm --filter @led-control/web typecheck`
  - Expected: all P0 view states and typecheck PASS.

- [ ] **Step 7: 커밋한다.**
  - Run: `git add apps/web/src/features/statistics apps/web/src/styles.css && git commit -m "feat(web): show energy savings comparisons"`

### Task 7: Browser 회귀와 문서 수렴

**Files:**
- Modify: `apps/web/e2e/statistics-flow.spec.ts`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-10-statistics-p0-savings-comparison.md`

**Interfaces:**
- Consumes: Tasks 1~6 전체 P0 동작.
- Produces: 네 viewport 회귀, 구현/한계 문서, 완료 체크리스트.

- [ ] **Step 1: Playwright route fixture에 comparison 응답을 추가한다.**
  - saving, overuse, insufficient-state site별 fixture를 제공한다.
  - 기존 `/statistics` 테스트는 redirect 이후 overview heading을 기다리도록 수정한다.

- [ ] **Step 2: 브라우저 흐름을 작성한다.**
  - `/statistics?siteId=site-1` query 보존 redirect.
  - preset 전환 후 URL/query와 API 요청.
  - 음수 절감의 `초과 사용` 텍스트.
  - comparison retry가 기존 KPI를 유지하는지.
  - 1440/1024/390/320에서 서브메뉴와 chart overflow, 44×44px target.

- [ ] **Step 3: Chromium 회귀를 실행한다.**
  - Run: `pnpm --filter @led-control/web exec playwright test e2e/statistics-flow.spec.ts --project=chromium`
  - Expected: P0 flows PASS with no document horizontal overflow.

- [ ] **Step 4: 메뉴와 상태 문서를 갱신한다.**
  - `docs/menus/statistics.md` 구현 완료에 overview route, 절감률, 기준 그래프, 동기간 비교를 기록한다.
  - `현재 등록 조명 기준`, `조명 구성 변화 미보정`, 실제 계측/HIL 미실행을 개선 필요 항목에 기록한다.
  - `docs/project-status.md`의 활성 P0 상태와 실제 검증 명령을 기록한다.

- [ ] **Step 5: 전체 소프트웨어 검증을 실행한다.**
  - Run: `pnpm --filter @led-control/shared test && pnpm --filter @led-control/api test -- --runInBand src/energy && pnpm --filter @led-control/web test && pnpm --filter @led-control/web build`
  - Run: `git diff --check`
  - Expected: all commands exit 0; production build의 기존 bundle 경고는 실패로 확대하지 않고 기록한다.

- [ ] **Step 6: 계획 체크리스트와 상태판을 동기화해 커밋한다.**
  - 이 계획에서 실제 완료한 step만 `[x]`로 바꾼다.
  - Run: `git add apps/web/e2e/statistics-flow.spec.ts apps/web/src/App.test.tsx docs/menus/statistics.md docs/project-status.md docs/superpowers/plans/2026-09-10-statistics-p0-savings-comparison.md && git commit -m "test(statistics): verify P0 savings overview"`

## Plan Self-Review

- Spec coverage: P0 산식·forecast·prior range는 Tasks 1~3, route/submenu는 Task 4, Web query와 화면은 Tasks 5~6, 접근성·반응형·문서는 Task 7이 담당한다.
- Compatibility: 기존 summary·series와 daily aggregate schema는 변경하지 않는다.
- Type consistency: API와 Web은 Task 1의 `EnergyComparisonResponse`와 `EnergyComparisonPreset`을 사용한다.
- Deployment: P0는 overview만 노출하며 P1/P2 URL은 wildcard redirect로 처리한다.

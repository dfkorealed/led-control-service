# Statistics Report Grid and Visual Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 보고서 이력을 검색 가능한 compact server-paginated grid로 바꾸고, 선택 기간 통계 개요와 같은 KPI·실제 차트를 PDF/XLSX에 생성한다.

**Architecture:** 목록은 shared strict query contract와 `(siteId, createdAt, id)` keyset cursor를 사용하고 Web이 cursor stack과 URL filter state를 관리한다. 보고서는 기존 immutable document/manifest 경계를 v2 calculation basis와 visualization reference로 확장하고, 하나의 deterministic PNG chart renderer 결과를 PDF와 XLSX가 공유한다.

**Tech Stack:** TypeScript, Zod, NestJS, Prisma/PostgreSQL, React, TanStack Query, React Aria 기반 공통 form controls, Tailwind CSS, pdf-lib, ExcelJS, sharp, Vitest/Jest/Playwright.

**Spec:** `docs/superpowers/specs/2026-09-16-statistics-report-grid-visual-output-design.md`

## Global Constraints

- 작업 디렉터리는 `/Users/kim-jh/Documents/led-control-service`만 사용한다.
- 기존 untracked `.chart-data-*`, `docs/research/`, `outputs/`는 수정·삭제·커밋하지 않는다.
- 목록 검색은 현재 페이지가 아니라 전체 보관 이력을 서버에서 수행한다.
- 페이지 크기는 10·20·50·100만 허용하고 기본값은 20이다.
- 실제 저장 비용과 생성 당시 현재 단가 기준 비용을 같은 값으로 표현하지 않는다.
- v1 stored report document를 계속 렌더링할 수 있어야 한다.
- PDF와 XLSX는 동일 scalar manifest와 동일 source chart PNG를 사용한다.
- UI는 Tailwind semantic token과 기존 공통 컴포넌트를 우선 사용하고 새 CSS는 Tailwind로 표현 불가능한 부분만 허용한다.
- 모든 interactive target은 44×44px 이상이며 320px 문서 overflow를 만들지 않는다.
- DB schema 변경과 함께 `docs/database-schema.md`, 통계 기능 변경과 함께 `docs/menus/statistics.md`를 갱신한다.

---

### Task 1: Shared 목록 검색·페이지네이션 계약

**Files:**
- Modify: `packages/shared/src/energy-p2-contracts.ts`
- Modify: `packages/shared/src/energy-p2-contracts.test.ts`

**Interfaces:**
- Produces: `ENERGY_REPORT_PAGE_SIZES`, `energyReportListQuerySchema`, `EnergyReportListQuery`, 확장된 `energyReportListResponseSchema`
- Consumes: 기존 `energyReportJobSchema`, `energyReportStatusSchema`, `energyReportFormatSchema`, `energyScopeSchema`, `calendarDateSchema`

- [x] **Step 1: 허용 page size, filter normalization, strict response의 실패 테스트를 작성한다.**

```ts
it.each([10, 20, 50, 100])("accepts report page size %i", (limit) => {
  expect(energyReportListQuerySchema.parse({ limit })).toEqual({ limit });
});

it.each([0, 1, 19, 21, 101])("rejects report page size %i", (limit) => {
  expect(() => energyReportListQuerySchema.parse({ limit })).toThrow();
});

it("normalizes report filters", () => {
  expect(energyReportListQuerySchema.parse({
    limit: 20, query: "  서울 물류센터  ", status: "completed", format: "pdf",
    scope: "site", requestedFrom: "2026-09-01", requestedTo: "2026-09-16"
  })).toEqual({
    limit: 20, query: "서울 물류센터", status: "completed", format: "pdf",
    scope: "site", requestedFrom: "2026-09-01", requestedTo: "2026-09-16"
  });
});

it("accepts at most 100 reports with cursor and total", () => {
  expect(energyReportListResponseSchema.parse({
    reports: Array.from({ length: 100 }, (_, index) => reportJob(index)),
    nextCursor: "opaque", totalCount: 137
  }).totalCount).toBe(137);
});
```

- [x] **Step 2: focused shared test가 RED인지 확인한다.**

Run: `pnpm --filter @led-control/shared test -- energy-p2-contracts.test.ts`

Expected: 새 schema/export가 없어 FAIL.

- [x] **Step 3: strict query와 response schema를 구현한다.**

```ts
export const ENERGY_REPORT_PAGE_SIZES = [10, 20, 50, 100] as const;
export type EnergyReportPageSize = typeof ENERGY_REPORT_PAGE_SIZES[number];
const reportPageSizeSchema = z.coerce.number().refine(
  (value): value is EnergyReportPageSize => ENERGY_REPORT_PAGE_SIZES.includes(value as EnergyReportPageSize),
  "invalid report page size"
);

export const energyReportListQuerySchema = z.object({
  limit: reportPageSizeSchema,
  cursor: z.string().min(1).max(1024).optional(),
  query: z.string().trim().min(1).max(100).optional(),
  status: energyReportStatusSchema.optional(),
  format: energyReportFormatSchema.optional(),
  scope: energyScopeSchema.optional(),
  requestedFrom: calendarDateSchema.optional(),
  requestedTo: calendarDateSchema.optional()
}).strict().superRefine(validateRequestedRange);

export const energyReportListResponseSchema = z.object({
  reports: z.array(energyReportJobSchema).max(100),
  nextCursor: z.string().min(1).max(1024).nullable(),
  totalCount: z.number().int().nonnegative()
}).strict();
```

`validateRequestedRange`는 한쪽 날짜만 전달된 요청, 역순, 90일 초과를 거절한다. query parser 외부에서 임의 기본값을 만들지 말고 Web/API adapter가 기본 `limit=20`을 전달한다.

- [x] **Step 4: shared test를 GREEN으로 만든다.**

Run: `pnpm --filter @led-control/shared test -- energy-p2-contracts.test.ts`

Expected: PASS.

- [x] **Step 5: Task 1을 커밋한다.**

```bash
git add packages/shared/src/energy-p2-contracts.ts packages/shared/src/energy-p2-contracts.test.ts
git commit -m "feat(shared): define report history query contract"
```

---

### Task 2: API keyset cursor와 검색 predicate

**Files:**
- Create: `apps/api/src/energy/reports/report-list-cursor.ts`
- Create: `apps/api/src/energy/reports/report-list-cursor.spec.ts`
- Create: `apps/api/src/energy/reports/report-list-filters.ts`
- Create: `apps/api/src/energy/reports/report-list-filters.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/reports/energy-report-jobs.service.ts`
- Modify: `apps/api/src/energy/reports/energy-report-jobs.service.spec.ts`
- Modify: `apps/api/src/energy/reports/energy-report-api.spec.ts`

**Interfaces:**
- Consumes: `EnergyReportListQuery`
- Produces: `encodeReportCursor`, `decodeReportCursor`, `normalizeReportFilters`, `buildReportListWhere`, paginated `EnergyReportJobsService.list(user, siteId, rawQuery, now)`

- [x] **Step 1: cursor round-trip, filter fingerprint mismatch, malformed input의 RED test를 작성한다.**

```ts
const filters = normalizeReportFilters({ limit: 20, query: "서울", status: "completed" });
const cursor = encodeReportCursor({ createdAt: new Date("2026-09-16T00:00:00Z"), id: IDS.report }, filters);
expect(decodeReportCursor(cursor, filters)).toEqual({
  createdAt: new Date("2026-09-16T00:00:00.000Z"), id: IDS.report
});
expect(() => decodeReportCursor(cursor, normalizeReportFilters({ limit: 20, query: "부산" }))).toThrow();
expect(() => decodeReportCursor("not-base64", filters)).toThrow();
```

- [x] **Step 2: filter predicate의 상태·형식·scope·대상명·현장 timezone 날짜 경계를 테스트한다.**

`status=completed`는 `status=completed AND expiresAt > now AND objectDeletedAt IS NULL`, `status=expired`는 `status=completed AND expiresAt <= now`를 생성해야 한다. `requestedFrom`은 현지 00:00 inclusive, `requestedTo`는 다음 현지 날짜 00:00 exclusive UTC instant가 되어야 한다.

- [x] **Step 3: cursor/filter focused tests가 RED인지 확인한다.**

Run: `pnpm --filter @led-control/api exec jest src/energy/reports/report-list-cursor.spec.ts src/energy/reports/report-list-filters.spec.ts --runInBand`

Expected: 모듈이 없어 FAIL.

- [x] **Step 4: canonical filter fingerprint와 cursor를 구현한다.**

```ts
type CursorPayload = { version: 1; createdAt: string; id: string; filterFingerprint: string };

export function encodeReportCursor(position: { createdAt: Date; id: string }, filters: NormalizedReportFilters) {
  const payload: CursorPayload = {
    version: 1,
    createdAt: position.createdAt.toISOString(),
    id: position.id,
    filterFingerprint: fingerprint(filters)
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
```

decode는 1024자 제한, canonical base64url 재인코딩 동일성, strict key set, version, ISO instant, UUID, 64자 hex fingerprint를 검증한다. Error 원문을 controller 밖으로 내보내지 않는다.

- [x] **Step 5: Prisma where builder를 구현한다.**

```ts
return {
  siteId,
  AND: [
    targetQueryPredicate(filters.query),
    statusPredicate(filters.status, now),
    filters.format ? { format: filters.format } : {},
    scopeJsonPredicate(filters.scope),
    requestedAtPredicate(filters.requestedFrom, filters.requestedTo, timeZone),
    cursor ? { OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } }
    ] } : {}
  ]
};
```

`targetLabelSnapshot` null legacy fallback는 public label 규칙과 동일한 scope/identity 문자열에 대해 별도 OR predicate를 만든다. Raw SQL이 필요하면 parameterized `Prisma.sql`만 사용하고 문자열 보간을 금지한다.

- [x] **Step 6: controller와 service를 paginated query로 교체한다.**

Controller는 `@Query() rawQuery`를 service에 전달하고 service가 shared schema로 strict parse해 400으로 정제한다. Service는 권한과 Site timezone 조회 후 repeatable-read transaction에서 filtered count와 `take: limit + 1` rows를 조회한다. cursor row를 count predicate에는 넣지 않는다.

```ts
const [totalCount, rows] = await this.prisma.$transaction(async tx => [
  tx.energyReportJob.count({ where: filterWhere }),
  tx.energyReportJob.findMany({
    where: pageWhere,
    take: query.limit + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: jobSelect
  })
], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
```

- [x] **Step 7: service/API tests를 GREEN으로 만든다.**

Run: `pnpm --filter @led-control/api exec jest src/energy/reports/report-list-cursor.spec.ts src/energy/reports/report-list-filters.spec.ts src/energy/reports/energy-report-jobs.service.spec.ts src/energy/reports/energy-report-api.spec.ts --runInBand`

Expected: PASS, raw parse/database 오류 미노출.

- [x] **Step 8: Task 2를 커밋한다.**

```bash
git add apps/api/src/energy/energy.controller.ts apps/api/src/energy/reports/report-list-* apps/api/src/energy/reports/energy-report-jobs.service.ts apps/api/src/energy/reports/energy-report-jobs.service.spec.ts apps/api/src/energy/reports/energy-report-api.spec.ts
git commit -m "feat(api): paginate and filter report history"
```

---

### Task 3: DB keyset index와 schema 문서

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260916150000_report_history_keyset_index/migration.sql`
- Modify: `apps/api/test/domain-schema.test.ts`
- Modify: `docs/database-schema.md`

**Interfaces:**
- Produces: `EnergyReportJob(siteId, createdAt, id)` descending keyset lookup support
- Consumes: Task 2의 order/predicate

- [ ] **Step 1: exact index shape를 요구하는 schema test를 작성한다.**

```ts
expect(model("EnergyReportJob")).toContain("@@index([siteId, createdAt, id]");
```

- [ ] **Step 2: schema test RED를 확인한다.**

Run: `pnpm --filter @led-control/api exec jest test/domain-schema.test.ts --runInBand`

Expected: 새 index 부재로 FAIL.

- [ ] **Step 3: Prisma model과 additive migration을 작성한다.**

```sql
CREATE INDEX "EnergyReportJob_siteId_createdAt_id_idx"
ON "EnergyReportJob"("siteId", "createdAt", "id");
```

기존 index를 같은 migration에서 제거하지 않는다. production preflight와 query plan 증거가 생긴 뒤 별도 최적화로 다룬다.

- [ ] **Step 4: database 문서에 index 목적과 cursor order를 기록한다.**

`EnergyReportJob` 표와 index 설명에 site tenant 범위, createdAt/id tie-break, filter count는 별도 predicate임을 추가한다.

- [ ] **Step 5: schema/migration 검증을 실행한다.**

Run: `pnpm --filter @led-control/api exec prisma validate && pnpm --filter @led-control/api exec jest test/domain-schema.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 6: Task 3을 커밋한다.**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260916150000_report_history_keyset_index/migration.sql apps/api/test/domain-schema.test.ts docs/database-schema.md
git commit -m "perf(db): index report history keyset queries"
```

---

### Task 4: 공통 DataTableShell과 PaginationBar

**Files:**
- Create: `apps/web/src/components/ui/DataTableShell.tsx`
- Create: `apps/web/src/components/ui/PaginationBar.tsx`
- Create: `apps/web/src/components/ui/DataTableShell.test.tsx`
- Create: `apps/web/src/components/ui/PaginationBar.test.tsx`
- Modify: `apps/web/src/components/ui/index.ts`

**Interfaces:**
- Produces: `DataTableShell`, `PaginationBar`
- Consumes: 기존 `Card`, `Button`, `SelectBox`, `Text`, `cn`

- [ ] **Step 1: table semantics, busy state, page size와 navigation event의 RED tests를 작성한다.**

```tsx
render(<PaginationBar page={2} pageSize={20} totalCount={137} hasPrevious hasNext
  onPrevious={onPrevious} onNext={onNext} onPageSizeChange={onPageSizeChange} />);
expect(screen.getByText("21~40 / 137건")).toBeInTheDocument();
fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
expect(onNext).toHaveBeenCalledOnce();
```

DataTableShell test는 caption, table, horizontal overflow container, `aria-busy`, className 전달을 확인한다.

- [ ] **Step 2: component tests RED를 확인한다.**

Run: `pnpm --filter @led-control/web test -- DataTableShell.test.tsx PaginationBar.test.tsx`

Expected: 모듈 부재로 FAIL.

- [ ] **Step 3: Tailwind semantic utility만으로 공통 컴포넌트를 구현한다.**

```tsx
export function DataTableShell({ caption, isBusy, children, className }: Props) {
  return <Card className={cn("min-w-0 overflow-hidden", className)}>
    <div className="min-w-0 overflow-x-auto" aria-busy={isBusy || undefined}>
      <table className="w-full min-w-5xl border-collapse text-body-sm">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  </Card>;
}
```

PaginationBar는 공통 SelectBox options 10·20·50·100, 이전/다음 최소 44px, 현재 page와 range live text를 제공한다. `totalCount=0`은 `0건`, next/previous disabled를 표시한다.

- [ ] **Step 4: component tests와 UI policy를 GREEN으로 만든다.**

Run: `pnpm --filter @led-control/web test -- DataTableShell.test.tsx PaginationBar.test.tsx && pnpm --filter @led-control/web test:ui-policy`

Expected: PASS, 신규 policy violation 0.

- [ ] **Step 5: Task 4를 커밋한다.**

```bash
git add apps/web/src/components/ui/DataTableShell* apps/web/src/components/ui/PaginationBar* apps/web/src/components/ui/index.ts
git commit -m "feat(web): add data table and pagination primitives"
```

---

### Task 5: 보고서 검색 filter bar와 paginated query hook

**Files:**
- Modify: `apps/web/src/api/energy.ts`
- Modify: `apps/web/src/api/energy.test.tsx`
- Create: `apps/web/src/features/statistics/reports/report-history-filters.ts`
- Create: `apps/web/src/features/statistics/reports/report-history-filters.test.ts`
- Create: `apps/web/src/features/statistics/reports/ReportHistoryFilters.tsx`
- Create: `apps/web/src/features/statistics/reports/ReportHistoryFilters.test.tsx`

**Interfaces:**
- Produces: `ReportHistoryFilterState`, `parseReportHistorySearchParams`, `serializeReportHistorySearchParams`, `useEnergyReports(siteId, query)`, `ReportHistoryFilters`
- Consumes: Task 1 query schema, 공통 `TextField`, `SelectBox`, `DateRangePicker`, `Button`

- [ ] **Step 1: URL normalization과 API query key/URL의 RED tests를 작성한다.**

```ts
expect(parseReportHistorySearchParams(new URLSearchParams(
  "query=%20%EC%84%9C%EC%9A%B8%20&status=completed&limit=50"
))).toEqual({ query: "서울", status: "completed", limit: 50 });
```

Hook test는 모든 filter가 URLSearchParams로 encode되고 query key에 normalized query 전체가 포함되며 현재 reports 중 active 상태가 있을 때만 3초 interval을 반환하는지 확인한다.

- [ ] **Step 2: RED를 확인한다.**

Run: `pnpm --filter @led-control/web test -- energy.test.tsx report-history-filters.test.ts ReportHistoryFilters.test.tsx`

Expected: 새 interface/component 부재로 FAIL.

- [ ] **Step 3: pure URL adapter와 query hook을 구현한다.**

```ts
export function useEnergyReports(siteId: string | undefined, query: EnergyReportListQuery) {
  const normalized = energyReportListQuerySchema.parse(query);
  return useQuery({
    queryKey: ["energy-reports", siteId, normalized],
    queryFn: () => apiGet(`/energy/sites/${encodeURIComponent(siteId!)}/reports?${toParams(normalized)}`)
      .then(value => energyReportListResponseSchema.parse(value)),
    enabled: Boolean(siteId),
    placeholderData: keepPreviousData,
    refetchInterval: result => result.state.data?.reports.some(isActiveReport) ? 3_000 : false
  });
}
```

- [ ] **Step 4: filter UI를 구현한다.**

검색 TextField는 입력 상태와 committed debounced query를 분리한다. 300ms timer cleanup으로 stale update를 막는다. DateRangePicker는 Site timezone 날짜 문자열을 그대로 유지하고 API가 timezone instant로 변환한다. 활성 조건 chip의 제거 버튼은 해당 form control과 URL state를 함께 갱신한다.

- [ ] **Step 5: focused Web tests를 GREEN으로 만든다.**

Run: `pnpm --filter @led-control/web test -- energy.test.tsx report-history-filters.test.ts ReportHistoryFilters.test.tsx`

Expected: PASS.

- [ ] **Step 6: Task 5를 커밋한다.**

```bash
git add apps/web/src/api/energy.ts apps/web/src/api/energy.test.tsx apps/web/src/features/statistics/reports/report-history-filters* apps/web/src/features/statistics/reports/ReportHistoryFilters*
git commit -m "feat(web): add report history search filters"
```

---

### Task 6: Compact responsive 보고서 grid와 cursor state

**Files:**
- Create: `apps/web/src/features/statistics/reports/report-job-view-model.ts`
- Create: `apps/web/src/features/statistics/reports/report-job-view-model.test.ts`
- Create: `apps/web/src/features/statistics/reports/ReportJobTable.tsx`
- Create: `apps/web/src/features/statistics/reports/ReportJobCards.tsx`
- Modify: `apps/web/src/features/statistics/reports/ReportJobList.tsx`
- Modify: `apps/web/src/features/statistics/reports/StatisticsReportsPage.tsx`
- Modify: `apps/web/src/features/statistics/reports/StatisticsReportsPage.test.tsx`

**Interfaces:**
- Consumes: Tasks 4–5 primitives/query/filter state
- Produces: desktop table, mobile cards, cursor stack, failure disclosure

- [ ] **Step 1: page size, next/previous, filter reset, generated report first-page reset의 RED tests를 추가한다.**

테스트는 101개 fixture를 모두 DOM에 그리지 말고 API pages를 결정적으로 mock한다. `limit=20 → nextCursor`, 다음 page의 21~40 범위, previous cursor stack 복귀, `limit=100` 변경 시 cursor 제거, filter 변경 시 first page를 검증한다.

- [ ] **Step 2: table/mobile semantics와 failure disclosure RED tests를 추가한다.**

Desktop container는 `table`과 column headings를, mobile container는 `list`, heading, `dl`을 가져야 한다. Failure toggle은 `aria-expanded`, `aria-controls`, 정제된 message/action만 노출해야 한다.

- [ ] **Step 3: RED를 확인한다.**

Run: `pnpm --filter @led-control/web test -- report-job-view-model.test.ts StatisticsReportsPage.test.tsx`

Expected: 기존 Card list 때문에 새 semantics/navigation assertion FAIL.

- [ ] **Step 4: view model과 responsive renderers를 구현한다.**

```ts
type ReportJobViewModel = {
  id: string;
  targetLabel: string;
  scopeLabel: string;
  rangeLabel: string;
  formatLabel: "PDF" | "XLSX";
  status: { label: string; tone: StatusTone; progress?: number };
  requestedAt: FormattedInstant;
  expiresAt?: FormattedInstant;
  action: "download" | "regenerate" | "none";
  failure?: { message: string; action: string };
};
```

Tailwind breakpoint로 desktop/table과 mobile/list 중 하나를 시각적으로 숨기되 hidden DOM이 focusable하지 않도록 `hidden`/responsive display를 사용한다. 같은 row action callback과 label을 공유한다.

- [ ] **Step 5: page에서 URL filter와 cursor stack을 결합한다.**

page state는 `{ page, currentCursor, previousCursors }`다. filter/site/pageSize 변경 시 모두 reset한다. 새 report 생성 성공 시 보고서 query prefix invalidate 후 first page로 이동한다. 기존 `.slice(0, 50)` cache mutation을 제거한다.

- [ ] **Step 6: focused Web tests를 GREEN으로 만든다.**

Run: `pnpm --filter @led-control/web test -- report-job-view-model.test.ts StatisticsReportsPage.test.tsx`

Expected: PASS.

- [ ] **Step 7: Task 6을 커밋한다.**

```bash
git add apps/web/src/features/statistics/reports/ReportJob* apps/web/src/features/statistics/reports/report-job-view-model* apps/web/src/features/statistics/reports/StatisticsReportsPage*
git commit -m "feat(web): render searchable paginated report grid"
```

---

### Task 7: Report document v2와 선택 기간 KPI

**Files:**
- Modify: `packages/shared/src/energy-p2-contracts.ts`
- Modify: `packages/shared/src/energy-p2-contracts.test.ts`
- Modify: `apps/api/src/energy/reports/energy-report-snapshot.service.ts`
- Modify: `apps/api/src/energy/reports/energy-report-snapshot.service.spec.ts`
- Modify: `apps/api/src/energy/reports/energy-report-document.builder.ts`
- Modify: `apps/api/src/energy/reports/energy-report-document.builder.spec.ts`
- Modify: `apps/api/src/energy/reports/report-renderer.ts`
- Modify: `apps/api/src/energy/reports/report-renderer.contract.spec.ts`

**Interfaces:**
- Produces: v1/v2 document union, `calculationBasis`, source-labelled KPI rows, `visualization` references
- Consumes: dimension history ratedWatt, Site tariff, daily/hourly aggregates

- [ ] **Step 1: v1 compatibility와 v2 strict contract의 RED tests를 작성한다.**

v1 fixture는 기존 그대로 parse되어야 한다. v2는 calculation basis와 supported visualization을 요구하고 존재하지 않는 table/column/row reference, 중복 visualization id, unknown source를 거절해야 한다.

- [ ] **Step 2: 선택 기간 KPI 수식의 RED tests를 작성한다.**

고정 fixture:

- 40W 조명 2개, KST 완료 날짜 10일, 전체 scope
- 실제 저장값 12.0000kWh, 저장 비용 1,800원
- 기준값 `40W × 2 × 24h × 10 / 1000 = 19.2000kWh`
- 현재 단가 160원/kWh
- 예상 절감 7.2000kWh, 1,152원, 37.50%
- known 1,555,200초 / expected 1,728,000초 = 90.00%

scope history가 하루 중 바뀌거나 ratedWatt history가 바뀐 경우 실제 유효 seconds로 나눠 계산한다. 단가 null, dimension gap, 실제값 null, baseline zero, 기준 초과를 각각 테스트한다.

- [ ] **Step 3: RED를 확인한다.**

Run: `pnpm --filter @led-control/shared test -- energy-p2-contracts.test.ts && pnpm --filter @led-control/api exec jest src/energy/reports/energy-report-snapshot.service.spec.ts src/energy/reports/energy-report-document.builder.spec.ts src/energy/reports/report-renderer.contract.spec.ts --runInBand`

Expected: v2 contract/calculation 부재로 FAIL.

- [ ] **Step 4: snapshot v2 input을 캡처한다.**

Site tariff, selected scope의 dimension history ratedWatt/effective interval, completed local-day expected seconds를 기존 snapshot transaction에 포함한다. DST 날짜는 고정 86,400초가 아니라 timezone day interval의 실제 UTC seconds를 사용한다. snapshot 이후 현재 DB를 renderer가 다시 조회하지 않는다.

- [ ] **Step 5: document builder v2 KPI와 visualization references를 구현한다.**

요약은 actual energy/stored cost와 baseline/savings/current-tariff cost/data coverage를 source-labelled row로 만든다. Daily table에 baseline column을 추가하고 null actual을 0으로 바꾸지 않는다. Comparison/ranking/heatmap section에 spec의 visualization reference를 추가한다.

- [ ] **Step 6: report traversal이 v1/v2 scalar order를 보존하도록 구현한다.**

v1 `reportBlocks` 출력은 byte-for-byte fixture manifest 순서를 유지한다. v2 calculation basis와 visualization metadata는 fingerprint에 포함하지만 사용자 표시 scalar와 내부 renderer instruction을 구분해 manifest extract가 안정적으로 검증되게 한다.

- [ ] **Step 7: Task 7 focused tests를 GREEN으로 만든다.**

Run: Task 7 Step 3과 동일.

Expected: PASS.

- [ ] **Step 8: Task 7을 커밋한다.**

```bash
git add packages/shared/src/energy-p2-contracts* apps/api/src/energy/reports/energy-report-snapshot.service* apps/api/src/energy/reports/energy-report-document.builder* apps/api/src/energy/reports/report-renderer*
git commit -m "feat(reports): add immutable visual report document v2"
```

---

### Task 8: Deterministic chart visual model과 PNG renderer

**Files:**
- Create: `apps/api/src/energy/reports/report-visual-model.ts`
- Create: `apps/api/src/energy/reports/report-visual-model.spec.ts`
- Create: `apps/api/src/energy/reports/report-chart-image.renderer.ts`
- Create: `apps/api/src/energy/reports/report-chart-image.renderer.spec.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/api/Dockerfile`
- Modify: `apps/api/container-contract.node.mjs`

**Interfaces:**
- Produces: `buildReportVisuals(document): ReportVisual[]`, `renderReportVisual(visual): Promise<RenderedReportVisual>`
- `RenderedReportVisual`: `{ id, png: Buffer, width, height, sha256, altText }`

- [ ] **Step 1: line/bar/ranking/heatmap descriptor의 RED tests를 작성한다.**

테스트는 descriptor가 document table cell reference에서만 값을 가져오고 null daily cell을 0으로 연결하지 않으며 top 10 tie-break가 document 순서를 유지하는지 확인한다.

- [ ] **Step 2: deterministic PNG와 접근성 metadata의 RED tests를 작성한다.**

같은 document 두 번 렌더링의 PNG SHA-256이 같아야 하고, 7×24 heatmap은 168개 cell geometry를 가지며 no-data color가 0 value color와 달라야 한다. PNG metadata나 SVG에 wall-clock/random 값을 넣지 않는다.

- [ ] **Step 3: RED를 확인한다.**

Run: `pnpm --filter @led-control/api exec jest src/energy/reports/report-visual-model.spec.ts src/energy/reports/report-chart-image.renderer.spec.ts --runInBand`

Expected: 모듈 부재로 FAIL.

- [ ] **Step 4: `sharp` dependency와 Linux image contract를 추가한다.**

Run: `pnpm --filter @led-control/api add sharp`

Docker build stage와 runtime architecture에서 sharp를 require할 수 있도록 현재 pnpm deploy/prune 흐름을 유지한다. Container contract는 `require.resolve("sharp")`와 API runtime import smoke를 검증한다.

- [ ] **Step 5: renderer-neutral visual model을 구현한다.**

```ts
export type ReportVisual =
  | { kind: "line"; id: string; title: string; x: string[]; series: VisualSeries[] }
  | { kind: "bar"; id: string; title: string; categories: string[]; series: VisualSeries[] }
  | { kind: "horizontal-bar"; id: string; title: string; rows: VisualBarRow[] }
  | { kind: "heatmap"; id: string; title: string; cells: VisualHeatmapCell[] };
```

Color는 semantic report palette 상수만 사용한다. Axis/legend/title과 no-data pattern을 descriptor에 포함한다.

- [ ] **Step 6: SVG→PNG renderer를 구현한다.**

SVG attribute/text를 escape하고 고정 width/height/viewBox/font family를 사용한다. sharp는 `.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })`처럼 결정적인 option으로 실행한다. PNG limit와 decoded dimensions를 재검증한다.

- [ ] **Step 7: visual/image/container tests를 GREEN으로 만든다.**

Run: `pnpm --filter @led-control/api exec jest src/energy/reports/report-visual-model.spec.ts src/energy/reports/report-chart-image.renderer.spec.ts --runInBand && node apps/api/container-contract.node.mjs`

Expected: PASS.

- [ ] **Step 8: Task 8을 커밋한다.**

```bash
git add apps/api/src/energy/reports/report-visual-model* apps/api/src/energy/reports/report-chart-image.renderer* apps/api/package.json pnpm-lock.yaml apps/api/Dockerfile apps/api/container-contract.node.mjs
git commit -m "feat(reports): render deterministic report charts"
```

---

### Task 9: PDF/XLSX 동일 차트와 layout

**Files:**
- Modify: `apps/api/src/energy/reports/pdf-energy-report.renderer.ts`
- Modify: `apps/api/src/energy/reports/pdf-energy-report.renderer.spec.ts`
- Modify: `apps/api/src/energy/reports/excel-energy-report.renderer.ts`
- Modify: `apps/api/src/energy/reports/excel-energy-report.renderer.spec.ts`
- Modify: `apps/api/src/energy/reports/report-pdf-layout.ts`
- Modify: `apps/api/src/energy/reports/report-renderer.test-support.ts`
- Modify: `apps/api/src/energy/reports/report-renderer.contract.spec.ts`
- Modify: `apps/api/src/energy/reports/pdf-report-manifest.ts`
- Modify: `apps/api/src/energy/reports/excel-report-xml.ts`

**Interfaces:**
- Consumes: Task 8 `RenderedReportVisual[]`
- Produces: PDF/XLSX files with identical source chart PNG SHA-256 and existing scalar manifest

- [ ] **Step 1: PDF/XLSX가 expected visual ids와 hashes를 포함해야 하는 RED contract test를 작성한다.**

```ts
expect(pdf.visuals).toEqual(xlsx.visuals);
expect(pdf.visuals.map(value => value.id)).toEqual([
  "daily-actual-vs-baseline", "period-energy", "period-cost",
  "fixture-ranking", "floor-ranking", "group-ranking", "energy-heatmap", "brightness-heatmap"
]);
```

- [ ] **Step 2: page/sheet layout bounds의 RED tests를 작성한다.**

PDF chart rectangle이 page margin을 넘지 않고 다음 표 header가 새 페이지에서 반복되는지, XLSX image anchor가 대응 sheet의 표를 가리지 않는지 확인한다.

- [ ] **Step 3: RED를 확인한다.**

Run: `pnpm --filter @led-control/api exec jest src/energy/reports/pdf-energy-report.renderer.spec.ts src/energy/reports/excel-energy-report.renderer.spec.ts src/energy/reports/report-renderer.contract.spec.ts --runInBand`

Expected: visual contract 부재로 FAIL.

- [ ] **Step 4: PDF에 chart image와 section caption을 삽입한다.**

각 visualization section에서 source PNG를 `embedPng`하고 aspect ratio를 유지한다. 페이지 여백 내에 들어가지 않으면 새 페이지를 만든다. 차트 title/alt summary는 PDF의 실제 텍스트로도 출력해 image만으로 의미를 전달하지 않는다.

- [ ] **Step 5: XLSX에 같은 PNG와 원본 표를 삽입한다.**

각 sheet 상단에 KPI/차트를, 이후에 원본 표를 둔다. ExcelJS addImage에 Task 8 PNG bytes를 그대로 전달하고 arbitrary 재인코딩을 하지 않는다. hidden manifest sheet에는 visual id/hash/dimensions를 포함한다.

- [ ] **Step 6: serialized file extractor를 확장한다.**

PDF embedded image stream과 XLSX media part의 digest를 추출해 source digest와 비교한다. Scalar manifest 기존 비교를 제거하지 않는다.

- [ ] **Step 7: renderers와 contract tests를 GREEN으로 만든다.**

Run: Task 9 Step 3과 동일.

Expected: PASS, PDF/XLSX scalar와 visual hash 동일.

- [ ] **Step 8: Task 9를 커밋한다.**

```bash
git add apps/api/src/energy/reports/pdf-* apps/api/src/energy/reports/excel-* apps/api/src/energy/reports/report-pdf-layout.ts apps/api/src/energy/reports/report-renderer.test-support.ts apps/api/src/energy/reports/report-renderer.contract.spec.ts
git commit -m "feat(reports): embed charts in PDF and XLSX"
```

---

### Task 10: Browser E2E, 실제 파일 fixture, 문서 갱신

**Files:**
- Modify: `apps/web/e2e/statistics-flow.spec.ts`
- Modify: `apps/api/test/support/render-report-browser-fixtures.ts`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/superpowers/plans/2026-09-16-statistics-report-grid-visual-output.md`

**Interfaces:**
- Consumes: Tasks 1–9 전체 기능
- Produces: browser/file acceptance evidence와 최신 통계 기능 문서

- [ ] **Step 1: 101건 검색·페이지네이션 E2E fixture와 시나리오를 작성한다.**

시나리오:

1. 기본 20건과 `1~20 / 101건`
2. 다음·이전 이동
3. 50/100 page size 변경
4. `서울` 대상명 + completed + PDF + site + 요청일 조합
5. filter 제거와 전체 초기화
6. 새로고침 후 URL filter 복원
7. 생성 후 first page reset
8. 0건 empty state

- [ ] **Step 2: responsive/accessibility assertions를 추가한다.**

1440×900·1024×768에서는 table, 390×844·320×740에서는 mobile list를 확인한다. document horizontal overflow 0, action/filter/pagination bounding box 44×44px 이상, focus visible, failure disclosure, live announcement를 확인한다.

- [ ] **Step 3: 실제 renderer fixture를 PDF/XLSX 다운로드에 연결한다.**

fixture generator는 v2 document에서 PDF/XLSX bytes를 만들고 scalar manifest, visual ids, image hashes를 test metadata로 제공한다. 브라우저 download bytes와 server fixture bytes가 동일해야 한다.

- [ ] **Step 4: 통계 메뉴 문서를 갱신한다.**

`구현 완료`, `미구현`, `부족하거나 개선이 필요한 기능`, `관련 파일`, `갱신 규칙` 구조를 유지한다. 서버 검색 범위, cursor UX, PDF/XLSX 실제 차트, 실제값/생성 당시 기준값 구분, v1 호환, 검증 범위를 기록한다.

- [ ] **Step 5: focused E2E를 실행한다.**

Run: `pnpm --filter @led-control/web exec playwright test e2e/statistics-flow.spec.ts --workers=1`

Expected: 통계 E2E PASS, 환경 의존 skip만 기존 allowlist와 일치.

- [ ] **Step 6: 전체 검증을 실행한다.**

```bash
pnpm --filter @led-control/shared test
pnpm --filter @led-control/api exec jest --runInBand
pnpm --filter @led-control/web test
pnpm --filter @led-control/web test:ui-policy
pnpm typecheck
pnpm build
pnpm --filter @led-control/web exec playwright test e2e/statistics-flow.spec.ts --workers=1
```

Expected: 모든 명령 exit 0. 실패가 있으면 기존 실패로 추정하지 말고 원인을 분리해 수정한 뒤 전체 명령을 다시 실행한다.

- [ ] **Step 7: plan 체크리스트와 검증 수치를 갱신한다.**

각 완료 Task의 checkbox를 `[x]`로 바꾸고 실제 test count, E2E viewport, 생성 파일 크기, visual hash 비교 결과를 계획 하단 실행 기록에 추가한다.

- [ ] **Step 8: Task 10을 커밋한다.**

```bash
git add apps/web/e2e/statistics-flow.spec.ts apps/api/test/support/render-report-browser-fixtures.ts docs/menus/statistics.md docs/superpowers/plans/2026-09-16-statistics-report-grid-visual-output.md
git commit -m "test: verify searchable visual energy reports"
```

---

## Execution Review Gates

- Tasks 1–3 후: shared/API 계약과 DB migration review
- Tasks 4–6 후: Web UI·접근성·URL state review
- Tasks 7–9 후: report accuracy·security·renderer review
- Task 10 후: 전체 diff와 fresh verification review

각 gate에서 다음 task로 넘어가기 전에 spec 위반, tenant scope 확대, raw error 노출, 현재 단가의 과거 실제 비용 오표기, v1 snapshot 회귀가 없는지 확인한다.

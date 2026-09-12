# 통계 P2 히트맵·보고서·탄소 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 P0/P1 상태 기반 에너지 분석을 재사용해 요일×시간대 히트맵, CSV·Excel·PDF 보고서, 근거가 추적되는 탄소 배출·절감 기능을 제공한다.

**Architecture:** P2는 세 단계로 독립 배포한다. 1단계는 기존 `FixtureEnergyHourlyAggregate`를 읽는 heatmap API/UI와 즉시 CSV를 제공하고, 2단계는 동일 분석 snapshot을 소비하는 durable report job·private object storage·Excel/PDF generator를 추가하며, 3단계는 operator가 승인한 effective-dated 배출계수를 일별 사용량·기준 절감량에 결합한다. 화면과 모든 export는 공통 `EnergyReportSnapshotService`의 결과만 직렬화해 산식이 갈라지지 않게 한다.

**Tech Stack:** TypeScript, NestJS, Prisma/PostgreSQL, React 18, React Router, TanStack Query, Recharts, Zod, AWS SDK v3 S3, ExcelJS, pdf-lib, @pdf-lib/fontkit, Noto Sans KR(OFL), Vitest/Jest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-11-statistics-p2-heatmap-reports-carbon-design.md`

## Global Constraints

- 이번 P2에서 최적화 기능은 전부 제외한다. `/statistics/optimization`, 운영 시간, 비운영 시간 낭비, 월 목표·예산 모델/API/UI를 생성하지 않는다.
- heatmap metric은 `energy | brightness`만 허용하고 `waste`를 허용하지 않는다.
- 보고서 포함 항목에서 낭비 감지와 목표·예산을 제외한다.
- 고객 통계 서브메뉴 최종 구성은 `개요`, `사용 분석`, `보고서` 세 개다.
- 모든 수치는 `상태 기반 추정`으로 표시하며 실제 전력계 실측으로 표현하지 않는다.
- heatmap 기본 기간은 완료된 최근 28일, 최대 기간은 양끝 포함 92일이다.
- report 기간도 양끝 포함 최대 92일로 제한해 heatmap·snapshot·파일 크기 상한을 동일하게 유지한다.
- CSV는 UTF-8 BOM을 포함하고 사용자 입력 cell이 `=`, `+`, `-`, `@`로 시작하면 앞에 작은따옴표를 붙인다.
- Excel/PDF 숫자는 report claim 시 저장한 immutable `dataSnapshot`만 사용한다.
- report object는 private storage에서 완료 후 7일, metadata는 생성 후 90일 보존한다.
- download URL은 요청할 때만 생성하며 5분 후 만료한다.
- 배출계수는 `kgCO₂e/kWh` Decimal 원본 정밀도로 계산하고 화면에는 소수 첫째 자리까지 표시한다.
- 승인된 배출계수가 없거나 기간이 겹치면 탄소값을 만들지 않고 `emission_factor_unavailable`을 반환한다.
- 기간 중 배출계수가 바뀌면 local date별 유효 계수를 적용한 뒤 합산한다.
- 음수 절감은 0으로 보정하지 않고 `기준 대비 추가 배출`로 표시한다.
- 기존 summary, series, comparison, ranking 응답 의미와 URL은 변경하지 않는다.
- 신규 DB migration은 기존 migration을 수정하지 않는 순방향 migration으로 작성한다.
- 다른 tenant의 heatmap, report job, object URL, emission assignment 존재 여부는 `404`로 숨긴다.
- API/Web 기능 변경과 함께 `docs/menus/statistics.md`, DB 변경과 함께 `docs/database-schema.md`, 검증 결과와 함께 `docs/project-status.md`를 갱신한다.

---

## 권장 릴리스 단위

1. **P2-A 패턴 분석:** heatmap contract/API/UI + 즉시 CSV
2. **P2-B 공유 보고서:** snapshot + durable job + private storage + Excel/PDF
3. **P2-C 탄소 근거:** factor catalog/assignment + emissions + 고객/운영자 UI + 보고서 포함

P2-A는 신규 hourly row가 이미 쌓이는 현장에서 바로 가치를 제공한다. P2-B는 파일 생성 실패가 실시간 분석 API에 전파되지 않게 격리한다. P2-C는 operator 승인 데이터가 준비된 현장에만 점진 활성화한다.

## 보고서 구현 기술 설계 요약

| 계층 | 기술 | 구현 책임 |
|---|---|---|
| Contract | shared TypeScript type + strict Zod schema | 기간·scope·format·section 요청과 job 응답을 웹/API에서 동일 검증 |
| API | NestJS | 권한 확인, job 생성/조회, CSV stream, 다운로드 URL 발급 |
| Consistent read | Prisma + PostgreSQL `RepeatableRead` | summary·comparison·ranking·heatmap·carbon을 같은 시점의 `dataSnapshot`으로 고정 |
| Durable worker | PostgreSQL row lease + NestJS `OnModuleInit` poller | `SKIP LOCKED` claim, heartbeat, retry, progress, multi-instance fencing |
| CSV | Node.js `Readable` | BOM과 injection 방어를 적용한 즉시 stream |
| XLSX | ExcelJS | 6개 sheet, numeric cell, style/freeze pane/print layout 생성 |
| PDF | pdf-lib + fontkit + Noto Sans KR | Chromium 없이 한글 A4 portrait/landscape vector 문서 생성 |
| Storage | AWS SDK v3 S3 + presigner | attempt별 private upload, HEAD 검증, 5분 GetObject URL, 7일 파일 보존 |
| Frontend | React + TanStack Query | 생성 dialog, 202 응답 반영, active job polling, 상태/오류/만료/다운로드 UI |
| Verification | Jest + Playwright + Poppler | 상태 전이, tenant 격리, workbook 구조, PDF 한글·페이지 경계, E2E 검증 |

보고서 생성은 API request thread에서 실행하지 않는다. POST는 job row만 만든 뒤 빠르게 `202 Accepted`를 반환하고, 기존 API 프로세스 안의 DB lease worker가 한 번에 한 job씩 처리한다. 첫 worker가 `dataSnapshot`을 저장한 뒤에는 재시도도 같은 JSON만 사용하므로, 생성 도중 통계 aggregate가 갱신되어도 Excel/PDF의 수치가 바뀌지 않는다. 규모가 커지면 worker provider만 별도 process로 떼어낼 수 있게 controller, job service, generator를 분리한다.

브라우저는 active job이 있을 때만 3초 polling하고 terminal state에서 중단한다. 다운로드 버튼은 저장소 URL을 직접 보관하지 않고 API에 일회 요청해 5분 signed URL을 받은 뒤 이동한다. snapshot은 원시 telemetry가 아닌 최대 92일 aggregate만 포함하고, 파일은 25 MB 상한을 적용한다.

## 파일 구조

### Shared 계약

- Create: `packages/shared/src/energy-p2-contracts.ts` — heatmap, CSV request, report job, emissions 계약
- Create: `packages/shared/src/energy-p2-contracts.test.ts` — strict schema와 경계 검증
- Modify: `packages/shared/src/index.ts` — root export
- Modify: `packages/shared/package.json` — `./energy-p2-contracts` ESM/CommonJS export
- Modify: `packages/shared/tsconfig.esm.json` — 신규 계약 빌드 포함
- Modify: `packages/shared/src/package-exports.test.ts` — packed package runtime import 검증

### API와 DB

- Create: `apps/api/prisma/migrations/20260912_statistics_p2_reports_emissions/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/test/domain-schema.test.ts`
- Create: `apps/api/src/energy/energy-heatmap.service.ts`
- Create: `apps/api/src/energy/energy-heatmap.service.spec.ts`
- Create: `apps/api/src/energy/energy-heatmap.integration.spec.ts`
- Create: `apps/api/src/energy/reports/energy-report-snapshot.service.ts`
- Create: `apps/api/src/energy/reports/energy-report-snapshot.service.spec.ts`
- Create: `apps/api/src/energy/reports/energy-csv-export.service.ts`
- Create: `apps/api/src/energy/reports/energy-csv-export.service.spec.ts`
- Create: `apps/api/src/energy/reports/energy-report-jobs.service.ts`
- Create: `apps/api/src/energy/reports/energy-report-jobs.service.spec.ts`
- Create: `apps/api/src/energy/reports/energy-report-worker.service.ts`
- Create: `apps/api/src/energy/reports/energy-report-worker.service.spec.ts`
- Create: `apps/api/src/energy/reports/energy-report-cleanup.service.ts`
- Create: `apps/api/src/energy/reports/energy-report-cleanup.service.spec.ts`
- Create: `apps/api/src/energy/reports/excel-energy-report.generator.ts`
- Create: `apps/api/src/energy/reports/excel-energy-report.generator.spec.ts`
- Create: `apps/api/src/energy/reports/pdf-energy-report.generator.ts`
- Create: `apps/api/src/energy/reports/pdf-energy-report.generator.spec.ts`
- Create: `apps/api/src/energy/emissions/emission-factors.service.ts`
- Create: `apps/api/src/energy/emissions/emission-factors.service.spec.ts`
- Create: `apps/api/src/energy/emissions/energy-emissions.service.ts`
- Create: `apps/api/src/energy/emissions/energy-emissions.service.spec.ts`
- Create: `apps/api/src/energy/emissions/operator-emission-factors.controller.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.module.ts`
- Modify: `apps/api/src/storage/object-storage.service.ts`
- Modify: `apps/api/src/storage/object-storage.service.spec.ts`
- Modify: `apps/api/src/storage/storage.module.ts`
- Modify: `apps/api/src/operator-site-admins/site-deletion-cleanup.service.ts`
- Modify: `apps/api/src/operator-site-admins/site-deletion-cleanup.service.spec.ts`
- Add: `apps/api/src/assets/fonts/NotoSansKR-Regular.ttf`
- Add: `apps/api/src/assets/fonts/NotoSansKR-Bold.ttf`
- Add: `apps/api/src/assets/fonts/OFL.txt`
- Modify: `apps/api/nest-cli.json` — `assets/fonts/**/*`를 build output에 복사
- Modify: `apps/api/package.json` — `exceljs`, `pdf-lib`, `@pdf-lib/fontkit`

### Web

- Modify: `apps/web/src/features/statistics/statistics-sections.ts`
- Modify: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.tsx`
- Modify: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx`
- Create: `apps/web/src/features/statistics/analysis/EnergyHeatmap.tsx`
- Create: `apps/web/src/features/statistics/analysis/EnergyHeatmap.test.tsx`
- Create: `apps/web/src/features/statistics/reports/StatisticsReportsPage.tsx`
- Create: `apps/web/src/features/statistics/reports/StatisticsReportsPage.test.tsx`
- Create: `apps/web/src/features/statistics/reports/ReportCreateDialog.tsx`
- Create: `apps/web/src/features/statistics/reports/ReportJobList.tsx`
- Create: `apps/web/src/features/statistics/reports/CarbonSummaryPanel.tsx`
- Create: `apps/web/src/features/operator/emissions/EmissionFactorManagementView.tsx`
- Create: `apps/web/src/features/operator/emissions/EmissionFactorManagementView.test.tsx`
- Modify: `apps/web/src/features/operator/OperatorShell.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/api/energy.ts`
- Modify: `apps/web/src/api/energy.test.tsx`
- Create: `apps/web/src/api/emission-factors.ts`
- Create: `apps/web/src/api/emission-factors.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/e2e/statistics-flow.spec.ts`
- Create: `apps/web/e2e/operator-emission-factors.spec.ts`

### 문서와 시각 증거

- Modify: `docs/superpowers/specs/2026-09-10-statistics-analytics-roadmap-design.md` — P2 정본 링크와 최적화 제외 상태 반영
- Modify: `docs/menus/statistics.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/project-status.md`
- Create: `docs/assets/statistics-analytics/statistics-p2-heatmap-ui.png`
- Create: `docs/assets/statistics-analytics/statistics-p2-reports-ui.png`
- Create: `docs/assets/statistics-analytics/statistics-p2-carbon-ui.png`

---

### Task 1: P2 범위와 strict shared 계약 고정

**Files:**
- Create: `packages/shared/src/energy-p2-contracts.ts`
- Create: `packages/shared/src/energy-p2-contracts.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json`
- Modify: `packages/shared/tsconfig.esm.json`
- Modify: `packages/shared/src/package-exports.test.ts`
- Modify: `docs/superpowers/specs/2026-09-10-statistics-analytics-roadmap-design.md`

**Interfaces:**
- Produces: `EnergyHeatmapQuery`, `EnergyHeatmapResponse`, `EnergyReportRequest`, `EnergyReportJobResponse`, `EnergyEmissionsResponse`와 대응 Zod schema.
- Consumes: 기존 `EnergyDataStatus`, `EnergyRankingDimension`, ISO local date 규칙.

- [ ] **Step 1: 최적화 제외 계약 테스트를 작성한다.**

```ts
expect(energyHeatmapQuerySchema.parse({
  from: "2026-08-01", to: "2026-08-28", metric: "energy", scope: "site"
})).toMatchObject({ metric: "energy", scope: "site" });
expect(() => energyHeatmapQuerySchema.parse({
  from: "2026-08-01", to: "2026-08-28", metric: "waste", scope: "site"
})).toThrow();
expect(() => energyReportRequestSchema.parse({
  from: "2026-08-01", to: "2026-08-28", format: "pdf", sections: ["waste"]
})).toThrow();
```

- [ ] **Step 2: 92일, scope와 상태 경계를 실패로 확인한다.**
  - `scope=site`이면 `identityId`를 거부한다.
  - `scope=fixture|floor|group`이면 `identityId` UUID를 요구한다.
  - 93일 요청, 역전 날짜, unknown field를 거부한다.
  - `queued | processing | completed | failed | expired` 외 report status를 거부한다.
  - Run: `pnpm --filter @led-control/shared test -- energy-p2-contracts.test.ts`
  - Expected: FAIL because P2 schemas do not exist.

- [ ] **Step 3: additive 계약을 구현한다.**

```ts
export const energyHeatmapMetricSchema = z.enum(["energy", "brightness"]);
export const energyHeatmapScopeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("site") }).strict(),
  z.object({ scope: z.enum(["fixture", "floor", "group"]), identityId: z.string().uuid() }).strict()
]);

export const energyReportSectionSchema = z.enum([
  "summary", "comparison", "rankings", "heatmap", "emissions", "data_quality", "metadata"
]);
```

  - heatmap cell은 `weekday`, `localHour`, `estimatedKwh`, `averageBrightness`, `knownSeconds`, `unknownSeconds`, `coverageRate`, `utcBucketCount`, `dataStatus`를 가진다.
  - emissions는 `estimatedUsageKgCo2e`, `baselineKgCo2e`, `savedKgCo2e`, `result=saving|overuse|unavailable`, 적용 factor segment 배열을 가진다.
  - report request는 `from`, `to`, `format=xlsx|pdf`, `scope`, `sections`, `locale=ko-KR`만 허용한다.

- [ ] **Step 4: package runtime export를 검증한다.**
  - Run: `pnpm --filter @led-control/shared test && pnpm --filter @led-control/shared typecheck`
  - Expected: root/subpath ESM과 CommonJS import 모두 PASS.

- [ ] **Step 5: 설계 문서의 P2에서 최적화 의존성을 제거한다.**
  - 네 개 서브메뉴 문구를 `개요/사용 분석/보고서` 세 개로 바꾼다.
  - heatmap `waste`, 보고서 `낭비/목표·예산` 포함 문구를 제거한다.
  - P2 완료 기준과 rollout도 같은 범위로 맞춘다.

- [ ] **Step 6: 커밋한다.**
  - Run: `git add packages/shared docs/superpowers/specs/2026-09-10-statistics-analytics-roadmap-design.md && git commit -m "feat(shared): define statistics P2 contracts"`

### Task 2: report와 배출계수 DB foundation

**Files:**
- Create: `apps/api/prisma/migrations/20260912_statistics_p2_reports_emissions/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/test/domain-schema.test.ts`
- Modify: `docs/database-schema.md`

**Interfaces:**
- Produces: `EnergyReportJob`, `EmissionFactorCatalog`, `SiteEmissionFactorAssignment` Prisma model.
- Consumes: 기존 `Site`, `User`, cascade deletion 정책.

- [ ] **Step 1: schema invariant 실패 테스트를 작성한다.**
  - active report dedupe partial unique index가 `(siteId, requestedByActorId, requestHash)`에 존재하는지 검사한다.
  - report status/progress/attempt check constraint를 검사한다.
  - assignment overlap exclusion constraint가 site별 `tstzrange(effectiveFrom, effectiveTo, '[)')`에 존재하는지 검사한다.
  - factor 값이 0보다 크고 effective range가 순방향인지 검사한다.

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand test/domain-schema.test.ts`
  - Expected: FAIL because the three models and constraints are absent.

- [ ] **Step 3: Prisma 모델과 migration을 구현한다.**

```prisma
model EnergyReportJob {
  id                String   @id @default(uuid())
  siteId            String
  requestedByActorId String
  requestedByUserId String?
  requestedByLoginIdSnapshot String
  format            String
  status            String
  progressPercent   Int      @default(0)
  requestHash       String
  requestSnapshot   Json
  dataSnapshot      Json?
  objectKey         String?
  contentSha256     String?
  contentType       String?
  sizeBytes         Int?
  attemptCount      Int      @default(0)
  leaseOwner        String?
  leaseExpiresAt    DateTime?
  errorCode         String?
  createdAt         DateTime @default(now())
  startedAt         DateTime?
  completedAt       DateTime?
  expiresAt         DateTime?
  site              Site     @relation(fields: [siteId], references: [id], onDelete: Cascade)
  requestedBy       User?    @relation(fields: [requestedByUserId], references: [id], onDelete: SetNull)
  @@index([status, leaseExpiresAt, createdAt])
  @@index([siteId, createdAt])
}
```

  - active report dedupe key는 `(siteId, requestedByActorId, requestHash)`이며 `requestedByActorId`는 요청 당시 User ID snapshot이다.
  - `requestHash`는 canonical JSON의 SHA-256 hex다.
  - factor catalog row는 승인 후 immutable이며 수정 대신 새 `version` row를 만든다.
  - assignment는 factor row를 가리키며 현장 삭제 시 cascade한다.
  - 사용자 영구 삭제 시 FK는 `SET NULL`이지만 `requestedByActorId`와 `requestedByLoginIdSnapshot`은 남겨 report metadata와 active dedupe 의미를 보존한다.

- [ ] **Step 4: migration rehearsal을 실행한다.**
  - fresh schema와 기존 P1 hourly/daily row가 있는 schema 양쪽에 migration을 적용한다.
  - 겹치는 assignment와 active duplicate job insert가 DB에서 거부되는지 확인한다.
  - Run: `pnpm --filter @led-control/api test -- --runInBand test/domain-schema.test.ts`
  - Run: `DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/validation pnpm --filter @led-control/api exec prisma validate`

- [ ] **Step 5: DB 문서를 갱신하고 커밋한다.**
  - Run: `git add apps/api/prisma apps/api/test/domain-schema.test.ts docs/database-schema.md && git commit -m "feat(api): add P2 report and emission schema"`

### Task 3: 요일×시간대 heatmap query

**Files:**
- Create: `apps/api/src/energy/energy-heatmap.service.ts`
- Create: `apps/api/src/energy/energy-heatmap.service.spec.ts`
- Create: `apps/api/src/energy/energy-heatmap.integration.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.service.ts`
- Modify: `apps/api/src/energy/energy.module.ts`

**Interfaces:**
- Consumes: `FixtureEnergyHourlyAggregate`, dimension/group membership history, `energyHeatmapQuerySchema`.
- Produces: `GET /energy/sites/:siteId/heatmap` returning exactly 168 cells.

- [ ] **Step 1: heatmap 산식 실패 테스트를 작성한다.**

```ts
expect(cell.averageBrightness).toBe(
  round(sumBrightnessWeightedSeconds.div(sumKnownSeconds), 1)
);
expect(cell.estimatedKwh).toBe(12.3456);
expect(cell.utcBucketCount).toBe(5);
```

  - 월요일 시작 7×24 정렬, no-data/zero 구분, known/unknown coverage를 포함한다.
  - DST fall-back의 같은 local weekday/hour 두 UTC row는 한 cell에 합치고 `utcBucketCount=2` 이상을 유지한다.
  - DST spring-forward로 row가 없는 cell은 0이 아니라 `no_data`다.
  - group scope는 유효기간 membership을 적용하고 복수 그룹 합계를 현장 총계로 오인하지 않는다.

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/energy-heatmap.service.spec.ts`
  - Expected: FAIL because `EnergyHeatmapService` is absent.

- [ ] **Step 3: site-first bounded SQL을 구현한다.**

```ts
getHeatmap(
  user: AuthenticatedUser,
  siteId: string,
  rawQuery: unknown,
  readContext?: { tx: Prisma.TransactionClient; generatedAt: Date }
): Promise<EnergyHeatmapResponse>
```

  - `siteAccess.assert(user, siteId, "read")`를 analytics SQL보다 먼저 실행한다.
  - `bucketStartUtc`, `localDate`, `localHour`, UTC offset은 저장된 값을 사용하고 서버 timezone으로 재해석하지 않는다.
  - fixture/floor/group scope는 P1 identity ID만 받고 operational ID를 받지 않는다.
  - brightness denominator는 known seconds만 사용한다.
  - energy가 정확히 0이고 known seconds가 있으면 `available` 0으로 반환한다.
  - 데이터가 없는 weekday/hour도 빈 cell을 생성해 168개 정렬을 고정한다.

- [ ] **Step 4: tenant와 기간 integration을 검증한다.**
  - 타 site identity를 요청하면 `404`다.
  - 93일 요청은 SQL 전에 `400`이다.
  - 삭제된 fixture identity의 과거 hourly row도 요청 기간에 포함된다.
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/energy-heatmap.service.spec.ts src/energy/energy-heatmap.integration.spec.ts`

- [ ] **Step 5: 커밋한다.**
  - Run: `git add apps/api/src/energy && git commit -m "feat(api): query hourly energy heatmaps"`

### Task 4: 사용 분석 heatmap UI

**Files:**
- Create: `apps/web/src/features/statistics/analysis/EnergyHeatmap.tsx`
- Create: `apps/web/src/features/statistics/analysis/EnergyHeatmap.test.tsx`
- Modify: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.tsx`
- Modify: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx`
- Modify: `apps/web/src/api/energy.ts`
- Modify: `apps/web/src/api/energy.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `useEnergyHeatmap({ siteId, from, to, metric, scope, identityId })`.
- Produces: ranking 선택과 연동되는 7×24 heatmap, keyboard/touch 상세 표시.

- [ ] **Step 1: hook와 화면 상태 실패 테스트를 작성한다.**
  - query key에 site/range/metric/scope/identityId 전체가 포함되는지 검사한다.
  - P1 ranking에서 항목 선택 시 heatmap scope가 같은 identity로 바뀌는지 검사한다.
  - 선택이 없으면 site 전체, site 변경 시 selection 초기화, heatmap 오류가 ranking을 숨기지 않는지 검사한다.

- [ ] **Step 2: 접근성 실패 테스트를 작성한다.**
  - grid accessible name, 168개 gridcell, 선택 cell의 숫자 상세, 결측 cell의 `데이터 없음` 문구를 검사한다.
  - energy/brightness는 `aria-pressed` segmented control이고 색상 외 숫자·범례가 있다.
  - 좌우/상하 방향키는 1시간/1요일씩 이동하고 Enter/Space로 상세를 고정한다.

- [ ] **Step 3: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/web test -- EnergyHeatmap.test.tsx StatisticsAnalysisPage.test.tsx src/api/energy.test.tsx`
  - Expected: FAIL because the hook and component are absent.

- [ ] **Step 4: component를 구현한다.**
  - 기존 `Card`, `FeedbackState`, `StatusBadge`, segmented control 시각을 재사용한다.
  - 데스크톱 cell은 최소 32px, coarse pointer/mobile은 44px이며 component 내부만 가로 scroll한다.
  - 선택 상세에는 값, 수집률, known/unknown 시간, UTC bucket count를 표시한다.
  - Recharts를 heatmap에 억지로 사용하지 않고 CSS grid cell로 구현한다.
  - `prefers-reduced-motion`에서 metric 전환 색 변화 animation을 끈다.

- [ ] **Step 5: 네 viewport를 검증하고 커밋한다.**
  - Run: `pnpm --filter @led-control/web test -- EnergyHeatmap.test.tsx StatisticsAnalysisPage.test.tsx src/api/energy.test.tsx`
  - Run: `pnpm --filter @led-control/web typecheck`
  - Run: `git add apps/web/src && git commit -m "feat(web): add statistics usage heatmap"`

### Task 5: effective-dated 배출계수와 탄소 산식

**Files:**
- Create: `apps/api/src/energy/emissions/emission-factors.service.ts`
- Create: `apps/api/src/energy/emissions/emission-factors.service.spec.ts`
- Create: `apps/api/src/energy/emissions/energy-emissions.service.ts`
- Create: `apps/api/src/energy/emissions/energy-emissions.service.spec.ts`
- Create: `apps/api/src/energy/emissions/operator-emission-factors.controller.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.module.ts`

**Interfaces:**
- Produces: operator factor catalog/assignment API와 `GET /energy/sites/:siteId/emissions`.
- Consumes: daily aggregates, P0 baseline semantics, factor/assignment tables.

- [ ] **Step 1: 승인·권한·유효기간 실패 테스트를 작성한다.**
  - operator만 factor 생성과 site assignment를 수행할 수 있다.
  - customer admin/viewer는 emissions read만 가능하고 factor 값을 수정할 수 없다.
  - 같은 site의 assignment overlap, 0 이하 factor, 역전 기간을 거부한다.
  - 이미 승인된 factor row의 in-place mutation method는 제공하지 않는다.

- [ ] **Step 2: 탄소 산식 실패 테스트를 작성한다.**

```text
estimatedUsageKgCo2e = Σ(localDateEstimatedKwh × factorAt(localDate))
baselineKgCo2e       = Σ(localDateBaselineKwh × factorAt(localDate))
savedKgCo2e          = baselineKgCo2e - estimatedUsageKgCo2e
```

  - factor version 경계, leap day, factor 없음, assignment gap, 음수 savings를 검사한다.
  - factor gap이 하루라도 있으면 전체 응답을 `unavailable`로 두고 부분 탄소값을 만들지 않는다.

- [ ] **Step 3: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/emissions`
  - Expected: FAIL because emission services are absent.

- [ ] **Step 4: factor service와 operator API를 구현한다.**

```http
GET  /operator/emission-factors
POST /operator/emission-factors
GET  /operator/sites/:siteId/emission-factor
PUT  /operator/sites/:siteId/emission-factor
GET  /energy/sites/:siteId/emissions?from=YYYY-MM-DD&to=YYYY-MM-DD
```

  - POST는 immutable catalog version을 생성한다.
  - PUT assignment는 site row를 lock하고 현재 열린 assignment를 닫은 뒤 새 assignment를 생성한다.
  - operator audit metadata에는 factor ID/version/effective range만 기록하고 session이나 credential을 기록하지 않는다.

- [ ] **Step 5: Decimal 계산과 tenant scope를 검증한다.**
  - 소수 계산 중 JS number로 바꾸지 않고 응답 직렬화 직전에만 반올림한다.
  - 타 tenant 사용자에게 factor assignment 존재 여부를 노출하지 않는다.
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/emissions`

- [ ] **Step 6: 커밋한다.**
  - Run: `git add apps/api/src/energy/emissions apps/api/src/energy/energy.controller.ts apps/api/src/energy/energy.module.ts && git commit -m "feat(api): calculate traceable energy emissions"`

### Task 6: 공통 report snapshot과 즉시 CSV

**Files:**
- Create: `apps/api/src/energy/reports/energy-report-snapshot.service.ts`
- Create: `apps/api/src/energy/reports/energy-report-snapshot.service.spec.ts`
- Create: `apps/api/src/energy/reports/energy-csv-export.service.ts`
- Create: `apps/api/src/energy/reports/energy-csv-export.service.spec.ts`
- Modify: `apps/api/src/energy/energy-analytics-query.service.ts`
- Modify: `apps/api/src/energy/energy-rankings.service.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.module.ts`

**Interfaces:**
- Produces: `buildSnapshot(user, siteId, request, generatedAt): Promise<EnergyReportSnapshot>`와 streaming CSV endpoint.
- Consumes: P0 summary/comparison, P1 ranking, Task 3 heatmap, Task 5 emissions.

- [ ] **Step 1: snapshot 일관성 실패 테스트를 작성한다.**
  - 모든 section에 동일 `generatedAt`, site timezone, source가 들어간다.
  - read 중간에 새 aggregate가 commit되어도 RepeatableRead snapshot에는 섞이지 않는다.
  - 요청하지 않은 section은 query하지도, JSON에 넣지도 않는다.

- [ ] **Step 2: query service에 read context를 추가한다.**

```ts
export interface EnergyAnalyticsReadContext {
  tx: Prisma.TransactionClient;
  generatedAt: Date;
}
```

  - 기존 endpoint는 내부에서 context를 만들고 기존 응답을 유지한다.
  - report snapshot은 하나의 `Prisma.TransactionIsolationLevel.RepeatableRead` transaction에서 모든 section을 조립한다.

- [ ] **Step 3: CSV 보안 실패 테스트를 작성한다.**

```ts
expect(csvCell("=HYPERLINK(\"https://bad\")").startsWith("\"'=")).toBe(true);
expect(output.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
```

  - comma, quote, CR/LF, `+`, `-`, `@` prefix와 한글 label을 검사한다.
  - `Content-Disposition` filename은 ASCII fallback과 RFC 5987 `filename*`을 함께 사용한다.

- [ ] **Step 4: 즉시 CSV endpoint를 구현한다.**

```http
GET /energy/sites/:siteId/exports/csv?from=YYYY-MM-DD&to=YYYY-MM-DD&scope=site
```

  - metadata, daily usage/cost/coverage, ranking, heatmap, emission factor segment를 section marker로 구분한다.
  - 최대 92일 snapshot만 허용하고 response body 전체를 controller string으로 만들지 않고 Node stream으로 전달한다.
  - response header에 `Cache-Control: private, no-store`를 설정한다.

- [ ] **Step 5: 검증하고 커밋한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/reports/energy-report-snapshot.service.spec.ts src/energy/reports/energy-csv-export.service.spec.ts`
  - Run: `pnpm --filter @led-control/api typecheck`
  - Run: `git add apps/api/src/energy && git commit -m "feat(api): export consistent energy CSV snapshots"`

### Task 7: private report object storage

**Files:**
- Modify: `apps/api/src/storage/object-storage.service.ts`
- Modify: `apps/api/src/storage/object-storage.service.spec.ts`
- Modify: `apps/api/src/storage/storage.module.ts`
- Modify: `apps/api/src/storage/object-storage.integration.spec.ts`

**Interfaces:**
- Produces: `putPrivateObject`, `createPrivateDownloadUrl`, `deletePrivateObject`, `headObject`.
- Consumes: 기존 AWS SDK v3 S3 client/options.

- [ ] **Step 1: private object 실패 테스트를 작성한다.**
  - `reports/{siteId}/{reportId}/attempt-{attemptCount}.{ext}` 밖의 key를 거부한다.
  - upload에 content type, content length, SHA-256 checksum이 들어간다.
  - download URL은 GetObject command와 300초 expiry를 사용한다.
  - response content disposition은 안전한 attachment filename만 허용한다.

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/storage/object-storage.service.spec.ts`
  - Expected: FAIL because private report methods are absent.

- [ ] **Step 3: floor 공개 asset과 report private object 경계를 구현한다.**

```ts
putPrivateObject(input: {
  objectKey: string;
  body: Uint8Array;
  contentType: "application/pdf" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  sha256Hex: string;
}): Promise<void>
```

  - report에는 `publicUrl`을 생성하지 않는다.
  - signed URL이나 storage credential을 log/audit metadata에 넣지 않는다.
  - GetObject URL은 API가 `read` 권한과 report site를 확인한 뒤에만 발급한다.

- [ ] **Step 4: S3-compatible integration을 검증한다.**
  - private upload→HEAD checksum/size→signed GET→delete 순서를 검증한다.
  - Run: `RUN_OBJECT_STORAGE_INTEGRATION=true pnpm --filter @led-control/api test -- --runInBand src/storage/object-storage.integration.spec.ts`

- [ ] **Step 5: 커밋한다.**
  - Run: `git add apps/api/src/storage && git commit -m "feat(api): store reports as private objects"`

### Task 8: durable report job과 Excel generator

**Files:**
- Create: `apps/api/src/energy/reports/energy-report-jobs.service.ts`
- Create: `apps/api/src/energy/reports/energy-report-jobs.service.spec.ts`
- Create: `apps/api/src/energy/reports/energy-report-worker.service.ts`
- Create: `apps/api/src/energy/reports/energy-report-worker.service.spec.ts`
- Create: `apps/api/src/energy/reports/excel-energy-report.generator.ts`
- Create: `apps/api/src/energy/reports/excel-energy-report.generator.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.module.ts`
- Modify: `apps/api/package.json`

**Interfaces:**
- Produces: report CRUD/download API, leased worker, snapshot 기반 `.xlsx` bytes.
- Consumes: report snapshot, `EnergyReportJob`, private storage.

- [ ] **Step 1: job 상태 전이 실패 테스트를 작성한다.**
  - 같은 site/user/request hash의 queued/processing job은 기존 row를 반환한다.
  - completed/failed/expired job 이후 같은 요청은 새 row를 만든다.
  - claim은 `FOR UPDATE SKIP LOCKED`, 30초 lease, 한 번에 1개를 사용한다.
  - processing worker가 중단되면 lease expiry 후 다른 worker가 같은 job을 재개한다.
  - 최대 3회 실패 후 `failed`, 그 전에는 `queued`와 backoff 시각으로 돌아간다.

- [ ] **Step 2: lease fencing 실패 테스트를 작성한다.**
  - snapshot, render, upload 각 경계 전에 `leaseOwner`와 live `leaseExpiresAt`을 검사한다.
  - upload 후 lease를 잃은 worker는 completed transition을 수행하지 않는다.
  - attempt별 object key를 사용해 lease를 잃은 worker가 승자의 파일을 덮어쓰지 못한다.

- [ ] **Step 3: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/reports/energy-report-jobs.service.spec.ts src/energy/reports/energy-report-worker.service.spec.ts`
  - Expected: FAIL because job services are absent.

- [ ] **Step 4: report API와 worker를 구현한다.**

```http
POST /energy/sites/:siteId/reports
GET  /energy/sites/:siteId/reports?cursor=<opaque>&limit=20
GET  /energy/sites/:siteId/reports/:reportId
POST /energy/sites/:siteId/reports/:reportId/download
```

  - progress는 claim 10, snapshot 35, render 75, upload 90, commit 100으로만 전진한다.
  - 첫 성공 snapshot은 `dataSnapshot`에 lease 조건부 update로 저장하고, 이후 retry는 query를 다시 실행하지 않는다.
  - worker는 기존 service pattern과 같은 `OnModuleInit` poller로 시작하며 instance별 UUID를 lease owner로 사용한다.
  - validation/unsupported-format은 즉시 실패하고 object storage timeout만 최대 3회 지수 backoff로 재시도한다.
  - 원시 telemetry를 포함하지 않는 최대 92일 aggregate snapshot만 허용하고 결과 파일이 25 MB를 넘으면 `report_too_large`로 종료한다.
  - download는 completed이면서 `expiresAt > now`인 job만 5분 URL을 반환한다.
  - expired file은 URL을 반환하지 않고 `report_expired` 상태와 재생성 가능 request를 반환한다.

- [ ] **Step 5: Excel 구조 실패 테스트를 작성한다.**
  - sheet는 `요약`, `일별 사용량`, `사용량 순위`, `시간대 패턴`, `탄소`, `산정 정보` 순서다.
  - numeric cell은 문자열이 아니라 number type이다.
  - formula cell을 만들지 않고 사용자 label은 그대로 text type으로 저장한다.
  - timezone, generatedAt, source, factor version이 `산정 정보`에 존재한다.

- [ ] **Step 6: ExcelJS generator를 구현한다.**
  - heatmap은 7×24 fixed grid와 neutral no-data fill을 사용한다.
  - 모든 sheet에 freeze pane, print area, column width 상한을 고정한다.
  - workbook creator/created/modified metadata를 snapshot 값으로 고정하고 locale 의존 format 대신 명시적 number/date format을 사용한다.
  - 생성 byte의 SHA-256을 worker가 저장한다.

- [ ] **Step 7: 검증하고 커밋한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/reports`
  - Run: `pnpm --filter @led-control/api typecheck`
  - Run: `git add apps/api/src/energy/reports apps/api/src/energy/energy.controller.ts apps/api/src/energy/energy.module.ts apps/api/package.json pnpm-lock.yaml && git commit -m "feat(api): generate durable Excel energy reports"`

### Task 9: 한글 PDF generator

**Files:**
- Create: `apps/api/src/energy/reports/pdf-energy-report.generator.ts`
- Create: `apps/api/src/energy/reports/pdf-energy-report.generator.spec.ts`
- Add: `apps/api/src/assets/fonts/NotoSansKR-Regular.ttf`
- Add: `apps/api/src/assets/fonts/NotoSansKR-Bold.ttf`
- Add: `apps/api/src/assets/fonts/OFL.txt`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/energy/reports/energy-report-worker.service.ts`
- Modify: `apps/api/nest-cli.json`

**Interfaces:**
- Produces: A4 PDF bytes from immutable `EnergyReportSnapshot`.
- Consumes: pdf-lib, @pdf-lib/fontkit, bundled Noto Sans KR font.

- [ ] **Step 1: font와 page layout 실패 테스트를 작성한다.**
  - regular/bold font files와 OFL license가 repository와 production build output에 포함되는지 검사한다.
  - snapshot generatedAt이 같으면 PDF metadata와 page count가 안정적인지 검사한다.
  - 긴 한글 현장/층/그룹명이 표 폭을 넘어가면 줄바꿈되고 row가 다음 page로 이동한다.

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/reports/pdf-energy-report.generator.spec.ts`
  - Expected: FAIL because generator and fonts are absent.

- [ ] **Step 3: vector 기반 PDF를 구현한다.**
  - 표지/요약은 A4 portrait, heatmap과 넓은 ranking 표는 A4 landscape page를 사용한다.
  - summary, comparison, ranking bar, 7×24 heatmap, emissions, data quality, metadata를 `dataSnapshot` 순서로 그린다.
  - 차트 색만으로 의미를 구분하지 않고 legend와 직접 숫자를 함께 출력한다.
  - footer에 `상태 기반 추정`, timezone, generatedAt, page number를 넣는다.
  - production Chromium을 추가하지 않고 pdf-lib vector drawing을 사용한다.
  - `apps/api/nest-cli.json`의 `compilerOptions.assets`에 `assets/fonts/**/*`를 등록하고 runtime에서는 `join(__dirname, "assets", "fonts", fileName)`으로만 읽는다.

- [ ] **Step 4: render 시각 검증을 자동화한다.**
  - 생성 PDF를 Poppler로 PNG page로 렌더한다.
  - text extraction으로 핵심 한글과 factor source/version을 확인한다.
  - page image에서 표/heatmap bounding box가 page crop box 안에 있는지 검사한다.

- [ ] **Step 5: worker format 분기를 연결하고 커밋한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/reports`
  - Run: `pnpm --filter @led-control/api build`
  - Run: `git add apps/api && git add pnpm-lock.yaml && git commit -m "feat(api): generate Korean PDF energy reports"`

### Task 10: 보고서·탄소 고객 UI와 operator factor UI

**Files:**
- Create: `apps/web/src/features/statistics/reports/StatisticsReportsPage.tsx`
- Create: `apps/web/src/features/statistics/reports/StatisticsReportsPage.test.tsx`
- Create: `apps/web/src/features/statistics/reports/ReportCreateDialog.tsx`
- Create: `apps/web/src/features/statistics/reports/ReportJobList.tsx`
- Create: `apps/web/src/features/statistics/reports/CarbonSummaryPanel.tsx`
- Create: `apps/web/src/features/operator/emissions/EmissionFactorManagementView.tsx`
- Create: `apps/web/src/features/operator/emissions/EmissionFactorManagementView.test.tsx`
- Modify: `apps/web/src/features/operator/OperatorShell.tsx`
- Modify: `apps/web/src/features/statistics/statistics-sections.ts`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/api/energy.ts`
- Modify: `apps/web/src/api/energy.test.tsx`
- Create: `apps/web/src/api/emission-factors.ts`
- Create: `apps/web/src/api/emission-factors.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `/statistics/reports`, `/operator/emission-factors`.
- Consumes: CSV, report job/download, emissions, factor catalog/assignment API.

- [ ] **Step 1: reports route와 메뉴 실패 테스트를 작성한다.**
  - 서브메뉴는 `개요/사용 분석/보고서`만 노출하고 최적화 link가 없다.
  - direct URL, query/hash 보존, primary 통계 active 상태를 검사한다.
  - viewer와 admin 모두 보고서를 읽고 생성할 수 있으며 다른 site cache가 섞이지 않는다.

- [ ] **Step 2: report 상태 실패 테스트를 작성한다.**
  - queued/processing progress, completed download, failed retry, expired regenerate를 각각 검사한다.
  - polling은 queued/processing일 때만 2초 간격으로 수행하고 완료/실패/만료에서 중지한다.
  - download mutation은 signed URL을 React Query cache에 저장하지 않고 즉시 `window.location.assign`으로 전달한다.
  - CSV 실패와 async report 실패를 서로 독립된 feedback 영역에 표시한다.

- [ ] **Step 3: carbon 상태 실패 테스트를 작성한다.**
  - available, factor unavailable, overuse, partial coverage를 검사한다.
  - factor 값, 단위, 출처, version, 유효기간이 항상 숫자 근처에 보인다.
  - customer 화면에는 factor 편집 버튼이 없다.

- [ ] **Step 4: 고객 reports UI를 구현한다.**
  - 상단 action은 `CSV 내보내기`, `보고서 만들기` 두 개다.
  - create dialog는 기간, scope, PDF/Excel, 포함 section만 제공한다.
  - 포함 section은 사용량·비용, 절감률, 동기간 비교, 순위, heatmap, 탄소, 데이터 품질, 산정 정보이며 낭비/목표/예산은 렌더하지 않는다.
  - 모바일에서는 table을 report card list로 바꾸고 document horizontal overflow를 만들지 않는다.

- [ ] **Step 5: operator factor UI를 구현한다.**
  - `/operator/emission-factors`에 catalog 생성과 site assignment 이력을 제공한다.
  - 승인된 version은 편집하지 않고 `새 버전 등록`만 제공한다.
  - overlap/invalid factor 오류는 field 가까이에 표시하고 mutation 중 중복 제출을 막는다.

- [ ] **Step 6: Web 검증 후 커밋한다.**
  - Run: `pnpm --filter @led-control/web test -- StatisticsReportsPage.test.tsx EmissionFactorManagementView.test.tsx src/api/energy.test.tsx src/api/emission-factors.test.tsx`
  - Run: `pnpm --filter @led-control/web typecheck && pnpm --filter @led-control/web build`
  - Run: `git add apps/web/src && git commit -m "feat(web): add statistics reports and carbon views"`

### Task 11: report expiry, cleanup과 site 삭제

**Files:**
- Create: `apps/api/src/energy/reports/energy-report-cleanup.service.ts`
- Create: `apps/api/src/energy/reports/energy-report-cleanup.service.spec.ts`
- Modify: `apps/api/src/energy/energy.module.ts`
- Modify: `apps/api/src/operator-site-admins/site-deletion-cleanup.service.ts`
- Modify: `apps/api/src/operator-site-admins/site-deletion-cleanup.service.spec.ts`

**Interfaces:**
- Produces: 7일 object expiry, 90일 metadata purge, site delete report cancellation/object cleanup.
- Consumes: report job model, private object storage, 기존 site deletion cleanup.

- [ ] **Step 1: retention 실패 테스트를 작성한다.**
  - `completed.expiresAt <= now` object를 최대 100개 claim해 삭제하고 status를 `expired`로 바꾼다.
  - report별 `1..attemptCount` key를 계산해 완료 object뿐 아니라 lease를 잃은 attempt object도 함께 삭제한다.
  - object 삭제 실패 시 completed metadata와 objectKey를 보존해 다음 sweep에서 재시도한다.
  - expired/failed metadata 중 `createdAt < now-90days`만 최대 1,000개 삭제한다.

- [ ] **Step 2: site deletion race 실패 테스트를 작성한다.**
  - site 삭제 시작 시 queued job은 취소 대상이 되어 claim되지 않는다.
  - live processing lease가 있으면 삭제 cleanup은 lease 만료 또는 bounded cancellation handoff를 기다린다.
  - 모든 report object key를 삭제한 뒤에만 DB site deletion을 완료한다.

- [ ] **Step 3: cleanup worker를 구현한다.**
  - `OnModuleInit/OnModuleDestroy`, non-overlap sweep, bounded batch를 사용한다.
  - 다른 worker와 중복 삭제해도 S3 delete idempotency와 DB CAS로 수렴한다.
  - timer/worker 오류는 process를 종료하지 않고 error code와 job ID만 구조화 log한다.

- [ ] **Step 4: 검증하고 커밋한다.**
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/energy/reports/energy-report-cleanup.service.spec.ts src/operator-site-admins/site-deletion-cleanup.service.spec.ts`
  - Run: `git add apps/api/src/energy/reports apps/api/src/operator-site-admins apps/api/src/energy/energy.module.ts && git commit -m "feat(api): expire reports and clean site artifacts"`

### Task 12: Browser 회귀, 시각 증거, 문서와 배포 게이트

**Files:**
- Modify: `apps/web/e2e/statistics-flow.spec.ts`
- Create: `apps/web/e2e/operator-emission-factors.spec.ts`
- Create: `docs/assets/statistics-analytics/statistics-p2-heatmap-ui.png`
- Create: `docs/assets/statistics-analytics/statistics-p2-reports-ui.png`
- Create: `docs/assets/statistics-analytics/statistics-p2-carbon-ui.png`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-11-statistics-p2-heatmap-reports-carbon.md`

**Interfaces:**
- Consumes: Tasks 1~11.
- Produces: P2 software release evidence and synchronized documentation.

- [ ] **Step 1: 고객 Chromium P2 여정을 작성한다.**
  - 사용 분석에서 floor ranking 선택→heatmap scope 변경→energy/brightness 전환→결측 상세를 확인한다.
  - CSV download의 filename/content type/BOM/metadata를 확인한다.
  - report 생성→processing polling→completed download와 expired regenerate를 확인한다.
  - factor 없음과 available/overuse 탄소 상태를 확인한다.

- [ ] **Step 2: operator Chromium 여정을 작성한다.**
  - factor 새 version 생성, site assignment, overlap 오류, 고객 carbon 활성화를 route fixture로 검증한다.
  - operator 외 사용자의 direct API/route 접근이 막히는지 검증한다.

- [ ] **Step 3: 반응형·접근성 회귀를 작성한다.**
  - 1440×900, 1024×768, 390×844, 320×740에서 document overflow가 없다.
  - heatmap 내부 scroll은 허용하되 선택 상세와 범례는 viewport에 남는다.
  - 통계 서브메뉴 3개는 내부 scroll과 최소 44px 높이를 유지한다.
  - keyboard-only로 heatmap 선택, report dialog, download까지 도달한다.

- [ ] **Step 4: 파일 산출물을 실제로 검사한다.**
  - CSV를 UTF-8/Excel 호환 parser로 다시 읽어 한글과 injection escape를 확인한다.
  - Excel workbook을 다시 load해 sheet 이름, numeric type, metadata를 확인한다.
  - PDF를 page PNG로 render해 한글 glyph, table/heatmap clipping, page break를 확인한다.
  - 생성된 세 화면을 네 viewport에서 캡처해 `docs/assets/statistics-analytics`에 저장한다.

- [ ] **Step 5: 문서를 갱신한다.**
  - `docs/menus/statistics.md`의 구현 완료/미구현/한계/관련 파일을 갱신한다.
  - `docs/database-schema.md`에 report/factor/assignment/retention/site deletion을 기록한다.
  - `docs/project-status.md`에 software 검증 수치, object storage integration 여부, HIL 미실행을 기록한다.
  - 실제 전력계·Raspberry Pi·ESP32-H2 검증은 실행하지 않았다면 완료로 기록하지 않는다.

- [ ] **Step 6: 전체 검증을 실행한다.**
  - Run: `pnpm --filter @led-control/shared test`
  - Run: `pnpm --filter @led-control/api test -- --runInBand`
  - Run: `pnpm --filter @led-control/gateway test`
  - Run: `pnpm --filter @led-control/web test`
  - Run: `pnpm lint && pnpm typecheck`
  - Run: `pnpm --filter @led-control/api build && pnpm --filter @led-control/web build`
  - Run: `pnpm --filter @led-control/web exec playwright test e2e/statistics-flow.spec.ts e2e/operator-emission-factors.spec.ts --project=chromium`
  - Run: `git diff --check`
  - Expected: 모든 software 검증 PASS. 외부 S3 integration을 실행하지 않았다면 이유와 남은 명령을 상태 문서에 기록한다.

- [ ] **Step 7: 최종 커밋한다.**
  - Run: `git add apps/web/e2e docs && git commit -m "test(statistics): verify P2 reports and carbon"`

## Plan Self-Review

- Spec coverage: heatmap은 Tasks 1·3·4, CSV는 Task 6, private storage는 Task 7, durable Excel/PDF는 Tasks 8·9, emissions는 Tasks 2·5·10, retention/site delete는 Task 11, UI/E2E/docs는 Tasks 10·12가 담당한다.
- Scope consistency: `waste`, 운영 시간, 목표, 예산, `/statistics/optimization`은 계약·DB·API·UI·보고서 section에서 모두 제외했다.
- Data consistency: 화면/CSV/Excel/PDF는 동일 `EnergyReportSnapshot`과 `generatedAt`을 사용하며 report worker는 claim 시 snapshot을 고정한다.
- Security: site access가 analytics query보다 먼저 실행되고 report object는 public URL을 만들지 않으며 download마다 5분 signed URL을 발급한다.
- Failure recovery: report job은 DB lease, attempt limit, attempt별 object key, fenced completion으로 process crash와 중복 worker에 수렴한다.
- Accessibility: heatmap은 색상 외 숫자·상태·범례와 keyboard/touch 선택을 제공하고 mobile overflow는 component 내부로 제한한다.
- Documentation: 통계 메뉴, DB schema, project status, 화면 증거가 최종 task에 포함된다.

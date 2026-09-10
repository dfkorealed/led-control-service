# Statistics P2 Heatmap, Reports, and Emissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시간대별 사용 패턴 히트맵, 안전한 CSV·Excel·PDF 보고서, 관리자가 설정한 배출계수 기반 탄소 절감량을 추가하고 `/statistics/reports` 서브페이지를 공개한다.

**Architecture:** P1의 immutable fixture identity·dimension history·hourly aggregate를 분석 원천으로 사용한다. 짧은 CSV는 요청 중 스트리밍하고, Excel/PDF는 DB-backed `EnergyReportJob`과 lease worker가 고정된 request/data snapshot으로 생성해 private object storage에 저장한다. 탄소 환산은 운영자가 관리하는 유효기간형 배출계수와 현장 배정을 별도 bounded context로 두며, 값이 없으면 추정하지 않는다.

**Tech Stack:** TypeScript, Zod, NestJS, Prisma/PostgreSQL, AWS S3 SDK, ExcelJS, PDFKit, `@fontsource/noto-sans-kr`, React 18, React Router 7, TanStack Query 5, Recharts 3, Vitest, Jest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-statistics-analytics-roadmap-design.md`

**UI References:** `docs/assets/statistics-analytics/statistics-analysis-ui.png`, `docs/assets/statistics-analytics/statistics-reports-ui.png`

## Global Constraints

- P0와 P1 계획을 완료하고 해당 migration을 적용한 상태에서 시작한다.
- 모든 에너지·탄소 값은 `상태 기반 추정`임을 화면과 내보내기 파일에 표시한다.
- 히트맵의 결측은 0과 다른 상태로 유지하고 회색/`데이터 없음`으로 표현한다.
- 현장 timezone으로 7×24 cell을 구성하되 DST 실제 경과 초를 사용하며 중복 local hour를 합산한다.
- 배출계수가 없거나 조회 기간 일부를 덮지 못하면 해당 탄소 값은 `null`과 이유 코드로 반환한다.
- CSV는 UTF-8 BOM을 포함하고 `=`, `+`, `-`, `@`, tab, carriage return으로 시작하는 문자열을 apostrophe로 escape한다.
- 보고서 object는 public URL을 만들지 않고 권한 재검사 후 300초짜리 signed GET URL만 발급한다.
- 보고서 생성은 동일 job을 동시에 실행하지 않으며 60초 lease, 20초 heartbeat, 최대 3회 retry를 적용한다.
- 파일은 완료 후 7일, job metadata는 90일 보존한다. 만료·현장 삭제 시 object와 DB 상태를 함께 수렴시킨다.
- PDF의 한글은 package-pinned Noto Sans KR 글꼴을 embed하고 시스템 글꼴이나 외부 CDN에 의존하지 않는다.
- `분석` 서브메뉴에 히트맵을 추가하고 `보고서` 서브메뉴를 공개한다. 숨겨진 route를 직접 입력해도 release flag를 우회하지 못한다.
- P3 제어 모드 기여도는 구현하지 않는다.
- 실제 조명 HIL과 상태 기반 소프트웨어 검증을 같은 증거로 기록하지 않는다.

---

## File Structure

- `packages/shared/src/energy-analytics-contracts.ts`: heatmap, export, report job, emissions strict schema 확장.
- `packages/shared/src/energy-analytics-contracts.test.ts`: P2 계약의 valid/invalid 상태 테스트.
- `apps/api/prisma/schema.prisma`: report job, emission factor catalog/assignment, enum과 relation.
- `apps/api/prisma/migrations/20260910130000_energy_reports_emissions/migration.sql`: P2 저장 구조와 index.
- `apps/api/src/energy/energy-heatmap-query.service.ts`: hourly aggregate를 7×24 local cell로 축약.
- `apps/api/src/energy/energy-csv-export.service.ts`: bounded streaming CSV와 injection escape.
- `apps/api/src/energy/energy-report.service.ts`: job request/status/download와 immutable snapshot.
- `apps/api/src/energy/energy-report-worker.service.ts`: lease claim, heartbeat, retry, expiry cleanup.
- `apps/api/src/energy/energy-report-renderer.service.ts`: XLSX/PDF 생성과 한국어 글꼴 embed.
- `apps/api/src/energy/energy.controller.ts`: heatmap, CSV, emissions, report endpoint.
- `apps/api/src/emissions/emission-factors.controller.ts`: operator 전용 factor CRUD와 site assignment.
- `apps/api/src/emissions/emission-factors.service.ts`: 유효기간·중복 방지와 factor resolution.
- `apps/api/src/emissions/emissions.module.ts`: emissions bounded context.
- `apps/api/src/storage/object-storage.service.ts`: private put와 signed GET.
- `apps/api/src/storage/object-storage.service.spec.ts`: private storage 계약.
- `apps/api/src/operator-site-admins/operator-site-admins.service.ts`: site deletion cleanup에 report object key capture.
- `apps/api/src/operator-site-admins/site-deletion-cleanup.service.ts`: report object 삭제 수렴 검증.
- `apps/api/src/app.module.ts`, `apps/api/src/energy/energy.module.ts`: module/provider wiring.
- `apps/api/package.json`, `pnpm-lock.yaml`: ExcelJS, PDFKit, font package.
- `apps/web/src/api/client.ts`: blob download helper.
- `apps/web/src/api/energy.ts`: P2 query/mutation/download boundary.
- `apps/web/src/features/statistics/analysis/EnergyHeatmap.tsx`: metric switch, 7×24 grid, 접근 가능한 표.
- `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.tsx`: 히트맵 section.
- `apps/web/src/features/statistics/reports/StatisticsReportsPage.tsx`: report request/history/download와 emissions summary.
- `apps/web/src/features/statistics/statistics-sections.ts`: reports release metadata.
- `apps/web/src/styles.css`: heatmap/reports responsive layout.
- `apps/web/e2e/statistics-flow.spec.ts`: P2 route, keyboard, downloads, 네 viewport.
- `docs/database-schema.md`, `docs/menus/statistics.md`, `docs/project-status.md`: schema·기능·한계 기록.

### Task 1: Shared P2 계약

**Files:**
- Modify: `packages/shared/src/energy-analytics-contracts.ts`
- Modify: `packages/shared/src/energy-analytics-contracts.test.ts`

**Interfaces:**
- Consumes: P0 `EnergyDataStatus`, P1 `EnergyAnalyticsFilter`와 `EnergyScope`.
- Produces: `EnergyHeatmapResponse`, `EnergyReportJobResponse`, `EnergyEmissionSummaryResponse`와 request schema.

- [ ] **Step 1: missing cell, unsafe format, incomplete factor 실패 테스트를 작성한다.**

```ts
expect(() => energyHeatmapResponseSchema.parse({
  ...validHeatmap,
  cells: [{ weekday: 7, hour: 24, value: 0, dataStatus: "available" }]
})).toThrow();
expect(() => energyReportRequestSchema.parse({ format: "docx", preset: "current_month" })).toThrow();
expect(energyEmissionSummaryResponseSchema.parse({
  ...validEmission,
  factor: null,
  estimatedKgCo2e: null,
  unavailableReason: "factor_not_configured"
}).unavailableReason).toBe("factor_not_configured");
```

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/shared test -- energy-analytics-contracts.test.ts`
  - Expected: FAIL because P2 schemas are not exported.

- [ ] **Step 3: strict schema와 discriminated 상태를 구현한다.**

```ts
export const energyHeatmapMetricSchema = z.enum(["energy", "brightness", "waste"]);
export const energyReportFormatSchema = z.enum(["xlsx", "pdf"]);
export const energyReportStatusSchema = z.enum(["queued", "processing", "completed", "failed", "expired"]);
export const emissionUnavailableReasonSchema = z.enum([
  "factor_not_configured",
  "factor_period_incomplete",
  "energy_unavailable"
]);
```

  - heatmap cell은 `weekday=0..6`, `hour=0..23`, `sampleSeconds`, `expectedSeconds`, nullable value를 가진다.
  - report response는 status별로 `downloadReady`, `failureCode`, `expiresAt` 조합을 `superRefine`한다.
  - emissions 응답은 factor snapshot이 있을 때만 kgCO2e 값과 outcome을 허용한다.

- [ ] **Step 4: shared 계약을 검증한다.**
  - Run: `pnpm --filter @led-control/shared test -- energy-analytics-contracts.test.ts && pnpm --filter @led-control/shared typecheck`
  - Expected: PASS.

- [ ] **Step 5: 커밋한다.**
  - Run: `git add packages/shared/src/energy-analytics-contracts.ts packages/shared/src/energy-analytics-contracts.test.ts && git commit -m "feat(shared): add P2 energy analytics contracts"`

### Task 2: 보고서와 배출계수 DB 모델

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260910130000_energy_reports_emissions/migration.sql`
- Modify: `apps/api/test/domain-schema.test.ts`
- Modify: `docs/database-schema.md`

**Interfaces:**
- Produces: `EnergyReportJob`, `EmissionFactorCatalog`, `SiteEmissionFactorAssignment` Prisma clients.
- Constraint: assignment 기간은 `[effectiveFrom, effectiveTo)`이고 동일 site에서 겹칠 수 없다.

- [ ] **Step 1: schema 구조와 cascade 정책의 실패 테스트를 작성한다.**

```ts
expect(schema).toContain("model EnergyReportJob");
expect(schema).toContain("site Site @relation(fields: [siteId], references: [id], onDelete: Cascade)");
expect(schema).toContain("model SiteEmissionFactorAssignment");
expect(migration).toContain("energy_report_jobs_claim_idx");
```

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- test/domain-schema.test.ts --runInBand`
  - Expected: FAIL because the three models do not exist.

- [ ] **Step 3: enum과 모델을 추가한다.**

```prisma
enum EnergyReportStatus { queued processing completed failed expired }
enum EnergyReportFormat { xlsx pdf }

model EnergyReportJob {
  id              String             @id @default(uuid())
  siteId          String
  requestedByUserId String?
  clientRequestId String
  requestHash     String
  format          EnergyReportFormat
  status          EnergyReportStatus @default(queued)
  progressPercent Int                @default(0)
  requestSnapshot Json
  dataSnapshot    Json?
  objectKey       String?
  contentSha256   String?
  sizeBytes       Int?
  attemptCount    Int                @default(0)
  availableAt     DateTime           @default(now())
  leaseOwner      String?
  leaseExpiresAt  DateTime?
  startedAt       DateTime?
  completedAt     DateTime?
  expiresAt       DateTime?
  errorCode       String?
  site            Site               @relation(fields: [siteId], references: [id], onDelete: Cascade)
  requestedBy     User?              @relation(fields: [requestedByUserId], references: [id], onDelete: SetNull)
  createdAt       DateTime           @default(now())
  updatedAt       DateTime           @updatedAt
  @@index([status, availableAt, leaseExpiresAt], map: "energy_report_jobs_claim_idx")
  @@index([siteId, createdAt])
  @@index([expiresAt])
  @@unique([siteId, requestedByUserId, clientRequestId])
}
```

  - catalog에는 `name`, `regionCode`, `kgCo2ePerKwh Decimal(12,6)`, `sourceName`, `sourceUrl`, `validFrom`, `validTo`, `createdById`를 둔다.
  - assignment에는 `siteId`, `factorId`, `effectiveFrom`, `effectiveTo`, `createdById`와 `@@unique([siteId, effectiveFrom])`를 둔다.
  - `Site`에는 report job/assignment back relation, `User`에는 requested report와 created factor/assignment의 named back relation을 추가한다.
  - migration에는 `effectiveTo IS NULL OR effectiveTo > effectiveFrom`, factor 양수 check와 필요한 index를 명시한다.
  - `btree_gist`와 `daterange(effectiveFrom, COALESCE(effectiveTo, 'infinity'), '[)')` exclusion constraint로 같은 site의 assignment overlap을 DB에서도 거부한다.
  - queued/processing 중 같은 `(siteId, requestedByUserId, requestHash)`를 막는 partial unique index를 migration에 추가한다.
  - service transaction도 Site advisory lock 후 겹침을 먼저 검사해 사용자에게 안정적인 409를 반환하고 DB constraint는 경합의 최종 방어선으로 둔다.

- [ ] **Step 4: migration 정적 계약과 Prisma generate를 검증한다.**
  - Run: `pnpm --filter @led-control/api test -- test/domain-schema.test.ts --runInBand && pnpm --filter @led-control/api prisma:generate && pnpm --filter @led-control/api typecheck`
  - Expected: PASS.

- [ ] **Step 5: DB 문서를 같은 커밋에서 갱신한다.**
  - `docs/database-schema.md`에 세 모델, 삭제 정책, retention, 기간 겹침 검사 주체를 기록한다.
  - Run: `git diff --check`
  - Expected: no output.

- [ ] **Step 6: 커밋한다.**
  - Run: `git add apps/api/prisma apps/api/test/domain-schema.test.ts docs/database-schema.md && git commit -m "feat(api): add energy report and emission schemas"`

### Task 3: 7×24 히트맵 API

**Files:**
- Create: `apps/api/src/energy/energy-heatmap-query.service.ts`
- Create: `apps/api/src/energy/energy-heatmap-query.service.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.module.ts`
- Modify: `apps/api/src/energy/energy.controller.spec.ts`

**Interfaces:**
- Endpoint: `GET /energy/sites/:siteId/heatmap?from=YYYY-MM-DD&to=YYYY-MM-DD&metric=energy&floorId=&groupId=`.
- Limits: default previous 28 completed local dates, inclusive range maximum 92 dates.

- [ ] **Step 1: DST, 결측, waste metric 실패 테스트를 작성한다.**

```ts
expect(result.cells).toHaveLength(168);
expect(cell(result, 0, 2)).toMatchObject({ value: null, dataStatus: "no_data" });
expect(fallBackRepeatedHour.sampleSeconds).toBe(7200);
expect(wasteCell.value).toBeCloseTo(1.25);
```

  - fixture별 identity/dimension history를 조회 시점에 적용하는 case도 포함한다.
  - `from > to`, 93일, 잘못된 floor/group scope가 각각 400/404인지 controller test로 고정한다.

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- energy-heatmap-query.service.spec.ts energy.controller.spec.ts --runInBand`
  - Expected: FAIL because heatmap service/route do not exist.

- [ ] **Step 3: local hour aggregation을 구현한다.**

```ts
type HeatmapAccumulator = {
  estimatedKwh: Decimal;
  wasteKwh: Decimal;
  brightnessSeconds: bigint;
  sampleSeconds: number;
  expectedSeconds: number;
};
```

  - UTC hourly row의 `localWeekday`, `localHour`, `utcOffsetMinutes`, 실제 `bucketSeconds`를 사용한다.
  - average brightness는 `brightnessSeconds / sampleSeconds`, waste는 P1 operating-hours snapshot 밖의 `estimatedKwh`만 합산한다.
  - 168개 cell을 항상 반환하되 sample이 없으면 value null, 일부만 있으면 partial로 둔다.
  - response에 timezone, range, metric, generatedAt, scope, legend min/max와 source를 포함한다.

- [ ] **Step 4: controller 권한과 strict response parse를 연결한다.**
  - 기존 site read 권한을 사용하고 query를 shared schema로 parse한다.
  - Run: `pnpm --filter @led-control/api test -- energy-heatmap-query.service.spec.ts energy.controller.spec.ts --runInBand && pnpm --filter @led-control/api typecheck`
  - Expected: PASS.

- [ ] **Step 5: 커밋한다.**
  - Run: `git add apps/api/src/energy && git commit -m "feat(api): add hourly energy heatmap"`

### Task 4: 안전한 CSV 스트리밍 내보내기

**Files:**
- Create: `apps/api/src/energy/energy-csv-export.service.ts`
- Create: `apps/api/src/energy/energy-csv-export.service.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.controller.spec.ts`

**Interfaces:**
- Endpoint: `GET /energy/sites/:siteId/exports/csv?from=&to=&floorId=&groupId=`.
- Output: `text/csv; charset=utf-8`, attachment filename, UTF-8 BOM, 최대 366일.

- [ ] **Step 1: BOM, quote, formula injection, bounded range 실패 테스트를 작성한다.**

```ts
expect(csv.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
expect(csv.toString("utf8")).toContain("'=@SUM(A1:A2)");
expect(csv.toString("utf8")).toContain('"A동, 1층"');
await expect(exporter.createRows(rangeOf367Days)).rejects.toMatchObject({ status: 400 });
```

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- energy-csv-export.service.spec.ts energy.controller.spec.ts --runInBand`
  - Expected: FAIL because exporter/route do not exist.

- [ ] **Step 3: async generator 기반 CSV를 구현한다.**

```ts
export function escapeCsvCell(value: string | number | null): string {
  if (value === null) return "";
  const raw = String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
```

  - stable `(localDate, energyFixtureId)` keyset pagination으로 1,000행씩 읽는다.
  - 열은 날짜, 층, 그룹, 조명, rated watt, 추정 kWh, 추정 비용, known/unknown seconds, data status, source 순서로 고정한다.
  - 첫 두 comment row에 `상태 기반 추정`, timezone/generatedAt를 기록하고 tariff 미설정 비용은 빈 셀로 둔다.

- [ ] **Step 4: streaming response와 권한을 검증한다.**
  - client disconnect 시 generator/stream을 종료하고 추가 DB page를 조회하지 않는다.
  - Run: `pnpm --filter @led-control/api test -- energy-csv-export.service.spec.ts energy.controller.spec.ts --runInBand && pnpm --filter @led-control/api typecheck`
  - Expected: PASS.

- [ ] **Step 5: 커밋한다.**
  - Run: `git add apps/api/src/energy && git commit -m "feat(api): stream safe energy CSV exports"`

### Task 5: 비공개 보고서 저장소와 job API

**Files:**
- Modify: `apps/api/src/storage/object-storage.service.ts`
- Modify: `apps/api/src/storage/object-storage.service.spec.ts`
- Create: `apps/api/src/energy/energy-report.service.ts`
- Create: `apps/api/src/energy/energy-report.service.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.controller.spec.ts`
- Modify: `apps/api/src/energy/energy.module.ts`

**Interfaces:**
- Storage: `putPrivateObject`, `createDownloadUrl`.
- Endpoints: `POST /energy/sites/:siteId/reports`, `GET /energy/sites/:siteId/reports`, `GET /energy/sites/:siteId/reports/:reportId`, `POST /energy/sites/:siteId/reports/:reportId/download`.

- [ ] **Step 1: public URL 부재와 cross-site 다운로드 거부 실패 테스트를 작성한다.**

```ts
expect(await storage.putPrivateObject(input)).toEqual({ objectKey: input.objectKey });
expect(s3.send).toHaveBeenCalledWith(expect.objectContaining({ input: expect.not.objectContaining({ ACL: "public-read" }) }));
await expect(service.createDownload(siteAUser, siteB, reportId)).rejects.toMatchObject({ status: 404 });
```

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- object-storage.service.spec.ts energy-report.service.spec.ts energy.controller.spec.ts --runInBand`
  - Expected: FAIL because private report methods/routes do not exist.

- [ ] **Step 3: private put와 signed GET을 구현한다.**

```ts
async putPrivateObject(input: { objectKey: string; body: Buffer; contentType: string; sha256: string })
async createDownloadUrl(objectKey: string): Promise<{ downloadUrl: string; expiresInSeconds: 300 }>
```

  - `PutObjectCommand`에 content length/type/checksum만 설정하고 public base URL을 반환하지 않는다.
  - `GetObjectCommand`를 300초 presign하며 test injection용 `presignDownload` option을 둔다.

- [ ] **Step 4: job create/list/status/download를 구현한다.**
  - create는 shared request를 parse하고 authorized site/timezone/filter와 `requestedAt`을 `requestSnapshot`에 고정한다.
  - list는 최근 50개 bounded 목록, status는 object key/signed URL을 노출하지 않는다.
  - download는 site 권한과 `completed`, 미만료, object metadata를 재검사한 뒤 signed URL을 발급한다.
  - Task 2에서 생성한 `(siteId, requestedByUserId, clientRequestId)` unique key로 같은 payload만 재사용하며 충돌은 409로 응답한다.
  - canonical request snapshot SHA-256을 `requestHash`로 저장하고 같은 site·사용자의 queued/processing partial unique 충돌이면 기존 job을 반환한다.

- [ ] **Step 5: job API와 storage를 검증한다.**
  - Run: `pnpm --filter @led-control/api test -- object-storage.service.spec.ts energy-report.service.spec.ts energy.controller.spec.ts --runInBand && pnpm --filter @led-control/api typecheck`
  - Expected: PASS.

- [ ] **Step 6: 커밋한다.**
  - Run: `git add apps/api/src/storage apps/api/src/energy && git commit -m "feat(api): add private energy report jobs"`

### Task 6: Durable Excel/PDF report worker

**Files:**
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/api/src/energy/energy-report-renderer.service.ts`
- Create: `apps/api/src/energy/energy-report-renderer.service.spec.ts`
- Create: `apps/api/src/energy/energy-report-worker.service.ts`
- Create: `apps/api/src/energy/energy-report-worker.service.spec.ts`
- Modify: `apps/api/src/energy/energy.module.ts`

**Interfaces:**
- Job state: `queued → processing → completed | queued(retry) | failed`, then `expired`.
- Object key: `energy-reports/{siteId}/{jobId}.{xlsx|pdf}`.

- [ ] **Step 1: 의존성을 추가하고 lockfile을 갱신한다.**
  - Run: `pnpm --filter @led-control/api add exceljs pdfkit @fontsource/noto-sans-kr && pnpm --filter @led-control/api add -D @types/pdfkit`
  - Expected: manifest and lockfile contain pinned workspace-resolved dependencies.

- [ ] **Step 2: renderer의 한글·수치·결측 실패 테스트를 작성한다.**

```ts
expect(await inspectWorkbook(xlsx)).toMatchObject({
  sheets: ["요약", "일별 사용량", "조명별 사용량"],
  disclaimer: "상태 기반 추정"
});
expect(await extractPdfText(pdf)).toContain("에너지 사용 통계 보고서");
expect(await extractPdfText(pdf)).toContain("데이터 없음");
```

  - XLSX formula cell을 만들지 않고 값만 기록하는 test를 포함한다.
  - PDF 생성 시 `require.resolve("@fontsource/noto-sans-kr/files/noto-sans-kr-korean-400-normal.woff2")` buffer를 register하는 test를 고정한다.

- [ ] **Step 3: renderer 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- energy-report-renderer.service.spec.ts --runInBand`
  - Expected: FAIL because renderer does not exist.

- [ ] **Step 4: 동일 snapshot을 사용하는 XLSX/PDF renderer를 구현한다.**

```ts
type EnergyReportDataSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  site: { id: string; name: string; timeZone: string };
  request: EnergyReportRequest;
  summary: EnergyComparisonResponse;
  ranking: EnergyRankingResponse;
  heatmap: EnergyHeatmapResponse;
  emissions: EnergyEmissionSummaryResponse;
};
```

  - XLSX는 요약/일별/조명별 sheet, 고정 header, auto filter, frozen row, unit/nullable cell format을 적용한다.
  - PDF는 제목, 기간/scope, KPI, 기준-실제 그래프, ranking, heatmap legend, factor source와 disclaimer를 순서대로 렌더한다.
  - PDF/XLSX 모두 snapshot의 generatedAt/timezone을 사용하고 실행 시점 데이터를 재조회하지 않는다.

- [ ] **Step 5: worker lease/retry 실패 테스트를 작성한다.**
  - 두 worker 동시 claim에서 하나만 renderer를 호출한다.
  - heartbeat가 lease를 연장하며 stale worker completion은 fence 조건으로 update 0건이 된다.
  - 1·2회 실패는 30초/120초 뒤 queued, 3회 실패는 stable failure code와 failed가 된다.
  - object upload 성공 후 DB completion 실패 시 동일 object key overwrite로 재시도하고 중복 object를 만들지 않는다.

- [ ] **Step 6: atomic claim과 worker를 구현한다.**

```sql
WITH candidate AS (
  SELECT id FROM "EnergyReportJob"
  WHERE status IN ('queued','processing')
    AND "availableAt" <= NOW()
    AND (status = 'queued' OR "leaseExpiresAt" <= NOW())
  ORDER BY "createdAt"
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE "EnergyReportJob" job
SET status = 'processing', "attemptCount" = "attemptCount" + 1,
    "leaseOwner" = :worker_id,
    "startedAt" = COALESCE("startedAt", NOW()),
    "leaseExpiresAt" = NOW() + INTERVAL '60 seconds'
FROM candidate WHERE job.id = candidate.id
RETURNING job.*;
```

  - worker poll은 2초이며 timer `unref`, shutdown 시 새 claim을 중지하고 진행 중 heartbeat를 해제한다.
  - snapshot 생성은 repeatable-read transaction에서 한 번 수행하고 `dataSnapshot`에 저장한 뒤 renderer에 넘긴다.
  - completion update에는 job id, processing status, 현재 `leaseOwner`를 포함하는 fencing 조건을 적용한다.

- [ ] **Step 7: renderer와 worker를 검증한다.**
  - Run: `pnpm --filter @led-control/api test -- energy-report-renderer.service.spec.ts energy-report-worker.service.spec.ts --runInBand && pnpm --filter @led-control/api typecheck`
  - Expected: PASS; extracted PDF contains Korean text and concurrent test renders once.

- [ ] **Step 8: 커밋한다.**
  - Run: `git add apps/api/package.json pnpm-lock.yaml apps/api/src/energy && git commit -m "feat(api): generate durable energy reports"`

### Task 7: 배출계수 관리와 탄소 절감 API

**Files:**
- Create: `apps/api/src/emissions/emission-factors.controller.ts`
- Create: `apps/api/src/emissions/emission-factors.controller.spec.ts`
- Create: `apps/api/src/emissions/emission-factors.service.ts`
- Create: `apps/api/src/emissions/emission-factors.service.spec.ts`
- Create: `apps/api/src/emissions/emissions.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/energy/energy-analytics-query.service.ts`
- Modify: `apps/api/src/energy/energy-analytics-query.service.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.module.ts`

**Interfaces:**
- Operator endpoints: `GET|POST /operator/emission-factors`, `PUT /operator/emission-factors/:factorId`, `GET|PUT /operator/sites/:siteId/emission-factor`.
- Customer endpoint: `GET /energy/sites/:siteId/emissions?from=&to=&floorId=&groupId=`.

- [ ] **Step 1: 권한, 기간 중첩, factor 누락 실패 테스트를 작성한다.**

```ts
await expect(controller.createFactor(adminUser, validBody)).rejects.toMatchObject({ status: 403 });
await expect(service.assign(siteId, overlappingPeriod)).rejects.toMatchObject({ status: 409 });
expect(await analytics.emissions(siteId, uncoveredRange)).toMatchObject({
  estimatedKgCo2e: null,
  unavailableReason: "factor_period_incomplete"
});
```

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- emission-factors.service.spec.ts emission-factors.controller.spec.ts energy-analytics-query.service.spec.ts --runInBand`
  - Expected: FAIL because emissions module/API do not exist.

- [ ] **Step 3: operator-only catalog와 assignment를 구현한다.**
  - factor는 이름/지역/수치/출처 URL/유효기간을 strict validate하며 사용 이력이 있는 값을 파괴적으로 수정하지 않고 새 factor version을 만든다.
  - assignment transaction은 site advisory lock 후 기존 기간과 `[from,to)` overlap을 검사한다.
  - 실제 공공 배출계수를 임의 seed하지 않는다. 운영자 설정 전까지 명시적으로 unavailable이다.

- [ ] **Step 4: energy와 savings를 factor 구간별로 환산한다.**

```ts
estimatedKgCo2e = sum(estimatedKwhForFactorWindow * kgCo2ePerKwh);
baselineKgCo2e = sum(baselineKwhForFactorWindow * kgCo2ePerKwh);
savingsKgCo2e = baselineKgCo2e - estimatedKgCo2e;
```

  - 여러 factor version을 걸치는 범위는 날짜별로 올바른 factor를 적용하고 response에 사용한 factor snapshot 배열을 제공한다.
  - 범위 중 하루라도 미배정이면 부분 탄소 합계를 보여주지 않고 null과 incomplete reason을 반환한다.
  - 음수 savings는 `overuse`로 유지한다.

- [ ] **Step 5: emissions 전체 경계를 검증한다.**
  - Run: `pnpm --filter @led-control/api test -- emission-factors.service.spec.ts emission-factors.controller.spec.ts energy-analytics-query.service.spec.ts energy.controller.spec.ts --runInBand && pnpm --filter @led-control/api typecheck`
  - Expected: PASS.

- [ ] **Step 6: 커밋한다.**
  - Run: `git add apps/api/src/emissions apps/api/src/app.module.ts apps/api/src/energy && git commit -m "feat(api): add configured carbon savings analytics"`

### Task 8: Web 히트맵

**Files:**
- Modify: `apps/web/src/api/energy.ts`
- Create: `apps/web/src/features/statistics/analysis/EnergyHeatmap.tsx`
- Create: `apps/web/src/features/statistics/analysis/EnergyHeatmap.test.tsx`
- Modify: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.tsx`
- Modify: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Query key: `energyHeatmapKey(siteId, filter, range, metric)`.
- UI: 에너지/평균 밝기/운영 외 낭비 metric, weekday rows, hour columns.

- [ ] **Step 1: 결측 cell과 키보드 탐색 실패 테스트를 작성한다.**

```tsx
expect(screen.getByRole("gridcell", { name: /월요일 02시 데이터 없음/ })).toHaveAttribute("data-status", "no_data");
await user.keyboard("{ArrowRight}");
expect(screen.getByRole("gridcell", { name: /월요일 03시/ })).toHaveFocus();
expect(screen.getByText("상태 기반 추정")).toBeVisible();
```

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/web test -- EnergyHeatmap.test.tsx StatisticsAnalysisPage.test.tsx`
  - Expected: FAIL because heatmap component/query do not exist.

- [ ] **Step 3: strict query hook과 heatmap presenter를 구현한다.**
  - API 응답은 shared schema로 parse하고 invalid response를 generic empty state로 숨기지 않는다.
  - roving tabindex와 arrow keys, focus tooltip, accessible table/grid labels를 제공한다.
  - 색만으로 상태를 구분하지 않고 숫자/`—`/pattern과 legend를 함께 사용한다.
  - 모바일은 heatmap 자체만 `overflow-x:auto`; 문서 전체와 통계 shell은 overflow하지 않는다.

- [ ] **Step 4: 분석 페이지에 section을 연결하고 반응형 테스트를 통과시킨다.**
  - Run: `pnpm --filter @led-control/web test -- EnergyHeatmap.test.tsx StatisticsAnalysisPage.test.tsx && pnpm --filter @led-control/web typecheck`
  - Expected: PASS.

- [ ] **Step 5: 커밋한다.**
  - Run: `git add apps/web/src/api/energy.ts apps/web/src/features/statistics apps/web/src/styles.css && git commit -m "feat(web): add energy usage heatmap"`

### Task 9: Web 보고서·탄소 페이지

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/energy.ts`
- Create: `apps/web/src/features/statistics/reports/StatisticsReportsPage.tsx`
- Create: `apps/web/src/features/statistics/reports/StatisticsReportsPage.test.tsx`
- Modify: `apps/web/src/features/statistics/statistics-sections.ts`
- Modify: `apps/web/src/features/statistics/StatisticsShell.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Client: `apiDownload(path, init): Promise<{ blob: Blob; filename: string }>`.
- Polling: processing job 5초, background tab 30초, terminal state에서 중지.

- [ ] **Step 1: route 공개, CSV 다운로드, job polling, factor unavailable 실패 테스트를 작성한다.**

```tsx
expect(screen.getByRole("link", { name: "보고서" })).toHaveAttribute("href", "/statistics/reports?siteId=site-1");
expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
expect(screen.getByText("배출계수 설정이 필요합니다")).toBeVisible();
expect(reportStatusQuery.refetchInterval(terminalJob)).toBe(false);
```

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/web test -- StatisticsReportsPage.test.tsx StatisticsShell.test.tsx`
  - Expected: FAIL because reports route/page/download client do not exist.

- [ ] **Step 3: safe blob download와 report mutations를 구현한다.**

```ts
export async function apiDownload(path: string, init?: RequestInit) {
  const response = await authenticatedFetch(path, init);
  if (!response.ok) throw await toApiError(response);
  return {
    blob: await response.blob(),
    filename: parseAttachmentFilename(response.headers.get("content-disposition"))
  };
}
```

  - filename은 RFC 5987 `filename*`와 quoted filename을 bounded sanitize하고 경로 구분자를 제거한다.
  - CSV는 직접 blob download, XLSX/PDF는 job create 후 status 목록에서 완료될 때 다운로드한다.
  - clientRequestId는 mutation 1회마다 생성하고 network retry에서 그대로 재사용한다.

- [ ] **Step 4: reports UI와 carbon summary를 구현한다.**
  - 기간/scope/format form, 생성 중/완료/실패/만료 상태, 재시도 action, 최근 보고서 50개를 표시한다.
  - 탄소 카드는 추정 배출량, 기준 배출량, 절감/초과량, factor source/effective range를 표시한다.
  - factor가 없으면 운영자 설정 필요 안내만 표시하고 0 kg으로 보이지 않게 한다.
  - `statisticsSections`의 reports release를 P2로 전환하고 route guard도 같은 release selector를 사용한다.

- [ ] **Step 5: Web 경계를 검증한다.**
  - Run: `pnpm --filter @led-control/web test -- StatisticsReportsPage.test.tsx StatisticsShell.test.tsx && pnpm --filter @led-control/web typecheck`
  - Expected: PASS.

- [ ] **Step 6: 커밋한다.**
  - Run: `git add apps/web/src/api apps/web/src/features/statistics apps/web/src/features/shells/CustomerShell.tsx apps/web/src/styles.css && git commit -m "feat(web): add energy reports and carbon insights"`

### Task 10: Retention, site deletion, E2E, 문서 수렴

**Files:**
- Modify: `apps/api/src/energy/energy-report-worker.service.ts`
- Modify: `apps/api/src/energy/energy-report-worker.service.spec.ts`
- Modify: `apps/api/src/operator-site-admins/operator-site-admins.service.ts`
- Modify: `apps/api/src/operator-site-admins/operator-site-admins.service.spec.ts`
- Modify: `apps/api/src/operator-site-admins/site-deletion-cleanup.service.ts`
- Modify: `apps/api/src/operator-site-admins/site-deletion-cleanup.service.spec.ts`
- Modify: `apps/web/e2e/statistics-flow.spec.ts`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/project-status.md`

**Interfaces:**
- Retention: completed file 7일, terminal metadata 90일.
- Site deletion: report object key를 site row 삭제 전 `SiteDeletionCleanup.objectKeys`에 합친다.

- [ ] **Step 1: expiry와 site deletion 실패 테스트를 작성한다.**
  - 7일 경과 file은 object delete 성공 후 expired가 되며 download가 410을 반환한다.
  - object delete 실패는 다음 retry로 남고 DB가 먼저 expired/completed cleanup으로 거짓 표시되지 않는다.
  - site 삭제 cleanup payload에 floor asset과 report object key가 모두 포함되고 중복 제거된다.
  - 90일 terminal metadata 삭제는 object가 이미 삭제/expired인 row만 대상으로 한다.

- [ ] **Step 2: 실패를 확인한다.**
  - Run: `pnpm --filter @led-control/api test -- energy-report-worker.service.spec.ts operator-site-admins.service.spec.ts site-deletion-cleanup.service.spec.ts --runInBand`
  - Expected: FAIL because report retention/deletion capture is not wired.

- [ ] **Step 3: retention과 deletion convergence를 구현한다.**
  - expiry worker는 최대 100개씩 claim하고 object 삭제 성공/NotFound 뒤에만 `expired`, objectKey null을 저장한다.
  - site 삭제 transaction은 report keys를 기존 cleanup objectKeys에 합친 뒤 Site를 삭제한다.
  - cleanup의 기존 upload URL safety window를 유지하고 report signed GET 최대 300초도 같은 safety window 안에 포함됨을 test로 고정한다.

- [ ] **Step 4: 실제 API fixture로 브라우저 회귀를 작성한다.**
  - `/statistics/analysis`에서 168개 heatmap cell과 metric 전환을 검증한다.
  - `/statistics/reports`에서 CSV content-disposition/BOM, PDF/XLSX job 완료와 download URL 요청을 검증한다.
  - factor 미설정/설정됨, missing cell, failed/expired report 상태를 검증한다.
  - 1440/1024/390/320에서 상단 정렬, submenu, inner heatmap scroll, document overflow 부재를 검증한다.

- [ ] **Step 5: 메뉴 문서와 상태판을 실제 증거에 맞춰 갱신한다.**
  - `docs/menus/statistics.md`의 `구현 완료`, `미구현`, `부족하거나 개선이 필요한 기능`, `관련 파일`, `갱신 규칙` 구성을 유지한다.
  - P0/P1/P2 구현과 mock/HIL 한계, P3 보류, 배출계수 운영자 설정 필요를 기록한다.
  - `docs/project-status.md`에서 세 계획 체크리스트 완료와 검증 수치를 일치시킨다.

- [ ] **Step 6: focused와 전체 검증을 실행한다.**
  - Run: `pnpm --filter @led-control/shared test && pnpm --filter @led-control/api test -- --runInBand && pnpm --filter @led-control/web test`
  - Expected: all suites PASS; environment-gated skips are listed separately.
  - Run: `pnpm --filter @led-control/shared typecheck && pnpm --filter @led-control/api typecheck && pnpm --filter @led-control/web typecheck && pnpm --filter @led-control/api build && pnpm --filter @led-control/web build`
  - Expected: PASS; existing bundle warning, if unchanged, is documented rather than treated as new success.
  - Run: `pnpm --filter @led-control/web exec playwright test e2e/statistics-flow.spec.ts --workers=1`
  - Expected: P0/P1/P2 statistics scenarios PASS at four viewports.
  - Run: `git diff --check && rg -n "TODO|FIXME|placeholder|coming soon" packages/shared/src/energy-analytics-contracts.ts apps/api/src/energy apps/api/src/emissions apps/web/src/features/statistics docs/menus/statistics.md`
  - Expected: diff check has no output; placeholder scan has no unintended production placeholders.

- [ ] **Step 7: 최종 독립 코드 검토를 요청하고 지적을 수정한다.**
  - Verify authorization, cross-site isolation, report lease fencing, formula injection, DST, factor gaps, keyboard access, object retention.
  - Re-run every affected focused test after fixes.

- [ ] **Step 8: 최종 커밋한다.**
  - Run: `git add apps/api/src/energy apps/api/src/operator-site-admins apps/web/e2e/statistics-flow.spec.ts docs/menus/statistics.md docs/project-status.md && git commit -m "test(statistics): verify P2 analytics and reports"`

---

## Final Acceptance Checklist

- [ ] 7×24 heatmap은 결측과 실제 0을 구분하고 DST 실제 초를 반영한다.
- [ ] CSV는 BOM, RFC-compatible quoting, formula injection 방어와 366일 제한을 지킨다.
- [ ] XLSX/PDF job은 concurrent worker에서 한 번만 claim되고 stale worker가 완료를 덮어쓰지 못한다.
- [ ] PDF 한글이 외부 네트워크나 시스템 글꼴 없이 추출·표시된다.
- [ ] report object는 public URL이 없고 권한 재검사 뒤 300초 signed URL로만 내려받는다.
- [ ] 배출계수 미설정/기간 공백은 0이 아니라 unavailable로 나타난다.
- [ ] 여러 배출계수 유효기간에 걸친 계산은 구간별 factor snapshot을 사용한다.
- [ ] 7일 file, 90일 metadata retention과 site deletion cleanup이 object leak 없이 수렴한다.
- [ ] 분석/보고서 서브메뉴와 직접 URL guard가 같은 release metadata를 사용한다.
- [ ] 1440/1024/390/320에서 상단 정렬과 문서 overflow 부재를 유지한다.
- [ ] `docs/database-schema.md`, `docs/menus/statistics.md`, `docs/project-status.md`가 실제 구현·검증 상태와 일치한다.
- [ ] P3 제어 모드 기여도는 노출·route·API 어디에도 추가되지 않는다.

## Plan Self-Review

- Spec coverage: 히트맵은 Tasks 1·3·8, CSV는 Tasks 1·4·9, durable XLSX/PDF는 Tasks 2·5·6·9, 탄소 환산은 Tasks 2·7·9가 담당한다.
- Security: site read 권한, operator-only factor mutation, cross-site 404, private object와 download 재인가를 API 경계에 각각 둔다.
- Failure recovery: report lease fencing, bounded retry, idempotent object key, 7일 expiry와 site deletion cleanup을 Tasks 5·6·10에서 검증한다.
- Type consistency: Shared Task 1의 heatmap/report/emissions schema를 API와 Web의 모든 외부 경계에서 parse한다.
- Data integrity: factor 기간 공백, heatmap 결측, report snapshot을 0이나 최신 데이터 재조회로 대체하지 않는다.
- Release navigation: P2에서 `보고서`를 공개하고 기존 `분석`에 히트맵만 추가하며 P3 route는 만들지 않는다.

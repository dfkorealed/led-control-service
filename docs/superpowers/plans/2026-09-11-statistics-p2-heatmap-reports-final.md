# 통계 P2 히트맵·동일내용 보고서 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development. Implement only the assigned task, commit it, and write the requested report.

**Goal:** P2-C 없이 요일×시간대 히트맵과 CSV/XLSX/PDF 보고서를 제공하며, XLSX/PDF는 하나의 immutable document model에서 동일한 사용자 정보만 렌더링한다.

**Spec:** `docs/superpowers/specs/2026-09-11-statistics-p2-heatmap-reports-final-design.md`

## Global Constraints

- P2-C, 탄소, 배출계수, 최적화, 운영시간, 낭비, 목표·예산을 구현하지 않는다.
- 보고서 파일에는 완료된 영속 aggregate만 사용한다.
- `상태 기반 추정`, `예상`, `추정`, coverage, known/unknown, forecast, 24시간 baseline과 그 종속 숫자를 보고서 document/API/file에 넣지 않는다.
- XLSX/PDF는 같은 `EnergyReportDocument` snapshot만 렌더링하며 section, label, value, displayValue, order, fingerprint가 동일하다.
- renderer는 계산하지 않고 layout만 담당한다.
- heatmap은 energy/brightness만 지원하고 최대 92일이다.
- site access는 query 전 `read` 권한을 확인하고 cross-tenant resource는 404로 숨긴다.
- report object는 private, 파일 7일, metadata 90일, signed URL 5분이다.
- 공통 UI component 규칙과 `docs/ui-spacing.md` 간격을 따른다.
- 기능 변경과 함께 `docs/menus/statistics.md`, DB 변경과 함께 `docs/database-schema.md`, 검증 결과와 함께 `docs/project-status.md`를 갱신한다.

### Task 1: shared P2 계약과 공통 보고서 문서 모델

**Files:**
- Create: `packages/shared/src/energy-p2-contracts.ts`
- Create: `packages/shared/src/energy-p2-contracts.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json`
- Modify: `packages/shared/tsconfig.esm.json`
- Modify: `packages/shared/src/package-exports.test.ts`

- [ ] 실패 테스트로 heatmap query/response, report request/job/list/download와 strict schema를 정의한다.
- [ ] report request는 from/to, site|fixture|floor|group scope, identityId, xlsx|pdf만 받으며 section 선택은 받지 않는다.
- [ ] `EnergyReportDocument` discriminated section model과 canonical fingerprint input을 정의한다.
- [ ] document model에는 금지 필드와 P2-C 필드가 존재하지 않도록 타입과 runtime schema를 제한한다.
- [ ] root 및 `./energy-p2-contracts` ESM/CommonJS export를 구현하고 packed import를 검증한다.
- [ ] shared test/typecheck/build를 실행하고 커밋한다.

### Task 2: heatmap API

**Files:**
- Create: `apps/api/src/energy/energy-heatmap.service.ts`
- Create: `apps/api/src/energy/energy-heatmap.service.spec.ts`
- Create: `apps/api/src/energy/energy-heatmap.integration.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.module.ts`

- [ ] 실패 테스트로 168 cell, energy 합계, weighted brightness, DST 반복 합산, 실제 0/결측, 최대 92일을 고정한다.
- [ ] fixture/floor/group identity 유효기간을 적용하고 site access를 query 전에 검사한다.
- [ ] `GET /energy/sites/:siteId/heatmap`을 shared schema로 parse/serialize한다.
- [ ] API unit/integration/typecheck를 실행하고 커밋한다.

### Task 3: heatmap UI

**Files:**
- Create: `apps/web/src/features/statistics/analysis/EnergyHeatmap.tsx`
- Create: `apps/web/src/features/statistics/analysis/EnergyHeatmap.test.tsx`
- Modify: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.tsx`
- Modify: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx`
- Modify: `apps/web/src/api/energy.ts`
- Modify: `apps/web/src/api/energy.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] 실패 테스트로 기본 완료 28일, energy/brightness toggle, ranking selection scope, 0/결측, keyboard detail을 고정한다.
- [ ] 7×24 CSS grid, legend, selected cell detail, loading/error/empty를 공통 UI로 구현한다.
- [ ] 1440/1024/390/320에서 overflow 없이 상단 정렬과 44px 조작 영역을 유지한다.
- [ ] Web test/typecheck를 실행하고 커밋한다.

### Task 4: report job schema와 정확한 document snapshot

**Files:**
- Create: `apps/api/prisma/migrations/20260912_statistics_p2_reports/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/test/domain-schema.test.ts`
- Create: `apps/api/src/energy/reports/energy-report-document.builder.ts`
- Create: `apps/api/src/energy/reports/energy-report-document.builder.spec.ts`
- Create: `apps/api/src/energy/reports/energy-report-snapshot.service.ts`
- Create: `apps/api/src/energy/reports/energy-report-snapshot.service.spec.ts`
- Modify: `docs/database-schema.md`

- [ ] `EnergyReportJob` status/progress/attempt/lease/requestSnapshot/dataSnapshot/documentSnapshot/object metadata schema와 active dedupe index를 실패 테스트로 고정한다.
- [ ] 완료된 현지 날짜의 persisted daily/hourly rows만 하나의 RepeatableRead transaction에서 조회한다.
- [ ] current projection/forecast/baseline/coverage/known/unknown을 조회하거나 document에 넣지 않는 테스트를 작성한다.
- [ ] document builder가 summary, daily, comparison, fixture/floor/group rankings, energy/brightness heatmaps, calculation info를 한 번 계산한다.
- [ ] canonical JSON SHA-256 contentFingerprint를 document에 저장한다.
- [ ] DB rehearsal, service test, typecheck를 실행하고 커밋한다.

### Task 5: 동일내용 XLSX/PDF renderer

**Files:**
- Create: `apps/api/src/energy/reports/report-renderer.ts`
- Create: `apps/api/src/energy/reports/report-renderer.contract.spec.ts`
- Create: `apps/api/src/energy/reports/excel-energy-report.renderer.ts`
- Create: `apps/api/src/energy/reports/excel-energy-report.renderer.spec.ts`
- Create: `apps/api/src/energy/reports/pdf-energy-report.renderer.ts`
- Create: `apps/api/src/energy/reports/pdf-energy-report.renderer.spec.ts`
- Add: `apps/api/src/assets/fonts/NotoSansKR-Regular.ttf`
- Add: `apps/api/src/assets/fonts/NotoSansKR-Bold.ttf`
- Add: `apps/api/src/assets/fonts/OFL.txt`
- Modify: `apps/api/package.json`
- Modify: `apps/api/nest-cli.json`

- [ ] 동일 document fixture를 두 renderer에 입력하고 추출 manifest가 완전히 같은 실패 테스트를 먼저 작성한다.
- [ ] renderer 공통 interface는 bytes, contentType, extension, extracted manifest를 반환하고 계산 API를 제공하지 않는다.
- [ ] ExcelJS는 ordered section을 sheet에, pdf-lib/fontkit은 같은 ordered section을 A4 page에 표현한다.
- [ ] 두 파일 모두 같은 title, metadata, labels, raw/display values, row order, fingerprint를 포함한다.
- [ ] 한글, 긴 이름, page break, numeric XLSX cell, heatmap, 금지 문구 부재를 검증한다.
- [ ] renderer test/API build를 실행하고 커밋한다.

### Task 6: CSV, private storage, durable report worker/API

**Files:**
- Create: `apps/api/src/energy/reports/energy-csv-export.service.ts`
- Create: `apps/api/src/energy/reports/energy-csv-export.service.spec.ts`
- Create: `apps/api/src/energy/reports/energy-report-jobs.service.ts`
- Create: `apps/api/src/energy/reports/energy-report-jobs.service.spec.ts`
- Create: `apps/api/src/energy/reports/energy-report-worker.service.ts`
- Create: `apps/api/src/energy/reports/energy-report-worker.service.spec.ts`
- Modify: `apps/api/src/storage/object-storage.service.ts`
- Modify: `apps/api/src/storage/object-storage.service.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`
- Modify: `apps/api/src/energy/energy.module.ts`

- [ ] CSV BOM/quoting/formula injection/streaming 실패 테스트를 작성하고 공통 document의 table 정보를 stream한다.
- [ ] private put/head/delete/300초 download URL과 report key allowlist를 실패 테스트로 고정한다.
- [ ] POST/list/detail/download API, active request dedupe, 30초 lease, SKIP LOCKED, progress, 최대 3회 retry/fencing을 구현한다.
- [ ] worker는 저장된 documentSnapshot만 renderer에 전달하고 attempt별 key를 사용한다.
- [ ] 25MB 상한, 7일 expiry, 안전한 filename, tenant 404를 검증한다.
- [ ] API test/typecheck/build를 실행하고 커밋한다.

### Task 7: 보고서 고객 UI

**Files:**
- Create: `apps/web/src/features/statistics/reports/StatisticsReportsPage.tsx`
- Create: `apps/web/src/features/statistics/reports/StatisticsReportsPage.test.tsx`
- Create: `apps/web/src/features/statistics/reports/ReportCreateDialog.tsx`
- Create: `apps/web/src/features/statistics/reports/ReportJobList.tsx`
- Modify: `apps/web/src/features/statistics/statistics-sections.ts`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/api/energy.ts`
- Modify: `apps/web/src/styles.css`

- [ ] `개요/사용 분석/보고서` 세 route와 P2-C/최적화 link 부재를 실패 테스트로 고정한다.
- [ ] 생성 dialog는 기간/scope/xlsx|pdf만 제공하고 section 선택·불확실 지표를 노출하지 않는다.
- [ ] 같은 기간/scope를 사용하는 `CSV 내보내기` action을 제공하고 streamed attachment 응답을 다운로드한다.
- [ ] queued/processing/completed/failed/expired 목록, active 3초 polling, 재생성, signed download를 구현한다.
- [ ] format과 무관하게 동일 제목/기간/내용 안내를 표시한다.
- [ ] Web test/typecheck/build를 실행하고 커밋한다.

### Task 8: retention, E2E, 문서와 최종 게이트

**Files:**
- Create: `apps/api/src/energy/reports/energy-report-cleanup.service.ts`
- Create: `apps/api/src/energy/reports/energy-report-cleanup.service.spec.ts`
- Modify: `apps/api/src/operator-site-admins/site-deletion-cleanup.service.ts`
- Modify: `apps/api/src/operator-site-admins/site-deletion-cleanup.service.spec.ts`
- Modify: `apps/web/e2e/statistics-flow.spec.ts`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/project-status.md`

- [ ] 7일 object expiry, 90일 metadata purge, 모든 attempt object와 site delete cleanup을 실패 테스트로 고정한다.
- [ ] Chromium에서 heatmap과 report 생성/상태/다운로드/모바일 overflow를 검증한다.
- [ ] XLSX/PDF extraction 결과 동일성과 금지 문구 부재를 E2E fixture로 검증한다.
- [ ] P2-C와 최적화 미구현 상태, mock/storage/HIL 한계를 메뉴 문서에 기록한다.
- [ ] 전체 test, lint, typecheck, build, `git diff --check`를 실행하고 커밋한다.

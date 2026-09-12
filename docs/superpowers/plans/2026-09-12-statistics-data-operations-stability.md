# Statistics Data Operations Stability Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 통계 데이터와 P2 보고서가 장기 운영에서 안전하게 정리·복구되고, 사용자가 보고서 상태와 비용 기준을 정확히 이해하도록 한다.

**Architecture:** 기존 migration checksum은 보존하고 순방향 migration, stream high-water, bounded retention worker, immutable report target snapshot, durable cleanup counters를 추가한다. Shared strict contract → Prisma/API → Web 순으로 적용하며 모든 DB 검증은 disposable PostgreSQL만 사용한다.

**Tech Stack:** TypeScript, NestJS, Prisma/PostgreSQL, React, TanStack Query, Zod, Jest/Vitest, Playwright, S3-compatible object storage.

---

## Global Constraints

- [ ] 작업 경로는 `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-statistics-data`, branch는 `codex/p0p1-statistics-data`, base는 `d6231a071b77519cc654f0e29f2110c76e48ce01`로 고정한다.
- [ ] 기존 migration 파일은 수정하지 않는다. 사용자/운영 DB에 migration을 실행하지 않는다.
- [ ] 새 DB 검증은 임시 schema 또는 disposable PostgreSQL에서만 수행하고 종료 시 정리한다.
- [ ] P2-C, 최적화, P3, AuditLog/claim/certificate purge, 배포는 포함하지 않는다.
- [ ] 각 task는 RED → GREEN → scoped verification → commit 순서로 수행한다.
- [ ] DB 변경은 `docs/database-schema.md`, 통계 UI/API 변경은 `docs/menus/statistics.md`, 상태는 `docs/project-status.md`에 동기화한다.

## Task 1: 마이그레이션 실패·재시도 검증과 운영 가드

**Files:**
- Create: `apps/api/src/energy/reports/energy-report-migration-safety.integration.spec.ts`
- Create: `apps/api/scripts/check-report-migration-preflight.mjs`
- Modify: `apps/api/package.json`
- Modify: `docs/database-schema.md`

- [x] 실제 `prisma migrate deploy` clean replay와 20260911까지 적용한 staged upgrade test를 작성한다.
- [x] 테스트용 migration copy에 statement failure를 주입해 `_prisma_migrations`, catalog, data rollback/partial state와 retry 결과를 검증한다.
- [x] 20260913 legacy `objectKeys` scalar/다중 형식으로 제약을 넘는 row, 20260914 trigger 누락을 읽기 전용 preflight가 fail-closed로 보고하도록 작성한다.
- [x] table lock 대기/timeout과 concurrent writer 차단을 두 connection으로 검증한다.
- [x] maintenance barrier와 실패 복구 runbook을 schema 문서에 기록한다.
- [x] Run: `pnpm --filter @led-control/api test -- energy-report-migration-safety.integration.spec.ts --runInBand`
- [x] Commit: `test(api): harden report migration recovery checks`

## Task 2: 이벤트 watermark와 보존 스키마

**Files:**
- Create: `apps/api/prisma/migrations/20260915_statistics_operations_retention/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/test/domain-schema.test.ts`
- Create: `apps/api/src/retention/gateway-event-watermark.ts`
- Modify: `apps/api/src/energy/fixture-state-ingestion.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/automation/vehicle-sensor-capability.service.ts`
- Modify corresponding specs in those directories.

- [x] `GatewayEventWatermark`와 provisioning terminal identity, retention indexes를 forward migration으로 추가한다.
- [x] 기존 PGE에서 안전하게 high-water를 backfill하되 동일 sequence conflict는 migration preflight에서 탐지한다.
- [x] fixture state, heartbeat, scan, capability transaction에서 compare-and-advance를 적용한다.
- [x] exact duplicate는 기존 ACK/응답을 재사용하고 stale/conflict는 기존 contract에 맞게 거부한다.
- [x] PGE row를 지운 뒤의 duplicate/stale/corrupt replay 회귀를 먼저 작성한다.
- [x] Run: focused consumer tests, `pnpm --filter @led-control/api exec prisma validate`, `pnpm --filter @led-control/api prisma:generate`.
- [x] Commit: `feat(api): retain gateway event high watermarks`

## Task 3: bounded data retention worker

**Files:**
- Create: `apps/api/src/retention/data-retention.service.ts`
- Create: `apps/api/src/retention/data-retention.service.spec.ts`
- Create: `apps/api/src/retention/data-retention.integration.spec.ts`
- Create: `apps/api/src/retention/retention.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `docs/menus/settings.md`

- [ ] event type별 7/30/90/365일 cutoff와 안전 조건을 구현한다. 알 수 없는 type은 보존한다.
- [ ] 만료/폐기 후 30일 Session을 batch 10,000으로 정리한다.
- [ ] Floor별 최근 100개 또는 최근 365일을 남기고 그 밖의 revision을 batch 1,000으로 정리한다.
- [ ] `FOR UPDATE SKIP LOCKED`, stable ordering, timer 중복 방지, `unref()`, structured summary log를 적용한다.
- [ ] 두 Prisma connection이 locked row를 건너뛰고 다음 sweep에서 수렴하는 disposable PostgreSQL integration test를 작성한다.
- [ ] Run: retention unit/integration tests and API typecheck.
- [ ] Commit: `feat(api): add bounded operational data retention`

## Task 4: 보고서 공개 계약과 불변 대상 snapshot

**Files:**
- Modify: `packages/shared/src/energy-p2-contracts.ts`
- Modify: `packages/shared/src/energy-p2-contracts.test.ts`
- Modify: `packages/shared/src/package-exports.test.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260916_report_operations_metadata/migration.sql`
- Modify: `apps/api/src/energy/reports/energy-report-jobs.service.ts`
- Modify: `apps/api/src/energy/reports/energy-report-snapshot.service.ts`
- Modify: `apps/api/src/energy/reports/energy-report-worker.service.ts`
- Modify corresponding API specs.

- [ ] strict job schema에 target, requestedAt, 공개 failure를 추가하고 legacy nullable row를 지원한다.
- [ ] 생성 transaction에서 대상 label을 snapshot하고 snapshot immutability trigger를 forward migration으로 교체한다.
- [ ] rename/delete 뒤에도 label이 유지되고 `requestedAt === createdAt`임을 검증한다.
- [ ] worker 실패를 안전한 public code로 분류하고 raw error 문자열이 API로 나가지 않게 한다.
- [ ] Run shared tests/typecheck and focused report API/worker tests.
- [ ] Commit: `feat(reports): expose actionable job metadata`

## Task 5: 보고서 객체 정리 관측성

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/prisma/migrations/20260916_report_operations_metadata/migration.sql`
- Modify: `apps/api/src/storage/object-storage.service.ts`
- Modify: `apps/api/src/energy/reports/energy-report-cleanup.service.ts`
- Modify: `apps/api/src/energy/reports/energy-report-cleanup.service.spec.ts`

- [ ] ledger에 attempt/failure/observed/deleted/late PUT count·byte와 last attempt를 추가한다.
- [ ] HEAD 404/존재/실패를 구분하고 존재 객체의 크기를 DELETE 전에 측정한다.
- [ ] successful pass 뒤 재발견된 key만 late PUT으로 누적한다.
- [ ] lease-lost owner가 지표를 이중 commit하지 않는 회귀를 작성한다.
- [ ] sweep 결과에 backlog, oldest due, retry/failure/late PUT totals를 넣고 structured log로 남긴다.
- [ ] Run cleanup/worker/site-deletion focused tests.
- [ ] Commit: `feat(api): add report cleanup ledger metrics`

## Task 6: 보고서 목록 오류·메타 UI와 비용 기준 문구

**Files:**
- Modify: `apps/web/src/api/energy.ts`
- Modify: `apps/web/src/features/statistics/reports/ReportCreateDialog.tsx`
- Modify: `apps/web/src/features/statistics/reports/StatisticsReportsPage.tsx`
- Modify: `apps/web/src/features/statistics/reports/ReportJobList.tsx`
- Modify: `apps/web/src/features/statistics/StatisticsOverviewPage.tsx`
- Modify: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.tsx`
- Modify: `apps/web/src/features/statistics/analysis/EnergyRankingList.tsx`
- Modify: `apps/web/src/styles.css`
- Modify corresponding web tests.

- [ ] 목록에 정확한 대상 label, 요청 시각, 완료 파일 만료 시각, 실패 사유/행동 안내를 표시한다.
- [ ] 400/404/409/5xx/network 오류를 `ApiError`와 fetch error로 구분한다.
- [ ] 일별/순위/보고서는 “당시 적용 단가의 저장 비용”, forecast/baseline/savings는 “현재 설정 단가 기준”이라고 명시한다.
- [ ] 320px에서 metadata/action wrapping과 접근성 이름을 검증한다.
- [ ] Run focused Web tests, Web typecheck/build.
- [ ] Commit: `feat(web): clarify report status and energy cost basis`

## Task 7: 문서 수렴과 전체 검증

**Files:**
- Modify: `docs/menus/statistics.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/project-status.md`
- Modify: `docs/lesson_leared.md` when a reusable lesson is found.

- [ ] 구현 완료/미구현/한계/관련 파일/갱신 규칙 구조를 유지하며 통계 문서를 갱신한다.
- [ ] event exact dedupe horizon, restore availability, security/audit retention, migration deploy barrier, cleanup metrics 의미를 기록한다.
- [ ] `docs/project-status.md`와 이 plan의 체크 상태를 실제 검증 결과와 일치시킨다.
- [ ] Run: Prisma validate/generate, shared/API/Web lint/typecheck/test/build, migration integration, `git diff --check`.
- [ ] 독립 code review 후 P0/P1 findings를 수정·재검증한다.
- [ ] Commit: `docs: finalize statistics operations stability`

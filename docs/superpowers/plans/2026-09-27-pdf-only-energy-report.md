# PDF 전용 에너지 보고서 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Excel 보고서를 완전히 제거하고 기존 이력을 안전하게 초기화하며, 승인된 PDF 시안 구성으로 새 보고서를 생성한다.

**Architecture:** 공유 생성 계약은 PDF 전용으로 축소하고 CSV 범위 검증은 분리한다. 백엔드 문서 스냅샷은 보존하되 별도 PDF 표시 모델로 정확한 사실만 선택해 pdf-lib에서 레이아웃한다. 이력 삭제 migration은 객체 cleanup 원장을 남기고 저장소 정리 worker가 파일을 회수한다.

**Tech Stack:** TypeScript, Zod, React, NestJS, Prisma/PostgreSQL, pdf-lib, Sharp, Vitest/Jest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-27-pdf-only-energy-report-design.md`

## Global Constraints

- 대상 시안의 1쪽 해석 범위, 2쪽 읽는 방법, 3쪽 하단 하늘색 카드는 없어야 한다.
- 히트맵 168개 셀은 정사각형이며, 그래프·텍스트 겹침과 잘림이 없어야 한다.
- 추정 절감량·가상 기준선·현재 단가 소급 비용을 보고서 본문에 표시하지 않는다.
- 기존 보고서 이력은 전량 초기화하지만 객체 cleanup 원장은 모든 파일 삭제가 확인될 때까지 보존한다.
- CSV는 별도 원본 내보내기로 유지한다.

## Review Focus

- 동시 구 worker의 늦은 PUT: 유지보수 경계와 cleanup 원장이 파일을 놓치지 않는가.
- 부분·누락 기록: 단순 row 존재가 기간 완전성을 뜻하지 않으며 비교를 거부하는가.
- 0과 결측: `0 kWh`와 `데이터 없음`이 구별되는가.
- 긴 한글·emoji·긴 기간: 텍스트와 표 행이 페이지 밖으로 나가지 않는가.
- 오래된 `format=xlsx` URL/브라우저 상태: 오류 없이 현재 PDF 이력의 첫 페이지로 돌아오는가.

---

### Task 1: 시안 수정·검증

**Files:** 최종 시안 `output/pdf/energy-report-pdf-only-2month-demo.pdf` (제품 저장소 외 사용자 산출물)

- [x] 지정된 카드·작은 설명을 제거하고 히트맵 셀을 정사각형으로 수정한다.
- [x] 모든 페이지를 다시 렌더링해 겹침·잘림을 검사한다.
- [x] 62일 합계, 페이지 수, 텍스트 추출을 검증한다.

### Task 2: PDF 전용 계약과 이력 정리 경계

**Files:** `packages/shared/src/energy-p2-contracts.ts`, `apps/api/prisma/schema.prisma`, 새 순방향 migration, `apps/api/src/energy/reports/energy-report-jobs.service.ts`, `energy-report-worker.service.ts`, `energy-csv-export.service.ts`, 관련 테스트.

- [ ] PDF만 허용하고 XLSX를 거부하는 요청·worker 실패 테스트를 먼저 작성해 RED를 확인한다.
- [ ] CSV가 Excel 형식 없이 범위를 검증하는 테스트를 먼저 작성해 RED를 확인한다.
- [ ] 전체 보고서 행 삭제 후 원장이 보존되는 migration 테스트를 먼저 작성해 RED를 확인한다.
- [ ] 최소 코드·migration으로 GREEN을 만들고 worker·API·cleanup 회귀를 실행한다.
- [ ] Excel 렌더러·ExcelJS 의존성을 제거하되 구 XLSX 객체의 원장 삭제 경로는 유지한다.
- [ ] Prisma 검증·생성, Shared/API typecheck·test·build와 migration 안전성 검증을 실행한다.

### Task 3: 의미 기반 PDF 렌더링

**Files:** `apps/api/src/energy/reports/pdf-energy-report.renderer.ts`, `report-pdf-layout.ts`, `report-chart-image.renderer.ts`, 신규 PDF 표시 모델, 관련 테스트·브라우저 fixture.

- [ ] 6쪽 완전 데이터와 부분 기록·긴 텍스트·정사각 히트맵의 실패 테스트를 작성해 RED를 확인한다.
- [ ] 불변 스냅샷에서 요약·일별·월별·층/조명·시간대 사실만 선택하는 PDF 표시 모델을 구현한다.
- [ ] pdf-lib로 동적 페이지·표·차트를 배치하고 충돌 및 페이지 경계 검증을 추가한다.
- [ ] PDF 추출·PNG 비교·API worker 실제 생성 회귀를 GREEN으로 만든다.

### Task 4: 웹 PDF 전용 흐름

**Files:** `apps/web/src/features/statistics/reports/*`, `apps/web/src/api/energy.ts`, `apps/web/src/features/landing/*`, 관련 Vitest/Playwright.

- [ ] 생성 형식 선택·이력 형식 필터·Excel 홍보·구 URL 정규화의 실패 테스트를 먼저 작성해 RED를 확인한다.
- [ ] PDF 생성·재생성·다운로드와 CSV 내보내기를 유지하면서 Excel UI를 제거한다.
- [ ] Web typecheck·test·build 및 통계/랜딩 브라우저 회귀를 실행한다.

### Task 5: 문서·통합 검증

**Files:** `docs/menus/statistics.md`, 영향받는 랜딩 문서, `docs/database-schema.md`, `docs/project-status.md`.

- [ ] 메뉴 현황·DB migration·실행 여부를 사실대로 기록한다.
- [ ] `git diff --check`, 전체 영향 테스트, 실제 PDF 시각 검사를 실행한다.
- [ ] DB 이력·S3 파일 초기화는 접속 환경의 identity와 유지보수 경계를 확인한 경우에만 수행하고, 미실행 시 명시한다.
- [ ] 독립 코드 검토를 요청하고 중요 지적을 반영한다.

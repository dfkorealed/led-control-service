# PDF 전용 에너지 보고서 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Excel 보고서를 완전히 제거하고 기존 이력을 안전하게 초기화하며, 승인된 PDF 시안 구성으로 새 보고서를 생성한다.

**Architecture:** 공유 생성 계약은 PDF 전용으로 축소하고 CSV 범위 검증은 분리한다. 백엔드 문서 스냅샷은 보존하되 별도 PDF 표시 모델로 정확한 사실만 선택해 pdf-lib에서 레이아웃한다. 이력 삭제 migration은 객체 cleanup 원장을 남기고 저장소 정리 worker가 파일을 회수한다.

**Tech Stack:** TypeScript, Zod, React, NestJS, Prisma/PostgreSQL, pdf-lib, Sharp, Vitest/Jest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-27-pdf-only-energy-report-design.md`

**2026-09-28 개정:** Task 1~6의 6쪽·기존 페이지 번호는 최초 구현 당시 검증 이력이다. 현재 승인 구성은 Task 7의 별도 표지 포함 7쪽이며, 자료 상태 UI와 본문 UTC/생성 시각을 제거한다.

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

- [x] PDF만 허용하고 XLSX를 거부하는 요청·worker 실패 테스트를 먼저 작성해 RED를 확인한다.
- [x] CSV가 Excel 형식 없이 범위를 검증하는 테스트를 먼저 작성해 RED를 확인한다.
- [x] 전체 보고서 행 삭제 후 원장이 보존되는 migration 테스트를 먼저 작성해 RED를 확인한다.
- [x] 최소 코드·migration으로 GREEN을 만들고 worker·API·cleanup 회귀를 실행한다.
- [x] Excel 렌더러·ExcelJS 의존성을 제거하되 구 XLSX 객체의 원장 삭제 경로는 유지한다.
- [x] Prisma 검증·생성, Shared/API typecheck·test·build와 migration 안전성 검증을 실행한다.
- [x] 독립 검토 후 신규 XLSX 업로드 차단과 PDF-only migration 사후 점검을 보강한다.

### Task 3: PDF 표시 사실 모델과 자료 완전성

**Files:** 신규 `apps/api/src/energy/reports/pdf-report-presentation.ts`와 테스트, 필요 시 `energy-report-document.builder.ts` 및 해당 테스트.

**Interfaces:** `buildPdfReportPresentation(document: EnergyReportDocument): PdfReportPresentation`는 요약·일별·월별·층/조명·시간대 표시 사실과 각 수치의 완전성/표시 가능 여부를 반환한다. 기계 검증용 원본 필드와 화면 본문을 분리한다. 비용은 저장된 값만 사용하고 현재 단가로 재계산하지 않는다.

- [x] 누락된 하루, 일부 시간, 이전 기간 불완전, 0과 null, 비용 일부 null의 실패 테스트를 먼저 작성해 RED를 확인한다.
- [x] 선택된 문서의 일별·비교·층/조명 순위·에너지 히트맵만 읽고 기준선/밝기/그룹/UUID 등은 본문 모델에서 제외한다.
- [x] 완전성 판정과 원시 Decimal 합산, 문서 단위 전력량 2~4자리 표시, 62일·월별 합계의 GREEN을 확인한다.

### Task 4: PDF 레이아웃과 출력 검증

**Files:** `apps/api/src/energy/reports/pdf-energy-report.renderer.ts`, `report-pdf-layout.ts`, `report-chart-image.renderer.ts` 및 관련 테스트·브라우저 fixture.

**Interfaces:** Task 3의 `buildPdfReportPresentation`을 소비한다. `PdfEnergyReportRenderer.render(document)`는 PDF bytes, MIME `application/pdf`, extension `pdf`와 표시 사실을 추출해 검증한 manifest를 반환한다. worker는 불필요한 8개 PNG 사전 렌더링을 강제하지 않는다.

**시안 기준:** A4·44pt 바깥 여백·네이비/파랑/연한 하늘색을 사용한다. 완전한 현장 62일 입력은 1쪽 네 KPI와 비교 막대, 2쪽 일별 선과 월 합계, 3쪽 층 막대와 조명 상위 5개/그 외, 4쪽 요일×시간 168개 정사각형 셀과 산식, 5~6쪽 월별 31행 상세로 끝난다. 세 삭제 대상 카드는 어떤 페이지에서도 되살리지 않는다. 단위·값은 그래프 바깥 별도 영역에 두며 폰트 폭으로 충돌을 검사한다. 다른 scope/기간/결측 상태는 없는 영역을 빈 카드로 채우지 않고 동적으로 페이지를 조정한다.

- [x] 6쪽 완전 데이터와 부분 기록·긴 텍스트·정사각 히트맵의 실패 테스트를 작성해 RED를 확인한다.
- [x] pdf-lib로 동적 페이지·표·차트를 배치하고 충돌 및 페이지 경계 검증을 추가한다.
- [x] PDF 추출·PNG 비교·API worker 실제 생성 회귀를 GREEN으로 만든다.
- [x] 독립 검토의 17층 이상 페이지 분할·범위 종류 표시·불완전 일별 선 연결 문제를 TDD로 보강한다.

### Task 5: 웹 PDF 전용 흐름

**Files:** `apps/web/src/features/statistics/reports/*`, `apps/web/src/api/energy.ts`, `apps/web/src/features/landing/*`, 관련 Vitest/Playwright.

- [x] 생성 형식 선택·이력 형식 필터·Excel 홍보·구 URL 정규화의 실패 테스트를 먼저 작성해 RED를 확인한다.
- [x] PDF 생성·재생성·다운로드와 CSV 내보내기를 유지하면서 Excel UI를 제거한다.
- [x] Web typecheck·test·build 및 통계/랜딩 브라우저 회귀를 실행한다.

### Task 6: 문서·통합 검증

**Files:** `docs/menus/statistics.md`, 영향받는 랜딩 문서, `docs/database-schema.md`, `docs/project-status.md`.

- [x] 메뉴 현황·DB migration·실행 여부를 사실대로 기록한다.
- [x] `git diff --check`, 전체 영향 테스트, 실제 PDF 시각 검사를 실행한다.
- [x] DB 이력·S3 파일 초기화는 접속 환경의 identity와 유지보수 경계를 확인한 경우에만 수행하고, 미실행 시 명시한다.
  - 사용자 승인 뒤 기존 로컬 API·Web 서버를 중지하고 `led_control`과 `energy-reports`의 최신 백업·preflight를 확인했다. PDF 전용 migration 및 정리 서비스 실행 후 작업 4→0건, 파일 2→0개, 보존 원장 2→4건/12키, postflight 통과를 확인했다. 운영 환경에는 접속하거나 적용하지 않았다.
- [x] 독립 코드 검토를 요청하고 중요 지적을 반영한다.

### Task 7: 2026-09-28 사용자 PDF 주석 반영

**승인:** 기존 짧은 변경 설계를 사용자가 승인하되 자료 상태는 단어 변경이 아닌 표시 제거로 확정했다.

**Files:** `apps/api/src/energy/reports/semantic-pdf-energy-report.renderer.ts`, `report-pdf-layout.ts`, PDF semantic 회귀와 샘플 생성 스크립트, `docs/menus/statistics.md`, 기존 PDF 설계·상태판.

**완료 조건:**
- 첫 페이지는 중앙의 `조명 에너지 사용 보고서` 제목과 현장·범위·기간만 있는 표지다. 핵심 결과는 둘째 페이지이며 62일 완전 예시는 7쪽이다.
- 순위 제목은 `사용량 순위`, 히트맵 제목은 `시간대별 사용량`이다. 계속 페이지도 같은 제목 체계를 따른다.
- UTC/현장 시간대 및 생성 시각을 PDF 본문에서 제거한다. 불변 원본 문서의 메타데이터는 유지한다.
- 자료 상태 UI는 요약의 자료 확인 카드, 히트맵의 자료 상태 표기, 일별 상세 자료 열에서 제거한다. 내부 완전성 판정·비교 차단, 0과 결측 구별 및 자료 부족 사유는 유지한다. 일별 상세에서 부분/확인 불가 날짜의 사용량·비용은 `집계 불가`, 누락 날짜는 `데이터 없음`으로 표시해 하루 전체 수치로 오독하지 않게 하며 원시 값과 판정은 내부에 유지한다.
- 글꼴 폭 기반 중앙 정렬·줄바꿈과 페이지/텍스트 충돌 검증을 유지한다. 긴 현장·대상 이름, 17/20층 페이지 분할, 결측 추이, 큰 수치의 회귀가 통과한다.
- 실제 제품 렌더러와 62일/2개 층/6개 조명 가상 fixture로 `output/pdf/energy-report-annotated-2month-demo.pdf`를 사용자 작업 폴더 아래 생성한다. DB/S3 연결 없이 예시를 만들고 기존 파일은 보존한다.
- 신규 회귀의 RED/GREEN, API 전체 runnable 테스트·typecheck·build, PDF 전체 PNG 시각 검수를 기록한다. 기존 경고/환경 제외는 숨기지 않는다. 서버·DB·운영 환경은 변경하지 않는다.

- [x] 신규 회귀를 먼저 작성하고 표지 분리·표시 제거의 RED를 확인한다. 신규 7개 모두 기존 코드에서 실패했고 최소 구현 뒤 7/7 GREEN을 확인했다. 전체 관련 회귀는 진행 중이다.
- [x] PDF 렌더러와 표시 사실 목록을 변경하고 GREEN·API 검증을 확인했다. `350da0ab`: 집중 42/42, API 전체 217 suites·2,629 passed·57 suites/655 환경 의존 skipped, typecheck·Nest build 종료 코드 0. 기존 pnpm 설정 경고와 실패 주입 Nest 로그를 숨기지 않고 구현 보고서에 기록했다.
- [x] 통계 메뉴 및 기존 설계를 최신화하고 샘플 PDF를 생성·검수했다. 샘플 7쪽 전체 PNG 시각 검수에서 겹침·잘림 부재를 확인했고 독립 텍스트 추출은 62행·505.008 kWh·80,808원, 제거 문구 0·페이지 밖 글리프 0으로 통과했다. Browser 동적 fixture의 실제 생성·manifest 일치도 확인했다(새 Chromium 실행은 아님).
- [ ] 독립 검토 후 상태판과 이 체크리스트에 결과·남은 한계를 기록한다. 작업 검토는 요구사항/품질 승인(Critical·Important 0), 최종 통합 검토는 진행 중이다. 기존 pnpm 경고/테스트 로그 잡음은 별도 정리 Minor이며 이 PDF 변경의 차단 결함은 아니다.

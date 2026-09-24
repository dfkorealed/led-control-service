# 통계 P1 데이터 의미·메타데이터 구현 계획

> **실행 담당:** 통계 페이지 담당. 승인된 디자인 검토 문서의 통계 P1 범위만 구현한다. 각 독립 작업은 `superpowers:test-driven-development`의 RED→GREEN을 수행한다. 공유 checkout에서는 다른 담당자의 변경을 stage/commit/merge하지 않는다.

**Goal:** 통계 개요·분석·보고서에서 기간 적용 범위, 수치의 출처·결측, 현장 시간대, 차트·히트맵 축, 완료 파일 만료 시각을 오해 없이 읽을 수 있게 한다.

**Architecture:** 기존 summary/series/comparison/rankings/heatmap/report 응답과 계산·query key는 유지한다. 각 화면이 이미 받은 `timeZone`, `generatedAt`, `lastAggregatedAt`, `range`, `expiresAt`로만 짧은 inline 메타와 접근 가능한 축/레이블을 만든다. 새 공통 Tooltip API가 없으므로 공통 `Text`/`StatusBadge` 및 기존 Recharts Tooltip을 재사용하고 새 overlay는 만들지 않는다.

**Tech Stack:** React, TypeScript, Recharts, 공통 UI 컴포넌트, Vitest/Testing Library.

**Spec:** `docs/assets/ux-refresh-2026-09-23/design-review.md` 04·05 시안과 통계 P1 행·`통계·보고서` 단락. 사용자 승인된 디자인 범위다.

## Global Constraints

- 수정은 `apps/web/src/features/statistics` 내부의 각 하위 화면·테스트, `docs/menus/statistics.md`, 이 계획 파일에 한정한다. App/client/theme/shared shell·API·DB·shared 계약을 수정하지 않는다.
- 현장은 전역 선택, KPI 오늘·이번 달·올해는 각각 현장 시간대의 고정 기간, 추이 일별/월별과 분석 선택일은 각 화면의 범위, 절감 비교는 자체 preset/range라는 경계를 명시한다. 화면 설명이 query나 계산 범위를 바꿔서는 안 된다.
- 실계측 연동이 없는 값을 `측정`이라고 부르지 않는다. `상태 기반 추정`과 `24시간·100% 비교 기준`을 구분하고 실제 0과 `null`/미수집을 혼동하지 않는다.
- 오늘은 현장 현지 `00:00–마지막 집계, 진행 중`으로 표기한다. 마지막 집계가 없는 경우 생성 시각을 집계 완료 증거로 단정하지 않는다.
- 보고서 파일 7일 만료, PDF/XLSX 동일 immutable document, CSV, 다운로드 권한/URL, 요청일 90일 필터 계약을 변경하지 않는다.
- 기존 공통 컴포넌트를 사용하고 설명 블록을 중복 생성하지 않는다. 320/390/1024/1440px overflow/터치/키보드에 주의한다.
- 병렬 작업 중에는 담당 파일 focused Vitest만 실행한다. Playwright·전체 Web typecheck/build/UI policy는 총괄의 직렬 통합 게이트에 맡기고 미실행을 보고한다. Mock·자동 브라우저 증거를 실장비 HIL로 기술하지 않는다.

## Review Focus

1. 현장 자정 직전/직후에 오늘 날짜와 마지막 집계 시각을 브라우저 시간대가 아닌 현장 시간대로 표시하는가.
2. `lastAggregatedAt`이 `null`이면 `generatedAt`을 마지막 집계로 오표기하지 않는가.
3. 사용량 `0`은 숫자 0으로 유지하고 `null`/미수집은 빈 수치·결측으로 남는가.
4. 분석 순위 선택 기간과 히트맵의 완료된 28일 범위가 다르더라도 각 표기가 서로의 범위를 침범하지 않는가.
5. 완료 보고서의 파일 만료 시각이 table/card에서 라벨과 machine-readable `dateTime`으로 읽히고 대기/실패 행에는 가짜 시각이 없는가.

---

### Task 1: 통계 개요의 기간·출처·진행 중 메타

**Files:**
- Modify: `apps/web/src/features/statistics/StatisticsOverviewPage.tsx`
- Modify: `apps/web/src/features/statistics/StatisticsOverviewPage.test.tsx`
- Optional if existing behavior is insufficient: `apps/web/src/features/statistics/EnergyComparisonChart.tsx`, `EnergyComparisonChart.test.tsx`

**Interfaces:** `EnergySummary`, `EnergySeriesResponse`, `EnergyComparisonResponse`를 읽기만 한다. 계산·API 호출 파라미터와 `getEnergySeriesRanges`는 그대로 둔다.

- [x] **RED 테스트:** 현장 `Asia/Seoul` 자정 경계 fixture에서 오늘 KPI 설명이 현지 00:00부터 마지막 집계까지만 가리키고 진행 중임을 확인한다. 마지막 집계 null fixture에서는 생성 시각을 마지막 집계라고 부르지 않는다. 오늘/이번 달/올해 KPI가 각각 고정 범위이고, 추이의 활성 일/월 range 및 비교 응답의 자체 `range`가 별도 inline 메타로 드러남을 확인한다. 0 사용량과 미수집 및 null 비용을 구분하고 완료 기간 추정을 실측으로 부르지 않는지 검증한다.
- [x] **RED 실행:** `pnpm --filter @led-control/web exec vitest run src/features/statistics/StatisticsOverviewPage.test.tsx src/features/statistics/EnergyComparisonChart.test.tsx --reporter=dot`; 새 의미 테스트 4개가 현재 UI 부재로 실패했고, null 비용 테스트도 0원 오표기로 실패했다.
- [x] **GREEN 구현:** `PageHeader`/KPI·차트 카드의 기존 설명 위치에 짧은 텍스트를 배치했다. `lastAggregatedAt`이 null/전날인 경우 구분하며 비교 `range`·현장 `timeZone`을 응답 그대로 사용한다. `no_data` KPI와 null 비용을 숫자 0으로 표시하지 않는다. 비교 차트의 완료 기간 값을 실측으로 부르지 않는다.
- [x] **추가 RED/GREEN:** `no_data` 구간 payload가 숫자 0을 담아도 이를 실사용량 0으로 그리거나 읽지 않는 회귀 테스트를 먼저 실패시킨 뒤, 해당 구간의 차트 입력을 `null`로 정규화했다. API payload·원가/기준 계산은 수정하지 않았다. focused Vitest 2 files·23/23 통과.
- [x] **축 검토:** Recharts YAxis는 양 차트 모두 `unit=" kWh"`와 자동 tick이 이미 있으나 JSDOM에서는 tick `<g>` 내부 텍스트가 비어 있어 실제 눈금 렌더링은 최종 브라우저 게이트에서 확인한다.

### Task 2: 분석 선택 기간과 히트맵 축·범례

**Files:**
- Modify: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.tsx`
- Modify: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx`
- Modify: `apps/web/src/features/statistics/analysis/EnergyHeatmap.tsx`
- Modify: `apps/web/src/features/statistics/analysis/EnergyHeatmap.test.tsx`
- Modify: `apps/web/src/features/statistics/analysis/EnergyRankingDetailPanel.tsx`

**Interfaces:** 기존 rankings 선택일 `from`/`to`, heatmap 응답 `range`/`timeZone`/7×24 `cells`를 소비한다. `completedSiteRange`와 query 인자는 변경하지 않는다.

- [x] **RED 테스트:** 분석 조건이 현장 timezone과 선택 기간이 순위에 적용됨을 짧게 설명하고, 히트맵은 응답 자체의 완료된 28일 range를 별도로 표시해야 한다. 히트맵 가로 시각(00–23), 세로 요일(일–토), 현장 timezone, 5단계 낮음→높음, `0`과 `수집 데이터 없음`을 다른 범례/셀 label로 노출한다. 기존 168 버튼과 roving focus·키보드 이동은 유지한다.
- [x] **RED 실행:** 두 focused 테스트 파일에서 새 axis/기간 테스트 2개가 UI 부재로 실패했다.
- [x] **GREEN 구현:** 기존 카드 header·범례·스크롤 그룹 안에 축 이름/시간 눈금/요일 라벨을 배치했다. 상세 순위 차트에 kWh 세로축 label·YAxis unit을 추가하고 별도 안내 panel은 만들지 않았다. metric 전환 시 0 범례 단위를 바꾸며 `null` dashed/missing, 숫자 0은 0단계를 유지한다.
- [x] **GREEN 실행:** `pnpm --filter @led-control/web exec vitest run src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx src/features/statistics/analysis/EnergyHeatmap.test.tsx --reporter=dot` 2 files·12/12 통과. 7×24 버튼·roving focus·keyboard 이동 기존 테스트도 포함한다.

### Task 3: 보고서 완료 파일 만료 메타 검증·보완

**Files:**
- Modify: `apps/web/src/features/statistics/reports/ReportJobTable.tsx`, `ReportJobList.tsx`, `StatisticsReportsPage.tsx`, `report-job-view-model.ts`
- Modify: `apps/web/src/features/statistics/reports/StatisticsReportsPage.test.tsx`, `report-job-view-model.test.ts`

**Interfaces:** 보고서 `expiresAt` 값과 상태, 기존 targets query의 `timeZone`을 읽기만 한다. 이미 있는 table/card 메타를 재사용하며 새 API·별도 팝오버는 없다. targets 실패 시 기기 시간대를 명시하고 기존 목록 기능은 유지한다.

**Ruling:** 요청일 필터는 현장 현지 날짜인데 이력 시각은 기기 시간대로 무표기되어 필터 날짜와 행 날짜가 달라질 수 있었다. 이미 조회 중인 targets의 `timeZone`을 목록 포맷에 전달하고, targets가 없을 때만 명시적 기기 시간대 fallback을 사용한다. 잘못 판단했다면 필요한 후속 변경은 보고서 목록 응답에 timezone을 포함하는 공유 API 계약 변경이다.

- [x] **RED/현황 테스트:** 완료 row/card에서 `파일 만료 시각` 라벨과 원본 ISO를 가진 `<time dateTime>`이 접근 가능하고 대기/실패는 해당 메타가 없는지 검증했다. table/card의 시각 값과 mobile `<dt>/<dd>`·`<time>`은 이미 있었고 table header의 `파일` 문구만 부족했다.
- [x] **테스트 실행:** `pnpm --filter @led-control/web exec vitest run src/features/statistics/reports/StatisticsReportsPage.test.tsx src/features/statistics/reports/report-job-view-model.test.ts --reporter=dot`; 새 table header 기대가 기존 `만료 시각`에 대해 RED였다.
- [x] **최소 보완:** table header를 카드와 같은 `파일 만료 시각`으로 맞췄다. 완료/만료 정책과 기존 action/status mapping·시간 포맷은 변경하지 않았다.
- [x] **GREEN 실행:** 같은 focused Vitest 2 files·56/56 통과. 기존 다운로드/재생성 회귀 포함.
- [x] **추가 RED:** `America/Los_Angeles` 현장의 요청/만료 시각이 UTC 날짜와 다른 전날로 표시되고 목록에 시간대 출처가 있어야 한다는 테스트 2개가 기존 브라우저 시간대 표기로 실패했다.
- [x] **추가 GREEN:** 기존 targets 응답의 현장 `timeZone`으로 요청/만료 `<time>` 표시를 포맷하고 목록 상단에 현장/기기 시간대 출처를 짧게 표시했다. 같은 focused Vitest 2 files·58/58 통과.

### Task 4: 문서·통합 검토·총괄 인계

**Files:**
- Modify: `docs/menus/statistics.md`
- Modify: 이 계획 파일

- [x] 각 Task의 RED/GREEN 결과와 실제 product diff를 검토하고 개요·분석·보고서의 period/source/axis/expiry 구현 사실 및 한계를 `구현 완료`/`부족하거나 개선이 필요한 기능`/`관련 파일`에 기록했다.
- [x] 담당 scope focused Vitest를 직렬로 재실행해 11 files·112/112 통과했고 `git diff --check -- apps/web/src/features/statistics docs/menus/statistics.md`가 exit 0임을 확인했다. 공유 checkout의 다른 담당자 dirty files는 건드리지 않았다.
- [x] 총괄에게 변경 파일, 테스트 명령/개수/결과, 이미 충족된 요구와 새 구현의 구분, Playwright·typecheck/build 미실행, HIL 미실시를 보고했다. stage/commit/merge는 하지 않았다.

### 리뷰 후속: 차트 경고 공간과 320px KPI 밀도

**Files:** `StatisticsOverviewPage.tsx`, `StatisticsOverviewPage.test.tsx`, `apps/web/e2e/statistics-flow.spec.ts`, `docs/menus/statistics.md`.

- [x] **RED:** 차트 헤더에 결측·수집 공백을 표시하고 차트 아래 별도 경고 블록이 없어야 한다는 테스트가 기존 구현에서 1개 실패했다.
- [x] **GREEN:** 공통 `StatusBadge`를 차트 헤더의 제목 옆에 두고 상태별 짧은 라벨과 접근성/hover 설명을 제공한다. 기존 차트 툴팁·스크린리더 기간별 목록은 유지하며 하단 경고 블록을 제거했다. 같은 UX 기준에 따라 별도 수직 블록이던 KPI 수집 공백 안내도 페이지 헤더 배지로 이동했다. 두 변경은 각각 RED를 확인한 뒤 `StatisticsOverviewPage.test.tsx` 20/20 통과했다.
- [x] **브라우저 게이트 추가:** 320px에서 세 KPI helper의 최대 3줄·카드 높이 230px 이내·카드와 문서 가로 넘침 부재·하단 경고 블록 부재를 확인하는 `statistics-flow.spec.ts` 검사를 추가했다. 이후 기존 Vite 5173에 연결한 Chromium 전체 27/27에서 해당 검사도 통과했다.
- [x] 통계 전체 focused Vitest 11 files·113/113, 해당 화면 scoped UI policy `[]`, 소유 변경 파일 `git diff --check` exit 0을 확인했다. 총괄에게 초기 브라우저 테스트 미실행 상태를 별도 보고했다.

### 브라우저 게이트 후속: 보고서 상세 필터 locator

- [x] **RED/원인:** `statistics-flow.spec.ts`의 보고서 이력 반응형 네 viewport가 `filters.getByRole("button", { name: "범위" })`에서 모두 실패했다. 실제 locator는 숨겨진 범위 SelectBox가 아닌 보이는 `범위: 현장 조건 제거` chip에 해석됐다.
- [x] **GREEN:** 상세 필터 DOM 그룹 안에서 `exact: true`와 `includeHidden: true`로 형식·범위 SelectBox를 특정하고, 동일 locator를 숨김 검증과 펼친 뒤 터치 대상 검사에 재사용한다. 공통 `chooseOption`도 정확한 버튼 이름만 선택한다. 네 viewport focused Chromium 4/4, 같은 파일 전체 Chromium 27/27 통과했다.
- [x] 총괄에게 변경 내용과 브라우저 재실행 결과를 보고했다. stage/commit/merge는 하지 않았다.

## Self-review

- [x] API·shared·집계 계산·파일 만료 정책은 변경하지 않았다. 화면 설명과 `no_data` 차트 표시 정규화만 변경했다.
- [x] 기간 경계와 숫자 출처를 각 화면의 실제 응답 필드로 도출했다.
- [x] 히트맵 168셀/키보드, 보고서 다운로드·상태 계약을 유지했다.
- [x] 공통 컴포넌트/기존 카드 메타를 재사용했고 중복 설명 블록을 만들지 않았다.
- [x] Mock/자동 테스트와 미실행된 실장비 검증을 구별했다.

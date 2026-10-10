# Task 7 통계 표현 교정 결과

- checkout: `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-fidelity-statistics-20261010`
- branch: `codex/atlas-fidelity-statistics-20261010`
- BASE: `a97e2563df7b11bac2a03eebdeb9c7b6e914a01b`
- commit: `4d3cda30bc4e3c25322e084ada1fce1da0226249` (`feat(web): align statistics views with Atlas fidelity`)
- 소유 범위14파일만 commit, clean status. API/shared/공통/다른 메뉴·root 계획/status 변경 없음. 새 에이전트/리뷰어·브라우저·실제5173/4000·job 생성/다운로드 없음.

## 34행 교정/보존 mapping

원 감사: `/tmp/atlas-fidelity-audit.xPPSOZ/statistics.md`. 소스 약어는 `F=apps/web/src/features/statistics`. 원 감사의 정확 mock/current 행과 대조해 다음 상태로 처리했다. `교정`은 현재 소스와 단위 검사 결과이며 실 화면 승인으로 확대하지 않는다.

| ID | 상태 | 실제 처리/보존 근거 |
| --- | --- | --- |
| T01 V | 교정·공통 후속 일부 대기 | `F/StatisticsOverviewPage.tsx:46` 공통 h1의 제목을 사용량 개요로 변경하고 보고서 이동 CTA 추가. 현재 query/hash 보존, 진입 mutation 없음. 공통 eyebrow는 root 후속. |
| T02 P | 보존 | summary/comparison/custom/series hooks·완료1~400일·독립 day/month·현장 timezone·scope epoch 불변. |
| T03 V | 교정 | `F/StatisticsOverviewPage.tsx:431` 비교 날짜를 filter summary 한 곳에 표시, summary left/trigger right. 추이 단위는 header, 자체 날짜는 원래 별도 caption으로 유지. |
| T04 P | 보존 | 실제 완료기간 KPI와 오늘/월/년누적3개; 부족/null/0 상태와 모든 query 불변. |
| T05 V | 교정 | `F/StatisticsOverviewPage.tsx:412` 비교 chart full-width + 비교 panel 아래. `F/PeriodComparisonPanel.tsx:15` compact2열 직전/전년, coverage 유지. |
| T06 V | 교정 | `F/EnergyComparisonChart.tsx:64` 같은 baseline-muted line, 같은 observed 데이터 area+line, forecast dashed. area tooltip 중복 제외, legend 아래. |
| T07 P | 보존 | 비교 phase/null/connectNulls=false·고립점/forecast 분리, tooltip와 SR 원본 목록·테마identity 유지. |
| T08 P | 보존 | 독립 loading/error/retry·saving/overuse/no fixture/low coverage/unavailable 원 branches 유지. |
| T09 N | 보존 | 직전/전년 동기간 증감·양 coverage·조명구성 미보정 유지, 아래 compact panel로 표현 이동. |
| T10 P | 보존 | summary generatedAt/lastAggregatedAt·당일범위·당시단가 저장비용과 현재단가 전망 구분 그대로. |
| T11 V | 교정 | `F/StatisticsOverviewPage.tsx:182` 실제 baseline/forecast2막대 공통 최대비용 scale; 0의 width0, 기준초과 비율과 signed 절감 유지. 반복 row는 map으로 재사용. |
| T12 V | 교정 | `F/StatisticsOverviewPage.tsx:292` cost/quality desktop1:1·모바일stack, `F/StatisticsOperationalInfo.tsx:15` label/value rows 압축. |
| T13 P | 보존 | 실제 알려진시간/공백초·nullable 집계시각·기준조명수만 사용. 목업 표본·수집시간·층별절감 없음. |
| T14 P | 보존 | summary/series 독립 loading/error/retry/all-null/knownSeconds0/partial gap 유지. |
| T15 V | 교정 | commonBASE의 분석 h1 소비, `F/analysis/StatisticsAnalysisPage.tsx:79` 단독Card 제거·flat summary/trigger toolbar. |
| T16 P | 보존 | dimension/metric/sort/date/limit20·실제 querykey/동작 그대로. 가상층 filter/TOP5 미추가. |
| T17 N | 보존 | 실제 현장KPI·저장비용·그룹중복·legacy 안내 유지, 모바일 결과 우선 order 그대로. |
| T18 V | 교정 | `F/analysis/EnergyRankingList.tsx:24` 실제 최대값 scale(1kWh 바닥 없음), width0/null bar없음·muted2자리 번호·기본neutral/selectedsoft. |
| T19 P | 보존 | empty/unranked disclosure·reason/nullmetric·selected identity/조건/site reset 유지. |
| T20 V | 교정 | `F/analysis/EnergyRankingDetailPanel.tsx:20` usage/cost2KPI + 실제 contribution/change/coverage dl. null/0 neutral, 증가danger/감소success. |
| T21 N | 보존 | 실제 detail dailyPoints chart·조명구성slice8·현장 기여도의 실제 분모 유지. |
| T22 P | 보존 | rankings/heatmap scope/range/dimension/metric/sort response guard 및 stale-value 차단 그대로. |
| T23 P | 보존 | EnergyHeatmap 수정0;168cells/44hit/24h/rovingfocus/내부scroll/0·—/palette/strongborder 그대로. |
| T24 P | 보존 | heatmap loading/error/all-null·metric popup 수명/coverage/localDays/selection 그대로. |
| T25 V | 교정 | `F/reports/StatisticsReportsPage.tsx:305` flat검색/filter/CSV toolbar·Grid 영역. 기존 ReportHistoryFilters를 그대로 재사용, CSV는 기존createDialog만 열음. |
| T26 P | 보존 | ReportHistoryFilters 변경0; searchdebounce/status/scope/requestedDate90days/limit/chips/reset 그대로. |
| T27 P | 보존 | invalidURL/raw date·query silence·cursor/history·retainedlist/retry/focus restoration 그대로. |
| T28 P | 보존 | ReportJobList/DataGrid 변경0; 실제 fields·sort현재목록·mobiletarget/action/status 우선 그대로. |
| T29 N | 보존 | 보고서이름/목업preview/데모완료 미추가. 실제createform/download 그대로. |
| T30 P | 보존 | ReportCreateDialog 변경0; 완료일/범위/validtarget·pending/error·CSVcancel/handoff 그대로. |
| T31 N | 보존 | 5job상태/progress/failure disclosure·completeddownload/failedexpiredregenerate 그대로. |
| T32 P | 보존 | activepolling/liststate/retry/regenerate 원request·invalidation 그대로. |
| T33 P | 보존 | freshsignedURL/PDFbytes/browser/native/site/document/unmountcancel·중복잠금/error 구분 그대로. |
| T34 N | 보존 | 실제CSVendpoint/blob/abort/document identity·원 날짜/대상 전달 그대로. |

## 검증·실패 이력

TDD/writing-good-tests/verification 및 해당 AGENTS를 읽었다. runtime PATH는 `/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH`, Node22.20.0/pnpm9.15.0 확인(설치반복0). 초기 PATH 미설정 read-only 확인은 Node24.19였으며 실제 모든 테스트는 지정22 PATH에서 실행했다.

새계약 RED: 아래5파일의 선택표현 `-t 'draws collected zero|keeps a .* previous change|renders the real baseline|opens the existing target|offers report navigation|shows ranked usage'`로 실행 → exit1,8FAIL/1PASS/142비선택 (`task-7-red.log`). rank0/null·coverage/null0tone·baseline/area·페이지명/CTA·CSV entry가 없는 실제제품 상태에서 실패. commonBASE h1 때문에 기존 분석 제목 케이스는 통과였다. 수정후 동일표현 → exit0,9PASS/142비선택 (`task-7-green-focused.log`).

작은 수치 scale 추가 RED: `pnpm --filter @led-control/web exec vitest run src/features/statistics/analysis/EnergyRankingList.test.tsx -t 'compares small collected'` → exit1,1FAIL/5비선택 (`task-7-small-red.log`). 당시 최소max1 때문에0.25/0.125가25%/12.5%로 그려졌고 실제최대값을 사용해100%/50%로 교정했다. 최종 consumer에서 해당 case도 GREEN.

최종 명령:

```sh
PATH=/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH pnpm --filter @led-control/web exec vitest run src/features/statistics/StatisticsOverviewPage.test.tsx src/features/statistics/EnergyComparisonChart.test.tsx src/features/statistics/PeriodComparisonPanel.test.tsx src/features/statistics/StatisticsOperationalInfo.test.tsx src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx src/features/statistics/analysis/EnergyRankingList.test.tsx src/features/statistics/reports/StatisticsReportsPage.test.tsx src/features/statistics/reports/ReportHistoryFilters.test.tsx
```

- 최종 exit0,8파일171PASS/0FAIL/0SKIP,12.08초 (`task-7-consumers-green-final.log`). 기존 DTO/query/날짜/수집부족/음수절감/theme identity/PDF·CSVcancel/freshsignedURL/job진행 경계를 직접 소비자에서 유지했다. 엄격한 잘못된 URL 세 사례의 예상 ZodError stderr가 남으며 테스트 실패가 아니다.
- 중간 consumer 기록은 보존: `task-7-consumers.log` exit1 168PASS/2FAIL(과거Card/세로배치 class 단언), `task-7-consumers-green.log` exit1 170PASS/1FAIL(열린popover 뒤 inert trigger query에 hidden 미지정), `task-7-consumers-final.log` exit1 170PASS/1FAIL(날짜줄에 단위prefix를 추가해 기존 날짜-only 계약 위반). 구조 단언은 실제 필터 접근으로 대체, hidden은 실제 inert상태에 맞게 조회, 단위label은 header로 이동해 원 날짜-only 단언을 유지했다. 기존 실패 원인을 숨기는 skip/timeout 완화0.
- `git diff --check` exit0. docs/menus/statistics.md를 같은 commit에서 갱신했다. 전체 Web/583/canonical/Lab/E2E/type/UI/build·browser matrix는 승인 LEAN에 따라 미실행, root 최종11에 위임한다. 단위 fixture 성공은 실제 API/저장소/native OS/HIL 또는 시각 승인이 아니다.
- 모든 로그는 이 report와 같은 canonical ignored scratch의 `task-7-*`에 보존했다. 공통 eyebrow slot·통계 소비는 root 공통 후속이며 이 Task에서 복제 wrapper나 공통 확장을 하지 않았다. 같은 조건 filterReset 표현/flat toolbar와 실제390/562 모바일 높이·ratio/legend는 최종 시각 관문에서 확인 필요하다.

## 인계

root가 통합 전 source/commit diff를 검토하고 `4d3cda30bc4e3c25322e084ada1fce1da0226249`를 cherry-pick할 수 있다. 분석/개요 공통 h1은 BASE에 있었고 본 작업은 통계 feature와 메뉴 문서만 변경했다. root 단독 공통 eyebrow 후속 및 Task11의 실 화면/최종 검증과 Task12 통합 완료 주장은 남겨둔다.

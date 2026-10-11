# Task 1 — 공통 UI·통계 결과

- 역할 web_frontend, 단독 product writer. 기준 c48cc224, 공통 commit `fe1a17c5`, 통계/회귀 보강 commit `16b6c032`.
- TDD 및 writing-good-tests reference를 적용했다. 사용자 LEAN 지침에 따라 직접 변경/소비 단위만 실행했다. subagent·별도 reviewer·서버·browser·전체suite·최종 type/UI/build·원격/장비 작업은 실행하지 않았다.
- C8 `StatisticsOperationalInfo.tsx`와 해당 test의 diff는 0이다. 기존 raw seconds/null/0 검증도 그대로 2PASS.

## 변경 범위

- `PopoverProps.mobilePresentation?: "popover" | "bottom-sheet"` 기본 popover. FilterPanel의 기존 popover mode는 모바일에서 React Aria ModalOverlay/Modal/Dialog로 하단 sheet를 표시한다. 760px 경계·safe-area·최대 viewport 높이/scroll·감소 motion·overlay 등록·pending dismiss lock을 유지한다. desktop 기존 popup이다.
- `DataGridProps.compactColumnIds`, `renderRowDetails`, `getRowDetailsLabel` 계약 그대로 구현. 카드 요약 열은 caller 순서, 상세는 stable getRowKey 내부 set과 useId/연결된 ARIA로 제어한다. 표에서는 다음 colspan row, 카드에서는 같은 항목 아래에 펼친다. 미지정 소비자 동작은 기존과 같다.
- 공통 날짜는 실제 CalendarDays SVG·square 44px trigger, date segment 텍스트 폭/44px 높이·inset focus. DateRange는 flex-wrap 제거. raw draft/controller·bounds·RAC keyboard/screenreader/date semantics 불변, TimePicker의 기존 segment geometry 유지.
- 개요 중복 빠른 기간/정상 기간 helper/절감 badge/긴 estimate·baseline caption 제거, 제목/기간/필터 한 행. 분석 요약은 기간만. 세 실제 차트는 caption token/최소 tick 간격을 공유한다. 데이터/tooltip/null/테마 identity 불변.
- 보고서는 기존 스케줄/event와 같은 DataGrid를 사용한다. 카드 요약 대상/상태/기간/작업, 각 행의 인라인 상세에 범위/요청·만료시각/실패안내를 제공한다. 생성 CTA, 5상태, polling, download/retry/regenerate/expiry/viewer의 페이지 owner를 변경하지 않았다.
- 네 메뉴 문서에 짧은 공통 교정 기록을 추가하고 통계 소비 변경을 통계 문서에 별도 기록했다. checklist/project-status는 총괄 소유로 stage/commit하지 않았다.

## RED → GREEN 및 command

모든 실행은 worktree root에서 `PATH=/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH pnpm --filter @led-control/web exec vitest run ...`으로 실행했다.

1. DataGrid 초기1FAIL/기존12PASS: 중복 `queryByText` 에러를 `queryAllByText`로 바로잡은 뒤 실제 요약 열 미지원 실패를 확인했다.
2. `src/components/ui/{DataGrid,FilterPanel}.test.tsx`: 실제 RED2(요약열/모바일 modal semantic), 22PASS. Grid 구현 뒤13PASS. RAC Dialog가 aria-modal prop을 필터링하여 sheet 첫 GREEN 시도는1FAIL; 기존 DialogBase와 같은 public render composition으로 고쳤다.
3. `src/components/ui/date/DateRangePicker.test.tsx src/features/statistics/reports/ReportJobList.test.tsx src/components/ui/FilterPanel.test.tsx`: RED2(실제 icon 부재/보고서 기존7열 요약), 47PASS → GREEN49PASS.
4. `src/features/statistics/StatisticsOverviewPage.test.tsx src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx`: RED4(기존 caption/빠른기간/긴 baseline/분석 요약), 41PASS → 구현 후45PASS.
5. `src/features/statistics/EnergyComparisonChart.test.tsx`: RED1(실제 SVG tick font-size 없음), 6PASS → caption token 적용 후7PASS.
6. `src/components/ui/DataGrid.test.tsx src/components/ui/FilterPanel.test.tsx src/components/ui/date/DateRangePicker.test.tsx src/components/ui/date/date-components.test.tsx`: 4파일116PASS/0FAIL. 이후 실제 표 정렬 stable key와 mobile select/lock 회귀를 보강하여 변경된 두 파일 재실행26PASS/0FAIL(최종13+13). DateRange34/date-components58과 합쳐 공통 고유118개 통과.
7. 보고서 소비자 첫 실행5FAIL/기타194PASS: 기존 상시 metadata·실패전용toggle 단언이 새 인라인 상세 계약과 달라졌다. 실제 action/시각/권한 검증은 보존하고 해당 행을 펼친 뒤 검사하도록 수정했다. 다음 실행1FAIL/102PASS은 timezone 검사도 상세를 열지 않은 원인이었고 동일 방식으로 교정했다. invalid URL의3 ZodError stderr는 기존 의도한 거부 경계이며 숨기지 않았다.
8. 최종 통계 command: `src/features/statistics/StatisticsOverviewPage.test.tsx src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx src/features/statistics/EnergyComparisonChart.test.tsx src/features/statistics/reports/ReportJobList.test.tsx src/features/statistics/reports/StatisticsReportsPage.test.tsx src/features/statistics/StatisticsOperationalInfo.test.tsx src/features/statistics/analysis/EnergyRankingDetailPanel.test.tsx src/features/statistics/reports/ReportHistoryFilters.test.tsx` → 실제 매칭7파일169PASS/0FAIL/exit0. RankingDetailPanel 독립 test 파일은 없어 선택되지 않았으며 실제 chart/theme는 analysis 소비자17개에서 검증했다. 허위8파일 통과로 기록하지 않는다.
9. `git diff --check` exit0, C8 source/test diff0. source commit 뒤 product 수정은 없다.

## 자체 검토·후속 한계

- stable key/표 정렬/반응형 전환과 실제 job action 대상, 0/null/음수절감, invalid raw date owner, 중첩 날짜·select와 모바일 pending lock을 직접 검증했다. 총 고유287개(공통118+통계169)이며 최종HEAD에서 단일 전체명령으로287개를 다시 실행한 것은 아니다.
- 승인된 날짜 예외: 6개 digit segment+calendar를 모두 개별44px 폭으로 놓으면320px 한 줄이 불가능하다. digit는 텍스트 폭이며 group/달력/일반 버튼의 높이/hit를 유지한다. 코드 주석·네 문서에 이유를 적었고 모든 digit 개별44폭이라고 주장하지 않는다.
- 승인된 제목 예외: PC에서 제목/기간/필터 한 행이며 모바일은 완전 기간/제목이 필요하면 내부 줄바꿈을 허용한다. 숫자 생략·가로 page overflow를 해결했다고 browser evidence 없이 주장하지 않는다.
- QA 잔여: 짧은320/390 sheet 마지막동작과 fixednav/safe-area, 실제 slide/reduced motion, date 한줄/keyboard/touch·inset focus, 577px 보고서 summary/detail/양테마, 실차트축충돌/긴 숫자. 최종 type/UI policy/build와 browser는 총괄의QA 후속 범위다.
- 기존 SettingsShell baseline1FAIL·큰 chunk 경고·실계량기/native/HIL 한계는 이번 작업에서 수정/검증하지 않았다.

## 최종 정적 관문 국소 수리

- 수리 commit/source `437ebc39`, tracked checkout clean.

- QA source `77f8608f`의 fresh type/build는 exit0이나 UI check1·policy78PASS/1FAIL: `Popover.tsx`의 `rounded-t-panel`은 정책이 승인한 token utility가 아니었다. 원 증거는 task-4-raw/ui-check.log와 QA policy log에 보존한다.
- 단독 파일 `Popover.tsx`에서 승인 `rounded-panel`을 사용하고 bottom 두 radius만 inline `0`으로 고정했다. 이 값은 viewport 하단 flush geometry이며 새로운 디자인 radius가 아니다. 동일 policy parser는 `rounded-b-none`도 미승인 name으로 읽으므로 이를 쓰지 않았다. 총괄의 해당0값 승인과 이유를 코드 주석에 명시했다. top token/모바일 anchor/animation/portal/modal/focus·C8·다른 제품 source·policy/debt/token은 변경하지 않았다.
- 실행: `PATH=/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH pnpm --filter @led-control/web exec vitest run src/components/ui/FilterPanel.test.tsx src/components/ui/date/DateRangePicker.test.tsx` → 2파일47PASS/0FAIL/exit0(13+34). `git diff --check` exit0. QA 정적 전체·build/browser는 실행하지 않았으며 QA가 새 source에서 재개한다.

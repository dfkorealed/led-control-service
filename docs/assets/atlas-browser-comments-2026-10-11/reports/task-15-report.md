# Task 15 — 통계 헤더·보고서 필터 결과

- 기준: `codex/atlas-browser-comments-20261011`, 시작 HEAD `261502d4`. 승인된 통계 소유 범위만 수정했다.
- 제품 5파일: `StatisticsOverviewPage.tsx`, `analysis/StatisticsAnalysisPage.tsx`, `reports/{StatisticsReportsPage,ReportHistoryFilters,ReportJobList}.tsx`.
- 테스트 3파일: `StatisticsOverviewPage.test.tsx`, `analysis/StatisticsAnalysisPage.test.tsx`, `reports/StatisticsReportsPage.test.tsx`. 기존 `ReportHistoryFilters.test.tsx`는 수정 없이 직접 영향 회귀로 실행했다.
- 문서: `docs/menus/statistics.md`. 다른 메뉴/계획/상태판/common/API/DB 파일은 수정하지 않았다. QA의 `apps/web/e2e/atlas-ui-fidelity.spec.ts` 변경은 stage하지 않는다.

## 반영 내용

- 세 페이지의 ENERGY eyebrow 제거, 개요 표시 제목·보고서 바로가기 제거와 단일 `sr-only` h1 유지. 분석·보고서 PageHeader와 보고서 만들기 진입을 유지했다.
- 검색에 공통 SearchField를 사용하고 CSV 진입을 report 필터의 actions로 전달해 기존 FilterPanel compact/actions/reset 8px 간격·줄바꿈을 사용했다. 상세 필터 초기화와 전체 초기화의 기존 의미를 유지한다.
- 목록 시간대 caption과 빈 caption wrapper를 제거했다. formatter/timeZone/원 ISO time, 생성·다운로드·CSV 취소, null/0, 검색 debounce/raw 날짜 draft/cursor/scope epoch 로직은 변경하지 않았다.

## 실제 검증

모든 명령은 `PATH='/tmp/atlas-ui-fidelity-node22.xde1wS/bin':$PATH`로 primary worktree에서 실행했다.

```sh
pnpm --filter @led-control/web exec vitest run src/features/statistics/StatisticsOverviewPage.test.tsx src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx src/features/statistics/reports/StatisticsReportsPage.test.tsx -t 'keeps a single accessible overview|shows ranked usage and opens|opens the existing target and period dialog from CSV entry|groups CSV entry|preserves the.site.s timezone for report metadata'
```

- RED: exit 1, 3 files / 5 failed / 135 filtered skipped. 개요 h1이 sr-only가 아님, 분석·보고서 ENERGY 존재, CSV가 이력 검색 영역 밖, 목록 시간대 caption 존재로 각각 실패했다. 테스트 수집/환경 오류가 아니다.
- 구현 뒤 같은 command GREEN: exit 0, 3 files / 5 passed / 135 filtered skipped. filtered skipped는 실행하지 않은 다른 test이며 전체 통과 수에 포함하지 않는다.

```sh
pnpm --filter @led-control/web exec vitest run src/features/statistics/StatisticsOverviewPage.test.tsx src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx src/features/statistics/reports/StatisticsReportsPage.test.tsx src/features/statistics/reports/ReportHistoryFilters.test.tsx
git diff --check
```

- 직접 영향 회귀 exit 0, 4 files / 155 passed / 0 failed / 0 skipped, 10.86초. 개요 28·분석 16·보고서 96·필터 15개.
- reports의 기존 잘못된 status/limit URL strict 거부 테스트는 예상 ZodError와 React stderr를 출력했다. assertion 실패·unhandled test failure는 없다. stderr가 없는 run으로 기록하지 않는다.
- `git diff --check` exit 0.

## 한계와 전달

- 전체 Web/canonical/type/UI policy/build/browser를 실행하지 않았다. 실제 모바일 화면은 QA의 통합 7case에서 검증한다. 실제 API/native 파일 저장·운영·HIL 검증이 아니다.
- 신규 common primitive/slot·API/DTO/jobs/download lifetime 변경이 없다.
- 커밋: `e9d72b91675bf8a179e33d1b3a1b8143ff34142b` (`fix(web): simplify statistics headers and report toolbar`), 제품·직접 테스트·메뉴 문서 9개 파일 / 63삽입·33삭제. commit exit 0. 이후 status에는 QA 소유 `apps/web/e2e/atlas-ui-fidelity.spec.ts`만 modified로 남아 있다.

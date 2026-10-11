# 브라우저 조작·필터·반응형 교정 실행 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 총괄은 결과 취합과 체크리스트만 갱신한다.

**Goal:** 신규 브라우저 주석 21건 중 운영 인사이트(C8)를 제외한 20건을 기존 화면에 반영한다.

**Architecture:** 공통 날짜·필터 overlay·표의 선택적 행 확장을 통계 담당 한 명이 먼저 구현한다. 수동 지도 담당과 모니터링 담당은 고정된 공통 계약을 순차 소비하며 기존 API와 상태 소유자는 유지한다.

**Tech Stack:** React, TypeScript, React Aria, Recharts, DOM pointer 입력, Vitest, Playwright.

**Spec:** 대화의 21개 Browser comments 및 2026-10-11 사용자 승인: “운영 인사이트는 일단 그대로 진행하고 나머지만 변경”. 앞선 인사이트 4항목 제안은 채택하지 않는다.

## Global Constraints

- C8 운영 인사이트의 내용·계산·표시는 변경하지 않는다.
- 현재 API/DB/shared/권한/dispatch UUID/ACK/보고서 job 계약은 변경하지 않는다. 실제 0/null/음수 절감과 수집 공백을 숨기지 않는다.
- 기존 light/dark 토큰과 공통 UI를 사용한다. 새 제품 dependency는 추가하지 않는다.
- 최소 연속 44×44px 조작 영역과 키보드 focus/닫기 복귀/overlay dismiss lock을 유지한다. 모바일 safe-area와 fixed bottom navigation을 고려한다.
- 날짜 숫자 segment는 C3 한 줄 요구 때문에 고정52px 폭 대신 텍스트 폭을 사용한다. 날짜 group 높이와 달력/일반 버튼44px 영역은 유지하며, 숫자 segment 개별44px 폭은 문서화된 예외다.
- 수동 지도 새 제스처는 manual-only opt-in이다. 편집기·모니터링·embedded 지도 기본 동작은 보존한다.
- PC middle drag pan / left click toggle / left drag area, touch swipe pan / tap toggle / touch area 없음. 휠 회전 zoom과 pinch를 유지한다.
- 이름/번호 검색은 현재 이름 문자열에 포함된 번호와 실제 불러온 목록 대상이다. 기존 다음 페이지/부분 오류 안내를 유지하고 전체 서버 검색으로 표현하지 않는다.
- 관련 메뉴 문서의 5개 현황 구성을 유지한다. 공통 필터 영향으로 네 메뉴 모두 갱신한다.
- 단독 product writer, 변경 unit + 한 번의 Web type/UI policy/build + 필요한 실제 browser 사례 + 최종 통합 review만 수행한다. 이전 whole suite/대형 matrix/Lab/HIL은 재실행하지 않는다.
- 기준 cc6b9a7a, branch codex/atlas-interactions-comments-20261011. 기존 5173/4000/63200, 다른 worktree/stash/원격/실장비는 변경하지 않는다.

## Review Focus

- 하단 필터와 그 안의 달력/select 중첩 overlay: 실제 닫기/포커스 복귀와 짧은 화면 마지막 동작 도달.
- 날짜 segment focus: 외곽선 간섭 없음, 긴 날짜와 320–390px에서 한 줄/수평 overflow 없음.
- marker 시작 drag와 8px 경계: pan 이후 tap이 잘못 토글하지 않으며 cancel/pinch/잠금에서 area dispatch 없음.
- 보고서 job polling/행 정렬/필터 변화: 상세 row key와 action 대상이 바뀌지 않으며 viewer 다운로드와 재생성 권한 유지.
- 전부 offline/빈 목록/부분 page: 모든 지도 범례와 실제 다음 목록·미배치 조명 상세 예외 유지.

## Checklist

- [x] 읽기 전용 페이지별 감사 및 인사이트 제외 승인.
- [x] 격리 worktree/frozen offline install/workspace prepare.
- [x] Task 1 공통 UI + 통계 페이지 (`fe1a17c5`, `16b6c032`, 직접 고유287PASS; browser/최종 review 별도).
- [x] Task 2 수동 제어 지도·툴바 (`195974a7`, 최종 직접5suite295PASS; 실제 입력/geometry browser 후속).
- [x] Task 3 헤더·모니터링 통합 검색 (`9ba48ee7`, 직접 scope 마지막 실패 case까지 국소GREEN; 한 번의 전체최종batch PASS 아님).
- [ ] Task 4 한정 검증·실제 browser.
- [ ] Task 5 최종 통합 검토·필요 수리.
- [ ] Task 6 로컬 통합·증거 보존·정리.

### Task 1: 공통 UI와 통계 소비자 (C1–7, C9–11, C17–18)

**Files:** components/ui/{FilterPanel,DataGrid}.tsx 및 tests; components/ui/overlays/Popover.tsx 및 필요한 overlay helpers; components/ui/date/{DatePicker,DateRangePicker,date-field}.tsx 및 tests; features/statistics/{StatisticsOverviewPage,StatisticsAnalysisPage,EnergyComparisonChart,EnergyRankingDetailPanel}.tsx 및 tests; reports/ReportJobList.tsx/test; docs/menus 네 파일.

**Interfaces:** `PopoverProps.mobilePresentation?: "popover" | "bottom-sheet"` (기본 popover); FilterPanel popover는 bottom-sheet 소비. `DataGridProps<T>.compactColumnIds?: readonly string[]`, `renderRowDetails?(row: T, surface: DataGridSurface): ReactNode`, `getRowDetailsLabel?(row: T): string`. 미지정 소비자는 현재 동작 그대로, 상세 toggle state는 stable getRowKey 기반 내부 소유.

- [ ] RED: 필터 모바일/desktop overlay 및 focus/lock, 날짜 한 줄/segment inset/icon, optional Grid 요약열·아래 상세·정렬 후 key를 검증하는 focused test를 먼저 실행한다.
- [ ] 구현: bottom-sheet는 모바일 viewport 하단 붙임/slide-up(감소된 motion 고려), safe-area/overflow 내 닫기 도달. 실제 React Aria modal/portal/등록 owner를 유지하고 중첩 달력 dismiss가 부모를 닫지 않는다.
- [ ] 구현: 날짜 range flex-wrap 제거, segment inset과 실제 Calendar 아이콘/작은 시각 trigger. 공통 44px hit와 date validation/controller 수명 유지.
- [ ] 구현: DataGrid 카드에서 compactColumnIds만 표시, 모든 row의 “상세보기” 아래 detail 확장. table에서도 같은 action으로 colspan detail row; 펼침 label/aria-expanded/aria-controls/고유 ID 제공.
- [ ] 구현: 보고서 요약은 대상·상태·기간·작업; detail은 범위·요청/만료 시각·실패 안내. 기존 job actions/loading/poll/download/retry/expiry/viewer는 보존.
- [ ] 구현: 개요 빠른 기간/helper/절감 badge/긴 caption 제거, 제목+기간+필터 한 row; 분석 summary는 기간만. 개요 운영 인사이트는 원문 그대로.
- [ ] 구현: 실제 3곳 chart axis의 공통 tick/간격 규칙을 적용하여 작은 화면의 x/y 충돌 방지; data/tooltip/null gaps를 바꾸지 않는다.
- [ ] GREEN: 변경 직접 unit 실행, 날짜/표/filters의 소비 회귀, 네 메뉴 docs 갱신, diff check, 소유 파일만 commit. command/RED/GREEN/실제 source/한계 기록.

### Task 2: 수동 지도·툴바 (C13–16)

**Files:** features/floor-map/{FloorMapViewport,FloorScene}.tsx 및 해당 tests, features/control/{ControlView,SpatialTargetSelector,TargetSelectionToolbar}.tsx 및 tests, docs/menus/control.md.

**Interfaces:** `FloorMapViewportProps.toolModePolicy`의 기존 union에 `"manual-cad"` 추가, manual-workspace만 사용. 기존 `interactionPolicy`/area callbacks/좌표 변환/카메라 소유자는 유지.

- [ ] RED: manual mouse middle/left routing, 7/8px 임계, marker 시작 swipe→pan/no-toggle, touch long hold area 없음, cancel/Escape/lostcapture/pinch/lock, 기본 지도 정책 불변을 테스트한다.
- [ ] 구현: manual-cad policy로 PC middle/Space pan, left marquee, touch pan. pointerup marker 직접선택과 capture click 억제를 일관되게 연결하고 keyboard/detail=0 선택은 보존한다.
- [ ] 구현: 이동/개별/영역 tool UI와 state 제거, 중앙 inspection은 themed bg-surface-panel/rounded-panel/border. 층 select+“조명 목록” 한 행, scope tabs 유지, 구역 관리 button/dialog 전용 state 제거.
- [ ] 구현: visible 조명 제어 heading 제거, 단일 sr-only h1 유지. raw31 밝기 초안/선택 해제/명시 적용/권한·명령 수명은 보존.
- [ ] GREEN: 직접 unit 및 docs/diff check, 소유 파일 commit, source와 RED/GREEN 기록.

### Task 3: 공통 헤더·모니터링 (C12, C19–21)

**Files:** CustomerShell.tsx/test; monitoring/{MonitoringView,MonitoringFixtureFinder,FloorMap}.tsx/tests, docs/menus 네 파일.

**Interfaces:** Task1 `Popover.mobilePresentation`를 통합 finder에서 소비; selection callback 및 useFloorFixtures cursor query 그대로.

- [ ] RED: site-only context, single opener/focus, 항상 보이는 이름 검색·필터·scroll 목록, filtered/paginated selection·미배치 예외, 모든 지도 상태 범례를 테스트한다.
- [ ] 구현: CustomerShell site label은 site.name만, 기존 truncate/grid/52px account hit/권한 scope 유지. monitoring select desktop만 넓힘.
- [ ] 구현: 단일 “조명 검색/목록” opener와 Finder. 내부 목록 펼침/local state 및 중복 상세select 제거. 기존 filter 조건/다음 page/부분 error, row 클릭→map center/pin/detail 유지.
- [ ] 구현: 기존 renderer vocabulary 5종(정상/장애/오프라인/상태 확인 대기/조명 정보 확인 전)을 presence 필터 없이 항상 표시한다.
- [ ] GREEN: 직접 unit·관련 docs/diff check·소유 commit, source와 RED/GREEN 기록.

### Task 4: 한정 자동·시각 검증

**Files:** apps/web/e2e/atlas-interactions-comments.spec.ts(신규), 필요한 기존 fixture helper 소비, docs/assets/atlas-interactions-comments-2026-10-11/README.md 및 증거.

- [ ] Task1–3 결과를 확인하고 Web typecheck/UI 정책/build를 한 번 실행한다. 기존 SettingsShell 카드 테스트1 baseline 실패와 큰 chunk 경고는 별도 기록하고 미수리.
- [ ] 실제 browser 최대6 고유 cases: (1) PC manual middle/wheel/toggle/marquee/cancel, (2) touch manual swipe/tap/no-hold-area/짧은 viewport/dark, (3) monitoring single search/filters/camera/5legend/site header, (4) mobile filter bottom anchoring/nested date focus·calendar·날짜 한 줄/lastaction, (5) reports 577px summary/row details+dark/actions, (6) overview desktop+mobile title/ticks/no overlaps/C8 원문 유지.
- [ ] source HEAD/필요 hashes와 command 기록. 실제 bounds/visible hit/수평 overflow/fixednav 겹침, 필요한 screenshot만 보존. 실패면 원 증거 보존 후 원인 담당 수리 및 해당 case만 재실행.
- [ ] 모의API·headless browser 한계/미실행 상태를 명시하고 tracked 증거/QA commit.

### Task 5: 최종 통합 검토

- [ ] MERGE_BASE cc6b9a7a부터 review package 생성; 한 번의 독립 통합 reviewer에게 변경·요구·증거 전달. 전체 test 반복 금지.
- [ ] C8 변경0, 공통 UI/a11y/gesture·report state·범례·모바일 간격/겹침·문서 근거 일치 확인.
- [ ] 필요한 수리는 기존 담당에게 한 번 취합 배정하고 해당 tests만 재실행, 같은 review seat에서 fix diff 재확인.

### Task 6: 로컬 통합·보존

- [ ] 기본/작업 branch의 fresh HEAD/clean/소유 diff 확인 후 사용자 기존 요청 범위 로컬 FF; upstream 변경이면 충돌·권한부터 보고.
- [ ] 완료 체크리스트와 project-status를 동시에 갱신한다. source 검증과 docs-only 후속은 구분한다.
- [ ] task-owned ignored ledger/raw/test-results를 exact backup에 보존한 뒤 이번 merged worktree/branch만 정리한다. 삭제는 recoverable Git/backup 경로 기록.

## 실행 판단

- 사용자 요청대로 기존 페이지 담당 세션을 재사용하며 메인은 오케스트레이터다. 이전 완료 29건 task를 재실행하지 않는다.
- 승인된 대화 설계에서 C8만 제외한 직접 구현 요청이므로 추가 설계/실행 선택 질문을 반복하지 않는다. 이 파일은 실행 체크리스트이며 별도 새 subsystem 명세가 아니다.
- 사용자 LEAN 한도에 따라 task마다 새 review seat/whole test를 만들지 않고 최종 독립 통합 검토 1회로 취합한다. 문제 수리는 동일 담당/동일 검토 seat의 국소 diff만 확인한다.

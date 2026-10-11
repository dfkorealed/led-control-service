# Task 13 결과 — 공통 헤더·표 정렬·모바일 모니터링

- 기준: `24bfed93`, `codex/atlas-browser-comments-20261011`. 변경 commit: `aba951f7` (17 files, 160 insertions, 386 deletions). QA owner의 `apps/web/e2e/atlas-ui-fidelity.spec.ts` 미커밋 변경은 staging/commit에서 제외했다. report는 요청된 ignored SDD 경로에 보존한다.
- 현재 customer admin/viewer 단일 현장 계약에 맞춰 selector/guard/dialog/ref와 SiteSwitcher/useGuardedSiteSelection 및 전용 tests 4파일을 제거했다. 권한 useSites/dashboard/URL siteId/알람 scope/logout dirty guard는 유지하고 현재 현장은 일반 텍스트로 표시한다. 삭제 자료는 Git에 보존되어 복구 가능하다.
- PC 집계는 intrinsic 4열/동일 gap으로 묶으며 compact 4동일폭을 유지했다. DataGrid explicit align을 header/sort button/body/card value에 적용하고 undefined 기존 headercenter/bodyleft/customercompactcardright를 유지했다.
- Monitoring 일반 compact flex-none만 제거해 남은 높이를 소비하고 natural min/short scroll을 유지했다. 공통 viewport240/contain:size/renderer/camera 변경0. Monitoring 3분기 ATLAS와 visible map title을 제거하고 h1/층 region/집계 scope를 유지했다. Control ATLAS는 Task14 범위다.
- 범위 파일: `apps/web/src/components/ui/DataGrid{,.test}.tsx`, `features/shells/{CustomerShell,CustomerHeaderSummarySlot}{,.test}.tsx`, `features/monitoring/MonitoringView{,.test}.tsx`, `features/sites/{SiteSwitcher,useGuardedSiteSelection}{,.test}` 삭제, `features/settings/SettingsShell.test.tsx` 삭제source 목록 1줄 제거, `docs/menus/{monitoring,control,statistics,settings}.md`. e2e/계획/status/SettingsView 제품 변경0.

## 검증

모든 command는 `PATH='/tmp/atlas-ui-fidelity-node22.xde1wS/bin':$PATH`와 이미 준비된 workspace dependency를 사용했다.

1. RED: `pnpm --filter @led-control/web exec vitest run src/components/ui/DataGrid.test.tsx src/features/shells/CustomerHeaderSummarySlot.test.tsx src/features/shells/CustomerShell.test.tsx src/features/monitoring/MonitoringView.test.tsx -t 'honors explicit|keeps four captioned|keeps mobile brand|keeps the monitoring eyebrow|server.*summary' --reporter=dot` → exit1, 기대10FAIL/173 비선택. Header/grid/card 기존 align·w-full·selector·monitoring eyebrow가 새 요구와 다름을 확인했다. ready selector는 option/visible label 중복도 노출해 noninteractive assertion을 앞에 배치했다.
2. 첫 직접 회귀: `pnpm --filter @led-control/web exec vitest run src/components/ui/DataGrid.test.tsx src/features/shells/CustomerHeaderSummarySlot.test.tsx src/features/shells/CustomerShell.test.tsx src/features/shells/CustomerShell.monitoring.test.tsx src/features/monitoring/MonitoringView.test.tsx src/features/settings/SettingsShell.test.tsx --reporter=dot` → exit1, 206PASS/4FAIL. 기존 all-header-center/disabled selector 기대와 compact assertion 위치 3개를 수리했다. 별도 SettingsShell 홈 카드 실패1은 아래 baseline으로 분리했다.
3. 최종 직접5suite(설정 제외): 동일 command에서 SettingsShell만 제외 → exit0, 190PASS/0FAIL, 16.58초. 이 재실행은 총괄의 국소 재실행 지시가 도착하기 직전에 시작됐고 결과만 회수했다. 추가 전체 suite 반복0.
4. Baseline 기본 `/Users/kim-jh/Documents/led-control-service`, `d8dbfcd1`: `pnpm --filter @led-control/web exec vitest run src/features/settings/SettingsShell.test.tsx -t '설정 홈은 실제 데이터와 route action으로 다섯 카드를 표시한다' --reporter=dot` → exit1, 1FAIL/19 비선택. 동일 `SettingsShell.test.tsx:134` group `현장 관리` 미조회 fingerprint. `git diff d8dbfcd1 -- SettingsView.tsx SettingsShell.tsx` 없음, SettingsShell.test 변경은 별도 source 목록 1줄뿐이며 실패 test는 동일하다. 소유 밖 실패는 수정하지 않았다. 첫 직접 run에서 나머지 SettingsShell19는 PASS다.
5. `git diff --check` → exit0.

## 한계·후속

- 이번 직접 검증은 unit/DOM 및 emitted 클래스 계약이다. 578/681×1227 실제 지도 높이·짧은 화면 ticker/footer·긴 현장명·양 테마 pixel 증거는 최종 브라우저 단계에 남는다.
- 전체Web/타입/UI정책/빌드/브라우저·API/DB/HIL 검증은 실행하지 않았다. baseline SettingsShell1FAIL을 전체통과로 확대하지 않는다.
- 새로운 token/dependency/API/DB/운영/장비 변경0. 이전 Tasks1–12 완료 검증을 재실행하거나 이번 증거로 합산하지 않았다.

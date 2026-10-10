# Task 5 모니터링 교정 결과

상태: 승인된 메뉴 구현·집중 검증 완료. 공통 eyebrow는 총괄 후속 대기이며 전체 화면 충실도/통합 검증 완료를 주장하지 않는다.

- checkout: `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-fidelity-monitoring-20261010`
- branch: `codex/atlas-fidelity-monitoring-20261010`
- BASE: `a97e2563df7b11bac2a03eebdeb9c7b6e914a01b`
- actual SHA: `5ba6fb1a0fde4403c73cd26553b2ce2dfa0b9ca1`
- 13개 소유 파일만 commit했다. 메뉴 문서 포함, checkout clean. 공통/sidebar/다른 메뉴/API/DB/root 계획/project-status는 수정하지 않았다. root가 병합한다.

## 구현 및 공개 소비 계약

- 기존 PageHeader `variant="customer"`, `headingLevel={1}`, `actions`를 소비해 본문 제목과 서버 시각/refresh를 같은 header에 놓았다. 모바일도 지도 위이며 screen의 단일 navigation safe-space를 유지한다. 층 selector의 PC flex 확장을 제거하고 compact 유연 폭을 유지했다.
- finder `initialView?: "search" | "list"`는 표현 진입만 선택한다. `조명 검색·상세`와 `조명 목록`은 같은 fixture query/list/search/filter owner를 사용한다. 목록 CTA는 목록을 즉시 열고 transient portal 밖의 실제 opener ref로 anchor·dismiss/상세 반환을 수행한다. 지도 focus 실패 fallback은 검색 opener를 명시한다. 새 API/query/filter 없음.
- finder flat field/list, Button+실제 FixtureStatusBadge, search/status 이후 선택 selector를 사용한다. 상세는 기존 SidePanel `surface="plain"`을 소비하고 큰 primary 밝기 카드/중첩 카드 대신 관찰 시각·상태 조치·위치의 평면 행을 표시한다. pin Popover는 기존 plain surface를 보존했다.
- 공통 RecentActivityTicker `title="최근 활동"`, arrow·dialog trigger·실제 상태 badge를 소비한다. timestamp 시·분·초는 현장 timezone이며 원 날짜/시각을 화면읽기 텍스트에 유지한다. 실제 command/refresh unknown은 neutral/확인불가다. 상태 없는 단순 밝기 변화에 성공 outcome을 만들지 않는다.
- validated event DTO의 내용 signature를 presentation memo key로 삼아 equivalent rows의 새 배열/무관한 rerender에 현재 row와 남은5초 interval을 보존한다. 실제 event field/scope·expiry/error는 reset한다. query retained membership은 clock wake마다 검사하면서 source/membership 불변일 때 배열 identity를 보존한다. 오류/fetch/paused 동안 기존 활동 숨김은 유지한다.
- 전체 로그는 기존 LogView/DrawerDialog/filter/date draft/pager 안에서 실제 time/status/content를 공통 DataGrid로 표현한다. mock actor/target field·서버에 없는 검색/status filter·global sort는 추가하지 않는다. 50/100/500/1000/cursor/401/400/410/retention/focus owner는 그대로다.

## 기존 감사 34행 처리/보존 매핑

`docs/assets/atlas-ui-refresh-2026-10-07/audit-2026-10-10/monitoring.md`의 번호를 따른다. 아래 구현 표시는 소스+집중 단위 범위이며 browser 픽셀 완료가 아니다.

| 감사 행 | Task 5 처리 / 필수 차이·한계 |
| --- | --- |
| 01 | PageHeader 단일 본문 h1+우측 실제 refresh actions 구현. optional eyebrow는 공통 slot 미제공으로 root 후속 대기. |
| 02 | 모바일도 page-head refresh→toolbar→map/ticker. 단일 screen safe-space 유지. eyebrow 후속·320/390 실제 bounds는 Task11. |
| 03 | common Task3의 captioned header summary 그대로 소비. 실제 site/scope/null0 보존. |
| 04 | PC intrinsic selector/compact flex 소비 구현. 실제 floor IDs·disabled/reset/abort는 유지. |
| 05 | 두 CTA+Filter/List glyph 구현, 동일 state/query 및 actual opener ref 반환. |
| 06 | flat Popover finder와 search/status 이후 선택 selector로 순서 정리, zero-result selection guard 유지. |
| 07 | 기존 SearchField 소비, finder card 제거. trim/ko-KR/current loaded pages 의미 유지. |
| 08 | 실제 미배치·fault filter, 검색 유지 초기화 vs 전체 보기 검색 초기화 차이 보존. |
| 09 | 기존 Button+실제 FixtureStatusBadge로 목록 행 교정. fake ID/group/lastSeen 추가 없음. |
| 10 | initialView list 즉시 목록, 연속 페이지/부분수신/다음 retry/시점차이 안내 유지. |
| 11 | common Task4 chrome 소비에 customer-card-title 적용. renderer/가용폭 유지. |
| 12 | common Task2 dot/14·16/null0 인라인 집계 그대로 소비. floor.summary 정본 유지. |
| 13 | 실제 CAD/flex map 높이·viewport minimum/camera 유지. fixture 원본·counts·zoom 차이는 결함 아님. |
| 14 | common Task4의 static unified footerStart/legend 소비 보존. Task5 camera/gesture 변경 없음. |
| 15 | single selection/emphasis/fullview/48px coarse/unknown pin·camera instance 보존. |
| 16 | 기존 plain pin Popover/nonmodal/true runtime/trigger focus 보존. 실제 brightness/조치 삭제 없음. |
| 17 | SidePanel plain+평면 관찰값/조치 행, 큰 primary/nested card 제거. desktop focus/scroll guard 보존. |
| 18 | 같은 plain detail content를 compact DetailSheet에 소비, 1024px 전환·scroll refs/offset·actual opener fallback 보존. |
| 19 | 역사/현재 밝기·확인전·statusReason/fault precedence/배치 정보 유지하며 표현만 축소. |
| 20 | 실제 server timestamp/refresh를 PageHeader actions에 연결. UUID/job/refetch/repeated lock/abort 그대로. |
| 21 | partial/failed/expired 및 source/hardware 구분/SessionStatus retry 보존. |
| 22 | snapshot pending/stale/future/invalid/oldest60초·strictISO/timezone/timer 보존. |
| 23 | title/arrow/actual badge/짧은 visible time+full accessible timestamp 구현. 모의 outcome/actor 생성 없음. |
| 24 | 실제 retained source identity+내용 기준 rows memo 구현; equivalent rerender 현재 row/remaining timer 및 변경/scope reset 검증. |
| 25 | ticker pending/empty/error/cached-refetch error 숨김·retry/전체보기/stale 시각 유지. |
| 26 | actual time/status/content 공통 DataGrid 구현. 실제 query/pager/body scroll owner 유지, fake actor/sort/search 없음. |
| 27 | DateRangePicker draft/paired inclusive dates·50/100/500/1000 유지. transient filter 닫기/부분 날짜 기능 보존. |
| 28 | scope/A→B→A cursor reset·401 close/page2 400 recovery/410 latest·pending focus lease/retention 유지. |
| 29 | dashboard/fixture/map 독립 loading/error/retry·cached map 안내 보존. |
| 30 | actual installation/empty0/no-floor/unplaced/admin-only registration/edit 안내·viewer/operator 접근 보존. |
| 31 | 실제 readonly incident type/status/read/resolve 구별 보존, 공통 center/API 수정 없음. |
| 32 | 실제 알람 unknown/read-on-visible/dismiss/bulk requestID/confirm/실패 재시도 보존. |
| 33 | 현재 화면 상태·최근50/fingerprint/세션 수명/compact badge/fullview alarm 접근·toast 구별 보존. |
| 34 | policy DTO/실제 freshness와 BIO 관찰·건강/광학 한계 그대로. 새 policy editor/BIO incident 기능 없음. |

## 실행 증거 — LEAN

모든 Vitest 명령은 위 task checkout, `PATH=/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH`(node22.20.0/pnpm9.15.0 확인)을 사용했다. install/prepare 재실행 없음. 로그는 이 보고서와 같은 canonical scratch의 `task-5-*` 파일이다.

1. 핵심 계약 RED: `pnpm --filter @led-control/web exec vitest run src/features/monitoring/MonitoringView.test.tsx src/features/monitoring/MonitoringFixtureFinder.test.tsx src/features/monitoring/MonitoringLogTicker.test.tsx src/features/monitoring/useMonitoringActivity.test.tsx -t 'shares search and list|list entry|equivalent query rows|unrelated consumer render'` → **exit1,4FAIL/119filtered SKIP**,3.34초. 목록 CTA/initialView 부재, equivalent row reset, query 목록 identity 변경의 예상 실패. import/fixture 오류 없음. `task-5-red.log`.
2. 같은 핵심 명령 GREEN → **exit0,4PASS/119filtered SKIP**,3.30초. `task-5-green-contract.log`. filtered 제외는 환경 skip이나 전체 PASS가 아니다.
3. 이력 표현 RED: `pnpm --filter @led-control/web exec vitest run src/features/monitoring/MonitoringLogTicker.test.tsx src/features/monitoring/MonitoringLogDrawer.test.tsx -t 'recorded unknown|separates the recorded'` → **exit1,2FAIL/22filtered SKIP**,1.91초. neutral actual-status badge/구조화 time-status-content 부재 예상 실패. `task-5-activity-red.log`.
4. 직접 consumer 첫 run: 아래 최종 명령과 동일 → **exit1,24FAIL/137PASS**,`task-5-consumers-green.log`. 구현의 필수 StatusBadge icon 누락으로 발생한 render 실패와 공통Task3/4 이후 옛 h2/refresh 여백/첫자식 label 단언을 구분하여 보완했다. icon 계약을 실제로 공급하고 기존 기능 단언은 유지하며 제목/safe-space/order/glyph 소비 단언만 현 계약으로 변경했다. 실패/React warning 원문을 보존한다.
5. 보완 consumer run → **exit0,8files/161PASS/0FAIL/0SKIP**,15.74초,`task-5-consumers-green-final.log`. 이후 fallback opener 명시·검색 glyph/필드 순서 교정으로 코드가 바뀌어 최종 한 번 재확인했다.
6. 최종 명령: `pnpm --filter @led-control/web exec vitest run src/features/monitoring/MonitoringView.test.tsx src/features/monitoring/MonitoringFixtureFinder.test.tsx src/features/monitoring/MonitoringLogTicker.test.tsx src/features/monitoring/useMonitoringActivity.test.tsx src/features/monitoring/MonitoringLogDrawer.test.tsx src/features/monitoring/monitoring-activity-presentation.test.ts src/features/monitoring/FixtureDetailPanel.test.tsx src/features/monitoring/FixturePinPopover.test.tsx` → **exit0,8files/161PASS/0FAIL/0SKIP**,16.69초,`task-5-final-green.log`. 최종 로그 warning/error 없음. `git diff --check` exit0, commit 뒤 status clean.

전체583/Web/Lab/canonical/E2E/type/UI/build/실제 화면 matrix/HIL은 실행하지 않았다. 최종Task11 범위이며 이번 unit/class/DOM 결과를 pixel/대비/실기 완료로 확대하지 않는다. 실제5173/API4000·현재브라우저탭·장비 버튼/서비스는 조작하지 않았다.

## root 인계

- optional PageHeader eyebrow는 root가 공통 후속으로 처리한다고 회신했다. 이 보고서 row01/02와 메뉴 문서는 이를 완료로 표시하지 않는다. 다른 공통 확장 요구 없음.
- 최종 통합에서 양테마/320·390·562·759.5/760/760.5·short bounds, 두 opener dismissal/detail 반환, 긴 DataGrid/card scroll·44px·query/refresh/dimming 추가쓰기0을 확인한다. 새 row status는 실제 의미라 mock seed count/ID에 맞추지 않는다.
- 작업 종료 후 다음 writer 생성·다른 checkout/branch 수정 없이 멈춘다.

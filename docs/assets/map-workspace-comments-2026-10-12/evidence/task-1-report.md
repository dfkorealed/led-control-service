# Task1 C1–5 checkpoint — 원 페이지 세션 인계

- base `f31e56fadd27d63f96824bad2ea2c4ef71581b62`; 시작 HEAD `9d59c7e675d28fcaa6943947973ed8d2e89c0f66`.
- checkpoint commit: `ac323a3dcd128a32ffa73d460e4cfa07d99f0c10`, 5 owned files, commit exit0. 사용자 요청으로 기존 앱 페이지 담당자에게 인계하므로 추가 구현/검증 중단. 전체 작업 완료/실제 geometry 검증을 주장하지 않는다.
- 소유: `apps/web/src/features/monitoring/{MonitoringView,FloorMap}.tsx`와 직접 tests, `docs/menus/monitoring.md` (5파일). root-owned 상태판/계획 dirty는 보존하고 staging 제외.

## 현재 제품 변경과 경계

- FloorMap은 기존 `interactionPolicy="pan"` + `toolModePolicy="manual-cad"` 소비: 중간 버튼/Space 이동·touch swipe·좌클릭/tap 단일 선택. 공통 viewport 기본값/API/renderer 변경 없음, area callback 없음.
- 순수 valid metadata snapshot stale만 `announce:false`; 기존 알람센터 현재 화면 상태/재시도·fresh 복구 제거 유지. query error/invalid/future 안내는 announce true. 신규 서버 incident/DTO/미읽음/읽음·지우기 계약 없음.
- loading/error/main h1 sr-only. floor/finder/time/refresh 한 행. 1024px 미만 icon-only 기존52px action/accessible labels·HH:mm(전체 site-time/dateTime 설명) 소비. pending/invalid/future는 시각 확인 축약 + 전체 설명. HH:mm는 공통 strict formatTimestamp 출력에서 얻어 invalid zone의 ‘—’ 계약도 유지한다.
- PC/mobile 동일한 OperationMapPanel.relative body 내부 `absolute bottom-0 h-1/2` nonmodal aside. 별도 desktop grid22rem/mobile DetailSheet 제거. body만 scroll, close/Escape/focus·scope-aware 자동 제거/선택 scroll 기억 재사용. map subtree는 동일 위치. 공통 신규 component/API/export 없음; Control과 별도 semantic이므로 기존 공통 chrome만 소비.
- API/DB/토큰/의존성/서버/서비스/장비/원격 변경 없음.

## RED/GREEN 원 로그 (삭제·덮어쓰기 없음)

모든 Vitest는 `PATH=/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH pnpm --filter @led-control/web exec vitest run` + `--reporter=dot`; 파일 경로는 `src/features/monitoring/MonitoringView.test.tsx` 및 `FloorMap.test.tsx`. 아래 로그는 이 보고서와 같은 SDD 폴더다.

- `task-1-red.log`: 두 파일 `-t 'navigates from a real marker|pure snapshot delay|screen heading nonvisual|detail nonmodal'`, exit1, 5FAIL/122skip. mouse/touch scroll0≠20, purestale toast존재, h1 visible class, mobile modal→complementary 부재가 실제 의도 RED.
- `task-1-green-focused.log`: 같은 필터, exit1, 2PASS/3FAIL. 제품 지연/툴바 PASS. jsdom marker rect0 때문에 실제 hit-test tap이 실패; scroll test가 초기 focus/restore frame 전 scroll을 전달. 기존 real FloorScene test 패턴으로 hit rectangle와 frame 완료 후 사용자 scroll을 재현.
- `task-1-green-focused-2.log`: 같은 필터, exit1, 3PASS/2FAIL + unhandled2. 상세 lifecycle PASS. jsdom `document.elementFromPoint` 부재가 real pointerup 에러; 기존 FloorScene 방식의 test-only DOM hit API를 추가하고 teardown으로 제거. 제품 fallback을 추가하지 않음.
- `task-1-direct.log`: 직접 두 파일 전체, exit1, 121PASS/6FAIL. 새5동작 PASS. 기존 pan test의 left-button 기대는 승인 middle-button으로 갱신; pinch 뒤 `fireEvent.click(detail:0)`는 keyboard activation이므로 native ghost `detail:1`로 갱신. shared manual-cad가 keyboard activation을 억제하지 않는 계약과 실제 pointerup 단일 선택은 새 marker test에서 관찰한다. 실제 browser에서는 native middle drag/touch swipe→next tap 및 ghost 여부를 반드시 확인해야 하며 이 기대 변경을 browser 증거로 확대하지 않는다.
- 위 나머지4실패는 갱신 copy의 responsive 자식 span을 텍스트 query로 집어 `time`이 없는 node를 읽던 helper 문제. 실제 small timestamp container로 관찰하도록 수정하고 canonical dateTime/site-zone 값 assertions 유지.
- `task-1-direct-final.log`: 직접 두 파일 전체, exit1, 126PASS/1FAIL (FloorMap17PASS, Monitoring109PASS/1FAIL). 마지막 boundary test는 60000ms fresh 때 알람 modal을 연 후 aria-hidden sibling 알림 region을 accessible role로 찾은 harness 실패. hidden status도 조회하여 duplicate toast를 잡도록 수정.
- `task-1-boundary-final.log`: View `-t 'keeps 60,000ms fresh'`, exit0, 1PASS/109skip. 60000ms fresh→60001ms current-screen stale, hidden toast없음 확인.
- 자체 검토에서 HH:mm의 새 Intl 재파싱을 기존 strict formatter 출력 소비로 줄인 뒤 `task-1-time-final.log`: View `-t 'snapshot in site time|keeps 60,000ms fresh|screen heading nonvisual'`, exit0, 4PASS/106skip. UTC 날짜 경계의 Seoul/LA 원 dateTime·전체 accessible copy 유지.
- test pointer helper 중복을 기존 helper로 합친 뒤 `task-1-gesture-final.log`: FloorMap `-t 'navigates from a real marker|zooms with a modified wheel|two-touch pinch'`, exit0, 4PASS/13skip. 마지막 실행은 중단 지시 시 이미 진행 중이었고 결과만 회수.
- `git diff --check`: exit0. 타입/UI/build/full-web/browser 검증은 실행하지 않음.

## 인계 한계 / 자체 검토

- 최종 source에서 직접2suite 일괄127PASS라고 주장하지 않음. 이전126PASS와 boundary/time/gesture 국소 GREEN의 source/cohort 분리 증거다. API query mocks는 기존 외부 DTO 경계이고 FloorMapViewport/FloorScene/SessionStatus/상세 제품은 실제 컴포넌트다.
- 기존 N1 principal/site/floor/unmount 자동제거·outside focus, snapshot invalid/future·query failure, finder/pagination/pin regressions은 direct-final에서 PASS. 이번 변경은 scope guard를 유지한다.
- actual canvas height/rect/camera invariance, short-mobile 마지막 detail action과 nav 겹침·실제 toolbar overflow·양 테마·native browser gesture는 아직 미검증. overlay geometry와 keyboard return의 실제 화면 확인은 원 페이지 담당/총괄 후속 관문이다.
- 이후 추가 구현/테스트/브라우저/새 delegation은 사용자 인계 지시에 따라 하지 않음. source/checkpoint만 보존한다.

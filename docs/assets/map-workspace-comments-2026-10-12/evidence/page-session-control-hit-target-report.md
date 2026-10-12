# Task2 승인 수동 compact continuous44 실측 보완

2026-10-12. 시작 clean source `4093ff536e2ded9edfb1d1f1c3b25f53b54989b3`, 정확 NEW worktree/branch의 원 Task2 sole product writer. 원 `.superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux-aux-4093ff53.log`177 이후와 runs/actual-six-aux-4093ff53-20261012/results/*03~05*/original-failure.json 유지. Root actual: manual3~5 camera continuous44 FAIL, case6PC PASS. 직접 원 로그/검사 measureReachableArea 및 ready geometry를 읽었다. actual320 map251/390 map249/document overflow0는 새 기하 실패와 구분한다. 원본 변경0/자체browser 실행0.

## RED/원인/선택

원 실제 RED는 compact camera geometry44x44(배율47.625x44), usable43/44 및 hasMinimumAreafalse. 공통Button rounded-control(10px radius), border와 viewport ancestor clipping/hit 판정이 선언 크기와 다르게 연속 영역을 줄인다. CSS class-only RED를 geometry PASS로 만들지 않는다. 동작 handler는 문제 원인이 아니므로 새 가짜 실패 unit를 작성하지 않고 실제 원 RED를 재현 증거로 사용한다. 직접 소비자 기존 camera/focus/raw/firstApply/UUID/default 회귀를 GREEN으로 확인한다.

카메라는 compactChrome opt-in에서 기존 coarse52 크기로 바꾸며 overlay placement를 유지한다. 지도 flow 높이 증가0. 수동-mobile basic 행의 Apply/More/list/전체보기는 높이44를 유지하고 사각 외곽+최소48너비로 공통 feature class를 사용한다. basic 행을 모두52로 키워 map249→233처럼 줄이지 않는다. reader close/presets/selection clear도 같은 compact feature class를 소비한다. 새 optional public API 없음, common Button/default style 수정0.

PC 경로는 source상 ControlView.singleColumnLayout→Spatial.compactWorkspace→manualWorkspace&&compactWorkspace=compactManual→FloorMapViewport.compactChrome다. 실제 PC manual은 singleColumnLayoutfalse라 기존 false 경로. provider가 없는 opt-in compact consumer도 true를 전달하면52 정책을 소비할 수 있다. controlsPlacement는 compactAuxiliary 여부이며 camera 크기와 다른 조건이다. 기본/editor/defaultfalse 변경0. Root case6 actual 재검사는 후속.

## 체크

- [x] 원 actual RED/height/검사 source/공통 button audit
- [x] compact-only 최소 수리 및 메뉴5섹션 최신화
- [x] scoped direct GREEN/type/UI/diffcheck
- [x] 정확 owned source commit/SHA/사후 확인
- [ ] actual continuous44/map240/overlay reachability/final review/MAIN 관문 — root 후속

## 동일 구조 버튼 audit 및 실제 영향

수정은6개 소유 파일뿐이다. camera compact true 아이콘3개는52×52, 배율은 min-height52/min-width52 선언. gap/placement/props/handler/ref/key/renderer source 경로 변경0. footer로 되돌리지 않았다. compact false 클래스는 이전 그대로다.

Basic Apply는 이전 min-w0+짧은 글자로44보다 좁아질 수 있었다. Apply/More/조명 목록/전체 보기·선택 해제/빠른 값/보조 close는 `manualCompactButtonHitClassName` 하나의 재사용 사각 외곽(h44/min-width48/rounded-none)을 소비한다. List는 w48/h44이며 floor/scope 폭 배분을4px만 줄이고 row 높이는 늘리지 않는다. More/close/presets는 기존 동일 버튼/ref/handlers에 class만 변경했다. 기본 standalone/PC의 compactfalse 버튼 클래스는 유지했다. 선택 해제/전체 보기·presets처럼 넓은 프레임도 같은 compact 외곽 정책을 사용하되 default는 그대로다.

층/범위 dropdown은 충분히 넓은 기존 프레임에서 가운데44 영역을 사용할 수 있는 구조이며 새 카메라와 같은44 square 축소 frame이 아니다. 직접 glyph/native hit를 소스만으로 확정하지 않고 root actual 관문에서 확인한다. NumberField/Slider/기존 이력·모드/알람·theme button은 이번 수리에 새 기하 결함이 확정되지 않아 임의 확대/handler 변경하지 않았다. 전체44 target 조사와 slider endpoint 가림은 같은 실제 UX 관문에 남긴다. 일반 Button 또는 새로운 public optional API를 추가하지 않았다.

Camera overlay 높이 변경은 flow row를 사용하지 않는다. Basic 버튼 h44를 유지한 것이 선언상의 height budget 보존 근거이며, 기존 measured320251/390249를 최종 source actual 결과로 재사용하지 않는다. 최소240·continuous44 기준을 완화하지 않는다.

## 검증 및 원 로그

원 actual RED는 root/UX의4093 frozen cohort다. 자체 browser/서버/QA harness 변경·실행0. CSS 크기·class 검출 unit을 pixel HIT의 RED/GREEN처럼 만들지 않았으며, 필요한 직접 소비자 callback/키보드/disabled/raw/UUID/default 회귀를 실행했다.

| raw log | 결과 |
|---|---|
| page-session-control-hit-target-direct.log | 5files79PASS/0FAIL/242비선택,exit0,19.45s |
| page-session-control-hit-target-typecheck.log | pnpm --filter @led-control/web exec tsc --noEmit,exit0/출력0 |
| page-session-control-hit-target-ui-check.log | pnpm --filter @led-control/web ui:check,exit0/existing0/new0 |
| git diff --check | exit0 |

직접79=Control18/Shell6/Spatial33/ManualExecution9/Viewport13. 기존118이나 root의 별도 정적 policy79와 합산하거나 같은 실행으로 표현하지 않는다. 원 RED 대비 물리적 continuous44 GREEN은 UX 후속이며 직접79는 동작 보존 근거다.

정확 명령 (준비된 Node22 PATH `/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH`):

```text
pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx src/features/shells/CustomerShell.test.tsx src/features/control/target-selection/SpatialTargetSelector.test.tsx src/features/control/ManualExecutionPanel.test.tsx src/features/floor-map/FloorMapViewport.test.tsx -t 'C6-8|keeps every control disabled for viewer accounts|ManualExecutionPanel|SpatialTargetSelector|manual-cad|footer|maintains|resize|real authorized manual|manual route and query|navigation breakpoint to the real Control|preserves an in-flight UUID|retains original UUID|original frozen UUID' --maxWorkers=1 --minWorkers=1 --reporter=dot
```

자기 리뷰: exact6 allowlist, compact 조건/defaultfalse 경로, callback/ref/key/selection/renderer/query/UUID/raw/firstApply 로직 diff0, flow row height 변경0, 보조 portal lifetime/focus transfer 코드 변경0. 메뉴5섹션 갱신. source SHA256은 `page-session-control-hit-target-source-sha.json`; rootplan/status·Control/Spatial/Shell/FloorScene/공통Button 보존 SHA도 기록했다.

## 후속과 경계

root sourcefreeze 후 같은 actual case3~5의 camera/기본 compact 버튼 continuous44·map240/document0/overlay 및 보조 마지막 action을 재측정하고 case6PC false 경로를 확인한다. source 수리로 actual 통과를 주장하지 않는다. 새 unique/browser/전체suite/HIL/장비/다른 담당·agent·session/UX harness/원evidence/포트5173·4000·63200/외부API·DB/remote/다른worktree/MAIN 변경0. 설치/prepare/build/server/browser 실행0. source commit 뒤 STOP/WAIT.

## 최종 checkpoint — STOP/WAIT

Source commit `c9b65514ee257854e56e7314157b4f6143ba6787`, direct parent `4093ff536e2ded9edfb1d1f1c3b25f53b54989b3`. 정확 소유6파일만 commit, 검증SHA=commit blob=working sourceSHA 모두 일치. 소유 diff0/git status항목0개. rootplan/status·Control/Spatial/Shell/FloorScene/공통Button 보존SHA 일치. 최종 직접79PASS/0FAIL/242비선택 exit0, typecheck0/UI0·0/diffcheck0. 자체actual Green0. 총괄 최종정적·UX 재측정으로 인계하고 source 추가변경 없이 STOP/WAIT.

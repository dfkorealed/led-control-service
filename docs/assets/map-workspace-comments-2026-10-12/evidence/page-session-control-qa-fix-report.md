# Task2 실제 QA 모바일 지도0 수리

2026-10-12. 재개 승인 범위: 동일 NEW worktree와 원 Task2 소유 파일. 시작 clean HEAD `bea0dacb07d3d5c8e0b14e4659874da12ed6b2d4`. 실제 QA 지원/harness 수정은 UX 소유이며 본 담당은 수정/실행하지 않는다.

## RED 및 원인 조사

원 RED는 `page-session-ux-first-ui.log` exit1/0PASS6FAIL이며 3 harness/3 product로 전달받았다. 제품 근거는 `runs/actual-six-first-ui-20261012/results/*03*/failure.json+failure.png`,04,05. 원본 변경0. 세 geometry에서320×600,390×600,717×1227 모두 map height/clientHeight0, canvas0, exposedArea0이고 문서 scroll0이다. 03 PNG를 직접 열어 지도 없이 chrome/footer/선택/실행만 보이는 것을 확인했다. 수치 추출은 내 `page-session-control-qa-fix-red-summary.json`.

Finite 경로: CustomerShell manual 모바일 h-dvh/main min-h0/content minmax0fr → ControlView h-full **grid content-start + implicit auto rows** → manual tabpanel implicit auto row → 내부 manual grid minmax0fr/auto → Card flex/Spatial h-full → Spatial body minmax0fr/auto → OperationMapPanel flex chrome+body → flex1 wrapper/FloorMapViewport flex footer + size-contained viewport.

원인은 첫 ControlView grid에서 높이만 h-full로 만들고 content-start/implicit auto 행을 유지한 누락이다. 남은 공간은 빈 공간으로 남고 auto 행은 후손 intrinsic content로 크기를 계산한다. size-contained viewport는 intrinsic height를 제공하지 않으므로 지도만0이 된다. Tall717×1227에서도 y262/height0인 관측은 화면이 짧아서 생긴 최소높이 문제가 아님을 뒷받침한다. 공통 OperationMapPanel은 이미 body에 flex/min-h0/flex1을 갖고 있다. 기본 footer min240가 있던 이전 구성은 이 누락을 intrinsic minimum으로 가렸고 compact opt-in에서 제거되며 노출됐다.

단일 가설: 수동 모바일 ControlView outer를 tablist auto + manual remaining minmax0fr로 명시하고 manual tabpanel도 한 remaining row를 명시하면 부모부터 지도까지 finite 높이를 전달한다. 임의 최소지도높이/새 overflow clip/renderer 재부모화/명령 변경은 하지 않는다. 실제 원 RED를 제품 전 근거로 사용하며 CSS class-only unit RED를 새 실제 geometry 증거처럼 만들지 않는다.

## 진행 체크

- [x] systematic-debugging/TDD 읽기, actual RED/PNG/소스 경로 조사
- [x] 수동 모바일 explicit remaining rows 최소 수리 및 제어 메뉴 최신화
- [x] scoped 직접 소비자 회귀/type/UI/diffcheck
- [x] 소유 commit/source SHA/사후 확인
- [ ] 실제 QA 재측정은 UX/총괄 후속; 본 담당 GREEN 기하 주장 없음

## PC 좁은 이력 안내의 추가 RED 및 최소 보완

추가 root 승인 후 기존 case6 failure.png를 직접 확인했다. 원 PC 배치는9f3e25d7 parent에서 CommandHistoryPanel이 `compact:col-span-full compact:row-start-3`으로 전체 행을 차지했다. 현재는 같은 owner가350px 실행 aux에 있다. 기본 RecentActivityTicker의 `compact:flex-nowrap`와 `compact:flex-1`이 viewport760 이상에서 메시지/제목/retry/open을 한 줄로 경쟁시켜 긴 오류가 한 글자 폭으로 줄어든다. 좁은 pane의 실제 width가 viewport breakpoint보다 작아진 이번 재배치가 유발한 회귀다. GET404는 mock 오류 표현이며 실제 backend 장애로 주장하지 않는다.

수리는 ControlView의 기존 CommandHistoryPanel.className에서만 `flex-wrap` 및 direct content/ticker content `basis-full`, ticker action `shrink-0/whitespace-nowrap`를 선언한다. 메시지/loaded row와 버튼을 별도 줄에 배치하고 확인 필요한 명령 버튼도 유지한다. loaded text의 기존 truncate, empty/error의 자연 줄바꿈, retry/open/verify callback/ref/timer/query는 그대로다. 공통 ticker 및 CommandHistoryPanel 제품 파일/props/API 수정0. optional shared API가 필요하지 않아 도입0. 실제 줄바꿈/glyph/action 기하는 case6 재측정 필요.

## 최종 변경과 검증

제품은 ControlView.tsx 한 파일의 outer/manual grid row 선언과 manual history caller className뿐이다. Shell/Spatial/OperationMapPanel/FloorMapViewport/FloorScene/renderer/gesture/default embedded/자동화/query/command/UUID/input handlers 변경0. docs/menus/control.md에 다섯 구성으로 실제 RED/소스 보완/미측정 관문을 기록했다. 새 CSS class-only 테스트를 actual RED 대신 만들지 않았다. 실제 기존 UI failing case03/04/05 및case6이 회귀 근거이며 browser GREEN은 UX 후속이다.

| 원 로그 | 결과 / 의미 |
|---|---|
| page-session-control-qa-fix-direct.log | 7 files,82PASS/1FAIL/274 비선택, exit1,18.22s. CommandHistoryPanel `blocks manual retry after a history error while the reversed draft survives filter reopen, then reads a valid correction`가5000ms timeout. 원본 보존 |
| page-session-control-qa-fix-history-recheck.log | 같은 날짜 guard partial/impossible/reversed 3PASS/27 비선택, exit0,6.35s. 제품/테스트 수정 없이 분리 재검사 |
| page-session-control-qa-fix-direct-final.log | 동일 selection,7files83PASS/274 비선택, exit0,19.32s. maxWorkers=1/minWorkers=1로 CPU 동시 경쟁 없이 재검사. 최초 timeout을 숨기지 않으며 단발 timing 결과로 기록 |
| page-session-control-qa-fix-typecheck.log | pnpm --filter @led-control/web exec tsc --noEmit, exit0/출력0 |
| page-session-control-qa-fix-ui-check.log | pnpm --filter @led-control/web ui:check, exit0/existing0/new0 |
| git diff --check | exit0 |

최종 명령 (준비된 PATH `/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH`):

```text
pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx src/features/shells/CustomerShell.test.tsx src/features/control/target-selection/SpatialTargetSelector.test.tsx src/features/control/ManualExecutionPanel.test.tsx src/features/floor-map/FloorMapViewport.test.tsx src/features/control/CommandHistoryPanel.test.tsx src/components/ui/operations/RecentActivityTicker.test.tsx -t 'C6-8|keeps every control disabled for viewer accounts|ManualExecutionPanel|manual-cad|footer|maintains|resize|real authorized manual|manual route and query|real page changes|navigation breakpoint to the real Control|preserves an in-flight UUID|lost status-check|retains original UUID|original frozen UUID|replays a lost|CommandHistoryPanel|reserves the full message|same full-view ref' --maxWorkers=1 --minWorkers=1 --reporter=dot
```

83은 실제 direct consumer raw31/invalid blur·Enter/첫 Apply guard/별도 Apply/UUID frozen target/복원/재전송/readonly/lock/scope/실제 page identity/theme/media/default camera+manual CAD/실제 history GET-only retry/filter/ref/기본 ticker callback+clock 보존 근거다. 이전41/중간82/분리3과 합산하지 않는다. 전체 Web/build/HIL 테스트는 승인 경계에 따라 실행0. 클래스 조합에서 화면 높이 PASS를 추론하지 않는다.

자기 검토: 컴포넌트 children/keys/ref/query/handler는 기존과 동일. only manual-mobile rows 및 only manual history caller 규칙. min-height 강제/새 overflow clip 없음. shared ticker/default OperationMapPanel/Viewport 파일 SHA 보존. 소유2 파일 sourceSHA 및 rootplan/status 등 보존 파일 SHA는 `page-session-control-qa-fix-source-sha.json`.

## 다음 실제 QA 계약

동일case03/04/05에서 지도 actual height/clientHeight/canvas/exposed area 복구와 전체 finite chain/문서scroll/nav/목록·More 동시 끝 도달을 확인한다.320/390×600 canvas240 목표는 현재 chrome/보조 상태에 따라 남은 공간이 더 작을 수 있어 actual 수치가 필요하다. 이번 명시 rows만으로240 이상이나 dominance PASS를 주장하지 않는다. case6에서 긴 GET404 메시지의 문장 줄바꿈·retry/open/verify hit와 마지막 action 도달을 확인한다. rounded44/slider0·100 간섭은 지도0으로 미도달한 위험이며 확정 결함으로 수리하지 않았다. 새 actual case 추가/QA support 수정·실행0.

## 경계

추가agent/session/제어 페이지 담당자 호출/타 chat message0. root plan/status 및 다른 메뉴/API/DB/schema/장비/서비스/스태시/remote/다른 worktree/MAIN 수정0. 서버/browser/install/prepare/build 시작0. 소유 source commit 후 STOP/WAIT.

## 최종 checkpoint — STOP/WAIT

Source commit `69b1e9a3cb1dc7e2092a0ca96e56904e0938361a`, direct parent `bea0dacb07d3d5c8e0b14e4659874da12ed6b2d4`. Commit은 ControlView.tsx와docs/menus/control.md 정확히2개. 검증 source SHA=commit blob SHA=현재 working SHA 모두 일치. rootplan/status와 공통ticker/CommandHistoryPanel/OperationMapPanel/Viewport의 보존 SHA 일치. 소유 diff0, git status 항목0개. 실제 QA GREEN은 아직 없음. UX/총괄이 동결·같은 case 재측정 후 판정할 수 있도록 원RED/직접83PASS/타입·UI0 및 남은 기하 목표를 인계하고 추가 변경 없이 STOP/WAIT.

## 사용자 승인 하단 보조 패널 후속 인계

원69b1/actual RED 기록은 유지했다. 이후 승인 계약의 새 source `4093ff536e2ded9edfb1d1f1c3b25f53b54989b3`/직접118PASS/0FAIL 및 focus RED→GREEN/소유10파일은 `page-session-control-bottom-panel-report.md`에 별도 기록했다. 이전69b1의 actual 미완료를 이 최종 source의 기하PASS로 확대하지 않는다.

# Task2 승인 후속 — 수동 모바일 지도 하단 단일 보조 패널

2026-10-12. 사용자 승인 인계: 지도 크기 유지, 목록·더보기 한 번에 하나씩 지도 하단 nonmodal 보조 패널로 표시. 정확 writer는 제어 UI 개선 담당자 본인. worktree `/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012`, branch `codex/map-workspace-comments-20261012`. 시작 clean HEAD `4710954854acffb67921114fbf7d664a2192b48c`(제품69b1와 동일). 기존 approved design/brief를 bounded 후속 실행으로 읽고 brainstorming 목적·경계/TDD·systematic-debugging·verification 적용. 총괄 계획/status는 수정하지 않고 내 SDD 체크만 기록한다.

## 실행 체크

- [x] 사용자 승인 계약/UX height budget/원 실제 RED 보존 및 직접 읽기.
- [x] 상호배타/공통 reader/focus/scope/More 모드 접근 직접 동작 RED 실행.
- [x] manual-only chrome 정리 및 단일 하단 nonmodal reader 최소 구현.
- [x] portal target 변경에 의한 상세 state 초기화 및 DOM 이동 내부 focus loss의 직접 RED→GREEN.
- [x] raw31/invalid blur·Enter/첫 Apply 차단/명시 Apply/권한·lock/UUID/default 직접 회귀.
- [x] 최종7files118PASS, typecheck/UI policy/diffcheck 및 메뉴 문서5구성 최신화.
- [x] 소유10파일 commit/SHA/사후 diff 확인 (아래 checkpoint).
- [ ] actual240/map 우세/rect·canvas·camera/hit/끝 도달/final review/MAIN 관문 — 총괄 후속.

## 원 actual RED와 판단

`page-session-ux-repair-69b1e9a3.log`와 `runs/actual-six-repair-69b1e9a3-20261012/results/` 원본 변경0. case03 ready.json/png의320×600 map62, case04 ready의390×600 map70 및 failure.json/png의 listopen map0/노출area0를 직접 읽었다. 03 ready PNG와04 failure PNG 직접 열어 봤다. root 전달의 canvas isConnectedfalse를 원 native swipe→tap 부분 통과와 구분하며 본 담당 actual browser를 새로 실행한 근거로 주장하지 않는다. 전체69b1 actual 결과는2PASS4FAIL; case5/6 PASS를 여기서 재실행·합산하지 않는다.

UX 기록상 비지도538/530, 목록90+More150+간격 추가244로 기존 세로-flow 두 펼침은600 높이와 양립하지 않는다. overlay만 얹고 기본 map62/70을 유지하는 방식은 불충분하다. 승인대로 기본 화면의 반복 chrome부터 줄이고, reader를 map row에 영향을 주지 않는 absolute 하단 영역으로 옮긴다. min240 강제나 부모 overflow clip을 추가하지 않는다.

## 구현 / 소유 및 API

- 신규 feature presentation `manual-workspace/ManualAuxiliaryPanel.tsx`: provider(kind selection|more|null)/scope/실제 opener/고정 host, nonmodal panel(header/close44,body 내부 scroll), reusable content slot. selection/query/command owner0. Overlay 하나를 두 entry가 공유하고 active kind로 상호배타 표시한다. 처음 열린 뒤도 host/내용을 mounted로 유지한다. Escape는 panel body뿐 아니라 실제 외부 opener에서도 닫으며 소비한 nested popover/dialog Escape는 defaultPrevented/propagation으로 우선한다.
- ManualSelectionPanel count→전체 보기44 유지, compact provider에서 목록/clear를 common reader에 투영. default standalone 및 PC는 inline 기존 body. Scope key/층 callback으로 reader만 reset한다.
- ManualExecutionPanel 숫자/slider/Apply/More44 row 및 원 invalid guards 그대로. presets/기존 단일 feedback/history를 common reader에서 소비하고 중요한 상태/live는 reader가 열려도 유지한다. 독립 More 기본 fallback은 유지한다.
- ControlView manual 모바일: 기본 제어방식 tablist를 More로 옮기고 main은 현재 수동 모드 식별을 유지한다. 현장 전체 집계는 More에서 기존 data를 표시한다. 기존 mode route handlers/명령/UUID/query closures 그대로. PC mode/history 기본표시 유지.
- SpatialTargetSelector manual compact caller: 층/범위/list 한 row, 반복 floor 집계/legend는 More, camera 네 기능은 기존 viewport overlay controls로 배치. renderer/viewport 부모와 key를 토글로 바꾸지 않는다. floor/group choices도 selection reader 내부에 있어 map 행을 늘리지 않는다. Provider 없는 기존 compact/default 소비자의 status/footer 정책을 보존한다.
- CustomerShell authorized manual-active mobile만 header 집계 행을 표시하지 않고 기존52px alarm/theme action이 있는 compact header를 사용한다. 다른 route/PC/default/gates는 기존 branch. toolbar의 시각적 빈 label gap만 compact caller에서 제거하고 accessible label 유지.

공통 UI/public props API 추가0. 기존 compactWorkspace/compact/compactChrome default opt-in 값 유지. FloorMapViewport/FloorScene/OperationMapPanel/RecentActivityTicker/CommandHistoryPanel 제품 파일 변경0. 신규 feature provider의 enabled/scope, content kind/mobileOnly는 해당 수동 presentation 내부 API다. 외부 renderer/command API 변경0. 재사용 요소는 기존 common Button/Heading/Text/SelectBox/InlineStatusSummary다.

## Portal/state/focus 경계와 수리

단순 createPortal target 전환은 children을 remount하여 복구 상세 disclosure가 사라졌다. 첫5file consumer에서 기존 실제 Shell media test가 이를 잡았다. Content마다 lifetime이 고정된 portal target을 만들고, media 변경 때 그 DOM container만 desktop inline slot/mobile common reader 사이에 옮긴다. React children/history/ref/subscription 및 map DOM은 유지한다. PC의 inline portal wrapper는 contents여서 기존 grid gap/flow를 유지한다.

root 추가 관찰대로 React state 유지와 별개로 DOM remove/append가 activeElement를 body로 잃게 한다. 실제 Shell 기존 detail test의 history full-view 버튼에 focus를 놓은 검사와 실제 Control의 selection-clear/More-history action 두 검사(외부 numeric input 검사 아님)를 먼저 실패시켰다. cleanup에서 이동 전 내부 activeElement를 기록하고 같은 연결된 표시 요소일 때만 preventScroll로 복원한다. 닫힌 reader/사라진 scope/새 요소에 강제 focus를 주지 않는다. Scope reset에서는 열림을 닫고, 동일 scope의 media roundtrip에서는 기존 reader/disclosure state를 유지한다. 이 직접 DOM 근거는 actual Chromium focus/scroll 녹화의 대체가 아니며 UX에서 같은 경계를 추가 관찰할 수 있다.

## 원 direct RED/GREEN 및 최종 cohort

모든 raw log는 동일 SDD에 그대로 보존. Node PATH `/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH`, pnpm9.15.0 기존 설치만 사용. 전체 Web/HIL/이전 작업 전체 반복0.

| raw log | 결과 / 해석 |
|---|---|
| page-session-control-bottom-panel-red.log | 2FAIL/167 비선택,exit1,4.62s. common reader 부재/More-only mode access 부재의 제품 RED |
| green-first.log | 1PASS1FAIL/167 비선택,exit1,3.73s. floor helper가 desktop mode 버튼을 먼저 찾는 harness 오류. 실제 표시 층 SelectBox 경로로 고침; 제품 수리 이유로 쓰지 않음 |
| consumer.log | 46PASS2FAIL/270 비선택,exit1,9.82s. portal 내부 Escape가 opener 복귀 못함 + media target 전환이 실제 상세를 remount |
| consumer-second.log | 47PASS1FAIL/270 비선택,exit1,10.41s. React 상세 state는 유지됐으나 media enable 변경 때 reader 열림을 지워 모바일 반환 상세가 hidden. scope-only reset으로 교정 |
| direct-final.log | 115PASS/244 비선택,exit0,15.85s. 중간 cohort; 아래 최종에 합산하지 않음 |
| opener-escape-red.log | 1FAIL/168 비선택,exit1. panel 바깥 실제 More opener의 Escape가 닫기 경로에 못 도달 |
| focus-transfer-red.log | 2files3FAIL/231 비선택,exit1,4.17s. selection/More 내부 action 및 실제 Shell history action 모두 DOM 이동 후 focus loss |
| focus-escape-green.log | 2files5PASS/229 비선택,exit0,4.45s. 내부 focus+opener Escape+scope/mutual 전환 GREEN. 최종 부분집합 |
| typecheck.log | exit1. 새 집계의 optional offline count(undefined)를 공통 summary의 number|null 계약에 넘김. ??null로 교정; 원본 보존 |
| direct-ready.log | 118PASS/244 비선택,exit0,16.91s. PC inline contents 최종 미세 배치 전 cohort |
| page-session-control-bottom-panel-final.log | **7files118PASS/244 비선택,exit0,16.48s**. 최종 제품 소스 cohort |
| typecheck-ready.log | pnpm --filter @led-control/web exec tsc --noEmit,exit0/출력0 |
| ui-check.log | pnpm --filter @led-control/web ui:check,exit0/existing0/new0 |
| git diff --check | exit0 |

최종 명령:

```text
pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx src/features/shells/CustomerShell.test.tsx src/features/control/target-selection/SpatialTargetSelector.test.tsx src/features/control/ManualExecutionPanel.test.tsx src/features/floor-map/FloorMapViewport.test.tsx src/features/control/CommandHistoryPanel.test.tsx src/components/ui/operations/RecentActivityTicker.test.tsx -t 'C6-8|keeps every control disabled for viewer accounts|ManualExecutionPanel|SpatialTargetSelector|manual-cad|footer|maintains|resize|real authorized manual|manual route and query|real page changes|navigation breakpoint to the real Control|preserves an in-flight UUID|retains original UUID|original frozen UUID|CommandHistoryPanel|reserves the full message|same full-view ref|pauses for hover|delegates full-view|rotates only' --maxWorkers=1 --minWorkers=1 --reporter=dot
```

최종118=Control18/Shell8/Spatial33/ManualExecution9/Viewport13/History30/Ticker7. 중간 cohort/부분 GREEN을 합산하지 않는다. 새 guard integration은 기존 raw/invalid/UUID의 GREEN 회귀이며 신규 동작 RED라고 부르지 않는다. 내부 focused2+기존 Shell detail focus1/opener Escape/mutual/scope는 직접 제품 RED→GREEN. CSS class-only 검사로 actual geometry PASS를 대체하지 않았다.

## 최종 UX 계약 / 남은 관문

1. 같은320/390×600에서 base map240 이상 목표·지도 우세·scene fit/document scroll0/nav reserve를 측정한다. raw invalid/긴 critical은 flow에 남으므로 상태별 실제 budget도 확인한다. 선언만으로 실제 높이 PASS를 추론하지 않는다.
2. 공통 reader의 selection→More→selection/같은 opener 닫기/close44/Escape에서 map rect/camera/canvas identity·isConnected 불변, 긴60 목록·More 끝 action의 native 내부 scroll 도달을 확인한다.
3. 내부 action의 모바일↔PC 같은 DOM/native focus 복원, scope reset/실제 opener 복귀, nested popup Escape 우선권을 실제 Chromium에서도 확인한다.
4. 네 camera overlay 기능의 hit/zoom100%/fit, floor/scope/list와 execution 한 행/가로 overflow0/44px를 측정한다. 기존 compactChrome size11/rounded-control은 변경하지 않았다. rounded44 연속44×44 hit는 미확정 관찰로 보존하며 CSS만으로 합격 처리하지 않는다. slider0/100 간섭도 미도달 위험이며 확정 결함처럼 수리하지 않았다.
5. PC case6도 finalsource 한정 재검사: empty/full-row/long list/history retry/open/verify 끝 도달과 PC inline portal flow. schedule/event/editor/embedded/default 경계를 확인한다. 새 unique case/자체 browser 추가0.

총괄 sourcefreeze 뒤 UX/static/review/MAIN 통합을 기다린다. C7 전체 actual 성공이나 merge 완료를 주장하지 않는다.

## 소유·경계·자기 리뷰

소유10개 source path/SHA256과 rootplan/status/shared renderer/ticker/history 보존 SHA는 `page-session-control-bottom-panel-source-sha.json`. key/renderer/command hooks/동일 UUID sends/default handlers 변경0. reader는 presentation만 소유하며 query/drawer/domain owner 복제0. 중요한 live 상태는 밖에 남고 내용은 내부 scroll로 도달하도록 구성한다. 지도 renderer subtree reparent0. 타입/UI/diffcheck 완료.

추가agent/session/다른 제어 담당/장비 업무/타 chat message0. UX ignored harness/runner/원evidence/다른 메뉴/API/DB/schema/장비/서비스5173·4000·63200/stash/remote/다른 worktree/MAIN 변경0. install/prepare/build/server/browser 시작0. 자신의 SDD report/log/hash만 작성. source commit 뒤 STOP/WAIT.

## 최종 source checkpoint — STOP/WAIT

- Source commit `4093ff536e2ded9edfb1d1f1c3b25f53b54989b3`; direct parent `4710954854acffb67921114fbf7d664a2192b48c`.
- 정확 소유10파일만 commit; 검증 SHA256=commit blob=현재 working source 모두 일치. 소유 diff0. git status 항목0개. rootplan/status 및 shared renderer/ticker/history 보존 SHA 모두 일치.
- 최종 raw `page-session-control-bottom-panel-final.log`:7files118PASS/0FAIL/244비선택,exit0,16.48s. typecheck-ready exit0/UI existing0·new0 exit0. source 최종 검증 뒤 제품 변경0. 메뉴의 미확정 camera hit 기록만 마지막 문서 보완 후 source hash에 포함했다.
- actual browser 실행0/기하GREEN0/독립review·MAIN 통합0. root sourcefreeze/원UX actual 관문으로 인계하며 추가 작업 없이 STOP/WAIT.

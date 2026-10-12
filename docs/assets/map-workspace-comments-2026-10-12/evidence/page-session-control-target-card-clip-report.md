# Task2 compact 대상 Card ancestor clip 보완 — STOP/WAIT

- source commit `e35c0c209fab13f9be17ed3dcda079d8de642efd`
- base/parent `f2926e927ab8c976ef1dbb282c932bdddfdf8685`
- commit 관측 UTC `2026-10-12T04:37:45.567713+00:00`
- worktree `/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012`, branch `codex/map-workspace-comments-20261012`
- owned2 파일만 커밋, own diff0 / 전체 tree clean, commit blob/current/tested sourceSHA256 일치. source freeze/후속 UX grant 대기.

## 실제 상태와 원 RED

- 원 run `actual-one-parent-clip-f2926e92-20261012`, log `page-session-ux-parent-clip-f2926e92.log` 보존. 원 실패 source는 f292다.
- 원 endpoint0/100 attachment 각각 INPUT/thumb/Apply/More 네 target continuous44=true, 총8target PASS를 metadata에서 읽었다. thumb52×52의 usable52×48도44true. 이번 실패는 **입력 실패가 아니다**.
- 그 다음 toolbar 전체 검사에서 조명 목록 geometry48×44/usable48×44/hasMinimumArea=false로 새 중단. 이후 auxiliary/invalid firstApply stage는 미도달 상태 보존. 원본 PNG/JSON/harness 수정0.
- toolbar row의 원측정 x8/y87/w304/h44/right312/bottom131. list48의 개별x/y는 원error가 기록하지 않아 source의flex-end 배치로 x264/y87/right312/bottom131를 유도했다. 독립browser측정으로 주장하지 않는다. PNG는 toolbar list 우상끝 roundclip과 일치.

## 먼저 수행한 전체 ancestor 감사

- `page-session-control-target-card-clip-audit.md`, `page-session-control-target-card-clip-audit-sha.json`에 수리 전 source와 toolbar/선택/More/aux 좁은44 대상의 계층을 남겼다.
- list square48×44 → toolbar/flex → Spatial root → target outerCard rounded14/overflowhidden/padding0. top-right flush는44높이 여유0/48폭 여유4로 parent radius를 피할44 정사각형을 확보할 수 없다.
- 선택 전체 보기는 같은 outerCard 아래의 fullwidth304 버튼이다. compact selection wrapper는 round/overflow없고 중앙44 여유가 있다. More 실행행은 **sibling** SidePanel(square)로 이미 원0/1008target 통과.
- aux 실제DOM은 fixedportalhost→body(p2/scroll, round없음)→auxsection(round/nooverflow)→inner OperationMapPanel(round/clip)→outerCard. header px2/body p2 inset과 bottom/top 분리 상태를 확인했다. 아직actual미도달이므로clear/close/preset/history/복구action PASS를 단정하지 않는다.
- 추가로 확정된 miss가 없어 다른 소자나 내부 지도/공통 부모로 수리 범위를 확대하지 않았다. 실제 computed style/clip-off browser diagnostic0. Root가 승인한 외곽 Card 원인이 source/PNG와 일치해 같은 turn에서 수리했다.

## 승인된 최소 변경

- `ControlView.tsx`: outer targetCard caller 기존 class를 cn으로 유지하고 `singleColumnLayout && "rounded-none!"`만 추가. compact padding0에서 parentradius가flush44 toolbar를clip하는예외주석2행. default/PC/Card기본·내부지도roundedframe·overflow/scroll owner/height/padding/버튼크기/handler 변경0.
- `docs/menus/control.md`5섹션 갱신:0/100실측완료·list새RED·미도달aux/invalid·후속actual구분.
- 원 f292 SidePanel square, f28 slidergutters/numericsquare 유지. UUID/frozen/query/draft/nativeinputref/renderer/gesture/camera/portal/focus 수명 변경0.
- 보호16파일 baseline byte동일: commonCard/SidePanel/OperationMapPanel/Slider/NumberField, ManualExecution+test,Aux,Spatial/Toolbar/Selection,Viewport/Shell,theme,rootstatus/plan.

## 검증 / raw

PATH `/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH`, 기존Node22.20.0/pnpm9.15.0; 설치/prepare/build/fullWeb/browser/API/장비 실행0.

| cohort | 결과 | exit | 시간 | raw |
|---|---|---|---|---|
| 동일 direct 소비자 |5파일81PASS/242skip | 0 | wall23.927s / Vitest21.29s | `page-session-control-target-card-clip-direct.log` |
| Web tsc --noEmit | 진단0 | 0 | wall11.827s | `page-session-control-target-card-clip-typecheck.log` |
| UI policy |existing0/new0 | 0 | wall3.579s | `page-session-control-target-card-clip-ui-check.log` |
| git diff --check |오류0 |0 |commit직전 |postcommit/source audit |

- Control18+Shell6+Spatial33+ManualExecution11+Viewport13=81. 단일worker. 같은 filter로 UUID/frozen/readonly/invalid first Apply/native Home-End/raw31/portal 내부 포커스/media/default 소비자 회귀를 확인했다. 새 class-only 검사0. 이 cohort를 actual geometry GREEN으로 주장하지 않는다.
- exact command/filter/시작종료UTC/exit/time: `page-session-control-target-card-clip-{direct,typecheck,ui-check}-result.json`.
- baseline/source/commit/currentSHA256: `page-session-control-target-card-clip-source-sha.json`.
- commit/parent/files/cleanstatus: `page-session-control-target-card-clip-postcommit.json`.

## STOP / 후속

- browser실행0. 총괄이 source freeze 후 UX에 동일 case3 후속 grant를 보내면 toolbar 목록44·map≥240·행44·document overflow0·aux/invalid 등 미도달 단계를 판정한다. 새 source actual PASS나 전체 QA 완료를 주장하지 않는다.
- 원f292 listRED와0/100PASS evidence 보존. case5 재검사0, rootplan/status/harness/API/DB/HIL·서비스5173/4000/63200·stash/remote/MAIN/다른worktree/agent/newchat/타담당메시지0.
- ignored 보고서를 총괄 취합용으로 남기고 STOP/WAIT.

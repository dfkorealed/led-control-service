# Task 6 — 제어 표현 교정 보고서

checkout `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-fidelity-control-20261010`, branch `codex/atlas-fidelity-control-20261010`, BASE `a97e2563df7b11bac2a03eebdeb9c7b6e914a01b`(공통 Tasks1–4 고정). Node22.20.0/pnpm9.15.0 확인만; install/prepare 재실행 없음. 소유 `features/control/**` 직접 코드/테스트·`docs/menus/control.md`. 공통/타 메뉴/API/DB/root 계획·상태판 수정, agent/reviewer·브라우저·실제5173/4000/장비 조작 없음.

manual toolbar 층→방식→actions+pressed 도구/아이콘, 제목/큰 선택수/bounded 목록/명시 clear, 단일 초안 밝기+bare Slider, `제어 이력` ticker/plain UUID action, 자동화 중첩 filter card/heading 제거, 그룹 실제 metadata→공통 DataGrid를 적용했다. selection/query/store/command/automation/group owner는 유지한다. summary clear는 controlsLocked 때 차단하고 현재 picker만 비운다. 원 명령/payload/복구 기록은 바꾸지 않는다.

## 검증

명령 prefix `PATH=/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH pnpm --filter @led-control/web exec vitest run`.

| 실행 | 파일(모두 src/features/control 하위) | 결과·로그 |
|---|---|---|
| RED | `{ManualExecutionPanel,ControlView,CommandHistoryPanel}.test.tsx`, `groups/FixtureGroupsPanel.test.tsx`, `target-selection/TargetSelectionToolbar.test.tsx` + `-t fidelity` | 5FAIL/203 filtered-out; vitest/pnpm exit1, `/tmp/task-6-red.log`. 첫 wrapper가 tail로 끝나 shell0이었던 차이도 기록. 각 실제 계약 부재로 실패했고 수집 오류 아님. |
| 계약 GREEN | RED 동일 | 5PASS/203 filtered-out, exit0, `/tmp/task-6-green-contract.log` |
| 직접 소비자 | 위5 + `target-selection/SpatialTargetSelector.test.tsx`, `FixtureGroupDialog.test.tsx`, `automation/components/{AutomationRuleControls,AutomationWorkspaceSurface}.test.tsx`, `automation/{ScheduleControlPanel,VehicleEventControlPanel}.test.tsx` | 11파일 420PASS/3FAIL/skip0, exit1,45.53초, `/tmp/task-6-green-direct.log` |
| 수정파일 GREEN | `{CommandHistoryPanel,ControlView}.test.tsx` | 2파일192PASS/0FAIL/skip0, exit0,21.67초, `/tmp/task-6-green-corrected.log` |

직접 실행 실패3: `preserves adapter hover and focus pauses while unrelated parents reconstruct the same recent commands`, `reads five real recent commands and rotates after exactly five seconds while retaining full history`는 이전 region `최근 이력` locator를 `제어 이력`으로만 연결했다. `keeps the compact latest-history bar concise while retaining detail, drawer and verification entry`는 plain 표현에 원 `max-compact:rounded-none`/PC 기본 rounded-control을 복원했다. timer/44px native UUID/ref·disabled·복구 단언은 줄이지 않았다. 최종 두 파일192개와 소스가 그대로인 나머지9파일의231개를 구분하며 겹친162개를 합산하지 않는다. whole Web/583/Lab/canonical/E2E/type/UI/build/매트릭스/HIL는 요청대로 미실행. diff-check는 commit 전 확인한다.

## 30행 처리·보존

`F=apps/web/src/features/control/`. 공통 처리는 BASE Tasks1–4이며 Task6 신규로 합산하지 않는다.

| 행 | 처리/보존 |
|---|---|
| 01 | 공통 customer pill tabs 소비, mode/site/query/hash/ARIA/권한/roving 유지. eyebrow는 root 후속. |
| 02 | `target-selection/TargetSelectionToolbar` manual opt-in 층→방식→actions 읽기순서/wrap 행. |
| 03 | 실제 mode의 soft active 표현; 기존 current/pressed 의미 유지. |
| 04 | BASE tools/status 순서 + Task6 도구 아이콘·공통 pressed Button. |
| 05 | BASE InlineStatusSummary dot/위계·서버 floor.summary/null·0 유지. |
| 06 | BASE footerStart 범례+camera wrapping footer·240px/camera/zoom 유지. |
| 07 | actual CAD/고유색/camera/gesture owner 불변; fake SVG 복제 없음. |
| 08 | `ControlView` title/customer metric/max-h-24 list/명시 clear, lock 유지. |
| 09 | whole selection missing/unmapped/offline/multi-Gateway 차단 불변. |
| 10 | `ManualExecutionPanel` 단일 visible label/초안·작은 숫자 input/bare slider. |
| 11 | raw invalid·blur/Enter 복귀·same-click Apply 차단 불변/직접 시험 유지. |
| 12 | 0/30/70/100 draft-only·명시 Apply/원handler 불변. |
| 13 | subgrid/remaining-height·workspace/safety 내부scroll/map240 유지; Task11 실제 짧은PC 필요. |
| 14 | 우측 safety/result 내부scroll·진행/긴 결과 접근 유지, 숨김/unmount 추가 없음. |
| 15 | frozen UUID/canonical payload/ACK 원대상/generation/storage owner 불변. |
| 16 | 상태확인/원snapshot 안전재적용 CTA/잠금 유지. |
| 17 | 404/410/보존만료/mismatch/storage/query error/재조회 유지. |
| 18 | verificationcase/위험승인/ref/독립 recovery entry 유지. |
| 19 | `CommandHistoryPanel` 공통 제어이력 title/plain native row/중첩Card 제거, timer/reset 유지. |
| 20 | Drawer/검색debounce/기간raw/stage/limit/cursor/UUID 상세 유지. |
| 21 | schedule 실제 목록/filter/create·period/next/result/timezone 열/query 유지. |
| 22 | `AutomationRuleControls` 외곽Card 제거, `AutomationWorkspaceSurface` 중복 heading/외곽border 제거; pager/summary/overflow owner 유지. |
| 23 | schedule create/edit 주기/timezone/DST/날짜/overnight/dimming/snapshot/dialog 유지. |
| 24 | schedule Power toggle/RowActions/delete-confirm·pending/failed/applied/재조회/scope 유지. |
| 25 | vehicle source/target/brightness/hold/sync/detection·create/edit 유지. |
| 26 | source→target·BIO10/vehicle5~1800s/default60/current eligibility/activation-only 차단 유지. |
| 27 | preparation/catalog/telemetry/degraded/recovery/OFF 안내/current server authority 유지. |
| 28 | event disable/edit/delete/activation-only 차단/scope/generation/sync 유지. |
| 29 | `groups/FixtureGroupsContent` real metadata DataGrid; floor/Gateway/count/lifecycle/Mesh-version/error·canManage/locks/CRUD/resync/delete-focus 유지. mock cell/server sorting 추가 없음. |
| 30 | 원 membership map editor/100limit/floor·Gateway boundary/snapshot/generation 유지, polygon 저장 추가 없음. |

## 한계·handoff

Task11 실제 1024×600 외부scroll0/mapviewport≥240/내부 safety CTA·light/dark/compact geometry·continuous hit·draft/theme/tool/tab/filter/resize POST0 미실행. DOM unit를 실측/HIL로 확대하지 않는다. root 후속 공통 PageHeader eyebrow 및 modeTabs 소비(root 소유), 통합 타입/UI정책/빌드/최종 리뷰·병합 남음. 메뉴문서는 같은 커밋 포함.

## 완료 기록

- Commit: `0e3f20805effe48ee882aa225c0425f54a99a81f` (`feat(web): align control workspace with Atlas UI fidelity`), 소유 범위 14 files, 200 insertions/80 deletions.
- 최종 `git diff --check` exit 0; commit 후 `git status --short` 출력 없음(clean). 브랜치에만 commit, push/merge 없음.

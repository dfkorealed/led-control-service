# 제어 UI 개선 담당 — Task2 C6–8

2026-10-12. 신규 worktree/branch 단독 writer. 작업 위치 `/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012`, branch `codex/map-workspace-comments-20261012`. 시작 HEAD `c4c2961bf380ac8e50cb6304d92029e0655e4c9a` clean. 전달 `a8ded919` 이후 변경은 총괄 plan/status 문서뿐이었다. 기준 `f31e56fadd27d63f96824bad2ea2c4ef71581b62`, Task1 제품 checkpoint `ac323a3dcd128a32ffa73d460e4cfa07d99f0c10`/문서 `87f658ef` 및 API0 보존. 과거 operations WAIT와 별도 작업.

## 승인 brief 실행 체크

- [x] task-2-brief 전체/Task1 결과와 경계/적용 AGENTS/TDD·writing-good-tests·verification 읽기.
- [x] 실제 소비자 제품 RED: 인라인 선택 목록·raw31/More·collapsed 중요 상태·viewer 권한 표시. CSS class RED는 별도 분류 후 실제 소비자 계약으로 교체.
- [x] PC 선택 full-row/empty/internal scroll 소스, 모바일 인라인 전체 보기·Escape focus·현장/주체/층/선택 방식 펼침 reset.
- [x] 단일 실행 row/More internal scroll, raw/invalid 첫 Apply/명령·권한 유지.
- [x] manual-active-only shell 및 선택적 viewport compact chrome/default 보존.
- [x] 직접 GREEN/typecheck/UI policy/diffcheck/자기 검토/제어 메뉴 문서 최신화.
- [x] 원 로그·source SHA·한계·Task3 실제 QA 계약 기록.
- [x] 정확한 소유 13개 source commit 및 사후 소유 diff/SHA 확인 (아래 checkpoint).

## 구현 및 API 경계

`ManualSelectionPanel`은 기존 resolved selection을 표시하는 전용 컴포넌트다. PC empty 포함 h-full/내부 목록 scroll, 모바일 count 바로 아래 전체 보기(44px utility) 인라인 목록(max15dvh)을 갖는다. 기존 조명 목록 drawer는 유지하고 이 펼침을 위한 query/drawer/selection owner는 추가하지 않았다. Escape/opener 및 scope key로 reset한다.

`ManualExecutionPanel`의 `compact=false`, `moreContent`, `importantStatus`는 presentation opt-in이다. 숫자/slider/Apply/More 한 행, More 내부 presets/기존 단일 feedback/history(max25dvh). 기본 소비자는 expanded. 기존 blur/Enter/invalid 첫 Apply guard/별도 Apply 로직은 유지한다. More 닫기에도 feedback/query/UUID/초안 input을 mounted로 유지한다. empty picker보다 frozen 요청의 storage/verification/query/불확정/진행/잠금 상태 및 조회 전용 권한을 우선 표시한다.

`SpatialTargetSelector.compactWorkspace=false`와 toolbar compact는 manual-workspace에서만 적용한다. 층/선택 범위 dropdown/목록 icon 한 행; 기존 모드 변경 확인과 선택 owner를 사용한다. Embedded 구조/default 정책 보존. `FloorMapViewport.compactChrome=false`는 이 수동 모바일 caller만 사용한다. 네 camera control 및 fit/100%/gesture 코드 유지, presentation 크기/footer/남은 height만 변경. 기본 footer min240 유지. renderer/FloorScene 소스/API는 변경하지 않았다.

`CustomerShell`은 page의 authorized manual-active report가 있을 때만 모바일 finite h-dvh/min-h0/남은 grid row/기존 nav safe reserve를 쓴다. Desktop 기존 outer scroll 유지. monitoring/자동화/그룹/editor/권한 gate의 기본 정책은 그대로다. 화면 전환/미디어/테마 테스트는 실제 소비자를 사용한다.

CSS hidden attribute가 grid utility에 덮이지 않도록 명시 hidden class를 추가했다. 모바일 gap4/gap1 충돌은 cn으로 해소했다. 길이가 긴 선택/More는 내부 scroll로 끝 내용을 남긴다. 임의 overflow clip으로 모바일 document0을 주장하지 않았다.

## 원 RED/GREEN 및 정확한 검증 cohort

모든 아래 로그는 이 ignored SDD 폴더의 `page-session-control-*.log` 원본이며 이전 실패를 삭제하거나 PASS에 합산하지 않았다. 준비된 Node22 PATH `/tmp/atlas-ui-fidelity-node22.xde1wS/bin`, pnpm9.15.0만 사용했다.

| 로그 | 결과 | 해석 |
|---|---|---|
| red | 4 FAIL/232 비선택, exit1, 3.40s | 3 제품 RED(인라인 전체 보기/More 부재), 1 shell class 검출. class 실패는 실제 height 증거가 아님 |
| viewport-red | 1 FAIL/43 비선택, exit1 | min-h0 class 검출을 제거. 남긴 viewport/surface/zoom/default test는 호환성 GREEN이며 새 기능 RED로 주장하지 않음 |
| green-first | 4 PASS/1 FAIL, exit1 | More toggle 시 summary DOM이 unmount됨; mounted 표시로 교정 |
| green-second | 5 PASS/275 비선택, exit0 | 첫 소비자 GREEN |
| leaf-green | 85 PASS, exit0, 4.07s | 중간 ManualExecution9/Viewport44/Spatial32; 최종 전체 cohort로 확대하지 않음 |
| consumer-green | 65 PASS/1 FAIL, exit1 | 지원하지 않는 matcher 사용; CalledOnce+CalledWith로 교정. 제품 원인0 |
| status-red | 2 FAIL/164 비선택, exit1 | empty picker가 복원 명령 조회 오류/검증 필요를 가림; 중요 상태 우선순위 교정 |
| consumer-final | 68 PASS/194 비선택, exit0, 7.69s | 중간 command UUID/복원/재전송/잠금/scope/selection/shell 소비자 회귀. 아래 최종과 합산하지 않음 |
| leaf-final | 22 PASS/31 비선택, exit0, 2.65s | ManualExecution9 및 Viewport13 직접 회귀 |
| permission-red | 1 PASS/1 FAIL/165 비선택, exit1 | compact 조회 전용 상태가 empty picker 뒤로 숨음; 권한 요약 우선 표시로 교정 |
| final | 5 files, 41 PASS/275 비선택, exit0, 4.75s | 모든 최종 제품 소스의 직접 consumer 검사. 아래 identity hardening 직전 테스트 소스 |
| identity-final | 2 files, 2 PASS/209 비선택, 3.32s | 실제 scene/surface non-null을 먼저 확인한 최종 2개 테스트 보강. 제품 변경0. final의 두 케이스 재검사이므로 43 unique로 합산하지 않음. 원 실행 tool exit는 출력 잘림으로 재기록하지 않고 PASS 원 로그 보존 |
| typecheck-ready | `pnpm --filter @led-control/web exec tsc --noEmit`, exit0 | 최종 제품 타입 확인, 출력 없음 |
| ui-check-ready | `pnpm --filter @led-control/web ui:check`, exit0 | existing0/new0 |

최종41 실행: `pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx src/features/shells/CustomerShell.test.tsx src/features/control/target-selection/SpatialTargetSelector.test.tsx src/features/control/ManualExecutionPanel.test.tsx src/features/floor-map/FloorMapViewport.test.tsx -t 'C6-8|keeps every control disabled for viewer accounts|ManualExecutionPanel|manual-cad|footer|maintains|resize|real authorized manual|manual route and query|real page changes|navigation breakpoint to the real Control' --reporter=dot`.

Identity 보강2 실행: `pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx src/features/floor-map/FloorMapViewport.test.tsx -t 'C6-8 mobile expands|C6-8 optional compact' --reporter=dot`.

자기 검토: 정해진 13개만 source ownership, source handler/command/query 중복0, default false API, 원 command owner 및 renderer/camera/gesture handler 변경0, 명시 Apply/invalid guards 보존, readonly/restore/queryerror 요약의 실제 소비자 RED→GREEN 확인. 전체 Web/build/browser/HIL PASS를 주장하지 않는다. source SHA256은 `page-session-control-source-sha.json`에 최종 13개와 commit 직전 HEAD를 기록한다.

## Task3 QA 계약 및 남은 한계

| 범위 | 실제 QA 확인할 항목 |
|---|---|
| PC | empty 포함 선택 panel/map 행 높이 일치, 긴 이름 목록의 내부 scroll와 끝/해제 도달, 이력/복구 마지막 action 도달 |
| 320/390×600 | 실제 canvas240 이상 목표·map 우세 비율, document scroll0, nav safe reserve 겹침0. compact min-h0이므로 실제 잔여 공간이240 미만일 수 있음: 수치로 판정 필요 |
| 모바일 한 행 | floor/scope/list 및 numeric/slider/Apply/More 줄바꿈·overflow 없음, 버튼/목록/카메라 hit 실제44 이상, 긴 층/구역/큰 글꼴 |
| 목록/More | 각각 및 동시에 펼침, 내부 scroll 끝 내용과 action 도달, Escape/close/opener focus 및 scope reset, 중요 live 상태 collapsed 가시성 |
| 수명/default | 실제 renderer/camera 유지 및 resize/theme, raw31/invalid/첫 Apply/동일 UUID recovery, readonly/locks; monitoring/default/embedded/schedule/events/editor regression |

JSDOM class 문자열/DOM identity는 실제 layout·pointer capture·touch·safe-area 증거가 아니다. 실제 화면·최종 독립 review·MAIN 통합은 총괄 후속 관문이다.

## 작업 경계

소유 13개 제품/직접 tests/control 메뉴 문서만 변경했다. SDD의 내 report/log/source SHA만 기록했다. 총괄 `docs/project-status.md` 및 plan은 동시 작업 dirty이며 읽기만 했다. 다른 메뉴/API/DB/equipment/서비스5173·4000·63200/다른 worktree/stash/remote/배포/MAIN에는 변경0. 설치/prepare/build/새 서버/browser/helper/서브에이전트/타 chat message 없음. source commit 후 STOP/WAIT.

## 최종 source checkpoint — STOP/WAIT

- Source commit: `9f3e25d7460e215c242d775b83c6c32e3f32546f` (직접 parent `c4c2961bf380ac8e50cb6304d92029e0655e4c9a`).
- Commit 13개 정확히 ownership 목록과 일치; 모든 commit blob SHA256 및 현재 working source가 검증 snapshot과 일치. 소유 source diff0.
- Commit 직전/직후 총괄 두 문서 SHA 동일: `True`. 전체 worktree는 총괄 두 문서 dirty로 clean이 아니며 본 담당 소유는 clean.
- 잔여 상태:

```text
 M docs/project-status.md
 M docs/superpowers/plans/2026-10-12-map-workspace-comments.md
```

직접 제품/테스트/메뉴 문서 구현 인계 완료. Task3 actual QA/독립 review/MAIN 통합 미수행. 추가 변경 없이 STOP/WAIT.

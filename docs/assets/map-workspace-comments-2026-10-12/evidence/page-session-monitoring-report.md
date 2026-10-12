# 모니터링 페이지 담당 — C1–5 인수 보고

상태: **인수·자체 소스 검토·직접 검증 완료 / Task2 및 최종 실제 QA·독립 검토·MAIN 병합 대기**.

문서 인수 커밋: `87f658ef9ff9656ea288fbdbb611467bfcd742a8` (`docs/menus/monitoring.md` 1줄만 변경). 문서 수정 후 `git diff --check` exit0, 커밋 후 tracked/index clean 확인. 제품 checkpoint `ac323a3d`는 불변이다.

## 인수와 source cohort

- 신규 worktree `/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012`, branch `codex/map-workspace-comments-20261012`, baseline `f31e56fadd27d63f96824bad2ea2c4ef71581b62`.
- 기존 writer 종료/release를 전달받은 뒤 인수. 제품 checkpoint `ac323a3dcd128a32ffa73d460e4cfa07d99f0c10` 5파일과 기존 RED/중간 실패/국소 GREEN/보고서를 그대로 보존했다.
- 검증 HEAD `1ded19a6b07626146646e927102bb5b678f879b3`는 총괄 문서 전용 후속이다. `git diff ac323a3d HEAD -- <소유5파일>` 출력0을 확인했고 제품과 테스트를 추가 수정하지 않았다. 기존 구현/RED를 되풀이하거나 새 설계를 만들지 않았다.

| 파일 | 검증 시 Git blob |
| --- | --- |
| `apps/web/src/features/monitoring/FloorMap.tsx` | `558a2c949b4edb936bd9167816c60c29d8f4624f` |
| `apps/web/src/features/monitoring/MonitoringView.tsx` | `8aa365b0d4380663e6297b3f76020a5bc8bc6068` |
| `apps/web/src/features/monitoring/FloorMap.test.tsx` | `436cdf61fb78bdc3a198e3e1006e894d4a739029` |
| `apps/web/src/features/monitoring/MonitoringView.test.tsx` | `eb07cac086322827c43751069732612f1019e6c9` |
| 인수 전 `docs/menus/monitoring.md` | `94b4c3cbc23485edc82bb39657a8557e06e16257` |

## 자체 검토 결과

- C1: `FloorMap`이 기존 `manual-cad`/`pan`을 직접 소비한다. `FloorScene`의 single selection과 기존 viewport/camera/ref subtree를 유지하고 area callback·새 공통 API·viewport 기본값 변경이 없다.
- C2: metadata valid + query error 없는 순수 stale만 `announce:false`. 기존 현재 화면 상태/retry/fresh 복구 제거를 유지한다. fixture error/invalid/future는 `announce:true`, 새 server incident/unread producer 없음.
- C3–4: loading/error/empty/main의 h1은 sr-only. floor/finder/time/refresh가 같은 도구 그룹이며 narrow icon은 기존52px utility·accessible name을 사용한다. compact HH:mm는 기존 strict formatter의 검증된 출력에서 얻고 전체 site-time/dateTime 정보를 유지한다.
- C5: 기존 OperationMapPanel의 relative body에 out-of-flow 하단 h-1/2 aside를 배치한다. modal/desktop 분기·재부모화 없이 기존 map subtree를 유지한다. 고정 제목/닫기와 본문 scroll 분리, Escape/원 opener·scope-aware 자동 제거/scroll 기억을 소비한다. wheel listener는 viewport 소유이고 sibling aside에서 발생한 wheel이 그 viewport로 bubble하지 않는 구조다. 실제 geometry/gesture/wheel 결과는 후속 browser 관문에서 확인해야 한다.
- 인수 중 직접 확정된 추가 제품 결함/공통 API 필요 없음. 제품 변경0; 메뉴 문서에 이 새 직접 일괄 검증과 한계를 추가했다.

## 새 직접 검증 — 부족한 cohort만 보충

기존 보고서의 126PASS/1FAIL 뒤 국소 경계/시각/gesture PASS를 최종 일괄 결과로 합산하지 않았다. 현재 제품의 누락된 직접2suite 결과만 한 번 실행했다.

```sh
export PATH="/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH"
pnpm --filter @led-control/web exec vitest run src/features/monitoring/MonitoringView.test.tsx src/features/monitoring/FloorMap.test.tsx --reporter=dot
```

- 실제 Node `v22.20.0`, pnpm `9.15.0`.
- 종료코드 **0**, **2 files /127 PASS /0 FAIL /0 SKIP** (`FloorMap`17 + `MonitoringView`110), **18.14s**. 실행 시작 로컬 2026-10-12 10:11:53 KST.
- 새 원 로그: `page-session-monitoring-direct.log`. 기존 `task-1-*.log`와 `task-1-report.md` 변경/삭제/덮어쓰기0.
- snapshot boundary/복구/오류·invalid/future, 실제 공통 gesture 소비·단일 선택, 상세 nonmodal/viewport DOM 수명·본문 scroll 재열기, 기존 principal/site/floor/unmount/outside focus 회귀를 포함한다. JSDOM geometry와 시험용 hit API는 실제 브라우저 좌표 증거가 아니다.
- `git diff --check`를 문서 수정 뒤 실행하여 exit0을 확인했다. 새 전체 Web/Gateway/API suite·정적 gate·build/prepare/install·브라우저 실행0.

## 인계할 경계·남은 검증

- 공통 새 API/component/export 없음. Task2는 기존 OperationMapPanel body의 relative containing block, 기존 Button/Heading/renderer를 사용하면 되며 모니터링 파일을 재편집할 필요 없다.
- 실제 1194px/320·390px 한 행·양 테마/52px 연속 hit·HH:mm glyph, overlay 전후 map rect/camera/canvas identity, 화면 약 절반의 실제 ratio, 짧은 모바일 close/끝 내용/nav hit, real middle/Space pan·touch swipe→tap·ghost click 및 상세 wheel 시 지도 zoom 불변은 미실행이다. 기존 `task-3-preflight.md`의 후속 한정 실제 QA에서 검증할 범위다.
- jsdom sr-only 클래스 확인을 실제 visible glyph 제거 판정으로 확대하지 않는다. 타입/UI 정책/build/독립 검토/MAIN 병합도 총괄 후속 관문이다.
- 다른 메뉴·공통 viewport/session provider·API/DB/장비/의존성/기존5173·4000·63200·다른 worktree/stash/원격 변경0. 새로운 child delegation/세션/답신 메시지/서비스 실행0.
- 계획/상태판은 총괄 소유로 그대로 두었다. 기존 source checkpoint를 보존하여 제어 담당의 순차 구현을 이어갈 수 있다.

## 2026-10-12 12:49 KST — 통합 App test 계약 정합 후속

- 재개 BASE: clean `d2a83cfb2a852654b01cc2ea44bac19a5f3b2bf8`. 총괄이 별도 MAIN 변경을 통합한 상태를 보존하고, 승인된 App test lookup만 단독 수정했다.
- 커밋: **`2e11844e2a181ffb5f578d4d67f6a19b890e315f`** — `test(web): align monitoring detail with nonmodal overlay`. **`apps/web/src/App.test.tsx` 1파일, 8추가/8삭제**, 최종 blob `b464b3ca51117e53f2e3762c84f2f3950879e3d2`.
- 원 RED `final-d2a-integration-unit.log`(총괄의116run·111PASS/5FAIL)을 실제 stack과 대조했다. 승인 C5는 `complementary / 조명 상세` 및 내부 `complementary / 선택 조명 상세`인데 helper가 과거 compact modal을 기대했다. helper 외 동일 조회928/1183도 같은 원인으로 총괄이 allowlist에 추가 승인했다.
- 세 lookup의 role/name만 현재 nonmodal 계약으로 정합하고 관련 sheet 변수/주석을 overlay로 갱신했다. 부모와 내부 상세 범위·선택 조명 내용·기술정보 미노출·viewer 권한 assertion을 유지했다. 검색/목록 dialog·비밀번호 modal·기존 fixture/selector/header·skip/timeout/role권한 gate는 변경하지 않았다.
- 추가 allowlist 전달 전 시작된 helper-only 실행 `page-session-monitoring-app-helper-green.log`는 **67PASS/2FAIL /exit1 /10.64s**. 원 helper5실패 뒤 가려져 있던 동일 원인의 inline 두 lookup 실패이며 로그를 보존한다. 이를 독립 제품 결함이나 PASS로 바꾸지 않는다.
- 최종 명령: `PATH=/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH pnpm --filter @led-control/web exec vitest run src/App.test.tsx --maxWorkers=1 --minWorkers=1 --reporter=dot`.
- 새 최종 로그: **`page-session-monitoring-app-green.log`**. **1file/69PASS/0FAIL/0SKIP, exit0,10.91s**, 시작12:48:35 KST. 원116 전체 결과를 재실행/PASS로 주장하지 않는다. 기존 모니터링127·전체suite·정적관문·브라우저는 재실행하지 않았다.
- `git diff --check` exit0, commit후 tracked/index clean. BASE→commit는 App test1파일뿐이며 monitoring/common 제품·메뉴 기능 변경0이므로 메뉴 문서를 중복 수정하지 않았다. MAIN/API/DB/장비/서비스/다른 writer/new agent/원격/plan/status 변경0.
- 이번 단일 test 수리와 인계를 마쳤으며 **STOP**. UX/제어 제품 변경과 후속 통합판정은 총괄이 조율한다.

## 2026-10-12 — App role query 타입 오류 후속

- 재개 BASE: clean `2e11844e2a181ffb5f578d4d67f6a19b890e315f`. 앞선 App69 PASS는 타입 검사 통과를 의미하지 않았으며, 원 타입 실패 로그 `final-2e-typecheck.log`를 보존한다. 실제 진단은 ByRoleOptions에 없는 `exact`에 대한 TS2769이다.
- 커밋: **`2290a877d880efc60f91bbd3396a47d9361b3fbf`** — `test(web): use supported monitoring role query options`. `apps/web/src/App.test.tsx` 단독 4추가/4삭제, blob `0356512fa894667bca3751cff22164e0f1959a32`.
- 승인된 네 query에서 `exact: true`만 제거했다. 문자열 name·role·조회 범위·assertion을 그대로 유지했다. 설치된 `@testing-library/dom@10.4.1`의 role.js 및 matches.js에서 문자열 name은 `normalizedText === String(matcher)`로 완전 일치함을 확인했다.
- 동일 Node22 PATH에서 `pnpm --filter @led-control/web exec vitest run src/App.test.tsx --maxWorkers=1 --minWorkers=1 --reporter=dot`: **exit0, 1file/69PASS/0FAIL/0SKIP, 10.57s**, 시작12:52:19 KST. 원 로그 `page-session-monitoring-app-role-options-unit.log`.
- `pnpm --filter @led-control/web exec tsc --noEmit`: **exit0**, 정상 무출력. 원 로그 `page-session-monitoring-app-role-options-typecheck.log`(0bytes). 앞선 원69·중간 실패·typeRED는 덮어쓰지 않았다.
- `git diff --check` exit0, 커밋 후 tracked/index clean, BASE→HEAD 변경은 App test1파일뿐이다. 제품/메뉴/Main/서비스/에이전트/브라우저/실제QA/전체suite 변경 및 실행0. 한정 수정·검증·보고를 완료하고 **STOP**.

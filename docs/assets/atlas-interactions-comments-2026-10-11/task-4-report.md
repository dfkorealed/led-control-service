# Task 4 QA 보고서 — 2026-10-12

## 결론

제품 source `437ebc391614e8d7dc995de38108c78a01efb67b`에서 6개 고유 case와 최종 reviewer의 case2 marker-origin 추가 gate가 **분리된 국소 실행에서 통과**했다. marker 준비 단계의 원 실패 두 건은 보존했으며, 제어 소유자의 read-only 원인 확정(카메라 pan으로 본문 sticky occlusion을 복구할 수 없음)에 따라 root가 승인한 마지막 1회에서 실제 본문 wheel 복귀 후 gate가 통과했다. 최종 spec 전체6를 한꺼번에 재실행한 결과는 아니다. 제품 수정0, 테스트 기준/timeout 완화0.

## 소스와 정적 검증

- workdir: `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-interactions-comments-20261011`
- 공통 runtime: `PATH=/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH`.
- 원 source `77f8608f0ee72e2efda8a8b42ab9580eb495726f`: `pnpm --filter @led-control/web typecheck` exit0; `test:ui-policy` 78/79 exit1; `ui:check` exit1; `build` exit0.
- 원 실패: `Popover.tsx` `rounded-t-panel` unapproved-theme-utility 1건. 원 로그 덮어쓰기 없음.
- 제품 owner의 스타일만 수리된 `437ebc39`: `test:ui-policy` 79/79 exit0; `ui:check` exit0; `build` exit0. 타입을 바꾸지 않은 스타일 경계로 기존 typecheck source cohort를 유지했고 중복 실행하지 않았다.
- 빌드의 >500kB chunk warning은 그대로 기록/미수리. 기존 SettingsShell 카드 테스트1 baseline failure는 이전 근거로만 표시하며 이번에 해당 test/full suite를 실행하지 않았다.
- C8 source/test diff(`cc6b9a7a`부터) 0. hash: source `d4b216445f8f1b34b21cb085a62dd60c2c9f7179`, test `4856a77d2c84fc1dbf8dd3bb1f9bdf3c2ebf7c35`.

## 실제 브라우저 실행

공통: `E2E_WEB_PORT=15187 pnpm --filter @led-control/web exec playwright test e2e/atlas-interactions-comments.spec.ts --workers=1 --retries=0 --reporter=line` + 아래 grep/output. `--list` exit0, **6 tests in 1 file**. 6고유 case, **7 runs / 21 executions = 6+6+3+3+1+1+1**. source 제품 변경0. 새 spec/fixture만 국소 교정했다.

| run / output(test-results/atlas-interactions-) | grep | 결과/exit | 분류 |
| --- | --- | --- | --- |
| initial | 없음 | 0PASS/6FAIL,1 | mockDashboard에 API capabilities 누락, 실제 권한 경고로 모두 차단 |
| fixture-fixed | interactions [1-6] | 3PASS/3FAIL,1 | case1/2/4 PASS. 3 header strict locator,5 request/target identity 불일치,6 innerText/textContent 혼용 |
| locators-fixed | interactions (3\|5\|6) | 0PASS/3FAIL,1 | 3 monitoring aria-current 계약,5 숨은 정렬 option DOM text,6 SVG 뒤 tick 아직 준비 전 |
| contract-fixed | interactions (3\|5\|6) | 3PASS,0 | 실제 monitoring 계약/card dt/실제 tick-value 가시성 기준 교정. 수치·기대·timeout 완화0 |
| marker-origin | interactions 2 | 1FAIL,1 | reviewer 요청 추가 gate, 지도 rect 중앙이 sticky shell 뒤: marker center hit 실패, gesture 전 |
| marker-reachable | interactions 2 | 1FAIL,1 | 실제 blank hotzone으로 bounded CDP recenter했지만 marker center hit 실패, gesture 전. 추가 실행 중지 |
| body-restored | interactions 2 | 1PASS,0 | read-only 원인 대조 후 root 승인. 실제 gutter body wheel 복귀→marker hit→native CDP marker swipe/선택불변/후속tap/전체44 nav bounds 통과 |

6개 기존 case 범위: (1) PC toggle/blank 7→8px marquee/Escape/second marker marquee/wheel/middle·Space pan/raw31; (2) touch tap/blank held-touch no area/blank swipe camera pan/pinch cancellation/short dark central clear44; (3) monitoring one opener/name-number/filter/selected pin/5legend/site-only; (4)390·320 short bottom sheet/date one-line/keyboard focus/nested calendar Escape restoration/last close reachable; (5)577 dark four summary fields/details below/action enabled/stable expanded row key after sort/collapse/full period; (6)PC·390 chart bounds/ticks pairwise non-overlap/sr-only h1/C8 exact text and values.

## 마지막 추가 gate 원 실패와 최종 근거

- case2는 zoom controls의 native scroll-into-view 후 지도 일부가 sticky shell 아래에 있다. 첫 추가 run의 전체 map rect 중앙 recenter는 가려진 위치를 목표로 삼았다.
- 두 번째 추가 run은 실제 elementFromPoint가 도면을 가리키는 blank hotzone에서 bounded native CDP swipes로만 recenter했지만 24번 제한 뒤 marker hit가 false라 gate 앞에서 멈췄다. 제어 소유자 read-only 대조 결과 camera-pan으로는 본문 sticky occlusion을 복구할 수 없다는 setup 원인이 확정됐다.
- 당시 catch는 원 screenshot/error만 저장하여 각 camera/marker rect/hit chain이 없었다. 이 실측 부재도 원문으로 보존했다. root 승인 최종 run에만 입력전/실패 catch의 실측을 추가했다. 제품 결함이 아니며 승인 없는 재실행/카메라·CSS 주입/force/가짜 pointer dispatch/skip/timeout 확대는 하지 않았다.
- 최종 gate 실제 geometry: zoom1.8, body scrollY388/map y-3/topbar bottom118/hitHEADER→캔버스 밖 x8 gutter 실제 wheel(-1200) 후 scrollY0/map y385. visible map hotzone은 nav top532 위다. 원 24회 제한 그대로 native swipe recenter 후 marker x80.265625,y445.703125,48×48,bottom493.703125, center hitBUTTON/isMarkertrue. marker-origin32px CDP swipe에서 camera(0,0)→(8,8), 전체 selection array 불변/area0; 다음 tap false→true 정상.
- fixednav 실제 `[data-shell-navigation="compact"]` 적용, 전체 clear button bottom<=nav.top+기존1px 통과. 최종 clear x264.09375,y332,width85.90625,h44,bottom376<=nav top532. 전체44 continuous hit helper도 통과. raw JSON에 전/후 camera·map/topbar/nav/marker rect/hit 정보 저장했다.
- 미배치·pageerror·viewer download 전송·중첩select는 실제 browser 직접 assertion 범위 밖이며 제품 owner focused unit 근거만 남는다. 날짜 개별 numeric segment44폭 예외를 준수했다. group/calendar 계약 수치는 JSON에 보존했다.

## 증거/정리

- ignored canonical raw: `.superpowers/sdd/2026-10-11-atlas-interactions-comments/task-4-raw/`.
- 원/중간/최종 로그와 top-level PNG/JSON/error-context를 `docs/assets/atlas-interactions-comments-2026-10-11/`에 기계적으로 복사했다. README가 대표 절대 경로를 제공한다.
- 모든 screenshot은 실제 render 후 testInfo.outputPath로 저장하고 path attach했다. 실패의 원 자료는 변경하지 않았다.
- 순수 UI mock API 관측 writes=[]; 사용자5173/4000/63200 untouched. 실제 서버/DB/장비/HIL/실제 다운로드 transport/Native WebView는 미검증.
- `lsof -nP -iTCP:15187 -sTCP:LISTEN` 최종 결과 출력0/exit1: Playwright owned webServer 종료, listener 없음. root 소유 docs/project-status.md dirty 보존. QA owned spec/assets만 explicit stage/commit하며 ignored canonical report는 add-f하지 않는다.

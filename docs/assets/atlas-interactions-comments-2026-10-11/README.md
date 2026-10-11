# 브라우저 조작·필터 QA 증거

제품 source: `437ebc39`. 6고유 case / 7 runs / 21 executions(6+6+3+3+1+1+1). 6개 case와 추가 marker-origin gate는 **분리된 국소 실행에서 통과**했다. 최종 spec 전체6를 한꺼번에 다시 실행한 결과는 아니다. 원 실패를 포함한 logs/PNG/JSON/error-context를 run 이름별로 그대로 보존했다.

정적: 원77f8608f typecheck/build0, policy78/79·ui1. 스타일 수리437ebc39 policy79/79·ui0·build0. C8 source/test diff0. 기존 SettingsShell baseline1 failure는 이번 미실행, chunk warning은 유지했다.

첫 run은 mock API capabilities 누락. 이후 DTO와 실제 DOM locator/text 읽기/axis readiness만 교정했고 제품·threshold·timeout·retry 변경0. `fixture-fixed`에서1/2/4 PASS, `contract-fixed`에서3/5/6 PASS. 최종 reviewer 추가 marker-origin case2는 원 `marker-origin`/`marker-reachable`에서 gesture 이전 hit setup FAIL. 제어 소유자 read-only 원인 확정 뒤 root 승인한 `body-restored` 1회에서 실제 본문 gutter wheel 복귀 후 gate 전체PASS. 기존5개 green 재실행0.

대표 실제 렌더 이미지/좌표(아래 workspace prefix는 `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-interactions-comments-20261011/docs/assets/atlas-interactions-comments-2026-10-11/`):

- [PC native CAD](/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-interactions-comments-20261011/docs/assets/atlas-interactions-comments-2026-10-11/fixture-fixed/atlas-interactions-comment-ee699-rve-selection-and-raw-draft-chromium/manual-pc.png), 같은 폴더 manual-pc.json.
- [짧은 dark touch/clear](/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-interactions-comments-20261011/docs/assets/atlas-interactions-comments-2026-10-11/fixture-fixed/atlas-interactions-comment-416c4-rk-actions-remain-reachable-chromium/manual-touch-dark-short.png), 같은 폴더 JSON.
- [320 bottom sheet/date](/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-interactions-comments-20261011/docs/assets/atlas-interactions-comments-2026-10-11/fixture-fixed/atlas-interactions-comment-83a5a-tay-one-line-at-390-and-320-chromium/filter-sheet-320.png),390도 같은 폴더. 실제 nested calendar Escape→calendar focus→sheet close→opener focus 검증.
- [577 dark reports](/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-interactions-comments-20261011/docs/assets/atlas-interactions-comments-2026-10-11/contract-fixed/atlas-interactions-comment-ffb5d-e-row-and-preserves-actions-chromium/reports-dark-577-details.png), 같은 폴더 JSON.
- [390 chart](/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-interactions-comments-20261011/docs/assets/atlas-interactions-comments-2026-10-11/contract-fixed/atlas-interactions-comment-0d65e-C8-content-at-PC-and-mobile-chromium/overview-390.png),1440도 같은 폴더. JSON에 tick bounds/C8 원문.
- [마지막 미완료 marker gate 원 실패](/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-interactions-comments-20261011/docs/assets/atlas-interactions-comments-2026-10-11/marker-reachable/atlas-interactions-comment-416c4-rk-actions-remain-reachable-chromium/manual-touch-original-failure.png).
- [최종 marker-origin 실제 native touch](/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-interactions-comments-20261011/docs/assets/atlas-interactions-comments-2026-10-11/body-restored/atlas-interactions-comment-416c4-rk-actions-remain-reachable-chromium/manual-marker-origin-touch.png), 같은 폴더 JSON에 모든 phase camera/rect/hit와selection array. body scrollY388→0, marker48×48/bottom493.70<nav532, camera(0,0)→(8,8), selection불변/다음tap정상.
- [최종 short clear/nav bounds](/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-interactions-comments-20261011/docs/assets/atlas-interactions-comments-2026-10-11/body-restored/atlas-interactions-comment-416c4-rk-actions-remain-reachable-chromium/manual-touch-dark-short.png), 같은 폴더 JSON. clear y332,h44,bottom376<=실제nav top532.

raw/에 명령별 로그 보존. canonical 상세 보고서는 ignored `.superpowers/sdd/2026-10-11-atlas-interactions-comments/task-4-report.md`.

한계: headless Chromium controlled mocks이며 모든 관측 API 쓰기0. 장비/HIL/실제 DB·다운로드 transport 미실행. 미배치/pageerror/viewer 다운로드/중첩select 직접 browser assertion은 수행하지 않았다. 원 marker setup 실패 catch에는 상세 camera/rect/hit chain이 없었으며 원 자료는 그대로 남겼다. 최종 catch 및 입력전에는 실제 phase metrics를 추가했고 marker-origin/native pointerup와fixednav 전체44 visible assertion까지 최종case2에서통과했다. Owned15187 종료 확인, 사용자 서비스 untouched.

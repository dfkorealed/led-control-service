# UI/UX actual-five — frozen2290a877

## 판정
**Merge/Ready 관문 보류:3 PASS /2 FAIL /0 SKIP /0 FLAKY, exit1,30.730032s.** 실제5 loaded/body5/retry 모두0, runner errors[]. 기존6고유 선언 중1~5만 실행했으며6은 제외됐다. Cohort를 합산해11개 또는 새6개라고 계산하지 않는다. Case6은4093 PC PASS의 별도 source-carry 근거이며2290 fresh PASS가 아니다.

- Source `2290a877d880efc60f91bbd3396a47d9361b3fbf`, branch `codex/map-workspace-comments-20261012`, same worktree.
- Run `actual-five-hit-2290a877-20261012`, workers1/retries0/timeout30000 그대로. UTC raw start03:56:23.425는2026-10-12 12:56:23.425 KST.
- [Raw log](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux-hit-2290a877.log), [results JSON](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-five-hit-2290a877-20261012/results.json). 실패2건 original-failure JSON/failure geometry/failure PNG/runner screenshot 모두 보존, capture error0.
- 실행 전/후 fullHEAD2290 일치/clean/제품 diff0, 종료 후15188 lsof exit1/output0. 자동 재실행0. 이후 root가 승인한 prep-only 하네스 수정과 다음f28 grant는 아래 별도 기록하며 이 실행을 변조하지 않는다.
- Owner App69PASS/root2290type0/d2a policy79 및c9direct79는 별도 static/owner 결과로 이번 browser3PASS에 합산하지 않는다.

## 사례별 실제 도달 / 한계
| Case | 결과 | 실제 검증 및 미도달 |
| --- | --- | --- |
| 1 PC1194 monitoring light | PASS3.389s | Native middle/Space/wheel, single selection, half overlay, last dd 미배치 full viewport/native center, header/camera/renderer 불변, close focus, native pin 재클릭/reopen/scroll restore/Escape focus까지 완료. Body374/374/top0이므로 PC 양의 내부 scroll range 검증은 아님. |
| 2 monitoring390×600 dark | PASS2.078s | Toolbar/nav44·HH:mm/fullaria/datetime, single/half/identity; native document0→83 후 body ending239/(342−103), last dd full viewport/actualCenter, close/reopen/restored ending/Escape focus 완료. Map360×240/y254→171은 문서 이동이며 y+scrollY254/카메라 불변. 상단 복귀 flow는 별도 실행하지 않음. |
| 3 manual320×600 light | FAIL1.790s | Basic camera44/251px≥240/dominance/finite/actual exposure 및 두 row 정렬 완료. 실제 첫 pin 선택1, keyboard Home으로 input/range 모두0 확인. 이어 input/thumb/Apply/More 병렬 continuous44 중48×44 대상이 false. 실패 target 이름·개별 hit 좌표는 저장되지 않아 특정 컨트롤로 확정 불가. Endpoint0 전체44 PASS/100/raw31/aux/invalid101 첫Apply 모두 미도달. |
| 4 manual390×600 dark hasTouch | PASS7.161s | Basic camera44/249px≥240/finite 확인 후 진짜 zoom1.8, 노출 marker 시작 native swipe가 selection0/camera 이동, 다음tap1. Floor60, 실제 shared body ending1922/(2062−140), last60 full viewport/native hit/header 고정. List close/focus/reopen→More→list→실제 close/focus, 모든 aux rect/camera/renderer/anchors/exposure 완료. 모든60 pin 개별44나 실제hardware recovery 검증은 아님. |
| 5 manual717×1227→390×844 light | FAIL7.352s | Initial699×878 basic camera44/map240/finite/exposure 완료, 실제 pin1/raw31 도달. 그 뒤 빈 critical live region에 무조건 visible을 요구해 실패. 원 source는 정상 empty 상태를 허용한다. Aux/resize/focus 보존 검증은 전부 미도달; 관측 map896은 새 resize PASS가 아님. |

### Case3 — 정확한 target 식별 한계 / thumb 비교
Frozen spec343의 `Promise.all([input,thumb,apply,more].map(expectContinuous44Hit))`에서 에러가 발생했다. helper는 실패 시 `{width:48,height:44,continuous44:false}`만 반환하며 locator/name/target bbox/sample matrix를 남기지 않았다. Original failure stack도 병렬 배열의 개별 target index를 제공하지 않는다. 따라서 input/Apply/More 중 정확히 어느 target인지 이번 증거만으로 확정하지 않는다.

Saved failure geometry에는 실행 row(8,480,304,44)의9 coarse samples만 있다. 숫자 입력으로 실제 hit한 점은(38.4,484.4)/(38.4,502)/(38.4,519.6), 모두 INPUT/밝기 수치다. 이는 입력의 일부 도달만 증명하며 연속44폭이나 오른쪽 경계의 가림을 증명하지 않는다. `Slider.tsx`의 실제 outer thumb는 h-13/w-13=52px이고 track endpoint에서 숫자 input 쪽으로 확장될 수 있다. Failure PNG에서0 thumb의 focus frame이 숫자 입력 쪽으로 가까워지는 것이 보인다. **겹침은 우선 가설이지만 outline은 실제 hit owner 증거가 아니며, 개별 input/thumb bounds와 겹침 지점 elementFromPoint가 저장되지 않아 확정하지 않는다.** Bounding box48×44를 reachable44 PASS로 바꾸거나 force/추가zoom/threshold 완화하지 않는다.

### Case5 — empty live region과 실제 critical text
Frozen `ControlView.tsx:571–583`의 importantManualStatus는 storage/verification/command/recovery/readOnly/block/lock/message가 없으면 마지막 **빈 문자열""**을 반환한다(null이라고 단정하지 않는다). Typed3-fixture seed는 online/reported/controllable:true이고 첫 조명은정상70%; snapshot은 정상 조명 선택1/전송 가능/raw31을 보여 준다. First-pin consumer가 message를""로 초기화한 뒤 command 전송/복구 작업은 없었다. Raw failure DOM은 aria-live=polite/aria-atomic=true인 빈 status이며 saved height0(717의 y1155), hidden critical text가 아니라 내용 없는 live owner다. 따라서 이 실패를 실제 중요 경고 가림으로 분류하지 않는다.

반대로 before-selection basic에는 `제어 대상을 하나 이상 선택해 주세요.`가 nonempty18px/visible이고 native center 검사가 실제 통과했다(직접 PNG 확인). Case4 floor60의 Gateway0/1 준비·Mesh설정 중18px 중요 문구는 aux가 열린 동안에도 visible/native center를 통과했다. 정상 empty 상태와 실제 critical 메시지 reachability를 구분한다.

## 실제 geometry / occlusion
| 상태 | Raw map | Actual exposed px² | 분리된 관측 |
| --- | --- | --- | --- |
| PC monitoring detail | 916×852 | 419986 | Detail458.5/parent917 half, camera0/0/1. |
| Mobile monitoring detail after page wheel | 360×240 | 64620 | 문서83, body239/(342−103), detail bottom530<nav532. |
| Manual320 basic | 302×251 | 62286 | Camera opaque baseline13516, aux-added0, document600/600/top0. |
| Manual320 selected endpoint0 failure | 302×269 | 67722 | Empty critical row18→0로+18 관측; camera0/0/1, aux 닫힘. |
| Manual390 closed60 | 372×249 | 79112 | Baseline13516/aux-added0, camera115/85/1.8. |
| Manual390 list/More open | 372×249 불변 | 23157 | Opaque panel372×186.75, baseline13516/aux-added55955. Map/camera/renderer 동일, fixed-nav 가림0. |
| Manual717 basic→selected failure | 699×878→896 | 600206→612788 | 정상 경고18px 해소; document1227/1227/top0, resize 미도달. |

Camera의52px 프레임 수리로 outer218×62=13516px² 기본 가림이 이전10239.75보다 커졌다. 정상 camera baseline과 aux 추가 가림은 독립 기록이며 aux 결함으로 합산하지 않는다. Rectangle estimate/9 samples는 픽셀 알파 또는 continuous44의 대체 증거가 아니다.

## 도달 phase / requests
- Case1: `ready` → `native-gestures` → `detail-open` → `detail-end` → `detail-closed` → `complete`.
- Case2: `ready` → `detail-open` → `detail-native-document-wheel` → `detail-end` → `detail-closed` → `complete`.
- Case3: `ready` → `basic-map-before-zoom` → `failure`.
- Case4: `ready` → `basic-map-before-zoom` → `native-touch` → `long-selection-closed` → `long-list-open` → `long-list-end` → `long-list-ending-evidence` → `long-list-closed-focus` → `long-list-reopened` → `long-list-to-more` → `long-more-to-list` → `long-switch-closed-focus` → `complete`.
- Case5: `ready` → `basic-map-before-zoom` → `failure`.

총31 geometry phase 모두 source2290이다. 모든 reached/failure request와 두 original-failure에서 **nonGET0/POST0**. Fake GET-only/admin fixtures이며 real API/equipment command0. Case3 invalid-first-Apply 자체가 미도달이므로 first-invalid guard PASS로 확대하지 않는다. OS software keyboard/HIL/실장비/전체 권한·device/UUID recovery/시계 edge는 미실행.

## PNG 직접 검토 / UX 관측
직접12PNG를 읽었다: 모든5 최종 complete/failure, failure runner2, detail/list/More reader4, initial basic warning1. 이는 모든31 단계의 PNG를 하나씩 읽었다는 뜻은 아니다.

- 320에서 카메라·선택·실행 row가 읽히며 실제0 input/thumb/Apply/More 상태를 확인했다. Individual target hit identity 한계는 위와 같다.
- 717은 raw31와 정상 선택1/적용 가능 상태가 보인다; resize는 실행하지 않았다.
- 390 long list는57–60 마지막 항목/고정 header/닫기를 읽었으며 map 상단 노출과 하단 중요 문구가 유지된다.
- 목록 끝→More에서 shared body가top278/max278로 clamp돼 history 하단 위치로 열리는 관측이 있다. 빠른 밝기/모드의 최초 진입 위치를 검사한 PASS는 아니다. 초기 위치 정책은 후속UX 검토 대상이지 이번 승인 범위의 제품 수정이 아니다.
- Mobile monitoring은 마지막 미배치/조치 불필요를 nav 위에서 읽었다. 닫은 뒤 scroll83 유지로 toolbar가 sticky header 아래에 가려진 관측이 남는다. 상단 복귀 flow는 미검증이다.

- Case1 complete: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-five-hit-2290a877-20261012/results/page-session-ux-aux-01-PC--54626-tion-half-overlay-and-focus-chromium-ux-approved-aux-six-cases/attachments/complete-ef7de66e52c24d872e9a1587f460285a10d604af.png)
- Case2 complete: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-five-hit-2290a877-20261012/results/page-session-ux-aux-02-sho-2cc09-bar-HH-mm-and-detail-scroll-chromium-ux-approved-aux-six-cases/attachments/complete-0be474d7a8625816f12ee79ca6dd61ff991aecc3.png)
- Case3 failure: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-five-hit-2290a877-20261012/results/page-session-ux-aux-03-nar-3a191-y-and-exclusive-auxiliaries-chromium-ux-approved-aux-six-cases/attachments/failure-cb6986831969a0dc1c839ecd7702036b4ef04ffe.png)
- Case4 complete: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-five-hit-2290a877-20261012/results/page-session-ux-aux-04-nat-d94e2-ending-and-list-More-switch-chromium-ux-approved-aux-six-cases/attachments/complete-29112a82a4ba0303d832cea68e3a5b163242c128.png)
- Case5 failure: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-five-hit-2290a877-20261012/results/page-session-ux-aux-05-res-3f607-clusive-aux-focus-and-raw31-chromium-ux-approved-aux-six-cases/attachments/failure-6def241d4d52513132d1916945430efdfa708b33.png)
- Case1 detail-end: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-five-hit-2290a877-20261012/results/page-session-ux-aux-01-PC--54626-tion-half-overlay-and-focus-chromium-ux-approved-aux-six-cases/attachments/detail-end-82d9aaee0756527232945db0405214aa2d91dce2.png)
- Case2 detail-end: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-five-hit-2290a877-20261012/results/page-session-ux-aux-02-sho-2cc09-bar-HH-mm-and-detail-scroll-chromium-ux-approved-aux-six-cases/attachments/detail-end-ac0589c2181042df8ab01c16c5a2962299ee541f.png)
- Case4 long-list-ending-evidence: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-five-hit-2290a877-20261012/results/page-session-ux-aux-04-nat-d94e2-ending-and-list-More-switch-chromium-ux-approved-aux-six-cases/attachments/long-list-ending-evidence-d918953af53b84a60e9e9353e6c1c30a4611d0bd.png)
- Case4 long-list-to-more: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-five-hit-2290a877-20261012/results/page-session-ux-aux-04-nat-d94e2-ending-and-list-More-switch-chromium-ux-approved-aux-six-cases/attachments/long-list-to-more-9859b702733259f0c43706a48632029519f45222.png)
- Case3 screenshot: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-five-hit-2290a877-20261012/results/page-session-ux-aux-03-nar-3a191-y-and-exclusive-auxiliaries-chromium-ux-approved-aux-six-cases/test-failed-1.png)
- Case5 screenshot: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-five-hit-2290a877-20261012/results/page-session-ux-aux-05-res-3f607-clusive-aux-focus-and-raw31-chromium-ux-approved-aux-six-cases/test-failed-1.png)
- Case3 basic-map-before-zoom: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-five-hit-2290a877-20261012/results/page-session-ux-aux-03-nar-3a191-y-and-exclusive-auxiliaries-chromium-ux-approved-aux-six-cases/attachments/basic-map-before-zoom-2ffe1da24c39af9a086f0d6426d444587ad22d74.png)

## 실행 hash / frozen harness 보존
- Raw log SHA256 `89c6edca98e3b6ce84144c8c1f21a6de6ad8310b9813c9548c563d7eecfcade3`
- Results JSON `296e8c6bdb9be1cc4876bd439edd97195997a4c32e0b6fbd7c43d3388f930815`
- Executed spec `c765331b7556ed182ae016d40e2c2fa6b8f7faf35cc681de6a973398f56af861`
- Executed support `83ab0d32e18d099788dd5ed232c32c824d4d877dd7102d78a101415533e584f5`
- Executed config `fa4963f453a269baa78c7e57dc950008d02d43a74d9c51a80525a1c037cbef08`
- Executed binding `5f8e39456d312723f98781d33a6aab1060dc1295512777694469d348ed78d30d`

후속 prep 수정 전에 실행 당시4 files를 ignored `page-session-ux-source-2290a877/*.source.txt`에 exact-copy하고 모든 hash 일치를 확인했다.4093 preliteral4 archives와 과거run/log/JSON/PNG도 불변이다. NO_COLOR/FORCE_COLOR/pnpm.overrides warnings는raw에 남기고 의존/config 수정0.

## 승인된 후속 prep / 다음 실행과 분리
Root 승인 범위에서만 이후 하네스 prep을 수정했다.Always verify critical live owner count1/aria-live polite/aria-atomic true/no hidden·inert ancestor. Nonempty text에는 기존 visible/actualCenter 검사를 그대로 유지하고 empty는 phase에 기록한다. Basic state의 독립 `제어 대상을 하나 이상 선택해 주세요.` 기대를 추가해 blanket empty bypass를 금지했다. Continuous44 helper는 target tag/aria/name/raw bounds **metadata만** 추가했으며44/clipping/grid/point/algorithm은 그대로다. Metadata를 제외한 TypeScript AST canonical hash는전/후 동일 `c0509d25446484a6a68147da7f9e4300e7ca9622f1ad961c9ea917e89afd2bc2`이다(runtime PASS 증거 아님).

또한 root의 추가 조건부 승인에 따라 정상 경고 해소의18px flow 차이를 source/원geometry로 입증하고, Case3 selected-raw31/Case5 resize-selected-raw31 **두 최초 정상선택 baseline만** before=basic 인수를 제거했다. Basic/selected 각각 map≥240/finite/exposure와 renderer identity, 이후 모든 aux baseline 대비 rect/camera/anchors/exposure 계약은 유지했다. Overlay 계약을 선택 전 경고 해소까지 확장한 가정만 정정했다. 제품/원 tests/tracked docs/root metadata 수정0. 새 prep은 아직 재실행하지 않았으며 기존3PASS2FAIL을 GREEN으로 변경하지 않는다.

Root의f28 source/once3·5 재실행 승인은 **다음 별도 cohort**다. 이번2290 실행을 덮거나 자동 재실행하지 않는다. Case1/2/4는2290 PASS, Case6은4093 PC false-path carry의 기존 한계(PC-hidden close 클래스 차이 포함)와 분리한다. **이번 실행 결과 보고 완료; Ready/merge 승인은 root 최종 검토 사항.**

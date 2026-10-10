# Task 11 controlled browser 증거 — scoped 재확인 종료

## Source / 경계

- 최초 product+spec HEAD `5f3e3c20be92a4cddfcd3a920dfc0627d87d273b`; 준비 spec commits `2a42c3eb`, `f3fb9bba`가 이미 통합됐다.
- 최소 spec 수리 commit `b3492ad2e8131420cc9ae85dee83fe74d547f00e`: `apps/web/e2e/atlas-ui-fidelity.spec.ts`만31+/7-. Product/API/공통/메뉴 수정0, checkout clean.
- Node22.20/pnpm9.15 준비 runtime, `E2E_WEB_PORT=15185`, 각 실행직전 `lsof -nP -iTCP:15185 -sTCP:LISTEN` empty. Playwright task-owned server만 사용하고 종료후 listener없음. 5173/4000/63200·사용자 browser tab·real Lab/DB/장비 사용0. 기존 fail-close API boundary 유지.

## 실행별 결과 (중복 합산 금지)

| Run | Command suffix / source | exit / 결과 | 로그 |
| --- | --- | --- | --- |
| 최초12 | `playwright test e2e/atlas-ui-fidelity.spec.ts --project=chromium --workers=1`; HEAD5f3e3c20 | 1; 8PASS/4FAIL/0SKIP,2.0m | `/tmp/task-11-browser-first.log` |
| 대표증거+원실패5 | 같은명령+`--grep 'PC four roots\|responsive 562\|dark four roots\|short manual recovery\|both monitoring finder' --output=/tmp/task-11-browser-focused-results`; HEAD5f3e3c20+현재spec수리(AfterScrolling전) | 1;4PASS/1FAIL/0SKIP,19.0s | `/tmp/task-11-browser-focused.log` |
| manual원실패1 | 같은명령+`--grep 'short manual recovery' --output=/tmp/task-11-browser-manual-results`; HEAD5f3e3c20+최종b3492ad2spec | 0;1PASS/0FAIL/0SKIP,10.6s | `/tmp/task-11-browser-manual.log` |

모든 명령앞은 `E2E_WEB_PORT=15185 PATH=/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH pnpm --filter @led-control/web exec`. 최초실행 진행중, 이미 끝난 실패 조사후 spec-only 수리를 시작해 worker재시작후 source표시line이변경됐다. 첫로그 galleryline277은 출력source와 mismatch이며 최초원spec의 `node.isConnected` 즉시false단언이실제실패다. 원runtime수치를최종spec 통과로바꿔쓰지않는다.

## 실패 / 최소 수리

1. manual 최초30s timeout: nativecheckbox `.check()`가실제React Aria label/indicator에pointer interception. 기존 atlas acceptance의 associatedlabel.click+동일input checked단언으로수리. 다음실측은 statusregion중`상세 보기`가29px만보이는부분clip을전체버튼일괄44로측정해실패했다. 기존 AfterScrolling helper로 **모든action각각노출후연속44** 검사해원case1PASS. mapviewport≥240,outerdocument600/scrollY0,CTAreachable,draft30,canvasidentity/zoom,추가write0 그대로.
2. finder 최초30s timeout: modalPopover 열린원탭headerthemebutton은body가pointer차단. 기존controlled별도customer탭의실제themebutton→브라우저native storage event를재사용했다. force/synthetic theme/htmlattribute변경0. 검색/list query/filter와각openerfocus 그대로검사해대표run1PASS.
3. settingsDialog 최초30s timeout: 공통settings-api에운영metadata`GET /sites/:id/settings`가없어404Feedback,수정button없음. 기존settings-operations와실제SiteSettingsResponse의완전한readDTO를spec에만추가했다. PATCH/credentialAPI추가0. 원case runtime재확인은rootsettingssource보완통합뒤대기.
4. gallery 최초`isConnected true` 실패: navigationclick직후routecommit전에즉시단언했다. URLsettle후기존canvasnode disconnect를poll단언하도록spec수리했다. 실제roleimg/floorlabel176px/inert/최대2owner/readsnapshot추가0/editorwrite0/historyquery계약유지. 원case runtime재확인은rootsource보완통합뒤대기.
5. 증거harness: 최초evidence가body첨부만사용해passedPNG/JSON이worker임시수명으로종료시삭제됐다. `outputPath`에실제screenshot/json을저장하고path첨부로최소수리. 원artifact실패로root승인대표PC4/light-dark2case+562mobile만재확인했으며통과12전체재실행없음.

## 실제 파일 증거

원실패4개의 `error-context.md`, `test-failed-1.png`는 정확원폴더를 `/tmp/task-11-browser-first-artifacts`로기계복사해보존. 원본`apps/web/test-results`도그대로있다. 원PNG임시passed첨부는이미삭제돼복원하지않았다.

영구 대표PNG·동명`-metrics.json`:

- PC4 light: `/tmp/task-11-browser-focused-results/atlas-ui-fidelity-PC-four--6bdec-ics-subnav-retain-URL-scope-chromium/pc-monitoring.png`, `pc-control.png`, `pc-statistics.png`, `pc-settings.png`.
- Dark4+portals: `/tmp/task-11-browser-focused-results/atlas-ui-fidelity-dark-fou-eb9b3-nherit-the-customer-palette-chromium/dark-monitoring.png`, `dark-control.png`, `dark-statistics.png`, `dark-settings.png`, `dark-site-portal.png`, `dark-alarm-portal.png`.
- Mobile562: `/tmp/task-11-browser-focused-results/atlas-ui-fidelity-responsi-dd44e-itoring-refresh-precede-map-chromium/responsive-562-monitoring.png`, `responsive-562-options.png`.
- Finder: `/tmp/task-11-browser-focused-results/atlas-ui-fidelity-both-mon-1d1d4-d-restore-the-actual-opener-chromium/finder-shared-state.png`.
- Manual: `/tmp/task-11-browser-manual-results/atlas-ui-fidelity-short-ma-dc02c-ols-theme-resize-write-free-chromium/short-manual-recovery.png`와`short-manual-recovery-metrics.json`(explicitcontrolledwrite1포함).
- 중간manual원실측: `/tmp/task-11-browser-focused-results/atlas-ui-fidelity-short-ma-dc02c-ols-theme-resize-write-free-chromium/error-context.md`, `test-failed-1.png`.

## 한계 / 후속

- gallery/dialog최종runtime/screenshot은아직대기. 현재전체12PASS라고표현하지않는다. 최초320/390/759/760/statisticszero-gap은PASS지만영구PNG가없다;대표562증거와분리한다.
- test screenshot은fixture실측자료이며목업대조/UIUXreview·전상태시각검토완료는총괄별도역할이다. contrast전수/firstpaint/HIL/GPUrelease/offscreen3+cards는미검증. readonlygallery층1개조건은ownerunit cleanup/fanout증거와구분한다.
- Type/UI/build는다른담당에게배정되어실행0. timeout30s/assertion44/viewport240를늘리거나skip하지않았다. 로그의NO_COLOR/FORCE_COLOR환경warning은보존하며제품warning으로단정하지않는다.

## 최종 통합 source 재확인 (위 대기 / 초기 이미지 상태를 대체)

- Product통합 HEAD `0bba6fe16c89b5681c4d96050513ba7145bddcdd`에는 settings정적수리`da9edfee`와 commonFooter타입수리`1c4943a6`가포함된다. `36cb3d005f549044916e067a31cfa4e8a55788e3`는 spec ready-helper/fixture수리로별도통합됐다.
- 최종 spec commit `eef83fa3a8172efe2130df25661c163edbce7b02`: spec단일파일6+/4-. git diff --check0, commit후checkoutclean. source수리/ready값기준완화0. 모든추가실행직전15185lsofempty, 종료후lsofempty.

| 추가 Run | grep / output | source / exit / 결과 | 로그 |
| --- | --- | --- | --- |
| 통합4 | `PC four roots\|dark four roots\|settings edit/password\|gallery draws`; `/tmp/task-11-browser-final-results` | HEAD0bba6fe1,exit1;2PASS(dialog/gallery)/2FAIL(PC/dark)/0SKIP,30.6s | `/tmp/task-11-browser-final.log` |
| PC/dark원2 | `PC four roots\|dark four roots`; `/tmp/task-11-browser-ready-results` | HEAD0bba6fe1+energyrouteorder수리,exit1;0PASS/2FAIL/0SKIP | `/tmp/task-11-browser-ready.log` |
| 원2+열린Dialog증거1 | `PC four roots\|dark four roots\|settings edit/password`; `/tmp/task-11-browser-ready-final-results` | HEAD0bba6fe1+최종eef83fa3동일spec,exit0;3PASS/0FAIL/0SKIP,16.8s | `/tmp/task-11-browser-ready-final.log` |

명령prefix/기본args는위와동일하다. 총 browser실행은 **최초12 + 대표5 + manual원1 + 통합4 + PC/dark원2 + 원2/Dialog증거1의3**,6회이며한번의전체12재실행은없다. 서로중복case를더해전체PASS수로표현하지않는다. 최초미수리8PASS중모바일320/390/759/760/statisticszero-gap은기존source증거,manual/finder는b3492ad2대응원case통과,최종PC/dark/Dialog는eef83fa3대응통과,gallery는통합4run통과로각각추적한다.

### readiness / 증거 harness 실패 원인

- 총괄이대표5run의pc-control실제이미지를열어floorplaceholder/summary—/등록empty를발견했다. 제목h1은loading에서도뜨므로그이미지는 **최종승인자료에서제외**한다. 단순미settled뿐아니라statisticshelper가floorlessdashboard를덮는fixture등록순서도원인이었다.
- `rootReady`는실제16대현장summary,monitor/controlcanvas+B2선택층,statistics4.25summary+실제SVG+SRseriesrow,settings5actualcard+users0완료를기다린다. sleep/가짜HTML/가짜state없음.
- 최초ready수리는statisticshelper를settingsgeneralAPIroute보다먼저설치해energyGET을general404에가로채게했다. 통합4runPC/dark2FAIL은실제summaryerrorstate로확인했다. **settingsgeneral→statsspecific→authoritativecustomerdashboard** 등록순서를고정했다. 이것은제품결함이아닌fixture설계문제다.
- 다음PC/dark원2run은4.25/SVGready통과후SRseries날짜의ISOliteral오류로실패했다. error-context의실제formatter표현`2026년 8월 25일: 4.1 kWh, 656원`과`StatisticsOverviewPage.tsx`의seriesSR소비를대조해literal을`2026년 8월 25일: 4.1 kWh`로교정했다. 최종원2PASS. 더큰helper/새판정/format계산/timeout완화없음.
- 열린Dialogpixel누락도harness문제로구분했다. 기존끝capture는닫은Dialog뒤MFAowner만이었다. 총괄승인으로동일case의siteedit/passwordDialog가열린각위치에기존evidence2개만추가해1case재확인했다. 실제passwordsubmit/credential변경은하지않았으며passwordpending/late-response는ownerunit증거영역이다.

### 최종 승인용 실제 PNG / JSON 경로

**아래 PC/dark이미지가위대표5run의초기placeholder이미지를대체한다.** 모두실제ready조건뒤촬영했고동일폴더의동명`-metrics.json`에URL/viewport를저장했다.

| 대상 | 정확폴더 | PNG 파일 |
| --- | --- | --- |
| PC4 light | `/tmp/task-11-browser-ready-final-results/atlas-ui-fidelity-PC-four--6bdec-ics-subnav-retain-URL-scope-chromium` | `pc-monitoring.png`, `pc-control.png`, `pc-statistics.png`, `pc-settings.png` |
| Dark4+portal | `/tmp/task-11-browser-ready-final-results/atlas-ui-fidelity-dark-fou-eb9b3-nherit-the-customer-palette-chromium` | `dark-monitoring.png`, `dark-control.png`, `dark-statistics.png`, `dark-settings.png`, `dark-site-portal.png`, `dark-alarm-portal.png` |
| 실제열린Dialog / MFA | `/tmp/task-11-browser-ready-final-results/atlas-ui-fidelity-settings-2d599-nt-MFA-draft-survives-theme-chromium` | `settings-site-edit-open.png`, `settings-password-dialog-open.png`, `settings-dialog-and-MFA-owner.png`(닫은뒤owner) |
| Gallery실제readonlysnapshot | `/tmp/task-11-browser-final-results/atlas-ui-fidelity-gallery--2bc21-ation-without-editor-writes-chromium` | `gallery-real-snapshot.png` |

Mobile562/finder/manual위기존유효증거는그대로유지하고재실행하지않았다. 위대표5의PC/dark는실행PASS였어도ready증거로인정하지않는다. 추가실행의실패error-context/PNG도각output폴더에보존했고삭제/덮어쓰기없음.

최종scope에서열린브라우저실패는남지않지만이는source별focused12case증거를취합한결과이며 **최종HEAD전체12일괄PASS,모든상태runtimePASS,전체대비/모바일PNGmatrix/HIL** 주장은아니다. root가실제PNG를UIUXreview에서확인하고정적관문/ownerunit결과와따로취합해야한다. 추가browser/type/UI/build실행은하지않고멈춘다.

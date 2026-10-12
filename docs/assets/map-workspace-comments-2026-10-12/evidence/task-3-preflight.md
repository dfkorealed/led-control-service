# Task 3 QA 사전 점검 — 실행 전 제안

## 경계

- 새 worktree `/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012`, branch `codex/map-workspace-comments-20261012`, baseline `f31e56fa`, 읽은 HEAD `9d59c7e6`(준비 문서 commit). Task1 writer 진행 중이므로 현재 source는 최종 계약/완료 증거가 아니다.
- applicable root/apps-web/docs AGENTS, agent-operations, 현재 상태판과 이번 계획의 C1–8/Task3를 확인했다. 이번 보고서만 작성: 제품·test·plan/status·index·commit·browser·server 변경0, child delegation0, 과거 raw/전체 suite 읽기·실행0.
- 신규 spec 제안: `apps/web/e2e/map-workspace-comments.spec.ts`, 최대6 고유 case. 기존 spec를 import하거나 이전6/12/149 matrix를 재등록/실행하지 않는다.
- 신규 owned port15188: `lsof -nP -iTCP:15188 -sTCP:LISTEN` 현재 출력0/exit1. 실행 승인 시 다시 확인하고 Playwright reuseExistingServer=false로만 사용한다. 사용자5173/4000/63200 untouched.

## 재사용 가능한 실제 코드

- `e2e/support/mock-api-boundary.ts`: context same-origin 경계와 미설정API404 재사용. boundary→settings general→이번 specific GET routes 순서. 외부 transport 차단.
- `e2e/support/settings-api.ts`: `installSettingsApiRoutes`, SettingsFixture, readyMapDocument/mapDimensions/lightSlots/snapshotGeneratedAt/gatewayHeartbeatAt, failNextMapSnapshots와 command clock envelope 재사용. 명령 state setter가 있어도 순수 UI case에서 command 생성POST는 하지 않는다.
- `e2e/support/layout-assertions.ts`: horizontal overflow/continuous44 hit 검사 재사용. 날짜/통계는 범위 밖, 공간 marker와 실제 일반 button을 분리해 측정한다.
- 기존 `atlas-interactions-comments.spec.ts`의 native CDP touch, `blank` 실제 elementFromPoint, phase별 map/topbar/nav/marker/camera JSON, testInfo.outputPath/path attachment 패턴만 좁게 재사용한다. `*.spec.ts` import 금지. 필요한 작은 generic 측정/gesture helper를 support 파일로 분리하거나 새 spec의 짧은 local helper로 유지한다.
- 기존 harness의 고정15187/3fixture/437source/본문 scroll 복귀 가정은 새 요구와 맞지 않는다. source는 최종 env SHA, 새port15188, actual manual finite workspace docscroll0을 명시한다. 예전 body-wheel(-1200) setup을 이번 manual layout에 복사하지 않는다.
- mockDashboard는 UI seed라 capabilities가 빠져 있다. 새 authoritative dashboard에는 settings helper의 read/control/manage/commission 계약, floor mapConfigured/revision·fixture count·실제 snapshot placement/heartbeat를 일치시킨다. statistics helper/거대한 old DTO를 복사하지 않는다.
- `operational-map-fixture.ts` dense5는 과거Task9 fault/dense 중심·옛 timestamp로 이번 목적에 부적합하다. typed SettingsFixture 한 seed에서 UUID/이름/좌표를 생성하는 작은 spread factory가 더 적합하다. pointer용3개는 겹치지 않게, longlist용40~60개는 실제 배치·조절가능·상태 metadata를 일치시킨다.

## 최대6 actual browser case 제안

| 고유 case | viewport/theme | 이번 C1–8의 실제 관찰 |
| --- | --- | --- |
| 1 모니터링 PC gesture + 상세 |1194×1227 light| sr-only h1/toolbar floor·finder·time·refresh same row. 실제 middle/Space drag pan와left single fixture/no area, pointer wheel zoom. marker→pin→detail 전후 viewport DOM identity/canvas identity·rect·camera 불변. nonmodal 지도하단overlay 약절반과 header/close고정, 본문wheel 내부scroll·zoom불변, Escape/close returnfocus·같은fixture reopen scroll기억. |
| 2 모니터링 짧은 모바일 + 상태 경계 |390×600 dark| icon button44/name, HH:mm/full timestamp 설명, finder→marker/detail 내부 노출·지도가림영역과mapbox 별도측정. controlled browser clock+fixed server snapshot60,000→60,001ms에서 순수stale는 alarm센터 현재상태만 변화, toast/최근알림/unread 추가0. 이어 specific mock GET 실패/invalid·future metadata는 경고를 유지함을 같은case에서관찰. |
| 3 수동 최단폭 + invalid 안전 |320×600 light| document scrollHeight==clientHeight/scrollY0, finite manual shell과floor/scope/list·brightness/slider/Apply/More44 한행, 실제nav위 전체44 hit. renderer준비후mapbox/exposed area/남은공간실측(240px목표는Task2 최종계약확인). marker선택→raw31→invalid 입력→Enter/blur와첫Apply 차단·별도 적용 안내, POST0. More에서긴preset/history 내부끝 도달·closefocus. |
| 4 수동 touch + 긴 선택 목록 |390×600 dark, hasTouch| real nativeCDP marker-origin swipe≥8→camera변화/selection불변/다음tap정상/noholdarea/pinchcancel. 화면내marker strict hit 선행, JS카메라/scroll값주입0. scope 전체로40~60선택→지도하단count→44전체보기→같은패널 internal longlist 마지막행actual노출, header/닫기고정·내부wheel/touch/문서scroll0·nav44. |
| 5 수동 tall + 한정 resize |717×1227 light→390×844 동일case| map remaining-height dominant/선택collapsed·expanded camera/renderer불변, popup/More가camera를재부모화하지않음. actual input focus + viewport resize로부피변화측정, 닫기/focus/raw31보존·nav전체hit/overflow/documentscroll0. 이것은browser resize이지실제OSkeyboard증거가아님. |
| 6 수동 PC fullrow + recovery 가용성 |1194×1227 dark| PC선택panel empty도전체행높이, 긴목록internalscroll. More/이력 mock GET로기존오류·복구표시가collapsed에도visible/live이고expanded에서세부끝까지접근. read-only/viewer 또는 scoped복구lock을같은case의auth/command fixture단계에서확인, disabledApply/재전송0/POST0. owner의actual복구schema·trigger계약없으면임의storagepayload금지/그부분실행전root에보고. |

이 6개가 신규 고유 case 경계다. width/theme를 별도 test 등록으로 늘리지 않는다. 실패 원 run/PNG/phase metrics를 보존한 뒤 원인 확정·root 승인 실패case만 재실행하며 retry/timeout/skip/수치완화하지 않는다.

## 실행 전 필요한 제품 인계

1. Task1 final source와공통 maps overlay API/label/body-scroll/header/close 계약. 지금 source에는 desktop detailRef+compact DetailSheet 분기가 남아 있어 baseline locator를 최종으로 가정하지 않는다. baseline FloorMap은 viewport기본정책이며 planned manual-cad/pan 소비 완료를 기다린다.
2. Task2 source/finite shell activation predicate/전체보기·More label+data slot/공유overlay소비,240목표·actualremainingheight 기준,scope reset/empty fullrow/복구 상태 GET·storage schema. 새 public props를 QA가 요구하거나 제품을수정하지 않는다.
3. pure snapshot stale의 live/persistent alarm surface 식별자와현재 unread baseline. frozen clock은브라우저시간/모의서버snapshot만조절하고 실제서버·장비시간 주장0. 오류fixture는예상실패phase와fatal load readiness를구분한다.
4. root 최종 제품 ready와soleQA writer/정적한정commands 승인. Task1/2 directunit cohort를취합하며과거fullsuite를되풀이하지않는다.

## 증거/안전 기준

- settled actual data·canvas·marker·snapshot 준비후 PNG. map rect와 overlay 후 exposed rect를 둘다기록하고 약절반은실측ratio로UX에인계한다. 렌더러DOMidentity/zoom/scrollcamera 전후같음도기록한다.
- input전/after/catch에 document·visualViewport·shell/header/nav/map/overlay/body/marker/button rect, scrollTop/scrollHeight/clientHeight, elementFromPoint hitchain, selection, fixture GET·모든nonGET count를저장한다. fixednav 실제selector `[data-shell-navigation="compact"]`, 버튼전체bottom<=nav.top+기존1px(overlay top-layer는overlay실제clip/hit기준). 44 continuoushit·일반간격·수평overflow를별도검사한다.
- 내부목록·More·detail은actual wheel/touch로끝까지이동하고최대scroll/마지막행전체visible를증명한다. document CSS변경/force/fakePointerEvent는금지. gesture시점에overlay밖 actualhotzone를검증한다.
- 모든 순수UI case mutation POST/PUT/PATCH/DELETE0, no real hardware/DB. ExplicitApply 성공은이번0POST경계밖이며owner unit·mock명령근거와분리한다. 복구재실행·status-check POST를클릭해가짜완료로만들지않는다.
- evidence는새 `docs/assets/map-workspace-comments-2026-10-12/`와이번ignoredSDD에저장하며예전작업21exec·통합2case와합산하지않는다. 실제OSkeyboard/nativeWebView/HIL·모든기기/전브라우저검증은주장하지않는다.

현재는 제안만 완료. 신규 spec/helper edit0, test/server/browser 실행0, commit0.

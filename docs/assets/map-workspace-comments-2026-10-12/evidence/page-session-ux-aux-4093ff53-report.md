# UI/UX actual6 — frozen source4093ff53

## 판정
**UI merge 관문 보류. 1 PASS /5 FAIL /0 SKIP /0 FLAKY, exit1, 34.307626s.** 같은6고유 case를 새 source에서 한 번 재검사했다. 기존 cohort와 합산해18고유라고 계산하지 않는다. 실행 직후 교정0; 이후 승인된 prep-only 기대값 한 줄 교정은 아래 별도 기록한다. 자동 재실행/이 세션의 제품 변경0, STOP/WAIT.

- Source: `4093ff536e2ded9edfb1d1f1c3b25f53b54989b3`, branch `codex/map-workspace-comments-20261012`, same worktree.
- Run: `actual-six-aux-4093ff53-20261012`, workers1/retries0/timeout30000. 실제6 loaded/body6, retry 전부0, runner errors[].
- Raw [log](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux-aux-4093ff53.log), [results JSON](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-six-aux-4093ff53-20261012/results.json). 모든5실패 original-failure JSON/failure geometry/failure PNG/runner screenshot 보존; 이번 run failure capture 누락0.
- Root 전달 owner118PASS/type·UI0, 최종policy79PASS/build0는 별도 owner/static 결과이며 browser1PASS에 합산하지 않는다.
- 전/후 fullHEAD 일치·git clean·제품 diff0 확인. 실행 종료 후15188 lsof exit1/output0; 다른 서비스/포트/장비/remote 변경0.

## Case별 실제 도달 / 분류
| Case | 결과 | 실제 원인 / 미도달 |
| --- | --- | --- |
| 1 PC monitoring1194 light | FAIL, 8.354s | CAD middle/Space/wheel camera 변화·single·unchanged rect/camera/canvas·half detail·내부 끝까지 도달. **이 세션 새 하네스의 불필요한 마지막 값 `배치됨` literal 기대**가 실제 `미배치`와 달라 실패. 제품 재열기 결함으로 분류하지 않는다. 마지막 항목 full-hit assertion과 close/focus/native pin re-click/reopen/restore는 이후라 미도달. |
| 2 monitoring390×600 dark | FAIL, 6.612s | toolbar/nav44·HH:mm/fullaria/dateTime·single/half/identity, native document wheel0→83, detail above nav, actual body wheel239/(342−103) 끝 도달. Case1과 동일 literal 하네스 실패. 마지막 정보의 자동 full-hit/close/reopen은 미도달. **이전 covered-center만으로 끝 도달불가라던 결론은 지지되지 않는다.** |
| 3 manual320×600 light | FAIL, 1.788s | ready에서 count→바로 아래 fullview44/same-panel aria-controls를 확인한 뒤 **actual camera controls continuous44 실패**. 기본 지도251px이나 map240/dominance의 명시 assertion은 이 검사 뒤라 실행 전 실패. 첫 pin/슬라이더0·100/numeric·Apply·More44/raw101 첫Apply0POST/패널 전환 모두 미도달. |
| 4 manual390×600 dark hasTouch | FAIL, 1.999s | ready에서 동일 **camera continuous44 실패**. 지도249px 관측. zoom/native swipe0→nexttap1/floor60/목록 내부 끝/header/닫기·focus/More 전환은 전부 미도달. 이전 source의 touch 통과를 이번 source PASS로 사용하지 않는다. |
| 5 manual717×1227→390×844 light | FAIL, 1.880s | initial717 ready **camera continuous44 실패**. 기본699×878 관측. 선택/raw31/각 aux 전환/resize/focus는 전부 미도달; 이전 resize PASS는 다른 source 결과. |
| 6 PC manual1194 dark | PASS, 1.987s | 새 default-inline portal 경로에서 empty/populated map/selection panel922px 동일. 실제60행 native internal ending1108/(1968−860), header 고정/canvas identity/camera/no-x-overflow 유지. 실제 UI recovery/전체 pin44 검증은 아님. |

### 하네스 vs 제품 경계
Case1/2 `배치됨` 기대는 읽기 끝 도달이라는 승인 목적에 불필요하게 추가한 내 하네스 가정이다. 실행 source4093ff53를 `git show`로 직접 대조했다. `prepareCustomer`는 `readyMapDocument:true`와 조명이 연결된 lightSlots를 제공한다. `settings-api.ts:385` ready 분기의 `mapSnapshot(..., [])`에서 세 번째 인자는 **objects**이며, builder(`:673–689`) 자체에 legacy `fixtures` 필드가 없다. 따라서 snapshot에 saved fixture pin이 없다. `MonitoringView`의 selectedPin은 없고 `resolveFixtureMapPosition`으로 넘어가며, 이 함수는 saved pin 없는 mapDocument에서 `unplaced`를 반환한다. `FixtureDetailPanel`은 마지막 `지도 배치` dd에 `미배치`를 표시한다. 실제 두 실패의 Received 값/PNG와 이 source 경로가 일치한다. API fixture나 제품 수리 없이, 별도 승인에 따라 기대값만 정확한 `미배치`로 바꿨다. 기존 결과는 **1PASS5FAIL 그대로이며 교정본 재실행0**이다.

Case3/4/5 camera는 source의 compact `size-11/min-h-11` 및 shared `rounded-control` 프레임이다. 기존 shared continuous44 helper가 실 브라우저 elementFromPoint로 모두 실패했다: 축소44×44/도달폭43, 배율47.625×44/도달폭47, 확대44×44/도달폭43, 화면맞춤44×44/최대폭44이나 연속44사각형 없음. 네 버튼 모두 `hasMinimumArea=false`. **44×44 bbox를 실제 연속44 hit PASS로 대체하지 않는다.** 현재 product camera hit 계약 blocker이며, 카메라 크기·모서리 등 제품 수리 판단은 원 writer/root 소유다. 이번 session 제품 변경0.

## 실제 geometry (관측과 통과 assertion을 구분)
| 화면/phase | map box | actual exposed px² | 핵심 값 |
| --- | --- | --- | --- |
| PC monitoring detail | 916×852 | 419986 | detail458.5/parent917 half. body374/374·top0; camera0,0/zoom1. |
| mobile monitoring open→native page move | 360×240 동일, y254→171 | 64620 동일 | document0→83, y+scrollY=254 불변. aside bottom613→530, nav starts532. body endtop239. |
| manual320 ready/failure | 302×251 | 65562.25 | usable=raw, canvas252×167, camera opaque rectangular baseline10239.75. map bottom387<nav532. document600/600/top0. |
| manual390 ready/failure | 372×249 | 82388.25 | usable=raw, canvas300×199, camera baseline10239.75. map bottom387<nav532. document600/600/top0. |
| manual717 initial | 699×878 | 603482.25 | usable=raw, canvas649×432, camera baseline10239.75. document1227/1227/top0. resize 미도달. |
| PC manual complete | 282×752 | 212064 | actual scene232×154, cameras in footer outside map so map occlusion0. selection/map panels922, actual list860client/end1108. |

기본지도는 이전 source69b1의320 height62→251(+189),390 height70→249(+179)로 개선된 **관측**이다. mobile 비지도 합계는320349px/390351px; 지도 전136/138·후213이며 count panel66, execution44, important18, nav68이 유지된다. all mobile/717 ready에 aux는 닫혀 있으므로 aux 추가 가림0이고 차감10239.75는 카메라 기본 가림이다. aux open/switch/close에 따른 별도 camera/aux 필드 생성 단계는 camera44 실패로 미도달: `baselineCameraOcclusionArea/additionalAuxiliaryOcclusionArea`의 실제 open-state 결과가 있다고 주장하지 않는다. Rectangle estimate/9sample hit는 연속44 또는 정확 픽셀 알파 가림의 대체 증거가 아니다.

## 직접 PNG 확인 / UI·UX 및 권한 한계
직접7PNG를 열어 읽었다(실패5+완료1, 그리고 mobile native-document-wheel1); 모든6 화면을 포함한다.
- 320: 지도는 더 이상62px 띠가 아니며3핀 분리가 보인다. count/44전체보기/밝기행/중요 요약/nav 간격이 읽힌다. camera44 blocker와 아직 미도달인 편집/보조패널을 완료로 표시하지 않는다.
- 390 dark60: 지도249px에서60 fixture가 보이지만 하단 우측 일부 핀을 정상 카메라 overlay가 가린다. 실제 zoom/touch/선택은 미검증이다.
- 717: 지도/조명3/하단 count·밝기·nav가 보이지만 resize는 실행되지 않았다.
- PC manual:60 마지막 행, readable history 오류 문장과 `Gateway0/1 준비·Mesh설정중/제어불가` 표시 확인. Fit scene의60핀 밀집/겹침은 남는 관측이며 이 PASS가 전체60개의 개별 map-hit44 PASS는 아니다.
- Monitoring PC: half 상세 마지막 `지도배치/미배치`를 육안으로 읽었다. Mobile: native page 이동 뒤 상세가 nav 위로 올라가고 body native ending에서 마지막 안내/값이 읽힌다. Header/닫기는 보이며 상단 도구행은 페이지 이동 뒤 sticky shell 아래에 가려지는 관측이 있다; 위로 되돌리는 흐름은 추가 실행하지 않았다.
- API fixtures는 admin 권한의 fake GET-only다. real operator/viewer 전체 권한·장비 연동을 검증한 것이 아니다. 이번 모든 reached phase/original failure request 기록 nonGET0/POST0; first-invalid-Apply phase 자체가 미도달이므로 해당 guard PASS로 확대하지 않는다. OS software keyboard/HIL/real equipment/전체device/복잡UUID recovery/시계 edge 검증 미실행.

- Case1 failure: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-six-aux-4093ff53-20261012/results/page-session-ux-aux-01-PC--54626-tion-half-overlay-and-focus-chromium-ux-approved-aux-six-cases/attachments/failure-39ff1e119b2f24e0c12cdbcb477cf1ced242a12a.png)
- Case2 failure: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-six-aux-4093ff53-20261012/results/page-session-ux-aux-02-sho-2cc09-bar-HH-mm-and-detail-scroll-chromium-ux-approved-aux-six-cases/attachments/failure-d568d29118d53fc1e4157cf39314f601fe3bac70.png)
- Case3 failure: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-six-aux-4093ff53-20261012/results/page-session-ux-aux-03-nar-3a191-y-and-exclusive-auxiliaries-chromium-ux-approved-aux-six-cases/attachments/failure-ccabeada3fcc6a716e2b1e04d73338a82fc8bb02.png)
- Case4 failure: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-six-aux-4093ff53-20261012/results/page-session-ux-aux-04-nat-d94e2-ending-and-list-More-switch-chromium-ux-approved-aux-six-cases/attachments/failure-dedfbb411ea9b1e86f9ffdd5261dee10a4b8cb8f.png)
- Case5 failure: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-six-aux-4093ff53-20261012/results/page-session-ux-aux-05-res-3f607-clusive-aux-focus-and-raw31-chromium-ux-approved-aux-six-cases/attachments/failure-92436e6194c8cf47f5f7bf79f1f0d4398b7186cb.png)
- Case6 complete: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-six-aux-4093ff53-20261012/results/page-session-ux-aux-06-PC--1c686--and-60-row-internal-scroll-chromium-ux-approved-aux-six-cases/attachments/complete-69a7c542e9d1f94dd063cace72979b764f1ac2ee.png)
- Case2 native page move: [PNG](/Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012/.superpowers/sdd/2026-10-12-map-workspace-comments/runs/actual-six-aux-4093ff53-20261012/results/page-session-ux-aux-02-sho-2cc09-bar-HH-mm-and-detail-scroll-chromium-ux-approved-aux-six-cases/attachments/detail-native-document-wheel-eab17446a2568d6354549cac590a337605cc6c62.png)

## Hash / 원본 보존
- 현재 raw log SHA256 `d751f9209fc1ea2df74d199e0c3c484219fbf09b1e5790e2fd7984e981999e12`
- 현재 results JSON `769f366afcf43fe002fc5dab28d7dbdd3bc91c575ae382c00fddded62b47a493`
- aux spec `be1cbcef37f95f68e2ec3f211bf63559ce899e0342679892a2194befea8e71b9`
- aux support `83ab0d32e18d099788dd5ed232c32c824d4d877dd7102d78a101415533e584f5`
- aux config `fa4963f453a269baa78c7e57dc950008d02d43a74d9c51a80525a1c037cbef08`
- aux binding `d3c89a971a5cdc5acab012490c17c323ba0076b0e4e0bc6af8e1eb5e88e17b7b`

原 spec/support/config hashes d4d914e3/1c282988/71f91edf, config-failure/firstUI raw logs+JSON, repair69b1 raw logs+JSON match prior recorded full hashes. All old PNG/run directories remain untouched. Preparation's initial type setup93/then shadow2 diagnostics remain documented; no old failure suppressed. Current NO_COLOR/FORCE_COLOR and pnpm.overrides warning logged, no dependency/config remediation attempted.

## 승인된 prep-only 후속 / 기존 실행 동결

Root의 source-proof 조건부 승인 범위에서 aux spec233의 `배치됨`→`미배치` **한 줄만** 교정했다. `diff -u`로 단일 literal delta를 확인했다. internalEnd/full viewport/actualCenter/카메라/header/close/reopen/focus 및 shared continuous44 기준·collector는 전부 유지한다. 바뀐 aux spec SHA256은 `c765331b7556ed182ae016d40e2c2fa6b8f7faf35cc681de6a973398f56af861`; support/config/binding은 위 실행 당시 hash와 같다. 기존 raw log/results JSON hashes도 다시 일치 확인했다.

교정 전에 실행 당시 네 TS 파일을 ignored `page-session-ux-source-4093ff53/*.source.txt`에 exact-copy로 보존하고 네 hash 일치를 확인했다. `.txt` 확장자로 runner case를 추가하지 않으며 기존 frozen run 디렉터리 자체는 수정하지 않았다. 새 prep strict/noEmit TypeScript는 exit0/diagnostics0, AST test declarations6; **runtime GREEN/전체 suite PASS가 아니다**. 15188 lsof exit1/output0. 이번 후속 browser/server/case 실행0, 제품/기존 테스트/root metadata/remote/장비 변경0. 원 control writer의 tracked 변경이 진행 중이므로 현재 checkout clean 또는 새 final source를 주장하지 않는다.

**STOP/WAIT:** Camera continuous44 제품 실패3은 원 control owner의 compact-only 수리 범위다. 다음 실제 실행에는 새 owner final full SHA, root 관문, 별도 실행 승인이 필요하다. 현재 binding은 실행 당시4093ff53이며 신규 source로 재사용 승인되지 않았다. 자동 재실행/추가 제품·하네스 수정 없음. Completion/merge approval is not claimed.


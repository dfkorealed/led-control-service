# 실제 UI/UX QA — 첫 실측 / 모바일 지도0 확정 / 수정·국소 재검사 승인 대기

2026-10-12. Frozen source `bea0dacb07d3d5c8e0b14e4659874da12ed6b2d4`. 제품 소스 수정 0 / ignored SDD만 작성. 현장 운영·시설 관리 담당자를 사용성 기준으로 유지.

## Source cohort

- Monitoring 제품 `ac323a3dcd128a32ffa73d460e4cfa07d99f0c10`: owner 직접 2suite/127PASS/0FAIL/0SKIP. 인수 문서 `87f658ef`. 이 QA에서 재실행하지 않았다.
- Control 제품 `9f3e25d7460e215c242d775b83c6c32e3f32546f`: owner final41PASS. identity2는 그중 2개의 보강 재검사이므로 43unique로 합산하지 않는다. 중간85/68은 최종 전체 cohort가 아니다.
- 총괄 정적 gate 전달: frozen HEAD policy79PASS/0FAIL, tsc포함web build exit0. 기존 main932.47kB chunk warning은 UI 결함으로 취급하지 않는다. 내가 해당 정적 suite를 재실행한 결과는 아니다.

## 초기 harness 실행·원본 — 보존한 중간 결과

- `binding-list-20261012`: Playwright --list 정상 6개 등록. 브라우저 0 / 실제 화면검증 0.
- `actual-six-original-20261012`: workers1/retries0, exit1. runner는 1FAILED/5DID-NOT-RUN을 출력했으나 첫 worker config 로딩 전 실패(duration0, workerIndex-1)다. **실제 browser scenario body 0 / unique UI검증 0 / 제품 FAIL확정 0**. 6unique를 실행·통과했다고 주장하지 않는다.
- 원 로그: `page-session-ux-original.log`. 원 JSON: `runs/actual-six-original-20261012/results.json`. 원본 유지/덮어쓰기0. PNG/geometry는 생성되지 않았으며 직접 읽은 PNG 0.
- 실행 당시 NO_COLOR/FORCE_COLOR 충돌 경고가 출력됐다. 제품 수리 대상이 아니며 변경하지 않았다.

## 첫 실패 진단

| 분류 | Phase / 파일 | 관측 |
| --- | --- | --- |
| Harness / coordinator-worker 재로딩 경계 | config-load / `page-session-ux.config.ts:17` | `Evidence run directory already exists; originals must not be overwritten` |

Playwright1.61.1 실제 runtime source `lib/worker/workerProcessEntry.js:1385–1386`에서 두 worker index를 설정한 뒤 `:1490`에서 deserializeConfig를 호출한다. coordinator가 새 결과 폴더를 생성하고 자신의 서버를 실행한 뒤 worker가 config를 재평가한다. 시작 전용 fresh-directory/free-port 검사를 worker에 다시 적용한 것이 원인이다. 제품/API/selector/geometry 오류가 아니다.

최소 harness 수정: source/승인/runID/git guard는 모든 로드에서 유지. fresh-directory/free-port guard만 coordinator에 적용하고, worker는 숫자 worker 두 index + 상속 coordinator PID가 실제 parent PID와 같고 해당 새 runDir가 존재할 때만 재로드로 인정한다. 기존 run을 다음 coordinator가 재사용할 수 없다. 이 수정의 browser GREEN은 **미실행**이며 확정 수리 PASS를 주장하지 않는다.

15188 listener는 runner 종료 후 `lsof -nP -iTCP:15188 -sTCP:LISTEN` exit1/출력0. 내가 시작한 runner/browser/server는 종료됐다. 다른 서비스 종료0. HEAD clean `bea0dacb…` 유지.

## 연결한 6개 case / 아직 판정하지 못한 범위

1. 1194×1227 light monitoring: 실제 middle/Space/wheel/CAD, toolbar, 단일 선택, half detail/rect/camera/DOM identity, 내부 끝/header/focus/scroll 기억.
2. 390×600 dark monitoring: icon/HH:mm/full accessible timestamp, detail/internal end/navigation. clock future/error/stale는 source ac323a3d의 owner127 단위 근거로 browser 중복 제외; 이 QA에서 실제 clock/browser 검증 없음.
3. 320×600 light manual: finite document0, 두 행, continuous44 toolbar/execution/footer/list/nav 및 slider0/100 endpoint, raw31/invalid 첫Apply0POST, selection+More 동시 확장/내부 끝/focus/important 요약.
4. 390×600 dark native hasTouch manual: exposed marker-origin swipe→ghost 선택0→다음tap, 60개 층 선택/inline list 끝/header/nav/identity.
5. 717×1227→390×844 light manual: More/list 확대·닫기, renderer identity/raw31/focus/resize/document0. OS keyboard 검증 아님. endpoint는 첫 actual 실행 전 총괄 지시에 따라 case3으로 이동.
6. 1194×1227 dark manual: empty panel/map 행 높이 및 long60 내부 끝/heading/identity. 복잡 command recovery/동일 UUID는 owner41 직접 consumer 근거로 browser storage 조작 재구현 제외; 이 QA에서 복구 browser 실행0.

map240 목표는 관측값/충족 여부를 기록하도록 연결했으며 부족을 숨기거나 임의 수치로 완화하지 않는다. map box와 overlay/nav 차감 노출 면적을 분리한다. 9지점 hit 샘플은 continuous44 증거가 아니며 continuous44는 기존 1px sampling helper로 별도 측정한다. rounded44/list/camera 위험 및 slider52 endpoint 간섭은 아직 확정 결함이 아니다. 실제 OS keyboard/HIL/전체 장치/전체 데이터·query 조합 검증 주장0.

## 초기 중단 판정 — 이후 새 실행은 아래 절 참조

**Merge 가능 판정 미제공 — 실제 관문 미실행.** 재실행 승인 필요. 제품 수리·threshold 완화·force·scroll/camera injection·skip·retry0. 승인되면 새로운 runID로 아직 body가 실행되지 않은 동일6case만 실행하며, 원 결과는 보존한다. 새 행렬/새 case/독립 reviewer/delegation은 추가하지 않는다.

## 새 actual 첫6 실행 — 추가 승인 후의 현재 결과

총괄이 harness 소유 config 경계 최소 수정과 새 runID의 첫6 actual 실행을 승인했다. `actual-six-first-ui-20261012`, source 동일 `bea0dacb…`, workers1/retries0. 원 로그 `page-session-ux-first-ui.log`, 원 JSON `runs/actual-six-first-ui-20261012/results.json`. exit1 / **6 FAILED, 0 PASS, 0 SKIP, 0 FLAKY**, 실제 시간53.038s. 기존 config-load 실행은 actual body가0이므로 12unique로 합산하지 않는다. 이번 **6unique screen은 실제 로드됐지만 완료 검증은0**이다. coordinator/worker reload 원인은 새 실행에서 해소되어 실제 body와 PNG/geometry 생성까지 도달했다.

첫6의 모든 failure.json 요청 기록상 nonGET0. command/hardware 전송0. 6개 failure PNG를 모두 직접 열어 읽었고 동일 파일의 geometry도 읽었다. 새 run의 source/meta/run별 증거는 보존했다. 제품 소스 변경0 / 재실행0 / scope 기준 완화0. 15188은 runner 종료 후 lsof exit1/출력0. HEAD clean 동일.

### 원 실패 분류 — 제품 문제와 harness 오류를 합치지 않음

| Case | 실패 phase / 조건 | 실제 결과 / 원인 | 분류 |
| --- | --- | --- | --- |
| 1 PC monitoring1194 light | native-gestures 이후 detail에서 single selection 검사 | 단일 선택 source는 `aria-current=true`/`data-selected=true`인데 spec가 multiple 전용 `aria-pressed=true`로 찾음. PNG는 첫 핀 선택 outline·popover·상세보기 실제 표시. 기대1/관측0은 틀린 selector. | Harness |
| 2 monitoring390×600 dark | ready 뒤 HH:mm 검사 | source time에는 desktop hidden span와 실제 mobile11:03 span 둘 다 있음. toHaveText는 hidden 문자열까지 포함해 `2026-10-12 11:03:45 (현장 시간)11:03`. PNG 실제 glyph11:03. visible text 측정 필요. | Harness |
| 3 manual320×600 light | setup / 실제 canvas readiness | map viewport `(9,262,302,0)`, clipped box null, 노출면적0, canvas0. 지도는 없고 chrome/footer만 남음. doc600/client600/scrollY0만으로 사용성 PASS 아님. | **제품 C6–8 / blocker** |
| 4 manual390×600 hasTouch | setup / 같은 readiness | viewport `(9,264,372,0)`, 노출0/canvas0. theme 전환 이전에 실패해서 요청한 dark/native gesture 검증 미실행; 실제 PNG는 light. | **동일 제품 blocker** |
| 5 manual717×1227 light | setup / 같은 readiness | viewport `(9,262,699,0)`, 노출0/canvas0. 큰 빈 공간에도 map0. resize390×844/초안/focus 검증 미실행. | **동일 제품 blocker** |
| 6 PC manual1194 dark | ready / global 전체 보기 hidden 검사 | 선택 목록의 mobile 전체보기는 숨었지만 다른 기존 이력 전체보기를 global locator가 찾음. selection/map panel 높이는 각각922px로 같음. | Harness |

제품 source 조사 위치: `ControlView.tsx:680–686` finite workspace/grid height 전달, `SpatialTargetSelector.tsx:141–156` remaining grid/map wrapper, `FloorMapViewport.tsx:725–742` compact min-h0/contain:size viewport. 확정 증상은 **지도 남은 높이0**이며 CSS 원인/해결 책임은 sole writer/root이다. 이 QA는 수정하지 않았다. 240 목표에 못 미친 정도가 아니라 주 작업 지도 노출0이므로 UI merge 승인 불가.

추가 harness source 대조: 실제 React Aria NumberField는 browser에서 `textbox "밝기 수치"`이며 spec의 spinbutton 가정은 이후 단계에서 수정 필요. 이번 first6에서는 해당 selector까지 도달하지 않아 이 항목을 별도 actual FAIL로 세지 않는다.

### 관측된 geometry·네이티브 입력 (부분 근거만)

| Case | map box width×height | exposed area(px²) | document scrollHeight/clientHeight, scrollY | theme 실제 |
| --- | --- | --- | --- | --- |
| 1 | 916×852 | 732172 (핀 popover가 일부 가림) | 1227/1227,0 | light |
| 2 | 360×240 | 86400 | 792/600,0 | dark |
| 3 | 302×0 | 0 | 600/600,0 | light |
| 4 | 372×0 | 0 | 600/600,0 | light(요청 dark 미도달) |
| 5 | 699×0 | 0 | 1227/1227,0 | light |
| 6 | 282×752 | 212064 | 1227/1227,0 | dark |

case1 native middle/Space/wheel은 `native-gestures.json/png`가 생성되어 실제 입력·camera 변화·area overlay0 체크에 도달했다. 나머지 detail half/scroll/focus/continuous44 전부 PASS로 확대하지 않는다. case2 natural document scroll은 모니터링 기존 정책이라 scrollHeight792 자체를 manual finite 결함으로 세지 않는다. map240은 실제로 충족하지만 footer 아래쪽이 nav532px 이후 가려져 native scroll 접근 검증은 아직 필요하다. map box와 노출 영역을 분리했고 hit9 샘플을44 proof로 확대하지 않았다.

PNG 직접 UI 판정: 모니터링은 one-row 도구와 mobile HH:mm이 눈에 보이며 PC 단일 선택 outline·popover가 보인다. 모바일 manual은 본래 지도 작업 공간이 사라지고 상단 도구·범례·전체보기·실행만 남는다. 717 tall에서도 같은 현상이라 짧은 viewport 문제로 축소 해석할 수 없다. PC empty panel full-height는922px로 일치하나 map 폭282와 실제 fit scene232×154로 60핀이 밀집되어 native 선택/44 판단은 미완료다. PC mock GET404의 최근 명령 오류 문장이 한 글자씩 수직으로 감긴 모습도 보인다(실제 backend 장애 주장 아님). 긴 critical/action 표시 품질은 후속 수정/국소 실제 검증에서 확인 필요.

### 현재 merge / 남은 검증

**현재 merge UI 관문 FAIL/보류.** root/제어 writer가 map0을 먼저 수정해야 한다. 모니터링/PC harness 3개는 selector 및 hidden-text 관측을 실제 source에 맞춰 최소 교정해야 한다. 모든 원 실패와 PNG·JSON을 보존하고, 총괄의 변경 source/국소 rerun 승인 전에는 실행하지 않는다. 새 case/행렬 추가 없음. slider0/100은 총괄 요청대로 가장 좁은 **case3(320px)**로 옮겼지만 map readiness 실패로 아직 미측정. More/list 동시 확장/continuous44/nav/internal ends/native touch/resize/raw31/invalid 첫Apply 및 detail body/focus는 해당 실패 이후 단계라 현재 검증 완료 주장0. OS keyboard/HIL/실장비/전체 devices 검증0.

## 총괄 후속 인계 — STOP/WAIT 및 최소 harness delta 제안

총괄이 first6의 0PASS/6FAIL과320 map0을 직접 확인했다. 제어 sole writer에게만 finite 높이 경로 제품 freeze를 해제했으며 **본 QA는 새 source grant 전 추가 browser 실행 STOP**이다. 아래는 이 보고서의 제안만이며 spec/support를 아직 변경하거나 실행하지 않았다. 15188 종료는 후속 인계 뒤에도 다시 lsof exit1/출력0으로 확인했다. HEAD commit/menu/제품/기존 test 변경0.

### 실제 실패 3개에 대한 최소 교정

1. **Case1 single selection**: `detail()`의 `aria-pressed` count를 `map.locator('[data-spatial-map-marker="true"][aria-current="true"]')` count1로 바꾸고 원 opener의 `aria-current="true"`를 함께 확인한다. `FloorScene.tsx:374–377`의 single와multiple 계약에 맞추는 것으로 단일 선택 기준1은 그대로다. geometry collector의 selection에 기존 pressed와 함께 실제 current/data-selected도 기록하도록 제안한다. 핀·카메라·제품 상태 주입 없이 읽기만 한다.
2. **Case2 실제 HH:mm glyph**: time의 정규식은 유지하고 `toHaveText(/^\d{2}:\d{2}$/, { useInnerText: true })`로 visible text를 측정한다. 설치된 Playwright1.61.1 `types/test.d.ts:9597–9613`에서 지원함을 확인했다. 기존 full aria-label/dateTime 검사는 유지하고 숨겨진 full span 존재를 오류로 취급하지 않는다. 길이나 정규식을 느슨하게 만드는 변경이 아니다.
3. **Case6 PC inline button scope**: global `getByRole("button", {name:"전체 보기"})` 대신 이미 잡은 `listPanel`의 실제 header disclosure `:scope > div:first-child > button[aria-controls]`를 scoped locator로 잡아 count1 및 hidden을 확인한다. 기존 command history 전체보기와 혼동을 제거하고 실제 선택 목록 버튼의 존재와 hidden 계약을 모두 확인한다. 이력 버튼을 숨기거나 mock하지 않는다.

추가로 아직 실패하지 않은 **latent harness role 오류**를 명시한다: case3/5의 numeric locator를 현재 actual browser의 `textbox "밝기 수치"`로 연결해야 한다. 실패 후 threshold 조정이 아니라 NumberField 소비자와 브라우저 accessibility snapshot의 정확한 역할을 반영한다. spec의 역할2곳을 같은 locator 계약으로 교정하는 제안이며 새 case0. 현재 지도0 때문에 raw31/invalid를 측정하지 못했으므로 이 role 교정을 GREEN이나 제품 결함 해결로 세지 않는다.

원 source/run에서는 위 원 실패를 삭제하거나 판정값을 바꾸지 않는다. 새 source grant가 오면 허용된 failed case만 fresh runID/retries0로 검사하고 run별 unique와 재검사를 구분한다. 제품 수리 검증은 지정 writer/root 소유이며 본 QA는 제품을 수정하지 않는다.

### 추가 판단/Ruling 명시

- 새로운 UI/UX 설계 Ruling·기능 축소·API 변경·판정 threshold 추가 **0**. 지도0은 기존 남은 지도/실제 노출 계약에 대한 blocker 판정이다. 240목표를 강제 새 기준으로 바꾸지 않았다.
- 추가 관측1: NumberField textbox 역할은 기존3 harness 실패 외의 **미도달 잠재 테스트 오류**다. 위에 별도 표시했고 실제 실패 개수에 더하지 않았다.
- 추가 관측2: PC mock GET404 최근 명령 오류의 한 글자 수직 wrap 및282px map 밀집은 **PNG warning/미판정**이다. 새 확정 제품 결함/수리 범위로 지정하거나 전체 backend 문제로 확대하지 않았다.
- 모니터링 natural document scroll, OSkeyboard/HIL0, source cohort별 direct unit 한계, map box와 exposedarea/9sample와continuous44 분리는 기존 계약을 유지한 설명이며 새 Ruling이 아니다.

현재 작업 산출물은 원본 first6 증거·실패 분류·최소 delta 제안까지다. 새 승인 source/국소 실행 인계 전 WAIT.

## 승인된 harness 4개 최소 반영 — 실행하지 않은 준비 상태

위 제안은 총괄이 검토·승인했으며 이후 **ignored SDD spec/support만** 다음과 같이 반영했다. 제품/기존 test/config/6case 구성/threshold/timeout/force/noPOST/navhit 규칙은 변경0. 새 source grant 전 server/browser/Playwright list/typecheck/정적 test 실행0, HEAD commit0. 따라서 수정본 runtime GREEN/PASS는 아직 주장하지 않는다.

- Case1: single `aria-current=true` count1 + 원 opener `aria-current=true`. multiple 전용 pressed와의 혼동만 제거.
- Case2: HH:mm 정규식 유지 + `useInnerText:true`. full aria-label/dateTime 검사는 그대로 유지.
- Case6: `listPanel` header `button[aria-controls]`에 scope를 한정, count1 + hidden. 기존 이력 전체보기에는 변경0.
- Case3/5: numeric locator 두 곳만 actual `textbox` 역할로 연결.
- Collector: 기존 `pressed` 유지 + 실제 `aria-current`/`data-selected` 읽기 필드 추가. DOM·scroll·camera 변경 없음.

새 파일 SHA256(준비본 식별용, runtime 검증 증거 아님):

| 파일 | 이전 → 현재 |
| --- | --- |
| page-session-ux.spec.ts | `6aa9c614fd27a5b2f01ab42f8c0bdf09b23d0a5bf03c0df2ecda0167cc1dfdb4` → `d4d914e3efb1ac915e15c8ac8cba9e2fb1073027b4c690b958aa1d2043363801` |
| page-session-ux-support.ts | `5ef810e03dddeac4bc40cb89f0ea80b23bad5c525f7ca549e67b702dde99ac24` → `1c282988a94f71fa3c473eed3217629e67f87c54ab2785c4f62fa74a943ee878` |

원 증거4개의 전후 SHA256 일치를 확인했다(첫config log `cee95592…`, 첫UI log `50a6ba39…`, 첫config results.json `71b13518…`, 첫UI results.json `4c0fd6a0…`). 해당 runs의 PNG/geometry 파일은 수정 대상으로 접근하지 않았다. 이전6FAIL 및 map0 판정은 불변이다.

새 UI/UX Ruling0. 총괄의 변경 source grant 뒤 **기존 failed6만** 허용 scope로 검사할 준비까지 수행했으며, 지금은 추가 실행 없이 WAIT.

## 제품 높이 수리 source69b1e9a3 — 승인된 failed6 재검사 결과

총괄 execute grant의 새 clean HEAD `69b1e9a3cb1dc7e2092a0ca96e56904e0938361a`에서 실행했다. 제품 변경은 지정 제어 writer의 `ControlView.tsx`/`docs/menus/control.md` 2개이며 finite 외부/tabpanel explicit remaining rows와 manual history pane wrapping이다. 공통 API/handler/query/command 변경0이라는 root 인계를 받았다. root 전달 직접검증7files83PASS/type·UI0은 이 새 제품 cohort의 owner 결과이며 내 browser 결과에 합산하지 않는다. root final static newcohort는 별도 진행 중이다.

Run `actual-six-repair-69b1e9a3-20261012`, 원 로그 `page-session-ux-repair-69b1e9a3.log`, 원 JSON `runs/actual-six-repair-69b1e9a3-20261012/results.json`. **exit1 / 2 PASS /4 FAIL /0 SKIP /0 FLAKY /80.915s**, workers1/retries0. 승인된 기존 failed6 재검사6건이다. 첫6+재검사6은 **6unique +6 재검사**이지12unique가 아니다. 이전 source bea0dacb의 6FAIL과 config-load 오류는 불변·별도 cohort로 보존한다.

이번 read-only geometry/PNG와 요청 기록도 nonGET0. 15188 종료 후 lsof exit1/출력0, HEAD69b1e9a3/clean 확인. 제품·기존 test 수정0, 자동 case retry0, 테스트 timeout/force/44·nav·noPOST·geometry 기준 변경0, 새 case0. 승인된 harness4delta만 사용했고 이번 실패 후 수정/추가 실행하지 않았다.

### 새 실패·통과 분류

| Case | 결과 / 실제 phase | 관측·분류 |
| --- | --- | --- |
| 1 PC monitoring1194 light | FAIL / detail-end 후 reopen, timeout30s | 선택 count·half overlay·동일 map rect/camera/canvas·close/focus까지 도달. 상세 종료 후 pin popover가 자동 재개됐다고 spec가 가정해 없는 상세보기 버튼을 기다림. `FloorMap.tsx:196–201`은 nonmodal onOpenChange(false) 때 openFixtureId를 null로 한다. 기존 상세 종료 후 실제 pin을 다시 클릭하는 흐름이 필요하다. **추가 harness 원인**, 제품 재열기 결함 확정 아님. |
| 2 monitoring390×600 dark | FAIL / detail-open 뒤 body native wheel origin | HH:mm/fullaria/dateTime·toolbar/nav44·single/half/rect/camera/identity/close44에 도달. body bounds y498.5..601, 중심549.75가 fixed nav y532..600에 덮여 actualCenter가 거부했다. 실제 노출 body는 nav 전33.5px. **제품 가림 관측 + center-only harness 한계**; native document scroll/노출 위치 wheel 없이 도달불가로 확정하지 않는다. |
| 3 manual320×600 light | FAIL / ready 뒤 첫 pin click, timeout30s | 지도0은 해소됐으나 viewport302×62, actual canvas19×12. 세 핀이 tiny surface/clamp에서 겹치고 클릭을 viewport placeholder div 또는03핀 등이 가로막음. actual1번째 클릭이 성립하지 않음. **제품 좁은 지도/선택 접근 blocker**. endpoint0/100·More·invalid는 아직 미도달. |
| 4 manual390×600 dark hasTouch | FAIL / native-touch 뒤 60 floor + inline end, identity | 초기 map372×70, zoom/touch 이후372×88. native swipe 선택0→다음tap1, 층60 count·inline 끝60·고정 heading·document0/nav44·전체보기44까지 도달했다. 목록 펼침 후 map372×0/exposed0/canvas0로 다시 사라져 기존 canvas.isConnected=false. **제품 잔여 공간/canvas 소실 blocker**, 독립 renderer handler 수리로 단정하지 않는다. |
| 5 717×1227→390×844 light | PASS | 목록+More 동시 확장/닫기와 raw31·renderer identity/camera·focus·finite document0/nav44·resize. 초기 map699×699, 동시 펼침699×425, resize후372×334. OSkeyboard 검사 아님. |
| 6 PC1194 dark | PASS | empty/60 선택 list/map panel922px 동일, 내부끝scroll1108/(1968−860), 실제60행 도달, heading/identity/overflow 유지. manual history 오류 문장이 수평으로 읽히며 기존 수직 글자 wrap 해소 PNG 확인. 복잡 recovery는 browser 미실행. |

case1/3의 timeout 시 Playwright가 page를 먼저 닫아 `failure.json/png`를 추가 생성하지 못했다. **누락을 숨기지 않는다**: original-failure.json + runner test-failed-1.png/error-context + 해당 ready/detail-end phase geometry가 남고 failure-capture-error attachment는 `Target page, context or browser has been closed`이다. test timeout을 늘리거나 fail 내용을 지우지 않았다.

### 새 geometry / 실제 노출 면적

| Case/phase | map box | exposed(px²) | 주요 내부/가림 값 |
| --- | --- | --- | --- |
| 1 detail open/end | 916×852 | 419986 | aside458.5/parent917 정확half. body client374/scroll374/top0(PC에는 양의 scroll range없음). 지도camera0,0/zoom1 유지 |
| 2 detail open/failure | 360×240 | 64620 | aside179.5/parent359. body102.5높이·scroll342/client103·top0, center549.75 nav에 가림. 전체 body 노출33.5px before nav |
| 3 ready | 302×62 | 18724 | canvas19×12, 문서600/600·scrollY0. 목표240 대비−178px, map 우세/선택 가능성 실패 |
| 4 ready / native-touch | 372×70 /372×88 | 26040 /32736 | native swipe camera y8→13, selection0→tap1. 초기 목표240 대비−170px |
| 4 inline-end failure | 372×0 | 0 | list90px, scroll1878/(1968−90) 끝 도달. canvas0·기존 canvas disconnected, footer usable null. 문서600/600·scrollY0이라도 지도 보존은 실패 |
| 5 both-expanded / resized | 699×425 /372×334 | 297075 /124248 | More208px/list80px(1개 선택) 동시 노출. resize raw31/focus/renderer 유지, document844/844·0 |
| 6 PC end | 282×752 | 212064 | PC list860px와 panel922px 유지. actual fit scene232×154에60핀이 밀집한 제한은 남음 |

240은 관찰 목표로 유지했으며62/70과0을 숨기거나 최소치로 완화하지 않았다. map raw box / ancestor-clipped box / overlay·nav 차감 노출 면적을 별도 기록했다. 9sample hit는 continuous44를 대신하지 않는다. Case3의 320 endpoint(0/100)·camera/list icon44 full continuous checks는 pin 클릭에서 막혀 실행되지 않았다. case4/5가 통과한 nav44/list header44를 endpoint나 모든 camera44 PASS로 확대하지 않는다.

### 이번 직접 PNG 읽음 / UI/UX 판정

이번8개 PNG를 직접 열어 읽었다: case1 detail-open와timeout test-failed, case2 failure, case3 timeout test-failed, case4 failure, case5 both-expanded/resized-focused, case6 complete. 모든6 화면을 포함한다.

- PC monitoring: half 상세는 기존 도면 크기를 바꾸지 않고 읽히며 닫기 후 원 핀 포커스가 보인다. 자동 pin popover 재개는 없는 실제 화면이라 spec 재열기 가정과 다르다.
- 짧은 mobile monitoring: 상세 제목/닫기/조명 이름은 보이지만 내용 시작 이후가 nav에 가려져 현재 한 화면에서 정보 읽기가 부족하다. 테스트도 body center 대신 실제 노출 영역을 선택하거나 native 문서 이동을 검증해야 하며, 둘 다 root 추가 승인 전에는 반영/실행하지 않는다.
- 320 manual: 지도는 얇은62px 띠이고 사실상 한 점처럼 뭉친 핀만 보인다. 주요 기능을 편하게 사용하는 UI라는 목표에 부족하다. 문서0/행2개의 geometry만으로 최종 사용성 PASS 불가.
- 390 manual60 inline: list 마지막58/59/60은 읽히나 지도와footer가 사라져 count/list가 본 작업 공간을 대체했다. renderer 재생성을 강제로 막기보다 height0 원인을 제품 owner가 검토해야 한다.
- 긴717/resize390×844: 지도·목록·More가 함께 보이고, 닫은 후334px 지도와 밝기31 focus가 유지된다. 이 실제 대표 case 범위만 PASS.
- PC manual: 선택 목록922px 유지/끝60 도달, 제어 이력 오류문장의 수직 wrap 해소. 기존 데이터 fixture GET404를 실제 서버 문제라고 주장하지 않는다.

### 현재 판정 / 후속 권한

**현재 merge UI 관문 보류**: source69b1e9a3은 최초0-height를 해소했지만 short viewport/map·list확장 blocker가 남는다. 기존 PASS2는 재실행하지 않는다. 실패4의 원인·이 기록을 root에 인계하고 STOP/WAIT. case1 재열기 native opener 클릭과case2 노출 영역/native 문서 이동은 **추가 harness 교정 제안**일 뿐 approved4 범위를 넘으므로 아직 변경0. 새 UI/UX 설계 Ruling0·제품 수리0·threshold 완화0. OSkeyboard/HIL/real equipment/전체device/미실행clock/recovery 검증 주장0.

## 다음 실행 판정 — short budget / 최소 계층 권고 (새 실행0)

| 기존 ready geometry | 지도 전 공간 | 지도 | 지도 후 공간 | 비지도 합계 |
| --- | --- | --- | --- | --- |
| 320×600 | 262 | 62 | 276 | 538 |
| 390×600 | 264 | 70 | 266 | 530 |

320 지도 후276 = footer63 + border/간격5 + count/전체보기66 + 간격4 + 실행44 + 간격4 + 중요상태18 + nav전4 + nav68. 390은 footer53이므로266. 지도 전262/264에는 toolbar52/54·map상태chrome28과 shell/제어방식/간격이 포함된다. 390 목록 펼침은 기존66에 내부90+간격4를 추가해160px: 기존 남은70보다94가 더 필요하다. 이 geometry만으로도 정상 flow의 지도0 재발을 설명하며, floor별 선택 UI의 별도 영향은 단독 phase가 없어서 분리 측정 주장하지 않는다.

추천 최소 순서: **authorized compact manual만** (1) 중복 현장전체/층 집계·legend를 기존 More로 재배치, (2) 제어방식 전환도 More에서 같은 기존 route handler로 접근 가능하게 하고 main에서는 현재 수동 모드 식별 유지, (3) floor/scope/list 실제44행·compact topbar로 조정, (4) 지도→count→바로 아래44전체보기→44실행행→중요상태/action→nav의 순서를 유지. 카메라4기능/조명 선택/상태·권한/원 handler·query·UUID owner/default 소비자를 없애지 않는다. 현재 viewport padding24×2가62px 영역을 actual canvas19×12로 줄이는 증폭 요인이지만 padding만 줄여 C7를 충족했다고 주장할 수 없다.

**명시 선택이 필요한 지점**: 기존90px 목록 + 최대150px More를 동시에 세로 flow로 펴면 추가244px이다. 기본 지도를240px로 확보해도 잔여가 음수가 되어, ‘600px·document0·모든44/critical/action·동시 세로 inline·항상 map 우세’를 padding 수리만으로 함께 충족할 수 없다. 더 작은 두 내부 pane라도 각각 마지막44 action을 노출하려면 추가약96px이며 map240을 그대로 유지하지 못한다. 따라서 compact chrome 정리는 우선 권고하되, **C7 우세를 기본 지도 작업 상태에 한정할지, 목록/More 보조 읽기의 동시 세로-flow 표현을 바꿀지** root/사용자 결정이 필요하다. 임의로 하나만 펼치게 하거나 count/전체보기·critical·nav를 숨기지 않는다. 새 최소 높이/테스트 threshold는 제안·반영하지 않았다.

Case1은 **harness 확정**: 없는 자동 pin-popover 재개를 기다림; 실제 opener 재클릭이 정상 경로. Case2는 **center-only harness 한계 + 실제 가림 관측**: body y498.5..601의 center549.75가 nav532..600에 덮이며 노출33.5px. 실제 노출점/native 문서 이동을 아직 시도하지 않아 제품 ‘끝 도달불가’ 확정은 보류한다. 새 viewport/API/상태분석/제품 수리/harness 확장/실행0. 권고는 미승인 설계 선택이며 새 Ruling으로 적용하지 않고 WAIT.

# 2026-10-12 모니터링·수동 제어 지도 작업 공간 실행 체크리스트

> 승인: 사용자의 ‘오케이’는 대화에서 확인한 8건의 짧은 설계와 별도 브랜치 구현 → UI/UX 확인 → 로컬 머지 진행을 승인한다. 재설계나 별도 승인 절차를 추가하지 않는다.
> 실행: 사용자가 ‘담당 에이전트 세션’은 기존 앱 채팅을 뜻한다고 정정했다. 내부 서브에이전트의 추가 구현은 중단하고 아래 기존 세션에 직접 인계했다. 총괄은 소스 수정 대신 결과·원 증거와 이 체크리스트를 취합한다.

## 실제 담당 세션

- 모니터링: `모니터링 페이지 담당자` / `01a088f3-9a15-7802-bd31-cfcfcba2f4d1`.
- 제어 UI: 사용자 링크로 확인한 `제어 UI 개선 담당자` / `01a0f776-b930-7eb2-a121-e05bef4d1581`. 정확 세션을 읽어 이번 NEW Task2 단독 writer로 메시지 배정했다. 기존 `제어 페이지 담당자` / `01a088db-9c18-7fc1-8ec4-9782efb8ad20`의 이번 UI 요청만 취소 메시지를 전송했고 그 세션의 기존 장비 작업은 취소 범위가 아니다.
- UI/UX: `UI/UX 디자이너` / `01a0ce87-d272-72d2-8bb6-e021f52628c3`.
- 사용자 직접 인계 지시로 위 세션 메시지 전송을 승인받았다. 기존 진행 중인 별도 장비 작업을 중단하거나 이 UI 작업에 혼합하지 않는다. 제어 UI는 정확한 지정 세션 확인과 Task1 인수 후 단독 writer로 시작한다. 세션 전체 interrupt/handoff로 기존 작업까지 중지하지 않는다.
- 내부 모니터링 checkpoint `ac323a3d`(소유5파일)와 원 RED/실패/국소 GREEN은 보존한다. 원 세션이 이를 검토·인수해 이어가며 중복 구현하지 않는다. 내부 제어는 준비만/제품diff0, 내부 QA도 제안만/실행0이다.

## 범위와 공통 제약

- 기준 MAIN `codex/mvp1-cloud-web` / `f31e56fadd27d63f96824bad2ea2c4ef71581b62`; 격리 `.worktrees/map-workspace-comments-20261012`, 브랜치 `codex/map-workspace-comments-20261012`.
- 이번 신규 C1–8만 수정한다. 과거 29건/20건 완료 증거와 합산하지 않으며 운영 인사이트·통계·설정·API·DB·실장비·다른 worktree·stash·원격·배포는 변경하지 않는다.
- 중간 버튼 드래그 pan, 왼쪽 클릭 fixture, touch swipe pan/tap, wheel zoom·Space·arrow·pinch·cancel·카메라 기억을 보존한다. 모니터링에 다중/영역 선택을 도입하지 않는다.
- 순수 snapshot 60초 지연만 기존 알람센터의 현재 화면 상태로 안내한다. toast/최근 알림/서버 incident/새 unread count는 생성하지 않는다. 조회 실패·잘못된/미래 metadata 경고를 일괄 무음화하지 않는다.
- 보이는 모니터링 제목 제거, 접근성 h1 보존. 층·검색/목록·시각·새로고침 한 행; 좁은 화면 버튼은 44px 아이콘·접근 가능한 이름, 시각 HH:mm 축약과 전체 정보 설명 보존.
- 상세는 지도 내부 하단 약 절반 nonmodal overlay. 지도 rect·카메라·renderer lifetime 불변, header/닫기 고정, 본문 내부 scroll, Escape/focus 복귀/scroll 기억 유지, overlay wheel이 지도 확대를 유발하지 않는다.
- PC 선택 패널은 empty도 전체 행 높이. 모바일은 ‘선택 조명 N개’ → 바로 아래 44px ‘전체 보기’를 유지하고, 목록은 지도 내부 하단 보조 패널에서 내부 스크롤한다. 사용자 후속 승인으로 목록/More는 한 번에 하나만 열며 지도 rect·카메라·renderer 크기를 줄이지 않는다. 새 query/command owner 없음.
- 수동-active 모바일만 유한 높이 shell/workspace. floor·scope·목록 한 44px 행, brightness 숫자·slider·Apply·More 한 44px 행. presets/history/recovery 상세는 내부 More; 오류/복구 존재를 보이는 표시와 live 안내로 유지한다.
- raw draft·invalid blur/Enter·첫 Apply 차단·명시 Apply·권한/잠금·UUID·명령 복구 수명·scope reset을 보존한다. CSS overflow-hide로 누락을 덮지 않는다. schedules/events/editor/embedded 기본 동작 변경 없음.
- 기존 Button/Card/SelectBox/IconButton/OperationMapPanel 및 token을 사용한다. 실제 두 소비자의 overlay chrome가 반복되면 Task1이 `components/ui/maps`에 최소 공통 컴포넌트를 만들고 API를 보고한 뒤 Task2가 소비한다. 새 shared/API 계약 없음.

## 경계 사전 점검

| 작업 | 단독 writer | 공유·선행 관계 | 자기 정합 점검 |
| --- | --- | --- | --- |
| 1 C1–5 | 기존 모니터링 담당 | 공통 maps chrome 필요 시 이 담당만 먼저 수정; 기존 Viewport 정책 소비 | 모니터링 single selection·alarm/focus 수명 유지, 약 절반 overlay는 canvas 크기 불변 |
| 2 C6–8 | 기존 제어 담당 | Task1 source/API 확인 후 순차. CustomerShell manual-only 높이 및 common viewport optional compact chrome 필요 시 이 담당 소유 | 단일 command/draft owner·default/embedded 보존, min-height와 내부 scroll/44px 모두 실제 검증 |
| 3 검증 | 기존 QA + UI/UX 담당 | 제품 writer 완료 후. QA는 test/evidence만, UX는 읽기 전용 | 동일 source cohort·actual map box와 exposed area를 구분, fixture/API fake와 HIL 미실행 기록 |
| 4 리뷰·통합 | 기존 독립 reviewer + 총괄 | base..최종 제품 SHA의 source-scoped package, owner 수리 후 scoped 재검증 | fresh MAIN 상태·예상 SHA·clean 확인. 변동 시 같은 통합 tree 한정 재검증 |

Ruling: 사용자 요청의 필요한 검증만 수행하는 방침에 따라 변경 직접 unit/TDD, 최종 웹 타입·UI 정책·빌드, 이번 동작의 한정 실제 browser와 기존 reviewer 1회 통합 검토를 사용한다. 과거 전체 suite·HIL을 반복하지 않는다. 틀리면 변경 밖 회귀를 놓칠 수 있으므로 미실행 범위를 명시한다.

## 진행

- [x] 짧은 설계 승인·기존 세 담당 read-only audit·별도 브랜치/worktree 준비.
- [x] frozen offline install/workspace prepare(exit0), 계획 자기 점검·Task1 brief 생성; 준비 commit9d59c7e6.
- [x] 기존 앱의 모니터링·UI/UX 세션에 직접 인계. 내부 writer 종료 및 checkpoint 원 자료 보존.
- [x] 사용자 지정 `제어 UI 개선 담당자`의 정확 링크 확인·Task2 단독 writer 인계(기존 제어 페이지 UI 요청만 취소 전달).
- [x] Task1 모니터링 C1–5 제품ac323a3d 인수·자체검토, 원 페이지 세션 직접2suite127PASS 및 메뉴문서87f658ef. 실제geometry는후속QA.
- [x] Task2 지정 앱세션 제어 C6–8 제품9f3e25d7/소유13파일, 최종선택41PASS·identity2국소PASS(중복합산0)·타입/UI0. 실제기하는후속QA.
- [ ] Task3 한정 browser·정적 관문·실제 UI/UX 리뷰, 발견 문제 owner 수리.
- [ ] Task4 독립 통합 리뷰·fresh MAIN 확인·로컬 머지·회복 가능한 정리.

### 현재 인계 — 사용자 승인한 지도 하단 단일 보조 패널로 재개

- 수리 source `69b1e9a3`는 모바일 남은 높이 전달과 좁은 PC 이력 줄바꿈을 보완했다. 지정 제어 UI 담당 소유2파일/직접7files83PASS(274비선택)·타입/UI0·0, 총괄 동일source정책79PASS·타입포함buildexit0를 확인했다. 원82PASS/1timeout·분리3PASS를 최종83에 합산하지 않는다.
- 실제 첫6는0PASS6FAIL, 수리source동일failed6 재검사는2PASS(case5 resize/6 PC)4FAIL(case1–4)이다. 원 config-load1FAIL/5미실행은 실제body0으로 구분한다. 원 PNG/geometry/log는 ignored SDD `page-session-ux-report.md` 및 runs에 보존했다. 최종6전체 통과나 merge readiness로 확대하지 않는다.
- 기본map0은 해소됐지만320×600 map62px/390×600 map70px이며 긴 목록 확장후 다시map0/canvas소실이다. 동일 화면의 비지도 공간은538/530px, 목록90+More150 동시세로펼침은추가244px이다. ‘지도 우세·페이지scroll0·기존44px/중요상태·동시세로펼침’은 현재정보를유지한 채 함께충족할수없어 표현선택을사용자에게묻는다. 최소compactchrome재배치는후속권고이며아직적용하지않았다.
- 위 선택 대기는 당시 이력이다. 사용자가 ‘지도 크기를 유지하고, 목록·더보기를 한 번에 하나씩 여는 지도 하단 보조 패널’을 승인했다. 지정 제어 UI 원 세션만 제품 수리를 재개하고, UX 원 세션은 같은 최대6고유 case의 준비를 갱신한다. 최종 source SHA 인계 전 실제 browser 실행은 대기한다. 기본브랜치/다른작업/스태시/원격은변경하지않는다.
- 기본62/70px 지도를 그대로 유지하는 overlay만으로는 C7–8을 충족하지 못한다. 수동-active 모바일만 중복 현장/층 요약·범례와 모드 전환을 기존 More 접근 경로로 압축하고 현재 수동 모드 식별을 유지한다. 층/scope/목록44px 한 행, 지도, 선택 count→바로 아래 전체 보기44px, 실행44px, 중요 상태/live, nav 순서와 안전 동작을 보존한다. 기본 지도240px 이상 목표·map box와 가림 없는 exposed area는 후속 실제 측정이며 source/class만으로 완료 처리하지 않는다.
- 보조 패널은 nonmodal·고정 header/닫기·본문 내부 scroll, 목록↔More 상호배타, Escape/실제 opener focus 복귀·scope reset을 유지한다. 전환은 원 draft/UUID/query와 renderer를 재마운트하거나 복제하지 않는다. PC/schedule/event/default/editor/embedded 기본값은 변경하지 않는다.
- 모니터링case1은실제pin재클릭을생략한재열기harness오류다. case2는bodycenter가nav에가리는실측+center-onlyharness한계이며native문서이동/노출점wheel을아직실행하지않아끝도달불가제품결함으로단정하지않는다. 후속승인된failedscope에서수리·검증한다.

### Task 1: 모니터링 C1–5

**실행 경계:** NEW worktree `.worktrees/map-workspace-comments-20261012`, NEW branch `codex/map-workspace-comments-20261012`, baseline f31e56fa. 운영 인사이트/통계/설정/API/DB/장비/다른 worktree/stash/원격/배포/기존 서비스는 변경하지 않는다. 기존 공통 UI/token을 재사용하고 공통 overlay가 두 소비자에 필요할 때만 최소 API를 추가하여 총괄에게 알린다. 실패 테스트 먼저 실행하고 직접 suite만 검증한다. 계획 전체가 아니라 이 task brief와 applicable AGENTS/skills만 읽는다.

**소유:** MonitoringView/FloorMap/직접 tests/docs/menus/monitoring.md. 필요 최소 common maps component/export/test만 이 담당 소유. FloorMapViewport 기본 정책·session provider 전역 변경은 먼저 보고한다.

**필수 문맥:** 위 공통 제약 전부 적용. 기존 `manual-cad` + `interactionPolicy="pan"` 소비. 순수 snapshot stale만 announce false. loading/error/main visible title 제거하되 h1 sr-only. floor/search/time/refresh 한 행, narrow icon-only44·time HH:mm/full accessible 설명. 기존 별도 aside/mobile modal을 지도 하단 비모달 약 절반으로 통일; map rect/camera/remount 불변, close/Escape/return focus/scroll 기억과 지도 interaction 유지.

1. 새 동작을 실제 컴포넌트로 관찰하는 실패 테스트를 먼저 작성·실행한다. snapshot 경계60000/60001·복구와 failure/invalid 안내, real marker gesture 및 single selection/no area, overlay lifecycle 중심. CSS geometry는 Task3 browser 관문이다.
2. 최소 제품 구현, 직접 suite GREEN. 프레임워크나 mock 존재 assertion 대신 소비자 동작 검증.
3. 공통 overlay 추가 시 최소 API/경로/기본값·Task2 소비 방법을 보고한다. 기존 공통 Card/Button 재사용으로 충분하면 불필요 API를 만들지 않는다.
4. 메뉴 문서 다섯 구성 유지·mock/HIL 한계 기록, diffcheck, 자기 리뷰·소유 파일만 source commit.
5. task-1-report.md에 base/source SHA·변경 파일·원 RED/GREEN 로그·검증된 동작/누락/경계 API를 기록한다. 총괄 plan/status 수정 금지, 다른 writer 호출 금지.

**검증:** 직접 Monitoring/FloorMap 및 필요한 공통 overlay suites만. 원 로그는 이 작업 SDD workspace. 제품 구현 후 Task2에 source checkpoint 전달.

### Task 2: 수동 제어 C6–8

**실행 경계:** NEW worktree `.worktrees/map-workspace-comments-20261012`, NEW branch `codex/map-workspace-comments-20261012`, baseline f31e56fa 이후 Task1 checkpoint. 운영 인사이트/통계/설정/API/DB/장비/다른 worktree/stash/원격/배포/기존 서비스는 변경하지 않는다. 공통 UI/token 재사용; Task1 maps optional API를 먼저 확인하고 default/embedded는 보존한다. 실패 테스트 먼저 실행하고 직접 suite만 검증한다. 계획 전체가 아니라 이 task brief와 applicable AGENTS/skills만 읽는다.

**소유:** ControlView/ManualExecutionPanel/target-selection 및 직접 tests/docs/menus/control.md. CustomerShell manual-active-only height, 선택적 FloorMapViewport compact chrome 및 direct tests는 이 담당만 소유. Task1 maps API 변경 시 승인된 API 소비만.

**필수 문맥:** 위 공통 제약 전부 적용. Task1 결과 source/API 확인 후 구현. PC 선택 panel h-full empty 포함·long list internal scroll. mobile 선택 count → 바로 아래44 ‘전체 보기’ 유지, 승인된 지도 하단 nonmodal 보조 패널에 목록/More를 하나씩 표시·internal scroll; map rect 유지·close/focus/scopereset 보존. manual-active shell h-dvh/min-h0/navigation safe reserve, finite grid remaining map dominant; floor/scope/list44 한 행 및 brightness numeric/slider/Apply/More44 한 행. 긴 presets/history/recovery More internal scroll. raw draft/invalid/first Apply/explicit apply/lock/permissions/UUID/command lifecycle 보존; 중요 상태는 collapsed에도 visible/live. schedules/events/default/editor/embedded behavior 변경0.

1. 선택 panel 확장/empty/focus/scope reset, compact input/More 복구/command safety의 직접 실패 테스트를 먼저 실행한다. shared optional compact props 도입 시 default 소비자 회귀 test도 직접 확인한다.
2. 최소 제품 구현 후 직접 GREEN, 기존 중복 command owner/query/drawer 만들지 않는다. 카메라 reparent/remount를 피한다.
3. 320/390×600에서 map240 이상 목표이나 실제geometry로 확정한다. height hidden clipping 금지, nav/button44·long list/recovery reachability는 Task3에 계약으로 전달한다.
4. 메뉴 문서 다섯 구성 유지·한계 기록, diffcheck, 자기 리뷰·source commit. Task2 report에 source SHA·API 변경·원 RED/GREEN·누락/원인/검증 cohort를 기록한다.
5. 제품 변경은 이 작업 scope만; plan/status 수정·다른 agent 호출 금지.

**검증:** 변경 직접 selection/ManualExecution/Control/Shell/Viewport suites 필요한 case만. 기존 전체 suite·이전20건·HIL 반복 없음.

### Task 3: 한정 QA와 실제 UI/UX 점검

**소유:** 기존 앱 `UI/UX 디자이너` 세션이 이번 ignored SDD 안에 최소 Playwright 측정 harness를 준비하고 Task2 최종 SHA 인계 후 최대6 actual case·PNG/geometry와 UI/UX 검토를 수행한다. 제품/기존 test는 읽기 전용이고 source selector 미확정 동안 common 수집부만 준비한다. 증거는 총괄이 영구 docs/assets/map-workspace-comments-2026-10-12로 취합한다. 제품 수리는 원 페이지 owner로 되돌린다.

- 실제 renderer·pointer로 PC1194×1227 monitoring middle drag/left click/no area, same-row toolbar, detail 전후 rect/camera 동일·overlay ~half/body scroll/wheel isolation/closefocus.
- 320×600·390×600·390×844 control light/dark 중 필요한 대표조합, 717×1227 mapdominant/PCemptyfull, mobile marker-origin swipe선택불변/다음tap, 내부selectedlonglist끝, overlay/More닫기/focus·invalid31/Apply 안전·오류/복구접근, document scroll0/nav가림0/44px 모두 실측한다.
- 최소 unique 6case 목표, 필요한 source-scoped 재실행만. keyboard/visualViewport resize 한정case로 확인하며 실제 OSkeyboard/HIL 주장 금지. additional POST0 scopefake 계수.
- 타입/UI 정책·ui-check/build 한 번 최종제품SHA. 기존 SettingsShell baselinefailure·bundlewarning는 이번 실패와 구분, unrelatedfix 금지.
- QA owned 새 port만(start전free확인), 기존5173/4000/63200 중단/변경금지. route fake는 fake로 명시. raw JSON/PNG/원fail을 보존, 같은case재시도와unique counts 구분.
- UX actualreport는 overlap/gap/hit/clipping/mapbox/exposedarea·기능가용성·sourcecohort·한계를 포함한다. browser를 동시에 조작하지 않는다.

### Task 4: 독립 검토·로컬 통합

- 총괄은 root role로 writing-plans/status를 결과만 취합하여 업데이트한다. 제품 직접 수정하지 않는다.
- base f31e56fa..최종제품SHA package를 기존 independentreviewer에게 전달한다. 요구사항/spec·quality/safety를 한 번 통합 검토, finding은 원owner수리 후 영향범위만 재검토한다.
- 검증·UX·review 완료 후 fresh MAIN status/HEAD 확인. unchanged면 승인된 로컬 merge, advanced면 기존 변경 보존 통합tree만 새 한정검증. conflict에 의미결정 필요 시 사용자 문의.
- remote/push/PR/deploy 없음. 완료 직전 원자료/ledger를 정확한 별도backup경로로 복사해diff로 확인. 합쳐진 이번cleanworktree/branch만 recoverablecleanup. final은실제mergeSHA·검증범위/한계 및 모든 Ruling을명시한다.

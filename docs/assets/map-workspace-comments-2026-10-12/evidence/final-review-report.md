# 지도 작업 공간 C1–8 — 독립 source review

상태: **source 및 최종 정적 증거 검토 완료 / 실제 UI·UX 대기**. 이전29/20건 리뷰가 아닌 신규 작업이다.

- BASE `f31e56fadd27d63f96824bad2ea2c4ef71581b62`, HEAD `bea0dacb07d3d5c8e0b14e4659874da12ed6b2d4`.
- `final-review-brief.md`, 제공 full-range diff의 제품/테스트/문서 변경, 적용 AGENTS, 직접 필요한 common UI·gesture·session-status·command consumers와 두 페이지 인수 보고서를 읽었다. 검토 종료 시 HEAD 동일/tracked clean.
- `superpowers:requesting-code-review`의 단일 독립 reviewer 형식으로 검토했다. 테스트·브라우저·서버·새 subagent/chat·다른 세션 메시지 실행0. 제품/test/docs/index/HEAD/branch 수정0; 이 ignored 보고서만 작성했다.

## Strengths

- 모니터링은 기존 `manual-cad`와 `interactionPolicy="pan"`을 명시적으로 조합한다. 공통 gesture 분기상 좌버튼은 marker 후보, middle/Space/touch는 pan이며 area callback을 추가하지 않는다. 기존 단일 fixture owner, pinch/cancel/keyboard, 카메라 memory 및 FloorScene 소스는 유지된다.
- 순수 valid stale만 `announce:false`로 기존 현재 화면 상태에 등록한다. SessionStatusProvider의 fingerprint/announce 처리와 대조했으며, 오류·invalid/future 분기는 계속 알린다. incident/unread/API 생산자를 추가하지 않았다.
- 모니터링 상세는 기존 OperationMapPanel의 relative body 안에 out-of-flow aside로 배치한다. viewport/renderer를 다른 부모로 옮기지 않고 body scroll과 고정 header를 분리하며, 지도 wheel listener의 자손이 아닌 sibling으로 둔다. scope-aware 자동 제거, 기존 close/focus fallback, 선택별 scroll 기억 경로를 유지한다. 이 구조적 판단은 실제 map rect·wheel 통과 주장과 구분한다.
- loading/error/main h1을 sr-only로 유지하고, 갱신 시각은 기존 strict timezone formatter의 결과를 축약한다. 원 datetime/전체 접근 가능한 정보와 실패 안내를 보존한다.
- 수동 제어의 단일 query/명령 소유자, frozen 요청·UUID·recovery callback은 그대로다. More는 별도 실행 owner를 만들지 않고 기존 feedback/history 노드를 mounted 상태로 접는다. 새 summary는 empty picker보다 저장/검증/명령 조회 실패·불확정·진행 상태를 우선하며, 실제 consumer RED 후 권한/오류 누락을 보강했다.
- raw 숫자 검증, invalid blur/Enter 복귀, 첫 invalid Apply 차단 및 명시 Apply 로직은 이동 후에도 같은 컴포넌트에 남는다. 세션/현장 key, 선택 패널의 주체/현장/층/선택방식 key, default false compact props가 수명/기본 소비자 경계를 명시한다.
- finite shell은 권한이 확인된 manual-active 보고를 받아서만 활성화한다. 일정/이벤트/그룹/editor 흐름은 기존 분기이며, optional viewport chrome은 manual mobile만 소비한다. 데이터/토큰/API/DB/의존성 계약 확장 없이 기존 UI를 재사용했다.
- 두 메뉴 문서는 다섯 구성과 실제 브라우저/물리 HIL 미검증 한계를 기록한다. class assertion을 소비자 동작/DOM identity assertion으로 바꾼 테스트를 actual geometry의 대체물로 주장하지 않는다.

## Issues

### Critical (Must Fix)

확정된 source finding 없음.

### Important (Should Fix)

확정된 source finding 없음. 아래 실제 기하·입력 관문은 열려 있으며, 실행되지 않은 관문을 통과로 간주하지 않는다.

### Minor (Nice to Have)

별도 nitpick 없음.

## 실제 QA에서 반드시 판정할 source risk — 아직 확정 결함 아님

1. **작아진 rounded hit 영역.** `apps/web/src/features/floor-map/FloorMapViewport.tsx:715`–719와 `apps/web/src/features/control/target-selection/TargetSelectionToolbar.tsx:47`의 compact action은52px에서44px로 줄지만 공통 Button의 rounded-control을 유지한다.44×44 bounding box만으로 연속44px hit를 증명할 수 없다. 현재 소스에서 corner hit 감소가 예상되므로 기존 모바일 case의 실제 elementFromPoint/continuous44 검사로 판정해야 한다. 실패하면 공통 기본 토큰을 바꾸지 말고 해당 opt-in hit 영역만 최소 수정한다.
2. **가로 실행행의 slider endpoint.** `apps/web/src/features/control/ManualExecutionPanel.tsx:72`의 gap1 행에 기존52px thumb를 가진 Slider가 들어간다(`components/ui/fields/Slider.tsx:30`).0/100 끝 위치에서 숫자/Apply와 thumb hit 영역이 겹치는지는 실제 paint/hit를 확인해야 한다. 기존 모바일 case에 endpoint와 Apply 실제 hit를 포함하며, 화면을 보지 않고 결함 또는 통과로 단정하지 않는다.
3. **유한 높이의 모든 상태.** compact canvas의 강제240 minimum이 opt-in에서 제거됐으므로 남은 높이·document scroll0·지도 우세·240 목표는 source만으로 확정할 수 없다.320/390 short viewport에서 selected list와 More 동시 확장, floor/group 선택, 긴 오류/복구 마지막 action, nav reserve와 visualViewport 축소를 기존 계획6case 안에서 실측해야 한다. CSS overflow-hidden으로 성공을 만드는 수리는 승인하지 않는다.
4. **모니터링 하단 상세.** PC/mobile 실제 overlay ratio, 열기 전후 map rect/camera/renderer identity, 내부 scroll 끝/닫기 hit, wheel 시 zoom 불변과 지도 뒤편 상호작용을 실제 입력으로 확인해야 한다. JSDOM에서 할당한 scrollTop/marker hit rectangle은 이 증거가 아니다.

위1–2는 총괄에 미리 전달한 구체적 QA 관찰점이다. 새로운 case 수/추가 전체 실행을 요구하지 않으며, 실패가 나오면 원 페이지 담당의 scoped 수정 후 이 seat가 delta만 재검토한다.

## 검증 증거와 cohort

- 모니터링 페이지 인수 시 product `ac323a3d` 동일 소스에서 직접2suite **127PASS** (`FloorMap17 + MonitoringView110`,18.14s). 보고서와 원 log tail을 확인했다. 이후 제어가 공통 viewport의 opt-in 표현을 추가한 전체HEAD에서 이127개를 재실행했다고 주장하지 않는다.
- 제어 최종 제품 직접 선택 **5files/41PASS/275비선택**(4.75s). 이후 scene/surface non-null identity 보강2개는 제품 변경0인 같은41 중 두 케이스 국소 재검사(2PASS/209비선택,3.32s)이며43개로 합산하지 않는다. identity 실행 exit 원문 누락은 보고서대로 유지한다.
- 중간85/68 및 원 RED/중간 matcher 실패는 최종 고유/전체 PASS에 더하지 않는다. 직접41/127을 단일최종HEAD 일괄168PASS로 표현하지 않는다.
- 페이지 담당 타입exit0/UI existing0/new0는 해당 source cohort 보고다. 추가 handoff에서 HEAD `bea0dacb`의 `final-ui-policy.log` 원문79PASS/0FAIL과 `final-build.log`의 `tsc --noEmit && vite build` 성공을 직접 확인했다(총괄 명령exit0). main932.47kB 및 >500kB 경고는 유지한다. 별도 final ui-check 실행을 이 두 로그에서 증명한다고 확대하지 않는다.
- 이번 actual UI·UX6case는 이 source review 시점에 아직 미실행이다. 실제 geometry/native pointer/OSkeyboard/HIL/전체Web 완료 주장은 없다.

## Declined to judge — executor ruling 수용

총괄이 아래6개를 기존 승인 범위/Ruling1과 일치하는 경계로 각각 수용했다. 제거 UI의 접근성·명령 수명은 계속 필수 검토/QA 대상이며, 새 실패를 baseline으로 덮지 않는다. MAIN/backup/cleanup은 총괄 실행 후 실제 증거로만 판정한다.

- 이전29/20건 및 기존 대형 행렬의 재검토/재실행: 이번 신규8건 변경과 별개이며 과거 증거를 현재 cohort에 합산하지 않는다.
- API/DB/장비/서버 incident 설계·다른 세션 장비 업무·원격 배포: 이번 UI 소유 범위 밖이고 관련 제품 변경이 없다. 실제 hardware 실행/안전 검증을 이 UI 리뷰로 대체하지 않는다.
- 전체Web/HIL/native WebView/GPU/물리 OS keyboard 및 모든 viewport/theme 조합: 사용자 LEAN 관문 밖이다. 계획된 실제6case와 직접 source/cohort 증거만 판정한다.
- 기존 SettingsShell baseline failure와 기존 chunk warning 수리: 변경 밖 기존 한계다. 새 실패를 같은 이유로 덮거나 전체PASS로 표시하지 않는다.
- 제거한 보이는 제목·모바일 별도 modal·분리된 desktop aside·항상 보이던 부가 실행 UI의 복구: 이번 명시된 UI 변경이다. nonmodal/More 접근성과 원 command 수명은 계속 검토/QA 대상이며 제거 자체를 결함으로 만들지 않는다.
- MAIN 반영·backup·cleanup 실행: 총괄의 최종 검증/권한/상태 확인 후 작업이며 이 read-only source review가 미래 실행을 인증하지 않는다.

## Assessment (source checkpoint)

**Ready to merge? No — 실제 UI·UX 관문 대기.**

읽은 소스에서 확정된 Critical/Important 회귀는 없지만, 이번 핵심 요구인 유한 높이·지도 노출·44px 실제 hit와 overlay/native interaction은 직접 unit/class만으로 충족됐다고 볼 수 없다. 같은 seat에서 후속 원 증거 및 필요 수정 delta만 확인한 뒤 최종 판정을 갱신한다.

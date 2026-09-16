# 제어 맵 중심 대상 선택 설계

기준일: 2026-09-16

## 1. 결정 요약

수동 제어, 스케줄 제어, 이벤트 제어와 구역 관리의 조명 선택을 **맵 중심 공통 선택기**로 통합한다. PC에서는 맵을 기본 작업 영역으로 유지하고 우측 요약 패널을 함께 보여준다. 모바일에서는 맵을 먼저 보여주고 선택 요약과 실행 폼을 접근 가능한 bottom sheet로 제공한다. 이름 검색, 미배치 조명, 키보드·스크린리더 조작을 위해 목록은 제거하지 않고 보조 drawer 또는 full-height sheet로 유지한다.

최종 배치 결정은 다음과 같다.

- 수동 제어 PC: 맵 상시 노출 + 우측 선택/밝기 패널
- 스케줄·이벤트 PC: 현재 설정 dialog 안의 전체 화면 대상 선택 단계
- 모바일 공통: 맵 + 접고 펼칠 수 있는 bottom sheet + 고정 실행 버튼
- 구역 생성·수정: 같은 맵 선택기의 편집 모드
- 모니터링과 제어: 맵 viewport와 scene 렌더링을 공유하되, 각 메뉴의 선택 상태와 업무 규칙은 분리

이 설계는 UI를 PC 맵과 모바일 목록의 두 구현으로 나누지 않는다. 하나의 선택 상태와 검증 결과를 맵, 목록, 요약 패널이 동시에 소비한다.

## 2. 배경과 현재 상태

현재 `ControlTargetPicker`는 `fixtures | floor | group` 모드를 제공하지만 조명 개별·다중 선택은 목록이 중심이다. 사용자는 이름과 상태만으로 실제 위치를 추론해야 한다. 모니터링의 `FloorMap`과 `FloorScene`은 도면, 배치 조명, 상태 표현, 이동과 확대·축소를 이미 제공하지만 단일 `selectedFixtureId` 계약만 지원한다.

수동 제어는 대상 picker, 명령 이력과 밝기 패널을 한 화면에 배치한다. 스케줄과 이벤트 dialog는 별도 대상 선택 view에서 같은 목록 picker를 사용한다. 구역 관리 dialog 역시 목록에서 같은 층·같은 gateway 조명을 선택한다.

서버의 실제 저장 의미는 화면에서 명확히 표현해야 한다.

- 수동 제어의 fixture, floor, group target은 실행 시점 명령 target으로 사용한다.
- 스케줄은 저장할 때 target을 fixture ID 집합으로 해석해 `LightingScheduleFixture` snapshot으로 저장한다.
- 이벤트는 source와 target을 각각 fixture ID 집합으로 저장한다.
- 따라서 스케줄·이벤트에서 저장 구역을 선택해도 이후 구역 멤버 변경이 기존 자동화 규칙에 자동 반영되지는 않는다. UI는 “현재 N개 조명을 저장”한다고 안내하고 자동 반영을 암시하지 않는다.

## 3. 목표와 비목표

### 3.1 목표

- 사용자가 도면에서 실제 위치를 확인하며 조명을 직접 선택한다.
- 개별 클릭, 명시적인 영역 선택, 저장 구역과 층 전체 선택을 제공한다.
- 선택한 조명을 새 구역으로 저장하고 기존 구역을 같은 화면에서 수정한다.
- PC와 모바일에서 맵, 목록과 선택 요약이 하나의 상태로 즉시 동기화된다.
- 현재 제어 가능 여부, gateway 경계와 Mesh 준비 상태를 선택 전에 이해할 수 있다.
- 모바일 390×844와 320×740에서 한 손 조작, 44×44px 터치 영역, safe area와 하단 내비게이션을 보장한다.
- 기존 semantic token, 공통 UI component, spacing과 typography 정책을 준수한다.
- PC 제어 페이지에 문서 수준 가로·세로 스크롤을 만들지 않고 필요한 패널 내부만 스크롤한다.

### 3.2 비목표

- 지도에서 조명의 물리 좌표를 편집하지 않는다. 좌표 변경은 기존 floor editor 책임이다.
- 자유형 polygon 구역, 중첩 구역의 도형 자체 저장, 실시간 협업 편집을 추가하지 않는다.
- 자동화 규칙이 저장 구역 멤버 변경을 자동 추적하도록 DB 모델을 변경하지 않는다.
- 현재 최대 fixture 선택 수, 구역당 1~100개, 같은 gateway 제약을 이번 UI 변경만으로 제거하지 않는다.
- 실제 BLE Mesh, MQTT 또는 firmware 전송 규칙을 변경하지 않는다.

## 4. 사용자 경험

### 4.1 공통 선택 방식

선택기 상단에는 `직접 선택`, `저장된 구역`, `층 전체` 모드를 둔다. 직접 선택에서는 marker 클릭 또는 명시적인 영역 선택으로 fixture 집합을 변경한다. 저장된 구역에서는 구역 경계와 포함 marker를 함께 강조하고, 층 전체에서는 해당 층 marker를 모두 강조한다.

검색과 목록은 맵 위에 상시 큰 영역으로 두지 않는다. PC에서는 `목록` 버튼으로 drawer를 열고, 모바일에서는 full-height sheet를 연다. 검색 결과를 선택하면 맵이 해당 marker 위치로 이동하고 같은 선택 상태를 갱신한다. 맵에 배치되지 않은 fixture는 목록에서 `미배치`로 표시하며 위치 확인이 불가능하다는 사실을 숨기지 않는다.

marker의 visible dot은 기존 크기를 유지할 수 있지만 pointer hit target은 fine pointer 최소 32px, coarse pointer 약 44px로 확장한다. 상태는 색상만 사용하지 않고 label, pattern 또는 icon과 함께 제공한다.

### 4.2 수동 제어 PC

페이지의 남은 높이를 `minmax(0, 1fr)` 맵 영역이 사용한다. 상단에는 선택 방식, 층, 검색과 목록 진입만 둔다. 우측 고정 패널은 다음 순서다.

1. 선택 수와 제어 가능 여부
2. 선택 대상 요약과 개별 제거
3. 밝기 slider, 숫자 입력과 preset
4. `선택을 새 구역으로 저장`
5. `N개 조명에 밝기 적용`

명령 이력은 맵 높이를 상시 줄이지 않도록 접힌 하단 drawer 또는 별도 진입 버튼으로 제공한다. 명령 처리 중 lock, 재전송, 상태 확인과 feedback 계약은 기존 `ControlView` 동작을 유지한다.

### 4.3 스케줄·이벤트 PC

대상 선택은 dialog 안의 전체 화면 단계로 연다. 좌측 또는 중앙은 맵, 우측은 선택 요약이며 dialog footer에 취소와 선택 완료를 둔다. dialog는 viewport를 넘지 않고 맵과 요약 영역만 내부 크기를 계산한다.

스케줄은 `시간 → 대상 → 밝기` 흐름으로 표시한다. 이벤트는 `감지 조명 → 제어 조명 → 동작 설정` 흐름으로 표시한다. 감지 조명 단계는 vehicle event source 자격이 있는 fixture만 활성화하고 group 또는 floor 모드를 제공하지 않는다. 제어 조명 단계는 직접 선택을 기본으로 하며 저장 구역 또는 층 전체를 선택하면 현재 멤버 fixture ID 집합으로 변환해 기존 이벤트 API에 제출한다.

스케줄·이벤트 모두 저장 직전에 resolved fixture 수와 gateway를 다시 표시한다. 이후 구역 멤버 변경은 자동 반영되지 않으며 규칙 편집에서 대상을 다시 선택해야 한다.

### 4.4 구역 생성·수정 PC

구역 편집기는 `이동`, `클릭 선택`, `영역 선택`, `선택 제외` 도구를 제공한다. floor와 gateway를 먼저 선택하거나 첫 fixture 선택으로 경계를 잠근다. 경계 밖 fixture는 낮은 opacity와 선택 불가 사유를 제공한다.

우측 패널은 구역 이름, 선택 수, 정상·제어 불가 수, gateway와 Mesh 구성 예정 상태를 표시한다. 저장 후 Mesh control group이 `ready`가 되기 전에는 해당 구역을 제어 대상으로 사용할 수 없다는 안내를 저장 전후에 모두 제공한다.

수정 화면은 기존 멤버, 추가 예정과 제거 예정 상태를 색상 외 pattern과 label로 구분한다. 저장 요청은 전체 replacement fixture ID 집합을 보내 기존 backend transaction과 Mesh 재구성 규칙을 유지한다.

## 5. 모바일 설계

### 5.1 화면 구조

760px 미만에서는 좌우 분할을 사용하지 않는다. 화면 순서는 다음으로 고정한다.

1. compact app header
2. 수동·스케줄·이벤트 메뉴
3. 선택 방식과 floor selector
4. 맵
5. 선택 요약 bottom sheet
6. 공통 mobile bottom navigation

수동 제어의 bottom sheet는 기본 peek/half 상태에서 선택 수, 제어 가능 여부, 밝기와 실행 버튼을 보여준다. sheet handle만 제공하지 않고 “선택 대상 펼치기/접기”라는 접근 가능한 button을 제공한다. full 상태에서는 선택 fixture 목록과 구역 저장 action을 보여준다.

스케줄·이벤트 대상 선택은 route 수준 화면처럼 보이는 full-screen dialog를 사용한다. 상단 back action, 단계 표시, 맵, 선택 요약과 완료 action 순서로 구성하고 underlying page는 스크롤하거나 포커스를 받지 않는다.

목록은 맵 위 작은 overlay가 아니라 full-height sheet로 열어 검색 field, filter, fixture row와 선택 완료 action을 안정적으로 제공한다.

### 5.2 터치 gesture

맵 pan과 영역 선택이 같은 drag gesture를 경쟁하지 않도록 `이동`, `선택`, `영역`을 명시적인 44px 이상 도구로 제공한다.

- 이동 모드: 한 손가락 drag로 pan, pinch로 zoom
- 선택 모드: marker tap으로 추가·해제, 빈 공간 drag는 아무 동작도 하지 않음
- 영역 모드: 한 손가락 drag로 rectangle selection, pinch zoom 유지
- 선택 제외: 별도 mode 또는 선택 marker 재탭으로 제거

두 손가락 pinch 확대·축소는 이동·선택·영역 모드 모두에서 항상 우선한다. 두 pointer 사이 거리 비율로 zoom을 계산하고 두 pointer의 중점을 anchor로 사용해 사용자가 보고 있던 위치가 손가락 아래에 유지되게 한다. pinch가 시작되면 진행 중인 pan 또는 영역 선택을 취소하고, 한 손가락이 떨어진 뒤 남은 pointer가 갑자기 pan으로 이어지지 않도록 gesture 기준점을 초기화한다. 기존 zoom 하한·상한과 화면 맞춤 동작은 유지한다.

long press나 hover를 필수 동작으로 사용하지 않는다. 처음 영역 모드를 사용할 때 “두 손가락으로 확대·축소”를 포함한 짧은 inline 도움말을 제공하되 다시 보지 않아도 모든 action label이 이해 가능해야 한다.

### 5.3 모바일 사용성 규칙

- 모든 interactive target은 최소 44×44px이며 marker visible dot과 hit target을 분리한다.
- editable field text는 최소 16px로 유지해 mobile browser 자동 확대를 방지한다.
- 주요 실행 버튼은 bottom navigation과 `safe-area-inset-bottom` 위에 위치한다.
- 320px에서 toolbar label이 한 글자씩 줄바꿈되지 않게 3개 이하로 제한하고, 필요하면 icon+짧은 label을 사용한다.
- sheet 확장, keyboard 표시와 validation message 추가 시 실행 버튼이 화면 밖으로 밀리지 않게 action 영역을 sheet footer가 소유한다.
- 문서 수준 가로 overflow는 허용하지 않는다. 세로 scroll은 full sheet 또는 목록 내부에서만 발생한다.
- device orientation 변경 뒤 map fit을 다시 계산하지만 현재 floor와 selection은 보존한다.

## 6. 컴포넌트 구조

### 6.1 공통 맵 계층

```text
FloorMapViewport
├─ pan / zoom / fit / resize
├─ pointer capability adaptation
└─ FloorScene
   ├─ map objects and floor plan
   ├─ fixture status presentation
   └─ multi-selection marker interaction
```

`FloorMapViewport`는 모니터링의 이동·확대·축소 구현을 추출한 공통 primitive다. `FloorScene`은 `selectedFixtureId` 하나 대신 read-only fixture ID collection과 `onToggleFixture`를 받도록 확장한다. 모니터링은 단일 선택 adapter를 사용하므로 기존 상세 패널 동작을 유지한다.

### 6.2 제어 선택 계층

```text
SpatialTargetSelector
├─ TargetSelectionToolbar
├─ FloorMapViewport
├─ SelectionSummaryPanel / mobile sheet
├─ FixtureSelectionDrawer
└─ selection policy adapter
   ├─ manual
   ├─ schedule
   ├─ vehicle source
   ├─ vehicle target
   └─ fixture group editor
```

`SpatialTargetSelector`는 API client를 직접 호출하지 않는다. dashboard와 floor map snapshot, 현재 selection, allowed modes, fixture eligibility, selection limit, interaction mode와 `onChange`를 받는다. 업무별 policy adapter가 선택 가능 여부와 reason을 계산한다.

`SelectionSummaryPanel`은 선택 집합, resolved fixture, blocked fixture와 delivery/readiness 정보를 표시한다. 밝기 form이나 구역 이름 form은 summary component 안에 넣지 않고 수동 제어와 구역 편집 feature가 composition한다.

### 6.3 선택 상태

기존 `ControlSelection` 의미를 유지한다.

```ts
type ControlSelection =
  | { mode: "fixtures"; fixtureIds: string[] }
  | { mode: "floor"; floorId: string }
  | { mode: "group"; groupId: string };
```

렌더링과 제출 전에는 별도 resolver가 다음 결과를 만든다.

```ts
interface ResolvedControlSelection {
  selection: ControlSelection;
  fixtureIds: string[];
  fixtureCount: number;
  gatewayIds: string[];
  blockedFixtureIds: string[];
  available: boolean;
  unavailableReason: string | null;
}
```

UI state는 source selection과 resolved snapshot을 혼합하지 않는다. fixture ID는 항상 안정 정렬하고 중복을 제거한다. selection mode 전환은 의도하지 않은 대상 합집합을 만들지 않도록 새 mode의 빈 상태로 시작하며, 전환 전에 현재 선택을 버린다는 사실을 명확히 보여준다.

## 7. 데이터와 서버 계약

### 7.1 API 유지

첫 구현에서는 수동 command, schedule, vehicle event와 fixture group API payload를 변경하지 않는다. map UI는 기존 payload를 만드는 adapter만 교체한다.

- manual: `controlSelectionToDimmingTarget`
- schedule: 기존 `DimmingTarget` 제출 후 server가 fixture snapshot 저장
- vehicle source: eligible `sourceFixtureIds`
- vehicle target: group/floor selection을 resolved `targetFixtureIds`로 변환
- group editor: 기존 name, floorId, gatewayId, fixtureIds 전체 replacement

DB schema 변경은 없다. 구현 중 API 또는 schema 변경이 실제로 필요해지면 이 설계를 수정하고 `docs/database-schema.md`를 함께 갱신한 뒤 별도 승인을 받는다.

### 7.2 경계와 한도

- 직접 선택의 현재 최대 1,000개 한도는 유지한다.
- 저장 구역은 같은 floor, 같은 gateway의 unique fixture 1~100개를 유지한다.
- 현재 command fan-out이 단일 gateway 경계이므로 수동 직접 선택도 첫 fixture의 gateway로 범위를 잠그고, 여러 gateway를 포함한 floor 전체는 선택 완료를 차단한다.
- schedule과 vehicle event는 server의 single-gateway 검증을 UI에서도 사전 표현한다.
- floor 또는 group target이 여러 gateway를 포함하거나 준비되지 않았으면 선택 완료 action을 비활성화하고 구체적인 사유를 표시한다.
- source와 target을 합쳤을 때 gateway가 달라지는 vehicle event 조합도 제출 전에 차단한다.

서버가 최종 권한과 membership을 다시 검증하는 fail-closed 규칙은 유지하며 UI 검증을 보안 경계로 간주하지 않는다.

## 8. 오류와 동시 변경 처리

- floor map snapshot이 없으면 목록 fallback과 “도면 미등록” 안내를 제공한다.
- fixture가 미배치면 목록에서 선택 가능 여부와 위치 미확인 상태를 표시한다.
- 선택 중 dashboard refresh로 fixture가 삭제되거나 권한·상태가 바뀌면 invalid selection을 자동 숨기지 않고 요약에서 오류로 표시한다.
- group membership 또는 Mesh status가 바뀌면 선택 완료 시 최신 resolver 결과를 사용한다.
- 선택된 floor snapshot fetch 실패 시 기존 snapshot을 유지하고 refresh feedback을 표시한다.
- 구역 저장이 `configuring`이면 성공 메시지와 설정 중 상태를 표시하고 즉시 제어 가능하다고 안내하지 않는다.
- backend 4xx는 validation 또는 권한 문제로, network/5xx는 재시도 가능한 전송 문제로 구분한다.

## 9. 접근성

- 맵은 `region`과 floor 이름을 갖고 marker는 fixture 이름, 상태, 밝기와 선택 상태를 accessible name/state로 제공한다.
- keyboard 사용자는 marker tab 이동, Space/Enter 선택과 목록 fallback을 모두 사용할 수 있다.
- 선택 수 변경은 `aria-live="polite"`로 요약만 알리고 pan/zoom 중 매 frame을 알리지 않는다.
- 선택 불가 fixture는 disabled 상태만 두지 않고 목록과 요약에서 사유 text를 제공한다.
- dialog와 mobile sheet는 공통 React Aria overlay/focus primitive를 사용하며 닫을 때 원 trigger로 focus를 복귀한다.
- 상태와 신규·제거 예정 의미는 색상 외 text, icon 또는 pattern을 함께 사용한다.
- `prefers-reduced-motion`에서는 sheet와 map transition을 최소화한다.

## 10. 디자인 시스템 적용

- `apps/web/src/styles/theme.css`의 semantic token만 사용한다.
- spacing은 `docs/ui-spacing.md`의 승인 scale만 사용한다.
- 신규 arbitrary spacing, color, typography와 page 전용 breakpoint를 추가하지 않는다.
- `compact=47.5rem`, `tablet=64rem` breakpoint를 사용한다.
- Button, IconButton, SelectBox, SearchField, Slider, TextField, ModalDialog와 SidePanel 등 기존 공통 component를 사용한다.
- runtime marker position, zoom geometry와 touch hit area 계산만 문서화된 canvas/geometry 예외로 둔다.
- 모바일 shell의 `pb-shell-navigation-safe`, `h-shell-navigation-safe`, `pb-safe-area-bottom` utility를 재사용한다.

## 11. 테스트 전략

### 11.1 단위 테스트

- fixture toggle, stable sort, 중복 제거와 1,000개 selection limit
- floor/group resolution과 unavailable reason
- vehicle source eligibility, source+target single-gateway 검증
- 같은 floor/gateway 구역 경계와 1~100개 검증
- mode 전환 시 stale selection 제거
- monitoring single-selection adapter 회귀
- schedule/event의 group selection이 현재 fixture snapshot으로 제출되는 계약

### 11.2 컴포넌트·접근성 테스트

- map marker accessible name, selected/disabled 상태와 keyboard toggle
- drawer와 bottom sheet focus containment, Escape/back, trigger focus 복귀
- selection count `aria-live`와 validation `role="alert"`
- coarse pointer에서 44×44px effective target
- 16px mobile form field text

### 11.3 Playwright

- 1440×900, 1024×768에서 PC 문서 스크롤 없이 맵과 우측 panel 내부 overflow만 동작
- 390×844, 320×740에서 가로 overflow 없음, bottom navigation과 action 겹침 없음
- marker 선택 → 목록 동기화 → 밝기 command payload
- 저장 구역 선택 → schedule fixture snapshot 저장
- event source/target 선택과 다른 gateway 차단
- map 직접 선택 → 새 구역 저장 → configuring → ready 표시
- 미배치 조명 목록 fallback
- orientation/resize 뒤 selection 보존과 map fit
- 이동·선택·영역 모드에서 두 pointer pinch의 중점 기준 zoom, zoom 한계와 pinch 종료 후 pan jump 방지

실제 BLE Mesh 전송, native WebView safe-area와 실제 touch gesture는 browser automation 결과만으로 완료 처리하지 않는다. Web software 검증 후 실제 모바일 기기와 gateway 환경의 수동/HIL 확인을 별도 기록한다.

## 12. 구현 단계

1. selection resolver와 policy adapter를 테스트 우선으로 정리한다.
2. 모니터링 `FloorMap`에서 공통 `FloorMapViewport`를 추출한다.
3. `FloorScene`의 복수 선택과 marker hit target을 구현한다.
4. `SpatialTargetSelector`, drawer, summary와 mobile sheet를 공통 component로 구현한다.
5. 수동 제어 PC·모바일 배치를 전환한다.
6. 스케줄 대상 선택을 전환한다.
7. 이벤트 source와 target 선택을 전환한다.
8. 구역 생성·수정을 맵 편집 방식으로 전환한다.
9. unit, accessibility, responsive와 production browser 회귀를 실행한다.
10. `docs/menus/control.md`, 필요 시 `docs/menus/monitoring.md`와 `docs/ui-spacing.md`를 실제 구현 상태로 갱신한다.

## 13. 완료 기준

1. 수동·스케줄·이벤트와 구역 관리가 같은 맵 선택 primitive를 사용한다.
2. PC에서 맵이 기본 선택 수단이고 페이지 문서 스크롤이 생기지 않는다.
3. 모바일에서 tap, 명시적 gesture mode, 모든 mode의 두 손가락 pinch zoom, bottom sheet와 목록 fallback으로 모든 선택과 실행이 가능하다.
4. 320px와 390px에서 horizontal overflow, clipping과 action/navigation overlap이 없다.
5. 스케줄·이벤트의 구역 선택은 현재 fixture snapshot 저장 의미를 정확히 안내한다.
6. 선택 가능 여부와 server fail-closed 검증이 일치한다.
7. 기존 수동 명령 안전성, 스케줄·이벤트 실행과 Mesh 구역 lifecycle 회귀가 통과한다.
8. UI policy, typecheck, Web unit, build와 focused/전체 Chromium 검증이 통과한다.
9. 관련 메뉴 문서가 구현과 검증 한계를 함께 기록한다.

## 14. 시각 예시

- PC 수동 제어, 스케줄·이벤트 대상 선택과 구역 만들기: thread visualization의 `control-map-selection-mockup.html`
- 모바일 수동 제어, 스케줄·이벤트 대상 선택과 구역 만들기: thread visualization의 `control-map-mobile-mockups.html`

시각 예시는 정보 구조와 상호작용을 확인하기 위한 개념 시안이다. 구현은 이 문서의 semantic token, 공통 component, breakpoint와 접근성 규칙을 우선한다.

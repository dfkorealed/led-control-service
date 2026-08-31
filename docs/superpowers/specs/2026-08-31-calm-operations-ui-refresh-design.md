# Calm Operations 고객 UI 전면 개선 설계

작성일: 2026-08-31

## 1. 목표

고객용 `모니터링`, `제어`, `통계`, `설정` 화면을 하나의 일관된 디자인 시스템으로 재구성한다. 승인된 A안인 `Calm Operations`를 기준으로 정보 위계, 상태 식별, 아이콘, 여백과 상호작용을 개선한다.

이번 작업은 현재 구현된 기능과 API 계약을 유지하는 시각·정보 구조 개선이다. 새 백엔드 기능, 새 데이터 모델, Gateway 제어 기능을 추가하지 않는다.

## 2. 디자인 원칙

### 2.1 핵심 원칙

- 사용자는 각 화면에 진입한 뒤 5초 안에 현재 상태, 주의가 필요한 항목, 다음 행동을 파악할 수 있어야 한다.
- 흰색과 옅은 중성 배경을 기본으로 하고 파란색은 선택, 링크, 주요 실행에만 사용한다.
- 상태는 색상만으로 표현하지 않고 아이콘, 텍스트, 형태를 함께 사용한다.
- 장식보다 운영 데이터와 실제 행동을 우선한다.
- 같은 의미의 카드, 버튼, 배지, 입력, 빈 상태는 모든 메뉴에서 같은 컴포넌트와 토큰을 사용한다.
- 토스 계열 제품의 명확한 위계와 충분한 여백을 참고하되 로고, 고유 자산, 화면 구성을 복제하지 않는다.

### 2.2 시각 토큰

| 분류 | 기준 |
| --- | --- |
| 배경 | 앱 배경은 옅은 회색, 주요 작업 영역은 흰색 |
| Primary | 접근 가능한 명도의 royal blue, 주요 행동과 활성 상태에 제한 |
| Text | 강한 본문, 보조 본문, 비활성 본문의 3단계 중성색 |
| Status | 정상 green, 주의 amber, 장애 red, 오프라인 gray |
| Border | 중성 1px border를 기본으로 사용 |
| Radius | 작은 입력 10~12px, 카드와 패널 16px, pill은 완전한 원형 |
| Shadow | 메뉴 popover와 modal처럼 깊이 구분이 필요한 경우에만 사용 |
| Spacing | 4px 배수 체계, 화면·섹션은 24~32px, 카드 내부는 16~24px |
| Icon | `lucide-react` outline 아이콘, 기본 18~20px, 텍스트와 함께 사용 |
| Motion | hover/focus 120~180ms, 상태 변화는 `prefers-reduced-motion` 존중 |

### 2.3 타이포그래피와 숫자

- 시스템 한글 sans-serif를 유지한다.
- 페이지 제목, 섹션 제목, 본문, 보조 문구의 크기와 굵기를 토큰으로 고정한다.
- 운영 수치에는 tabular number를 적용해 값 변화로 인한 흔들림을 줄인다.
- 단위는 수치보다 작게 표시하되 대비를 충분히 유지한다.
- eyebrow를 반복적으로 사용하지 않고, 문맥을 실제로 보완할 때만 사용한다.

## 3. 공통 애플리케이션 셸

### 3.1 데스크톱

- 좌측 주 내비게이션, 상단 현장 문맥 바, 중앙 콘텐츠 구조를 유지한다.
- 주 내비게이션은 아이콘과 텍스트를 함께 표시하고 현재 route를 pale blue 배경으로 구분한다.
- 상단에는 현재 현장, 현재 층 문맥, Gateway 연결 상태, 로그아웃을 배치한다.
- 현장과 층 정보는 실제 선택 상태만 표시하며 존재하지 않는 기능처럼 보이는 control을 만들지 않는다.
- 콘텐츠 최대 폭을 화면 성격에 따라 사용한다. 도면·대상 목록·차트처럼 넓이가 필요한 화면은 더 넓게, 폼은 읽기 좋은 폭으로 제한한다.

### 3.2 설정 서브메뉴

설정 화면 내부에 있던 별도 설정 사이드바를 제거한다. 설정 하위 route는 주 내비게이션의 `설정` 항목에서 노출한다.

- 데스크톱 pointer 환경에서는 `설정` 항목의 hover 또는 focus-within에서 popover 서브메뉴를 연다.
- `설정` 주 항목을 직접 누르면 `/settings`의 `설정 개요`로 이동한다.
- popover에는 현재 역할로 접근 가능한 항목만 표시한다.
  - admin: `설정 개요`, `도면 관리`, `비밀번호 변경`
  - viewer: `설정 개요`, `도면 관리`
- 서브메뉴를 누르면 기존 query string의 `siteId`와 기타 문맥을 유지해 해당 route로 이동한다.
- 현재 설정 하위 route가 활성화되어 있으면 주 메뉴의 `설정`과 해당 서브메뉴를 모두 활성 상태로 표시한다.
- pointer가 설정 항목과 popover 사이를 이동할 때 메뉴가 닫히지 않도록 하나의 hover boundary로 구성한다.
- Escape는 메뉴를 닫고 trigger로 focus를 되돌린다. 바깥 클릭과 실제 navigation도 메뉴를 닫는다.
- 키보드는 설정 링크에 focus하면 서브메뉴를 열고, Tab/Shift+Tab으로 링크 사이를 이동하며, Escape로 닫을 수 있어야 한다. Enter는 focus한 링크의 route로 이동한다.
- 모바일과 coarse pointer 환경에서는 hover에 의존하지 않는다. 하단 `설정` 탭을 누르면 동일한 역할별 하위 메뉴를 bottom sheet로 열고, 항목 선택 시 route로 이동한다. `설정 개요`도 sheet의 첫 항목으로 제공한다.
- 도면 편집 중 dirty guard는 기존 동작을 유지한다. 서브메뉴 이동도 일반 내부 navigation과 동일하게 저장하지 않은 변경 확인을 거친다.

### 3.3 반응형

- 760px 이하에서는 기존 하단 주 내비게이션 패턴을 유지한다.
- 화면 본문과 하단 내비게이션이 겹치지 않도록 safe-area 공간을 보존한다.
- KPI는 760px 이하에서 2열, 360px 이하에서 1열로 전환하고 주요 작업 패널은 760px 이하에서 1열로 전환한다.
- 표는 핵심 열을 우선하고 필요할 때 가로 스크롤을 제공한다. 정보를 잘라내지 않는다.
- modal은 작은 화면에서 화면 폭을 사용하는 dialog로, navigation popover는 bottom sheet로 전환한다.
- 320px 너비에서도 버튼과 텍스트가 겹치지 않아야 하며 터치 target은 최소 44px을 유지한다.

## 4. 공통 컴포넌트

`apps/web/src/components/ui` 아래에 재사용 가능한 UI primitive를 모은다. 기능별 복잡한 컴포넌트는 기존 feature 폴더에 유지한다.

- `Button`: primary, secondary, ghost, danger와 loading 상태
- `IconButton`: 접근 가능한 이름을 필수로 갖는 아이콘 버튼
- `Card`: 일반, 선택, 강조, danger 표면
- `StatusBadge`: icon + label + semantic tone
- `MetricCard`: label, value, unit, supporting text, optional status
- `SegmentedControl`: route나 mode 선택의 단일 패턴
- `PageHeader`: 제목, 설명, 보조 상태, actions
- `EmptyState`, `ErrorState`, `LoadingState`: 공통 피드백 패턴
- `SubmenuPopover`와 모바일 대응 메뉴: navigation disclosure

컴포넌트는 className 문자열 복제를 줄이고, 기존 DOM semantics와 accessible name을 보존한다. feature-specific 상태 머신이나 API 요청 로직을 primitive 안으로 이동하지 않는다.

## 5. 메뉴별 화면 설계

### 5.1 모니터링

- 현재의 설치 상태 guard, Gateway claim, 조명 등록 세션 복구와 등록 패널을 유지한다.
- 상단에는 층별 전체 조명, 정상, 점검 필요, 평균 밝기를 `MetricCard`로 표시한다.
- `fault`, 운영상 offline, provisioning 상태 대기를 서로 다른 icon + label로 구분한다.
- 수동 새로고침, 마지막 갱신 시각, 일부 실패 메시지를 한 영역에 정리한다.
- 도면을 가장 큰 시각 영역으로 유지하고 선택 조명 상세를 우측 패널에 배치한다.
- 선택 상세에는 현재 밝기, 정격 전력, 최근 수신, Health, 위치와 필요한 후속 행동을 위계화한다.
- 장애·오프라인 목록은 선택 조명 정보 아래의 상세 패널에 재사용 가능한 row로 표시한다.
- 등록 조명이 없는 상태는 admin의 실제 설치 다음 행동을 하나의 primary action으로 명확히 안내하고 viewer에는 읽기 전용 안내만 표시한다.

### 5.2 제어

- 제어 상단 mode tabs인 `수동 제어`, `스케줄 제어`, `차량 이벤트 제어`는 기존 ARIA tab semantics를 유지하고 공통 tab 스타일로 시각 통일한다.
- 수동 제어는 좌측 대상 선택과 우측 밝기 실행 패널 구조를 유지한다.
- 개별·다중, 층, 구역 선택과 검색·필터·최대 선택 개수, Mesh readiness 표시를 보존한다.
- 밝기 수치, slider, preset, 적용 버튼을 하나의 명확한 실행 흐름으로 구성한다.
- 명령 상태는 접수, MQTT 발행, Gateway 수신, 조명 적용과 terminal 결과를 단계형 status surface로 표시한다.
- 명령 진행 중 입력 잠금, 복구, 재조회, 불확실한 응답 재전송 규칙은 기존 로직을 변경하지 않는다.
- 스케줄과 차량 이벤트의 목록, 활성 상태, Gateway 동기화, 최근 실행·감지, 추가·수정·삭제 dialog를 A안 테이블·row·badge·button 규칙으로 통일한다.
- viewer는 조회 전용 상태를 page-level notice와 disabled action으로 명확히 구분한다.

### 5.3 통계

- 오늘, 이번 달, 올해 사용량과 비용을 동일한 `MetricCard` 체계로 표시한다.
- `available`, `partial`, `no_data`는 카드와 차트 모두 icon + label로 표현한다.
- 일별·월별 선택을 공통 segmented control로 통일한다.
- 차트, 비용 비교, 24시간 100% 기준과 예상 절감 정보를 하나의 읽기 순서로 배치한다.
- 상태 기반 추정, coverage, 마지막 집계 시각은 보조 설명으로 명확히 표시한다.
- summary 실패와 series 실패를 분리해 기존 부분 복구 동작을 유지한다.
- 데이터가 없는 기간은 0으로 오해되지 않도록 선을 연결하지 않고 empty state를 사용한다.

### 5.4 설정

- 화면 내부 설정 사이드바는 제거하고 본문은 선택된 하위 기능에 집중한다.
- `설정 개요`는 현재 구현된 현장·설치 상태, Gateway claim, 조명 등록 진입점과 역할별 읽기/관리 범위를 카드·목록으로 정리한다.
- `도면 관리`는 층별 도면 상태, 편집 가능 여부, revision과 편집 진입 행동을 명확히 한다.
- 도면 편집기는 넓은 작업 화면을 유지하되 toolbar, property panel, save/restore 상태를 공통 button, badge, feedback 토큰으로 맞춘다.
- `비밀번호 변경`은 읽기 좋은 단일 column form으로 유지하고 validation과 성공·오류 상태를 공통 feedback 패턴으로 바꾼다.
- 아직 구현되지 않은 설정 정보 구조 항목은 새 메뉴나 placeholder로 노출하지 않는다.

## 6. 상태와 오류 처리

- 카드·목록·차트의 페이지 전체 loading에는 레이아웃을 유지하는 skeleton을 사용하고, 인증·설치 상태 guard에는 현재처럼 간결한 text loading state를 사용한다.
- 일부 query만 실패한 경우 정상 데이터를 숨기지 않고 실패한 영역 안에서 재시도를 제공한다.
- destructive action은 기존 확인 dialog를 유지하고 danger tone을 실행 버튼에만 제한한다.
- 비동기 실행 버튼은 label을 동작형 진행 문구로 바꾸고 중복 실행을 막는다.
- 성공 메시지는 다음 행동을 가리지 않는 inline announcement로 제공한다.
- 실제 HIL이 확인되지 않은 상태를 UI에서 양산 완료로 과장하지 않는다.

## 7. 접근성

- 본문과 UI text는 WCAG AA 대비를 만족한다.
- focus-visible ring을 모든 interactive element에 일관되게 적용한다.
- hover로 열리는 설정 메뉴는 동일 기능을 focus, keyboard, touch로 제공한다.
- tab, dialog, menu의 적절한 role과 `aria-selected`, `aria-expanded`, `aria-controls`, accessible name을 유지한다.
- 아이콘만으로 의미가 결정되지 않도록 text 또는 screen-reader label을 제공한다.
- 차트의 기존 screen-reader data list를 유지한다.
- motion 감소 설정에서 회전·전환 animation을 최소화한다.

## 8. 코드 구조와 변경 경계

주요 변경 대상은 다음과 같다.

- `apps/web/src/styles.css`: token layer와 공통 layout/primitive style 재구성
- `apps/web/src/components/ui/*`: 공통 primitive 추가
- `apps/web/src/features/shells/CustomerShell.tsx`: 주 내비게이션과 설정 서브메뉴
- `apps/web/src/features/settings/SettingsShell.tsx`: 내부 sidebar 제거, outlet 중심 layout
- `apps/web/src/features/settings/settings-sections.ts`: 역할별 서브메뉴의 단일 정본 유지
- 모니터링·제어·자동화·통계·설정 feature view: 공통 primitive 적용과 정보 위계 조정
- 관련 component test와 Playwright 시나리오
- `docs/menus/monitoring.md`, `control.md`, `statistics.md`, `settings.md`
- `docs/project-status.md`와 활성 구현 계획 체크리스트

API wrapper, React Query key, command/session recovery, authorization, Prisma schema, MQTT 계약은 변경하지 않는다.

## 9. 검증 기준

### 9.1 자동 검증

- 공통 component의 variant, disabled, loading, keyboard focus를 component test로 검증한다.
- 설정 submenu는 admin/viewer 항목 차이, hover/focus/keyboard/touch 열기, Escape, 외부 클릭, route 이동, query string 보존을 검증한다.
- 설정 내부 sidebar가 더 이상 렌더링되지 않는 것을 검증한다.
- 기존 모니터링, 제어, 자동화, 통계, 설정 feature test를 유지하고 변경된 accessible role/name에 맞춰 갱신한다.
- desktop Chromium과 390x844 mobile에서 네 메뉴의 핵심 흐름과 가로 overflow 부재를 Playwright로 검증한다.
- typecheck, web test, web build를 통과한다.

### 9.2 수동 시각 검증

- 1440px desktop, 1024px tablet, 390px mobile, 320px minimum width에서 확인한다.
- 모든 화면에서 title, primary state, primary action의 읽기 순서가 일관적인지 확인한다.
- 긴 한글 label, 큰 수치, partial/error/loading/empty 상태를 확인한다.
- 설정 popover가 viewport 밖으로 잘리지 않고 주 메뉴와 내용 위에 올바르게 쌓이는지 확인한다.
- 키보드만으로 설정 하위 route에 진입하고 빠져나올 수 있는지 확인한다.

## 10. 범위 제외

- operator 전용 관리자 화면의 전면 리디자인
- 새로운 설정 기능 또는 placeholder 메뉴 추가
- 새로운 통계 지표, 제어 모드 또는 Gateway 동작 추가
- API, DB, MQTT, firmware 변경
- 로고 리브랜딩과 별도 마케팅 자산 제작
- dark mode

## 11. 완료 조건

- 고객용 네 메뉴가 승인된 A안의 공통 token과 primitive를 사용한다.
- 현재 구현된 모니터링 등록, 수동·스케줄·차량 이벤트 제어, 통계, 설정·도면·비밀번호 기능을 잃지 않는다.
- 설정 내부 sidebar가 제거되고 역할별 하위 메뉴가 주 내비게이션의 hover/focus/touch 메뉴로 이동한다.
- 기존 권한, route, query string, dirty guard와 복구 동작이 유지된다.
- 관련 메뉴 문서와 상태판이 실제 구현·검증 결과와 일치한다.
- 자동 검증과 지정 viewport 시각 검증이 완료된다.

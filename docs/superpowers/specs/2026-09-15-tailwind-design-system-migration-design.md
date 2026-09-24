# Tailwind 디자인 토큰 및 공통 UI 시스템 전환 설계

> **2026-09-23 적용 기준:** 아래 `0장`은 [승인된 킨다 관제 UX 시안](../../assets/ux-refresh-2026-09-23/design-review.md)의 제품 적용을 위한 최신 디자인 시스템 계약이다. 이 문서의 기존 1~14장은 2026-09-15 Tailwind 전환 당시의 설계·구현 순서 기록이며, 특히 2장의 “Tailwind 미사용”과 10장의 세션 배정은 **현재 구현 상태가 아니다**. 실제 완료·미완료 판정은 [프로젝트 현황](../../project-status.md)과 메뉴별 현황이 우선한다. 시안의 화면 방향·여정은 `design-review.md`, 토큰/공통 컴포넌트 구현 계약은 이 문서 0장, 제품 기능 계약은 기존 메뉴·API 문서가 정본이다.

## 0. 2026-09-23 승인 UX 적용 명세

### 0.1 범위와 변경 원칙

11개 PNG의 **지도 중심 작업대, 전역 현장 맥락, 재진입 가능한 상태 표현**을 유지한다. 이 장은 새 기능 완료 선언이 아니라 페이지 구현자가 사용할 변경 명세다. 제품 코드·API·DB·펌웨어는 이 문서 작업에서 변경하지 않는다. UI 변경은 기존 route, 역할별 capability, `siteId` URL, 조회·명령·보고서 payload, 맵 저장/lease/dirty/409 계약을 보존해야 한다. 사용자에게 보이는 수치는 mock 시안 데이터와 분리하고, 실측·상태 기반 추정·가상 비교 기준을 혼동하지 않는다.

현재 제품의 토큰은 `apps/web/src/styles/theme.css`의 Tailwind v4 `@theme static`가 단일 원천이다. 공통 UI는 `apps/web/src/components/ui`의 공개 API를 이용한다. 각 페이지가 PNG의 색/간격을 literal로 옮기거나 `scenes.css`를 제품에 import하지 않는다. 새 primitive가 필요한 상태 센터·toast·현장 선택은 **공통 UI/셸 담당이 먼저 API·접근성·테스트를 확정**하고 메뉴 담당은 공개 API를 사용한다. 현장 선택 가능 범위와 URL 동기화는 현재 서버의 권한/현장 조회 계약을 확인한 뒤 결정하며, 보이지 않는 타 현장 접근 권한을 UI로 만들어내지 않는다.

### 0.2 토큰과 화면 밀도

| 화면 역할 | 제품 토큰/규칙 | 시안 적용 경계 |
| --- | --- | --- |
| 브랜드 | `brand-navy #15324a`, `brand-blue #256fa1`, `brand-coral #ff7a5c`, `brand-paper #f4f8fa` | Navy 제목/역색 면, Blue 주요 행동, Paper 캔버스. Coral은 로고·제한적 장식만; 오류·경고·주요 CTA 아님 |
| 표면·문자 | `surface-canvas/panel/elevated/inset/inverse`, `content-primary/secondary/muted/inverse/disabled` | 카드·패널은 흰 면과 `border-default`; muted만으로 필수 정보나 오류를 전달하지 않음 |
| 행동·상태 | `action-primary/*`, `action-danger-*`, `status-neutral/info/success/warning/danger-*` | 상태는 의미 토큰 + 텍스트/아이콘. 연결 상태, 조명 점검, freshness, 제어 가능 여부를 하나의 배지로 합치지 않음 |
| 지도·차트 | `fixture-*`, `chart-*` 및 공통 theme color adapter | 마커 색은 현재 제품 의미를 보존하고 선택·오프라인을 형태/라벨로도 구분. 결측은 0 색상으로 칠하지 않음 |
| 간격 | 기존 5.1의 2/4/6/8/10/12/14/16/18/20/24/28/32/40/48/64px scale | 기본 카드 내부 16px 모바일·24px 데스크톱, 섹션 간 24~32px, 조밀한 상태 행 8~12px. 44px hit target은 간격이 아닌 조작 제약 |
| 글자 | `page-title 28/36`, `section-title 24/32`, `card-title 20/28`, `body 14/22`, `body-sm 13/20`, `label/caption 12/18`, `metric 28/34` | 표·보조 상태를 11px 이하로 축소하지 않음. 모바일 입력은 확대 방지를 위해 16px 이상을 유지; 숫자·시각은 tabular number |
| 형태 | `radius-control/panel/popover/pill`, `shadow-panel/popover/focus` | 둥근 카드·조작·오버레이의 역할별 사용. focus ring은 hover/selected와 별개로 유지 |

`content-muted`와 상태 전경의 실제 조합, 차트 선·마커·작은 텍스트는 사용 맥락마다 AA 명암비를 확인한다. 본문 4.5:1, 큰 글자·의미 있는 경계/아이콘 3:1을 목표로 하며 미달 조합을 시안의 임의 hex로 고치지 말고 UI 기반 담당에게 의미 토큰 조정을 요청한다. 기본 본문은 `Inter` 기반 현재 제품 typography를 유지하고 한글 줄바꿈·200% 확대에서 레이아웃을 검증한다. 새 dark theme나 별도 Figma/정적 시안 토큰 원천은 만들지 않는다.

### 0.3 공통 컴포넌트와 상태 계약

| 요소 | 현재 재사용 출발점 | 승인 UX 적용 시 필요한 variant·상태/행동 |
| --- | --- | --- |
| Button/IconButton | `Button`의 `primary/secondary/ghost/danger/link`, `sm/md/lg`, `isLoading`; `IconButton`, `IconTooltipButton` | 기본 높이 최소 44px, 필수 실행은 primary 1개/맥락, 보조는 secondary/ghost, 파괴 동작만 danger. pending은 중복 실행 차단·텍스트 유지, disabled는 비활성 이유를 근처에 제공. 로딩·실패가 성공처럼 보이지 않음 |
| 입력·검색 | `FormField`, `TextField`, `SearchField`, `NumberField`의 `outline/filled/ghost`, `sm/md/lg` | label/description/errorMessage 연결, 필수·읽기 전용·invalid·disabled 구분. 검색의 빈 결과·조회 실패·미배치 대상은 서로 다른 상태. 320px에서 검색이 지도를 밀어내지 않도록 지도 앞의 짧은 행 사용 |
| 선택·기간 | `SelectBox`의 `outline/filled`, `selectedKey`, `items`, `onSelectionChange`; 공통 날짜·시간 계열 | 현장/층은 권한·데이터 준비 전 임의 기본값 금지. 하나뿐인 층/게이트웨이 자동 선택은 해당 등록 단계에서만 검증 후 사용. 기간은 현장 timezone·24시간제·date-only 변환을 유지하고 KPI/차트/보고서 각각의 범위를 라벨에 명시 |
| 카드·상태 | `Card`의 `default/selected/danger`, `MetricCard`, `StatusBadge`의 `neutral/info/success/warning/danger`, `FeedbackState` | 선택 카드와 위험 카드 시각 분리. `StatusBadge`는 icon+문구가 필수이며 단일 “정상”으로 freshness/명령 가능 여부를 뭉치지 않음. 로딩/빈값/미수집/0/부분 실패/오프라인은 독립 표기 |
| 도움말·overlay | `IconTooltipButton`, `Popover`, `ModalDialog`, `ConfirmDialog`, `SidePanel` | tooltip은 보조 설명만; 중요한 실패·행동은 본문/상태 센터에 남김. popover·drawer는 Escape/외부 클릭/trigger focus 복귀, dialog는 focus containment. 지도 상세는 `SidePanel`을 시작점으로 하되 desktop 인접 패널·compact bounded sheet/drawer의 레이아웃 변형을 공통 소유자가 정의 |
| toast·상태 센터 | 현재 공통 `Toast`/`StatusCenter` 없음; 새 셸 UI 제안 | 완료는 4~6초 비차단 toast와 관련 이력 링크, 부분 실패·stale는 toast + 상단 점/건수 + 재진입 popover/drawer. 해결 전 상태는 현 로그인 세션의 기존 쿼리/인시던트에서 재구성; 새 알림 DB, push, escalation, 장기 보관을 뜻하지 않음. `role=status`/`alert`는 긴급도에 맞게 중복 낭독 없이 사용 |
| 지도 마커·패널 | `FloorMapViewport`, `FloorScene`, `SpatialTargetSelector`, `SidePanel` | 시각 dot과 독립된 최소 44px hit target, 밀집 시 확대/목록 경로. 선택/제어 가능/오프라인/최근 확인 밝기 및 마지막 수신 시각을 분리. 모니터링은 읽기 전용, 제어는 기존 대상·잠금·ACK 계약, 편집은 draft/저장 결과 분리 |

새 API를 페이지 로컬 버튼·toast·상태 배열로 먼저 복제하지 않는다. 공통 소유자는 `variant`, `size`, `className`, forwarded ref, 키보드/스크린리더 이름과 focus 테스트를 한 번에 제공한다. 메뉴 소유자는 도메인 상태를 위 공통 표현에 매핑하고, 요청 성공/실패 판정은 기존 데이터 계층에서만 받는다.

### 0.4 반응형 배치 기준

| 검증 폭 | 셸·콘텐츠 | 지도·상태·조작 |
| --- | --- | --- |
| 1440×900 | 데스크톱 좌측 주 메뉴, 상단 현장 맥락, 2열 작업대 | 지도 우선 + 독립 상세 패널; toast/popover는 본문 높이 미변경. 차트 축·단위와 보고서 메타를 표시 |
| 1024×768 | 메뉴/상단은 유지하되 카드·필터 줄바꿈 | 지도와 패널 최소 너비를 보장; 필요하면 패널을 아래로 배치. 고정 폭 때문에 수평 body overflow를 만들지 않음 |
| 390×844 | 하단 4메뉴·safe area, 페이지 본문 스크롤 | 모니터링 KPI 한 줄 가능할 때만 사용; 지도→우선 확인/검색. 제어 실행은 하단 메뉴 위 기존 compact sheet에 대상·밝기·적용을 보존 |
| 320×740 | 하단 메뉴·safe area 보존, 줄바꿈/축약을 검증 | KPI 2×2, 검색을 지도 앞에 둠. 지도·목록·확대·미배치 접근을 유지하고 내부 패널만 필요한 경우 스크롤 |

기준 breakpoint는 `compact 47.5rem(760px)`, `tablet 64rem(1024px)`이며 1024px 정확 경계에서 레이아웃을 실제 확인한다. 390px/320px의 숫자 배치는 사용 가능한 문구 길이와 접근성 확대에 따라 2×2로 내려갈 수 있다. 모바일 마커가 44px 영역끼리 겹치면 전부 강제로 표시하지 말고 확대/집계/검색 목록으로 전환한다. 고정 하단 요소는 `safe-area`와 실제 시트 높이만큼 본문 여백을 확보한다.

### 0.5 화면 연결과 파일 소유 핸드오프

2026-09-23 코드/QA 대조 결과를 구현 티켓의 **시작 상태**로 사용한다. 아래 `유지` 항목은 새 기능으로 다시 만들거나 완료 판정을 중복 집계하지 않는다.

| 화면 | 실제 갭: 이번 UX 적용 대상 | 이미 있는 계약: 유지·회귀만 |
| --- | --- | --- |
| 최초 설치 | `SetupWizard`의 층수↔`floors` 개수 불일치 저장 차단과 완료 후 다음 단계 CTA 없음 | pending 설치 진입·역할 제한 및 기존 저장/등록 API |
| 셸·상태 | `CustomerShell`은 현장 읽기 전용 배지이며 전역 현장 선택, 게이트웨이 집계, 상태 센터 없음 | 권한이 확인되기 전 보호 route 차단, 역할별 nav와 dirty logout guard |
| 모니터링 | stale 경고가 본문을 밀고, offline 밝기를 현재값처럼 표기하며, 320px KPI가 1열 | 읽기 전용 지도, 실제 상태/인시던트 데이터와 부분 실패·재조회 계약 |
| 수동·자동 제어 | 승인 시안의 간결한 정보 위계와 일정 적용 기간 가시성 조정 | 실행 결과 패널, 명령 재시도/복구·잠금/ACK 계약, 공통 지도 대상 선택은 이미 존재 |
| 통계·보고서 | 보고서 필터 5개가 기본 노출되어 3개 기본 + 2개 상세로 위계 조정 필요 | 현장 timezone, 추정 표기·히트맵 범례, 보고서 만료 시각·문서 형식 계약은 이미 존재 |
| 도면 모바일 | 위치 지정이 HTML drag/drop에 의존해 선택→지도 탭→확인 대안 필요 | 도면 저장·revision, lease/dirty/409와 등록 조명 ID |
| 인증 | 로그인 제출에서 500/transport를 비밀번호 오류로 오분류하고 무응답 deadline 없음 | `/auth/me`의 401/403/일시 오류 복구와 보호 route fail-closed는 이미 존재 |

상태 센터의 `미해결`은 durable 알림 원장이 아니라 **현재 세션에서 기존 API/쿼리로 확인되는 문제**의 재진입 상태다. 새로고침·현장 전환 시 과거 메시지 보존을 약속하지 않으며, 동일 문제의 toast 반복 방지·해제 조건은 공통 셸 담당이 현재 쿼리 식별자로 정의한다. 외부 notification/escalation, 장기 보관, 새 장애 수집 API는 이 인수 범위에 없다.

| 순서/담당 | 기존 route·진입점 | 페이지 변경과 완료 증거 |
| --- | --- | --- |
| 1 공통 UI·셸 | `components/ui`, `styles/theme.css`, `features/shells/CustomerShell.tsx`, 인증 복구 | 현장 선택 가능성·권한 확인, 상단 상태 아이콘/세션 상태 센터/toast primitive, compact nav와 overlay focus. 현재 현장 읽기 전용 배지를 선택기로 오인하지 않음. 인증 `/auth/me` 401/403/5xx/전송 실패 분류와 fail-closed route, dirty editor 로그아웃 guard 유지 |
| 2 설치·설정 | `/settings`, `/settings/registration`, `/settings/floor-plans/:floorId/edit` | 현장·층→gateway→조명 등록→도면 배치→운영 진입을 단계로 연결. 층수/배열 검증, 완료 후 다음 단계 CTA, 모바일 선택→탭→확인 경로는 기존 lease/dirty/409·권한/등록 계약 안에서 구현. 실제 조명 등록/배치 결과와 mock 시안의 예시값 구분 |
| 3 모니터링 | `/monitoring`, `features/monitoring`, 공통 읽기 전용 지도 | 현장·층 KPI→지도→조명 상세/최근 수신/조치→제어 이동. 미배치·밀집 마커의 목록 경로와 부분 실패 재진입. 지도 상태를 정상값으로 보간하지 않음 |
| 4 제어 | `/control?mode=manual|schedule|event`, `features/control` | 같은 지도/목록 선택→실행 가능한 대상→밝기→명령 접수/terminal·부분 실패→이력. 기존 단일 Gateway/개수·lock/idempotency/ACK/복구 유지. schedule 시작·종료일과 event 센서→조명→동작을 항상 요약; BIO `0x09` production 미구현은 숨기지 않음 |
| 5 통계·보고서 | `/statistics/overview|analysis|reports`, `features/statistics` | 현장 timezone, 고정 KPI 기간 vs 추이/분석 기간 vs 보고서 기간 구분. 상태 기반 추정/비교 기준/결측/0·차트 축/범례, 보고서 기본 3필터와 상세 형식/범위, PDF/XLSX/CSV 계약 및 7일 만료 메타 유지 |
| 6 QA·운영 | `docs/menus/*`, 기존 집중 테스트·Chromium 여정 | 4개 폭, keyboard/screen reader/focus, 권한/URL/back, 부분 실패/재시도, 저장/명령/보고서 실제 응답을 회귀. 변경한 모든 메뉴 현황을 같은 구현 작업에서 갱신하고 mock·소프트웨어·실장비 HIL 증거를 분리 |

공통 API가 없거나 서버 데이터가 없는 항목은 페이지가 임의 mock으로 “완료” 처리하지 않는다. 구현 순서와 파일 잠금/체크리스트는 총괄의 활성 `writing-plans` 계획이 소유하며, 이 표는 디자인 인수 조건이다. 실제 iOS/Android WebView 수동 시각·제스처 검증, 다중 조명·Gateway HIL 및 production 알림/센서 실행은 별도 검증·승인 대상이다.

## 1. 결정 요약

Web UI를 **Tailwind CSS v4의 CSS-first 테마 변수**와 **React Aria Components 기반의 headless 공통 컴포넌트**로 전환한다. 현재 화면의 시각적 인상과 정보 밀도를 최대한 유지하면서 간격, 색상, 타이포그래피와 폼 상호작용을 하나의 규칙으로 통합한다.

- Tailwind CSS v4의 `@theme`를 디자인 토큰의 단일 원천으로 사용한다.
- padding, margin, gap은 승인된 고정 간격 토큰만 사용한다.
- 색상은 브랜드, 표면, 콘텐츠, 경계, 행동, 상태, 차트와 조명 의미별 semantic token만 사용한다.
- 폼과 상호작용 컴포넌트는 React Aria Components의 접근성·포커스·키보드 동작을 활용하고, 제품 API와 시각 표현은 프로젝트 공통 컴포넌트가 소유한다.
- 모든 공통 컴포넌트는 타입이 지정된 `variant`, `size`, `className`과 적절한 `ref`를 지원한다.
- 컴포넌트 내부의 DOM 탐색은 `querySelector` 대신 전달된 ref, 내부 ref, React Aria의 focus primitive를 사용한다.
- Tailwind로 표현 가능한 정적 스타일은 Tailwind를 사용한다. CSS 파일은 외부 라이브러리, 런타임 기하, 복잡한 애니메이션처럼 Tailwind가 적합하지 않은 경우에만 제한적으로 사용한다.
- UI 기반 담당 작업 세션이 토큰과 공통 컴포넌트를 단독 소유하고, 메뉴 담당 작업 세션은 공개된 공통 API를 사용해 각 페이지를 전환한다.

## 2. 배경과 현재 상태

현재 Web은 Tailwind를 사용하지 않고 있으며 CSS 5개 파일, 약 6,981줄로 구성된다. 전역 `apps/web/src/styles.css`가 대부분의 규칙을 보유하고 있고, 간격 선언 약 637개와 색상 literal 약 394개가 분산돼 있다. 기존 `:root`에는 브랜드·상태·간격 토큰 일부가 있지만 페이지별 literal과 반복 규칙을 막는 강제 장치가 없다.

`apps/web/src/components/ui`에는 Button, Card, ModalDialog, PageHeader, StatusBadge 등 15개 안팎의 공통 컴포넌트가 있다. 반면 production 화면에는 raw `input` 약 107개, `select` 약 21개, `button` 약 31개가 남아 있고 날짜, 시간, 숫자, 범위, 체크박스가 개별 구현돼 있다. ConfirmDialog와 포커스 관리 구현도 여러 계열로 나뉘며 일부 production 코드가 `querySelector`를 사용한다.

이 전환은 새 디자인을 덧씌우는 작업이 아니라 다음 문제를 함께 해결하는 구조 변경이다.

1. 스타일 값의 출처와 허용 범위를 명확하게 만든다.
2. 접근 가능한 폼·팝오버·캘린더 동작을 공통 구현으로 통합한다.
3. 현재 화면의 외형을 유지하면서 중복 스타일을 제거한다.
4. 여러 담당 작업 세션이 병렬로 페이지를 수정해도 공통 파일 충돌과 API 분기를 만들지 않게 한다.

## 3. 목표와 비목표

### 3.1 목표

- 신규·수정 UI가 승인된 간격, 색상과 타이포그래피만 사용하게 한다.
- 현재 제품의 Navy/Blue/Coral/Paper 기반 시각 인상과 화면 밀도를 보존한다.
- TextField, SelectBox, Dropdown, Calendar, TimePicker, Button 등 폼 구성 요소를 재사용 가능한 공통 컴포넌트로 제공한다.
- 키보드 조작, 포커스 복귀, 오류 연결, 이름·역할·상태 전달을 공통 레이어에서 보장한다.
- 페이지가 저장 형식이나 API 형식을 공통 컴포넌트 내부에 침투시키지 않도록 UI 값과 도메인 값의 경계를 만든다.
- 기존 메뉴를 작은 단위로 순차 전환하고 각 단계에서 회귀를 검증할 수 있게 한다.

### 3.2 비목표

- 메뉴 기능, API 계약, DB 스키마, MQTT/BLE Mesh/게이트웨이 동작을 바꾸지 않는다.
- 이번 전환만을 위해 dark theme를 새로 만들지 않는다.
- 모든 수치를 4px 배수로 강제하지 않는다. 글꼴 크기, 선 두께, 터치 영역, 차트·캔버스 기하처럼 의미가 다른 수치는 해당 토큰 또는 문서화된 예외를 사용한다.
- React Aria Components를 페이지에서 직접 사용하는 두 번째 스타일 체계를 허용하지 않는다. 페이지는 프로젝트 공통 wrapper를 사용한다.
- 한 번에 전역 CSS를 삭제하지 않는다. 메뉴 전환이 검증된 뒤 사용하지 않는 규칙만 단계적으로 제거한다.

## 4. 기술 구조

### 4.1 스타일 계층

스타일 진입점은 다음 세 계층으로 분리한다.

1. `theme.css`: Tailwind v4의 `@theme`와 제품 semantic token을 정의하는 단일 원천
2. `base.css`: reset, 문서 기본값, focus 기본 규칙처럼 앱 전체에 실제로 필요한 최소 규칙
3. `exceptions.css`: Konva, Recharts, 런타임 좌표·크기, 키프레임처럼 utility class로 안정적으로 표현하기 어려운 예외

Vite와 Web 앱에는 Tailwind v4 공식 플러그인 구성을 사용한다. 기존 `styles.css`는 전환 기간에 compatibility entry 역할만 맡고, 완료 시 위 계층을 import하는 작은 진입점으로 축소한다. JavaScript 기반 `tailwind.config`를 별도 토큰 원천으로 만들지 않는다.

공통 컴포넌트의 class 조합은 하나의 typed variant utility와 하나의 class merge utility로 통일한다. 페이지가 문자열 조합으로 공통 컴포넌트의 내부 구조나 상태 selector를 복제하지 않게 한다.

### 4.2 의존성 경계

```text
theme.css / base.css / exceptions.css
              ↓
공통 variant·class utilities
              ↓
React Aria 기반 공통 UI 컴포넌트
              ↓
메뉴별 feature/page 컴포넌트
              ↓
기존 API client와 도메인 타입
```

- React Aria는 키보드, focus, overlay, ARIA 관계와 상호작용 상태를 담당한다.
- 공통 UI wrapper는 variant, size, tone, className, ref, label/error/help API와 Tailwind 스타일을 담당한다.
- 페이지는 도메인 값 변환, API 요청, 권한과 업무 흐름을 담당한다.
- 공통 UI 컴포넌트는 API client, 메뉴 라우트 또는 서버 응답 타입을 import하지 않는다.

## 5. 디자인 토큰

### 5.1 간격

허용 간격 값은 다음으로 고정한다.

| 토큰 값 | px | 대표 용도 |
| --- | ---: | --- |
| `0.5` | 2 | 아주 작은 광학 보정 |
| `1` | 4 | 아이콘과 라벨, 촘촘한 내부 요소 |
| `1.5` | 6 | 작은 인라인 요소 |
| `2` | 8 | 라벨과 값, 작은 컨트롤 내부 |
| `2.5` | 10 | 기존 compact control 보존 |
| `3` | 12 | 카드 내부 행, 안내문 |
| `3.5` | 14 | 기존 밀도 보존이 필요한 중간 간격 |
| `4` | 16 | 기본 패널 gap, 모바일 카드 padding |
| `4.5` | 18 | 기존 UI의 제한적 중간 단계 |
| `5` | 20 | control group과 subsection |
| `6` | 24 | 독립 섹션, 데스크톱 카드 padding |
| `7` | 28 | 큰 제목 블록 내부 |
| `8` | 32 | 큰 단락 분리 |
| `10` | 40 | 화면 shell 여백 |
| `12` | 48 | 큰 layout 여백 |
| `16` | 64 | 최상위 hero·빈 상태 분리 |

padding, margin, gap과 위치 보조 간격은 위 값만 사용한다. 반복 요소 사이의 간격은 자식 margin보다 부모의 `gap`이 소유한다. typography 컴포넌트는 자체 외부 margin을 갖지 않는다.

기존 `docs/ui-spacing.md`는 이 확장 스케일, Tailwind utility 이름, 예외와 검증 규칙을 반영해 갱신한다. 새 페이지는 즉시 적용하고 기존 페이지는 메뉴별 전환 과정에서 적용한다.

### 5.2 색상

원시 팔레트는 `@theme` 안에만 정의하고, production 컴포넌트는 다음 semantic family를 사용한다.

- `brand-*`: Navy, Blue, Coral, Paper를 포함한 브랜드 계열
- `surface-*`: canvas, panel, elevated, inset, inverse
- `content-*`: primary, secondary, muted, inverse, disabled
- `border-*`: subtle, default, strong, focus, disabled
- `action-*`: primary, primary-hover, primary-active, secondary와 disabled
- `status-*`: neutral, info, success, warning, danger의 foreground/background/border
- `chart-*`: 시계열, 비교, 목표, 기준선과 heatmap 단계
- `fixture-*`: connected, inspection, offline, on, off와 같은 조명·게이트웨이 의미

현재 전역 토큰은 다음 초기 semantic mapping으로 이전해 첫 화면의 색감을 유지한다.

| semantic token | 초기 값 | 기존 역할 |
| --- | --- | --- |
| `brand-navy` / `content-primary` | `#15324A` | 기본 제목·본문 |
| `brand-blue` / `action-primary` | `#256FA1` | 주요 행동·선택 |
| `brand-coral` | `#FF7A5C` | 제한적 브랜드 강조 |
| `brand-paper` / `surface-canvas` | `#F4F8FA` | 앱 배경 |
| `surface-panel` | `#FFFFFF` | 카드·패널 |
| `border-default` | `#DBE7F5` | 기본 경계 |
| `content-secondary` | `#64748B` | 보조 본문 |
| `content-muted` | `#73839A` | 낮은 위계 정보 |
| `action-primary-hover` | `#1D5C86` | 주요 행동 hover |
| `action-primary-soft` | `#E8F2F8` | 선택·정보의 연한 면 |
| `status-success-foreground` | `#15803D` | 성공 텍스트 |
| `status-warning-foreground` | `#B45309` | 경고 텍스트 |
| `status-danger-foreground` | `#DC2626` | 오류 텍스트 |

상태의 background/border, chart와 fixture 세부 단계는 기존 production literal을 시각적 역할별로 먼저 묶은 뒤 위 family 아래 고유 이름으로 이동한다. 서로 다른 의미가 우연히 같은 색을 사용하더라도 alias를 분리해 이후 한 역할만 안전하게 조정할 수 있게 한다. 이 inventory와 1:1 mapping은 구현 계획의 UI 기반 첫 작업에 포함하며, 임의로 새 색을 고르는 작업이 아니다.

브랜드 Coral은 장식적 포인트이고 오류 의미를 대체하지 않는다. 상태는 색상 외에 텍스트, 아이콘, badge 형태 또는 pattern을 함께 제공한다. 일반 텍스트는 WCAG AA `4.5:1`, 큰 텍스트와 의미 있는 UI 경계는 `3:1` 이상을 충족한다.

TSX와 일반 CSS에서 hex, rgb/hsl, named color와 임의 Tailwind 색상을 직접 사용하지 않는다. Konva/Recharts에 문자열 색상이 필요한 경우에도 theme token을 읽는 공통 adapter를 통해 전달한다.

### 5.3 반경, 그림자와 breakpoint

현재 인상을 보존하는 radius와 shadow도 `@theme`에서 이름을 부여한다. 컴포넌트는 숫자 literal 대신 `control`, `panel`, `popover`, `pill`과 같은 역할 토큰을 사용한다. breakpoint는 기존 화면 검증 폭을 기준으로 최소 종류만 정의하고 페이지별 임의 breakpoint를 추가하지 않는다.

## 6. 타이포그래피

| variant | font-size / line-height | 기본 weight | 용도 |
| --- | --- | ---: | --- |
| `display` | 32 / 40 | 700 | 제한적인 대표 수치·빈 상태 제목 |
| `page-title` | 28 / 36 | 700 | 페이지 제목 |
| `section-title` | 24 / 32 | 700 | 주요 섹션 제목 |
| `card-title` | 20 / 28 | 700 | 카드·패널 제목 |
| `body-lg` | 16 / 24 | 400 또는 600 | 주요 설명·강조 본문 |
| `body` | 14 / 22 | 400 또는 500 | 기본 본문·control text |
| `body-sm` | 13 / 20 | 400 또는 600 | 보조 본문·표 |
| `label` | 12 / 18 | 600 또는 700 | form label·짧은 상태 |
| `caption` | 12 / 18 | 400 | 도움말·메타 정보 |
| `overline` | 11 / 16 | 700 | 제한적인 범주 표기 |
| `metric` | 28 / 34 | 700 | KPI와 에너지 수치 |

공통 `Heading`은 `variant`, 의미에 맞는 `as`, `className`, `ref`를 받는다. `Text`는 `variant`, `tone`, 제한된 `weight`, `as`, `className`, `ref`를 받는다. 숫자 수치와 시간·식별자 표에는 tabular number를 적용한다.

페이지는 임의의 font-size, line-height, letter-spacing utility를 만들지 않는다. 말줄임은 정보 손실이 허용되는 명시적 위치에서만 사용하며, 기본적으로 한글 제목·라벨이 자연스럽게 줄바꿈되게 한다.

## 7. 공통 UI 컴포넌트

### 7.1 공통 API

모든 공통 컴포넌트는 해당 요소의 의미에 맞춰 다음 API를 제공한다.

- 타입이 지정된 `variant`
- `sm | md | lg` 크기 중 의미 있는 `size`
- 호출자가 layout을 보완할 수 있는 `className`
- 실제 interactive 또는 root element를 가리키는 forwarded `ref`
- disabled, readOnly, invalid, required, pending 같은 표준 상태
- label, description, errorMessage의 접근 가능한 연결

`className`은 escape hatch이지만 임의 값 금지 규칙을 우회하는 수단이 아니다. 컴포넌트 내부의 핵심 색상, 간격과 상태 스타일은 variant가 소유하며 페이지는 이를 복제하지 않는다.

### 7.2 구현 대상

- Field 기반: `FormField`, `TextField`, `SearchField`, `PasswordField`, `TextArea`, `NumberField`
- 선택: `SelectBox`, `ComboBox`, `DropdownMenu`
- boolean·범위: `Checkbox`, `CheckboxGroup`, `RadioGroup`, `Switch`, `Slider`
- 날짜·시간: `Calendar`, `DatePicker`, `DateRangePicker`, `TimePicker`
- 행동: `Button`, `IconButton`
- overlay 통합: `Popover`, `Dialog`, `ModalDialog`, `ConfirmDialog`

기존 Card, PageHeader, StatusBadge, MetricCard, FeedbackState 등은 새 토큰과 API 규칙으로 정리하되 불필요한 이름 변경은 피한다.

### 7.3 variant 체계

- input 계열: `outline | filled | ghost`
- button 계열: `primary | secondary | ghost | danger | link`
- selection 계열: `outline | filled`
- 의미 상태: `neutral | info | success | warning | danger`
- 공통 크기: `sm | md | lg`

모든 컴포넌트가 모든 variant를 억지로 지원하지 않는다. 각 컴포넌트는 의미 있는 subset을 타입으로 제한하고, 기본값을 문서와 테스트에 고정한다.

### 7.4 날짜와 시간 값

Calendar, DatePicker와 TimePicker는 React Aria Components와 `@internationalized/date` 값을 사용한다. 화면 기본 locale은 `ko-KR`, 시간 표기는 24시간제를 사용한다.

공통 컴포넌트는 캘린더 날짜와 시간을 timezone 없는 UI 값으로 전달한다. 페이지 adapter가 API 계약에 맞춰 ISO date, local time 또는 timestamp로 변환한다. 날짜-only 값을 `Date`의 UTC 변환에 바로 넣어 하루가 이동하는 문제를 허용하지 않는다.

### 7.5 포커스와 DOM 접근

기존의 여러 dialog/focus trap 구현은 React Aria의 overlay와 FocusScope 동작을 사용하는 한 계열로 통합한다. dialog가 닫히면 실행 요소로 포커스가 복귀해야 한다.

production 컴포넌트에서 `document.querySelector`, `element.querySelector`로 focus target이나 자식 상태를 찾지 않는다. 필요한 element는 ref로 직접 소유하거나 callback ref, context와 React Aria collection API로 전달한다. 테스트 코드의 사용자 관점 query는 이 금지 대상이 아니다.

## 8. Tailwind 우선과 CSS 예외

다음은 Tailwind utility와 data/ARIA variant로 표현한다.

- layout, spacing, color, typography, border, radius, shadow
- hover, active, focus-visible, disabled, invalid, selected, open 상태
- responsive layout과 container 수준 변화
- 공통 컴포넌트의 variant 조합

다음은 `exceptions.css` 또는 기능별 승인된 예외 파일을 사용할 수 있다.

- Konva 캔버스 좌표, 확대/축소와 runtime geometry
- Recharts가 요구하는 SVG 속성 또는 runtime 계산값
- percentage와 측정 결과를 기반으로 하는 inline custom property
- utility로 표현할수록 불명확해지는 복잡한 keyframe
- 브라우저·외부 라이브러리 제약을 위한 selector

예외에는 이유, 적용 대상과 Tailwind로 대체할 수 없는 근거를 주석으로 남긴다. 정적인 padding, margin, gap, color를 예외 CSS로 옮기는 것은 허용하지 않는다.

## 9. 자동 강제 규칙

CI와 로컬 검사에 source scan을 추가해 다음을 차단한다.

- arbitrary Tailwind spacing과 color class
- TSX 및 일반 CSS의 직접 px/rem 간격, hex/rgb/hsl/named color
- 승인 목록 밖 CSS 파일 또는 selector 추가
- 공통 컴포넌트로 대체 가능한 raw form style의 신규 추가
- production 코드의 신규 `querySelector`
- typography scale 밖 font-size, line-height와 letter-spacing

다음은 문서화된 allowlist로 관리한다.

- `0`, percentage, viewport와 geometry 계산
- border 1px, 최소 터치 영역 44px처럼 spacing이 아닌 물리·사용성 제약
- chart/canvas runtime values
- 테스트 fixture 또는 test-only selector

검사는 신규 위반을 즉시 막고, 기존 위반은 메뉴별 migration baseline을 줄이는 방식으로 운영한다. 전환 완료 시 baseline을 0으로 만든다.

## 10. 작업 세션 소유권과 적용 순서

여기서 “담당자”는 한 대화 안의 임시 서브에이전트가 아니라 사용자가 생성해 사이드바에서 관리하는 **별도 Codex 작업 세션**을 뜻한다. 각 세션은 `/Users/kim-jh/Documents/led-control-service`의 저장된 프로젝트에서 직접 작업한다. 공통 파일은 한 세션만 수정하고 페이지 세션은 배정된 feature 범위만 수정한다.

### 10.1 UI 기반 담당 작업 세션

단독 소유 범위는 다음과 같다.

- Tailwind/Vite 설정과 `theme.css`, `base.css`, `exceptions.css`
- variant/class merge utility
- `components/ui`의 공통 컴포넌트와 public barrel
- dialog/focus 계열 통합과 production `querySelector` 제거
- 스타일 강제 검사, 공통 컴포넌트 unit·a11y 테스트
- 전역 legacy style의 단계적 제거

다른 담당 세션은 위 파일을 직접 수정하지 않는다. 필요한 API가 없으면 UI 기반 담당 세션에 요청하고, 공개된 API가 반영된 뒤 페이지 migration을 계속한다.

### 10.2 페이지 담당 작업 세션

적용 순서는 다음으로 고정한다.

1. **통계 담당:** 첫 pilot. overview, analysis, reports에 typography, form, chart token, Calendar/DatePicker를 적용해 공통 API를 검증한다.
2. **모니터링 담당:** 대시보드, 목록, 상태 필터, empty/error state와 조명·게이트웨이 상태를 전환한다.
3. **제어 담당:** 수동 제어, 그룹 제어, automation과 schedule의 form·dialog를 전환한다. 모니터링과 병렬 진행할 수 있다.
4. **설정 담당:** 일반 설정 화면을 먼저 전환한다. 최근 변경이 많은 등록 flow는 일반 설정 안정화 후 적용한다.
5. **floor editor 담당:** Konva 기반 편집기는 설정 등록과 분리해 마지막에 적용하고 geometry 예외를 검증한다.
6. **shell/인증/운영 담당:** app shell, login/auth, operator 화면을 전환하고 route loading/error, navigation과 responsive shell을 검증한다.

사용자가 기존에 만든 담당 작업 세션을 우선 사용한다. 존재하지 않는 역할은 별도 Codex 작업 세션을 새로 만들며, 본 설계 승인 시점에는 shell/인증/운영 담당 세션을 새로 만든다.

### 10.3 충돌 방지

- UI 기반 담당만 theme, 공통 barrel, 공통 컴포넌트와 legacy global CSS를 수정한다.
- 페이지 담당은 자기 feature 폴더와 대응하는 `docs/menus/*.md`를 소유한다.
- `App`, `CustomerShell` 등 shell 공통 파일은 shell/인증/운영 담당이 소유한다.
- 두 세션이 같은 파일을 필요로 하면 먼저 소유 세션에서 변경하고, 다른 세션은 그 커밋을 기준으로 이어간다.
- 전체 구현 계획에는 각 세션의 선행 커밋, 시작 조건, 소유 파일과 검증 명령을 체크리스트로 기록한다.

## 11. 테스트와 검증

### 11.1 공통 컴포넌트

- 모든 지원 variant, size와 상태 조합의 class·접근성 계약
- `className` 병합과 forwarded ref가 실제 대상 element를 가리키는지
- label, description, error와 control의 ARIA 연결
- 키보드 이동, Escape 닫기, overlay focus containment와 trigger focus 복귀
- SelectBox, DropdownMenu, Calendar, DatePicker, TimePicker의 keyboard interaction
- `ko-KR`, 24시간제와 date-only 변환에서 UTC 날짜 이동이 없는지
- axe 기반 주요 접근성 위반 검사

### 11.2 페이지 회귀

- 1440×900, 1024×768, 390×844, 320×740 viewport에서 레이아웃과 overflow
- 최소 44×44px 터치 영역과 focus-visible 식별성
- 통계 기간 선택, 조명·게이트웨이 필터, 제어 form, 설정·등록, 로그인과 운영자 flow
- 기존 API 요청 payload, 권한, route와 업무 동작이 변하지 않는지
- desktop, tablet, mobile Playwright screenshot 또는 핵심 DOM assertion

### 11.3 전체 검증 명령

각 단계는 최소한 다음 검증을 실행한다.

```bash
pnpm --filter @led-control/web typecheck
pnpm --filter @led-control/web test
pnpm --filter @led-control/web build
pnpm --filter @led-control/web exec playwright test
```

메뉴별 담당은 전체 E2E 전에 자기 범위의 focused test를 실행한다. 스타일 강제 검사에서 arbitrary value, 직접 literal, 승인되지 않은 CSS와 production `querySelector`가 증가하지 않아야 한다.

## 12. 문서 갱신

- `docs/ui-spacing.md`: 새 간격 scale, Tailwind utility, 예외와 검증 폭
- `docs/menus/statistics.md`: pilot 적용 범위, 날짜·차트 UI와 한계
- `docs/menus/monitoring.md`: 필터, 상태, empty/error state 전환
- `docs/menus/control.md`: 제어 form, dialog, automation/schedule 전환
- `docs/menus/settings.md`: 일반 설정, 등록 flow와 floor editor 전환
- shell/auth/operator에 별도 메뉴 문서가 없다면 변경 범위와 검증 결과를 가장 가까운 운영 문서에 기록하고, 독립 메뉴가 추가되는 경우 `docs/menus/{menu-name}.md`를 만든다.

문서에는 공통 컴포넌트를 적용했다는 사실만 적지 않고, 실제 하드웨어 연동 전 구현이나 mock 제한, 아직 남은 legacy 영역과 후속 작업을 함께 기록한다.

## 13. 완료 기준

다음 조건을 모두 충족해야 전환이 완료된 것으로 본다.

1. production Web 화면의 spacing, color와 typography가 승인된 토큰 또는 문서화된 예외만 사용한다.
2. 대상 raw form control이 공통 UI 컴포넌트로 전환되고 variant, className과 ref 계약이 테스트된다.
3. production 컴포넌트의 focus 관리를 위한 `querySelector`가 제거된다.
4. dialog와 overlay가 하나의 접근성 체계로 통합된다.
5. 모든 메뉴가 지정 viewport, keyboard, a11y와 업무 회귀 검증을 통과한다.
6. Web typecheck, unit test, build와 Playwright E2E가 통과한다.
7. 관련 `docs/menus/*.md`와 `docs/ui-spacing.md`가 실제 구현 상태와 일치한다.
8. 공통 파일의 단일 소유권이 지켜져 담당 작업 세션별 변경을 순서대로 통합할 수 있다.

## 14. 구현 전환 규칙

본 문서는 구조와 책임 경계를 확정한다. 다음 단계에서는 `writing-plans` 절차로 파일 단위 작업, 테스트 우선 순서, 세션별 선행 조건과 커밋·통합 순서를 작성한다. 사용자의 서면 설계 검토가 끝나기 전에는 공통 UI 또는 페이지 코드를 수정하지 않는다.

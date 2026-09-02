# Calm Operations A 교정 UI 적용 설계

작성일: 2026-09-02
상태: 승인된 교정 시안 기준 구현 대기
기준 커밋: `edde0d8f55920e54ecc877fe6c42dcd97a732009`

## 1. 목표

승인된 `A. Calm Operations` 교정 시안 26개를 현재 React 웹 애플리케이션의 실제 화면에 적용한다. 로그인, 전역 운영자, 현장 설치, 조명 등록, 모니터링, 수동·자동 제어, 통계, 설정·도면·보안 화면을 하나의 차분한 운영 UI로 정렬하되, 이미 검증된 기능·데이터 흐름·권한·복구 동작은 바꾸지 않는다.

이번 작업의 성공은 시안처럼 보이는 정적 화면을 만드는 것이 아니다. 실제 API 응답과 현재 역할에 따라 기존 기능이 그대로 동작하고, 정상·부분 실패·빈 상태·복구·읽기 전용 상태가 일관된 위계로 표현되며, `1440`, `1024`, `390`, `320`px 너비에서 가로 넘침이나 조작 요소 겹침이 없는 React UI를 만드는 것이다.

## 2. 설계 입력과 우선순위

### 2.1 정본 자료

1. 이 작업의 추가 확정 요구
2. `/Users/kim-jh/.codex/visualizations/2026/08/29/01a04ba1-65a6-7de3-b94c-8a395c5b420d/calm-operations-a-corrected/prototype.html`
3. 같은 폴더의 `manifest.json`과 `01-login.png`부터 `26-floor-security-states.png`까지의 PNG 26개
4. 최초 방향 기준 이미지의 좌측 A안
   - `/Users/kim-jh/.codex/generated_images/01a04ba1-65a6-7de3-b94c-8a395c5b420d/exec-10cfa968-b6f7-4efb-b24c-24598a70a3e8.png`
   - `/Users/kim-jh/.codex/generated_images/01a04ba1-65a6-7de3-b94c-8a395c5b420d/exec-f781c772-8541-4279-a5a3-24393b933998.png`
5. 기존 설계 `docs/superpowers/specs/2026-08-31-calm-operations-ui-refresh-design.md`

상충할 때는 번호가 낮은 자료를 우선한다. 따라서 scene 01의 prototype에 남아 있는 `연결 조명`, `정상 운영`, `게이트웨이` 요약 카드 3개는 실제 로그인 화면에 렌더링하지 않는다.

### 2.2 시안 해석 원칙

- PNG와 prototype은 시각 위계, 밀도, 배치, 상태 표현의 정본이다.
- `manifest.json`의 `coveredFunctions`는 현재 기능 중 어떤 상태를 그 위계에 배치할지 알려 주는 coverage 목록이다.
- 시안의 예시 수치, 날짜, 고객사명, 장비명은 fixture가 아니라 실제 API 데이터로 대체한다.
- 현재 코드에 없는 내보내기, 검색, 상태 필터, 세션 관리, 가짜 동기화 같은 control은 보이는 장식으로 추가하지 않는다.
- 시안의 문구가 현재 계약과 다르면 기존 계약을 유지하고 쉬운 한국어로만 다듬는다. 예를 들어 비밀번호 검증 규칙, 설치 단계 수, 명령 단계 수는 현재 실제 로직이 정본이다.
- prototype의 고정 `1440×900` 높이는 구도 참고용이다. 실제 React 화면은 콘텐츠 스크롤을 허용하며 정보를 잘라내기 위해 고정 높이를 사용하지 않는다.

## 3. 현재 구조와 유지할 경계

### 3.1 현재 route와 화면 소유권

| 사용자 흐름 | 현재 route 또는 진입 조건 | React 소유 화면 |
| --- | --- | --- |
| 로그인 | 인증 사용자 없음 | `apps/web/src/features/auth/AuthView.tsx` |
| 전역 운영자 | `/operator/site-admins` | `OperatorShell`, `SiteAdminManagementView`, 계정 dialog 3종 |
| 현장 설치 | pending admin의 `/settings` 강제 이동 | `SetupWizard` |
| Viewer 설치 대기 | 접근 현장 없음 또는 pending | `InstallationPending` |
| Gateway claim | 설치 완료, Gateway 미등록 admin | `GatewayClaimPanel` |
| 조명 등록·복구 | 설치 완료, admin | `RegistrationPanel`, batch/individual form |
| 모니터링 | `/monitoring` | `MonitoringView`, `FloorMap`, `FloorScene` |
| 수동·구역 제어 | `/control?mode=manual` | `ControlView`, `ControlTargetPicker`, `FixtureGroupDialog` |
| 스케줄 제어 | `/control?mode=schedule` | `ScheduleControlPanel`, `ScheduleDialog` |
| 차량 이벤트 제어 | `/control?mode=event` | `VehicleEventControlPanel`, `VehicleEventDialog` |
| 통계 | `/statistics` | `StatisticsView` |
| 설정 개요 | `/settings` | `SettingsShell`, `SettingsView` |
| 도면 목록·편집 | `/settings/floor-plans`, `/settings/floor-plans/:floorId/edit` | `FloorPlanSettingsView`, `FloorEditorRoute`, `FloorEditorView` |
| 비밀번호 변경 | `/settings/security` | `PasswordSettingsView` |

### 3.2 절대 변경하지 않는 기능 경계

| 경계 | 보존 내용 |
| --- | --- |
| API | request/response body, endpoint, query key, polling interval, invalidation 범위를 변경하지 않는다. |
| React Query | principal 교체 시 tenant cache 제거, site/user scope 격리, mutation callback, partial-data 유지와 retry 동작을 보존한다. |
| 인증 | login plaintext 비캐시, 자동 로그인 전달, logout/revoke, operator/customer 분기를 보존한다. |
| route | 기존 path, `siteId`, `mode`, redirect, browser back/forward 의미를 보존한다. |
| 권한 | operator/admin/viewer 노출 차이, viewer read-only, admin mutation 범위를 보존한다. |
| 설치·등록 | 설치 상태 guard, active registration session 복구, 재검색, reconcile 확인·제외·완료·취소를 보존한다. |
| 수동 명령 | canonical request, in-flight lock, active request/id 복구, terminal 판정, 동일 요청 재전송, logout block을 보존한다. |
| 자동화 | schedule/event CRUD, pagination, polling, `401` 처리, scope generation, Gateway sync status와 validation을 보존한다. |
| 도면 | lease/fence, atomic save, revision restore, `409` conflict, dirty sentinel, navigation/logout/site-switch guard를 보존한다. |
| 공유 계약 | `packages/shared`, API, DB, MQTT, firmware를 수정하지 않는다. |

JSX 구조와 accessible name을 시안에 맞춰 조정할 때도 위 경계를 다루는 hook, mutation, effect, store 코드는 이동하거나 재작성하지 않는다. UI 작업에서 발견한 기능 결함은 이번 작업에 섞지 않고 별도 진단 대상으로 남긴다.

## 4. 디자인 시스템

### 4.1 토큰

교정 시안의 토큰을 현재 CSS custom property에 수렴한다.

| 용도 | 값 |
| --- | --- |
| 앱 배경 | `#f6f9fe` |
| 카드 | `#ffffff` |
| 경계선 | `#dbe7f5` |
| 본문 | `#152238` |
| 보조 본문 | `#64748b` |
| Primary | `#0b63e5` |
| Primary soft | `#e9f2ff` |
| Success | `#15803d` / `#ecfdf3` |
| Warning | `#b45309` / `#fff7e6` |
| Danger | `#dc2626` / `#fff1f2` |
| Neutral state | `#64748b` / `#f1f5f9` |
| 카드 radius | `14px` |
| control radius | `9px`~`10px` |
| 카드 shadow | `0 8px 24px rgba(30, 64, 175, 0.06)` |
| popover shadow | `0 18px 40px rgba(15, 23, 42, 0.18)` |
| focus ring | `0 0 0 3px rgba(11, 99, 229, 0.24)` |

일반 카드에는 1px 경계와 매우 약한 그림자만 사용한다. 선택, modal, popover, 지도 마커처럼 깊이 차이가 실제 의미가 있을 때만 더 강한 그림자를 사용한다.

### 4.2 공통 컴포넌트

재사용 가능한 버튼, 카드, 배지, metric, 피드백과 진행 단계는 `apps/web/src/components/ui`의 public export를 사용한다.

- `Button`: `primary | secondary | ghost | danger`, loading, disabled, ref 전달
- `Card`: 기본·선택·위험 surface
- `StatusBadge`: `success | warning | danger | neutral | info`, Lucide icon + visible label
- `MetricCard`: label, value, unit, helper, optional status
- `PageHeader`: heading level, 설명, status, actions
- `FeedbackState`: neutral/info/success/warning/danger 상태의 icon, title, description, action
- `ProgressSteps`: 설치·등록·명령의 순서 있는 단계를 `complete | current | pending | error`로 표현

feature 컴포넌트가 로컬 상태나 mutation을 공통 UI로 넘기지 않는다. 공통 컴포넌트는 전달받은 표시 값만 렌더링한다. 기존 `.primary-button`, `.secondary-button`, feature별 상태 pill은 화면을 옮길 때 공통 컴포넌트로 수렴시키며, 동일 의미의 새 로컬 버튼·카드·배지 class를 만들지 않는다.

### 4.3 상태와 문구

상태는 색만으로 구분하지 않고 Lucide icon, 텍스트, tone을 함께 제공한다. 아이콘은 장식일 때 `aria-hidden="true"`, 아이콘 단독 버튼일 때 명시적 `aria-label`을 가진다.

일반 사용자에게 보이는 문구에서는 `ACK`를 사용하지 않는다.

| 기술 의미 | 사용자 문구 |
| --- | --- |
| command/config ACK 대기 | `장비 응답 대기` 또는 `적용 확인 중` |
| application ACK 완료 | `장비 응답 확인` 또는 `적용 확인` |
| ACK timeout | `장비 응답 시간 초과` |
| ACK 재시도 | `응답 다시 확인` 또는 `최신 구성 재전송` |

코드 identifier, API type, protocol test, 개발자 문서의 MQTT/application ACK 용어는 변경하지 않는다. 브라우저 fixture의 서버 오류 문구처럼 그대로 사용자에게 표시되는 문자열만 쉬운 한국어로 바꾼다.

## 5. 공통 셸과 반응형 구조

### 5.1 데스크톱·태블릿

- `1121px` 이상은 92px 아이콘 rail, 72px 현장 context bar, 유동 폭 본문을 사용한다.
- rail에는 로고와 `모니터링`, `제어`, `통계`, `설정`의 icon + label을 세로로 배치한다.
- 상단에는 실제 현장, 선택 가능한 실제 층 문맥, 실제 Gateway 상태, 마지막 갱신/로그아웃을 배치한다. 존재하지 않는 알림·프로필 기능을 만들지 않는다.
- `761px`~`1120px`은 rail과 topbar를 유지하되 넓은 2열 panel을 1열로 전환하고 table은 자체 가로 스크롤을 사용한다.
- document의 `scrollWidth`는 viewport를 넘지 않는다. 넓은 table과 editor 내부 canvas만 명시된 scroll container가 될 수 있다.

### 5.2 모바일

- `760px` 이하는 4개 주 메뉴를 고정 bottom navigation으로 전환하고, 본문은 `safe-area-inset-bottom`을 포함한 여백을 확보한다.
- topbar는 현장명, 층, Gateway 상태를 compact header에 줄바꿈 가능한 형태로 표시한다.
- `390px`에서는 KPI 2열, `360px` 이하에서는 1열을 사용한다.
- 설정은 scrim, grabber, title을 가진 bottom sheet로 연다. 역할별 항목과 dirty guard는 desktop과 동일하다.
- 모든 활성 button, link, input, select, range와 checkbox/radio의 실제 reachable target은 최소 `44×44 CSS px`이다.
- 긴 한글, 큰 숫자, 브라우저 기본 확대에서도 control이 겹치지 않는다.

## 6. Scene별 화면 설계

### 6.1 로그인·전역 운영자: scene 01~03

로그인은 좌측 brand message와 우측 로그인 card의 2열 구도를 사용하고 모바일에서는 단일 열로 전환한다. brand 영역에는 제품 설명만 두고 `연결 조명`, `정상 운영`, `게이트웨이` 요약 3개를 렌더링하지 않는다. 아이디, 비밀번호, 자동 로그인, 오류 alert, submit pending과 문의 문구는 현재 동작을 유지한다.

전역 운영자는 compact top header, 페이지 header, 실제 목록에서 계산한 요약 metric, 현장별 관리자 table을 사용한다. 설치·계정 상태는 공통 배지로 표시하고 create/assign/edit/reset/disable dialog는 동일 form spacing과 footer action 순서를 사용한다. 현재 없는 export/search/filter 기능은 추가하지 않는다. dialog focus trap, Escape, 완료 후 원 trigger 또는 stable fallback으로의 focus 복귀를 유지한다.

### 6.2 현장 설치·Gateway claim·조명 등록: scene 04~09

초기 설치는 실제 필드와 실제 validation을 유지하면서 현재 단계, Gateway 연결, 조명 등록, 운영 시작의 진행 맥락을 표시한다. 층 수 입력과 자동 생성 결과는 한 화면에서 읽히되 모바일에서 순서대로 쌓인다.

Viewer의 설치 대기는 다음 동작을 요구하지 않는 중앙 feedback으로, admin의 Gateway claim은 serial/code form과 실제 성공·오류 feedback으로 표현한다. 장비 online/mTLS 같은 API에 없는 사전 확인을 가짜 정상 상태로 표시하지 않는다.

등록 화면은 다음 실제 상태를 교정 시안의 카드·목록·단계 표현으로 배치한다.

- 층/Gateway 선택과 검색 시작
- 검색 중, 검색 실패, 검색 결과 없음, 검색 완료
- 후보 선택, RSSI와 status, 일괄/개별 설정
- batch name/rated watt/size/auto placement와 individual name/size/X/Y validation
- 이전 attempt의 `provisioning`·`reconcile_required` 노드, 상태 재확인, 안전 제외, 세션 완료·취소

검색·등록·복구 mutation과 polling 조건은 그대로 두고 DOM과 시각 위계만 바꾼다.

### 6.3 모니터링: scene 10~12

페이지 header 아래에 전체 조명, 정상, 점검 필요, 평균 밝기 4개 metric을 둔다. desktop은 4열, mobile은 2열/1열이다. 지도를 가장 큰 영역으로 유지하고 선택 조명 상세를 오른쪽 panel에 배치한다. 모바일에서는 빠른 점검 목록, 지도, 선택 상세 순서로 쌓아 우선 조치 대상을 먼저 볼 수 있게 한다.

지도 marker와 범례는 정상, 장애, 오프라인, 상태 확인 대기를 icon + label로 구분한다. 선택 상세는 밝기, 정격 전력, 최근 수신, Health, Gateway, RSSI, Hop, 명령 성공률과 점검 queue를 유지한다. 제어 이동이 현재 route 문맥으로 안전하게 제공될 수 있을 때만 실제 link를 노출한다.

0대, Viewer 설치 대기, 최초 지도 실패, 저장된 지도 유지 중 부분 갱신 실패를 서로 다른 feedback surface로 표시한다. 정상 데이터가 있는 query는 다른 query 실패 때문에 숨기지 않는다.

### 6.4 수동·구역 제어: scene 13~16

수동 화면은 mode tab 아래 `대상 선택`과 `밝기 실행`의 2열 구도를 유지한다. 개별·다중/층/저장 구역, 검색, 상태·층 filter, 선택 수, Mesh readiness, slider, 0/30/70/100 preset, override 종료 시각과 적용 버튼을 현재 semantics 그대로 배치한다.

명령 진행 중에는 기존 lock 조건을 그대로 사용하고, 접수·Gateway 전송·Gateway 수신·조명 적용 단계를 `ProgressSteps`로 표현한다. terminal 결과는 전체 성공, 실패, 시간 초과, 부분 실패의 실제 fixture 결과를 보여 준다. refresh 후 active command 복구와 동일 요청 재전송은 같은 status surface에서 제공한다. 사용자 문구는 `장비 응답 대기`, `장비 응답 확인`, `장비 응답 시간 초과`를 사용한다.

Gateway offline, Health fault, Mesh 미준비와 viewer read-only는 page-level notice와 대상별 이유를 함께 제공한다. 저장 구역 목록·생성·수정·재동기화·삭제는 현재 dialog와 API를 유지하고 공통 card/button/badge로 통일한다.

### 6.5 스케줄·차량 이벤트: scene 17~21

desktop에서는 표를 유지하되 이름, 활성 상태, 대상, 반복/센서, 밝기, Gateway 적용 상태, 최근 결과를 명확한 열로 정리한다. tablet/mobile에서는 table container를 스크롤하거나 row card로 재배치하되 모든 값을 접근 가능하게 유지한다.

스케줄 dialog는 이름, 적용 기간, 시작/종료 시각, 반복 유형/요일/월일, dimming, 밝기, 대상을 섹션으로 나눈다. 기존 현장 timezone, 자정 통과, overlap·Gregorian validation과 focus 이동을 유지한다. 삭제, 적용 실패, 재시도, 빈 목록은 각각 confirmation, inline error, pending feedback, empty action으로 표현한다.

차량 이벤트 dialog는 확인된 source capability, 같은 Gateway target, 이름, dimming, 밝기, 유지 시간을 동일한 순서로 표현한다. 현재 source eligibility와 validation을 바꾸지 않는다. admin CRUD/활성화와 viewer read-only, polling·pagination·`401` 처리는 그대로다.

### 6.6 통계: scene 22~23

상단에는 오늘, 이번 달, 올해의 3개 metric을 두고 coverage 상태를 배지와 보조 문구로 표시한다. 차트와 비용 비교는 desktop 2열, `1120px` 이하 1열이다. 일별/월별 선택, screen-reader data list, null gap, tooltip과 비용/baseline/절감 계산은 현재 구현을 유지한다.

현장 전체 no-data는 KPI를 0으로 표시하지 않는 empty state로, 선택 기간 no-data는 최신 KPI를 유지한 chart feedback으로, series 오류는 KPI·비용을 유지한 retry feedback으로 표현한다. summary 오류와 series 오류를 합치지 않는다.

### 6.7 설정·도면·보안: scene 24~26

설정 개요는 실제 현장 정보, 층·도면, Gateway 상태, 계정·보안 진입을 2×2 카드 위계로 정리한다. 현재 API에 없는 firmware, 세션 관리, 최근 변경은 표시하지 않는다. 카드 action은 기존 `/settings`, `/settings/floor-plans`, `/settings/security` route와 역할 권한을 사용한다.

desktop 설정 disclosure는 rail 오른쪽 popover, mobile은 bottom sheet다. 현재 route와 `siteId`를 보존하고 admin/viewer 항목 차이, Escape, outside click, focus 이동, dirty editor confirm/cancel 의미를 보존한다.

도면 목록은 admin에게 edit/register action, viewer에게 조회 전용 상태를 제공한다. editor는 tool rail, canvas, properties/asset/revision panel과 save action을 넓은 작업 영역으로 정리한다. lease read-only, `409` conflict, 최신 reload, revision restore, dirty guard를 기존 동작대로 유지한다.

비밀번호는 현재 client/server validation과 성공·오류 결과를 명확히 표시한다. 시안 예시의 `10자 + 특수문자`를 새 정책으로 만들지 않으며, 현재 성공 처리에서 강제 이동이나 추가 logout을 도입하지 않는다.

## 7. Scene-to-task coverage

| Scene | 화면 | 구현 task |
| --- | --- | --- |
| 01 | 로그인 | Task 2 |
| 02 | 운영자 고객사·현장·관리자 목록 | Task 2 |
| 03 | 운영자 계정 대화상자 | Task 2 |
| 04 | 현장 초기 설치 | Task 3 |
| 05 | Gateway claim 역할 상태 | Task 3 |
| 06 | 조명 검색 | Task 3 |
| 07 | 조명 일괄 등록 | Task 3 |
| 08 | 조명 개별 등록 | Task 3 |
| 09 | 등록 복구 | Task 3 |
| 10 | 모니터링 desktop | Task 4 |
| 11 | 모니터링 mobile | Task 4 |
| 12 | 모니터링 예외 상태 | Task 4 |
| 13 | 수동 제어 | Task 5 |
| 14 | 제어 명령 결과 | Task 5 |
| 15 | 제어 불가·Viewer | Task 5 |
| 16 | 저장 구역 관리 | Task 5 |
| 17 | 스케줄 목록 | Task 6 |
| 18 | 스케줄 편집 | Task 6 |
| 19 | 스케줄 상태 | Task 6 |
| 20 | 차량 이벤트 목록 | Task 6 |
| 21 | 차량 이벤트 편집 | Task 6 |
| 22 | 통계 정상 | Task 7 |
| 23 | 통계 상태 | Task 7 |
| 24 | 설정 내비게이션 | Task 8 |
| 25 | 층·도면 관리와 편집 | Task 8 |
| 26 | 도면·보안 상태 | Task 8 |

Task 1은 scene 01~26이 공통으로 소비하는 token, primitive, shell과 반응형 계약을 제공한다.

## 8. 테스트 전략

### 8.1 TDD 단위

각 task는 다음 순서를 독립적으로 지킨다.

1. 변경될 semantic landmark, 사용자 문구, 역할별 노출, responsive geometry를 테스트로 먼저 고정한다.
2. 새 테스트가 현재 UI에서 의도한 assertion으로 실패하는 것을 확인한다.
3. API/hook/store를 건드리지 않고 최소 JSX/CSS 변경으로 통과시킨다.
4. 해당 feature 전체 unit test, 관련 Playwright route fixture, typecheck를 실행한다.
5. task 소유 파일과 같은 task의 메뉴/상태 문서를 한 commit으로 남긴다.

### 8.2 반응형 검증

모든 주요 route는 `1440×900`, `1024×768`, `390×844`, `320×740`에서 다음을 검사한다.

- `document.documentElement.scrollWidth <= window.innerWidth`
- fixed rail/topbar/bottom nav가 본문과 겹치지 않음
- 활성 control의 reachable target `44×44 CSS px` 이상
- table/editor의 의도된 내부 scroll 외 document 가로 overflow 없음
- dialog와 bottom sheet가 viewport 안에서 scroll 가능함
- heading, primary state, primary action이 DOM과 시각 순서에서 일치함

### 8.3 회귀 검증

- `pnpm --filter @led-control/web test`
- `pnpm --filter @led-control/web typecheck`
- `pnpm --filter @led-control/web build`
- `pnpm --filter @led-control/web exec playwright test --project=chromium`
- `git diff --check`

브라우저 fixture와 자동 Chromium 결과는 실제 Gateway/Raspberry Pi/ESP32-H2 HIL 증거로 기록하지 않는다.

## 9. 문서 갱신

- 모니터링 변경은 `docs/menus/monitoring.md`에 기록한다.
- 수동·구역·스케줄·이벤트 변경은 `docs/menus/control.md`에 기록한다.
- 통계 변경은 `docs/menus/statistics.md`에 기록한다.
- 설치·Gateway claim·등록·설정·도면·비밀번호 변경은 `docs/menus/settings.md`에 기록한다.
- 로그인·operator·setup과 전체 완료 상태, 검증 결과와 HIL 한계는 `docs/project-status.md`에 기록한다.
- 활성 구현 중 task 완료 여부는 구현 계획의 checkbox와 `docs/project-status.md`를 총괄이 같은 시점에 맞춘다.

## 10. 범위 제외

- API, DB, MQTT, BLE Mesh, Gateway, firmware 변경
- 새 route, 새 query key, 새 global state 또는 권한 모델
- prototype에만 있는 export/search/filter/firmware/session 관리 기능
- password policy나 auth/logout semantics 변경
- command/config protocol identifier 변경
- 실제 전력계나 실장비 상태를 시뮬레이션한 가짜 정상 표시
- dark mode, 로고 리브랜딩, 마케팅 asset 제작
- 기능과 무관한 기존 코드 리팩터링

## 11. 완료 조건

- 26개 scene의 현재 구현 기능과 상태가 scene-to-task 표의 화면에 반영된다.
- 로그인에 `연결 조명`, `정상 운영`, `게이트웨이` 요약 3개가 없다.
- 일반 사용자-visible copy에 `ACK`가 없다.
- 공통 버튼·카드·배지가 `apps/web/src/components/ui`를 사용한다.
- 기존 API/React Query/state/route/권한/복구/dirty guard/command semantics 회귀 테스트가 통과한다.
- `1440`, `1024`, `390`, `320`px에서 가로 넘침, 겹침, 잘린 primary action이 없다.
- 네 메뉴 문서와 `docs/project-status.md`가 실제 구현과 검증 결과를 반영한다.
- software validation과 실제 hardware HIL 상태가 구분되어 기록된다.

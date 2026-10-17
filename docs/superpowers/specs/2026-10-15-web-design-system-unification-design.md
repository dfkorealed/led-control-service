# 전체 Web 공통 디자인 시스템 적용 설계

현장 운영·시설관리 담당자가 상태·대상·조작 결과를 쉽게 읽고 편하게 작업할 수 있도록 전체 Web의 UI를 일관되게 만든다. 공개 페이지의 기존 브랜드 특징은 유지한다.

상태: **2026-10-16 사용자 승인 · 2026-10-17 과제별 검토·전체 리뷰 보완 반영 · 전체 Web 6FAIL/Important 보존 관문 미해결 · 회귀 수리 범위 결정 대기**

작성일: 2026-10-15

2026-10-16 후속: 사용자가 [중앙 guide 수치표](../../ui-design-system.md)와 [실행 계획](../plans/2026-10-16-web-design-system-unification.md)의 공통 컴포넌트·전체 Web 적용을 지시하고 분리 작업공간 실행을 승인했다. 순차 subagent-driven 구현을 시작하며 실제 완료 상태·검증 한계는 계획과 coverage를 따른다.

## 목적과 승인 단계

사용자는 남은 P3 여섯 항목만 수리하는 범위를 넘어 공통 가이드라인을 확정하고 모든 Web 페이지에 적용하기를 요청했다. 공개 홈·기능·요금제, 운영자, 로그인·인증도 “다 포함 해”로 포함했고, 정확한 수치표와 계획 확인 후 전체 공통 적용 진행 및 분리 작업공간을 승인했다. 구현 완료는 별도의 화면·상태 coverage와 검증 근거로 판단한다.

규칙 정본은 [Web 공통 디자인 시스템 가이드](../../ui-design-system.md)다. 이 설계는 중앙 규칙을 복제하지 않고 적용 경계·보존 계약·수용 기준을 정의한다. 2026-10-16 사용자 실행 승인 뒤 Task1에서 `docs/ui-spacing.md`의 현행 참조·역사 분리와 함께 새 가이드로 규범 효력을 전환했다. 공통 계약의 독립 검토가 완료되었으며 실제 화면 적용 현황은 coverage로 별도 추적한다. 규범 전환은 전체 화면 완료 선언이 아니다.

목표는 일반 기능 UI의 공통 역할을 고객·운영자·인증에 일관되게 적용하면서 브랜드 이야기·인증 배치·운영 frame·작업 공간처럼 목적이 다른 표현을 명시적 variant로 유지하는 것이다. 별도 디자인 시스템을 페이지마다 만들거나 모든 화면의 외형을 같은 크기로 강제하지 않는다.

## 적용 inventory와 집계

| 페이지군 | 적용 단위 | 집계·경계 |
| --- | --- | --- |
| 고객 | monitoring, control, statistics overview/analysis/reports, settings overview/site/users/registration/floor-plans/editor/security | leaf12개. control1route를 manual/schedule/event/group의4mode로 나누면 고객 전체 surface는12−1+4=15개. route와 surface를 합산하지 않음 |
| 공개 | `/`, `/features`, `/pricing` | page3개. main/service/landing entry가 같은 컴포넌트를 소비하는 것을 중복 집계하지 않음 |
| 운영자 | site-admins, sensor-profiles, landing-inquiries, security | 명시 route4개. wildcard redirect는 page가 아닌 route 동작 |
| 인증 | `/login` 진입과 App 인증 gate | login 별도 Route가 아니라 AppRoot/App 상태. credentials/MFA TOTP/recovery/강제 비밀번호 변경을 상태 coverage로 추적 |
| 공통 상태·overlay | modal/drawer/confirm/menu/popover/loading/empty/error/recovery | 부모 page와 연계해 상태 coverage를 기록. App recovery와 bootstrap 준비·실패, 중복 MobilePreparation 포함 |
| 독립404 | HTTP `404.html`, React 공개 fallback | JS 없는 HTTP 문서와 React fallback을 구분하여 foundation 시각 역할·연락/귀환 접근을 검증 |

고객 leaf 계산은 monitoring1+control1+statistics3+settings7=12다. statistics의 index redirect, 고객/operator wildcard, query/hash 변화, dialog를 추가 page로 세지 않는다. 설정 leaf7은 overview/site/users/registration/floor-plans/floor editor/security다.

HTML 소스14개는 별도 inventory다. 제품 entry4(index/landing/service/404), React concept entry1, `public/concepts` 정적 archive5, 개발 smoke4로 분류한다. 일반 제품 적용과 보관·개발 문서의 경계를 추적하기 위한 수치이며 archive 재디자인·smoke 제품화를 포함하지 않는다. React concept의 기존 URL·동작과 archive 링크가 제품 리팩터링 때문에 깨지지 않는지 보호 회귀만 확인한다.

앱 entry와 route 근거는 모두 `apps/web/src` 기준으로 `{main,service-main,landing-main}.tsx`, `App.tsx`, `features/shells/CustomerShell.tsx`, `features/operator/OperatorShell.tsx`다. 공개3page는 일반 main entry, public landing 모드 entry, public service 모드 entry 각각에서 대응 route·직접 접속·새로고침·상담·로그인 표시를 동등하게 추적한다. 모드별 private 모듈/로그인 차이는 기존 계약대로 검증한다. 배포 허용 경로는 `apps/web/scripts/public-deploy-contract.mjs`와 `apps/web/scripts/static-landing-contract.mjs`를 대조한다. source route 존재와 운영 배포 접근 가능성을 동일하게 기록하지 않는다.

## 소비 경계와 책임 계약

중앙 가이드의 functional 수치·heading 역할·variant·예외·접근성 규칙을 따른다. 공통 primitive 변경을 먼저 검토하고 page 소비를 순차 적용한다. 일반 카드의 숫자가 현재 다르다는 이유로 op/auth 전체를 예외로 유지하지 않는다.

Shell은 외부 여백과 navigation, page title owner를 소유한다. feature 부모는 section/grid/row 관계를 구분한다. common Card와 Typography는 내부 padding과 시각 역할을 소유한다. `PageHeader`의 문서 headingLevel과 visual titleRole을 분리해 하위 제목이 page scale을 잘못 소비하지 않게 한다. 공통 API의 기존 소비자 호환성을 확인하고 무관한 도메인 인터페이스는 변경하지 않는다.

공유 `AccountSecurityView`에는 shell에서 presentation을 전달한다. 고객 SettingsShell의 h1과 운영자 security wrapper의 h1을 각각 유지하고 내부 view가 중복 page h1을 만들지 않는다. 두 역할의 일반 panel·title은 functional 계약에 일치시키되 MFA 권한과 principal별 remount/query/cache/secret state를 바꾸지 않는다.

공개3page는 SiteFrame/PublicSiteLayout, 승인 landing Card/Button/LinkButton과 canonical theme를 공유한다. 브랜드 hero/landing card 본연 geometry는 유지하고 상담 modal의 일반 내용은 중앙 functional panel 계약으로 정합화한다. 상담은 선택 plan을 맥락으로 표시하는 tel/mailto 연락 modal이며 문의 접수 API/개인정보 양식이 아니다. 보관 concept의 InquiryForm과 합치지 않는다. 독립 landing bundle에는 private/auth/API/mobile/concept 모듈을 가져오지 않는다. service 모드의 인증·route allowlist·404·직접 접속/새로고침을 유지한다.

독립404와 bootstrap 중복도 공통 기반의 적용 범위에 포함한다. 독립404는 JS 없는 HTTP404 성질을 유지하면서 승인된 시각 역할과 맞춘다. bootstrap 공통화는 mobile 준비 순서·실패 복구·root 수명을 보존한다. 정확한 공통화 구현은 계획 단계에서 정하며 이 문서는 새 bundle/runtime 구조를 승인하지 않는다.

## 기존 P3 여섯 항목의 적용 우선순위

| 순서 | 기존 ID | 역할과 적용 기준 |
| --- | --- | --- |
| 1 | OPS-003 | 일반 MonitoringView의 tools→map 직계 section gap은20px 대상이다. 중앙 가이드의 fullview gap8px·shell inset8/12px 및 지도 내부 chrome 예외와 분리 |
| 2 | SET-005 | 설정 개요·site·security·floor-plans의 독립 section과 동급 card grid를 구별해 공통 gap 소비 |
| 3 | BUS-004 | 통계 desktop section 리듬을 공통화. 중앙 가이드의 statistics shell mobile8px 국소 예외 보호 |
| 4 | SET-006 | 현장·보안 일반 panel의 고정 mobile20px를 일반 inset 역할로 정합화. 공유 security의 운영자 소비도 함께 검증 |
| 5 | BUS-003 | 통계 개요 차트·비용·인사이트·분석 히트맵의 외부 panel inset을 공통화. chart margin·cell geometry와 분리 |
| 6 | SET-007 | 현장/층/구역/조명 제목의 page/section/card 역할을 분류하고 titleRole로 소비. h2/h3 tag만 보고 크기를 결정하지 않음 |

이 항목은 `.local/ui-audit-20261014/report.md`와 영역별 report의 관측을 출발점으로 삼는다. 모든 값을 lexical 승인 scale 안에서 사용하더라도 역할이 다르면 불일치가 남는다는 사례다. 여섯 개 해결은 전체 Web coverage의 대체물이 아니다.

## 보존할 동작과 범위 밖 변경

API 요청·응답, DB·MQTT·장비 식별/등록, auth/session/principal/cache, password/MFA/복구 코드 비밀 수명, 역할·tenant 경계, command safety와 거절/불확정 결과 처리, pending/disabled, 자동 재전송 금지를 보존한다. 디자인 적용을 근거로 데이터나 안전 정책을 바꾸지 않는다.

기존8개 UI 수리의 본문 접근·긴 내용 판독·scroll을 보호한다. floor editor 최소256px/size containment/셸 세로 scroll, 기록 탭 단일 reader와 복구 action, 수동 지도 content588px split 및 선택/지도 DOM/배율/열린 이력, 긴 명령100 UUID reader와 위험 조작 disabled, 등록 정보의 행 읽기 폭, 현장 form 긴 층/중간 폭 저장 열과 Save 아이콘, 통계 수치·단위의 Text Range, 초기화 대상 긴 login ID 줄바꿈을 회귀 대상으로 유지한다.

표 sorting/pagination과 card 전환, upload/PDF/CSV/다운로드, 지도 pointer·dirty logout·draft, setup/등록·설정 저장, operator 현장 삭제 확인·프로파일 승인/철회·문의 cursor, modal focus 수명을 보호한다. 공개 예시를 실제 제어·실측 전력·과금·문의 접수로 바꾸지 않는다. 새 테마·새 제품 기능·archive 재디자인·native 앱 변경·운영 배포·서버 재시작·실장비 작업은 범위 밖이다.

## 단계별 산출물

1. 서면 목표 확인: 본 spec와 중앙 guide의 범위·역할·예외·수용 기준을 상세 수치표와 함께 검토한다.
2. 계획 검토: 후속 요청으로 준비한 writing-plans의 파일·의존성·소유자·검증·문서 순서를 검토했다. 사용자가 전체 공통 적용과 분리 작업공간 실행을 승인해 순차 subagent-driven 구현을 시작했다. 승인 이력과 실제 완료 체크는 계획·상태판에 구분한다.
3. 기준과 공통 소비 계약: 최초 기반 작업에서 중앙 가이드로 규범 효력을 전환하고 ui-spacing 현행 참조·역사를 분리한다. 현재 freeze의 page/state/variant coverage와 실패 baseline을 고정하고 common primitive/titleRole/presentation을 먼저 검토한다. 새 token이 필요할 때만 중앙 가이드의 독립 승인 경로를 따른다.
4. 제품 소비 적용: 고객12leaf/전체15surface(제어4mode 포함), 운영자4, 인증 gate/state, 공개3와 공통 overlay/error/bootstrap/404를 누락 없이 추적한다. 공유 파일은 한 소유자가 순차 수정한다.
5. 독립 검증·적용 현황 확정: 소비·화면·동작 근거를 검토하고 coverage·메뉴 현황·상태·계획을 실제 결과에 맞춰 갱신한다. 규범 전환과 화면별 적용 완료를 혼동하지 않는다.

단계는 계약의 의존 순서를 설명하며 명령별 실행 계획이나 체크리스트 완료 선언이 아니다.

## 검증 설계와 수용 기준

lexical 정책만 통과하는 것을 완료로 보지 않는다. 각 page/state의 owner·role·variant를 source로 대조하고, generated CSS와 browser computed에서 실제 gap/padding/type/색을 확인한다. 실제 keyboard/tap/click/wheel과 text Range/box·focus·clip/hit 결과를 연결한다. CSS class 존재만으로 동작이나 실제 hit를 판정하지 않는다.

기본 viewport는320×600,390×844,1024×768,1440×900이다. 앱 경계759/760·1023/1024·1120px, 실제 content587/588/589px, 공개430/720/1050px 각각의 직전·해당·직후 정수와 경계 바로 바깥 분수 폭을 포함한다. 지원하는 고객 light/dark와 기본 비고객 표현, normal/reduced-motion을 확인한다. 미지원 테마를 시험용으로 켜는 기능은 만들지 않는다.

각 page군은 ready뿐 아니라 실제 제공하는 pending/paused/empty/error/success/disabled 및 긴 내용, narrow 상태를 coverage에 포함한다. 공개 tel/mailto와 plan modal·login 모드, auth credentials/MFA/recovery/강제 변경, operator table/card/action/보안, 고객 지도·설정·통계·보고서의 주요 소비자가 들어가야 한다. state가 없는 화면에 인위적인 새 기능을 만들지 않는다.

수용 조건은 다음과 같다.

- 일반 기능 UI의 section/grid/panel/title은 중앙 guide의 역할에 맞고, 예외는 이유·소비 범위·보존 행동·검증 근거로 추적된다.
- 제목 계층과 visual role이 분리되고 page h1 소유가 하나이며 shared security 양쪽 소비가 일치한다.
- 긴 내용·필수 수치·단위·안전 action이 잘리지 않고 실제 scroll/keyboard/tap으로 도달한다. 기존8수리와588/256 경계를 보존한다.
- 승인 theme source/anchor·빈 policy baseline·private bundle 차단·배포 경로 계약을 유지하며, 새 token이면 별도 승인 근거가 있다.
- 접근성은 중앙 guide의 텍스트/비텍스트 대비와 프로젝트 hit 정책을 실제 색·가림·초점으로 검증하고 자동 도구 결과와 수동 분류를 구분한다.
- typecheck/build/UI정책 및 변경 관련 단위·브라우저 회귀의 결과를 실제 소스/환경과 연결하고 실패·skip을 숨기지 않는다. 최종 계획에서 정한 필수 gate를 충족한다.

## 기존 실패 baseline과 완료 coverage

이전8수리 인계의 전체 unit 최신3834PASS/6FAIL/3SKIP과 구형 E2E locator6건 한계는 성공 baseline이 아니다. 이번 적용 직전의 최신 소스에서 재확인한 baseline을 별도로 기록한다. 동일한 실패인지, 변경으로 생긴 실패인지, 구형 locator인지 근거로 구분하며 원인 미확정 상태를 무관·해결로 단정하지 않는다. locator 갱신은 원래 의미·보호 단언을 유지하는 별도 검토 대상이다. 집중 PASS로 전체 suite FAIL을 덮지 않는다.

완료 coverage에는 page/route·entry·state·variant·shared consumer·viewport/theme/motion·기능 보존·검증 근거·판정(PASS/FAIL/미실행/보류)을 기록한다. route 수만 채우거나 6개 P3만 닫아 완료로 표시하지 않는다. 고객12leaf와 전체15surface(제어manual/schedule/event/group4mode 포함), public3의 일반/landing/service entry, operator4, authgate/state, overlay/recovery/404/bootstrap이 모두 추적되어야 한다. archive/smoke는 inventory와 보호 회귀 범위가 명확해야 한다.

완료 주장은 실제 통과한 소프트웨어 범위로 제한한다. 운영 API·실제 문의/메일·AWS 배포·native WebView·Safari/WebKit·OS 키보드·Gateway/LED HIL은 해당 증거가 없으면 미검증이다.

## 문서 갱신과 인계

구현과 같은 작업에서 `docs/menus/monitoring.md`, `control.md`, `statistics.md`, `settings.md`, `landing.md`, `features.md`, `pricing.md`, `operator.md` 중 영향받은 문서를 갱신한다. 공통 overlay/loading/auth 변경이 여러 메뉴에 걸치면 관련 소비 메뉴를 모두 갱신한다. 메뉴별 구현 완료/미구현/부족하거나 개선이 필요한 기능/관련 파일/갱신 규칙 구성을 유지하고 mock·실제 운영·장비 한계를 구별한다.

총괄은 현재 상태 정본과 활성 writing-plans의 상태를 일치시킨다. 구현·검증·독립 검토가 끝난 실제 단계만 완료 체크하고 영향 메뉴를 같은 작업에서 갱신한다. 최종 인계에는 공통 규칙 적용 범위·승인 예외·검증 결과·잔여 baseline·지원 환경 한계를 함께 남긴다.

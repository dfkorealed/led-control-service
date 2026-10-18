# Web 공통 디자인 시스템 가이드

현장 운영·시설관리 담당자가 상태·대상·조작 결과를 쉽게 읽고 편하게 작업할 수 있는 일관된 UI를 만든다. 공개 페이지는 기존 브랜드 특징을 유지한다.

상태: **2026-10-16 사용자 승인 · 현재 Web 디자인 규범 · 2026-10-17 전체 적용 범위·검증 한계 기록**

작성일: 2026-10-15

상세 수치표 승인: 2026-10-16. 사용자가 상세 수치표·실행 계획·분리 작업공간 실행을 승인했다. Task1의 공통 layout·panel padding·titleRole을 Task2–5에서 고객·운영자·인증·공개 소비자로 연결했고, 실제 실행 범위와 미실행 조건을 [coverage](assets/web-design-system-2026-10-16/coverage.md)에 기록한다. Task6 및 whole-branch 독립 최종 검토는 별도 관문이다.

이 문서는 전체 Web의 현재 디자인 규범이다. [ui-spacing.md](ui-spacing.md)는 현행 규칙을 이 가이드로 연결하고 날짜별 승인·실패 이력을 보존한다. 규범 승인은 모든 화면의 적용 완료를 뜻하지 않는다. 적용 전 실제 실패는 [fresh baseline](assets/web-design-system-2026-10-16/baseline.md), 현재의 실제 등록·실행·computed/조작·대표 시각 확인과 한계는 [coverage](assets/web-design-system-2026-10-16/coverage.md)를 따른다.

## 정본 전환과 책임

승인된 계획의 최초 기반 작업에서 현행 규칙 참조와 역사 분리를 함께 정리하여 규범 효력을 이 가이드로 전환했다. 날짜별 승인·실패·토큰 회전 기록은 역사적 근거이며, 실제 화면 적용 현황은 coverage로 별도 추적한다. 이력의 실패를 지우거나 과거 수치를 현재 검증으로 승격하지 않는다. 상태 요약은 계속 `project-status.md`, 메뉴 기능 현황은 `menus/*.md`, 운영 기준은 `agent-operations.md`가 소유한다.

디자인 역할·예외는 designer가 정의하고 총괄과 web_frontend가 검토한다. 구현과 소비자 연결은 web_frontend, 독립 검증은 qa_reviewer가 맡는다. 공유 계약과 운영 변경의 권한은 기존 저장소 규칙을 따른다. 구체적인 적용 범위와 수용 기준은 [전체 Web 통일 설계](superpowers/specs/2026-10-15-web-design-system-unification-design.md)를 따른다.

## 하나의 기반과 목적별 표현

모든 제품 Web은 같은 semantic token과 공통 primitive를 사용한다. 목적별 variant는 구성·표현 차이를 명시하는 계약이다. 역할이 같은 일반 기능 카드의 기존 값이 다르다는 이유만으로 고객·운영자·인증을 각각 예외 처리하지 않는다.

| 표현 | 공통 기반을 사용하는 대상 | 허용되는 목적 구성 |
| --- | --- | --- |
| `functional` | 고객·운영자·인증의 일반 정보 패널, form, 목록, 제목 | 아래 일반 기능 UI 계약 |
| `customer-workspace` | 모니터링·제어·통계·설정 | 고객 light/dark, rail·site navigation, 지도·editor의 작업 공간 |
| `operator-workspace` | 현장 관리자·프로파일·문의·계정 보안 | 최대 1160px content frame, 운영 navigation·작업 흐름 |
| `auth-composition` | 로그인·MFA·강제 비밀번호 변경 | 소개와 form의 2열/1열 배치, 중앙 집중형 진입 화면. 일반 form 카드 내부는 functional 계약 |
| `public-brand` | 공개 홈·기능·요금제 | 승인된 브랜드 font, 넓은 hero·장면·fluid 제목·landing card와 action, 고정 공개 header |
| `overlay` / `recovery` | modal·drawer·확인·오류·로딩·복구 | 내용·초점·안전 action에 필요한 frame과 내부 scroll. 일반 내용의 역할 위계는 공유 |

현재 지원하는 테마만 검증하고 유지한다. 고객의 light/dark 지원을 공개·운영자·인증에 새 기능으로 확장하지 않는다. 공개 브랜드 font와 hero를 일반 운영 제목으로 전파하지 않는다.

## 일반 기능 UI의 엄격한 역할 계약

아래는 승인된 현행 규칙이다. 고객뿐 아니라 운영자와 인증의 ordinary functional UI에도 같은 역할로 적용한다. viewport의 `compact` 경계는 현재 760px를 유지하며 `max-compact`는 760px 미만이다.

| 역할 | desktop | compact | 소유자 |
| --- | --- | --- | --- |
| 독립 section 사이 | 20px | 20px | section을 배치하는 부모 |
| 동급 card grid | 18px | 18px | grid 부모 |
| 일반 panel inset | 20px | 16px | 공통 Card의 명시적 padding 표현 |
| page title | 26px / 1.35 | 24px / 32px | 페이지 제목 owner |
| section title | 20px / 28px | 20px / 28px | 독립 하위 section |
| 작은 card title | 16px / 24px | 16px / 24px | card heading |
| 실제 조작 영역 | 최소 44×44 CSS px | 최소 44×44 CSS px | 공통 control와 배치 owner |
| 일반 문서형 main 외곽 | 좌우28px / 상하24px | 좌우14px / 상하18px | 고객·운영자 shell content. 인증 fullscreen composition·공개·workspace frame 제외 |

기존 52px 또는 그 이상의 지도·도구 조작 영역을 44px로 축소하지 않는다. 기존 body·caption·metric scale은 승인된 역할을 재사용하며 이 표를 모든 텍스트에 적용하지 않는다.

Card와 SidePanel은 일반 내용의 `regular` inset20/16px, 목적과 소비 범위를 등록한 `compact` inset16px, 작업 공간의 geometry를 분리한다. SidePanel이라는 태그만으로 일반 정보 내용을 geometry 예외로 만들지 않는다. loaded/pending/error/empty는 같은 page/section wrapper와 역할을 소비하며 상태 전환에 따른 임의 여백 변화를 만들지 않는다. 상태 분기와 query 조건은 유지한다.

통계 개요·분석의 `MetricCard`와 `EnergyRankingDetailPanel` 안의 테두리가 있는 두 지표 카드는 같은 일반 정보 카드 역할이다. 세 소비자가 기존 `panelPaddingClass("regular")`를 명시적으로 사용하며, 상세의 두 형제 카드도 `CardGrid`18px를 사용한다. 중첩됐다는 이유로 chart geometry 예외가 되지 않는다. 카드 내부 gap·metric28/34px·전체 숫자/단위와 chart margin/높이는 보존한다. 다른 호출자의 호환을 위해 `MetricCard` 자체의 미전달 기본 inset16px는 바꾸지 않는다.

외부 여백은 shell이, section 리듬은 해당 section 부모가, card grid는 grid 부모가, 카드 내부는 Card가 소유한다. feature가 shell padding을 중첩해 보상하지 않는다. 값이 같은 row gap과 section gap은 역할이 다르다. field label/description, form 행, toolbar의 아이콘·label gap은 현재 승인 scale에서 콘텐츠 관계에 맞게 공통 form/toolbar가 소유하며, 모든 `gap`을 20px 또는 18px로 치환하지 않는다. compact 정보 카드의 16px 고정 inset처럼 독립된 역할만 예외 등록 후 허용한다.

`headingLevel`은 문서 구조를, `titleRole`은 시각적 크기를 결정한다. h2/h3를 썼다는 이유로 page title 크기를 주지 않는다. page/section/card 역할을 공통 제목 API에서 구분하고 동일 역할의 형제 제목은 같은 표현을 쓴다. route마다 page h1 owner 하나를 명시한다. 표시 크기를 맞추기 위해 문서 heading 구조를 바꾸지 않는다.

## 정확한 값 검토표

px 환산은 root16px 기준이며 사용자 font 설정·확대를 막는 전역16px 강제는 추가하지 않는다. 아래에서 ‘유지’는 현재 source의 역할·값을 보존한다는 뜻이고, ‘통일 목표’는 승인된 소비자 정합화 값이다. 운영자 기존 main24/32px·mobile14/24px는 일반 문서형 main28/24px·mobile14/18px로 통일할 대상이다.

| 구분 | 역할 | 크기 / 행간 / 굵기 | 결정 |
| --- | --- | --- | --- |
| 제목 | page desktop / compact | 26px / 35.1px(1.35) /700 · 24px /32px /700 | 통일 목표; customer-page-title와 기존 section-title 재사용 |
| 제목 | section / 작은 card | 20px /28px /700 ·16px /24px /700 | 통일 목표; customer-section/card-title 표현 재사용 |
| 본문 | body-lg / body / body-sm | 16/24/400 ·14/22/400 ·13/20/400 | 유지 |
| 보조 | label / caption / overline | 12/18/600 ·12/18/400 ·11/16/700 | 유지; caption을 필수 본문 대용으로 축소하지 않음 |
| 지표 | 고객 desktop / compact · 일반 | 30/39/700 ·28/34/700 ·28/34/700 | 유지; tabular-nums |
| 일반 font | 기본·고객·인증·운영자 | `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | `styles/base.css:210` 유지 |
| 브랜드 font | 공개 | `Inter, "Pretendard", "Noto Sans KR", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | `--font-landing` 유지 |
| 공개 hero | 제품 home만 | `clamp(55px,5.3vw,78px)` /1.15 /자간−0.085em /850 | 승인 브랜드 유지; concept의100px 상한과 혼합 금지 |
| frame | operator / auth / public | max1160 /960 /1180px | 목적 frame 유지; auth 소개2열/compact1열 |
| 공개 header | 기본 / stacked≤720px | min82 /96px | 유지;430/720/1050px 포함형 경계 |

색상 source는 `apps/web/src/styles/theme.css`, 고객 alias는 `apps/web/src/styles/base.css`다. 기본은 고객 marker 없는 공개·인증·운영자의 semantic fallback이며 브랜드 고유색과 다른 역할이다.

| semantic 역할 (`--color-` 접두사) | 기본 | 고객 light | 고객 dark |
| --- | --- | --- | --- |
| surface-canvas | #F4F8FA | #F4F7FB | #0F1724 |
| surface-panel / elevated | #FFFFFF | #FFFFFF | #182334 |
| surface-inset | #F1F5F9 | #EEF2F8 | #1E2D44 |
| surface-inverse | #172033 | #0F1724 | #000000 |
| content-primary | #15324A | #152C43 | #EAF1FA |
| content-secondary / muted | #64748B / #73839A | #526477 / #526477 | #B0BDCE / #B0BDCE |
| content-inverse | #FFFFFF | #FFFFFF | #FFFFFF |
| content-disabled | #94A3B8 | #526477 | #B0BDCE |
| border-subtle / default | #E2E8F0 / #DBE7F5 | #D8E1EC / #D8E1EC | #33465D / #33465D |
| border-strong | #CBD5E1 | #7B8B9C | #647C98 |
| border-focus | #256FA1 | #245FE8 | #94B9FF |
| border-disabled | #CBD5E1 | #D8E1EC | #33465D |
| action-primary | #256FA1 | #245FE8 | #94B9FF |
| action-primary-hover | #1D5C86 | #194BC0 | #B3CEFF |
| action-primary-active | #1D5C86 | #153C99 | #CCE0FF |
| action-primary-foreground | #FFFFFF | #FFFFFF | #0F1724 |
| action-primary-soft | #E8F2F8 | #E9F0FF | #263D68 |
| action-secondary | #FFFFFF | #FFFFFF | #182334 |
| action-disabled | #F1F5F9 | #EEF2F8 | #1E2D44 |
| status-success foreground / background | #15803D / #ECFDF3 | #187445 / #E7F4EC | #70D6A4 / #1C3834 |
| status-warning foreground / background | #B45309 / #FFFBEB | #946000 / #FFF4DE | #F2C46D / #3A3225 |
| status-danger foreground / background | #DC2626 / #FFF1F2 | #B4233C / #FFF0F3 | #FF91A5 / #392536 |

ブランド navy#15324A・blue#256FA1・coral#FF7A5C・paper#F4F8FA는 유지한다. 고객 primary 글자에는 action-primary-foreground를 사용하며 dark에서도 흰색인 content-inverse와 혼동하지 않는다. 비고객 Button의 기존 inverse 소비는 보존한다. 위 status 쌍은 semantic 상태값이며 badge/feedback 전용 역할을 덮어쓰지 않는다. feedback info foreground/background 기본#0B63E5/#E9F2FF, light#245FE8/#E9F0FF, dark#94B9FF/#263D68; success foreground 기본#166534/light#187445/dark#70D6A4; warning foreground/background 기본#92400E/#FFF7E6, light#946000/#FFF4DE, dark#F2C46D/#3A3225; danger foreground 기본#991B1B/light#B4233C/dark#FF91A5를 각각 유지한다.

팔레트 유지가 모든 조합의 AA 통과를 뜻하지 않는다. FormField help는 기본 secondary가 canvas에서 약4.45:1이어서 primary를 쓰는 기존 보정·주석을 유지한다. 실제 배경·opacity 합성·역할 조합을 검사하고 실패하면 승인된 적합 role로 대체 가능한지 확인한다. 새 색/token이 필요할 때만 한정 승인으로 분리하며 AA 기준을 낮추지 않는다.

| primitive | 현재 정확한 계약과 결정 | source (`apps/web/src/components/ui` 기준) |
| --- | --- | --- |
| Button 일반 | min폭44·min높이44, gap8, border1, radius10,700. sm inset좌우12/상하0·13/20; md16/0·14/22; lg min높이48·24/8·16/24 유지. 더 큰 caller geometry 우선 | `Button.tsx` |
| disabled/loading | 기본 opacity60%, disabled/aria-busy·중복 activation 차단 유지. action-disabled token을 실제 fill로 일괄 치환하지 않음 | `Button.tsx`, loading primitive |
| field | min높이44(lg48); sm inset12/8, md12/10, lg16/12. coarse pointer 글자16/24 유지(viewport와 구분) | `fields/field-types.ts`, field primitive |
| field 관계 | label/control/help gap8, label primary, help primary, error danger 유지 | `fields/FormField.tsx` |
| icon control | IconButton min44·aspect-square·padding8; IconTooltipButton 기본52/sm44·icon18 유지 | `IconButton.tsx`, `IconTooltipButton.tsx` |
| FilterPanel | inline 관계gap12/compact8; popover fields gap16/compact12 유지 | `FilterPanel.tsx:39–66` |
| option / 표 | Select option min44·gap4; DataGrid cell inset좌우16/상하12, compact12/8 유지 | `fields/SelectBox.tsx`, DataGrid 하위 table primitive |
| radius | control10, panel/popover14 유지; 브랜드 geometry와 DataGrid header 예외는 별도 | `styles/theme.css` |
| motion | 일반Button 전역duration 추가 없음; popover/sheet200ms, spinner1s linear, reduced-motion에서 해당 animation 없음 유지 | overlay/loading primitive |
| 브랜드 motion | public action200ms ease·hover translateY(−2px), header250ms 유지 | `Button.tsx`, `public-site/SiteFrame.tsx` |

form row gap·icon size·전역 duration을 하나의 새 숫자로 강제하지 않는다. 위 목적 primitive 계약과 일반 section/card 역할을 구분한다. 원본 source 근거는 정적 대조이며 현재 브라우저 검증 완료가 아니다.

## 공통 source와 소비 API

토큰의 단일 source는 `apps/web/src/styles/theme.css`의 CSS-first `@theme static`이다. 재사용 Button, Card, Typography, form, feedback, loading, navigation, DataGrid, overlay는 `apps/web/src/components/ui`에 모은다. feature별 복사본·별도 CSS source·광범위 selector로 공통 API를 우회하지 않는다.

색은 semantic surface/content/border/action/status 역할을 소비하고 고객 theme alias가 지원 light/dark를 결정한다. 기존 브랜드 팔레트는 유지한다. 기본 control radius10px, panel radius14px는 현재 `--radius-control`/`--radius-panel`을 사용하며 브랜드의 등록된 geometry는 별도 variant다. 본문 font는 기존 승인 scale을 재사용한다. hover/focus/disabled/error/loading 표현은 공통 primitive가 소유하고 feature가 같은 상태를 개별 재정의하지 않는다.

현재 고객 compact 승인 anchor는 `e841c57b11321a5ae35d15920031020089f06ee2`이며 실제 PostCSS AST는738선언이다. 향후 토큰 추가나 anchor 회전은 이번 통일 작업의 승인이 아니다. 기존 역할로 표현 가능하면 재사용한다. 새 역할이 필수면 의미·정확 값·소비 범위·기존 역할로 표현 불가한 이유를 제출하고, 토큰 전용 변경의 독립 검토 후 정확한 승인 ref와 빈 baseline을 함께 회전한다. 규칙 완화, allowance 증가, lexical 검사 밖 CSS나 인라인 값으로 우회하지 않는다.

공통 소비 API는 `PageStack`의 section 간격20px, `CardGrid`의 card 간격18px, `Card`·`SidePanel`의 `padding="regular"`20/16px·`compact`16px·`none`무padding이다. 기존 `customer`는 `regular`와 같은 alias이며 기본 padding은 계속 `none`이다. `PageHeader`의 명시적 `titleRole="page" | "section" | "card"`는 위 시각 역할을 사용한다. 미전달 시 기존 `variant="customer"`의 page 표현과 default의 legacy section 표현을 유지한다. `headingLevel`, ref·aria/data·rest props, Card tone/variant와 SidePanel surface는 호환을 유지한다. 열 수·반응형 배치는 소비 부모가 소유한다.

`AccountSecurityView`는 customer/operator의 presentation을 shell에서 명시적으로 전달받는다. shell이 page title과 외부 여백을 소유하고, 공유 view는 presentation에 대응하는 공통 Card·Typography를 소비한다. 고객과 운영자의 일반 card 수치는 위 functional 계약을 공유하며 presentation이 임의 숫자 차이를 만드는 허가가 아니다. presentation은 theme scope·구성 경계만 표현한다. MFA 권한, principal, query key, cache 교체, 비밀 입력 수명과 API는 기존 도메인 로직을 유지한다.

## 작업 공간·반응형·내용 보존

지도·floor editor·표·drawer의 geometry는 일반 panel 여백과 구분한다. shell 높이 전달, `min-h-0`/size containment, scroll owner와 원본 CAD/도형 색, pointer 좌표, scale·선택·열린 이력·dirty draft를 보존한다. floor editor의 최소 256px와 수동 지도 실제 content width 588px 미만 split을 유지한다. viewport 폭으로 content 경계를 대체하지 않는다.

공개는 현재 포함형 `landing-narrow` 430px, `landing-stack` 720px, `landing-wide` 1050px를 유지한다. 앱 760px 미만 규칙과 합치지 않는다. public-brand의 승인 font fallback 순서·넓은 장면·fluid hero·normal/reduced-motion 상태를 보존한다. 일반 control의 사용성은 이 variant 안에서도 검증한다.

긴 한국어 이름·이메일·UUID·큰 수치·단위·오류·목록을 실제 내용으로 평가한다. 높이를 맞추기 위한 정보 삭제, 임의 축소, 무조건 ellipsis, 겹침을 가리는 overflow hidden을 해결책으로 쓰지 않는다. 필요한 줄바꿈·적절한 scroll·영역 재배치를 사용하며 중요한 값과 action까지 도달할 수 있어야 한다.

## 접근성 기준

일반 텍스트는 최소 4.5:1, 적격 큰 글자는 3:1을 적용한다. 큰 글자 판단은 글자 크기와 굵기를 함께 보며 일반 18pt 또는 굵은 14pt 기준을 따른다. 20px라는 이유만으로 전부 큰 글자로 분류하지 않는다. 실제 배경과 opacity 합성값을 확인하고 경계 미달을 반올림해 통과시키지 않는다. [W3C SC 1.4.3 설명](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

필수 UI 식별·상태와 의미를 전달하는 graphic은 인접 색 대비 3:1을 확인한다. 장식 면 전체에 기계적으로 적용하거나 상태를 색만으로 전달하지 않는다. [W3C SC 1.4.11 설명](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)

프로젝트의 실제 hit 영역 44×44px는 내부 사용성 정책이다. WCAG 2.2 AA target minimum은 24×24px 또는 규정된 간격·예외 조건이며, 44×44px는 enhanced 기준이다. 프로젝트44를 AA의 보편 의무라고 설명하지 않는다. inline link 등 목적상 다른 대상은 정확한 예외 근거를 등록하고 키보드와 포인터 접근을 확인한다. [AA minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [enhanced](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html)

keyboard 순서·visible focus·label·상태 announcement·pending 중 재입력/중복 제출 제한·modal 최초 focus/Escape/복귀를 보존한다. bbox 크기만으로 hit 성공을 주장하지 않고 clip·가림·원형 모서리·실제 tap을 확인한다. reduced-motion에서 최종 정보와 조작이 남아야 한다.

## 예외 등록과 승인 흐름

예외에는 이름, 이유, 정확한 소비 범위, 값 또는 geometry, 보존할 행동, 검증 방법·근거, 승인 상태를 기록한다. 과거 구현값을 그 자체로 예외 근거로 삼지 않는다. 일반 기능 UI의 기존 op/auth inset24/28px 등을 묶어 보존하는 포괄 예외는 허용하지 않는다.

| 명시적 variant/예외 | 이유·소비 범위 | 보존 행동·검증 |
| --- | --- | --- |
| public-brand composition | 공개 3page의 브랜드 이야기와 기존 승인 hero/font/landing card 본연 geometry | 장면·포함형 breakpoint·anchor·motion 비교. 상담 modal의 일반 내용은 functional inset 준수 |
| auth-composition | 로그인 소개+form, 강제 변경의 집중 배치 | credentials/MFA/recovery/강제 변경 접근·keyboard 검증. 일반 panel은 functional 준수 |
| operator content frame | 운영 navigation과 목록의 최대1160px 구성 | table/card 전환·action·가로 읽기 폭 검증. 내부 card의 임의 inset 예외 아님 |
| statistics-mobile rhythm | `StatisticsShell.tsx:10`의 compact gap8px. 좁은 통계 작업 공간의 승인 압축 | desktop은 일반 section 규칙 적용. mobile 내용 접근·수치·탭·scroll 검증 |
| monitoring-fullview frame | `MonitoringView.tsx:331`의 전체 보기 gap8px, `CustomerShell.tsx:358`의 전체 보기 shell inset mobile8/desktop12px. 지도에 작업 높이 제공 | 일반 MonitoringView section은20px로 정합화. 진입/복귀·Escape·지도 상태·유효 높이 검증 |
| DataGrid sort hit-shape | `DataGrid.tsx:114`의 정렬 header `rounded-none`. 모서리가 연속44px hit를 깎지 않도록 유지 | 실제 연속44×44 hit·정렬·keyboard 검증. 일반 control radius 예외로 확장하지 않음 |
| workspace geometry | 고객 지도·floor editor·chart 내부 geometry. editor 최소256px, 수동 지도 content588px split | 320×600/587·588·589px의 pointer·선택·단일 scroll·데이터 의미 보존 |
| overlay frame | dialog/drawer의 backdrop·최대폭·viewport 배치·safe-area·단일 reader·기존52px 닫기·focus·pending | 일반 modal/drawer 내용은 functional panel20/16px로 정합화. frame 계약을 일반 inset 불일치의 포괄 예외로 쓰지 않음 |

위 source는 `apps/web/src/features/statistics/StatisticsShell.tsx`, `apps/web/src/features/monitoring/MonitoringView.tsx`, `apps/web/src/features/shells/CustomerShell.tsx`, `apps/web/src/components/ui/DataGrid.tsx`다. 수치·소비 범위는 소스와 대조한 보존 계약이며 해당 소비 화면의 현재 브라우저 판정은 [coverage](assets/web-design-system-2026-10-16/coverage.md)를 따른다. DataGrid의 구역·사용자·층·보고서·운영로그 다섯 populated 소비자는 개별 검사하며, container/열 최소폭과 frame으로 실제 table/card를 구분한다. 새 예외는 designer·web_frontend가 근거를 검토하고 총괄 승인 후 좁게 적용한다. 토큰 변경이면 별도 토큰 승인 경로도 통과한다. 미확인 소비자를 무조건 예외로 넣지 않고 적용 coverage에서 미확인으로 남긴다.

## 검증과 변경 완료

lexical 정책 0건은 필요한 gate지만 역할 적합성과 화면 통일의 충분조건이 아니다. 소비 역할 목록, 실제 generated CSS/computed 값, 내용의 Range/box, keyboard/tap/wheel/focus와 상태별 시각 검증을 함께 사용한다. 미실행·실패·보류와 지원하지 않는 환경은 그대로 기록한다. 운영 배포·실제 API·메일·native·장비/HIL은 별도 증거 없이는 완료로 표시하지 않는다.

2026-10-16 승인된 [실행 계획](superpowers/plans/2026-10-16-web-design-system-unification.md)에 따라 공통 기반과 소비 표현을 적용했다. 미전달 legacy 제목·Card tone/variant/customer/none·SidePanel surface는 호환을 유지한다. [coverage](assets/web-design-system-2026-10-16/coverage.md)는 고객12leaf/15surface·operator4·auth gate/state·public3×actual entry3·overlay/recovery/bootstrap/404와 HTML14 경계를 추적한다. 정책0/0, 실제 computed·조작, 대표 PNG, raw 대비와 단위 실패 판정을 구분하며 existing-but-unexecuted 조건부 mount는 N/A로 바꾸지 않는다. 전체 Web 실패와 CAD 원인 미확정·실제 native/운영/HIL 한계가 남으면 전체 GREEN 또는 모든 상태 완료로 발표하지 않는다.

최신 검증(2026-10-18 기존 브랜치 통합 후): 실제 main `d87a1901`에서 단독 전체 Web3,939PASS/0FAIL/기존3SKIP(266파일·47.05초)를 확인했다. 전체 안전 Chromium229는225actualPASS+의도된차단FAIL3+예상밖foundation cleanup timeout1(373.614705초)로 브라우저 gate는 FAIL이다. body의1440px 마지막단언과page.close 뒤 메모리서버정리가 대기했으며 정확한 연결원인은 미확정이다. 추가진단은 선택오류로0개실행되어 해결증거가 아니다. inventory38/CAD8, 정적랜딩 기본/QA각6PASS, public landing각5PASS+기존모드3SKIP/service각8PASS, 타입·확장E2E타입·빌드·UI정책79/위반0·계약6+3·907source/runner불변은 확인했다. 병합은 승인Web과대상API·다른작업의미커밋원문을 보존했고, 전체GREEN·실backend/장비/native·전상태시각인증은 아니다. [새 원증거·실패·한계](assets/web-design-system-2026-10-16/coverage.md#2026-10-18-기존-브랜치-통합-후-새-검증)를 따른다.

이전 검증 이력(2026-10-18 후속 최종 보완): 공개 spec의 config 유도 loopback origin, CAD finally의 browserErrors 관문, foundation setup부터 page→server 정리·원 오류 보존을 test-only로 보완했다. 최종 source의 단독 전체 Web은3,939PASS/0FAIL/기존3SKIP(266파일·51.36초)이다. 이번 집중 CAD8+foundation7은15actualPASS이며, 정적 랜딩 기본15185/QA15342 각각6PASS, public landing 기본5187/QA15342 각각5PASS+기존 서비스 전용3SKIP, public service 각각8PASS를 확인했다. 타입/E2E타입·빌드·UI정책79PASS/위반0·landing6/public3 계약과907source·runner hash 전후 일치를 확인했다. 확장 E2E 타입 검사가 드러낸 기존 runner union TS2349는 exact FIX_BASE 가상 소스로10건을 재현한 뒤 type-only 선언으로 수리했고 runtime 선택과 안전 fixture는 유지했다. 이전 Task8의 전체229 Chromium을 재실행한 결과가 아니며 실 backend·장비·native·모든 palette AA·후속 맵 전체 paint 인증은 아니다. 정확한 회차·원로그·한계는 coverage의 후속 최종 보완 기록을 따른다.

직전 검증(2026-10-18 Task8): Task7 h1 보완과 CAD 시험 수명 수리까지 포함한 단독 전체 Web은3,938PASS/0FAIL/3SKIP이다. 전체 안전 Chromium은229expected(실제226PASS+기존 의도된 차단FAIL3), unexpected/skip/flaky0이며 전체38소비자+inventory39 직렬 묶음·제어9·CAD8을 포함한다. 타입/E2E타입·빌드·UI정책79PASS/위반0·landing6/public3 계약도 통과했고907source hash가 검증 전후 일치했다. CAD는 regions→native scene→reviewKey 전환에서 분리된 이전 DOM을 캡처한 시험 원인을 controlled RED로 확인한 test-only 수리이며 제품 paint/권한 fence는 유지했다. 실제 backend·장비·native·모든 palette AA·후속 맵 전체 paint 인증은 아니다. 정확한 명령·원로그·한계는 coverage의 Task8 기록을 따른다.

이전 검증 이력: 2026-10-17 보완의 단독 전체 Web은3,928PASS/6FAIL/3SKIP으로 FAIL이었다. 제어5와 CAD `common=true, interruption=site`의 초기 preview-ready1이 남았고 당시 CAD focused1PASS는 원인 해결의 증거가 아니었다. Task5 principal/Task4 floor/당시 site 실패를 일괄 같은 원인으로 묶지 않는다. 결합212의 cleanup1실패와 test-only 수리 뒤62expected(실제59PASS+3의도된차단FAIL), 수명helper4unitPASS의 원 로그를 유지한다. 이는 당시212전체PASS가 아니며 위 Task8의 새로운 전체229 실행과 구분한다.

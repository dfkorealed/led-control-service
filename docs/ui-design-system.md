# Web 공통 디자인 시스템 가이드

현장 운영·시설관리 담당자가 상태·대상·조작 결과를 쉽게 읽고 편하게 작업할 수 있는 일관된 UI를 만든다. 공개 페이지는 기존 브랜드 특징을 유지한다.

상태: **검토용 초안 · 서면 승인 전 · 제품 미적용**

작성일: 2026-10-15

사용자의 “다 포함 해”, “오케이”는 전체 Web 범위와 인챗 설계 방향에 대한 승인이다. 이 문서는 그 방향을 검토할 수 있도록 작성한 초안이며, 서면 설계 승인·구현 계획 승인·코드 적용 완료를 뜻하지 않는다. 현재 유효한 규범은 [ui-spacing.md](ui-spacing.md)다. 충돌하는 제안은 이 초안으로 현재 규범을 소급 변경하지 않는다.

## 정본 전환과 책임

서면 승인은 목표 기준을 확정한다. 현재 규범 효력은 계획·실행 방식 승인 후 최초 기반 작업에서 `ui-spacing.md`의 현행 규칙 참조와 역사 분리를 함께 정리하면서 이 가이드로 전환한다. 날짜별 승인·실패·토큰 회전 기록은 역사적 근거로 표시하고, 실제 화면 적용 현황은 coverage로 별도 추적한다. 이력의 실패를 지우거나 과거 수치를 현재 검증으로 승격하지 않는다. 상태 요약은 계속 `project-status.md`, 메뉴 기능 현황은 `menus/*.md`, 운영 기준은 `agent-operations.md`가 소유한다. 이 초안 작성에서는 기존 정본을 변경하지 않는다.

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

아래는 서면 승인 이후 적용할 규칙이다. 고객뿐 아니라 운영자와 인증의 ordinary functional UI에도 같은 역할로 적용한다. viewport의 `compact` 경계는 현재 760px를 유지하며 `max-compact`는 760px 미만이다.

| 역할 | desktop | compact | 소유자 |
| --- | --- | --- | --- |
| 독립 section 사이 | 20px | 20px | section을 배치하는 부모 |
| 동급 card grid | 18px | 18px | grid 부모 |
| 일반 panel inset | 20px | 16px | 공통 Card의 명시적 padding 표현 |
| page title | 26px / 1.35 | 24px / 32px | 페이지 제목 owner |
| section title | 20px / 28px | 20px / 28px | 독립 하위 section |
| 작은 card title | 16px / 24px | 16px / 24px | card heading |
| 실제 조작 영역 | 최소 44×44 CSS px | 최소 44×44 CSS px | 공통 control와 배치 owner |

기존 52px 또는 그 이상의 지도·도구 조작 영역을 44px로 축소하지 않는다. 기존 body·caption·metric scale은 승인된 역할을 재사용하며 이 표를 모든 텍스트에 적용하지 않는다.

Card와 SidePanel은 일반 내용의 `regular` inset20/16px, 목적과 소비 범위를 등록한 `compact` inset16px, 작업 공간의 geometry를 분리한다. SidePanel이라는 태그만으로 일반 정보 내용을 geometry 예외로 만들지 않는다. loaded/pending/error/empty는 같은 page/section wrapper와 역할을 소비하며 상태 전환에 따른 임의 여백 변화를 만들지 않는다. 상태 분기와 query 조건은 유지한다.

외부 여백은 shell이, section 리듬은 해당 section 부모가, card grid는 grid 부모가, 카드 내부는 Card가 소유한다. feature가 shell padding을 중첩해 보상하지 않는다. 값이 같은 row gap과 section gap은 역할이 다르다. field label/description, form 행, toolbar의 아이콘·label gap은 현재 승인 scale에서 콘텐츠 관계에 맞게 공통 form/toolbar가 소유하며, 모든 `gap`을 20px 또는 18px로 치환하지 않는다. compact 정보 카드의 16px 고정 inset처럼 독립된 역할만 예외 등록 후 허용한다.

`headingLevel`은 문서 구조를, `titleRole`은 시각적 크기를 결정한다. h2/h3를 썼다는 이유로 page title 크기를 주지 않는다. page/section/card 역할을 공통 제목 API에서 구분하고 동일 역할의 형제 제목은 같은 표현을 쓴다. route마다 page h1 owner 하나를 명시한다. 표시 크기를 맞추기 위해 문서 heading 구조를 바꾸지 않는다.

## 공통 source와 소비 API

토큰의 단일 source는 `apps/web/src/styles/theme.css`의 CSS-first `@theme static`이다. 재사용 Button, Card, Typography, form, feedback, loading, navigation, DataGrid, overlay는 `apps/web/src/components/ui`에 모은다. feature별 복사본·별도 CSS source·광범위 selector로 공통 API를 우회하지 않는다.

색은 semantic surface/content/border/action/status 역할을 소비하고 고객 theme alias가 지원 light/dark를 결정한다. 기존 브랜드 팔레트는 유지한다. 기본 control radius10px, panel radius14px는 현재 `--radius-control`/`--radius-panel`을 사용하며 브랜드의 등록된 geometry는 별도 variant다. 본문 font는 기존 승인 scale을 재사용한다. hover/focus/disabled/error/loading 표현은 공통 primitive가 소유하고 feature가 같은 상태를 개별 재정의하지 않는다.

초안 기준 현재 고객 compact 승인 anchor는 `e841c57b11321a5ae35d15920031020089f06ee2`이며 당시 실제 PostCSS AST는 738선언이다. 이는 현재 승인 사실이며, 향후 토큰 추가나 anchor 회전을 이 초안으로 승인하는 것이 아니다. 기존 역할로 표현 가능하면 재사용한다. 새 역할이 필수면 의미·정확 값·소비 범위·기존 역할로 표현 불가한 이유를 제출하고, 토큰 전용 변경의 독립 검토 후 정확한 승인 ref와 빈 baseline을 함께 회전한다. 규칙 완화, allowance 증가, lexical 검사 밖 CSS나 인라인 값으로 우회하지 않는다.

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

위 source는 `apps/web/src/features/statistics/StatisticsShell.tsx`, `apps/web/src/features/monitoring/MonitoringView.tsx`, `apps/web/src/features/shells/CustomerShell.tsx`, `apps/web/src/components/ui/DataGrid.tsx`다. 수치·소비 범위는 현재 소스와 대조한 보존 계약이며 이 초안에서 브라우저 재검증한 결과가 아니다. 새 예외는 designer·web_frontend가 근거를 검토하고 총괄 승인 후 좁게 적용한다. 토큰 변경이면 별도 토큰 승인 경로도 통과한다. 미확인 소비자를 무조건 예외로 넣지 않고 적용 coverage에서 미확인으로 남긴다.

## 검증과 변경 완료

lexical 정책 0건은 필요한 gate지만 역할 적합성과 화면 통일의 충분조건이 아니다. 소비 역할 목록, 실제 generated CSS/computed 값, 내용의 Range/box, keyboard/tap/wheel/focus와 상태별 시각 검증을 함께 사용한다. 미실행·실패·보류와 지원하지 않는 환경은 그대로 기록한다. 운영 배포·실제 API·메일·native·장비/HIL은 별도 증거 없이는 완료로 표시하지 않는다.

서면 설계 검토와 승인 이후 writing-plans에서 파일별 작업·테스트·검토 순서를 구체화하고 계획 승인과 실행 방식 선택을 받는다. 본 문서는 실행 명령별 계획이 아니며 지금 제품 적용을 시작하는 허가가 아니다.

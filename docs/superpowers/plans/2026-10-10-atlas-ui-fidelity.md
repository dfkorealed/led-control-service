# ATLAS 전체 UI 충실도 교정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 compact 목업과 사용자 수정 의견을 고객 네 메뉴·상세 UI에 일관되게 적용하고, 필요한 검증 후 별도 브랜치를 로컬 병합한다.

**Architecture:** 기존 React Aria·semantic token·기능 owner를 유지하며 고객 전용 표현 계약을 먼저 정한다. UI/UX 담당이 공통 기준을 소유하고 페이지 담당이 동일 계약을 소비한다. 데이터·권한·명령/편집 수명은 바꾸지 않는다.

**Tech Stack:** React, TypeScript, React Aria Components, Tailwind CSS 4, TanStack Query, Vitest, Playwright, pnpm 9.15.0, Node.js 22.

**Spec:** [기존 승인 명세](../specs/2026-10-07-atlas-ui-refresh-design.md), [전체 감사 정본](../../assets/atlas-ui-refresh-2026-10-07/audit-2026-10-10/README.md). 세부 source·보존 조건은 감사의 공통/메뉴 보고서이며 아래 과제의 일부다.

상태: 사용자 2026-10-10 “진행해줘. 각 페이지의 에이전트 세션과도 협업해.”로 계획 검토 완료. 격리 브랜치에서 Task1 공통 기반부터 구현을 시작한다. 페이지/디자이너 협업과 LEAN 검증·로컬 병합 방법을 유지하며 다시 선택하지 않는다.

## Global Constraints

- 기준 `b1dd36eed1e9dd41663d17cdf94379360e539fb4`, 격리 `codex/atlas-ui-fidelity-20261010` / `.worktrees/atlas-ui-fidelity-20261010`, 병합 대상 `codex/mvp1-cloud-web`.
- 고객 모니터링·제어·통계·설정 및 상세 UI가 범위다. 공개·로그인·운영자는 신규 디자인 제외, 기존 동작/기본 표현 보존.
- `max-compact`는 760px 미만. 모바일 로고, 현장 선택 360px 미만 128px/그 이상 144px, 최소 hit 44px, 기존 더 큰 지도 hit 유지.
- 도면 상태는 라벨14px/수치16px 인라인. 도구는 지도 상단, footer는 legend+camera 한 줄의 일반 flow이며 canvas 위 absolute overlay가 아니다.
- PC manual 외부 세로 스크롤 없음. 1024×600에는 실제 map viewport 최소240px과 필요 내부 workspace 스크롤을 유지한다. 모바일 자연 스크롤·직접 보이는 도구/밝기/적용 유지.
- 기본 light, 저장 키 `led-control.customer-theme.v1`, 기존 root alias·cross-tab·저장 실패 fallback 유지. theme로 route/query/command/editor/MFA를 remount하지 않는다.
- API·DB·공유 schema·Gateway·펌웨어·실장비·배포·remote push/PR 변경 없음. fake 도면/수치/필터/보고서/센서 기능을 이식하지 않는다.
- 기존 palette와 canonical token 값 보존. typography 신규4선언만 검토 후 추가하고 정확한 token commit으로 policy anchor를 회전한다. baseline/native/literal/selector 예외는 늘리지 않는다.
- 총괄은 보고서 취합·계획/상태 갱신·통합에 집중한다. 공통 완료 뒤 페이지 담당에 전달하며 공유 파일의 동시 구현은 금지한다. 메뉴 현황 문서는 코드와 같은 작업에서 5개 기존 구성을 유지한다.
- 실행 속도 보완(범위·검증량 불변): 공통Tasks1–4를 고정한 후 파일 집합이 분리된 네 메뉴 owner는 각각 별도 worktree/branch로 실행할 수 있다(모니터링Task5, 제어Task6, 통계Task7, 설정Tasks8–10은 내부 순차). 같은 checkout에는 writer 한 명, 공통/API/타 메뉴/계획 파일 수정은 금지한다. 동시 세 페이지까지 실행하고 먼저 끝나는 slot에 설정을 이어가며 총괄이 파일 범위·보고서·commit을 대조해 교정 브랜치에 순서대로 통합한다. 설정의 계획된 RegistrationPanel/편집기 소비자 수정은 설정 owner만 소유한다. 공유 계약 변경이 필요하면 페이지 writer가 멈추고 총괄에게 반환한다.
- 사용자 LEAN 요구: 새 동작/계약은 focused RED→GREEN, 순수 스타일 mirror test 금지. 변경 관련 unit과 마지막 Web 정책/타입/빌드·제한 브라우저 확인만 실행. 토큰 승인 외에는 최종 통합 리뷰 한 번으로 묶고 전체 583/Lab/canonical/HIL은 실행하지 않는다.

## Review Focus

1. 긴 이름·320px·759/760px·다크 portal: 로고/선택/현재 메뉴/CTA가 잘리지 않고 focus·44px hit를 유지한다(Task2/3/11).
2. 선택·draft·theme·resize·filter: 추가 쓰기 요청0, 기존 canvas/명령/편집/MFA owner identity와 미저장 입력 유지(Task4/5/9/10/11).
3. null·실제0·음수 절감·기간 불일치: 가짜 성공/최소 양수 bar/기간 합성 없이 실제 의미 표시(Task7).
4. 1024×600·오프라인·긴 실패/복구·잠금: 외부 scroll 차단이 행동/안내를 숨기지 않음(Task5/11).
5. 공통 default 소비자·readonly·overlay 닫기: 비고객/Setup 기본 동작, 원 trigger focus 복귀, editor lease/dirty guard 유지(Task3/4/8/9/10).

## 파일·소유 경계

공통 owner는 `apps/web/src/components/ui`, 지도 공통은 `features/floor-map`, 고객 shell은 `features/shells`다. 메뉴 owner는 기존 `features/{monitoring,control,statistics,settings}`를 유지한다. 새 파일은 아래 명시한 공통 NavigationCard/recipe, 현장 편집 dialog, readonly preview, focused 검증에 한정한다. 기존 큰 기능 store/API를 표현 교정 때문에 재작성하지 않는다.

---

### Task 1: 고객 typography 토큰·정책 계약

**Files:** 수정 `apps/web/src/styles/theme.css`, `apps/web/scripts/ui-policy.mjs`, `apps/web/scripts/ui-policy.test.mjs`, `docs/ui-spacing.md`; 생성 `apps/web/src/components/ui/customer-typography-tokens.test.ts`.

**Interfaces:** 신규 `--text-customer-page-title: 1.625rem`, `--text-customer-page-title--line-height: 1.35`, `--text-customer-metric: 1.875rem`, `--text-customer-metric--line-height: 1.3`. 기존 이름→값 전수 불변, palette 추가 없음.

- [x] **Step 1:** 격리 dependency 준비(`pnpm install --frozen-lockfile`, `pnpm workspace:prepare`), 기존 서버/다른 worktree 출력은 수정하지 않는다.
- [x] **Step 2:** token 계약 RED: 신규4 값 정확 일치, 기존 승인 AST의 각 이름/값 불변, 고객 shadow/alias 경계 유지를 assert한다.
- [x] **Step 3:** 해당 테스트만 실행하여 신규 token 부재로 실패함을 확인한다.
- [x] **Step 4:** 네 선언만 추가한 token-only commit을 만든다. 실제 AST 개수를 기록하며 과거734+4를 무조건 현재 개수로 쓰지 않는다.
- [x] **Step 5:** UI/UX 담당의 token-only 독립 검토 뒤 그 exact commit으로 anchor를 회전하고 policy test·spacing 문서에 의도/고객 compact 예외를 기록한다.
- [x] **Step 6:** token test와 `pnpm --filter @led-control/web test:ui-policy`, `ui:check` GREEN을 확인하고 정책/doc commit. 중간 stale-anchor 실패는 최종 정책 PASS로 기록하지 않는다.

실행 증거: token `e841c57b` 독립 승인, 정책/doc `ef9b52c9`. 신규6 PASS/정책79 PASS/UI0·0, baseline debt 추가0·삭제0. 최초 classifier 충돌1 FAIL은 승인 typography 분류 교정 뒤 동일 범위에서 해소했으며 신규 계약과 구분해 기록했다.

### Task 2: 공통 고객 표현 컴포넌트

**Files:** 수정 `components/ui/{Typography,PageHeader,Card,Button,UnderlineNavigation,FilterPanel,DataGrid,SidePanel}.tsx`, `components/ui/index.ts`, `components/ui/operations/{InlineStatusSummary,RecentActivityTicker}.tsx`, `components/ui/fields/Slider.tsx`; 생성 `components/ui/NavigationCard.tsx`, `components/ui/navigation-item-recipe.ts`, `components/ui/CustomerPresentation.test.tsx`. 모든 경로는 `apps/web/src/` 상대다.

실행 중 확인한 필수 소비자 확장: `components/ui/utils/{cn.ts,cn.test.ts}`에서 승인된 `customer-page-title`/`customer-metric` 두 semantic text 이름만 additive 등록한다. 등록이 없으면 클래스 병합기가 크기를 색상으로 오인한다. 기존 entries/merge 정책은 불변이며 크기+foreground 조합·responsive size 교체를 focused 검증한다. Task1 token-only의 cn 불변과 별도다.

**Interfaces:**

- Typography variant: `customer-page-title | customer-section-title | customer-card-title | customer-metric`. page=26px/mobile24px, section=기존20px, card=기존16px, metric=30px/mobile28px. 기존 variant 유지.
- `PageHeaderProps.variant?: "default" | "customer"`, `headingLevel` 유지. customer page header는 위 page-title을 소비한다.
- `CardProps.padding?: "none" | "customer"` default none. 고객 inset20px/mobile16px.
- `UnderlineNavigationProps.variant?: "default" | "customer"`; `navigationItemClass({active, variant}): string`를 NavLink/button tabs가 공통 소비. customer soft pill, default 기존 underline.
- `NavigationCardProps`: `to: To; icon: ReactNode; title: string; description?: ReactNode; summary?: ReactNode`와 기존 Link의 접근성 속성. 단일 전체 Link, 가로 inset icon, 중첩 interactive 없음.
- `FilterPanelProps.triggerLabel?: string` default 필터, count0 badge 숨김/실제 count 유지. `RecentActivityTickerProps.title?: string` default 최근 이력, PC visible/mobile sr-only.
- `SidePanelProps.surface?: "card" | "plain"` default card, embedded plain은 중복 경계 제거. `SliderProps.presentation?: "field" | "bare"` default field, bare는 외곽 input 경계 없이 실제 label/설명/오류/ARIA·큰 thumb hit 유지.
- Button과 DataGrid는 기존 고객 theme scope에서만 soft/neutral 표현을 적용한다. 기본 비고객 표현은 불변.

- [x] **Step 1:** 새 opt-in/default 계약 테스트를 작성: 단일 link, caller children/ARIA/ref 유지, default 불변, 필터0 badge 없음/양수 count 표시, bare slider label·keyboard 유지.
- [x] **Step 2:** `CustomerPresentation.test.tsx`와 변경된 기존 FilterPanel/RecentActivityTicker/Slider 계약의 해당 case만 RED 확인.
- [x] **Step 3:** 공통 recipe/variant 구현. 본문 desktop `px-7 py-6`, mobile `px-3.5 py-4.5`, 직계 section gap20px, card grid18px, inset20/16px를 공통 소유한다.
- [x] **Step 4:** 동일 targeted 계약 GREEN; 변경한 Typography/DataGrid/InlineStatusSummary 기존 suite를 한 번 실행한다.
- [x] **Step 5:** S3–S6/S9–S12 처리·기본 소비자 보존 근거를 공통 보고서에 기록하고 commit.

실행 증거: `2782a942` 공통API와 네 메뉴문서. focused13 PASS/195 filtered 제외, 변경기존3suite35 PASS. API 소비·geometry/dark 실제 확인은 후속Task3–11이며 전체suite PASS가 아니다.

후속 공통 보완 완료(`121cd277`): optional `eyebrow?: ReactNode`를 PageHeader title 위에 추가했고 운영 ATLAS / OPERATIONS·통계 ENERGY INTELLIGENCE 원문을 모든 해당 main/loading/error 분기에 소비한다. 설정은 단순 제목을 유지한다. 공통 RED1→최종33 PASS, 소비자 RED8→집중10 PASS(396비선택). 초기금지 tracking utility는 정책확장 없이 제거했다. 기존11px overline/상속자간을 사용하며 exact10px/원문자간 일치로 과장하지 않는다. 기본/ref/ARIA/단일h1 보존, 새token·페이지별wrapper0. 실제 geometry는Task11.

### Task 3: 고객 shell·제목·탭 소유

**Files:** `features/shells/{CustomerShell,CustomerHeaderSummarySlot,CustomerAccountPanel}.tsx`, `features/sites/SiteSwitcher.tsx`(필요한 표현만), `features/control/automation/ControlModeTabs.tsx`, `features/statistics/StatisticsSubnavigation.tsx`, `features/settings/{SettingsShell,SettingsSubnavigation}.tsx`, `features/settings/settings-sections.ts`, 네 메뉴 root 및 설정6개 child의 제목 소비 부분(`SettingsView`, `site/SiteOperationsView`, `users/SiteUsersView`, `registration/RegistrationSettingsView`, `floor-plans/FloorPlanSettingsView`, `security/AccountSecurityView`).

**Interfaces:** CustomerShell은 visible route h1을 제거하며 본문 PageHeader가 단일 h1/actions를 소유. `shell-current-menu` hook은 필요시 sr-only span 유지. PC site-left/실제4summary-center/alarm-theme-account-right 한 행; 모바일 기존 logo/select 첫 행+summary 둘째 행. account Link는 기존 settings/security를 사용하며 새 query/duplicate panel 없음. 설정은 `SettingsSection.pageTitle: string`을 추가하고 capability-filtered6목록의 trailing-slash 정규화 pathname을 정확히 매칭해 SettingsShell이 h1을 tabs 위에 소유한다. 제목은 설정/현장 관리/사용자 관리/조명 등록/도면 관리/계정 및 보안이다. child는 중복 제목만 제거하고 기존 description/actions를 한 본문 toolbar에 유지한다. editor 같은 상세 경로는 Shell header 없이 실제 child가 h1을 소유한다. 새 title context나 query는 없다.

- [x] **Step 1:** CustomerShell/summary/settings shell focused RED: body 단일h1, header grid 배치, 긴 현장명/summary0·unknown/capability, 기존 eager logout 실패/차단 유지를 assert.
- [x] **Step 2:** 해당 case RED 실행 후 shell/summary의 값 위 caption·neutral/statustone, sidebar inset/softactive, compact account strip 구현.
- [x] **Step 3:** 공통 customer 탭을 control/statistics/settings에 적용. monitoring 본문 제목+갱신, control 조명 제어 제목→tabs, settings6목록은 Shell h1→desktop tabs→child toolbar, statistics tabs→route h1. 모바일 설정 tabs 숨김·return/search/hash 보존, 중복 제목 제거.
- [x] **Step 4:** shell·summary·mode tabs·settings shell 기존 targeted tests GREEN. 320/390/562·759/760 및 dark 실제 geometry는 Task11 한 번에서 확인한다.
- [x] **Step 5:** 공통 S1–S4/S13 처리와 영향받은 네 메뉴 문서를 갱신하고 commit.

실행 증거: `de336545`와 네 메뉴문서. 신규RED8 FAIL/1 PASS/77filtered제외→최종4suite88 PASS. 중간 index fixture 누락1 FAIL은 fixture만 교정했다. 필요한 좁은 sidebar 소비자 `SettingsNavigationItem.tsx`도 포함했다. 실제 responsive/dark geometry는 Task11이며 source 계약 결과와 구분한다.

### Task 4: 공유 지도 상·하단 chrome

**Files:** `components/ui/maps/OperationMapPanel.tsx`, `features/floor-map/FloorMapViewport.tsx`와 각 기존 test; `features/monitoring/FloorMap.tsx`, `features/control/target-selection/SpatialTargetSelector.tsx`.

**Interfaces:** `FloorMapViewportProps.footerStart?: ReactNode` 추가. `controlsPlacement="footer"`+footerStart opt-in 때 legend-left/camera-right 한 static bar, default/overlay 소비자 불변. OperationMapPanel title/tools-left+inline summary-right, chrome inset16/12px.

- [x] **Step 1:** RED: footerStart와 camera가 동일 flow footer에 있고 viewport/children identity가 동일하며 기본 소비자 placement 불변.
- [x] **Step 2:** 두 공유 map test의 새 case를 실패 확인하고 인터페이스 구현.
- [x] **Step 3:** monitoring/manual 소비자가 기존 legend를 footerStart로 전달하고 중복 legend strip 제거. manual 도구 gesture·zoom/fit/전체보기 owner는 그대로 사용.
- [x] **Step 4:** 동일 map suites와 SpatialTargetSelector 변경 관련 case GREEN. readonly/등록/그룹 등 미변경 소비자의 선택 정책은 바꾸지 않는다.
- [x] **Step 5:** 공통 S7/S8 및 모니터링/제어 현황을 갱신하고 commit.

실행 증거: `e27fd510`, shared/map selector3suite69 PASS·monitoring관련3 PASS/12filtered제외. default/embedded와 viewport identity를 확인했다. 마지막 test-only assertion 후 chrome3 PASS는 같은 suite의 재확인이므로 합산하지 않는다. PC 최소높이·실제footer wrap·dark geometry는 Task11.

### Task 5: 모니터링 toolbar·상세·이력

**Files:** `features/monitoring/{MonitoringView,MonitoringFixtureFinder,FixtureDetailPanel,FixturePinPopover,MonitoringLogTicker,MonitoringLogDrawer}.tsx`, `useMonitoringActivity.ts`, 기존 각 test, `docs/menus/monitoring.md`.

**Interfaces:** finder `initialView?: "search" | "list"`는 같은 query/list/filter state의 표현 entry만 선택. 열 때 실제 initiator ref로 닫기 focus 복귀. 갱신은 모바일에서도 지도 위. ticker title=최근 활동, 실제 item/scope만 reset 기준.

- [x] **Step 1:** RED: 두 CTA가 같은 실제 목록을 열고 각각 focus 복귀; unrelated theme/selection rerender 뒤 ticker의 현재 index/5초 timer 유지, 실제 items/scope 변경은 reset.
- [x] **Step 2:** 해당 finder/activity/ticker tests RED 실행 후 query/filter 결과 identity 안정화와 CTA 구현.
- [x] **Step 3:** intrinsic floor selector, 조명 검색·상세/별도 조명 목록, nested popover/detail Card→공통 plain surface, timestamp/refresh/ticker/log 계층 교정.
- [x] **Step 4:** 수정된 MonitoringView/finder/detail/activity/ticker/log 직접 consumer tests GREEN. 50/100/500/1000/cursor·stale/error/no-floor·등록 안내·권한 보존.
- [x] **Step 5:** monitoring 34행의 처리/보존을 작업 묶음별 기록, 메뉴 문서 갱신·commit. 실제 장비 refresh/명령 버튼은 검증 목적으로 클릭하지 않는다.

실행 증거: `5ba6fb1a`와 모니터링문서/34행처리표. 최종직접8파일161 PASS/0FAIL·SKIP, 중간실패24와focused제외는 보고서에 별도보존했다. eyebrow만공통후속queue, 실제geometry/추가POST0는Task11.

### Task 6: 수동 제어·자동화·그룹 목록

**Files:** `features/control/{ControlView,ManualExecutionPanel,CommandHistoryPanel}.tsx`, `target-selection/{TargetSelectionToolbar,SelectionSummaryPanel}.tsx`, `automation/components/{AutomationRuleControls,AutomationWorkspaceSurface,AutomationRuleTable}.tsx`, `groups/{FixtureGroupsPanel,FixtureGroupsContent}.tsx`, 기존 관련 test, `docs/menus/control.md`.

**Interfaces:** target selection/store/command/automation/group handler 계약 불변. 그룹은 실제 owner→공통 DataGrid adapter(이름·층·대상수·실제 동기화·작업), 지원하지 않는 cell은 만들지 않음.

- [x] **Step 1:** 기존 tests의 변경 UI entry와 새 계약 RED: target count/list+clear, bare slider 입력 label·draft invalid Apply 차단, group row edit/delete/locked 상태 동일.
- [x] **Step 2:** 해당 case RED 실행 후 floor/target modes/actions toolbar, 제어 대상 큰 count·bounded목록, 단일 밝기 패널·draft-only presets·명시 Apply, plain history rows 구현.
- [x] **Step 3:** 자동화 중첩 카드/중복 heading을 제거하고 그룹 DataGrid 전환. schedule 모든 주기/시간대·BIO source/hold/동기화 필드와 create/edit/recovery owner 유지.
- [x] **Step 4:** 변경된 ControlView/ManualExecutionPanel/CommandHistoryPanel/automation/groups 직접 tests GREEN. frozen UUID/payload·same-click invalid input·전체 offline 차단·복구 CTA assertions는 줄이지 않는다.
- [x] **Step 5:** control 30행의 처리/필수 차이/동등 상태 기록, 메뉴 문서·commit. 짧은 PC·추가 POST0는 Task11에서 확인한다.

실행 증거: `0e3f2080`와 제어문서/30행처리표. 신규5 PASS; 직접11파일 최초420 PASS/3 FAIL→해당2파일192 PASS, 소스가 그대로인나머지9파일231 PASS는 이전실행증거로구분한다. 같은suite재실행수치는합산하지않는다. eyebrow·실제shortPC geometry는후속queue/Task11.

### Task 7: 통계 개요·분석·보고서

**Files:** `features/statistics/{StatisticsOverviewPage,EnergyComparisonChart,PeriodComparisonPanel,StatisticsOperationalInfo}.tsx`, `analysis/{StatisticsAnalysisPage,EnergyRankingList,EnergyRankingDetailPanel}.tsx`, `reports/{StatisticsReportsPage,ReportHistoryFilters}.tsx`, 기존 test와 새 `analysis/EnergyRankingList.test.tsx`(없는 경우), `docs/menus/statistics.md`.

**Interfaces:** 모든 Query/DTO/기간/metric/sort/download owner 불변. baseline-muted line/observed area+line/forecast dashed, null gap 연결 금지. ranking 실제0 bar width0, null bar 없음; 변화 null/0 neutral·증가 danger·감소 success.

- [x] **Step 1:** RED: ranking0/unknown·증감tone, chart phase/gap/동일 데이터·accessible table, 보고서 CSV action이 기존 실제 create dialog를 열고 query/polling 유지.
- [x] **Step 2:** ranking/chart/overview/reports 관련 case RED 실행 후 10개 V 항목(T01/03/05/06/11/12/15/18/20/25) 구현.
- [x] **Step 3:** chart fullwidth, 실제 이전/전년 비교 compact 아래 배치; 실제 월 baseline/forecast bars; 비용/품질 desktop1:1·mobile stack; 분석2KPIs+실제 상세, 보고서 flat toolbar/grid 구현.
- [x] **Step 4:** 변경된 overview/chart/analysis/reports targeted suites GREEN. 수집부족/음수절감/null·0/기간독립·CSV/PDFjob/취소/서명만료·168 heatmap 원 assertions 보존.
- [x] **Step 5:** 34행 보존/교정 및 source-only와 실제 확인을 구분해 기록, 메뉴 문서·commit.

실행 증거: `4d3cda30`, 통계문서/34행처리표. 신규RED8 FAIL/1 PASS→9 PASS, 직접8파일최종171 PASS/0FAIL·SKIP. 중간class단언실패와비선택을보고서에구분했다. 실제period/DTO/job/0-null 의미보존, eyebrowroot후속과geometryTask11은아직.

### Task 8: 설정 홈·현장/사용자·등록 표현

**Files:** `features/settings/SettingsView.tsx`, `features/settings/settings-action-link.ts`, `features/settings/site/SiteOperationsView.tsx`; 생성 `features/settings/site/SiteInformationEditDialog.tsx`, `features/settings/site/FloorEditDialog.tsx`; `features/settings/users/SiteUsersView.tsx`(공통 소비만), `features/settings/registration/RegistrationSettingsView.tsx`, `features/registration/RegistrationPanel.tsx`, 기존 관련 test, `docs/menus/settings.md`.

**Interfaces:** site/floor dialog는 현재 field schema·mutation callback·expectedUpdatedAt·draft owner 재사용. `RegistrationPanelProps.headerPresentation?: "default" | "embedded"` default 기존 Setup header, embedded settings 중복 overline/header만 제거.

- [x] **Step 1:** RED: 홈 whole-link 단일 interactive, site/floor read정보→edit/create dialog 진입·취소 focus·version conflict/invalid 보존, registration embedded/default 동일 session/scan owner.
- [x] **Step 2:** SettingsView/SiteOperationsView/RegistrationSettingsView의 새 case RED 실행.
- [x] **Step 3:** F1–F6 구현: 가로 NavigationCard5개, readonly 현장정보+수정, 실제 authoritative 구성집계, compact 층표+편집/생성 dialog. 주소/시간대/KRW단가·층level/order/archive/restore/blocker·BIO 설정을 삭제하지 않는다.
- [x] **Step 4:** 사용자 목록/CRUD와 등록 wrapper에 공통 표현 적용. exact loginId 삭제확인/100limit·serial/claim/discovery/provision/reconcile/correlation·설치 continuation·dev tools 보호 유지.
- [x] **Step 5:** 변경된 settings home/site/users/registration 직접 tests 및 변경 shared RegistrationPanel의 Setup 직접 consumer tests GREEN. UI 검증용 실제 계정/등록/test-data 쓰기는 하지 않는다.
- [x] **Step 6:** 설정 감사 해당 행·메뉴 문서 갱신하고 commit.

실행 증거: `ec2eb023`(설정 격리 branch), 소유11파일/F1–F6·감사01–30행 처리·보존. focused RED3 FAIL/87비선택 → 직접8 suites138 PASS/0FAIL·SKIP. 중간 badge icon19실패는 수리·최종 직접 실행으로 해소했다. 공통writer 완료 뒤 교정branch에 통합했고 실제browser는Task11.

### Task 9: 실제 도면 gallery·이력 진입·editor chrome

**Files:** `features/settings/floor-plans/{FloorPlanSettingsView,FloorEditorRoute}.tsx`; 생성 `FloorPlanPreview.tsx`; `features/floor-editor/FloorEditorView.tsx`, 기존 관련 test, `docs/menus/settings.md`.

**Interfaces:** `FloorPlanPreviewProps = {floorId:string; siteId:string; floorName:string; active:boolean}`. 기존 `useFloorMapSnapshot(floorId,siteId)`를 active인 경우만 사용하고 `FloorMapViewport(showControls=false)`+`FloorScene(interactive=false)` readonly로 그림. telemetry 미조회 placed fixture는 `unobservedFixtureIds`로 중립 표시. list IntersectionObserver가 보이는 configured 카드 중 최대2개만 active로 선택.

- [x] **Step 1:** RED: false/unknown/error/권한·site scope, offscreen query disabled/최대2renderer/cleanup, 실제0·unknown 표시, history URL search/hash 보존.
- [x] **Step 2:** FloorPlanSettingsView focused tests RED 후 176px(`h-44`) 실제 readonly preview 구현. inert 그림과 층 preview accessible label, 실제 retry/error, cache 유지; eager editor-state/lease/GPU fan-out 금지.
- [x] **Step 3:** 버전 이력 Link는 기존 editor URL에 `editorPanel=details`, 일반 편집 Link는 해당 query 삭제. `FloorEditorViewProps.initialPanelTab?: "properties" | "details"` 추가, invalid/default properties; initial details는 기존 desktop정보/narrow정보 panel을 열고 버전 영역 focus/scroll intent만 전달.
- [x] **Step 4:** 실제 이력/restore/lease/dirty/sentinel owner 유지. editor singleh1·back/save visible labels, primary save 전경은 `text-action-primary-foreground`로 수정한다.
- [x] **Step 5:** 변경된 gallery/route/editor tests GREEN: 최초 intent 후 theme/query 변화에 initialize/release/restore 추가0, 기존 stage/save ACK/dirty guard 유지. readonly renderer 자체를 수정한 경우만 해당 renderer tests 추가.
- [x] **Step 6:** F7a/b–F9 처리·실제 scene thumbnail의 자원/대형 CAD 한계를 기록, 메뉴 문서·commit. 서버 raster thumbnail/대형 CAD 성능 PASS라고 주장하지 않는다.

실행 증거: `3000d17c`, 소유10파일/F7–F9·감사31–38행. focused RED5 FAIL/119비선택 → 최종직접6 suites139 PASS/0FAIL·SKIP. 과거backlabel·focus순서·image cache fixture 중간실패와 수리는 보고서에 구분. 교정branch 통합 완료. 실제largeCAD/GPU성능·raster·browser는 완료증거가 아니다.

### Task 10: 보안 편집·MFA·session 배치

**Files:** `features/settings/security/{AccountSecurityView,PasswordSettingsView}.tsx`, 기존 두 test, `docs/menus/settings.md`.

**Interfaces:** 실제 재사용 owner인 `PasswordChangeCardProps.presentation?: "card" | "embedded"`를 추가한다(default card). 별도 `PasswordSettingsView`는 기존 card form을 유지하고, AccountSecurityView에서는 password 요약+공통 Dialog의 embedded form을 사용한다. MFA enrollment owner는 기존 위치/수명 유지. PC password/MFA2cols→sessions fullwidth, mobile stack.

- [x] **Step 1:** RED: edit dialog dismiss/focus, password8–1024/invalid/pending/principal late response, MFA secret/recovery draft와 session owner가 theme·dialog 닫기로 remount되지 않음.
- [x] **Step 2:** 두 기존 suite 새 case RED 후 F10 표현 구현. eager logout/현재 session revoke·실패 상태와 독립 PasswordSettingsView export의 default form 불변. 현재 없는 password route는 신설하지 않는다.
- [x] **Step 3:** 두 직접 security suites GREEN, F10 및 설정40행의 최종 처리/보존표·메뉴 문서 갱신하고 commit.

실행 증거: `6c53b330`, 직접security2 suites35 PASS/0FAIL·SKIP·설정40행 최종mapping 및 메뉴문서. Task9후속 `224f1446`은 내부tab string 계약 한 줄 보완(집중2 PASS/74비선택), 이력 재작성0. 두 결과 교정branch 통합 완료. browser/type/UI/build·최종리뷰는Task11.

### Task 11: LEAN 통합 확인·한 번의 최종 리뷰

**Files:** 생성 `apps/web/e2e/atlas-ui-fidelity.spec.ts`; 기존 `e2e/support/{mock-api-boundary,settings-api,first-screen-statistics,layout-assertions}` fixture 재사용, 필요 최소 변경만. 감사 보고서, 네 메뉴 문서, `docs/project-status.md`, 이 체크리스트 갱신.

**Interfaces:** 기존 controlled API 경계·실제 schema fixture를 사용하며 real Lab/DB/장비 요청 금지. `E2E_WEB_PORT`는 사전 점유 확인한 task-owned 빈 포트, 사용자63200/5173/4000 재사용/종료 없음.

준비 증거: `2a42c3eb` 신규spec만255행/Chromium목록12개(exit0), 실제browser/type/UI/build 미실행. 설정9/10과 최종 source 통합 뒤 selector를 대조하고 1회실행한다. gallery configured층1개 fixture는 최대2 ceiling/DOM cleanup까지만, 3개 이상offscreen/GPU는직접unit증거로구분한다.

- [x] **Step 1:** 최종 diff에서 변경된 동작·공통 소비자 목록을 고정하고 unit 증거 중복/미실행을 구분한다. 전역 formatting/새 dependency 추가 없음 확인.
- [x] **Step 2:** 최대12개 focused browser case 작성: PC4root+하위nav, mobile로고/select/긴값, 759/760경계, manual1024×600긴복구, dark4menu/대표portal, finder focus, 설정edit/security owner, stats0/gap, gallery 실제 readonly source/cleanup. 지도 도구·선택·draft/theme/resize/filter는 추가 write0.
- [x] **Step 3:** `pnpm --filter @led-control/web exec playwright test e2e/atlas-ui-fidelity.spec.ts --project=chromium --workers=1` 최초12 한 번. 실패한 원 case/증거 harness만 국소 재실행; 전체 atlas matrix·583개·Lab/canonical 미실행, timeout/skip/기준 완화0.
- [x] **Step 4:** `pnpm --filter @led-control/web typecheck`, `test:ui-policy`, `ui:check`, `build` 최초 각1회와 실제 수리 후 실패 관문 각1회. 최종 source `0bba6fe1` 모두 exit0; build 자체 typecheck 외 임의 반복 없음.
- [x] **Step 5:** 대표 실제16장과 원본의 UI/UX 종합 검토 APPROVED, 독립 최종 code review 같은 seat 재검토까지 ready to merge YES. source-only 상세와 실제 runtime 증거를 구분했다.
- [x] **Step 6:** 13공통·138inventory 처리/보존을 [감사 대응표](../../assets/atlas-ui-refresh-2026-10-07/audit-2026-10-10/README.md)와 담당 Task 보고서의 행별 mapping에 연결했다. 모든 행의 runtime 통과로 확대하지 않는다.
- [x] **Step 7:** P2 두 건 및 정적 오류만 수리·직접 재확인, 메뉴5개 구성/한계·원 실패와 최종 command/exit/skip·screenshots·review를 [구현 증거](../../assets/atlas-ui-refresh-2026-10-07/audit-2026-10-10/implementation/README.md)와 docs commit에 보존한다.

최종 증거: 공통 타입 test `1c4943a6`, 설정 `da9edfee`(보안38/refs117 PASS), 정책79 PASS/0 FAIL·SKIP/UI0·0/타입0/빌드0(기존500KB초과 경고1). CSS AST738/unique738·기존734보존/신규4·anchor e841/baseline files{} 유지. Browser 최초8PASS/4FAIL, 실패/증거 최소 수리 포함 총6회27 case 실행; 마지막 국소PC/dark/열린Dialog3 PASS, gallery/manual/finder 및 기존mobile/0-gap source 증거별 취합. 최종HEAD전체12 일괄PASS가 아니다. 최종spec `eef83fa3` 이후 제품 변경0; 전체/HIL·대형CAD/GPU·모든138runtime 미실행 한계를 유지한다.

### Task 12: 로컬 통합·handoff

**Files:** 코드 신규 수정 없음. `docs/project-status.md`, 이 계획의 실제 통합 상태만 갱신.

- [x] **Step 1:** `git diff --check`, 두 checkout clean/status/head를 새로 확인했다. 사용자 dirty 파일/옛 stash/다른 worktree·서버를 보존했다.
- [x] **Step 2:** 기본 branch가 기준 `b1dd36ee`임을 확인하고 `git merge --ff-only codex/atlas-ui-fidelity-20261010`으로 사용자 승인 로컬 병합 완료(exit0, 첫FF `b8c54516`). 강제/원격 통합0.
- [x] **Step 3:** 첫FF HEAD 일치/clean·실제 병합 결과 확인. 검증 제품source와 동일, 이후 문서 전용 closeout이라 전체 검증을 다시 실행하지 않는다. closeout도 동일 correction branch에서 commit한 뒤 기본 branch에 FF하고 HEAD/clean을 마지막 확인한다.
- [x] **Step 4:** [보존 화면·처리표·한정 검증·실제 통합 기록](../../assets/atlas-ui-refresh-2026-10-07/audit-2026-10-10/implementation/README.md)을 handoff 정본으로 확정했다. 최종 응답에서 최종SHA와 함께 전달하며 원격/배포/실장비 완료로 확대하지 않는다.

통합 증거: 기준 `b1dd36eed1e9dd41663d17cdf94379360e539fb4`→첫FF `b8c545168be5e66ae3cb249cfe6dd6b4a5bc2e53`, 두 checkout clean. `git diff 0bba6fe1 HEAD -- apps/web/src packages` 출력0. 사용자 기존stash `eecf13ef` 포함 전부 유지. 페이지4 worktree/merged branch 정리, ignored scratch5묶음과 monitoring test-results는 `.superpowers/sdd/atlas-fidelity-backup-20261010.GvemD0/` 보존. 통합 worktree는 최종 문서FF 확인 후 정리하며 무관 checkout/서버는 건드리지 않는다.

## 계획 자체 점검

- [x] 명세의 모바일 로고/현장 선택·인라인 집계·지도 도구/높이·다크 수명·공통 우선·네 메뉴/상세·문서·격리/병합을 과제에 연결했다.
- [x] 공통 default/opt-in API와 메뉴 소비 API 이름을 일치시켰다. F7의 실제 snapshot renderer와 기존 이력 owner 경로를 source로 확인했다.
- [x] Review Focus 다섯 가지를 해당 task와 최종 focused 확인에 연결했다. 이전 전체 검증 결과를 이번 성공 증거로 사용하지 않는다.
- [x] 구현 방법은 이미 요청한 에이전트 협업으로 보존한다. 사용자 계획 검토 후 실행하며, 작업마다 새로운 계획 승인·실행 방식 질문을 반복하지 않는다.
- [x] 사용자 계획 검토 완료(2026-10-10).
- [x] 구현 완료·필요 검증 완료·최종 리뷰 완료·로컬 병합 완료.

## 2026-10-11 브라우저 주석 교정 (Tasks 13–17)

이번 29개 주석과 사용자 승인(스케줄 추가는 목록 툴바로 이동)이 이전 현장 선택/eyebrow 디자인보다 우선한다. Tasks 1–12는 완료된 이력이며 다시 실행하지 않는다. 기준 `d8dbfcd10a6b5a00bafbfca65cb8652d0bb08508`, 격리 branch `codex/atlas-browser-comments-20261011`, checkout `.worktrees/atlas-browser-comments-20261011`, 병합 대상 `codex/mvp1-cloud-web`이다. 현재 customer admin/viewer는 DB unique·실제 접근 권한 경로상 최대 한 현장이므로 selector 제거에 API/DB 변경은 필요 없다. 현재 현장 조회/권한/URL scope는 보존한다.

공통 계약부터 고정하고 세 페이지 담당을 같은 격리 checkout의 단독 writer로 순차 실행한다. 총괄은 계획/상태/증거 취합·통합만 담당한다. 새 디자인 시스템·상세 drawer·toolbar primitive를 만들지 않고 기존 optional title, DataGrid align, FilterPanel actions를 소비한다. 실제 시간대·DTO·권한·선택/명령 UUID·초안/명시 Apply·복구·MFA/lease 수명은 불변이다. 사용자 LEAN 지시에 따라 직접 관련 unit, 한 차례 최종 Web 타입/정책/UI/빌드, 제한 모바일/PC 화면, 최종 통합 리뷰 한 번만 진행한다. 실패만 국소 재확인하며 전체 Web/E2E/Lab/HIL·remote/배포는 하지 않는다.

### Task 13: 공통 헤더·표 정렬과 모바일 모니터링

**Owner / Files:** monitoring_header 담당. `features/shells/CustomerShell*`, `CustomerHeaderSummarySlot*`, 현장 전환 전용 `SiteSwitcher`/`useGuardedSiteSelection` 및 해당 테스트, `features/monitoring/MonitoringView*`, `components/ui/DataGrid*`. 삭제 source 목록을 참조하는 `SettingsShell.test.tsx`만 설정 소유 예외. 영향 받는 `docs/menus` 네 문서도 공통 변경을 기록한다. 다른 제어/통계 제품 파일·계획/상태판 수정 금지.

- [x] 주석 2/19의 현장 selector·전환 guard/dialog·전용 코드 제거. `useSites` 권한 검증/현재 현장·dashboard/URL scope/로그아웃 dirty guard는 보존하고 현재 현장은 비대화형 정보로 표시.
- [x] 주석 4의 PC header 집계는 intrinsic 폭과 균일한 compact gap, 모바일은 네 동일 폭 셀을 유지. 모바일 로고·44px hit 보존.
- [x] DataGrid의 명시 align을 header·정렬 버튼·body·모바일 card에 일관 적용. undefined header는 기존 center, body는 기존 left, customer card는 기존 right를 보존.
- [x] 주석 1/27의 tall mobile 지도는 shell 남은 공간을 flex로 채우고 짧은 화면은 자연 scroll 가능. 공통 canvas 240px 최저값/contain:size/renderer/camera를 변경하지 않음.
- [x] 주석 3/28/29의 monitoring ATLAS와 visible map title 제거, 접근 가능한 scope/heading 보존. 변경 동작 focused RED→GREEN 및 기존 직접 영향 회귀만 확인하고 메뉴 문서와 commit/report 전달.

증거: `aba951f7`, focused RED10→직접5 suites190 PASS·diff-check0. 최초6 suites206PASS/4FAIL 중 새 기대3을 수리했다. SettingsShell 현장 관리 group 실패1은 기본 `d8dbfcd1`의 정확1건에서도 동일 fingerprint로 재현되어 변경 없는 기존 실패로 분리 보존한다. 브라우저/최종 통합 관문은 아직이다.

### Task 14: 제어 선택 목록·툴바·표 간소화

**Owner / Files:** control 담당. `features/control` 관련 제품·직접 테스트, `docs/menus/control.md`. 필요하면 기존 `AutomationRuleControls`에 optional actions를 추가하되 공통 UI/다른 메뉴 수정 금지.

- [x] 주석 5–8: 기존 중앙 inspection slot을 개별 선택에도 고정해 실제 선택 목록 표시. 오른쪽 chips 제거, 선택 해제는 중앙 목록 우상단, 밝기 표시의 초안만 제거. 전체 선택 오류/불가 대상·live announcement·실행/초안 owner 보존.
- [x] 주석 9–12: schedule 기간의 시간대 caption 제거(실제 변환 보존), 활성 열은 enabled만 표시·정렬, 이름 외 열 center. 제목줄 제거하고 유일한 스케줄 추가 CTA/ref를 기존 목록 툴바로 이동; global-contract 부재에도 생성 진입/삭제 후 fallback focus 유지.
- [x] 주석 13/18: event 소제목과 control ATLAS 제거, 기존 생성/readonly 동작은 compact toolbar에 유지.
- [x] 주석 14–17: group Gateway 열 제거, ready 상태는 badge만 표시, 이름 외 center. 숨긴 ready metadata를 위한 신규 상세 UI는 추가하지 않음. 기존 비정상 오류/이유·상태 action·실제 readiness 계약 보존.
- [x] 새 표현/선택·focus 계약 focused RED→GREEN, 직접 영향 회귀만 확인하고 메뉴 문서와 commit/report 전달.

증거: `d3010fc7`, RED 직접5 suites329PASS/9FAIL→직접7 suites373/373PASS(43.14초), diff-check0. 공통 계약 외 optional AutomationRuleControls.actions만 추가했으며 중앙 목록 label은 ‘선택 대상 목록’/‘선택 조명’이다. 모바일/최종 통합 관문은 아직이다.

### Task 15: 통계 헤더·보고서 공통 필터

**Owner / Files:** statistics 담당. `features/statistics/{StatisticsOverviewPage,analysis/StatisticsAnalysisPage,reports/StatisticsReportsPage,reports/ReportHistoryFilters,reports/ReportJobList}` 및 직접 테스트, `docs/menus/statistics.md`.

- [x] 주석 20–22/25–26: ENERGY eyebrow 모두 제거, overview visible 제목/상단 생성 CTA 제거(단일 sr-only h1 유지). reports의 기존 생성 진입 유지.
- [x] 주석 23: 기존 SearchField·FilterPanel actions/reset 슬롯을 사용하여 검색/필터/초기화/CSV 간격 통일. 기존 wrapping 레시피를 사용하며 한 행 강제/새 슬롯 없이 정리.
- [x] 주석 24: 목록 시간대 caption 제거하되 현장 시간 변환·원 ISO·null/0·jobs·CSV/PDF/취소·raw draft/debounce/cursor/epoch 불변.
- [x] focused RED→GREEN와 직접 영향 회귀만 확인하고 메뉴 문서와 commit/report 전달.

증거: `e9d72b91`, focused RED5→GREEN5、직접4 suites155/155PASS(10.86초)·diff-check0. 기존 invalid URL validation stderr는 실패가 아니다. 공통 계약·실제 formatter/생성/파일 수명 변경0.

### Task 16: 필요한 모바일·PC UI 검증

**Files:** `apps/web/e2e`의 이번 주석 전용 focused spec/기존 잘못된 selector 시나리오 기대값, 증거 보고서. 제품 수정이 필요하면 해당 owner에게 반환.

- [x] tall mobile 578×1227/681×1227 지도 공간, short mobile 자연 scroll/도구 접근, PC compact 집계/표 center, manual 개별 선택 목록/clear/초안 보존, schedule CTA 이동, dark mobile 보고서 필터·touch target/overflow를 6–8개 controlled case로 확인. 실제 data/지도 로딩을 기다리고 screenshot은 outputPath 파일로 보존.
- [x] 테스트 API fixture만 사용해 추가 쓰기0/기존 고객 서버5173/API4000 보존. 전체 이전 matrix·timeout/skip/기준 완화 금지.
- [x] 최종 Web `typecheck`, `test:ui-policy`, `ui:check`, `build` 각 한 번. 실패 관문만 최소 재실행; 원 실패와 최종 결과를 별도 기록.

최초 정적 묶음: 제품 `e9d72b91`과 전/후 동일 source fingerprint `824d09ad…`에서 타입exit0/정책79PASS·0FAIL·SKIP/UI0·0/buildexit0(기존main930.29KB 큰chunk 경고1). 최초Browser7=5PASS/2FAIL, 국소2=darkreportPASS/shortmonitorFAIL. darkreport는 실제 wheel 후 fixednav 위 완전노출/44px 원 기준을 통과했다. short390×600은 document779/scrollY179=max에서도 tickerbottom591>navtop532라 실제 제품 결함으로 담당에 반환했다. 수리/그 관련3높이사례·UI/build만 후속 확인, 전체7/정책/unit 묶음 반복 없음. 최종브라우저 완료·리뷰·병합은 아직이다.

### Task 17: 최종 리뷰·로컬 병합

- [x] 독립 최종 통합 리뷰 한 번(29주석/spec+코드), 중요 문제는 해당 owner 한 번 수리·국소 재확인. 최종 source·한계·모바일 증거와 메뉴 문서 최신화 확인.
- [ ] base/correction clean·HEAD를 새로 확인하고 사용자 요청대로 `git merge --ff-only codex/atlas-browser-comments-20261011`. base가 변경되면 무조건 덮어쓰지 않음. 원격 push/PR/배포 없음.
- [ ] 실제 merge 결과/HEAD·checklist/상태판을 기록하고 완료 handoff. 검증된 source 불변인 문서 closeout에는 전체 검증 반복 없음.

최종 증거: 모바일 높이 `4802b641`/헤더 폭 `45b22fce`/기존 계정 히트 최소교정 `b70f037f`, QA 최종spec `18f5a0eb`. 실제PC 캡처에서 뒤늦게 확인한 in-scope 헤더 회귀에는 같은 owner/같은 review seat만 국소 연장했다. Browser7unique/6runs15exec(7+2+3+1+1+1) source별 통과이며 최종전체7 batchPASS는 아니다. 최종제품 UI0·0/build(tsc)exit0, 초기정책79/타입0은 변경 없는 계약의 별도증거, 기존bigchunkwarn1/SettingsShellbaselineFAIL1 유지. 독립최종 C/I/M0·0·0/mergeYES. [영구 교정·검증 자료](../../assets/atlas-browser-comments-2026-10-11/README.md)에29건mapping·원실패·실제좌표/대표PNG/담당·리뷰·한계를 보존했다. 병합만 남았으며 새로운 검증은 계획하지 않는다.

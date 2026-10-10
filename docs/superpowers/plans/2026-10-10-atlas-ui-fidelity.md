# ATLAS 전체 UI 충실도 교정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 compact 목업과 사용자 수정 의견을 고객 네 메뉴·상세 UI에 일관되게 적용하고, 필요한 검증 후 별도 브랜치를 로컬 병합한다.

**Architecture:** 기존 React Aria·semantic token·기능 owner를 유지하며 고객 전용 표현 계약을 먼저 정한다. UI/UX 담당이 공통 기준을 소유하고 페이지 담당이 동일 계약을 소비한다. 데이터·권한·명령/편집 수명은 바꾸지 않는다.

**Tech Stack:** React, TypeScript, React Aria Components, Tailwind CSS 4, TanStack Query, Vitest, Playwright, pnpm 9.15.0, Node.js 22.

**Spec:** [기존 승인 명세](../specs/2026-10-07-atlas-ui-refresh-design.md), [전체 감사 정본](../../assets/atlas-ui-refresh-2026-10-07/audit-2026-10-10/README.md). 세부 source·보존 조건은 감사의 공통/메뉴 보고서이며 아래 과제의 일부다.

상태: 감사·계획 작성 완료, 사용자 계획 검토 대기. 구현·이번 제품 검증·병합 미착수. 실행 방식은 이미 요청한 페이지/디자이너 협업으로 확정하며 다시 선택하지 않는다.

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

- [ ] **Step 1:** 격리 dependency 준비(`pnpm install --frozen-lockfile`, `pnpm workspace:prepare`), 기존 서버/다른 worktree 출력은 수정하지 않는다.
- [ ] **Step 2:** token 계약 RED: 신규4 값 정확 일치, 기존 승인 AST의 각 이름/값 불변, 고객 shadow/alias 경계 유지를 assert한다.
- [ ] **Step 3:** 해당 테스트만 실행하여 신규 token 부재로 실패함을 확인한다.
- [ ] **Step 4:** 네 선언만 추가한 token-only commit을 만든다. 실제 AST 개수를 기록하며 과거734+4를 무조건 현재 개수로 쓰지 않는다.
- [ ] **Step 5:** UI/UX 담당의 token-only 독립 검토 뒤 그 exact commit으로 anchor를 회전하고 policy test·spacing 문서에 의도/고객 compact 예외를 기록한다.
- [ ] **Step 6:** token test와 `pnpm --filter @led-control/web test:ui-policy`, `ui:check` GREEN을 확인하고 정책/doc commit. 중간 stale-anchor 실패는 최종 정책 PASS로 기록하지 않는다.

### Task 2: 공통 고객 표현 컴포넌트

**Files:** 수정 `components/ui/{Typography,PageHeader,Card,Button,UnderlineNavigation,FilterPanel,DataGrid,SidePanel}.tsx`, `components/ui/index.ts`, `components/ui/operations/{InlineStatusSummary,RecentActivityTicker}.tsx`, `components/ui/fields/Slider.tsx`; 생성 `components/ui/NavigationCard.tsx`, `components/ui/navigation-item-recipe.ts`, `components/ui/CustomerPresentation.test.tsx`. 모든 경로는 `apps/web/src/` 상대다.

**Interfaces:**

- Typography variant: `customer-page-title | customer-section-title | customer-card-title | customer-metric`. page=26px/mobile24px, section=기존20px, card=기존16px, metric=30px/mobile28px. 기존 variant 유지.
- `PageHeaderProps.variant?: "default" | "customer"`, `headingLevel` 유지. customer page header는 위 page-title을 소비한다.
- `CardProps.padding?: "none" | "customer"` default none. 고객 inset20px/mobile16px.
- `UnderlineNavigationProps.variant?: "default" | "customer"`; `navigationItemClass({active, variant}): string`를 NavLink/button tabs가 공통 소비. customer soft pill, default 기존 underline.
- `NavigationCardProps`: `to: To; icon: ReactNode; title: string; description?: ReactNode; summary?: ReactNode`와 기존 Link의 접근성 속성. 단일 전체 Link, 가로 inset icon, 중첩 interactive 없음.
- `FilterPanelProps.triggerLabel?: string` default 필터, count0 badge 숨김/실제 count 유지. `RecentActivityTickerProps.title?: string` default 최근 이력, PC visible/mobile sr-only.
- `SidePanelProps.surface?: "card" | "plain"` default card, embedded plain은 중복 경계 제거. `SliderProps.presentation?: "field" | "bare"` default field, bare는 외곽 input 경계 없이 실제 label/설명/오류/ARIA·큰 thumb hit 유지.
- Button과 DataGrid는 기존 고객 theme scope에서만 soft/neutral 표현을 적용한다. 기본 비고객 표현은 불변.

- [ ] **Step 1:** 새 opt-in/default 계약 테스트를 작성: 단일 link, caller children/ARIA/ref 유지, default 불변, 필터0 badge 없음/양수 count 표시, bare slider label·keyboard 유지.
- [ ] **Step 2:** `CustomerPresentation.test.tsx`와 변경된 기존 FilterPanel/RecentActivityTicker/Slider 계약의 해당 case만 RED 확인.
- [ ] **Step 3:** 공통 recipe/variant 구현. 본문 desktop `px-7 py-6`, mobile `px-3.5 py-4.5`, 직계 section gap20px, card grid18px, inset20/16px를 공통 소유한다.
- [ ] **Step 4:** 동일 targeted 계약 GREEN; 변경한 Typography/DataGrid/InlineStatusSummary 기존 suite를 한 번 실행한다.
- [ ] **Step 5:** S3–S6/S9–S12 처리·기본 소비자 보존 근거를 공통 보고서에 기록하고 commit.

### Task 3: 고객 shell·제목·탭 소유

**Files:** `features/shells/{CustomerShell,CustomerHeaderSummarySlot,CustomerAccountPanel}.tsx`, `features/sites/SiteSwitcher.tsx`(필요한 표현만), `features/control/automation/ControlModeTabs.tsx`, `features/statistics/StatisticsSubnavigation.tsx`, `features/settings/{SettingsShell,SettingsSubnavigation}.tsx`, `features/settings/settings-sections.ts`, 네 메뉴 root 및 설정6개 child의 제목 소비 부분(`SettingsView`, `site/SiteOperationsView`, `users/SiteUsersView`, `registration/RegistrationSettingsView`, `floor-plans/FloorPlanSettingsView`, `security/AccountSecurityView`).

**Interfaces:** CustomerShell은 visible route h1을 제거하며 본문 PageHeader가 단일 h1/actions를 소유. `shell-current-menu` hook은 필요시 sr-only span 유지. PC site-left/실제4summary-center/alarm-theme-account-right 한 행; 모바일 기존 logo/select 첫 행+summary 둘째 행. account Link는 기존 settings/security를 사용하며 새 query/duplicate panel 없음. 설정은 `SettingsSection.pageTitle: string`을 추가하고 capability-filtered6목록의 trailing-slash 정규화 pathname을 정확히 매칭해 SettingsShell이 h1을 tabs 위에 소유한다. 제목은 설정/현장 관리/사용자 관리/조명 등록/도면 관리/계정 및 보안이다. child는 중복 제목만 제거하고 기존 description/actions를 한 본문 toolbar에 유지한다. editor 같은 상세 경로는 Shell header 없이 실제 child가 h1을 소유한다. 새 title context나 query는 없다.

- [ ] **Step 1:** CustomerShell/summary/settings shell focused RED: body 단일h1, header grid 배치, 긴 현장명/summary0·unknown/capability, 기존 eager logout 실패/차단 유지를 assert.
- [ ] **Step 2:** 해당 case RED 실행 후 shell/summary의 값 위 caption·neutral/statustone, sidebar inset/softactive, compact account strip 구현.
- [ ] **Step 3:** 공통 customer 탭을 control/statistics/settings에 적용. monitoring 본문 제목+갱신, control 조명 제어 제목→tabs, settings6목록은 Shell h1→desktop tabs→child toolbar, statistics tabs→route h1. 모바일 설정 tabs 숨김·return/search/hash 보존, 중복 제목 제거.
- [ ] **Step 4:** shell·summary·mode tabs·settings shell 기존 targeted tests GREEN. 320/390/562·759/760 및 dark 실제 geometry는 Task11 한 번에서 확인한다.
- [ ] **Step 5:** 공통 S1–S4/S13 처리와 영향받은 네 메뉴 문서를 갱신하고 commit.

### Task 4: 공유 지도 상·하단 chrome

**Files:** `components/ui/maps/OperationMapPanel.tsx`, `features/floor-map/FloorMapViewport.tsx`와 각 기존 test; `features/monitoring/FloorMap.tsx`, `features/control/target-selection/SpatialTargetSelector.tsx`.

**Interfaces:** `FloorMapViewportProps.footerStart?: ReactNode` 추가. `controlsPlacement="footer"`+footerStart opt-in 때 legend-left/camera-right 한 static bar, default/overlay 소비자 불변. OperationMapPanel title/tools-left+inline summary-right, chrome inset16/12px.

- [ ] **Step 1:** RED: footerStart와 camera가 동일 flow footer에 있고 viewport/children identity가 동일하며 기본 소비자 placement 불변.
- [ ] **Step 2:** 두 공유 map test의 새 case를 실패 확인하고 인터페이스 구현.
- [ ] **Step 3:** monitoring/manual 소비자가 기존 legend를 footerStart로 전달하고 중복 legend strip 제거. manual 도구 gesture·zoom/fit/전체보기 owner는 그대로 사용.
- [ ] **Step 4:** 동일 map suites와 SpatialTargetSelector 변경 관련 case GREEN. readonly/등록/그룹 등 미변경 소비자의 선택 정책은 바꾸지 않는다.
- [ ] **Step 5:** 공통 S7/S8 및 모니터링/제어 현황을 갱신하고 commit.

### Task 5: 모니터링 toolbar·상세·이력

**Files:** `features/monitoring/{MonitoringView,MonitoringFixtureFinder,FixtureDetailPanel,FixturePinPopover,MonitoringLogTicker,MonitoringLogDrawer}.tsx`, `useMonitoringActivity.ts`, 기존 각 test, `docs/menus/monitoring.md`.

**Interfaces:** finder `initialView?: "search" | "list"`는 같은 query/list/filter state의 표현 entry만 선택. 열 때 실제 initiator ref로 닫기 focus 복귀. 갱신은 모바일에서도 지도 위. ticker title=최근 활동, 실제 item/scope만 reset 기준.

- [ ] **Step 1:** RED: 두 CTA가 같은 실제 목록을 열고 각각 focus 복귀; unrelated theme/selection rerender 뒤 ticker의 현재 index/5초 timer 유지, 실제 items/scope 변경은 reset.
- [ ] **Step 2:** 해당 finder/activity/ticker tests RED 실행 후 query/filter 결과 identity 안정화와 CTA 구현.
- [ ] **Step 3:** intrinsic floor selector, 조명 검색·상세/별도 조명 목록, nested popover/detail Card→공통 plain surface, timestamp/refresh/ticker/log 계층 교정.
- [ ] **Step 4:** 수정된 MonitoringView/finder/detail/activity/ticker/log 직접 consumer tests GREEN. 50/100/500/1000/cursor·stale/error/no-floor·등록 안내·권한 보존.
- [ ] **Step 5:** monitoring 34행의 처리/보존을 작업 묶음별 기록, 메뉴 문서 갱신·commit. 실제 장비 refresh/명령 버튼은 검증 목적으로 클릭하지 않는다.

### Task 6: 수동 제어·자동화·그룹 목록

**Files:** `features/control/{ControlView,ManualExecutionPanel,CommandHistoryPanel}.tsx`, `target-selection/{TargetSelectionToolbar,SelectionSummaryPanel}.tsx`, `automation/components/{AutomationRuleControls,AutomationWorkspaceSurface,AutomationRuleTable}.tsx`, `groups/{FixtureGroupsPanel,FixtureGroupsContent}.tsx`, 기존 관련 test, `docs/menus/control.md`.

**Interfaces:** target selection/store/command/automation/group handler 계약 불변. 그룹은 실제 owner→공통 DataGrid adapter(이름·층·대상수·실제 동기화·작업), 지원하지 않는 cell은 만들지 않음.

- [ ] **Step 1:** 기존 tests의 변경 UI entry와 새 계약 RED: target count/list+clear, bare slider 입력 label·draft invalid Apply 차단, group row edit/delete/locked 상태 동일.
- [ ] **Step 2:** 해당 case RED 실행 후 floor/target modes/actions toolbar, 제어 대상 큰 count·bounded목록, 단일 밝기 패널·draft-only presets·명시 Apply, plain history rows 구현.
- [ ] **Step 3:** 자동화 중첩 카드/중복 heading을 제거하고 그룹 DataGrid 전환. schedule 모든 주기/시간대·BIO source/hold/동기화 필드와 create/edit/recovery owner 유지.
- [ ] **Step 4:** 변경된 ControlView/ManualExecutionPanel/CommandHistoryPanel/automation/groups 직접 tests GREEN. frozen UUID/payload·same-click invalid input·전체 offline 차단·복구 CTA assertions는 줄이지 않는다.
- [ ] **Step 5:** control 30행의 처리/필수 차이/동등 상태 기록, 메뉴 문서·commit. 짧은 PC·추가 POST0는 Task11에서 확인한다.

### Task 7: 통계 개요·분석·보고서

**Files:** `features/statistics/{StatisticsOverviewPage,EnergyComparisonChart,PeriodComparisonPanel,StatisticsOperationalInfo}.tsx`, `analysis/{StatisticsAnalysisPage,EnergyRankingList,EnergyRankingDetailPanel}.tsx`, `reports/{StatisticsReportsPage,ReportHistoryFilters}.tsx`, 기존 test와 새 `analysis/EnergyRankingList.test.tsx`(없는 경우), `docs/menus/statistics.md`.

**Interfaces:** 모든 Query/DTO/기간/metric/sort/download owner 불변. baseline-muted line/observed area+line/forecast dashed, null gap 연결 금지. ranking 실제0 bar width0, null bar 없음; 변화 null/0 neutral·증가 danger·감소 success.

- [ ] **Step 1:** RED: ranking0/unknown·증감tone, chart phase/gap/동일 데이터·accessible table, 보고서 CSV action이 기존 실제 create dialog를 열고 query/polling 유지.
- [ ] **Step 2:** ranking/chart/overview/reports 관련 case RED 실행 후 10개 V 항목(T01/03/05/06/11/12/15/18/20/25) 구현.
- [ ] **Step 3:** chart fullwidth, 실제 이전/전년 비교 compact 아래 배치; 실제 월 baseline/forecast bars; 비용/품질 desktop1:1·mobile stack; 분석2KPIs+실제 상세, 보고서 flat toolbar/grid 구현.
- [ ] **Step 4:** 변경된 overview/chart/analysis/reports targeted suites GREEN. 수집부족/음수절감/null·0/기간독립·CSV/PDFjob/취소/서명만료·168 heatmap 원 assertions 보존.
- [ ] **Step 5:** 34행 보존/교정 및 source-only와 실제 확인을 구분해 기록, 메뉴 문서·commit.

### Task 8: 설정 홈·현장/사용자·등록 표현

**Files:** `features/settings/SettingsView.tsx`, `features/settings/settings-action-link.ts`, `features/settings/site/SiteOperationsView.tsx`; 생성 `features/settings/site/SiteInformationEditDialog.tsx`, `features/settings/site/FloorEditDialog.tsx`; `features/settings/users/SiteUsersView.tsx`(공통 소비만), `features/settings/registration/RegistrationSettingsView.tsx`, `features/registration/RegistrationPanel.tsx`, 기존 관련 test, `docs/menus/settings.md`.

**Interfaces:** site/floor dialog는 현재 field schema·mutation callback·expectedUpdatedAt·draft owner 재사용. `RegistrationPanelProps.headerPresentation?: "default" | "embedded"` default 기존 Setup header, embedded settings 중복 overline/header만 제거.

- [ ] **Step 1:** RED: 홈 whole-link 단일 interactive, site/floor read정보→edit/create dialog 진입·취소 focus·version conflict/invalid 보존, registration embedded/default 동일 session/scan owner.
- [ ] **Step 2:** SettingsView/SiteOperationsView/RegistrationSettingsView의 새 case RED 실행.
- [ ] **Step 3:** F1–F6 구현: 가로 NavigationCard5개, readonly 현장정보+수정, 실제 authoritative 구성집계, compact 층표+편집/생성 dialog. 주소/시간대/KRW단가·층level/order/archive/restore/blocker·BIO 설정을 삭제하지 않는다.
- [ ] **Step 4:** 사용자 목록/CRUD와 등록 wrapper에 공통 표현 적용. exact loginId 삭제확인/100limit·serial/claim/discovery/provision/reconcile/correlation·설치 continuation·dev tools 보호 유지.
- [ ] **Step 5:** 변경된 settings home/site/users/registration 직접 tests 및 변경 shared RegistrationPanel의 Setup 직접 consumer tests GREEN. UI 검증용 실제 계정/등록/test-data 쓰기는 하지 않는다.
- [ ] **Step 6:** 설정 감사 해당 행·메뉴 문서 갱신하고 commit.

### Task 9: 실제 도면 gallery·이력 진입·editor chrome

**Files:** `features/settings/floor-plans/{FloorPlanSettingsView,FloorEditorRoute}.tsx`; 생성 `FloorPlanPreview.tsx`; `features/floor-editor/FloorEditorView.tsx`, 기존 관련 test, `docs/menus/settings.md`.

**Interfaces:** `FloorPlanPreviewProps = {floorId:string; siteId:string; floorName:string; active:boolean}`. 기존 `useFloorMapSnapshot(floorId,siteId)`를 active인 경우만 사용하고 `FloorMapViewport(showControls=false)`+`FloorScene(interactive=false)` readonly로 그림. telemetry 미조회 placed fixture는 `unobservedFixtureIds`로 중립 표시. list IntersectionObserver가 보이는 configured 카드 중 최대2개만 active로 선택.

- [ ] **Step 1:** RED: false/unknown/error/권한·site scope, offscreen query disabled/최대2renderer/cleanup, 실제0·unknown 표시, history URL search/hash 보존.
- [ ] **Step 2:** FloorPlanSettingsView focused tests RED 후 176px(`h-44`) 실제 readonly preview 구현. inert 그림과 층 preview accessible label, 실제 retry/error, cache 유지; eager editor-state/lease/GPU fan-out 금지.
- [ ] **Step 3:** 버전 이력 Link는 기존 editor URL에 `editorPanel=details`, 일반 편집 Link는 해당 query 삭제. `FloorEditorViewProps.initialPanelTab?: "properties" | "details"` 추가, invalid/default properties; initial details는 기존 desktop정보/narrow정보 panel을 열고 버전 영역 focus/scroll intent만 전달.
- [ ] **Step 4:** 실제 이력/restore/lease/dirty/sentinel owner 유지. editor singleh1·back/save visible labels, primary save 전경은 `text-action-primary-foreground`로 수정한다.
- [ ] **Step 5:** 변경된 gallery/route/editor tests GREEN: 최초 intent 후 theme/query 변화에 initialize/release/restore 추가0, 기존 stage/save ACK/dirty guard 유지. readonly renderer 자체를 수정한 경우만 해당 renderer tests 추가.
- [ ] **Step 6:** F7a/b–F9 처리·실제 scene thumbnail의 자원/대형 CAD 한계를 기록, 메뉴 문서·commit. 서버 raster thumbnail/대형 CAD 성능 PASS라고 주장하지 않는다.

### Task 10: 보안 편집·MFA·session 배치

**Files:** `features/settings/security/{AccountSecurityView,PasswordSettingsView}.tsx`, 기존 두 test, `docs/menus/settings.md`.

**Interfaces:** 실제 재사용 owner인 `PasswordChangeCardProps.presentation?: "card" | "embedded"`를 추가한다(default card). 별도 `PasswordSettingsView`는 기존 card form을 유지하고, AccountSecurityView에서는 password 요약+공통 Dialog의 embedded form을 사용한다. MFA enrollment owner는 기존 위치/수명 유지. PC password/MFA2cols→sessions fullwidth, mobile stack.

- [ ] **Step 1:** RED: edit dialog dismiss/focus, password8–1024/invalid/pending/principal late response, MFA secret/recovery draft와 session owner가 theme·dialog 닫기로 remount되지 않음.
- [ ] **Step 2:** 두 기존 suite 새 case RED 후 F10 표현 구현. eager logout/현재 session revoke·실패 상태와 독립 PasswordSettingsView export의 default form 불변. 현재 없는 password route는 신설하지 않는다.
- [ ] **Step 3:** 두 직접 security suites GREEN, F10 및 설정40행의 최종 처리/보존표·메뉴 문서 갱신하고 commit.

### Task 11: LEAN 통합 확인·한 번의 최종 리뷰

**Files:** 생성 `apps/web/e2e/atlas-ui-fidelity.spec.ts`; 기존 `e2e/support/{mock-api-boundary,settings-api,first-screen-statistics,layout-assertions}` fixture 재사용, 필요 최소 변경만. 감사 보고서, 네 메뉴 문서, `docs/project-status.md`, 이 체크리스트 갱신.

**Interfaces:** 기존 controlled API 경계·실제 schema fixture를 사용하며 real Lab/DB/장비 요청 금지. `E2E_WEB_PORT`는 사전 점유 확인한 task-owned 빈 포트, 사용자63200/5173/4000 재사용/종료 없음.

- [ ] **Step 1:** 최종 diff에서 변경된 동작·공통 소비자 목록을 고정하고 unit 증거 중복/미실행을 구분한다. 전역 formatting/새 dependency 추가 없음 확인.
- [ ] **Step 2:** 최대12개 focused browser case 작성: PC4root+하위nav, mobile로고/select/긴값, 759/760경계, manual1024×600긴복구, dark4menu/대표portal, finder focus, 설정edit/security owner, stats0/gap, gallery 실제 readonly source/cleanup. 지도 도구·선택·draft/theme/resize/filter는 추가 write0.
- [ ] **Step 3:** `pnpm --filter @led-control/web exec playwright test e2e/atlas-ui-fidelity.spec.ts --project=chromium --workers=1` 한 번. 기존 전체 atlas matrix·583개·Lab/canonical 미실행; 실패한 원 case/관련 수리만 재실행하고 timeout/skip/기준을 완화하지 않는다.
- [ ] **Step 4:** `pnpm --filter @led-control/web typecheck`, `test:ui-policy`, `ui:check`, `build` 최종 source에서 한 번씩. build의 자체 typecheck 외 별도 반복 없음.
- [ ] **Step 5:** 동일 fixture browser에서 목업/실제 대표 screenshot 비교를 UI/UX 담당과 한 번 종합 검토하고 독립 최종 code review 한 번. 새로 열린 source-only 상세는 확인한 것만 실제 검증으로 표시.
- [ ] **Step 6:** 13공통 결함·138inventory 각 처리/보존이 task/commit과 대응하는지 대조. 모든 시각 수정은 screenshot 또는 명시적 실제 확인, 데이터/API필수 차이는 source 근거를 기록. 전 상태 runtime 통과라고 쓰지 않는다.
- [ ] **Step 7:** 필요한 문제만 수리·해당 case 재확인; 메뉴5개 구성/한계·검증 command/exit/failure/skip·screenshots·수정 완료 상태를 기록하고 docs commit.

### Task 12: 로컬 통합·handoff

**Files:** 코드 신규 수정 없음. `docs/project-status.md`, 이 계획의 실제 통합 상태만 갱신.

- [ ] **Step 1:** `git diff --check`, 두 checkout status/head를 확인한다. 사용자 dirty 파일/옛 stash/다른 worktree·서버는 보존한다.
- [ ] **Step 2:** 기본 branch가 기준 HEAD면 `git merge --ff-only codex/atlas-ui-fidelity-20261010`으로 사용자가 이미 요청한 로컬 병합. moved HEAD면 겹침을 읽고 안전하게 통합하며 의미가 충돌하면 사용자 결정 전 강제 진행하지 않는다.
- [ ] **Step 3:** 최종 HEAD 일치/clean·commit·실제 병합 결과 확인. 검증한 동일 commit이면 전체 검증을 다시 실행하지 않는다.
- [ ] **Step 4:** 목업과 실제 결과·주요 교정·남는 실제 계약 차이·한정 검증·branch/merge SHA를 사용자에게 전달. 원격/배포/실장비 완료로 확대하지 않는다.

## 계획 자체 점검

- [x] 명세의 모바일 로고/현장 선택·인라인 집계·지도 도구/높이·다크 수명·공통 우선·네 메뉴/상세·문서·격리/병합을 과제에 연결했다.
- [x] 공통 default/opt-in API와 메뉴 소비 API 이름을 일치시켰다. F7의 실제 snapshot renderer와 기존 이력 owner 경로를 source로 확인했다.
- [x] Review Focus 다섯 가지를 해당 task와 최종 focused 확인에 연결했다. 이전 전체 검증 결과를 이번 성공 증거로 사용하지 않는다.
- [x] 구현 방법은 이미 요청한 에이전트 협업으로 보존한다. 사용자 계획 검토 후 실행하며, 작업마다 새로운 계획 승인·실행 방식 질문을 반복하지 않는다.
- [ ] 사용자 계획 검토 완료.
- [ ] 구현 완료·필요 검증 완료·최종 리뷰 완료·로컬 병합 완료.

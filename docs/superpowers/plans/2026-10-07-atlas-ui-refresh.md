# ATLAS 라이트·다크 고객 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 ATLAS 목업과 모바일 수정 의견을 실제 네 메뉴에 공통화하여 적용하고, 상태를 보존하는 라이트·다크 전환을 제공한 뒤 검증·로컬 병합한다.

**Architecture:** 기존 React Aria/Tailwind semantic UI와 API·기능 owner를 유지한다. canonical token의 두 고객 palette를 고객 shell 활성 중에만 root semantic 역할에 연결하고, 안정된 theme provider가 저장·portal·reactive color 갱신을 소유한다. 공통 기반과 공유 지도를 먼저 확정한 뒤 페이지 담당들이 같은 계약을 소비한다.

**Tech Stack:** React 18, TypeScript, React Aria, Tailwind CSS 4, React Query, React Router, Konva/Pixi, Recharts, Vitest, Playwright. 기존 lockfile·의존성 유지, 검증 runtime Node 22·pnpm 9.15.0.

**Spec:** [다크 포함 설계 명세](../specs/2026-10-07-atlas-ui-refresh-design.md)

상태: **실행 승인·Tasks 1–3 완료, Task 4 공통 UI·모바일 헤더 진행 중**. 2026-10-07 사용자가 페이지 및 기능 담당 에이전트 세션에 지시하여 진행하도록 승인했다. 사용자가 선택한 실행 방식은 **페이지별 에이전트 분담, 메인 오케스트레이션, 별도 브랜치 후 로컬 병합**이며 다시 선택을 요구하지 않는다. 완료 표시는 독립 검토와 실제 증거를 회수한 뒤 갱신한다.

## Global Constraints

- 작업 checkout은 `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-ui-refresh-20261007`, 브랜치는 `codex/atlas-ui-refresh-20261007`, 출발 제품은 `5e173fb4663fb9544cc0a6e74fa985c94218cfcb`다.
- API·공유 스키마·DB·MQTT·Gateway·펌웨어·native 외부 frame은 변경하지 않는다. 원격 push/PR/배포/실장비 조작을 하지 않는다.
- 목업은 디자인 참고만 한다. 가상 시나리오·SVG 도면·센서 이벤트·가짜 보고서·오프라인 제외 후 실행 정책은 이식하지 않는다.
- canonical `@theme static`, 기존 기본/brand/landing 값, 승인 간격 스케일과 금지 literal/native form/selector 규칙을 보존한다. 토큰 전용 커밋 후 별도 anchor rotation 검토, 빈 baseline·production 정책 부채 0건을 유지한다.
- 고객 theme 저장은 `led-control.customer-theme.v1`의 `light|dark`, 기본·잘못된 값·읽기 실패는 light다. 저장 실패는 현재 탭 전환을 막지 않는다. 시스템 테마 자동 연동은 범위 밖이다.
- theme는 CustomerShell 활성 동안만 html `data-customer-theme`에 적용하고 cleanup한다. 페이지·QueryClient·명령·renderer·editor identity에 theme를 넣지 않는다. 원본 CAD/도형 색과 사용자 색상 draft는 보존한다.
- 모바일 `<760px`, 경계 검증 `759.5/760/760.5px`. 현장 select 너비는 `<360px`에서 128px, `360px 이상`에서 144px, 최소 조작 hit 44px. sidebar 고객 geometry는 펼침 220px·rail 80px이다.
- 도면 상태는 인라인 라벨 14px·수치 16px, ticker는 5초. PC 수동 제어 외부 세로 스크롤 0, 짧은 1024×600은 내부 workspace 스크롤과 실제 canvas 최소 240px을 보존한다. 모바일은 자연 세로 스크롤이다.
- 기존 frozen UUID/payload/ACK·전체 선택 차단·권한·시간대·retention/cursor·null/0·설정 dirty/lease/MFA·PDF/CSV 수명을 보존한다. theme/선택/도구/필터/resize만으로 추가 dimming POST는 0건이다.
- 각 제품 task는 해당 메뉴 문서와 검증 증거를 같이 갱신한다. 기본 checkout의 목업 이력 문서 변경 두 개와 다른 사용자 변경을 보존한다. 현재 63200/5173/4000 서비스는 임의 조작하지 않는다.
- 실행자는 task 시작 전에 AGENTS와 명세를 읽는다. RED → 최소 구현 → GREEN → 선언 파일만 stage → fresh diff check → 명시된 메시지로 작은 커밋 → 독립 요구/품질 검토 순서를 지킨다. 실패/skip·이전 증거를 숨기지 않는다.

## Review Focus

1. 저장소가 차단되거나 값이 손상된 브라우저: UI는 정상 전환되고 초기 fallback·다른 탭·StrictMode cleanup이 일관돼야 한다 — Task 3.
2. 지도/CAD/차트의 오래된 색상 cache: light→dark→light가 실제 재도색되면서 같은 canvas·camera·선택·원본 색상이 유지돼야 한다 — Task 5, 9.
3. 전송 결과 불명확·저장소 실패·긴 안전 안내 중 전환/resize: 원래 UUID/lock·안전 재적용과 모든 복구 행동이 보존돼야 한다 — Task 7.
4. 진행 중 PDF/CSV 또는 MFA/도면 편집의 민감한 수명: 전환이 abort·중복 요청·비밀 재표시·dirty draft 유실을 만들면 안 된다 — Task 9, 10.
5. 관리 권한 없는 현장 또는 부분/결측 데이터: 비인가 query를 발행하거나 null을 0으로 만들지 않고, 일반 제어 사용자의 구역 조회는 남아야 한다 — Task 6, 8, 10.

## 파일 구조와 담당 경계

아래 `src/`·`scripts/`·`e2e/` 경로는 모두 `apps/web/` 기준이다. 문서 경로는 저장소 루트 기준이다. 새 공통 UI는 `src/components/ui` 안에서만 만든다.

| 단위 | 책임 / 순서 |
| --- | --- |
| `docs/assets/atlas-ui-refresh-2026-10-07/customer-theme-roles.json` | 두 palette와 alias·layout 역할의 검토 가능한 fixture. 제품에서 docs를 import하지 않는다. |
| `src/styles/theme.css`, `base.css`, 정책 3파일 | 평평한 palette/치수, 정확한 두 root alias, 승인 anchor·검사. 공통 기반 담당이 단독 소유한다. |
| `src/components/ui/theme/` | preference parser/provider/toggle/reactive palette. 업무 상태나 query를 소유하지 않는다. |
| `src/components/ui/operations/` | 인라인 상태·한 줄 ticker 표현. DTO/query/command는 소유하지 않는다. |
| `src/components/ui/maps/OperationMapPanel.tsx` | 도면 chrome slot·layout만 소유. camera는 기존 viewport가 소유한다. |
| `src/features/shells`, `sites`, `brand` | 모바일 logo/select/테마·sidebar·safe-area·공통 layout 경계. 공통 기반 담당 소유다. |
| `src/features/floor-map`, `floor-editor`, `map-scene`, 제어 target-selection | 공유 지도 담당이 테마 repaint와 manual opt-in을 먼저 적용한다. |
| 모니터링 / 제어 / 통계 / 설정 기능 모듈 | 각각 별도 페이지 담당. 공통 계약 변경은 총괄을 통해 원 소유자에게 반환한다. |
| `e2e/atlas-ui-refresh.spec.ts` | QA 담당의 전체 두 테마·너비·업무 수명 회귀. |

기존 공통 세션은 Task 1–4, 기존 제어/지도 세션은 Task 5·7–8, 기존 통계 세션은 Task 9를 담당한다. 모니터링과 설정은 각각 별도 담당을 배정한다. 같은 앱·공유 파일의 제품 수정은 순차 실행하며 읽기 전용 조사만 병렬화한다. 모든 task에는 구현자와 다른 검수자가 필요하다. 메인은 코드 대신 결과 대조와 이 체크리스트·`docs/project-status.md`를 동기화한다.

---

### Task 1: 두 테마 역할 inventory와 토큰 전용 변경

**Files:** Create `docs/assets/atlas-ui-refresh-2026-10-07/customer-theme-roles.json`, `scripts/customer-theme-contract.test.mjs`; Modify `src/styles/theme.css`, `src/components/ui/utils/theme-color.ts`, `src/components/ui/Typography.test.tsx`, `docs/ui-spacing.md`.

**Interfaces:** `colors: Record<string, { light: string; dark: string }>`는 기존 semantic 역할별 새 customer token 값, `layouts: Record<string,string>`는 고객 geometry다. layout 역할은 `--spacing-customer-sidebar:13.75rem`, `--spacing-customer-rail:5rem`, `--spacing-customer-site-small:8rem`, `--spacing-customer-site:9rem`이다. 인라인14/16px는 기존 body/body-lg typography를 사용한다. 기존 역할은 삭제/덮어쓰지 않는다. `themeColorTokens`/`ThemeColorToken`은 새 canonical color 선언과 정확히 일치해야 한다.

- [x] Step 1 — 승인 checkout/branch/dirty files와 Node 22·pnpm 9.15.0을 확인한다. 기존 설치를 재사용할 수 없으면 격리 checkout에만 frozen install하고 `pnpm workspace:prepare`를 수행한다. canonical baseline `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`를 순차 기록한다. 실패가 있으면 원 로그·소스를 보존하고 범위 영향을 판정한 뒤 진행한다.
- [x] Step 2 — 모든 customer 소비 color/hover/focus/disabled/feedback/chart/editor UI 역할을 JSON에 매핑하고 독립 designer가 값을 검토한다. spec의 두 palette 값을 그대로 쓰며 기존 CAD 지정색·brand/landing은 제외한다. 새 `action-primary-foreground`의 기본값은 `#FFFFFF`; 고객 light/dark는 `#FFFFFF`/`#0F1724`다. 독립 designer는 98색·4 layout을 Spec/Quality Approved(C0/I0/M1 후속 heatmap 경계 주의)로 승인했고, 별도 지도 3역할 추가도 명세에 맞춰 승인했다.
- [x] Step 3 — `matches both customer palettes without changing approved defaults`를 작성한다. 핵심 단언은 `colors["action-primary"].dark === "#94B9FF"`, light 화면 `#F4F7FB`, dark 화면 `#0F1724`, canonical palette 선언 각 1회, 이전 anchor의 기본 name→value 불변이다. `node --test apps/web/scripts/customer-theme-contract.test.mjs`로 신규 palette 부재 RED를 확인한다.
- [x] Step 4 — 검토된 JSON에 대응하는 `--color-customer-{light|dark}-{role}`와 위 select/sidebar 역할만 canonical theme에 추가하고 color inventory를 갱신한다. scanner/ref/baseline/CSS binding/화면 코드는 아직 바꾸지 않는다.
- [x] Step 5 — 같은 focused Node 검사와 `pnpm --filter @led-control/web exec vitest run src/components/ui/Typography.test.tsx`의 GREEN을 확인한다. 구 anchor 기준 전체 정책의 예상 FAIL을 별도 기록한다. `feat(ui): add reviewed ATLAS light and dark roles` 토큰 전용 로컬 커밋을 만든 뒤 BASE→HEAD 전체 토큰 diff를 독립 검토하고, 검수 승인한 실제 hash만 Task 2에 전달한다.

### Task 2: 정확한 customer alias와 정책 anchor 회전

**Files:** Modify `src/styles/base.css`, `scripts/ui-policy.mjs`, `scripts/ui-policy.test.mjs`, `scripts/ui-policy-baseline.json`, `scripts/customer-theme-contract.test.mjs`, `docs/ui-spacing.md`.

**Interfaces:** Task 1 palette를 기존 semantic 역할에 alias한다. selector는 `:root[data-customer-theme="light"]` / `:root[data-customer-theme="dark"]` 각각 1회, `color-scheme`도 해당 값이다. 새 css 파일/import·일반 selector allowlist를 추가하지 않는다. 승인 sourceRef는 Task 1의 실제 토큰 전용 commit이다.

- [x] Step 1 — `accepts only the complete reviewed customer bindings`와 `rejects missing duplicate mutated or extra customer binding`을 작성한다. 추가 selector/unknown alias/literal/중복/하나 빠짐은 각각 거부, 비고객 computed 기본값은 기존과 같다는 단언을 넣는다. `pnpm --filter @led-control/web test:ui-policy`로 새 정상 binding 거부 RED를 확인한다.
- [x] Step 2 — 검토된 두 정확한 alias 선언 집합만 base에 추가하고 scanner가 정확한 selector·property→token 값·개수·두 selector 필수 존재를 검사하도록 한다. token anchor/ref와 빈 baseline을 함께 회전한다. 임의 customer property·우회 stylesheet/selector/native form은 계속 차단한다.
- [x] Step 3 — `pnpm --filter @led-control/web test:ui-policy`, `pnpm --filter @led-control/web ui:check`, focused theme contract를 실행한다. 생성 CSS에서 고객 dark action foreground가 `#0F1724`, 기본 foreground는 `#FFFFFF`, theme 제거 후 기본 surface 복원을 확인한다.
- [x] Step 4 — 실제 anchor object/sourceRef·production 부채 0·기존 landing variant 경계를 독립 검토하고 `feat(ui): bind customer themes with fail-closed policy`로 커밋한다. 이 단계까지도 고객 테마 런타임은 아직 활성화하지 않는다.

### Task 3: 안정된 테마 provider·저장·전환·portal

**Files:** Create `src/components/ui/theme/customer-theme.ts`, `src/components/ui/theme/CustomerThemeProvider.tsx`, `src/components/ui/theme/ThemeToggle.tsx`, `src/components/ui/theme/useThemeColors.ts`, `src/components/ui/theme/CustomerThemeProvider.test.tsx`; Modify `src/components/ui/index.ts`, `src/features/shells/CustomerShell.tsx`, `src/features/shells/CustomerShell.test.tsx`, 네 `docs/menus/*.md`.

**Interfaces:** `CustomerTheme = "light" | "dark"`; `parseCustomerThemePreference(value: string|null): CustomerTheme`; `ThemePalette = Readonly<Record<ThemeColorToken,string>>`; `CustomerThemeProvider({children}: {children: ReactNode})`; `useCustomerTheme(): {theme: CustomerTheme; setTheme(theme: CustomerTheme): void; palette: ThemePalette; persistence: "available"|"unavailable"}`; `useThemeColors(): ThemePalette`는 provider 밖에서도 기존 기본 palette를 읽는다. `ThemeToggle({className?}: {className?: string})`는 context만 사용한다.

- [x] Step 1 — parser 검사에 `expect(parseCustomerThemePreference("dark")).toBe("dark")`, `expect(parseCustomerThemePreference("corrupted")).toBe("light")`를 넣는다. provider 검사 `preserves in-memory dark when storage throws`, `restores only its root attributes after StrictMode and logout`, `updates an open body portal without remounting children`, `applies cross-tab clear as light`를 작성한다. route/query identity와 mount count 불변도 단언한다.
- [x] Step 2 — `pnpm --filter @led-control/web exec vitest run src/components/ui/theme/CustomerThemeProvider.test.tsx`로 새 계약 RED를 확인한다.
- [x] Step 3 — stable provider를 CustomerShell 경계에 설치한다. layout 단계에서 자신의 root attribute/color-scheme alias 적용 후 computed palette를 발행하며 ownership-aware cleanup을 한다. storage read/write/listener는 try/catch·cleanup, persistence 실패는 현재 theme를 유지한다. setTheme는 query/route/명령 저장소를 호출하지 않는다. 초기 theme 적용도 첫 paint 전에 완료한다.
- [x] Step 4 — 아이콘 button은 공통 IconButton·44px·정확한 동작 이름·`aria-pressed`를 사용한다. ThemePalette 변경을 구독하는 hook만 제공하고 domain identity와 canvas를 재생성하지 않는다.
- [x] Step 5 — 위 unit 및 `CustomerShell.test.tsx`, `src/components/ui/overlays/overlays.test.tsx`, `Typography.test.tsx`를 함께 실행한다. 저장값/throw/삭제/다른 탭·portal·cleanup GREEN과 타입/UI 정책을 독립 검토한 뒤 `feat(ui): add persistent customer theme switching`으로 커밋한다.

### Task 4: 공통 UI·모바일 로고/select·sidebar 통일

**Files:** Audit `src/components/ui/Button.tsx`, `src/components/ui/IconButton.tsx`, `src/components/ui/Card.tsx`, `src/components/ui/MetricCard.tsx`, `src/components/ui/PageHeader.tsx`, `src/components/ui/StatusBadge.tsx`, `src/components/ui/UnderlineNavigation.tsx`, `src/components/ui/FilterPanel.tsx`, `src/components/ui/DataGrid.tsx`, `src/components/ui/fields/SelectBox.tsx`, `src/components/ui/overlays/Popover.tsx`, `src/components/ui/overlays/DialogBase.tsx`, `src/components/brand/KindaLogo.tsx`, `src/features/sites/SiteSwitcher.tsx`, `src/features/shells/CustomerShell.tsx`, `src/features/settings/SettingsView.tsx`; extend corresponding existing tests and `src/components/ui/ui-primitives.test.tsx`; update 네 메뉴 문서. 기존 semantic/RAC 계약을 이미 충족하는 primitive는 코드의 불필요한 cosmetic 변경 대신 파일별 확인·소비 회귀 증거를 보고한다. 계약 변경이 필요한 source만 수정하며 `src/features/shells/CustomerHeaderSummarySlot.tsx`·`.test.tsx`, `src/features/shells/SettingsNavigationItem.tsx`·`.test.tsx`를 추가 소유한다. 두 지정 E2E의 기존 header disclosure 계약은 새 항상-visible 집계 계약으로 대체하되 full-view/identity 단언을 보존한다. 승인된 geometry utility 병합을 위해 `src/components/ui/utils/cn.ts`·`cn.test.ts`의 기존 spacing registry/소비 회귀도 이 task 소유에 포함한다(토큰값/정책 변경 없음).

**Interfaces:** KindaLogo의 `presentation`에 `"header"|"workspace"`를 추가하고 접근성 이름을 보존한다. 고객 sidebar/workspace 글자는 content-primary를 사용하며 기본/landing/concept는 그대로다. 공통 SelectBox/SiteSwitcher의 기존 ref/onSelectionChange 계약은 유지한다. SettingsView에 필수 `capabilities: SiteCapabilities`를 추가하고 CustomerShell이 실제 capability를 전달한다. 페이지 담당은 이 prop을 재추론하지 않는다.

- [ ] Step 1 — `keeps real header branding and bounded site control in both themes`를 작성한다. 320/390/562px에서 logo와 trigger visible, trigger128/144px·hit44px·전체 option 이름·오류/없음/로딩, status center/theme 모두 접근 가능을 단언한다. desktop rail tooltip/keyboard/collapse, theme 버튼 Enter/Space activation 1회, overlay ESC/return focus도 추가한다.
- [ ] Step 2 — `pnpm --filter @led-control/web exec vitest run src/components/brand/KindaLogo.test.tsx src/features/sites/SiteSwitcher.test.tsx src/features/shells/CustomerShell.test.tsx src/components/ui/ui-primitives.test.tsx`로 새 계약 RED를 확인한다.
- [ ] Step 3 — 기존 primitives를 semantic alias로 통일한다. primary button은 별도 foreground token을 쓴다. 고객 logo의 헤더 mark·dark reversed asset은 실제 brand asset을 사용하고 landing/concept/default 표현을 보존한다. 필요한 component density는 고객 경계로 한정한다. native form·새 page-local card/button을 추가하지 않는다.
- [ ] Step 4 — 모바일 첫 행 logo/select/알림/theme, 두 번째 행 서버 현장 집계, 기존 eager 계정 영역을 유지한다. 760–1023px rail 기본, 넓은 화면220/80px 전환과 접근성 이름/tooltip, 중복 부제/현장 안내 정리를 구현한다. safe-area·focus/fullview·account/logout·권한 gate 수명은 유지한다. SettingsView capability 전달을 여기서 확정한다.
- [ ] Step 5 — above units, fields/FilterPanel/DataGrid/overlays·CustomerShell.monitoring 기존 unit, typecheck·ui:check와 `e2e/mobile-first-screen.spec.ts`, `e2e/app-shell-recovery.spec.ts`를 실행한다. 두 theme·비고객 기본 표현을 독립 검토하고 `feat(ui): unify ATLAS shell and shared controls`로 커밋한다.

### Task 5: 공통 operations 표현·지도 도구·테마 repaint

**Files:** Create `src/components/ui/operations/InlineStatusSummary.tsx`, `src/components/ui/operations/RecentActivityTicker.tsx`와 각각 `.test.tsx`, `src/components/ui/maps/OperationMapPanel.tsx`·`.test.tsx`; Modify `src/components/ui/index.ts`, `src/features/floor-map/FloorMapViewport.tsx`, `src/features/floor-map/FloorMapViewport.test.tsx`, `src/features/floor-map/FloorScene.tsx`, `src/features/floor-map/FloorScene.common-map.test.tsx`, `src/features/control/target-selection/SpatialTargetSelector.tsx`, `src/features/control/target-selection/TargetSelectionToolbar.tsx`와 기존 테스트, `src/features/floor-editor/FloorEditorCanvas.tsx`, `src/features/floor-editor/CadCandidateLayer.tsx`, `src/features/floor-editor/CadPlacementSlotLayer.tsx`, `src/features/floor-editor/EditorMinimap.tsx`, `src/features/floor-editor/CadSceneCanvas.tsx`, `src/features/floor-editor/CadElementPropertiesPanel.tsx`, `src/features/floor-editor/MapElementOverlay.tsx`, `src/features/floor-editor/CadElementOverlay.tsx`, `src/features/floor-editor/MapSelectionBoundsHandle.tsx`와 기존 대응 테스트; update 모니터링/제어/설정 메뉴 문서.

**Interfaces:** `InlineStatusSummary({label,items}: {label:string; items: readonly {id:string;label:string;value:number|null;tone:"info"|"success"|"warning"|"danger"|"neutral"}[]})`; `RecentActivityRow = {id:string;timestampLabel:string;content:ReactNode;status?:ReactNode}`를 ticker 파일과 UI barrel에서 export한다. `RecentActivityTicker`는 `{scopeKey:string; items:readonly RecentActivityRow[]; emptyContent:ReactNode; onOpen:()=>void; onRetry?:()=>void; triggerRef?:Ref<HTMLButtonElement>}`를 받는다. `OperationMapPanelProps = {title?:ReactNode;status?:ReactNode;tools?:ReactNode;children:ReactNode;className?:string}`이며 데이터/camera는 소유하지 않는다. SpatialTargetSelector에 `presentation?: "embedded"|"manual-workspace"`, FloorMapViewport에 `toolModePolicy?: "interaction-default"|"explicit"`를 추가한다. 기존 default는 보존한다.

- [ ] Step 1 — 인라인 `null→— / 0→0`, label14/count16, ticker 4999ms 무변화/5000ms 다음행, hover/focus/hidden pause·items/scope 초기화·unmount timer0을 작성한다. 지도 `explicit pan does not select`, `explicit area selects world rectangle`, `theme repaint retains camera and actual renderer canvas`를 추가한다. 저장 도형 색·사용자 색 draft 불변을 단언한다.
- [ ] Step 2 — common operations/maps 및 `FloorMapViewport.test.tsx`, `SpatialTargetSelector.test.tsx`를 `pnpm --filter @led-control/web exec vitest run`으로 실행해 신규 계약 RED를 확인한다.
- [ ] Step 3 — 도면 chrome/inline/ticker를 표현 전용으로 구현한다. manual opt-in에서 selection tools를 chrome slot으로 배치하고 항상 노출한다. explicit 도구 정책만 pan/select/area를 실제 gesture에 반영한다. Space/중간 버튼/touch pinch·hold/cancel/ghost click과 다른 embedded 소비자 기본 정책을 유지한다.
- [ ] Step 4 — 공유 지도/editor UI가 Task 3 palette를 구독하도록 하고 `useMemo([])` 색상과 draw effect의 theme 갱신을 수정한다. 원본 CAD/native renderer session/geometry·사용자 색 draft는 변경하지 않는다. renderer lifecycle은 기존 scope/platform을 유지하고 repaint만 요청한다. theme를 snapshot generation/viewport/camera scope에 넣지 않는다.
- [ ] Step 5 — operations unit, 공통 지도/editor 대응 unit과 `src/features/map-scene/MapSceneCanvas.test.tsx`, automation/group selector 회귀를 GREEN으로 확인한다. `e2e/control-map-target-selection.spec.ts`, `e2e/monitoring-navigation-confidence.spec.ts`, `e2e/settings-floor-editor.spec.ts`의 기존 identity/coordinate 계약을 대조하고 `feat(ui): share operation chrome and reactive map colors`로 커밋한다.

### Task 6: 모니터링 페이지 적용

**Files:** Modify `src/features/monitoring/MonitoringView.tsx`, `src/features/monitoring/MonitoringSummary.tsx`, `src/features/monitoring/FloorMap.tsx`, `src/features/monitoring/MonitoringLogTicker.tsx`, `src/features/monitoring/MonitoringLogDrawer.tsx`와 기존 `.test.tsx`, `docs/menus/monitoring.md`; Create `src/features/monitoring/monitoring-activity-presentation.ts`·`.test.ts`; extend `e2e/monitoring-surface-access.spec.ts`, `e2e/calm-operations-monitoring.spec.ts`.

**Interfaces:** MonitoringSummary 기존 `scope/mapName/total/online/fault/offline` 계약 유지. adapter `monitoringActivityRows(items: readonly MonitoringActivityItem[], timeZone:string): readonly RecentActivityRow[]`는 신규 `src/features/monitoring/monitoring-activity-presentation.ts`·`.test.ts`로 분리한다. MonitoringActivityItem은 기존 `@led-control/shared/monitoring-activity-contracts`, RecentActivityRow는 Task 5의 UI barrel export를 import한다. useMonitoringActivity의 조회/retention 계약은 그대로다.

- [ ] Step 1 — `uses server floor counts rather than loaded pins in both themes`, `does not advance server update time after failed refresh`, `keeps selected pin during theme change`를 작성한다. 서버 total24/loaded2·null/0, actual timestamp/timezone·반복 클릭 잠금·층 변경 취소, 5초/pause·retention/cursor recovery를 단언한다.
- [ ] Step 2 — `pnpm --filter @led-control/web exec vitest run src/features/monitoring/MonitoringView.test.tsx src/features/monitoring/MonitoringSummary.test.tsx src/features/monitoring/MonitoringLogTicker.test.tsx`로 새로운 표시/주기 RED를 확인한다.
- [ ] Step 3 — common inline/chrome/ticker를 연결하고 중복 도움말을 정리한다. 제목·서버 갱신·실제 refresh action·층 선택/검색/상세/목록·최근 활동을 배치한다. adapter는 실제 online/offline/fault·outcome/refreshStatus를 보존한다. 날짜/count/cursor 이외의 새 API 필터는 만들지 않는다.
- [ ] Step 4 — 위 units와 기존 FloorMap/LogDrawer/useMonitoringActivity/useMonitoringCameraMemory, 두 monitoring E2E를 실행한다. light/dark·selection/fullview/camera·집계/refresh를 검토하고 기본 checkout의 해당 목업 이력도 보존하여 `feat(monitoring): apply shared ATLAS monitoring layout`로 커밋한다.

### Task 7: 수동 제어·가용 높이·안전한 결과와 이력

**Files:** Modify `src/features/control/ControlView.tsx`, `src/features/control/CommandHistoryPanel.tsx`와 대응 테스트, `docs/menus/control.md`; Create `src/features/control/ManualExecutionPanel.tsx`·`.test.tsx`, `src/features/control/command-history-presentation.ts`·`.test.ts`; extend `e2e/calm-operations-manual-control.spec.ts`, `e2e/operational-marker-control-height.spec.ts`. 공통 shell 높이는 공통 소유자가 별도 순차 patch로 `src/features/shells/CustomerShell.tsx`·테스트에 반영한다.

**Interfaces:** ManualExecutionPanel은 현재 DimmingExecutionControls의 `brightness:number; controlsLocked:boolean; canSubmit:boolean; applyLabel:string; onBrightnessChange(value:number):void; onSubmit():void`를 받는 표현 경계다. 기존 invalid raw/restore refs는 이 컴포넌트 안에 보존하고 command owner는 ControlView에 남긴다. `commandHistoryRows(items: readonly Omit<CommandStatusResponse,"dispatches">[], timeZone:string): readonly RecentActivityRow[]`는 Task 5 타입을 소비한다. 최근 useCommandHistory limit은 기존1→5, 전체 이력 query는 그대로다.

- [ ] Step 1 — `theme resize and tool changes preserve the frozen uncertain command without another POST`, `invalid blur then Apply never sends`, `all recovery actions remain reachable in short desktop`를 작성한다. UUID/canonical payload·lock·A→B→A/remount·원래 대상 재적용, empty/decimal/range 입력, storage/404/410/긴 safety text·추가 POST0을 단언한다.
- [ ] Step 2 — `pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx src/features/control/CommandHistoryPanel.test.tsx src/features/control/ManualExecutionPanel.test.tsx`로 새 disclosure/height/ticker 계약 RED를 확인한다.
- [ ] Step 3 — manual-workspace opt-in으로 지도 도구/inline 상태/aside 시작선·직접 노출 brightness/Apply와 0/30/70/100% 값 선택을 적용한다. 빠른 값 선택은 draft만 바꾸며 POST는 발행하지 않는다. 정적 설명/range 끝 라벨·명령이 한 번도 없는 빈 결과만 제거한다. owner/frozen request/recovery는 같은 subtree에 계속 mounted 상태로 둔다. 기존 전체 선택 차단을 유지한다.
- [ ] Step 4 — authorized manual shell/viewport를 remaining-height 구조로 연결한다. 충분한 PC는 도면+aside+한 줄 이력, 짧은 PC는240px map 최소를 보존하는 내부 workspace scroll, 긴 결과는 aside 내부 scroll로 모든 safety action에 접근시킨다. mobile 자연 스크롤/safe-area는 유지한다. limit5 adapter만 추가하고 전체 이력/확인 사례 UUID 선택은 보존한다.
- [ ] Step 5 — 새 units와 active-command-store/session, control-selection, OutcomeActions/VerificationCases 기존 회귀·두 E2E·command-retention을 실행한다. 기본 checkout 목업 문서 이력을 보존하고 독립 safety/height 검토 후 `feat(control): apply ATLAS manual workspace safely`로 커밋한다.

### Task 8: 자동 제어·그룹/구역 탭

**Files:** Modify `src/features/control/ControlView.tsx`, `src/features/control/automation/ControlModeTabs.tsx`, `src/features/control/automation/ScheduleControlPanel.tsx`, `src/features/control/automation/VehicleEventControlPanel.tsx`, `src/features/control/automation/components/AutomationRuleTable.tsx`, `src/features/control/automation/components/AutomationWorkspaceSurface.tsx`, `src/features/control/FixtureGroupDialog.tsx`와 기존 대응 테스트; Create `src/features/control/groups/FixtureGroupsPanel.tsx`·`.test.tsx`; update `docs/menus/control.md`, `e2e/automation-control-flow.spec.ts`.

**Interfaces:** `ControlPageMode = "manual"|"schedule"|"event"|"group"`; ControlModeTabs는 기존 `mode/onChange`와 분리된 `allowAutomation:boolean; allowGroups:boolean`를 받는다. `FixtureGroupsPanel({siteId,dashboard,canManage,isActive=true,mutationsBlocked=false}: {siteId:string;dashboard:Dashboard;canManage:boolean;isActive?:boolean;mutationsBlocked?:boolean})`은 기존 Dialog의 내용·map editor를 재사용한다. Dialog는 isActive=open으로 기존 닫힘 시 query 정지·form reset을 보존한다. tab은 실제 isSubmitting/restorePending/commandInProgress/commandSessionBlocked/storageError를 mutationsBlocked로 전달한다. Dashboard는 `src/api/queries.ts`의 기존 타입을 import한다.

- [ ] Step 1 — `control-capable user can read groups but cannot mutate`, `group URL and roving focus survive back forward and theme`, `non-manager automation URL normalizes to manual preserving query`, `group tab cannot bypass an unresolved command mutation lock`를 작성한다. `mode=group`, siteId/hash·Arrow/Home/End·aria panel IDs, canManage=false/잠금 CRUD 차단·그룹 mutation0·UUID 보존, 닫힌 Dialog query 정지/reset을 단언한다. schedule/event pending/failed/retry·차량 필드를 유지하는 회귀를 넣는다.
- [ ] Step 2 — `pnpm --filter @led-control/web exec vitest run src/features/control/automation/ControlModeTabs.test.tsx src/features/control/ControlView.test.tsx src/features/control/FixtureGroupDialog.test.tsx`로 group URL의 기존 manual 정규화 RED를 확인한다.
- [ ] Step 3 — parser/type/tab/render·normalization을 함께 확장한다. manual/group 조회는 control-capable, schedule/event는 manage, group mutation은 canManage이고 command/storage 잠금이 없어야 한다. UI와 mutation handler 모두 guard한다. 실제 구역 CRUD/content를 독립 panel로 분리해 Dialog와 tab에서 공유한다. 기존 dialog 호출/닫힘·target/editor·configuring/retiring/resync guard는 유지한다.
- [ ] Step 4 — 자동 제어 surface/table/filter를 공통 표현에 맞추고 actual fields·timezone·정렬·활성 전환·실패/재시도를 보존한다. 신규 센서 계약을 만들지 않는다. above units와 Schedule/VehicleEvent/group editor·automation E2E를 GREEN으로 검토하고 `feat(control): align automation and saved-group surfaces`로 커밋한다.

### Task 9: 통계 개요·분석·보고서의 두 테마와 실제 정보

**Files:** Modify `src/features/statistics/StatisticsShell.tsx`, `src/features/statistics/StatisticsSubnavigation.tsx`, `src/features/statistics/StatisticsOverviewPage.tsx`, `src/features/statistics/EnergyComparisonChart.tsx`, `src/features/statistics/PeriodComparisonPanel.tsx`, `src/features/statistics/analysis/StatisticsAnalysisPage.tsx`, `src/features/statistics/analysis/EnergyRankingList.tsx`, `src/features/statistics/analysis/EnergyRankingDetailPanel.tsx`, `src/features/statistics/analysis/EnergyHeatmap.tsx`, `src/features/statistics/reports/StatisticsReportsPage.tsx`, `src/features/statistics/reports/ReportHistoryFilters.tsx`, `src/features/statistics/reports/ReportCreateDialog.tsx`, `src/features/statistics/reports/ReportJobList.tsx`, `src/features/statistics/reports/ReportJobStatus.tsx`와 기존 대응 테스트; Create `src/features/statistics/StatisticsOperationalInfo.tsx`·`.test.tsx`; update `docs/menus/statistics.md`.

**Interfaces:** `StatisticsOperationalInfo({summary}: {summary:EnergySummary})`는 기존 shared summary의 기간별 knownSeconds/unknownSeconds, nullable lastAggregatedAt, `baseline24Hours.fixtureCount`만 읽는다. 없는 값은 `—`로 유지하고 다른 API/계산을 만들지 않는다. Recharts는 Task 3 palette를 구독하며 축/tick/grid/tooltip/line/forecast/point를 semantic 역할로 지정한다.

- [ ] Step 1 — `repaints chart axes and missing heatmap cells without resetting selected period`, `theme does not abort or duplicate in-flight PDF and CSV`, `quality info preserves unknown aggregate time and collected zero`를 작성한다. theme 전후 selected range/168 cells·null/0/dashed gap/forecast·negative savings, job ID/poll/download bytes·URL·dialog/focus 불변을 단언한다.
- [ ] Step 2 — `pnpm --filter @led-control/web exec vitest run src/features/statistics/StatisticsOverviewPage.test.tsx src/features/statistics/EnergyComparisonChart.test.tsx src/features/statistics/analysis/EnergyHeatmap.test.tsx src/features/statistics/reports/StatisticsReportsPage.test.tsx src/features/statistics/StatisticsOperationalInfo.test.tsx`로 새 color/정보 표시 RED를 확인한다.
- [ ] Step 3 — 공통 tabs/header/card/filter/grid·큰 지표/그래프/순위/파일 우선 배치를 적용한다. 중복 CTA는 실제 품질 정보로 바꾸고 기간별 계산·완료 비교와 진행 예상·ranking/detail·signed file/expiry/failure/regenerate·날짜 draft/cursor를 유지한다. chart render를 palette에 구독시키되 key/remount는 사용하지 않는다.
- [ ] Step 4 — 통계 전체 unit 및 api/energy·mobile/file-download 회귀, `e2e/statistics-flow.spec.ts`, `statistics-surface-regression.spec.ts`, `statistics-mobile-files.spec.ts`를 실행한다. 실제 데이터 의미와 양 테마 색상/축/tooltip·파일 수명을 독립 검토하고 `feat(statistics): apply themed ATLAS statistics surfaces`로 커밋한다.

### Task 10: 설정 홈·하위 화면·권한과 미저장 상태

**Files:** Modify `src/features/settings/SettingsView.tsx`, `src/features/settings/SettingsShell.tsx`, `src/features/settings/SettingsSubnavigation.tsx`, `src/features/settings/settings-sections.ts`, `src/features/settings/settings-action-link.ts`, `src/features/settings/site/SiteOperationsView.tsx`, `src/features/settings/users/SiteUsersView.tsx`, `src/features/settings/registration/RegistrationSettingsView.tsx`, `src/features/settings/floor-plans/FloorPlanSettingsView.tsx`, `src/features/settings/security/AccountSecurityView.tsx`, `src/features/settings/security/PasswordSettingsView.tsx`와 대응 테스트; Create `src/features/settings/settings-card-model.ts`·`.test.ts`; update `docs/menus/settings.md`.

**Interfaces:** SettingsView는 Task 4의 실제 capabilities를 소비한다. `buildSettingsCards({dashboard,capabilities,userCount}: {dashboard:Dashboard;capabilities:SiteCapabilities;userCount:number|null}): readonly SettingsCardModel[]`; `SettingsCardModel = {id:string;label:string;path:string;icon:LucideIcon;summary:string}`이며 Dashboard/SiteCapabilities는 `src/api/queries.ts`, LucideIcon은 기존 lucide-react 타입이다. 기존 section capability 경계를 따른다. useSiteUsers는 manage+설치 완료일 때만 실제 siteId를 전달한다. 보안 card는 조회하지 않은 MFA 상태를 표시하지 않는다.

- [ ] Step 1 — `never issues users query for non-manager or pending site`, `mobile back preserves query hash and dirty editor confirmation`, `theme preserves MFA enrollment and recovery codes without new requests`를 작성한다. mapConfigured false/true, count null/0, same-origin Link guard·lease/fence/history/selection/camera/draft와 MFA 추가 start/confirm/revoke0을 단언한다.
- [ ] Step 2 — `pnpm --filter @led-control/web exec vitest run src/features/settings/SettingsView.test.tsx src/features/settings/SettingsShell.test.tsx src/features/settings/settings-card-model.test.ts src/features/settings/security/AccountSecurityView.test.tsx`로 새 card/back 계약 RED를 확인한다.
- [ ] Step 3 — 제목 `설정`, 실제 다섯 capability 기반 card·icon/요약, 영문/설명/화면환경/장식 제거, 모바일 탭 숨김을 적용한다. SettingsShell의 하위 모든 route에 `{pathname:"/settings",search:location.search,hash:location.hash}` Link 한 개를 제공한다. 계정/로그아웃 eager 영역·installation pending/setup·dirty guard는 유지한다.
- [ ] Step 4 — 하위 화면은 common controls/cards/filter/grid/themed chrome를 사용하고 기존 등록·현장/요금·사용자 계약·도면/CAD·MFA API는 유지한다. users count 권한 guard를 적용하고 fake email/admin/MFA 상태를 추가하지 않는다.
- [ ] Step 5 — settings unit과 FloorEditorRoute/step-ACK·FloorEditorView.save-ack/editor-drafts·PasswordSettings 회귀, `e2e/settings-operations.spec.ts`, `settings-mobile-lifecycle.spec.ts`, `account-security.spec.ts`, `site-user-management.spec.ts`를 실행한다. 권한/dirty 수명·light/dark/home return을 검토하고 `feat(settings): apply themed ATLAS settings navigation`으로 커밋한다.

### Task 11: 통합 시각·행동·접근성 검증과 전체 브랜치 검토

**Files:** Create `e2e/atlas-ui-refresh.spec.ts`; Modify 필요한 기존 E2E의 해당 요구 단언, 네 메뉴 문서, `docs/ui-spacing.md`, `docs/project-status.md`, 이 계획. 제품 결함은 원 소유자의 지정 task로 반환한다.

**Interfaces:** QA는 기존 API fixture/support와 실제 theme toggle을 사용한다. `data-shell-topbar`, `data-control-layout`, `data-control-panel`, 실제 canvas·route·POST 관측은 제품의 기존 공개 경계를 소비한다. 테스트용 production API/DOM 접근 우회를 만들지 않는다.

- [ ] Step 1 — 각 Task 3–10 test의 보존 경계를 통합 E2E에 연결한다. 양 theme에서 `scrollWidth <= clientWidth`, 표준 PC manual `document.scrollingElement.scrollHeight <= window.innerHeight`, 짧은 PC 내부 scroll·모든 safety action reachable, mobile logo/select/hit44를 단언한다. theme 전환 중 same canvas/camera/UUID·draft/PDF/MFA·추가 mutation0도 단언한다.
- [ ] Step 2 — 폭/높이 매트릭스 `320×740,390×844,562×1229,759.5/760/760.5×768,1024×600,1024×768,1304×1229,1440×900`에서 light/dark를 실제 CSS·renderer로 확인한다. phase 단위 정상 PNG·실패 원본·raw logs를 격리 산출물에 보존한다. 본문4.5:1·큰 글자/필수 UI3:1·focus/색 외 상태 라벨과 열린 portal를 대조한다.
- [ ] Step 3 — `pnpm --filter @led-control/web exec playwright test e2e/atlas-ui-refresh.spec.ts --project=chromium --workers=1`과 Tasks 4–10의 정확한 관련 suite, 기존 `e2e/monitoring-1000.spec.ts`를 실행한다. E2E는 기존15174 격리 설정을 사용하고 listener 충돌 시 소유 없는 서버를 재사용/종료하지 않는다.
- [ ] Step 4 — 같은 최종 소스에서 canonical `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`를 순차 실행한다. UI 정책도 fresh로 확인한다. 실패는 원인/소스와 함께 보존하며 전체 PASS로 바꾸지 않는다. native 실기기/HIL·외부 frame은 미검증으로 남긴다.
- [ ] Step 5 — 독립 요구/품질·UI/UX 전체 브랜치 검토와 원 소유자의 수정/재검증을 완료한다. Critical/Important 차단0과 문서·증거 일치를 확인하고 `test(ui): verify ATLAS themes and preserved workflows`로 커밋한다. 한 task의 GREEN을 다른 task/전체 PASS로 확대하지 않는다.

### Task 12: 사용자 변경 보존·로컬 병합·핸드오프

**Files:** Modify `docs/project-status.md`, 이 계획, 검증 결과에 따라 네 메뉴 문서만 정리. 제품/정책의 마지막 검증 commit을 정본으로 삼는다.

**Interfaces:** 기본 checkout `/Users/kim-jh/Documents/led-control-service`, 목적 branch `codex/mvp1-cloud-web`. 기본 두 메뉴 문서의 목업 이력과 작업 branch의 대응 기록을 diff로 대조하며 다른 변경은 소유자를 확인한다. 원격은 건드리지 않는다.

- [ ] Step 1 — `git status --short`, 두 branch log/diff·merge-base로 기본 branch 이동과 두 dirty 메뉴 문서의 일치를 확인한다. 동일한 기존 목업 이력은 이미 구현 branch에 보존돼 있어야 한다. 두 파일에 본 작업의 알려진 목업 이력만 남았음을 확인했을 때만 `git stash push -m "atlas-ui-refresh-preserve-mock-notes" -- docs/menus/monitoring.md docs/menus/control.md`로 경로 제한 복구 snapshot을 만들고 실제 stash commit ID를 기록한다. 사용자 변경이 섞였으면 자동 치우기 없이 방향을 받는다. reset·광범위 stash는 하지 않는다.
- [ ] Step 2 — 기본 branch가 이동했으면 해당 변경을 작업 branch에 보존 통합하고 충돌을 원 소유자에게 배정한다. 영향 검사와 Task 11 final gate를 새 통합 소스에서 다시 수행한다. 기본 dirty 변경 때문에 안전한 병합이 불가능하면 정확한 파일·이유를 보고 사용자 방향을 받는다.
- [ ] Step 3 — 독립 검토 승인 후 기본 checkout에서 `git merge --ff-only codex/atlas-ui-refresh-20261007`을 실행한다. ff 불가를 force/reset으로 우회하지 않는다. 완료 기록의 커밋도 정상 로컬 병합한다.
- [ ] Step 4 — 병합 제품 소스와 검증 소스 일치, 메뉴/정책 기록·원 dirty 이력 보존, fresh 웹 typecheck·전체 unit/UI 정책·build 및 핵심 shell/theme/manual 회귀를 확인한다. 기존 Web/API 재시작은 하지 않는다. 사용자에게 새 브랜치/커밋·병합/검증/미검증 범위를 전달하고 필요한 서비스 반영은 별도 안내한다.
- [ ] Step 5 — 자기 검증 자원만 정리하고 산출물/작업 branch와 문서 복구 snapshot을 보존한다. 이미 병합 문서에 포함된 목업 이력을 자동 stash pop/drop으로 중복 적용/삭제하지 않고 복구 ID를 핸드오프한다. 모든 체크는 실제 완료 후에만 표시한다. `docs: finalize ATLAS UI refresh verification and merge` 기록과 상태판을 동기화한다.

## 현재 준비 검증과 실행 승인

- [x] 기존 제품·테마·portal·renderer·페이지 경계를 읽기 전용으로 조사했다. 조사 자체는 제품 검증이 아니다.
- [x] 사용자 요청대로 명세의 라이트 우선 조건을 다크 실제 구현 포함으로 변경하고 이 실행 계획을 작성했다.
- [x] 메인이 spec coverage·단계/인터페이스 일치·Review Focus·과도한 범위를 self-review했다. 제품 테스트와 구현 task는 아직 실행하지 않았다.
- [x] 사용자가 최종 계획을 검토하고 페이지·기능 담당 에이전트 실행을 승인했다.
- [ ] Task 1–12의 구현·독립 검토·통합 검증·로컬 병합을 실제로 완료했다.

요청한 페이지별 에이전트 방식으로 공통 기반부터 순차 진행한다. 수정 요청은 명세/계획에 함께 반영한다.

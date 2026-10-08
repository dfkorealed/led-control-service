# ATLAS 라이트·다크 고객 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 ATLAS 목업과 모바일 수정 의견을 실제 네 메뉴에 공통화하여 적용하고, 상태를 보존하는 라이트·다크 전환을 제공한 뒤 검증·로컬 병합한다.

**Architecture:** 기존 React Aria/Tailwind semantic UI와 API·기능 owner를 유지한다. canonical token의 두 고객 palette를 고객 shell 활성 중에만 root semantic 역할에 연결하고, 안정된 theme provider가 저장·portal·reactive color 갱신을 소유한다. 공통 기반과 공유 지도를 먼저 확정한 뒤 페이지 담당들이 같은 계약을 소비한다.

**Tech Stack:** React 18, TypeScript, React Aria, Tailwind CSS 4, React Query, React Router, Konva/Pixi, Recharts, Vitest, Playwright. 기존 lockfile·의존성 유지, 검증 runtime Node 22·pnpm 9.15.0.

**Spec:** [다크 포함 설계 명세](../specs/2026-10-07-atlas-ui-refresh-design.md)

상태: **Tasks 1–10 구현·독립 검토 완료, 2026-10-08 사용자 재개 승인·Task 11 PC 검증 구조 보완 진행·Task 12 검증 후 로컬 병합 예정**. 사용자가 선택한 실행 방식은 **페이지별 에이전트 분담, 메인 오케스트레이션, 별도 브랜치 후 로컬 병합**이다. 완료 표시는 독립 검토와 실제 증거를 회수한 뒤 갱신한다. 역사적 웹 모듈 실패의 원인과 통합 브라우저 검증은 Task11 관문에 남아 있어 전체 완료·병합을 뜻하지 않는다.

## Global Constraints

- 작업 checkout은 `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-ui-refresh-20261007`, 브랜치는 `codex/atlas-ui-refresh-20261007`, 출발 제품은 `5e173fb4663fb9544cc0a6e74fa985c94218cfcb`다.
- API·공유 스키마·DB·MQTT·Gateway·펌웨어·native 외부 frame은 변경하지 않는다. 원격 push/PR/배포/실장비 조작을 하지 않는다.
- 목업은 디자인 참고만 한다. 가상 시나리오·SVG 도면·센서 이벤트·가짜 보고서·오프라인 제외 후 실행 정책은 이식하지 않는다.
- canonical `@theme static`, 기존 기본/brand/landing 값, 승인 간격 스케일과 금지 literal/native form/selector 규칙을 보존한다. 토큰 전용 커밋 후 별도 anchor rotation 검토, 빈 baseline·production 정책 부채 0건을 유지한다.
- 고객 theme 저장은 `led-control.customer-theme.v1`의 `light|dark`, 기본·잘못된 값·읽기 실패는 light다. 저장 실패는 현재 탭 전환을 막지 않는다. 시스템 테마 자동 연동은 범위 밖이다.
- theme는 CustomerShell 활성 동안만 html `data-customer-theme`에 적용하고 cleanup한다. 페이지·QueryClient·명령·renderer·editor identity에 theme를 넣지 않는다. 원본 CAD/도형 색과 사용자 색상 draft는 보존한다.
- 모바일 `<760px`, 경계 검증 `759.5/760/760.5px`. 현장 select 너비는 `<360px`에서 128px, `360px 이상`에서 144px, 최소 조작 hit 44px. sidebar 고객 geometry는 펼침 220px·rail 80px이다.
- 도면 상태는 인라인 라벨 14px·수치 16px, ticker는 5초. PC 수동 제어 외부 세로 스크롤 0, 짧은 1024×600은 내부 workspace 스크롤과 실제 조작 viewport/client 최소 240px을 보존한다. 내부 CAD맞춤 canvas의 실제 표시·DOM/count/camera는 별도 보존하며 CAD비율이나 배율을 높이 기준에 맞춰 바꾸지 않는다. 모바일은 자연 세로 스크롤이다.
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

- [x] Step 1 — `keeps real header branding and bounded site control in both themes`를 작성한다. 320/390/562px에서 logo와 trigger visible, trigger128/144px·hit44px·전체 option 이름·오류/없음/로딩, status center/theme 모두 접근 가능을 단언한다. desktop rail tooltip/keyboard/collapse, theme 버튼 Enter/Space activation 1회, overlay ESC/return focus도 추가한다.
- [x] Step 2 — `pnpm --filter @led-control/web exec vitest run src/components/brand/KindaLogo.test.tsx src/features/sites/SiteSwitcher.test.tsx src/features/shells/CustomerShell.test.tsx src/components/ui/ui-primitives.test.tsx`로 새 계약 RED를 확인한다.
- [x] Step 3 — 기존 primitives를 semantic alias로 통일한다. primary button은 별도 foreground token을 쓴다. 고객 logo의 헤더 mark·dark reversed asset은 실제 brand asset을 사용하고 landing/concept/default 표현을 보존한다. 필요한 component density는 고객 경계로 한정한다. native form·새 page-local card/button을 추가하지 않는다.
- [x] Step 4 — 모바일 첫 행 logo/select/알림/theme, 두 번째 행 서버 현장 집계, 기존 eager 계정 영역을 유지한다. 760–1023px rail 기본, 넓은 화면220/80px 전환과 접근성 이름/tooltip, 중복 부제/현장 안내 정리를 구현한다. safe-area·focus/fullview·account/logout·권한 gate 수명은 유지한다. SettingsView capability 전달을 여기서 확정한다.
- [x] Step 5 — above units, fields/FilterPanel/DataGrid/overlays·CustomerShell.monitoring 기존 unit, typecheck·ui:check와 `e2e/mobile-first-screen.spec.ts`, `e2e/app-shell-recovery.spec.ts`를 실행한다. 두 theme·비고객 기본 표현을 독립 검토하고 `feat(ui): unify ATLAS shell and shared controls`로 커밋한다.

### Task 5: 공통 operations 표현·지도 도구·테마 repaint

**Files:** Create `src/components/ui/operations/InlineStatusSummary.tsx`, `src/components/ui/operations/RecentActivityTicker.tsx`와 각각 `.test.tsx`, `src/components/ui/maps/OperationMapPanel.tsx`·`.test.tsx`; Modify `src/components/ui/index.ts`, `src/features/floor-map/FloorMapViewport.tsx`, `src/features/floor-map/FloorMapViewport.test.tsx`, `src/features/floor-map/FloorScene.tsx`, `src/features/floor-map/FloorScene.common-map.test.tsx`, `src/features/control/target-selection/SpatialTargetSelector.tsx`, `src/features/control/target-selection/TargetSelectionToolbar.tsx`와 기존 테스트, `src/features/floor-editor/FloorEditorCanvas.tsx`, `src/features/floor-editor/CadCandidateLayer.tsx`, `src/features/floor-editor/CadPlacementSlotLayer.tsx`, `src/features/floor-editor/EditorMinimap.tsx`, `src/features/floor-editor/CadSceneCanvas.tsx`, `src/features/floor-editor/CadElementPropertiesPanel.tsx`, `src/features/floor-editor/MapElementOverlay.tsx`, `src/features/floor-editor/CadElementOverlay.tsx`, `src/features/floor-editor/MapSelectionBoundsHandle.tsx`와 기존 대응 테스트; update 모니터링/제어/설정 메뉴 문서.

**Interfaces:** `InlineStatusSummary({label,items}: {label:string; items: readonly {id:string;label:string;value:number|null;tone:"info"|"success"|"warning"|"danger"|"neutral"}[]})`; `RecentActivityRow = {id:string;timestampLabel:string;content:ReactNode;status?:ReactNode}`를 ticker 파일과 UI barrel에서 export한다. `RecentActivityTicker`는 `{scopeKey:string; items:readonly RecentActivityRow[]; emptyContent:ReactNode; onOpen:()=>void; onRetry?:()=>void; triggerRef?:Ref<HTMLButtonElement>}`를 받는다. `OperationMapPanelProps = {title?:ReactNode;status?:ReactNode;tools?:ReactNode;children:ReactNode;className?:string}`이며 데이터/camera는 소유하지 않는다. SpatialTargetSelector에 `presentation?: "embedded"|"manual-workspace"`, FloorMapViewport에 `toolModePolicy?: "interaction-default"|"explicit"`를 추가한다. 기존 default는 보존한다.

- [x] Step 1 — 인라인 `null→— / 0→0`, label14/count16, ticker 4999ms 무변화/5000ms 다음행, hover/focus/hidden pause·items/scope 초기화·unmount timer0을 작성한다. 지도 `explicit pan does not select`, `explicit area selects world rectangle`, `theme repaint retains camera and actual renderer canvas`를 추가한다. 저장 도형 색·사용자 색 draft 불변을 단언한다.
- [x] Step 2 — common operations/maps 및 `FloorMapViewport.test.tsx`, `SpatialTargetSelector.test.tsx`를 `pnpm --filter @led-control/web exec vitest run`으로 실행해 신규 계약 RED를 확인한다.
- [x] Step 3 — 도면 chrome/inline/ticker를 표현 전용으로 구현한다. manual opt-in에서 selection tools를 chrome slot으로 배치하고 항상 노출한다. explicit 도구 정책만 pan/select/area를 실제 gesture에 반영한다. Space/중간 버튼/touch pinch·hold/cancel/ghost click과 다른 embedded 소비자 기본 정책을 유지한다.
- [x] Step 4 — 공유 지도/editor UI가 Task 3 palette를 구독하도록 하고 `useMemo([])` 색상과 draw effect의 theme 갱신을 수정한다. 원본 CAD/native renderer session/geometry·사용자 색 draft는 변경하지 않는다. renderer lifecycle은 기존 scope/platform을 유지하고 repaint만 요청한다. theme를 snapshot generation/viewport/camera scope에 넣지 않는다.
- [x] Step 5 — operations unit, 공통 지도/editor 대응 unit과 `src/features/map-scene/MapSceneCanvas.test.tsx`, automation/group selector 회귀를 GREEN으로 확인한다. `e2e/control-map-target-selection.spec.ts`, `e2e/monitoring-navigation-confidence.spec.ts`, `e2e/settings-floor-editor.spec.ts`의 기존 identity/coordinate 계약을 대조하고 `feat(ui): share operation chrome and reactive map colors`로 커밋한다.

### Task 6: 모니터링 페이지 적용

**Files:** Modify `src/features/monitoring/MonitoringView.tsx`, `src/features/monitoring/MonitoringSummary.tsx`, `src/features/monitoring/FloorMap.tsx`, `src/features/monitoring/MonitoringLogTicker.tsx`와 기존 `.test.tsx`, 기존 `src/features/monitoring/monitoring-activity-presentation.ts`·`.test.ts`, `docs/menus/monitoring.md`; `docs/menus/control.md`는 Task5 공통 집계 글씨의 실제 body/body-lg=14/16 보완 기록만 갱신한다; Audit `src/features/monitoring/MonitoringLogDrawer.tsx`·`.test.tsx`의 기존 공통 LogView/FilterPanel/DateRangeDraft·cursor/retention/권한·safe-area/focus 계약을 회귀 검사로 확인하며 이미 충족하면 불필요한 source 변경을 하지 않는다; extend `e2e/monitoring-surface-access.spec.ts`, `e2e/calm-operations-monitoring.spec.ts`.

**Consumer test handoff:** `src/App.test.tsx`와 `src/features/shells/CustomerShell.monitoring.test.tsx`의 기존 개별 MetricCard group locator만 실제 선택층 region의 single read-only inline group/label-value로 갱신한다. 전체 웹 검사에서 확인한 4개 locator 실패를 focused 회귀로 해결하고 실제 hardware POST1·query·선택 상세·lock·가시성/값 단언은 보존한다. 제품 App/CustomerShell source는 이 handoff에서 변경하지 않는다.

**I1 shared camera handoff:** 독립 검수의 legacy revision100 reset 실패는 `src/features/monitoring/FloorMap.test.tsx`의 실제 FloorMap/memory/viewport controlled regression으로 원인을 증명한다. 검증된 fit/restore 뒤 camera frame 발행 전 크기 변경이 이전120 camera를 복원하므로 공통 지도 owner가 `src/features/floor-map/FloorMapViewport.tsx`의 validated restoreCamera snapshot/queued resize cache만 순차 보완한다. geometry/RAF/clock/tolerance/API/key/default gestures는 보존한다. Page owner는 새 regression/기존 shared consumers·원 browser/타입/UI/build를 취합하고 모니터링·제어·설정 문서에 이 공통 카메라 보완과 검증 한계만 같은 작업에서 기록한다. 공통 patch 중 page source·시험·stage는 동결한다.

**Interfaces:** MonitoringSummary 기존 `scope/mapName/total/online/fault/offline` 계약 유지. adapter `monitoringActivityRows(items: readonly MonitoringActivityItem[], timeZone:string): readonly RecentActivityRow[]`는 기존 `src/features/monitoring/monitoring-activity-presentation.ts`·`.test.ts`를 보존 확장한다. 기존 formatter/분류 함수는 덮어쓰거나 중복 생성하지 않는다. MonitoringActivityItem은 기존 `@led-control/shared/monitoring-activity-contracts`, RecentActivityRow는 Task 5의 UI barrel export를 import한다. useMonitoringActivity의 조회/retention 계약은 그대로다.

- [x] Step 1 — `uses server floor counts rather than loaded pins in both themes`, `does not advance server update time after failed refresh`, `keeps selected pin during theme change`를 작성한다. 서버 total24/loaded2·null/0, actual timestamp/timezone·반복 클릭 잠금·층 변경 취소, 5초/pause·retention/cursor recovery를 단언한다.
- [x] Step 2 — `pnpm --filter @led-control/web exec vitest run src/features/monitoring/MonitoringView.test.tsx src/features/monitoring/MonitoringSummary.test.tsx src/features/monitoring/MonitoringLogTicker.test.tsx`로 새로운 표시/주기 RED를 확인한다.
- [x] Step 3 — common inline/chrome/ticker를 연결하고 중복 도움말을 정리한다. 제목·서버 갱신·실제 refresh action·층 선택/검색/상세/목록·최근 활동을 배치한다. adapter는 실제 online/offline/fault·outcome/refreshStatus를 보존한다. 날짜/count/cursor 이외의 새 API 필터는 만들지 않는다.
- [x] Step 4 — 위 units와 기존 FloorMap/LogDrawer/useMonitoringActivity/useMonitoringCameraMemory, 두 monitoring E2E를 실행한다. light/dark·selection/fullview/camera·집계/refresh를 검토하고 기본 checkout의 해당 목업 이력도 보존하여 `feat(monitoring): apply shared ATLAS monitoring layout`로 커밋한다.

Task6 승인 범위: 구현 `aa28dfab`와 카메라 수정 `01afab05`/`916acc58`, 독립 원 검토와 I1 scoped 재검토로 새 C/I0. 수정 소스 related234·editor62·원 browser7·타입/UI/build는 통과했다. 원 두 E2E 마지막71/5와 전체Web3327/4/3·수정 뒤3179/87/3 및66 미수집·unhandled1은 보존한다. 실패3파일 focused224PASS는 별도 결과이며 ApiError 전체 실행 원인은 아직 미확립이다. Task11 canonical/전체 브랜치 관문을 대체하지 않는다.

### Task 7: 수동 제어·가용 높이·안전한 결과와 이력

**Files:** Modify `src/features/control/ControlView.tsx`, `src/features/control/CommandHistoryPanel.tsx`, `src/features/control/target-selection/SpatialTargetSelector.tsx`와 대응 테스트, `docs/menus/control.md`; Create `src/features/control/ManualExecutionPanel.tsx`·`.test.tsx`, `src/features/control/command-history-presentation.ts`·`.test.ts`; extend `e2e/calm-operations-manual-control.spec.ts`, `e2e/operational-marker-control-height.spec.ts`. 공통 shell 높이는 공통 소유자가 별도 순차 patch로 `src/features/shells/CustomerShell.tsx`·테스트에 반영한다. 독립 검토의 dialog-trigger 의미 복원은 원 operations 공통 owner가 `src/components/ui/operations/RecentActivityTicker.tsx`·`.test.tsx` 두 파일에 기본 소비자 의미를 보존하는 선택적 prop으로 반영한다.

**Interfaces:** ManualExecutionPanel은 현재 DimmingExecutionControls의 `brightness:number; controlsLocked:boolean; canSubmit:boolean; applyLabel:string; onBrightnessChange(value:number):void; onSubmit():void`를 받는 표현 경계다. 기존 invalid raw/restore refs는 이 컴포넌트 안에 보존하고 command owner는 ControlView에 남긴다. `commandHistoryRows(items: readonly Omit<CommandStatusResponse,"dispatches">[], timeZone:string): readonly RecentActivityRow[]`는 Task 5 타입을 소비한다. 최근 useCommandHistory limit은 기존1→5, 전체 이력 query는 그대로다.

**Review fix handoff:** 일반 parent/명령 polling 렌더에서 history 훅이 새 배열을 반환해도 실제 최근 내용·scope가 같으면5초 순환이 유지돼야 한다. 최신 click guard/callback·disabled/selected/retention/error는 현재 값을 유지하고 실제 내용·scope 변경은 원 ticker reset 계약을 유지한다. adapter의 실제 표현 tuple/순서/시간대 기준으로 row identity를 안정화하고, private unkeyed presentation Context는 최신 disabled/selectedCommandId/onSelect만 전달한다. 이 Context는 state/query/UUID/request/command/theme owner를 소유·이동하지 않고 data undefined/error/fetching/retention을 이전 rows로 감추지 않는다. 공통 ticker의 선택적 `triggerHasPopup?: "dialog"`는 그대로 Button의 aria-haspopup에 전달하며 생략한 소비자는 기존 의미를 유지한다. 제어 adapter만 dialog를 명시하고 실제 opener 소비 회귀를 복원한다. 신규 reset identity/API가 필요하면 먼저 인터페이스 범위를 승인받는다.

**Shell handoff:** ControlView가 optional `onManualWorkspaceActiveChange?: (active:boolean)=>void`를 먼저 제공한다. resolved manual mode·canControl·실제 dashboard/site 일치만 layout effect로 보고하고 cleanup에서 false를 보낸다. fetching/canSubmit/명령 잠금에 연동하지 않는다. 그 후 공통 소유자가 CustomerShell+tests에 stable callback/state 연결과 desktop remaining-height 표현을 순차 적용한다. Shell은 URL·권한을 다시 해석하지 않고 기존 route/gate/fullview 및 `<760px` 자연 흐름을 유지한다. owner/provider/subtree/key와 명령 수명은 바꾸지 않는다.

**Displayed map summary handoff:** 현재 도면 층은 SpatialTargetSelector의 activeFloor가 소유하므로 수동 제어 인라인 상태는 이 컴포넌트의 manual-workspace 표현에서 기존 OperationMapPanel.status에 전달한다. 기존 DashboardFloor.summary의 totalFixtures/onlineFixtures/faultFixtures/offlineFixtures를 사용하고 누락은 null→`—`, 실제0은 `0`으로 유지한다. 현장 전체·선택 수·로딩된 fixtures로 대체 집계하지 않는다. 원 공유 지도 owner가 selector/test 두 파일만 순차 수정하며 신규 public prop/query·camera/gesture/key·embedded 표현은 변경하지 않는다. 짧은 PC의 실제 지도 chrome wheel이 내부 workspace로 전달되도록 같은 manual-workspace 조건의 content에만 `compact:overscroll-auto`를 적용한다. 모바일·기본 embedded의 `overscroll-contain`을 유지하고 실제 trusted wheel/owner scroll·camera 불변 및 기존 gesture를 검증한다.

- [x] Step 1 — `theme resize and tool changes preserve the frozen uncertain command without another POST`, `invalid blur then Apply never sends`, `all recovery actions remain reachable in short desktop`를 작성한다. UUID/canonical payload·lock·A→B→A/remount·원래 대상 재적용, empty/decimal/range 입력, storage/404/410/긴 safety text·추가 POST0을 단언한다.
- [x] Step 2 — `pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx src/features/control/CommandHistoryPanel.test.tsx src/features/control/ManualExecutionPanel.test.tsx`로 새 disclosure/height/ticker 계약 RED를 확인한다.
- [x] Step 3 — manual-workspace opt-in으로 지도 도구/inline 상태/aside 시작선·직접 노출 brightness/Apply와 0/30/70/100% 값 선택을 적용한다. 빠른 값 선택은 draft만 바꾸며 POST는 발행하지 않는다. 정적 설명/range 끝 라벨·명령이 한 번도 없는 빈 결과만 제거한다. owner/frozen request/recovery는 같은 subtree에 계속 mounted 상태로 둔다. 기존 전체 선택 차단을 유지한다.
- [x] Step 4 — authorized manual shell/viewport를 remaining-height 구조로 연결한다. 충분한 PC는 도면+aside+한 줄 이력, 짧은 PC는240px map 최소를 보존하는 내부 workspace scroll, 긴 결과는 aside 내부 scroll로 모든 safety action에 접근시킨다. mobile 자연 스크롤/safe-area는 유지한다. limit5 adapter만 추가하고 전체 이력/확인 사례 UUID 선택은 보존한다.
- [x] Step 5 — 새 units와 active-command-store/session, control-selection, OutcomeActions/VerificationCases 기존 회귀·두 E2E·command-retention을 실행한다. 기본 checkout 목업 문서 이력을 보존하고 독립 safety/height 검토 후 `feat(control): apply ATLAS manual workspace safely`로 커밋한다.

- Task 7 구현은 공통 shell `167d06d6`·수동 제어 `da235187`와 회귀 수정 `16025b44`를 독립 검토해 완료했다. 실제 polling의5초 순환·최신 잠금/콜백·fail-closed 이력과 선택적 dialog annotation을 보완했고 scoped Spec✅/Quality Approved·새C0/I0/M0·열린지적0이다. 수정 최종소스 관련501/15files·지정3E2E71PASS·전체Web3371PASS/기존3SKIP·타입/UI/build0을 확인했다. 원RED/중간FAIL/각source 증거와 Task6 runtime·Task11 native/firstpaint/portal/hit/non-manager 관문은 별도로 유지한다.

### Task 8: 자동 제어·그룹/구역 탭

**Files:** Modify `src/features/control/ControlView.tsx`, `src/features/control/automation/ControlModeTabs.tsx`, `src/features/control/FixtureGroupDialog.tsx`와 기존 대응 테스트; Create `src/features/control/groups/FixtureGroupsPanel.tsx`·`.test.tsx`, 같은 domain의 private `useFixtureGroupsWorkspace.ts`·`FixtureGroupsContent.tsx`와 필요한 covering tests; Audit `src/features/control/automation/ScheduleControlPanel.tsx`, `src/features/control/automation/VehicleEventControlPanel.tsx`, `src/features/control/automation/components/AutomationRuleTable.tsx`, `src/features/control/automation/components/AutomationWorkspaceSurface.tsx`와 대응 소비 회귀(이미 공통 semantic 계약을 충족하면 불필요한 source rewrite 없이 파일별 근거를 보고한다); update `docs/menus/control.md`, `e2e/automation-control-flow.spec.ts`.

**Interfaces:** `ControlPageMode = "manual"|"schedule"|"event"|"group"`; ControlModeTabs는 기존 `mode/onChange`와 분리된 `allowAutomation:boolean; allowGroups:boolean`를 받는다. `FixtureGroupsPanel({siteId,dashboard,canManage,isActive=true,mutationsBlocked=false}: {siteId:string;dashboard:Dashboard;canManage:boolean;isActive?:boolean;mutationsBlocked?:boolean})`은 기존 Dialog의 내용·map editor를 재사용한다. Dialog는 isActive=open으로 기존 닫힘 시 query 정지·form reset을 보존한다. tab은 실제 isSubmitting/restorePending/commandInProgress/commandSessionBlocked/storageError를 mutationsBlocked로 전달한다. Dashboard는 `src/api/queries.ts`의 기존 타입을 import한다.

**Extraction handoff:** Panel의 public props는 그대로 유지한다. 기존 Dialog의 동적 form title/class/body·pending-close·return focus는 wrapper가 계속 소유할 수 있도록 같은 groups domain의 private hook과 내용 component를 공유한다. Dialog는 hook에 isActive=open을 전달하며 tab Panel은 같은 hook/content를 사용한다. public Panel을 Dialog가 직접 렌더링하도록 강제하지 않는다. 동시 활성 query/poller·중복 form/editor owner를 만들지 않고 기존 site query/cache/membership·닫힘 reset·현재 권한/실행/storage handler guards를 유지한다. 새 common/public callback·presentation bridge/provider·command/theme/query scope key는 추가하지 않는다.

**Principal handoff:** 새 그룹 탭 consumer의 `FixtureGroupsPanel`만 기존 automation과 같은 `key={`${userId}:${data.site.id}`}`로 실제 사용자·현장 경계를 격리한다. Panel public props/query key/API는 그대로며 command owner인 ControlView·theme/provider는 재마운트하지 않는다. theme/mode/선택/잠금/반복 query는 key에 포함하지 않는다. 같은 현장의 실제 userId 변경·A→B→A와 이전 pending completion에서 draft/message/editor 표현 격리, 현재 권한/잠금 handler·query/poller cleanup을 회귀로 확인한다. 기존 Dialog는 원 parent의 user/site 변경 시 닫힘/reset 계약을 보존한다.

**Validation handoff:** 지정 automation-control-flow는 기존 RealBackendLab suite다. 현재 설치된 binary만 사용하고 실제 free15174·명시된 자체 infra ports, unique worktree lab dir/private socket/test DB/PKI/process 범위에서 기존 harness를 직렬 실행한다. 기존 migrations/seed는 새 lab-owned DB에만 적용한다. 실제 서비스/DB·실장비·API/schema/harness/config·설치를 변경하지 않는다. 없는 prerequisite/startup 실패는 body 미실행과 구분해 원로그로 보존하며 skip/mock 대체하지 않는다. 자신의 검증 자원만 정리하고 실제 listener 종료를 확인한다.

첫 Lab은 startup 후 기존 non-exact label이 실제 관리자 textbox와 숨은 Grid sort select를 함께 찾으며 site 생성 전에 실패했다. 원 실패를 보존하고 기존 생성 dialog의 정확한 입력/버튼으로만 locator를 제한한 추가 Lab 1회를 승인했다. 원 payload/network/단언/timeout/helper/harness/config는 그대로다. 숨은 select 접근이름은 이 교정으로 해결됐다고 주장하지 않으며 Task11에 관찰을 전달한다.

Lab2는 first-connect protocol convergence 후 카드 목록에서 기존 table-only selector가 실패했다. 실제 DataGrid의 표/카드 공통 규칙 locator와 두 스케줄 활성 단언만 정확한 활성+APPLIED 상태로 교정한 Lab3 단일 실행을 승인했다. 원20초·실제 명령/프로토콜/삭제/재시작 기대와 실패 기록을 보존하고 제품 반응형 정책이나 harness를 바꾸지 않는다.

Lab3의 수동 성공문구는 Task7의 실제 기본접힘 상세 안에 보존돼 있었다. 현재 명령 status의 상세 보기 조작 후 최근 결과 상세 region에서 원 exact 완료·저장 문구를 같은15초로 검사하는 Lab4 단일 실행을 승인했다. 실제60%/후속protocol/UUID/network 기대와 앞선 실패는 유지하며 성공badge로 대체하지 않는다.

- [x] Step 1 — `control-capable user can read groups but cannot mutate`, `group URL and roving focus survive back forward and theme`, `non-manager automation URL normalizes to manual preserving query`, `group tab cannot bypass an unresolved command mutation lock`를 작성한다. `mode=group`, siteId/hash·Arrow/Home/End·aria panel IDs, canManage=false/잠금 CRUD 차단·그룹 mutation0·UUID 보존, 닫힌 Dialog query 정지/reset을 단언한다. schedule/event pending/failed/retry·차량 필드를 유지하는 회귀를 넣는다.
- [x] Step 2 — `pnpm --filter @led-control/web exec vitest run src/features/control/automation/ControlModeTabs.test.tsx src/features/control/ControlView.test.tsx src/features/control/FixtureGroupDialog.test.tsx`로 group URL의 기존 manual 정규화 RED를 확인한다.
- [x] Step 3 — parser/type/tab/render·normalization을 함께 확장한다. manual/group 조회는 control-capable, schedule/event는 manage, group mutation은 canManage이고 command/storage 잠금이 없어야 한다. UI와 mutation handler 모두 guard한다. 실제 구역 CRUD/content를 독립 panel로 분리해 Dialog와 tab에서 공유한다. 기존 dialog 호출/닫힘·target/editor·configuring/retiring/resync guard는 유지한다.
- [x] Step 4 — 자동 제어 surface/table/filter를 공통 표현에 맞추고 actual fields·timezone·정렬·활성 전환·실패/재시도를 보존한다. 신규 센서 계약을 만들지 않는다. above units와 Schedule/VehicleEvent/group editor·automation E2E를 GREEN으로 검토하고 `feat(control): align automation and saved-group surfaces`로 커밋한다.

- Task 8 구현 `8070f997`와 여백 보완 `3f1b605d`를 독립 검토해 완료했다. 정확한 public Panel/private 공유 owner·현재 권한/command/storage handler guard·실제 user/site 격리·URL/hash/키보드를 보존했고, M1 tab inset은 기존 p-4만 적용해 scoped Spec✅/Quality Approved·새C0/I0/M0·열린0이다. 수정 최종소스 관련192/4files·실제 Lab5 전체 자동화+group 여정1PASS·6phase 양테마 inset/동일editor/draft/추가writes0·전체Web3391PASS/기존3SKIP·타입/UI/build0을 확인했다. 원Lab1–3 실패/Lab4 PASS/EOF-only source 경계·수치attach 미저장과 native/HIL/Task11 carry는 별도 보존한다.

### Task 9: 통계 개요·분석·보고서의 두 테마와 실제 정보

**Files:** Modify `src/features/statistics/StatisticsOverviewPage.tsx`, `src/features/statistics/EnergyComparisonChart.tsx`, `src/features/statistics/analysis/EnergyRankingDetailPanel.tsx`, `src/features/statistics/analysis/EnergyHeatmap.tsx`와 기존 대응 테스트; Create `src/features/statistics/StatisticsOperationalInfo.tsx`·`.test.tsx`; update `docs/menus/statistics.md`. Audit `src/features/statistics/StatisticsShell.tsx`, `src/features/statistics/StatisticsSubnavigation.tsx`, `src/features/statistics/PeriodComparisonPanel.tsx`, `src/features/statistics/analysis/StatisticsAnalysisPage.tsx`, `src/features/statistics/analysis/EnergyRankingList.tsx`, `src/features/statistics/reports/StatisticsReportsPage.tsx`, `src/features/statistics/reports/ReportHistoryFilters.tsx`, `src/features/statistics/reports/ReportCreateDialog.tsx`, `src/features/statistics/reports/ReportJobList.tsx`, `src/features/statistics/reports/ReportJobStatus.tsx`: 이미 공통 primitive·semantic palette를 소비하는 실제 블록을 파일별로 확인하고 관련 unit/지정 browser로 검수한다. ReportsPage의 새 theme 수명 회귀 테스트는 Modify 범위다. 기존 query/hash·기간/선택·date draft·job/cursor/abort/focus/실제 필드는 유지하며 무의미한 재작성은 하지 않는다. 새 실측 결함은 메인을 거쳐 원 소유자에게 반환한다.

**Interfaces:** `StatisticsOperationalInfo({summary}: {summary:EnergySummary})`는 기존 shared summary의 기간별 knownSeconds/unknownSeconds, nullable lastAggregatedAt, `baseline24Hours.fixtureCount`만 읽는다. 없는 값은 `—`로 유지하고 다른 API/계산을 만들지 않는다. Recharts는 Task 3 palette를 구독하며 축/tick/grid/tooltip/line/forecast/point를 semantic 역할로 지정한다.

**Measured shared/consumer handoff:** Task9 browser의 공통 ThemeToggle 연속44px hit 결함은 원 공통 owner가 `src/components/ui/theme/ThemeToggle.tsx`·기존 `CustomerThemeProvider.test.tsx`만 승인52px frame으로 보완한다. generic Button/IconButton/token/header와 native helper는 유지하고 monitoring/control/settings 메뉴의 공통 note를 같은 작업에서 갱신하며 statistics note는 해당 dirty 파일 소유자가 최종 commit에 반영한다. 기존 `e2e/statistics-flow.spec.ts`의 제어 navigation 소비3case는 원 제어 owner에게만4tab/group/GET-array fixture 및 원 geometry/visual·추가POST0 기대를 유지하는 test-only 범위를 배정한다. 통계 owner는 declared Heatmap 파일의 실제 끝 열 노출을44px 셀/168개/선택·focus·border 계약을 낮추지 않고 보완한다. 모든 handoff는 직렬로 freeze/보존·별도 원RED/실패 기록 뒤 complete Task9 range의 독립검수에 포함한다.

- [x] Step 1 — `repaints chart axes and missing heatmap cells without resetting selected period`, `theme does not abort or duplicate in-flight PDF and CSV`, `quality info preserves unknown aggregate time and collected zero`를 작성한다. theme 전후 selected range/168 cells·null/0/dashed gap/forecast·negative savings, job ID/poll/download bytes·URL·dialog/focus 불변을 단언한다.
- [x] Step 2 — `pnpm --filter @led-control/web exec vitest run src/features/statistics/StatisticsOverviewPage.test.tsx src/features/statistics/EnergyComparisonChart.test.tsx src/features/statistics/analysis/EnergyHeatmap.test.tsx src/features/statistics/reports/StatisticsReportsPage.test.tsx src/features/statistics/StatisticsOperationalInfo.test.tsx`로 새 color/정보 표시 RED를 확인한다.
- [x] Step 3 — 공통 tabs/header/card/filter/grid·큰 지표/그래프/순위/파일 우선 배치를 적용한다. 중복 CTA는 실제 품질 정보로 바꾸고 기간별 계산·완료 비교와 진행 예상·ranking/detail·signed file/expiry/failure/regenerate·날짜 draft/cursor를 유지한다. chart render를 palette에 구독시키되 key/remount는 사용하지 않는다.
- [x] Step 4 — 통계 전체 unit 및 api/energy·mobile/file-download 회귀, `e2e/statistics-flow.spec.ts`, `statistics-surface-regression.spec.ts`, `statistics-mobile-files.spec.ts`를 실행한다. 실제 데이터 의미와 양 테마 색상/축/tooltip·파일 수명을 독립 검토하고 `feat(statistics): apply themed ATLAS statistics surfaces`로 커밋한다.

- Task9 trueBASE `a81f7bb7`부터 공통 보완 `5cc324c0`·제어 소비 검사 `0a724f6b`·통계 `b8650f29`의 18파일 전체를 독립 Spec✅/Quality Approved C0/I0/M0로 검토했다. 실제 기간별 품질/수집 시각·null/0, reactive chart palette, 동일 PDF/CSV/선택 수명과 Audit10을 보존했다. 히트맵은 원2px 간격·44px/168셀/모바일 native scroll을 유지하고 desktop weekday16px/padding0만 적용했다. 공통52px frame은 최소 연속44px hit를 제공하며 기본 primitive는 바꾸지 않았다. 최종 focused138/관련271·정확3browser131PASS·전체Web3402PASS/기존opt-in3SKIP·타입/UI/build0, 소스842개와12SHA 불변을 확인했다. 첫32FAIL/99PASS·후속2FAIL/129PASS·타입9오류/검증순서 overlap·control 선택0 오류 및 실제native200 두 사례와 contrast/HIL/Task11 한계는 별도 보존한다.

### Task 10: 설정 홈·하위 화면·권한과 미저장 상태

**Files:** Modify `src/features/settings/SettingsView.tsx`, `src/features/settings/SettingsShell.tsx`, `src/features/settings/SettingsSubnavigation.tsx`, `src/features/settings/settings-sections.ts`, `src/features/settings/registration/RegistrationSettingsView.tsx`, `src/features/settings/floor-plans/FloorPlanSettingsView.tsx`와 대응 테스트; Create `src/features/settings/settings-card-model.ts`·`.test.ts`; update `docs/menus/settings.md`. Audit `src/features/settings/settings-action-link.ts`, `src/features/settings/site/SiteOperationsView.tsx`, `src/features/settings/users/SiteUsersView.tsx`, `src/features/settings/security/AccountSecurityView.tsx`, `src/features/settings/security/PasswordSettingsView.tsx`: 이미 common controls/cards/filter/grid/semantic theme를 쓰는 실제 블록과 API/권한/principal·site/pending·password/MFA 수명을 파일별 확인하고 지정 units/browser로 검수한다. 새 MFA theme 수명 등 대응 회귀 테스트는 Modify 범위이며 불필요한 재작성은 하지 않는다. `src/App.test.tsx`의 기존 설정 소비7지점만 새 제목/등록 카드로 이행하면서 실제 첫 Gateway 이름·serial·online/offline/미등록과 원redirect/권한/알람/focus/API검사를 보존한다. 기존 `e2e/settings-mobile-lifecycle.spec.ts`의 theme/공통복귀 회귀 추가와 `e2e/site-user-management.spec.ts`의 기존 home heading 한 지점 이행도 대응 테스트 범위다. 새 실측 결함은 메인을 거쳐 원 소유자에게 반환한다.

**Interfaces:** SettingsView는 Task 4의 실제 capabilities를 소비한다. `buildSettingsCards({dashboard,capabilities,userCount}: {dashboard:Dashboard;capabilities:SiteCapabilities;userCount:number|null}): readonly SettingsCardModel[]`; `SettingsCardModel = {id:string;label:string;path:string;icon:LucideIcon;summary:string}`이며 Dashboard/SiteCapabilities는 `src/api/queries.ts`, LucideIcon은 기존 lucide-react 타입이다. 기존 section capability 경계를 따른다. useSiteUsers는 manage+설치 완료일 때만 실제 siteId를 전달한다. 보안 card는 조회하지 않은 MFA 상태를 표시하지 않는다.

**Measured consumer preservation:** 승인된 다섯 capability card를 유지하고 조명 등록 요약에 기존 Dashboard 첫 Gateway의 실제 이름·시리얼·정상/오프라인 또는 미등록을 함께 보존한다. 실제 조명 total/사용자 null0/도면 mapConfigured·권한은 유지하며 제6 카드·새 API·가상 상태/전체 Gateway 집계로 바꾸지 않는다. 등록 카드 노출은 기존 section manage 경계를 따른다.

**Measured shared repair and fixture scope:** 실제1023 사용자 목록에서 공통 정렬 헤더48.5×44의 자체 둥근 모서리60지점이 hit되지 않는 원인을 확인했다. 공통 담당은 DataGrid 헤더 정렬 버튼에만 `rounded-none`과 예외 주석·단위 회귀를 적용하고 기존 열geometry/컨테이너 threshold/카드·정렬 계약과 generic 기본값은 보존한다. 공통 소유는 DataGrid 두 파일·ui-spacing·모니터링/제어/통계 문서이며 설정 문서는 원 담당에게 handoff한다. 실제 양테마 연속44 native 검증 뒤 설정 gate에 합류한다. 기존 `e2e/account-security.spec.ts` 첫 사례의 최초 `goto("/")`만 실제 로그인 경로 `/login`으로 교정한다. 공개 Landing에서 form 미도달한 최초 실패를 보존하며 auth source/payload/clock/MFA 단언은 바꾸지 않는다. true Task10BASE `368fa37c` 이후 전체 companion+설정 commit을 함께 독립 검토한다.

**Measured native preparation:** corrected exact4의25PASS/1FAIL/4미실행 원본을 보존한다. 실제200% 사용자 카드의 이름+행335.5px가 usable248.5px보다 커 기존 두 상태 분기에 들어갔지만, 초기화 버튼만 viewport 중앙에 놓으면서 이름339.5–354.5px가 실제 하단nav338.5px 아래에 남았다. 이 case의 tall-card 첫 준비에만 실제 이름+초기화 union·header/nav를 측정하고 일반 trusted wheel로 usable 영역에 함께 노출한다. 원이름가독성/44hit/focus/행작업·쓰기0와 native helper·zoom/capture/deadline·제품 geometry를 유지하고 단일 focused native→같은소스 finalexact4·whole1회·fresh검사로 확인한다. 제품 접근불가 원인/원PNG/capture 성공이나 실기기/HIL로 확대하지 않는다.

- [x] Step 1 — `never issues users query for non-manager or pending site`, `mobile back preserves query hash and dirty editor confirmation`, `theme preserves MFA enrollment and recovery codes without new requests`를 작성한다. mapConfigured false/true, count null/0, same-origin Link guard·lease/fence/history/selection/camera/draft와 MFA 추가 start/confirm/revoke0을 단언한다.
- [x] Step 2 — `pnpm --filter @led-control/web exec vitest run src/features/settings/SettingsView.test.tsx src/features/settings/SettingsShell.test.tsx src/features/settings/settings-card-model.test.ts src/features/settings/security/AccountSecurityView.test.tsx`로 새 card/back 계약 RED를 확인한다.
- [x] Step 3 — 제목 `설정`, 실제 다섯 capability 기반 card·icon/요약, 영문/설명/화면환경/장식 제거, 모바일 탭 숨김을 적용한다. SettingsShell의 하위 모든 route에 `{pathname:"/settings",search:location.search,hash:location.hash}` Link 한 개를 제공한다. 계정/로그아웃 eager 영역·installation pending/setup·dirty guard는 유지한다.
- [x] Step 4 — 하위 화면은 common controls/cards/filter/grid/themed chrome를 사용하고 기존 등록·현장/요금·사용자 계약·도면/CAD·MFA API는 유지한다. users count 권한 guard를 적용하고 fake email/admin/MFA 상태를 추가하지 않는다.
- [x] Step 5 — settings unit과 FloorEditorRoute/step-ACK·FloorEditorView.save-ack/editor-drafts·PasswordSettings 회귀, `e2e/settings-operations.spec.ts`, `settings-mobile-lifecycle.spec.ts`, `account-security.spec.ts`, `site-user-management.spec.ts`를 실행한다. 권한/dirty 수명·light/dark/home return을 검토하고 `feat(settings): apply themed ATLAS settings navigation`으로 커밋한다.

- Task10 trueBASE `368fa37c` 이후 공통 `54398e16`·설정 `7ff7ad9f`의25파일을 독립 Spec✅/Quality Approved C0/I0/M0로 검토했다. capability/설치 완료 users 조회·count null0/mapConfigured·첫 Gateway 정보·단일 mobile Link/search/hash·미저장 확인/MFA·원편집 수명을 보존했다. Audit5는 BASE 불변이며 이미 공통화된 소비 회귀로 검수했다. 공통 정렬 header radius만0, 로그인 fixture 진입 한 줄, native tall-card 이름+초기화 준비만 실제 입력으로 보완했다. final browser30PASS·focused native1PASS(비합산)·전체Web3423PASS/기존opt-in3SKIP·fresh타입/UI/build0·source848 불변을 확인했다. 원17/2/11·25/1/4·collection0·관찰경계 위반/원경고·native4원본의한계는 보존하고 Task11 전체 화면/portal/firstpaint/44hit/canonical 관문을 이어간다. 병합 완료는 아니다.

### Task 11: 통합 시각·행동·접근성 검증과 전체 브랜치 검토

**Files:** Create `e2e/atlas-ui-refresh.spec.ts`; Modify 필요한 기존 E2E의 해당 요구 단언, 네 메뉴 문서, `docs/ui-spacing.md`, `docs/project-status.md`, 이 계획. 제품 결함은 원 소유자의 지정 task로 반환한다.

**Interfaces:** QA는 기존 API fixture/support와 실제 theme toggle을 사용한다. `data-shell-topbar`, `data-control-layout`, `data-control-panel`, 실제 canvas·route·POST 관측은 제품의 기존 공개 경계를 소비한다. 테스트용 production API/DOM 접근 우회를 만들지 않는다.

**Corresponding consumer scope:** `monitoring-navigation-confidence` 기존7 KPI button 소비는 승인된 finder/statusSelect로 이행하며 원안전·재시도·카메라·쓰기0 단언을 유지한다. `app-shell-recovery` 401 최초 진입은 `/login`으로 교정했다. 이후 원단언을 유지한 bounded causal3에서 실제 첫 GET `ERR_ABORTED`와 나머지401/403 각1응답·network3 refusal을 구별했다. auth 소비는 정확한 StrictMode 첫 취소 identity/order/callback 대응을 별도 검사하고 원완료/재시도 예산·manual200·403tenant 정리/키보드/logout503을 그대로 검사하여 focused3PASS다. 단순 요청수 완화나 auth 제품 변경은 없다. fractional iframe 주석은 requested/observed 정규화 한계를 기록한다. `control-map-target-selection`의 두 private disclosure helper·mobile2/desktop2만 항상 보이는 도구/밝기·공통 전체보기로 이행해 원geometry/48hit/UUID/draft/POST를 보존하고 exact6PASS(`ca4b2207`)다. 이 검증은 전체 QA 완료가 아니다.

**Measured common repair:** 실제320 정상 PNG에서 최근 명령 오류 안내가 한 글자씩 세로로 나뉜 결함을 원 operations owner에게 반환했다. `90f732b3`은 no-row 모바일 flow만 wrapping/full-width로 보완했고 loaded ticker·desktop inline·font/44px·timer/ref/handler/검증 행동을 보존한다. 원320 wordRange RED→같은 사례 GREEN·관련305PASS·타입/UI/build0과 관련2메뉴/spacing 기록을 회수했다. 실제 실패 안내는 남아 있고 조회 실패 원인/status는 미확정이다. 새 전체 acceptance author는 `e2e/atlas-ui-refresh.spec.ts`만 소유하며 원QA3·공통 제품·helper/fixture/config를 변경하지 않는다. 먼저 dark390 고유1례를 수집한 뒤 실제 정수10 viewport×2theme와 별도 requested fractional6·short NONMANAGER frozen uncertain/first-frame/대비/44/renderer 수명을 검증한다. 기존18 mock·별도 RealBackendLab·canonical4와 문서/최종 전체검수는 원QA와 root가 직렬로 이어간다.

**Measured focus handoff:** 새149개 선언의 첫 bounded dark390는 실제 키보드 포커스 shadow가1.3116:1<3에서 FAIL했다. 첫 visible RAF dark·logo32/select144·header/option44/옵션본문4.5와필수경계3은 해당 reached phase에서 통과했지만 후속alarm/body/148미선택/matrix는 미검증이다. 원858 source/raw/PNG를 보존하고 root는 원공통 DS owner에게 `theme.css`·역할JSON·`customer-theme-contract.test.mjs`·spacing의 token-only4파일과, 후속 `base.css`·UI정책3파일·메뉴4의 전체distinct12파일 수리를 배정한다. 실제 현재732선언(출발528+추가204) 전체 이름→값·customer색98/layout4·provider/컨트롤/geometry/atlas는 유지하고 shadow2만 더해734가 된다. 이전 문서의375/579는 canonical 전수 count가 아니며 이 축소숫자를 보존 기준으로 쓰지 않는다. 이미 승인된 light/dark `border-focus` 색을3px 불투명 고객shadow2에 재사용하며 역할 독립검토→token RED/GREEN/전용커밋→해당 실제hash 독립검토→정확두root shadowalias/anchor회전/closed정책→관련회귀·같은firstdark390 한 번 순서로 진행한다. 새실패는 root로 반환하고 getter/3기준·timeout·skip을 완화하지 않는다. 수리 GREEN 뒤 atlas 원작성자만 기존PDF2사례에 descriptor/fileGET 대기 중 실제buddyToggle·같은URL/요청/원34byte 전달 검증을 추가한다. 원processing/CSV·fixture/support/API·nativehelper는 유지하고 새기본30초/실행가능성은 실제gate로 판정한다.

- Focus 역할 독립 디자인 사전 검토는 C0/I0/M1 Approved다. M1 canonical 수 오기는 root가 실제 PostCSS AST로 과거528/current732·old528변경/누락0/add204를 대조해 위 기준으로 정정했다. Tasks1–10의 이전 count 보고는 역사로 남기며 그 숫자만을 전수보존 근거로 확대하지 않는다. 실제token 커밋·후속alias·수리GREEN/전체검증 승인과는 별도다.

- Focus token-only `fac0d214` 정확4파일은 독립 Spec✅/QualityApproved C0/I0/M0다. 기존732변경0+shadow2→734·직접소비40/contract7PASS이며 oldanchor 예상정책2FAIL을 보존했다. 후속 alias/policy 최소5파일의 실제 combined83은82PASS/1FAIL(첫lightfield oldrgba), 아직 미커밋이다. 설치된 Tailwind4.3.3의 생성 named-shadow가 고정rgba를 인라인한 원인을 확인했고, 독립 C0/I0/M0 설계/단1회 메모리 compile이 네 변형에서 stock 뒤의 customer guard를 확인했다. 같은 phase2 소유10경로 안에서 `base.css` 최상위 utility1/nested rule1/`--tw-shadow` 선언1만 보완한다: `&:where(:root[data-customer-theme="light"] *, :root[data-customer-theme="dark"] *)` 안에 `0 0 0 3px var(--tw-shadow-color, var(--color-border-focus))`를 쓴다. 기존734/정확root2×100·generic소비자/다섯-slot 합성과 명시shadow-color·기본화면을 보존하고 exact base-only PostCSS 정책/우회negative 회귀를 추가한다. 원82/1·첫dark390 실패는 불변이며 실제paint/clip/네변형/default복원/관련회귀/fresh관문/같은first390 ONE은 아직이다. shadow2/rootaliases는 선언적 계약이고 paint의 고객 fallback은 이 compiler-compatible recipe를 쓰므로 alias-only 성공이라고 기록하지 않는다.

- Focus 공통 보완 `1912b280` 정확10파일은 scoped WITHCONCERNS다. 진짜정책RED→CSS-only기본복원/명시다른hover색·100%alpha 포함85contract/341units·typeUIbuild0·양팔레트40/4variant를 확인했고 원firstdark390의 같은 실제site focus8.009>=3까지 통과했다. 후속alarm에서 원atlas RGB-only 색parser가 실제반투명oklab을해석하지못해 testcase1FAIL이므로 전체firstcase/Task11 승인아님을 유지한다. 원atlasowner는 한파일local decoder의 실제RGBA/alpha조상stack·unknownfail·원4.5/3기준/geometry를 보존하는 최소제안만 준비한다. 원failures/859source/archive/QA3/protected734 모두 유지하며 별도sourcefixedfirst1→PDF2→full149→관련17/RealLab/canonical/wholegate가 남아 있다.

- 최신 source별 관측(2026-10-08 KST): strict numeric Oklab/정확 alpha decoder 뒤 원 firstdark390 ONE1PASS와 명시적 header-sent/body-pending PDF2PASS를 회수했다. 원753 body timeout 인과와 pre-header640FAIL은 보존하며 헤더 이전 대기·실물PDF 검증으로 확대하지 않는다. 실제 desktop logo는 sidebar, RAC checkbox는 실제 associated label, 모바일 wheel은 visible header padding의 document owner로 검사한다. Ghost 숫자 입력의 투명 edge 대신 실제 값/키보드 focus를 측정해 원320 focused1PASS(값13.892617/focus8.009080)다. 기존 decoder27/734/QA3/4.5·3/default30/859전수와 원실패는 유지한다. 같은884소스 전체149는70PASS/1FAIL/78미실행으로 멈췄다. 원760PC `<canvas>`142<240 검사는 Task7의 실제 조작 viewport240과 다른 대상으로, 기존 `operational-marker-control-height`의 실제 selector/실측을 확인했다. 승인 최소240은 실제 viewport/client 영역에서 검사하고 내부 CAD맞춤 canvas의 실제 표시·DOM/count/camera/zoom 보존은 별도로 유지한다. 제품/CAD/카메라/일반 소비자/높이 기준을 바꾸지 않는 한파일 검사 대상 교정 뒤 원760→새전체149→같은hash 관련17/분리RealLab19→canonical4/UI→독립whole를 진행한다. 부분 PASS/진단은 합산하지 않으며 Task11 체크와 병합은 아직 보류다.

- 최신 전체 실행과 후속 PC 검사(2026-10-08 KST): viewport 검사 대상 교정 뒤 동일899소스 전체149는82PASS/1FAIL/66미실행으로 멈췄다(R79). 첫 PC 안전 사례는 명령 이력 미도달이며, 원QA·root의 retention 소스 검토 뒤 기존 coherent clock tuple/원retentionfalse와 실제GET 관측만 교정했다. 이후 PC48 단일 실행은 R80 0/1/47, wheel witness 수리 R81 0/1/47, R82 16/1/31, R83 0/1/47이다. 서로 다른 source의 부분 PASS는 합산하지 않는다. 원 전체149/각 실패의 raw·source freeze·PNG와 미도달 범위를 보존한다.
- 현재 HOLD(R83): 최종 atlas blob `a62d746564db66ec28aaf3a93305720dd657647d`의 PC48은 type/UI0·고유list48 뒤0PASS/1FAIL/47미실행이다. 실제 trusted wheel에서 같은 부모 scrollTop0→75·documentY0·zoom1→1은 기록됐지만, 이벤트가 부모 자체 대신 하위 toolbar DIV로 전달돼 `directOwnerDelivery` 단언에서 실패했다. 후속 자체 이동/배율 단언·UUID 선택/상세·정상 PNG·대비는 도달하지 않았다. Root는 완전 보고서·859/보호858 read-only verifier exit0·실제 raw terminal/JSON/실패 PNG를 독립 대조했다. 같은 PC witness 수리가 세 차례 실패했으므로 네 번째 수정 전 사용자에게 검증 구조 재설계 후 계속할지 물었고, 답변 전 원작성자·원QA의 수정/추가 실행을 중지했다. 제품/44px·UUID·배율 계약을 완화하지 않으며 전체149 재실행·관련17·RealLab·canonical·whole review·커밋/병합은 별도 승인과 실제 통과 전까지 보류한다. 아래 Task11/12 체크는 미완료로 유지한다.

- 재개 승인(2026-10-08): 사용자가 검증 구조 보완·필요한 협업과 격리 브랜치 작업 후 병합을 지시했다. Ruling84는 local PC wheel helper의 직접 이벤트 대상 equality를 실제 hit/target-to-owner 경로의 비차단·원owner 연결 및 directional scroll 이동 증거로 교정한다. 기존 Task7 helper의 descendant 전달과 R83 실제 부모 이동을 근거로 삼되 원불일치 인과를 해결했다고 주장하지 않는다. 세 차례 실패한 원작성자 대신 새 검증 구현자에게 한 파일 local helper만 배정하고, PC48→독립 scoped 검토→새 전체149→기존QA의 관련17/분리Lab19/canonical→독립whole→사용자 변경 보존·병합 순서로 진행한다. 원44px action·UUID/noPOST·DOM/viewport240·문서Y0/배율·기본timeout/734/QA3를 유지하며 각 실제 신규 실패에서 후속 gate를 멈춰 원소유자에게 반환한다.

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

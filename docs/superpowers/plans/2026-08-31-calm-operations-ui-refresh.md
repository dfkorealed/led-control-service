# Calm Operations Customer UI Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 현재 고객 기능을 유지하면서 모니터링·제어·통계·설정 화면에 Calm Operations 디자인 시스템을 적용하고, 설정 내부 메뉴를 주 내비게이션의 접근 가능한 hover/focus/touch 서브메뉴로 이동한다.

**Architecture:** API, React Query, route와 feature 상태 로직은 유지하고 `apps/web/src/components/ui`에 표현 전용 primitive를 추가한다. 공통 셸이 역할별 설정 navigation의 단일 진입점을 소유하며 feature view는 primitive와 토큰을 조합한다. 시각 변경은 feature test의 접근 가능한 contract와 Playwright의 viewport/overflow contract로 보호한다.

**Tech Stack:** React 18, TypeScript, React Router, TanStack Query, Lucide React, Recharts, Vitest, Testing Library, Playwright, CSS

**Spec:** `docs/superpowers/specs/2026-08-31-calm-operations-ui-refresh-design.md`

## Global Constraints

- 고객용 `모니터링`, `제어`, `통계`, `설정`만 전면 개선하고 operator 전용 화면은 범위에서 제외한다.
- API wrapper, React Query key, command/session recovery, authorization, Prisma schema, MQTT 계약을 변경하지 않는다.
- 현재 구현된 설치 guard, Gateway claim, 등록 세션 복구, 수동·스케줄·차량 이벤트 제어, 통계, 도면 편집과 비밀번호 변경 기능을 유지한다.
- 미구현 설정 기능이나 placeholder를 새로 노출하지 않는다.
- 데스크톱 설정 서브메뉴는 hover와 focus에서, 모바일은 bottom sheet에서 동일한 역할별 route를 제공한다.
- 760px 이하에서 하단 주 내비게이션과 2열 KPI를 사용하고, 360px 이하에서 KPI를 1열로 전환한다.
- 최소 터치 target은 44px이고 본문과 UI text는 WCAG AA 대비를 만족해야 한다.
- 중요한 상태는 색상만이 아니라 Lucide outline icon과 text를 함께 사용한다.
- `prefers-reduced-motion`에서 불필요한 회전·전환 animation을 제거한다.
- 페이지 또는 메뉴 변경과 같은 커밋에서 해당 `docs/menus/*.md`를 함께 갱신한다.
- 실제 Raspberry Pi/BlueZ/ESP32-H2 HIL을 실행하지 않은 결과를 실장비 완료로 기록하지 않는다.

---

## File Structure

### New shared UI files

- `apps/web/src/components/ui/Button.tsx`: button variants와 loading contract
- `apps/web/src/components/ui/Card.tsx`: 공통 surface wrapper
- `apps/web/src/components/ui/StatusBadge.tsx`: icon + label semantic status
- `apps/web/src/components/ui/MetricCard.tsx`: KPI label/value/unit/supporting status
- `apps/web/src/components/ui/PageHeader.tsx`: page heading와 actions layout
- `apps/web/src/components/ui/FeedbackState.tsx`: loading/error/empty feedback surface
- `apps/web/src/components/ui/index.ts`: public export boundary
- `apps/web/src/components/ui/ui-primitives.test.tsx`: primitive semantics와 variants
- `apps/web/src/features/shells/SettingsNavigationItem.tsx`: 역할별 설정 disclosure navigation
- `apps/web/src/features/shells/SettingsNavigationItem.test.tsx`: hover/focus/touch/keyboard/route contract
- `apps/web/e2e/support/layout-assertions.ts`: viewport overflow와 touch target assertion helper

### Existing files grouped by responsibility

- Shell/navigation: `CustomerShell.tsx`, `SettingsShell.tsx`, `settings-sections.ts`, `App.test.tsx`, `SettingsShell.test.tsx`
- Monitoring: `MonitoringView.tsx`, `FloorMap.tsx`, related tests and `docs/menus/monitoring.md`
- Control: `ControlView.tsx`, `ControlModeTabs.tsx`, schedule/event panels, related tests and `docs/menus/control.md`
- Statistics: `StatisticsView.tsx`, related tests and `docs/menus/statistics.md`
- Settings: `SettingsView.tsx`, floor-plan/password/editor views, related tests and `docs/menus/settings.md`
- Visual system: `apps/web/src/styles.css`
- Cross-screen E2E: monitoring/control, statistics, settings/floor-editor Playwright specs
- Status: `docs/project-status.md` and this checkbox plan

---

### Task 1: Design tokens and shared UI primitives

**Files:**
- Create: `apps/web/src/components/ui/Button.tsx`
- Create: `apps/web/src/components/ui/Card.tsx`
- Create: `apps/web/src/components/ui/StatusBadge.tsx`
- Create: `apps/web/src/components/ui/MetricCard.tsx`
- Create: `apps/web/src/components/ui/PageHeader.tsx`
- Create: `apps/web/src/components/ui/FeedbackState.tsx`
- Create: `apps/web/src/components/ui/index.ts`
- Create: `apps/web/src/components/ui/ui-primitives.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `Button`, `Card`, `StatusBadge`, `MetricCard`, `PageHeader`, `FeedbackState`
- `StatusTone = "success" | "warning" | "danger" | "neutral" | "info"`
- Primitive는 API 호출이나 feature state를 소유하지 않는다.

- [x] **Step 1: Write failing primitive contract tests**

```tsx
import { CircleAlert, CircleCheck } from "lucide-react";
import { render, screen } from "@testing-library/react";
import { Button, FeedbackState, MetricCard, PageHeader, StatusBadge } from ".";

describe("Calm Operations UI primitives", () => {
  it("keeps button semantics while exposing variant and loading state", () => {
    render(<Button variant="primary" isLoading>저장</Button>);
    expect(screen.getByRole("button", { name: "저장 중" })).toBeDisabled();
    expect(screen.getByRole("button")).toHaveClass("ui-button", "ui-button-primary");
  });

  it("renders status with an icon and visible label", () => {
    render(<StatusBadge tone="success" icon={CircleCheck}>정상</StatusBadge>);
    expect(screen.getByText("정상")).toBeVisible();
    expect(screen.getByText("정상").closest("span")).toHaveAttribute("data-tone", "success");
  });

  it("gives metric cards an accessible label and stable value", () => {
    render(<MetricCard label="전체 조명" value="2,354" unit="개" helper="선택 층 기준" />);
    expect(screen.getByRole("group", { name: "전체 조명" })).toHaveTextContent("2,354개");
  });

  it("renders page actions and feedback semantics", () => {
    render(<><PageHeader title="운영 현황" actions={<button>새로고침</button>} /><FeedbackState tone="danger" icon={CircleAlert} title="불러오지 못했습니다" /></>);
    expect(screen.getByRole("heading", { name: "운영 현황" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("불러오지 못했습니다");
  });
});
```

- [x] **Step 2: Run the primitive tests and verify RED**

Run: `pnpm --filter @led-control/web test -- src/components/ui/ui-primitives.test.tsx`

Expected: FAIL because `apps/web/src/components/ui/index.ts` does not exist.

- [x] **Step 3: Implement the primitive public contracts**

Use native elements and small wrappers. The implementation must follow these signatures:

```tsx
// Button.tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  isLoading?: boolean;
  loadingLabel?: string;
  children: ReactNode;
}

export function Button({ variant = "secondary", isLoading = false, loadingLabel = "저장 중", children, className = "", disabled, ...props }: ButtonProps) {
  return <button {...props} disabled={disabled || isLoading} className={`ui-button ui-button-${variant} ${className}`.trim()}>{isLoading ? loadingLabel : children}</button>;
}
```

```tsx
// StatusBadge.tsx
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type StatusTone = "success" | "warning" | "danger" | "neutral" | "info";

export function StatusBadge({ tone, icon: Icon, children, className = "" }: { tone: StatusTone; icon: LucideIcon; children: ReactNode; className?: string }) {
  return <span className={`ui-status-badge ${className}`.trim()} data-tone={tone}><Icon size={14} aria-hidden="true" /><span>{children}</span></span>;
}
```

```tsx
// MetricCard.tsx
import type { LucideIcon } from "lucide-react";

export function MetricCard({ label, value, unit, helper, icon: Icon, tone = "neutral" }: { label: string; value: string | number; unit?: string; helper?: string; icon?: LucideIcon; tone?: "neutral" | "primary" | "success" | "warning" | "danger" }) {
  return <section className="ui-metric-card" data-tone={tone} role="group" aria-label={label}><div className="ui-metric-label">{Icon ? <Icon size={18} aria-hidden="true" /> : null}<span>{label}</span></div><strong><span>{value}</span>{unit ? <small>{unit}</small> : null}</strong>{helper ? <p>{helper}</p> : null}</section>;
}
```

```tsx
// Card.tsx
import type { HTMLAttributes, ReactNode } from "react";

export function Card({ tone = "default", className = "", children, ...props }: HTMLAttributes<HTMLElement> & { tone?: "default" | "selected" | "danger"; children: ReactNode }) {
  return <section {...props} className={`ui-card ui-card-${tone} ${className}`.trim()}>{children}</section>;
}
```

```tsx
// PageHeader.tsx
import type { ReactNode } from "react";

export function PageHeader({ title, description, status, actions }: { title: string; description?: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  return <header className="ui-page-header"><div><h2>{title}</h2>{description ? <div className="ui-page-description">{description}</div> : null}</div>{status || actions ? <div className="ui-page-actions">{status}{actions}</div> : null}</header>;
}
```

```tsx
// FeedbackState.tsx
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function FeedbackState({ tone = "neutral", icon: Icon, title, description, action }: { tone?: "neutral" | "danger"; icon: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  const liveProps = tone === "danger" ? { role: "alert" as const } : { role: "status" as const };
  return <section {...liveProps} className="ui-feedback-state" data-tone={tone}><Icon size={22} aria-hidden="true" /><div><strong>{title}</strong>{description ? <p>{description}</p> : null}{action}</div></section>;
}
```

Export all primitives and their public prop/status types from `index.ts`. Do not export feature-specific helpers from this folder.

- [x] **Step 4: Add the token layer and primitive CSS**

Replace the current root token values without renaming feature classes, then append primitive styles:

```css
:root {
  color: #191f28;
  background: #f4f6f8;
  --primary: #1769e0;
  --primary-hover: #0f5dcc;
  --primary-soft: #eaf3ff;
  --surface: #f4f6f8;
  --panel: #ffffff;
  --border: #e5e8eb;
  --text: #191f28;
  --muted: #6b7684;
  --subtle: #8b95a1;
  --success: #16a34a;
  --warning: #f59e0b;
  --danger: #e5484d;
  --focus-ring: 0 0 0 3px rgba(23, 105, 224, 0.24);
  --radius-control: 12px;
  --radius-card: 16px;
  --shadow-popover: 0 16px 40px rgba(25, 31, 40, 0.14);
}

.ui-button { min-height: 44px; border-radius: var(--radius-control); padding: 0 16px; font-weight: 700; }
.ui-button:focus-visible { outline: 0; box-shadow: var(--focus-ring); }
.ui-button-primary { border: 1px solid var(--primary); background: var(--primary); color: #fff; }
.ui-card, .ui-metric-card { border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--panel); }
.ui-status-badge { display: inline-flex; min-height: 28px; align-items: center; gap: 6px; border-radius: 999px; padding: 4px 9px; font-weight: 700; }
.ui-metric-card strong { font-variant-numeric: tabular-nums; }
```

- [x] **Step 5: Run focused tests, typecheck and build**

Run:

```bash
pnpm --filter @led-control/web test -- src/components/ui/ui-primitives.test.tsx
pnpm --filter @led-control/web typecheck
pnpm --filter @led-control/web build
```

Expected: all commands exit 0. Record the bundle-size output but do not treat bundle growth as a failure unless the build reports an error.

- [x] **Step 6: Commit Task 1**

```bash
git add apps/web/src/components/ui apps/web/src/styles.css
git commit -m "feat(web): add calm operations UI primitives"
```

---

### Task 2: Settings hover/focus/touch navigation and shell cleanup

**Files:**
- Create: `apps/web/src/features/shells/SettingsNavigationItem.tsx`
- Create: `apps/web/src/features/shells/SettingsNavigationItem.test.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/features/settings/SettingsShell.tsx`
- Modify: `apps/web/src/features/settings/SettingsShell.test.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `settingsSectionsFor(role)` and existing route/query context
- Produces: `SettingsNavigationItem({ role, search, isActive })`
- Desktop click navigates to `/settings`; coarse pointer click opens the bottom sheet without navigation.

- [x] **Step 1: Write failing settings navigation tests**

Test the component inside `MemoryRouter` with an admin and viewer:

```tsx
it("opens admin settings links on hover and closes with Escape", async () => {
  renderSettingsItem({ role: "admin", initialEntry: "/monitoring?siteId=site-1" });
  const trigger = screen.getByRole("link", { name: "설정" });
  fireEvent.mouseEnter(trigger.closest("div")!);
  expect(screen.getByRole("link", { name: "설정 개요" })).toHaveAttribute("href", "/settings?siteId=site-1");
  expect(screen.getByRole("link", { name: "도면 관리" })).toHaveAttribute("href", "/settings/floor-plans?siteId=site-1");
  expect(screen.getByRole("link", { name: "비밀번호 변경" })).toBeVisible();
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(screen.queryByRole("link", { name: "도면 관리" })).not.toBeInTheDocument();
});

it("does not expose admin-only security to a viewer", () => {
  renderSettingsItem({ role: "viewer", initialEntry: "/settings?siteId=site-1" });
  fireEvent.focus(screen.getByRole("link", { name: "설정" }));
  expect(screen.getByRole("link", { name: "도면 관리" })).toBeVisible();
  expect(screen.queryByRole("link", { name: "비밀번호 변경" })).not.toBeInTheDocument();
});

it("opens the mobile sheet instead of navigating on a coarse pointer", () => {
  mockMatchMedia({ coarse: true });
  renderSettingsItem({ role: "admin", initialEntry: "/monitoring?siteId=site-1" });
  fireEvent.click(screen.getByRole("link", { name: "설정" }));
  expect(screen.getByRole("dialog", { name: "설정 메뉴" })).toBeInTheDocument();
  expect(screen.getByTestId("location")).toHaveTextContent("/monitoring?siteId=site-1");
});
```

Also add App-level assertions that a subroute preserves `siteId` and SettingsShell no longer renders `aria-label="설정 메뉴"` as an internal sidebar.

- [x] **Step 2: Run focused navigation tests and verify RED**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/shells/SettingsNavigationItem.test.tsx src/features/settings/SettingsShell.test.tsx src/App.test.tsx
```

Expected: FAIL because `SettingsNavigationItem` is missing and the old settings sidebar still renders.

- [x] **Step 3: Implement `SettingsNavigationItem`**

Use one settings `NavLink`, conditional submenu DOM, and explicit interaction state:

```tsx
export interface SettingsNavigationItemProps {
  role: AuthUser["role"];
  search: string;
}

export function SettingsNavigationItem({ role, search }: SettingsNavigationItemProps) {
  const location = useLocation();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const [open, setOpen] = useState(false);
  const sections = settingsSectionsFor(role);
  const active = location.pathname.startsWith("/settings");

  function handlePrimaryClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!window.matchMedia("(hover: none), (pointer: coarse)").matches) return;
    event.preventDefault();
    setOpen(true);
  }

  return (
    <div ref={wrapperRef} className="settings-nav-disclosure" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)}>
      <NavLink ref={triggerRef} to={`/settings${search}`} className={active ? "nav-item active" : "nav-item"} aria-expanded={open} aria-haspopup="dialog" onClick={handlePrimaryClick} onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); } }}>
        <Settings size={18} aria-hidden="true" /><span>설정</span><ChevronRight className="settings-nav-chevron" size={16} aria-hidden="true" />
      </NavLink>
      {open ? <div className="settings-submenu" role={window.matchMedia("(hover: none), (pointer: coarse)").matches ? "dialog" : undefined} aria-label="설정 메뉴">
        {sections.map((section) => <NavLink key={section.path} to={`${section.path}${search}`} onClick={() => setOpen(false)}>{section.label}</NavLink>)}
      </div> : null}
    </div>
  );
}
```

Add document `pointerdown` outside handling, wrapper `onBlur` with `relatedTarget`, Escape close, and route-change close. Do not introduce a new route state or global store.

- [x] **Step 4: Integrate the settings item into `CustomerShell`**

- Keep monitoring/control/statistics in the existing `items` array.
- Render `SettingsNavigationItem` after those links.
- Pass `user.role` and `location.search`.
- Keep the existing `Routes`, role guards, selected `siteId`, logout and dirty-editor behavior unchanged.

- [x] **Step 5: Remove the internal settings submenu**

Change `SettingsShell` to keep `SiteSwitcher` in a horizontal context row and render `Outlet` directly:

```tsx
return (
  <section className="settings-workspace settings-workspace-flat">
    <div className="settings-context-bar">
      <SiteSwitcher sites={sites} selectedSiteId={selectedSiteId} canSelectSite={canSelectSite} />
    </div>
    <div className="settings-content"><Outlet /></div>
  </section>
);
```

Remove the `settings-nav` and `settings-sidebar` markup but keep the site-switch dirty confirmation and store reset exactly as-is.

- [x] **Step 6: Add desktop popover and mobile bottom-sheet CSS**

```css
.settings-nav-disclosure { position: relative; }
.settings-submenu { position: absolute; z-index: 20; top: 0; left: calc(100% + 10px); width: 208px; border: 1px solid var(--border); border-radius: 14px; background: var(--panel); box-shadow: var(--shadow-popover); padding: 8px; }
.settings-submenu a { display: flex; min-height: 44px; align-items: center; border-radius: 10px; padding: 0 12px; color: var(--text); text-decoration: none; }
.settings-submenu a.active { background: var(--primary-soft); color: var(--primary); font-weight: 700; }

@media (max-width: 760px), (hover: none), (pointer: coarse) {
  .settings-submenu { position: fixed; inset: auto 12px calc(var(--bottom-nav-space) - 8px); width: auto; max-height: min(60vh, 420px); overflow-y: auto; }
}
```

- [x] **Step 7: Run focused and full web tests**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/shells/SettingsNavigationItem.test.tsx src/features/settings/SettingsShell.test.tsx src/App.test.tsx
pnpm --filter @led-control/web test
pnpm --filter @led-control/web typecheck
```

Expected: focused and full suites pass; operator tests still show no customer navigation; viewer security route still redirects to settings overview.

- [x] **Step 8: Commit Task 2**

```bash
git add apps/web/src/features/shells apps/web/src/features/settings/SettingsShell.tsx apps/web/src/features/settings/SettingsShell.test.tsx apps/web/src/App.test.tsx apps/web/src/styles.css
git commit -m "feat(web): move settings navigation into app sidebar"
```

---

### Task 3: Monitoring hierarchy and state surfaces

**Files:**
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/features/monitoring/MonitoringView.test.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/monitoring.md`

**Interfaces:**
- Consumes: `MetricCard`, `PageHeader`, `StatusBadge`, `FeedbackState`
- Preserves: registration, refresh, map selection, query and status logic

- [x] **Step 1: Add failing monitoring semantic tests**

Add assertions to the existing populated-dashboard test:

```tsx
expect(screen.getByRole("heading", { name: "운영 현황" })).toBeInTheDocument();
expect(screen.getByRole("group", { name: "전체 조명" })).toHaveTextContent("2");
expect(screen.getByRole("group", { name: "정상" })).toHaveTextContent("1");
expect(screen.getByRole("group", { name: "점검 필요" })).toHaveTextContent("1");
expect(screen.getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("72%");
expect(within(screen.getByRole("complementary", { name: "선택 조명 상세" })).getByText(/정상|장애|오프라인|상태 확인 대기/)).toBeVisible();
```

Keep existing tests for active registration session recovery, partial refresh, map fallback, 1,000 fixture behavior and role-specific empty state.

- [x] **Step 2: Run monitoring tests and verify RED**

Run: `pnpm --filter @led-control/web test -- src/features/monitoring/MonitoringView.test.tsx src/features/monitoring/FloorMap.test.tsx`

Expected: FAIL on the new heading, metric group and complementary labels.

- [x] **Step 3: Apply the common page and metric structure**

- Replace the current heading with `PageHeader title="운영 현황"` and keep refresh/floor controls in `actions`.
- Replace four `.metric` wrappers with `MetricCard`.
- Rename visible KPI `온라인` to `정상`; do not change the underlying online calculation.
- Use `StatusBadge` with `CircleCheck`, `TriangleAlert`, `CircleX`, or `Clock3` based on the existing status/statusReason.
- Add `aria-label="선택 조명 상세"` to the detail aside.
- Preserve every query, effect, registration component, selected fixture calculation and refresh handler.

- [x] **Step 4: Restyle monitoring map and detail layout**

- Give the map the largest flexible column and the detail panel a bounded `minmax(280px, 340px)` column.
- Reduce marker decoration; keep hover/focus/selected enlargement and state labels.
- Use 16px cards, 1px border and no default shadow.
- Move the fault/offline rows below the selected fixture facts inside the detail panel.
- Preserve Konva hit targets and existing marker accessible names.

- [x] **Step 5: Update monitoring documentation**

Under `구현 완료`, add the Calm Operations hierarchy, icon+text state contract, responsive KPI behavior and unchanged registration limitation. Add the new shared UI files under `관련 파일`. Set the document date to `2026-08-31`.

- [x] **Step 6: Run focused monitoring verification**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/monitoring/MonitoringView.test.tsx src/features/monitoring/FloorMap.test.tsx
pnpm --filter @led-control/web typecheck
```

Expected: tests and typecheck pass.

- [x] **Step 7: Commit Task 3**

```bash
git add apps/web/src/features/monitoring apps/web/src/styles.css docs/menus/monitoring.md
git commit -m "feat(web): refresh monitoring information hierarchy"
```

---

### Task 4: Manual, schedule and vehicle-event control visual system

**Files:**
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Modify: `apps/web/src/features/control/ControlView.test.tsx`
- Modify: `apps/web/src/features/control/ControlTargetPicker.tsx`
- Modify: `apps/web/src/features/control/automation/ControlModeTabs.tsx`
- Modify: `apps/web/src/features/control/automation/ScheduleControlPanel.tsx`
- Modify: `apps/web/src/features/control/automation/ScheduleControlPanel.test.tsx`
- Modify: `apps/web/src/features/control/automation/VehicleEventControlPanel.tsx`
- Modify: `apps/web/src/features/control/automation/VehicleEventControlPanel.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/control.md`

**Interfaces:**
- Consumes: `Button`, `Card`, `PageHeader`, `StatusBadge`, existing ARIA tabs
- Preserves: `mode=manual|schedule|event`, command lock/recovery, automation CRUD and viewer permissions

- [x] **Step 1: Write failing control hierarchy tests**

```tsx
expect(screen.getByRole("heading", { name: "조명 제어" })).toBeInTheDocument();
expect(screen.getByRole("tablist", { name: "제어 방식" })).toBeInTheDocument();
expect(screen.getByRole("tab", { name: "수동 제어" })).toHaveAttribute("aria-selected", "true");
expect(screen.getByRole("complementary", { name: "밝기 실행" })).toHaveTextContent("밝기");
expect(screen.getByRole("status", { name: "명령 진행 상태" })).toBeInTheDocument();
```

For schedule/event panels, assert visible icon+text sync states `적용됨`, `적용 대기`, `적용 실패` and preserve all existing mutation, pagination, 401 and validation tests.

- [x] **Step 2: Run focused control tests and verify RED**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/control/ControlView.test.tsx src/features/control/automation/ScheduleControlPanel.test.tsx src/features/control/automation/VehicleEventControlPanel.test.tsx
```

Expected: FAIL on the new heading and named regions.

- [x] **Step 3: Unify the page shell and existing mode tabs**

- Render a single `PageHeader title="조명 제어"` above `ControlModeTabs`.
- Keep `role="tablist"`, roving tabIndex, ArrowLeft/Right, Home and End behavior unchanged.
- Use the same active pale-blue surface, icon size and focus ring as the primary navigation.
- Keep the URL mode query behavior unchanged.

- [x] **Step 4: Restyle manual control without changing its state machine**

- Keep target selection in the left card and add `aria-label="제어 대상 선택"`.
- Add `aria-label="밝기 실행"` to the right aside.
- Group selected count, 0–100 slider, presets and primary apply action in reading order.
- Render the existing command progression/result inside `role="status" aria-label="명령 진행 상태"`.
- Replace visual-only status pills with `StatusBadge`; retain exact current copy used by tests and API outcomes.
- Do not change `submitCommand`, active command storage, polling, retry, timeout, `overrideUntil`, read-only or Mesh readiness logic.

- [x] **Step 5: Restyle schedule and vehicle event management**

- Use `PageHeader` inside each panel only for panel-specific title/actions; avoid a second page h1/h2 hierarchy.
- Style list containers as bordered 16px surfaces with 56px minimum rows.
- Use `StatusBadge` for enabled, Gateway sync and recent execution/detection status.
- Use `Button` variants for add, edit, retry and delete while preserving existing accessible names.
- Keep dialogs, validation focus, pagination, polling, scope-generation and mutation auth side effects unchanged.

- [x] **Step 6: Update control documentation**

Add the three-mode Calm Operations layout, status badge contract and unchanged software/HIL limitations to `docs/menus/control.md`; include shared UI and automation panel files under `관련 파일`; update the date to `2026-08-31`.

- [x] **Step 7: Run control verification**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/control
pnpm --filter @led-control/web typecheck
```

Expected: all control tests and typecheck pass.

- [x] **Step 8: Commit Task 4**

```bash
git add apps/web/src/features/control apps/web/src/styles.css docs/menus/control.md
git commit -m "feat(web): unify manual and automation control UI"
```

---

### Task 5: Statistics cards, chart and cost comparison

**Files:**
- Modify: `apps/web/src/features/statistics/StatisticsView.tsx`
- Modify: `apps/web/src/features/statistics/StatisticsView.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/statistics.md`

**Interfaces:**
- Consumes: `MetricCard`, `PageHeader`, `StatusBadge`, `FeedbackState`
- Preserves: summary/series split queries, null gaps, screen-reader list and estimation copy

- [x] **Step 1: Add failing statistics contract tests**

```tsx
expect(screen.getByRole("heading", { name: "에너지 리포트" })).toBeInTheDocument();
expect(screen.getByRole("group", { name: "오늘 전력 사용량" })).toHaveTextContent("kWh");
expect(screen.getByRole("group", { name: "이번 달 누적 전력 사용량" })).toHaveTextContent("원");
expect(screen.getByText("상태 기반 추정")).toBeVisible();
expect(screen.getByRole("img", { name: /상태 기반 추정 전력 사용량 꺾은선 차트/ })).toBeInTheDocument();
```

Keep existing tests for partial/no-data, tooltip, independent series retry, timezone ranges and mobile overflow.

- [x] **Step 2: Run statistics tests and verify RED**

Run: `pnpm --filter @led-control/web test -- src/features/statistics/StatisticsView.test.tsx`

Expected: FAIL on the new `MetricCard` group contracts.

- [x] **Step 3: Apply the common hierarchy**

- Replace the page heading with `PageHeader` while preserving timezone and last aggregation copy.
- Change `EnergyMetric` to compose `MetricCard` and `StatusBadge`.
- Keep `available`, `partial`, `no_data` labels exactly as currently defined.
- Keep the day/month segmented buttons and their `aria-pressed` state.
- Place chart first and cost comparison second in DOM reading order.
- Preserve Recharts data, null points, tooltip and screen-reader list.

- [x] **Step 4: Restyle the chart and cost panel**

- Use neutral grid/border tokens and primary blue series.
- Give tooltip a 12px radius, high-contrast text and popover shadow.
- Align currency and kWh values with tabular numbers.
- Keep negative savings visible and semantic; never convert them to a positive success state.

- [x] **Step 5: Update statistics documentation**

Record the shared KPI/status components, hierarchy and responsive behavior in `docs/menus/statistics.md`; preserve every actual-estimation limitation and HIL distinction; update date and related files.

- [x] **Step 6: Run statistics verification**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/statistics/StatisticsView.test.tsx src/api/energy.test.tsx
pnpm --filter @led-control/web typecheck
```

Expected: tests and typecheck pass.

- [x] **Step 7: Commit Task 5**

```bash
git add apps/web/src/features/statistics apps/web/src/styles.css docs/menus/statistics.md
git commit -m "feat(web): refresh energy report presentation"
```

---

### Task 6: Settings overview, floor plans, editor and password surfaces

**Files:**
- Modify: `apps/web/src/features/settings/SettingsView.tsx`
- Modify: `apps/web/src/features/settings/SettingsShell.test.tsx`
- Modify: `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.tsx`
- Modify: `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.test.tsx`
- Modify: `apps/web/src/features/settings/security/PasswordSettingsView.tsx`
- Modify: `apps/web/src/features/settings/security/PasswordSettingsView.test.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/settings.md`

**Interfaces:**
- Consumes: shared primitives and flattened `SettingsShell`
- Preserves: setup, claim/registration, role guard, lease, dirty guard, atomic save/restore and password cache safety

- [x] **Step 1: Add failing settings hierarchy tests**

For the installed overview:

```tsx
expect(screen.getByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
expect(screen.getByRole("group", { name: "현장 정보" })).toBeInTheDocument();
expect(screen.getByRole("group", { name: "게이트웨이 상태" })).toHaveTextContent(/정상|오프라인|미등록/);
```

For floor plans, password and editor:

```tsx
expect(screen.getByRole("heading", { name: "도면 관리" })).toBeInTheDocument();
expect(screen.getByRole("form", { name: "비밀번호 변경" })).toBeInTheDocument();
expect(screen.getByRole("toolbar", { name: "도면 편집 도구" })).toBeInTheDocument();
```

Keep every existing viewer redirect, site switch dirty confirmation, lease conflict, atomic save/restore and password plaintext-cache test.

- [x] **Step 2: Run focused settings tests and verify RED**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/settings src/features/floor-editor/FloorEditorView.test.tsx
```

Expected: FAIL on the new heading and named region contracts.

- [x] **Step 3: Refresh the settings overview**

- Use `PageHeader title="설정 개요"`.
- Present site and Gateway as labeled `Card` sections with `role="group"` names.
- Present floors/groups as compact rows, not new editing actions.
- Keep pending setup, no-site state, Gateway claim and registration components unchanged.
- Use icon+text status and role-aware actions; do not expose admin actions to viewer.

- [x] **Step 4: Refresh floor-plan list and password form**

- Use the same PageHeader, Card and Button variants.
- Keep floor route/query, editor availability and viewer read-only behavior.
- Give the password form `aria-label="비밀번호 변경"`, keep local-only plaintext state and existing validation messages.
- Preserve success clearing, failed input retention and duplicate-submit lock.

- [x] **Step 5: Align the floor editor workbench**

- Keep canvas, asset upload, property panel, revision list and store boundaries unchanged.
- Give the existing tool container `role="toolbar" aria-label="도면 편집 도구"`.
- Apply common button/focus/status tokens to toolbar, properties and save/restore feedback.
- Maintain the wide editor layout at desktop and stack the properties/revisions below the canvas at 760px.
- Preserve 1,000-fixture performance, lease heartbeat/watchdog, dirty sentinel and atomic save/restore behavior.

- [x] **Step 6: Update settings documentation**

- Replace the old statement that PC uses a settings-only left menu with the approved primary-nav hover/focus and mobile bottom-sheet structure.
- Under `구현 완료`, record that only `설정 개요`, `도면 관리`, admin `비밀번호 변경` are exposed by role.
- Record the flattened content layout and unchanged setup/editor limitations.
- Update the date to `2026-08-31` and related files.

- [x] **Step 7: Run settings verification**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/settings src/features/floor-editor/FloorEditorView.test.tsx
pnpm --filter @led-control/web typecheck
```

Expected: tests and typecheck pass.

- [x] **Step 8: Commit Task 6**

```bash
git add apps/web/src/features/settings apps/web/src/features/floor-editor apps/web/src/styles.css docs/menus/settings.md
git commit -m "feat(web): refresh settings and floor editor surfaces"
```

---

### Task 7: Responsive and accessibility browser contracts

**Files:**
- Create: `apps/web/e2e/support/layout-assertions.ts`
- Modify: `apps/web/e2e/monitoring-control-flow.spec.ts`
- Modify: `apps/web/e2e/statistics-flow.spec.ts`
- Modify: `apps/web/e2e/settings-floor-editor.spec.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `expectNoHorizontalOverflow(page)` and `expectMinimumTouchTargets(page, selector)`
- Consumes: completed four-menu UI

- [x] **Step 1: Add the shared failing E2E layout assertions**

```ts
import { expect, type Page } from "@playwright/test";

export async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

export async function expectMinimumTouchTargets(page: Page, selector: string) {
  const undersized = await page.locator(selector).evaluateAll((elements) => elements.filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width < 44 || rect.height < 44;
  }).map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName));
  expect(undersized).toEqual([]);
}
```

Add assertions at 1440x900, 1024x768, 390x844 and 320x740 to the existing deterministic route-fixture flows. On settings, hover `설정`, click `도면 관리`, verify `siteId`, then repeat at mobile width by opening the `설정 메뉴` dialog.

- [x] **Step 2: Run the focused Playwright specs and verify RED**

Run:

```bash
pnpm --filter @led-control/web exec playwright test e2e/monitoring-control-flow.spec.ts e2e/statistics-flow.spec.ts e2e/settings-floor-editor.spec.ts --project=chromium
```

Expected: at least one new overflow/touch/navigation assertion fails before final responsive CSS is complete.

- [x] **Step 3: Finish the responsive CSS contract**

- At 1120px, stack monitoring/control/report secondary panels below primary content where required.
- At 760px, use bottom navigation, 2-column KPI, single-column work panels and mobile settings bottom sheet.
- At 360px, use 1-column KPI.
- Ensure fixed navigation respects `env(safe-area-inset-bottom)`.
- Apply `min-width: 0` to grid/flex children containing chart, tables or long Korean labels.
- Use `overflow-x: auto` only on actual data-table wrappers.
- Add a consistent `:focus-visible` ring and `@media (prefers-reduced-motion: reduce)` rule.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }
}
```

- [x] **Step 4: Run focused Playwright and full web verification**

Run:

```bash
pnpm --filter @led-control/web exec playwright test e2e/monitoring-control-flow.spec.ts e2e/statistics-flow.spec.ts e2e/settings-floor-editor.spec.ts --project=chromium
pnpm --filter @led-control/web test
pnpm --filter @led-control/web typecheck
pnpm --filter @led-control/web build
```

Expected: all commands exit 0 and each tested viewport has no document-level horizontal overflow.

- [x] **Step 5: Commit Task 7**

```bash
git add apps/web/e2e apps/web/src/styles.css
git commit -m "test(web): verify calm operations responsive layouts"
```

---

### Task 8: Documentation convergence and final verification

**Files:**
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-08-31-calm-operations-ui-refresh.md`
- Review: `docs/menus/monitoring.md`
- Review: `docs/menus/control.md`
- Review: `docs/menus/statistics.md`
- Review: `docs/menus/settings.md`

**Interfaces:**
- Consumes: verification evidence from Tasks 1–7
- Produces: truthful final status and completed checkbox record

- [x] **Step 1: Reconcile menu documents against the final UI**

Run:

```bash
rg -n "Calm Operations|서브메뉴|수동 제어|스케줄 제어|차량 이벤트|상태 기반 추정|도면 관리" docs/menus docs/superpowers/specs/2026-08-31-calm-operations-ui-refresh-design.md
```

Expected: each implemented customer menu has a matching current statement; no document claims a new API, actual meter, Gateway command or completed HIL.

- [ ] **Step 2: Run the complete web validation suite**

Run:

```bash
pnpm --filter @led-control/shared build
pnpm --filter @led-control/web test
pnpm --filter @led-control/web typecheck
pnpm --filter @led-control/web build
pnpm --filter @led-control/web exec playwright test --project=chromium
```

Expected: every command exits 0. Record exact unit and Playwright pass counts and bundle output in `docs/project-status.md`.

- [ ] **Step 3: Perform manual visual QA**

Inspect monitoring, each of the three control modes, statistics, settings overview, floor-plan list/editor and password at 1440px, 1024px, 390px and 320px. Verify:

- title → primary status → primary action reading order
- icon + text status distinction
- settings hover/focus submenu and mobile bottom sheet
- long Korean labels and large numeric values
- loading, empty, partial and danger states
- no clipped popover, fixed navigation overlap or accidental document overflow

Record browser-policy blocks separately from automated Chromium results.

- [x] **Step 4: Update status and plan checkboxes**

Set the Calm Operations implementation row in `docs/project-status.md` to `완료(소프트웨어)` only if Step 2 passes. Include manual visual QA as complete or explicitly list the environment block. Mark every completed checkbox in this plan; do not mark HIL complete.

- [x] **Step 5: Review the complete diff**

Run:

```bash
git diff --check
git status --short
git log --oneline -10
```

Expected: no whitespace errors, only intended UI/docs files modified, and Tasks 1–7 commits are present.

- [x] **Step 6: Commit Task 8**

```bash
git add docs/project-status.md docs/superpowers/plans/2026-08-31-calm-operations-ui-refresh.md docs/menus
git commit -m "docs: finalize calm operations UI refresh"
```

---

## Final Review Gate

After Task 8, invoke `superpowers:requesting-code-review`. The reviewer must compare the final diff against the design spec and this plan, with special attention to:

- settings hover/focus/touch submenu behavior and role filtering
- retention of `siteId`, route guards, dirty editor handling and operator isolation
- no regressions in command/session/automation state machines
- no color-only status communication
- mobile bottom navigation, bottom sheet, 320px overflow and touch targets
- menu docs and project status matching actual verification evidence

Any review finding is handled with `superpowers:receiving-code-review`, a failing regression test, the minimal fix and a focused re-run before repeating the final gate.

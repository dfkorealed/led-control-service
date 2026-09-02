# Calm Operations A Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 Calm Operations A 교정 시안 26개를 기존 기능 계약을 유지한 실제 React UI에 적용하고 네 개 지정 viewport에서 안전하게 동작하게 한다.

**Architecture:** 현재 route와 feature별 React Query/mutation/store 구조는 유지하고 JSX의 정보 위계와 `apps/web/src/styles.css`의 token·layout만 교정한다. 재사용 surface는 `apps/web/src/components/ui`를 확장해 각 feature가 표시 데이터만 전달하게 하며, feature별 상태 머신은 기존 파일에 남긴다. 구현은 공통 기반, 로그인·operator, 설치·등록, 모니터링, 수동·구역 제어, 자동화, 통계, 설정·도면·보안의 8개 review gate로 진행한다.

**Tech Stack:** React 18, TypeScript, React Router, TanStack React Query, Zustand, Vitest, Testing Library, Playwright Chromium, Recharts, Konva, Lucide React, CSS custom properties

**Spec:** `docs/superpowers/specs/2026-09-02-calm-operations-a-correction-design.md`

## Global Constraints

- 기준 branch는 `codex/calm-operations-a-implementation`, 기준 commit은 `edde0d8f55920e54ecc877fe6c42dcd97a732009`이다.
- 시각 정본은 `calm-operations-a-corrected`의 `prototype.html`, `manifest.json`, PNG 26개이며, 추가 확정 요구가 시안보다 우선한다.
- scene 01 로그인에서 `연결 조명`, `정상 운영`, `게이트웨이` 요약 3개를 완전히 제거한다.
- 기존 API/React Query/state/route/권한/복구/dirty guard/command semantics를 변경하지 않는다.
- `packages/shared`, `apps/api`, `apps/gateway`, `apps/esp32-h2-firmware`, DB schema와 MQTT 계약을 수정하지 않는다.
- 일반 사용자-visible copy에 `ACK`를 사용하지 않고 `장비 응답`, `적용 확인`, `응답 대기`로 표현한다. protocol identifier와 개발자 전용 계약명은 유지한다.
- 재사용 버튼·카드·배지는 `apps/web/src/components/ui`의 공통 컴포넌트를 사용하거나 그 public interface를 확장한다.
- `1440×900`, `1024×768`, `390×844`, `320×740`에서 document-level horizontal overflow, 겹침, 잘린 primary action이 없어야 한다.
- `760px` 이하의 활성 control은 reachable `44×44 CSS px` target을 제공하고 bottom navigation safe area를 침범하지 않는다.
- 각 task는 실패 테스트 작성 → RED 확인 → 최소 구현 → GREEN → 관련 회귀 → 문서 갱신 → commit 순서를 지킨다.
- 메뉴 변경은 같은 task에서 `docs/menus/monitoring.md`, `control.md`, `statistics.md`, `settings.md` 중 영향 문서를 갱신한다.
- 브라우저 fixture와 자동 Chromium 결과를 Raspberry Pi/ESP32-H2 HIL 완료로 기록하지 않는다.

---

## 실행 조정 규칙

- task 담당자는 해당 task의 코드·테스트·메뉴 문서만 수정하고 검증 결과를 총괄에게 보고한다.
- 총괄은 review가 통과한 뒤 이 계획의 해당 checkbox와 `docs/project-status.md`를 같은 상태로 갱신하고 task 변경과 함께 한 commit으로 만든다.
- 앞 task가 제공하는 공통 interface를 뒤 task가 소비하므로 task 번호 순서로 통합한다. task 내부 feature 파일은 서로 독립적으로 review하고 reject할 수 있다.
- 각 task 시작 시 `git status --short`로 이전 task 외 미추적 변경이 없는지 확인한다. 다른 task의 미완성 변경이 있으면 같은 파일을 수정하지 않는다.

## 파일 책임 지도

| 책임 | 파일 |
| --- | --- |
| token·공통 layout | `apps/web/src/styles.css` |
| 공통 button/card/badge/metric/header/feedback/progress | `apps/web/src/components/ui/*` |
| 인증 분기와 route 정본 | `apps/web/src/App.tsx`, `apps/web/src/features/shells/CustomerShell.tsx`, `apps/web/src/features/operator/OperatorShell.tsx` |
| 로그인 | `apps/web/src/features/auth/AuthView.tsx` |
| operator 계정 관리 | `apps/web/src/features/operator/site-admins/*` |
| setup/claim/registration | `apps/web/src/features/setup/*`, `apps/web/src/features/registration/*` |
| 모니터링 | `apps/web/src/features/monitoring/*`, `apps/web/src/features/floor-map/FloorScene.tsx` |
| 수동·구역 제어 | `apps/web/src/features/control/ControlView.tsx`, `ControlTargetPicker.tsx`, `FixtureGroupDialog.tsx` |
| schedule/event | `apps/web/src/features/control/automation/*` |
| 통계 | `apps/web/src/features/statistics/*` |
| 설정·도면·보안 | `apps/web/src/features/settings/*`, `apps/web/src/features/floor-editor/*` |
| responsive fixture | `apps/web/e2e/*`, `apps/web/e2e/support/layout-assertions.ts` |
| 상태 문서 | `docs/menus/*.md`, `docs/project-status.md`, 이 계획 파일 |

## Scene coverage

| Task | Scene | 검증 대상 |
| --- | --- | --- |
| 1 | 01~26 공통 | token, rail/topbar/bottom nav, 공통 상태·진행 컴포넌트, viewport 계약 |
| 2 | 01~03 | 로그인, operator 목록, 계정 dialog |
| 3 | 04~09 | 초기 설치, Viewer 대기, Gateway claim, 검색, batch/individual, 복구 |
| 4 | 10~12 | monitoring desktop/mobile/exception |
| 5 | 13~16 | manual control, command result, unavailable/viewer, saved zone |
| 6 | 17~21 | schedule list/editor/states, event list/editor |
| 7 | 22~23 | statistics normal/states |
| 8 | 24~26 | settings navigation, floor list/editor, lease/conflict/password |

---

### Task 1: Corrected tokens, shared feedback/progress, and application shell

**Scenes:** 01~26 공통 기반

**Files:**
- Create: `apps/web/src/components/ui/ProgressSteps.tsx`
- Create: `apps/web/e2e/calm-operations-shell.spec.ts`
- Modify: `apps/web/src/components/ui/FeedbackState.tsx`
- Modify: `apps/web/src/components/ui/index.ts`
- Modify: `apps/web/src/components/ui/ui-primitives.test.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`
- Orchestrator update: `docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md`
- Orchestrator update: `docs/project-status.md`

**Interfaces:**
- Consumes: existing `ButtonProps`, `CardTone`, `StatusTone`, `MetricTone`, `PageHeader` public exports
- Produces: `FeedbackTone = "neutral" | "info" | "success" | "warning" | "danger"`
- Produces: `ProgressStepState = "complete" | "current" | "pending" | "error"`
- Produces: `ProgressStep { id: string; label: string; state: ProgressStepState; description?: string }`
- Produces: `ProgressSteps({ label, steps }: { label: string; steps: readonly ProgressStep[] })`
- Preserves: `CustomerShell` route tree, `siteId` query, logout/dirty guard, settings disclosure behavior

- [x] **Step 1: Add failing primitive and shell tests**

Add these contracts to `ui-primitives.test.tsx`:

```tsx
it("renders ordered progress without using color as the only state", () => {
  render(<ProgressSteps label="명령 진행" steps={[
    { id: "queued", label: "명령 접수", state: "complete" },
    { id: "accepted", label: "장비 응답", state: "current" },
    { id: "applied", label: "조명 적용", state: "pending" }
  ]} />);

  const list = screen.getByRole("list", { name: "명령 진행" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  expect(within(list).getByText("장비 응답").closest("li")).toHaveAttribute("data-state", "current");
});

it.each(["info", "success", "warning"] as const)("exposes the %s feedback tone", (tone) => {
  render(<FeedbackState tone={tone} icon={CircleCheck} title={`${tone} 상태`} />);
  expect(screen.getByText(`${tone} 상태`).closest("section")).toHaveAttribute("data-tone", tone);
});
```

Add an App assertion that the four customer navigation links remain present after the rail markup changes. In the new Playwright file, mock the installed admin dashboard through `installSettingsApiRoutes`, visit `/monitoring`, and assert rail/topbar/bottom-nav geometry plus `expectNoHorizontalOverflow()` at all four required viewports.

- [x] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
pnpm --filter @led-control/web test -- src/components/ui/ui-primitives.test.tsx src/App.test.tsx
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-shell.spec.ts --project=chromium
```

Expected: Vitest fails because `ProgressSteps` is not exported and `FeedbackTone` rejects the new tones; Playwright fails because the new file's 92px rail/compact topbar/bottom-nav geometry assertions do not match the current shell.

- [x] **Step 3: Implement the shared progress and feedback interfaces**

Create the component with native ordered-list semantics:

```tsx
export type ProgressStepState = "complete" | "current" | "pending" | "error";

export interface ProgressStep {
  id: string;
  label: string;
  state: ProgressStepState;
  description?: string;
}

export function ProgressSteps({ label, steps }: { label: string; steps: readonly ProgressStep[] }) {
  return (
    <ol className="ui-progress-steps" aria-label={label}>
      {steps.map((step, index) => (
        <li key={step.id} data-state={step.state} aria-current={step.state === "current" ? "step" : undefined}>
          <span className="ui-progress-index" aria-hidden="true">{step.state === "complete" ? "✓" : index + 1}</span>
          <span><strong>{step.label}</strong>{step.description ? <small>{step.description}</small> : null}</span>
        </li>
      ))}
    </ol>
  );
}
```

Expand `FeedbackTone`, export the new types/component from `index.ts`, and style every tone with icon + text contrast. Do not put query state or timers in these components.

- [x] **Step 4: Apply the corrected token layer and shell geometry**

Set the exact spec colors and radii in `:root`, change desktop `.app-shell` to a 92px rail plus 72px top context bar, and keep the existing route links and `SettingsNavigationItem`. At `760px` and below, preserve four bottom navigation items and add safe-area content padding; at `360px` and below, allow labels to wrap without reducing the 44px target.

Implement the geometry with this CSS boundary while leaving the current `Routes`, `NavLink`, status values and handlers in place:

```css
.app-shell {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  min-height: 100vh;
}
.sidebar { width: 92px; }
.content { display: grid; grid-template-rows: 72px minmax(0, 1fr); min-width: 0; padding: 0; }
.topbar { min-width: 0; min-height: 72px; }
.content > :not(.topbar) { min-width: 0; margin: 20px 24px 24px; }
```

Do not add notification, avatar, or refresh controls that have no current handler.

- [x] **Step 5: Make the four-viewport shell fixture pass**

Use `responsiveViewports = [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 320, height: 740 }]`. Assert desktop rail visibility above 760px, bottom navigation visibility at or below 760px, one current nav item, content clear of fixed navigation, no horizontal overflow, and minimum mobile touch targets.

- [x] **Step 6: Run GREEN and shell regression**

Run:

```bash
pnpm --filter @led-control/web test -- src/components/ui/ui-primitives.test.tsx src/App.test.tsx src/features/shells/SettingsNavigationItem.test.tsx
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-shell.spec.ts e2e/layout-assertions.spec.ts --project=chromium
pnpm --filter @led-control/web typecheck
```

Expected: all commands exit 0; settings hover/focus/touch tests still preserve role and `siteId` behavior.

- [x] **Step 7: Review, synchronize status, and commit Task 1**

The orchestrator checks the completed boxes above, adds a `Calm Operations A 교정 UI` active row to `docs/project-status.md` with Task 1 complete and Tasks 2~8 remaining, then commits only reviewed files:

```bash
git add apps/web/src/components/ui apps/web/src/features/shells/CustomerShell.tsx apps/web/src/App.test.tsx apps/web/src/styles.css apps/web/e2e/calm-operations-shell.spec.ts docs/project-status.md docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md
git commit -m "feat(web): establish corrected calm operations shell"
```

---

### Task 2: Login and global operator surfaces

**Scenes:** 01, 02, 03

**Files:**
- Create: `apps/web/e2e/calm-operations-auth-operator.spec.ts`
- Modify: `apps/web/src/features/auth/AuthView.tsx`
- Modify: `apps/web/src/features/operator/OperatorShell.tsx`
- Modify: `apps/web/src/features/operator/site-admins/SiteAdminManagementView.tsx`
- Modify: `apps/web/src/features/operator/site-admins/SiteAdminFormDialog.tsx`
- Modify: `apps/web/src/features/operator/site-admins/ResetAdminPasswordDialog.tsx`
- Modify: `apps/web/src/features/operator/site-admins/DisableSiteAdminDialog.tsx`
- Modify: `apps/web/src/features/operator/site-admins/SiteAdminManagementView.test.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`
- Orchestrator update: `docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md`
- Orchestrator update: `docs/project-status.md`

**Interfaces:**
- Consumes: `Button`, `Card`, `MetricCard`, `PageHeader`, `StatusBadge`, `FeedbackState`
- Preserves: `AuthViewProps.onAuthenticated`, `login({ loginId, password, rememberMe })`, plaintext non-cache behavior
- Preserves: `DialogState`, operator query key/invalidation, create/assign/edit/reset/disable mutation arguments and focus restoration
- Produces no new API or route

- [x] **Step 1: Write failing login and operator semantic tests**

Use the exact test names `로그인은 운영 요약 없이 Calm Operations 브랜드와 실제 폼만 표시한다`, `운영자 목록은 실제 데이터로 네 요약과 상태 표를 표시한다`, and `운영자 계정 dialog는 mutation 후 초점을 복원한다`.

In `App.test.tsx`, extend the unauthenticated case:

```tsx
expect(screen.getByRole("heading", { name: /빛을 더 안정적으로/ })).toBeInTheDocument();
expect(screen.getByRole("heading", { name: "LED Control 로그인" })).toBeInTheDocument();
expect(screen.queryByText("연결 조명")).not.toBeInTheDocument();
expect(screen.queryByText("정상 운영")).not.toBeInTheDocument();
expect(screen.queryByText(/^(Gateway|게이트웨이)$/i)).not.toBeInTheDocument();
expect(screen.getByRole("checkbox", { name: "자동 로그인" })).toBeChecked();
```

In `SiteAdminManagementView.test.tsx`, after the list query resolves, assert groups named `운영 현장`, `설치 완료`, `관리자 계정`, and `확인 필요`, common status badges, the table label, and the existing five dialog actions. Keep every current password, conflict, focus restoration and mutation assertion.

- [x] **Step 2: Run the component tests and confirm RED**

Run:

```bash
pnpm --filter @led-control/web test -- src/App.test.tsx src/features/operator/site-admins/SiteAdminManagementView.test.tsx
```

Expected: login fails on the new brand heading; operator fails because metric groups and corrected page hierarchy do not exist.

- [x] **Step 3: Implement the login composition without summary cards**

Split `AuthView` into `.auth-brand-panel` and a `Card` form panel. Keep the same controlled inputs and submit function. Render this content:

```tsx
<section className="auth-brand-panel" aria-label="LED Control 소개">
  <div className="brand auth-brand"><span className="brand-mark">LC</span><strong>LED Control</strong></div>
  <h1>빛을 더 안정적으로,<br />현장을 더 선명하게.</h1>
  <p>주차장 LED 조명의 상태, 제어, 에너지 사용량을 하나의 차분한 운영 화면에서 확인하세요.</p>
</section>
```

Render no operational metric in the brand panel. Use `Button` for login and `FeedbackState` or an equivalent semantic inline alert for authentication failure. Preserve `autocomplete`, required fields, checked default and duplicate-submit lock.

- [x] **Step 4: Implement the operator header, metrics, table, and dialogs**

Use the resolved `siteAdmins.data` to derive display-only counts with `useMemo`; do not issue another query. The metric values are total sites, installed sites, assigned admin count, and pending/unassigned/inactive count. Render `PageHeader` + four `MetricCard`s + the existing table. Replace local action/button/card/status markup with common primitives while preserving every handler and accessible action name.

Keep dialog props and mutation calls byte-for-byte compatible. Only reorganize header, form field grid, feedback, and footer action order. Do not add prototype-only export, search, or filter controls.

Render the display-only counts with the existing query result:

```tsx
const summaries = [
  { label: "운영 현장", value: siteAdmins.data?.length ?? 0 },
  { label: "설치 완료", value: siteAdmins.data?.filter((site) => site.installationStatus === "installed").length ?? 0 },
  { label: "관리자 계정", value: siteAdmins.data?.filter((site) => site.admin).length ?? 0 },
  { label: "확인 필요", value: siteAdmins.data?.filter((site) => site.installationStatus !== "installed" || !site.admin || site.admin.status !== "active").length ?? 0 }
];
```

- [x] **Step 5: Add responsive auth/operator Playwright coverage**

Mock `auth/me` as unauthenticated for login and as operator for `/operator/site-admins`; mock the existing operator list endpoint with installed, pending, unassigned and inactive examples. For all four viewports assert login form visibility, absence of the three forbidden summaries, operator table or its own scroll container, dialog visibility, no document overflow, and mobile touch targets.

- [x] **Step 6: Run GREEN and auth/operator regression**

Run:

```bash
pnpm --filter @led-control/web test -- src/App.test.tsx src/features/operator/site-admins/SiteAdminManagementView.test.tsx
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-auth-operator.spec.ts e2e/auth-real.spec.ts --project=chromium
pnpm --filter @led-control/web typecheck
```

Expected: focused tests pass; real-auth spec remains skipped unless its existing environment flag is enabled; no password value appears in React Query cache assertions.

- [x] **Step 7: Review, synchronize status, and commit Task 2**

The orchestrator records scene 01~03 complete and keeps software/browser-fixture evidence distinct from real backend execution.

```bash
git add apps/web/src/features/auth apps/web/src/features/operator apps/web/src/App.test.tsx apps/web/src/styles.css apps/web/e2e/calm-operations-auth-operator.spec.ts docs/project-status.md docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md
git commit -m "feat(web): apply calm operations auth and operator UI"
```

---

### Task 3: Installation, gateway claim, registration, and recovery

**Scenes:** 04, 05, 06, 07, 08, 09

**Files:**
- Create: `apps/web/e2e/calm-operations-commissioning.spec.ts`
- Modify: `apps/web/src/features/setup/SetupWizard.tsx`
- Modify: `apps/web/src/features/setup/SetupWizard.test.tsx`
- Modify: `apps/web/src/features/setup/GatewayClaimPanel.tsx`
- Modify: `apps/web/src/features/setup/GatewayClaimPanel.test.tsx`
- Modify: `apps/web/src/features/registration/RegistrationPanel.tsx`
- Modify: `apps/web/src/features/registration/RegistrationPanel.test.tsx`
- Modify: `apps/web/src/features/registration/FixtureBatchForm.tsx`
- Modify: `apps/web/src/features/registration/FixtureIndividualForm.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/settings.md`
- Orchestrator update: `docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md`
- Orchestrator update: `docs/project-status.md`

**Interfaces:**
- Consumes: `Button`, `Card`, `StatusBadge`, `FeedbackState`, `ProgressSteps`
- Preserves: `SetupWizardProps`, `GatewayClaimPanelProps`, `RegistrationPanelProps`
- Preserves: setup/claim/registration API payloads, query keys, active-session polling and cache invalidation
- Preserves: `FixtureBatchDefaults`, `FixtureIndividualDefaults`, `FixtureIndividualDraft`

- [ ] **Step 1: Add failing installation and registration hierarchy tests**

Add these focused assertions while keeping all current mutation tests:

```tsx
expect(screen.getByRole("list", { name: "현장 설치 진행" })).toHaveTextContent("현장 정보");
expect(screen.getByRole("list", { name: "현장 설치 진행" })).toHaveTextContent("Gateway 연결");
expect(screen.getByRole("heading", { name: "현장 기본 정보를 입력하세요" })).toBeInTheDocument();
```

For Gateway claim, assert separate named regions `Viewer 설치 대기` and `Gateway 연결`; the fixture used by each test renders only the role-appropriate region. For registration, add state-driven cases named:

```tsx
it("교정 UI에서 검색 중 상태를 실제 session 상태로 표현한다", async () => {
  const activeSession = { ...mockRegistrationSession, scanStatus: "scanning" as const, discoveredNodes: [] };
  activeSessionsMock.mockResolvedValue([activeSession]);
  getSessionMock.mockResolvedValue(activeSession);
  renderPanel();
  expect(await screen.findByRole("status", { name: "조명 검색 상태" })).toHaveTextContent("검색 중");
});

it("등록 실패와 확인 필요 노드를 장비 상태 확인 단계로 표현한다", async () => {
  const node = { ...mockRegistrationSession.discoveredNodes[0], status: "reconcile_required" as const };
  const activeSession = completedSession([node]);
  activeSessionsMock.mockResolvedValue([activeSession]);
  getSessionMock.mockResolvedValue(activeSession);
  renderPanel();
  expect(await screen.findByRole("list", { name: "조명 등록 진행" })).toHaveTextContent("상태 확인");
});
```

The assertions must target headings, lists, status/alert roles and existing button names rather than CSS snapshots.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/setup/SetupWizard.test.tsx src/features/setup/GatewayClaimPanel.test.tsx src/features/registration/RegistrationPanel.test.tsx src/App.test.tsx
```

Expected: tests fail because the shared progress list and named commissioning regions are not wired into setup/registration views.

- [ ] **Step 3: Apply the setup and claim hierarchy**

Render actual installation progress with `ProgressSteps`, then group the existing address, tariff, timezone, floor-count and generated-floor controls into `Card` sections. Keep all validation constants and `createInitialSiteSetup` input unchanged.

For `InstallationPending`, render a neutral `FeedbackState` named `Viewer 설치 대기`. For `GatewayClaimPanel`, use a `Card`, common buttons and status feedback around the existing name/serial/code inputs. Do not show Ethernet, mTLS or device-online checks because the current API does not provide them.

Use the existing mutation state to supply the progress interface:

```tsx
<ProgressSteps label="현장 설치 진행" steps={[
  { id: "site", label: "현장 정보", state: "current" },
  { id: "gateway", label: "Gateway 연결", state: "pending" },
  { id: "fixtures", label: "조명 등록", state: "pending" },
  { id: "operate", label: "운영 시작", state: "pending" }
]} />
```

- [ ] **Step 4: Apply search, batch/individual, and recovery surfaces**

Keep `nodes`, `selectableNodes`, `actionableNodes`, historic unresolved merge and all mutation objects unchanged. Recompose the return JSX into:

```ts
function registrationSteps(session: RegistrationSession, nodes: DiscoveredRegistrationNode[]): ProgressStep[] {
  const unresolved = nodes.some((node) => node.status === "provisioning" || node.status === "reconcile_required");
  const scanState: ProgressStepState = session.scanStatus === "completed"
    ? "complete"
    : session.scanStatus === "failed" ? "error" : "current";
  return [
    { id: "scan", label: "조명 검색", state: scanState },
    { id: "configure", label: "등록 정보", state: nodes.length > 0 ? "current" : "pending" },
    { id: "provision", label: "장비 등록", state: unresolved ? "current" : "pending" },
    { id: "reconcile", label: "상태 확인", state: nodes.some((node) => node.status === "reconcile_required") ? "current" : "pending" }
  ];
}
```

`registrationSteps` is a pure display mapper local to `RegistrationPanel.tsx`; it must not alter status progression or polling. Migrate form submit buttons to common `Button` and node status to `StatusBadge`.

- [ ] **Step 5: Add commissioning viewport coverage**

Reuse `installSettingsApiRoutes` and the current `RegistrationSession` fixtures. At 1440/1024/390/320, cover pending admin setup, Viewer pending, Gateway claim, completed-empty scan, discovered batch, individual validation, reconcile state and enabled action touch targets. Call `expectNoHorizontalOverflow` after each state transition.

- [ ] **Step 6: Update the settings menu status document**

In `docs/menus/settings.md`, keep all required sections and add scene 04~09 under `구현 완료`. State that the UI uses actual setup/claim/registration APIs, active-session recovery remains implemented, prototype-only device prechecks are not implemented, and browser fixtures are not hardware HIL. Add the changed files to `관련 파일` and set the basis date to `2026-09-02`.

- [ ] **Step 7: Run GREEN and commissioning regression**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/setup/SetupWizard.test.tsx src/features/setup/GatewayClaimPanel.test.tsx src/features/registration/RegistrationPanel.test.tsx src/App.test.tsx
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-commissioning.spec.ts e2e/monitoring-control-flow.spec.ts --project=chromium
pnpm --filter @led-control/web typecheck
git diff --check
```

Expected: setup/claim payload tests, active session recovery, reconcile, rescan and all viewport assertions pass.

- [ ] **Step 8: Review, synchronize status, and commit Task 3**

```bash
git add apps/web/src/features/setup apps/web/src/features/registration apps/web/src/App.test.tsx apps/web/src/styles.css apps/web/e2e/calm-operations-commissioning.spec.ts docs/menus/settings.md docs/project-status.md docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md
git commit -m "feat(web): apply calm operations commissioning UI"
```

---

### Task 4: Monitoring desktop, mobile, and exception states

**Scenes:** 10, 11, 12

**Files:**
- Create: `apps/web/e2e/calm-operations-monitoring.spec.ts`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/features/monitoring/MonitoringView.test.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.test.tsx`
- Modify: `apps/web/src/features/floor-map/FloorScene.tsx`
- Modify: `apps/web/src/features/floor-map/FloorScene.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/monitoring.md`
- Orchestrator update: `docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md`
- Orchestrator update: `docs/project-status.md`

**Interfaces:**
- Consumes: common `Button`, `Card`, `MetricCard`, `PageHeader`, `StatusBadge`, `FeedbackState`
- Preserves: `useDashboard`, `useFloorFixtures`, `useFloorMapSnapshot`, 10-minute policy, pagination and manual refresh
- Preserves: `FloorMapProps`, `FloorScene` hit targets and read-only monitoring behavior
- Produces: named regions `빠른 상태`, `층 도면`, `선택 조명 상세`

- [ ] **Step 1: Write failing monitoring state and hierarchy tests**

Use the exact test names `모니터링은 빠른 상태, 층 도면, 선택 조명 상세 순서를 유지한다`, `부분 지도 갱신 실패에서도 직전 유효 데이터를 유지한다`, and `모바일 모니터링은 320px에서 문서 overflow 없이 동작한다`.

Add assertions to the populated, zero-fixture, map-error and partial-refresh tests:

```tsx
expect(screen.getByRole("heading", { name: "운영 현황" })).toBeInTheDocument();
expect(screen.getByRole("group", { name: "전체 조명" })).toHaveTextContent("2");
expect(screen.getByRole("group", { name: "정상" })).toHaveTextContent("1");
expect(screen.getByRole("region", { name: "빠른 상태" })).toHaveTextContent("점검 필요");
expect(screen.getByRole("region", { name: "층 도면" })).toBeInTheDocument();
expect(screen.getByRole("complementary", { name: "선택 조명 상세" })).toHaveTextContent("현재 밝기");
```

Add a mobile-order unit assertion using DOM order: `빠른 상태` precedes `층 도면`, which precedes `선택 조명 상세`. Keep existing selected fixture, provisioning-waiting, pagination and map fallback assertions.

- [ ] **Step 2: Run monitoring tests and confirm RED**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/monitoring/MonitoringView.test.tsx src/features/monitoring/FloorMap.test.tsx src/features/floor-map/FloorScene.test.tsx
```

Expected: new `빠른 상태` region and mobile-oriented DOM order assertions fail against the current layout.

- [ ] **Step 3: Recompose monitoring without changing queries**

Keep all hooks/effects/handlers above the return unchanged. Use common `Button` for refresh/retry, add a `Card` quick-status list derived from existing fault/offline fixtures, keep four metric cards, and place map/detail in the corrected 1fr/280px desktop grid. The empty admin/viewer, first map failure and partial map refresh branches remain separate.

Render the quick-state region directly from the current derived values:

```tsx
<Card className="monitoring-quick-status" role="region" aria-label="빠른 상태">
  <button type="button" disabled={!firstFaultFixture} onClick={() => firstFaultFixture && setSelectedFixtureId(firstFaultFixture.id)}>
    <TriangleAlert aria-hidden="true" /><span>점검 필요</span><strong>{floorSummary.faultFixtures}대</strong>
  </button>
  <button type="button" disabled={!firstOfflineFixture} onClick={() => firstOfflineFixture && setSelectedFixtureId(firstOfflineFixture.id)}>
    <CircleX aria-hidden="true" /><span>오프라인</span><strong>{offlineCount}대</strong>
  </button>
</Card>
```

Do not add a control link unless it is an actual React Router `Link` to `/control` that preserves the full current query string; if the link is added, assert it in `App.test.tsx` before implementation.

- [ ] **Step 4: Align map and marker visuals**

Keep `interactive={false}`, marker keyboard/click selection and accessible names. Reduce decoration, use icon+text legend for `정상`, `장애`, `오프라인`, `상태 확인 대기`, and keep the selected marker ring visible at 200% zoom. Do not change map coordinate scaling or hit-test math.

Keep the `FloorScene` call interface unchanged:

```tsx
<FloorScene
  snapshot={snapshot}
  fixtures={floor.fixtures}
  interactive={false}
  floorName={floor.name}
  selectedFixtureId={selectedFixtureId}
  onSelectFixture={onSelectFixture}
/>
```

- [ ] **Step 5: Add monitoring four-viewport and exception coverage**

Use the installed dashboard fixture with online/fault/offline/provisioning-waiting fixtures. At all viewports assert 4/4, 2/2, 2/2, 1/1 KPI columns for desktop/tablet/mobile/minimum respectively, correct panel stacking, no overflow and mobile touch targets. Add fixture variants for 0 fixtures, Viewer pending, initial map failure and partial refresh failure; assert valid data remains visible in the partial case.

- [ ] **Step 6: Update monitoring documentation**

Update `docs/menus/monitoring.md` under `구현 완료`, `부족하거나 개선이 필요한 기능`, `관련 파일`, and keep its hardware caveats. Record scenes 10~12, mobile quick-state ordering, four viewport contract, icon+text statuses and unchanged registration/session logic.

- [ ] **Step 7: Run GREEN and monitoring regression**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/monitoring/MonitoringView.test.tsx src/features/monitoring/FloorMap.test.tsx src/features/floor-map/FloorScene.test.tsx src/App.test.tsx
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-monitoring.spec.ts e2e/monitoring-1000.spec.ts --project=chromium
pnpm --filter @led-control/web typecheck
git diff --check
```

Expected: semantic tests pass, 1,000-fixture rendering remains a browser fixture rather than HIL, and every viewport has no document overflow.

- [ ] **Step 8: Review, synchronize status, and commit Task 4**

```bash
git add apps/web/src/features/monitoring apps/web/src/features/floor-map/FloorScene.tsx apps/web/src/features/floor-map/FloorScene.test.tsx apps/web/src/styles.css apps/web/e2e/calm-operations-monitoring.spec.ts docs/menus/monitoring.md docs/project-status.md docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md
git commit -m "feat(web): apply corrected monitoring surfaces"
```

---

### Task 5: Manual control, command results, readiness, and saved zones

**Scenes:** 13, 14, 15, 16

**Files:**
- Create: `apps/web/e2e/calm-operations-manual-control.spec.ts`
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Modify: `apps/web/src/features/control/ControlView.test.tsx`
- Modify: `apps/web/src/features/control/ControlTargetPicker.tsx`
- Modify: `apps/web/src/features/control/FixtureGroupDialog.tsx`
- Modify: `apps/web/src/features/control/FixtureGroupDialog.test.tsx`
- Modify: `apps/web/src/components/ConfirmDialog.tsx`
- Modify: `apps/web/e2e/monitoring-control-flow.spec.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/control.md`
- Orchestrator update: `docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md`
- Orchestrator update: `docs/project-status.md`

**Interfaces:**
- Consumes: `Button`, `Card`, `PageHeader`, `StatusBadge`, `FeedbackState`, `ProgressSteps`
- Preserves: `ControlSelection`, `controlSelectionToDimmingTarget`, `createDimmingCommand`, `useCommandStatus`
- Preserves: active command request/id storage, session ownership, retry, terminal lock release and logout blocking
- Preserves: fixture-group CRUD/resync payload, focus trap, return focus and viewer read-only rules
- Produces: `humanizeDeviceResponseMessage(value: string): string` as a display-only mapper

- [ ] **Step 1: Write failing manual-control and copy tests**

Use the exact test names `수동 제어는 실제 command stage를 명령 진행 단계로 표시한다`, `서버의 ACK 문구는 사용자 화면에서 장비 응답으로 표시한다`, and `저장 구역 dialog는 CRUD와 포커스 계약을 유지한다`.

Extend the current command success, partial failure, timeout, recovery, blocked and viewer cases:

```tsx
expect(screen.getByRole("tabpanel", { name: "수동 제어" })).toBeInTheDocument();
expect(screen.getByRole("group", { name: "제어 대상 선택" })).toBeInTheDocument();
expect(screen.getByRole("complementary", { name: "밝기 실행" })).toBeInTheDocument();
expect(screen.getByRole("list", { name: "명령 진행" })).toHaveTextContent("장비 응답");
expect(screen.queryByText(/ACK/i)).not.toBeInTheDocument();
```

Feed a fixture result error of `"게이트웨이 ACK를 확인하지 못했습니다."` and assert the rendered text is `"게이트웨이 장비 응답을 확인하지 못했습니다."`. Keep the raw mocked API value unchanged so the test proves the display mapper rather than hiding the case.

In `FixtureGroupDialog.test.tsx`, add headings/status assertions for the list and editor while retaining exact create/update/delete/resync payload and focus tests.

- [ ] **Step 2: Run control tests and confirm RED**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/control/ControlView.test.tsx src/features/control/FixtureGroupDialog.test.tsx
```

Expected: `명령 진행` list is absent and raw `ACK` text is still rendered from the command message/result.

- [ ] **Step 3: Implement the display-only response wording boundary**

Keep command stages and protocol values unchanged. Add a local pure formatter and use it only at render/set-message boundaries:

```ts
function humanizeDeviceResponseMessage(value: string) {
  return value.replace(/\bACK\b/gi, "장비 응답");
}
```

Change the successful post message to `"명령을 전송했습니다. 장비 응답을 기다리는 중입니다."`. Apply the formatter to server-provided fixture result messages before display. Do not change response matching, terminal detection or retry decisions.

- [ ] **Step 4: Render corrected target, brightness, and command progress surfaces**

Keep `ControlTargetPicker` modes, search, filters, selection limit and readiness derivation. Use `Card` for target and brightness panels, common `Button` for presets/actions, and `StatusBadge` for read-only/readiness.

Map the existing command stage to display steps:

```ts
const commandSteps = [
  { id: "queued", label: "명령 접수", state: stepState(status.stage, "queued") },
  { id: "published", label: "Gateway 전송", state: stepState(status.stage, "published") },
  { id: "accepted", label: "장비 응답", state: stepState(status.stage, "accepted") },
  { id: "completed", label: "조명 적용", state: terminalStepState(status.stage) }
] satisfies ProgressStep[];
```

`stepState` and `terminalStepState` are pure visual mappers. Existing `CommandStage`, fixture counts and failed results remain the source of truth.

- [ ] **Step 5: Apply saved-zone list/editor visuals**

Recompose `FixtureGroupDialog` with a page heading, current group list, Mesh status badges and a focused editor card. Keep group address/version display, selected fixtures, resync/delete confirmation and viewer action hiding. Use common `ConfirmDialog` buttons without changing its focus contract.

Use the existing readiness values to choose the shared badge rather than creating a second state model:

```tsx
<StatusBadge tone={group.meshControlGroup?.status === "ready" ? "success" : "warning"} icon={group.meshControlGroup?.status === "ready" ? CircleCheck : Clock3}>
  {group.meshControlGroup?.status === "ready" ? "준비됨" : "확인 필요"}
</StatusBadge>
```

- [ ] **Step 6: Add four-viewport manual and zone coverage**

Use the current monitoring/control fixture to cover target modes, slider/presets/override, in-flight lock, success/partial/timeout/recovery, offline/fault/Mesh block, viewer, and group list/editor at all four viewports. Assert no user-visible `ACK`, no document overflow, dialog scrollability and 44px mobile targets.

- [ ] **Step 7: Update control documentation for scenes 13~16**

In `docs/menus/control.md`, record corrected manual/command/readiness/group surfaces and the display-copy rule. Keep protocol-level ACK descriptions in technical implementation sections because those are developer documentation, and state explicitly that only user-visible copy changed. Preserve HIL limitations.

- [ ] **Step 8: Run GREEN and manual-control regression**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/control/ControlView.test.tsx src/features/control/FixtureGroupDialog.test.tsx src/features/control/active-command-store.test.ts
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-manual-control.spec.ts e2e/monitoring-control-flow.spec.ts --project=chromium
pnpm --filter @led-control/web typecheck
git diff --check
```

Expected: command payload/lock/recovery tests and group CRUD/resync tests pass; all rendered command messages use plain Korean.

- [ ] **Step 9: Review, synchronize status, and commit Task 5**

```bash
git add apps/web/src/features/control/ControlView.tsx apps/web/src/features/control/ControlView.test.tsx apps/web/src/features/control/ControlTargetPicker.tsx apps/web/src/features/control/FixtureGroupDialog.tsx apps/web/src/features/control/FixtureGroupDialog.test.tsx apps/web/src/components/ConfirmDialog.tsx apps/web/src/styles.css apps/web/e2e/calm-operations-manual-control.spec.ts apps/web/e2e/monitoring-control-flow.spec.ts docs/menus/control.md docs/project-status.md docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md
git commit -m "feat(web): apply corrected manual control surfaces"
```

---

### Task 6: Schedule and vehicle-event list, editor, and feedback states

**Scenes:** 17, 18, 19, 20, 21

**Files:**
- Create: `apps/web/e2e/calm-operations-automation.spec.ts`
- Modify: `apps/web/src/features/control/automation/ControlModeTabs.tsx`
- Modify: `apps/web/src/features/control/automation/ScheduleControlPanel.tsx`
- Modify: `apps/web/src/features/control/automation/ScheduleControlPanel.test.tsx`
- Modify: `apps/web/src/features/control/automation/ScheduleDialog.tsx`
- Modify: `apps/web/src/features/control/automation/VehicleEventControlPanel.tsx`
- Modify: `apps/web/src/features/control/automation/VehicleEventControlPanel.test.tsx`
- Modify: `apps/web/src/features/control/automation/VehicleEventDialog.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/control.md`
- Orchestrator update: `docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md`
- Orchestrator update: `docs/project-status.md`

**Interfaces:**
- Consumes: `Button`, `Card`, `PageHeader`, `StatusBadge`, `FeedbackState`, existing ARIA tab interface
- Preserves: `ControlPageMode = "manual" | "schedule" | "event"`, URL query and roving focus
- Preserves: schedule/event query keys, bounded pagination, polling, mutation-level auth/cache callbacks and scope generation
- Preserves: all form types and `validateScheduleForm`/vehicle-event validation

- [ ] **Step 1: Write failing schedule and event visual-state tests**

Use the exact test names `스케줄 목록은 적용 상태를 공통 badge로 구분한다`, `스케줄 dialog는 네 입력 section과 validation focus를 유지한다`, and `차량 이벤트 목록은 polling 실패에도 기존 행과 retry를 유지한다`.

Keep all current API, `401`, pagination and validation assertions. Add:

```tsx
expect(screen.getByRole("table", { name: "스케줄 목록" })).toBeInTheDocument();
expect(screen.getByText("적용됨").closest(".ui-status-badge")).toHaveAttribute("data-tone", "success");
expect(screen.getByText("적용 대기").closest(".ui-status-badge")).toHaveAttribute("data-tone", "warning");
expect(screen.getByText("적용 실패").closest(".ui-status-badge")).toHaveAttribute("data-tone", "danger");
```

Add empty-list action, delete confirmation, rejected sync retry, schedule section headings (`운영 기간과 시간`, `반복`, `밝기`, `제어 대상`) and event section headings (`감지 센서`, `제어 조명`, `행동`) to their existing tests.

- [ ] **Step 2: Run automation tests and confirm RED**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/control/automation/ScheduleControlPanel.test.tsx src/features/control/automation/VehicleEventControlPanel.test.tsx src/features/control/automation/schedule-form.test.ts src/features/control/automation/vehicle-event-form.test.ts
```

Expected: common status badge and named editor section assertions fail; API/form tests continue to compile.

- [ ] **Step 3: Apply the corrected list and state surfaces**

Keep tables semantic and give them `aria-label`. Use common badges for enabled/disabled and `PENDING|APPLIED|REJECTED`, common buttons for row actions, `FeedbackState` for loading/error/empty/background warnings, and `ConfirmDialog` for delete. Preserve current rows while background polling fails.

Keep sync-status conversion local and exhaustive:

```tsx
function SyncBadge({ status }: { status: ScheduleResponse["syncStatus"] }) {
  if (status === "APPLIED") return <StatusBadge tone="success" icon={CircleCheck}>적용됨</StatusBadge>;
  if (status === "REJECTED") return <StatusBadge tone="danger" icon={TriangleAlert}>적용 실패</StatusBadge>;
  return <StatusBadge tone="warning" icon={Clock3}>적용 대기</StatusBadge>;
}
```

On narrow viewports, keep the same table DOM in an `.automation-table-wrap` scroll container or expose each row as a CSS grid without hiding cells. Do not duplicate action controls into separate mobile state.

- [ ] **Step 4: Apply corrected schedule and event editor sections**

Reorder only JSX containers around existing controlled inputs. Keep input refs, `aria-invalid`, `aria-errormessage`, validation focus, submit payload, Escape/backdrop close, and return focus unchanged. Use the section order asserted in Step 1 and a sticky/mobile-safe action footer.

Use explicit fieldset boundaries without changing the input bindings:

```tsx
<form className="schedule-form" onSubmit={submit} noValidate>
  <fieldset className="schedule-form-section"><legend>운영 기간과 시간</legend>{periodFields}</fieldset>
  <fieldset className="schedule-form-section"><legend>반복</legend>{recurrenceFields}</fieldset>
  <fieldset className="schedule-form-section"><legend>밝기</legend>{brightnessFields}</fieldset>
  <fieldset className="schedule-form-section schedule-target-section"><legend>제어 대상</legend>{targetFields}</fieldset>
  <footer className="schedule-dialog-actions">{formActions}</footer>
</form>
```

Here `periodFields`, `recurrenceFields`, `brightnessFields`, `targetFields`, and `formActions` are the current JSX fragments extracted without changing their controlled props; define each constant immediately above the return in the same component.

Do not implement prototype-only holiday exception CRUD. Existing overlap/period validation is shown inside the feedback section.

- [ ] **Step 5: Add automation four-viewport coverage**

Use current schedule/event route fixtures and open both add dialogs at 1440/1024/390/320. Assert list columns remain reachable, enabled/disabled/sync/recent-result values are visible, empty/error/retry states have real actions, dialogs remain within viewport, all scrollable controls meet touch targets, and document overflow is absent.

- [ ] **Step 6: Update control documentation for scenes 17~21**

Add the corrected table/dialog/state hierarchy and four-viewport evidence to `docs/menus/control.md`. Keep existing API/Gateway offline automation and sensor HIL limitations exactly distinguished.

- [ ] **Step 7: Run GREEN and automation regression**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/control/automation/ScheduleControlPanel.test.tsx src/features/control/automation/VehicleEventControlPanel.test.tsx src/features/control/automation/automation-contracts.test.ts src/features/control/automation/schedule-form.test.ts src/features/control/automation/vehicle-event-form.test.ts
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-automation.spec.ts e2e/automation-control-flow.spec.ts --project=chromium
pnpm --filter @led-control/web test:bundle-audit
pnpm --filter @led-control/web typecheck
git diff --check
```

Expected: CRUD, auth expiry, pagination, polling, validation, focus and bundle boundary tests pass with corrected UI.

- [ ] **Step 8: Review, synchronize status, and commit Task 6**

```bash
git add apps/web/src/features/control/automation apps/web/src/styles.css apps/web/e2e/calm-operations-automation.spec.ts docs/menus/control.md docs/project-status.md docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md
git commit -m "feat(web): apply corrected automation surfaces"
```

---

### Task 7: Energy report and independent data states

**Scenes:** 22, 23

**Files:**
- Modify: `apps/web/src/features/statistics/StatisticsView.tsx`
- Modify: `apps/web/src/features/statistics/StatisticsView.test.tsx`
- Modify: `apps/web/e2e/statistics-flow.spec.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/statistics.md`
- Orchestrator update: `docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md`
- Orchestrator update: `docs/project-status.md`

**Interfaces:**
- Consumes: `Button`, `Card`, `MetricCard`, `PageHeader`, `StatusBadge`, `FeedbackState`
- Preserves: `useEnergySummary`, `useEnergySeries`, inclusive timezone ranges and query keys
- Preserves: Recharts data, null gaps, tooltip, screen-reader list, cost/baseline/savings calculations
- Produces no new statistic or API field

- [ ] **Step 1: Write failing report-layout and independent-state tests**

Use the exact test names `에너지 리포트는 metric, chart, 비용 비교 영역을 구분한다`, `series 오류는 summary와 비용을 유지하고 chart만 재시도한다`, and `선택 기간 no-data는 metric을 유지하고 chart만 비운다`.

Extend current tests with named regions and ordering:

```tsx
expect(screen.getByRole("heading", { name: "에너지 리포트" })).toBeInTheDocument();
expect(screen.getByRole("group", { name: "오늘 전력 사용량" })).toBeInTheDocument();
expect(screen.getByRole("region", { name: "상태 기반 추정 사용량" })).toBeInTheDocument();
expect(screen.getByRole("complementary", { name: "비용 비교" })).toBeInTheDocument();
```

For no-data assert no metric groups. For selected-period no-data assert metrics remain and only the chart region contains the empty message. For series error assert metrics/cost remain and the chart region contains the retry button.

- [ ] **Step 2: Run statistics tests and confirm RED**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/statistics/StatisticsView.test.tsx src/api/energy.test.tsx
```

Expected: named chart/cost region assertions fail while range/query contract tests pass.

- [ ] **Step 3: Apply corrected report structure**

Keep all calculation variables and query branches. Add exact region labels, use a 3-card metric strip, place chart and cost `Card` in a `minmax(0, 1fr) 330px` grid above 1120px, and stack below it. Use `StatusBadge` for available/partial and `FeedbackState` inside only the failing area.

Use named semantic surfaces around the existing chart and calculated values:

```tsx
<section className="statistics-chart-panel ui-card" aria-label="상태 기반 추정 사용량">
  {seriesQuery.error ? <FeedbackState tone="danger" icon={TriangleAlert} title="사용량 추이를 불러오지 못했습니다." action={retrySeriesButton} /> : chart}
</section>
<aside className="statistics-cost-panel ui-card" aria-label="비용 비교">
  <dl className="statistics-cost-list">{costRows}</dl>
</aside>
```

Define `retrySeriesButton`, `chart`, and `costRows` from the current JSX branches immediately before the return; do not recompute query data.

Keep `aria-pressed` on daily/monthly buttons and the existing chart `role="img"` description. Do not connect across null points or turn no-data into zero.

- [ ] **Step 4: Strengthen all four viewport assertions**

Update `statistics-flow.spec.ts` to assert metric columns 3/3/2/1 at 1440/1024/390/320, chart/cost split only above 1120px, readable axis/segmented actions, no document overflow and 44px mobile targets. Preserve existing success/no-data/summary retry/series retry flows.

- [ ] **Step 5: Update statistics documentation**

Update `docs/menus/statistics.md` with scene 22~23 hierarchy, independent summary/series/no-data behavior, four viewport validation and unchanged state-based-estimate limitation. Set the basis date to `2026-09-02` and list modified files.

- [ ] **Step 6: Run GREEN and statistics regression**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/statistics/StatisticsView.test.tsx src/api/energy.test.tsx
pnpm --filter @led-control/web exec playwright test e2e/statistics-flow.spec.ts --project=chromium
pnpm --filter @led-control/web typecheck
git diff --check
```

Expected: summary/series separation, null gaps, timezone ranges and every viewport assertion pass.

- [ ] **Step 7: Review, synchronize status, and commit Task 7**

```bash
git add apps/web/src/features/statistics apps/web/e2e/statistics-flow.spec.ts apps/web/src/styles.css docs/menus/statistics.md docs/project-status.md docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md
git commit -m "feat(web): apply corrected energy report surfaces"
```

---

### Task 8: Settings overview, navigation, floor editor, security, and final convergence

**Scenes:** 24, 25, 26

**Files:**
- Modify: `apps/web/src/features/shells/SettingsNavigationItem.tsx`
- Modify: `apps/web/src/features/shells/SettingsNavigationItem.test.tsx`
- Modify: `apps/web/src/features/settings/settings-sections.ts`
- Modify: `apps/web/src/features/settings/settings-sections.test.ts`
- Modify: `apps/web/src/features/settings/SettingsShell.tsx`
- Modify: `apps/web/src/features/settings/SettingsShell.test.tsx`
- Modify: `apps/web/src/features/settings/SettingsView.tsx`
- Modify: `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.tsx`
- Modify: `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.test.tsx`
- Modify: `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`
- Modify: `apps/web/src/features/settings/floor-plans/FloorEditorRoute.test.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`
- Modify: `apps/web/src/features/floor-editor/EditorPropertiesPanel.tsx`
- Modify: `apps/web/src/features/settings/security/PasswordSettingsView.tsx`
- Modify: `apps/web/src/features/settings/security/PasswordSettingsView.test.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/e2e/settings-floor-editor.spec.ts`
- Modify: `apps/web/e2e/floor-editor-layout.spec.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/settings.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md`

**Interfaces:**
- Consumes: common UI public exports and existing `settingsSectionsFor(role)`
- Preserves: `/settings`, `/settings/floor-plans`, `/settings/floor-plans/:floorId/edit`, `/settings/security`
- Preserves: query string/hash, role filtering, hover/focus/touch disclosure, dirty confirm/cancel and browser history sentinel
- Preserves: lease/fence, atomic save, `409`, reload, revision restore, asset upload lock and password API semantics
- Produces: four real overview cards with route-backed actions only

- [ ] **Step 1: Write failing settings overview and navigation tests**

Use the exact test names `설정 개요는 실제 데이터와 route action으로 네 카드를 표시한다`, `설정 메뉴는 siteId와 현재 항목을 보존한다`, and `모바일 설정 메뉴는 scrim과 bottom sheet focus 계약을 유지한다`.

In `SettingsShell.test.tsx`/`App.test.tsx`, assert the overview has groups `현장 정보`, `층·도면`, `Gateway 상태`, and admin-only `계정·보안`, each route-backed action preserves `siteId`. Extend disclosure tests:

```tsx
expect(screen.getByRole("navigation", { name: "설정 메뉴" })).toBeInTheDocument();
expect(screen.getByRole("link", { name: "설정 개요" })).toHaveAttribute("href", "/settings?siteId=site-1");
expect(screen.getByRole("link", { name: "도면 관리" })).toHaveAttribute("href", "/settings/floor-plans?siteId=site-1");
expect(screen.getByRole("link", { name: "비밀번호 변경" })).toHaveAttribute("href", "/settings/security?siteId=site-1");
```

Keep existing hover/focus/Tab/Shift+Tab/Escape/outside click/coarse-pointer/dirty cancel/confirm tests.

- [ ] **Step 2: Write failing floor/security state tests**

Use the exact test names `도면 편집기는 lease 상실 시 읽기 전용 feedback을 표시한다`, `409 충돌은 최신 버전 다시 불러오기만 제공한다`, and `비밀번호 변경은 기존 8자 규칙과 성공 상태를 유지한다`.

Add admin/viewer floor-list assertions, editor named regions, lease read-only, conflict/reload, revision restore and password validation/success assertions. Explicitly retain the current password rule:

```tsx
await user.type(screen.getByLabelText("현재 비밀번호"), "current-password");
await user.type(screen.getByLabelText("새 비밀번호", { selector: "input" }), "1234567");
await user.type(screen.getByLabelText("새 비밀번호 확인"), "1234567");
await user.click(screen.getByRole("button", { name: "비밀번호 변경" }));
expect(screen.getByRole("alert")).toHaveTextContent("새 비밀번호는 8자 이상이어야 합니다.");
expect(screen.queryByText(/10자|특수문자/)).not.toBeInTheDocument();
```

Drive the private validator through the form; do not export it for the test. Do not change success navigation/logout behavior.

- [ ] **Step 3: Run focused settings tests and confirm RED**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/shells/SettingsNavigationItem.test.tsx src/features/settings/SettingsShell.test.tsx src/features/settings/floor-plans/FloorPlanSettingsView.test.tsx src/features/settings/floor-plans/FloorEditorRoute.test.tsx src/features/floor-editor/FloorEditorView.test.tsx src/features/settings/security/PasswordSettingsView.test.tsx src/App.test.tsx
```

Expected: four-card overview, corrected floor/editor landmarks and security feedback assertions fail; dirty guard and API tests still compile.

- [ ] **Step 4: Implement the settings overview and disclosure visuals**

Build four cards only from existing dashboard/role/route data. Add `useLocation`/`Link`, derive the floor-plan count from the already loaded dashboard, and preserve the current query string explicitly:

```tsx
const location = useLocation();
const registeredPlanCount = data.floors.filter((floor) => floor.floorPlan !== null).length;

<div className="settings-overview-grid">
  <Card className="settings-summary-card" role="group" aria-label="현장 정보">
    <div className="settings-card-heading">
      <Building2 size={20} aria-hidden="true" />
      <div><span>현장 정보</span><strong>{data.site.name}</strong></div>
    </div>
    <dl className="settings-compact-rows">
      <div><dt>고객사</dt><dd>{data.site.customerName}</dd></div>
      <div><dt>주소</dt><dd>{data.site.address ?? "등록 없음"}</dd></div>
      <div><dt>시간대</dt><dd>{data.site.timeZone}</dd></div>
    </dl>
  </Card>
  <Card className="settings-summary-card" role="group" aria-label="층·도면">
    <div className="settings-card-heading">
      <Layers3 size={20} aria-hidden="true" />
      <div><span>층·도면</span><strong>{data.floors.length}개 층</strong></div>
    </div>
    <p>도면 등록 {registeredPlanCount}개</p>
    <Link className="ui-button ui-button-secondary" to={{ pathname: "/settings/floor-plans", search: location.search }}>
      도면 관리 열기
    </Link>
  </Card>
  <Card className="settings-summary-card" role="group" aria-label="Gateway 상태">
    <div className="settings-card-heading">
      <Network size={20} aria-hidden="true" />
      <div><span>Gateway 상태</span><strong>{gateway?.name ?? "미등록"}</strong></div>
    </div>
    {gateway ? (
      <div className="settings-gateway-summary">
        <StatusBadge tone={gateway.connectionStatus === "online" ? "success" : "neutral"} icon={gateway.connectionStatus === "online" ? CircleCheck : WifiOff}>
          {statusLabel(gateway.connectionStatus)}
        </StatusBadge>
        <span>시리얼 {gateway.serialNumber}</span>
      </div>
    ) : <StatusBadge tone="neutral" icon={CircleDashed}>미등록</StatusBadge>}
  </Card>
  {userRole === "admin" ? (
    <Card className="settings-summary-card" role="group" aria-label="계정·보안">
      <div className="settings-card-heading">
        <ShieldCheck size={20} aria-hidden="true" />
        <div><span>계정·보안</span><strong>관리자 비밀번호</strong></div>
      </div>
      <Link className="ui-button ui-button-secondary" to={{ pathname: "/settings/security", search: location.search }}>
        비밀번호 변경 열기
      </Link>
    </Card>
  ) : null}
</div>
```

Do not show firmware/session/last-change values not returned by current APIs. Keep `SettingsNavigationItem` event handlers and navigation decisions; only apply corrected popover/bottom-sheet shell with scrim, grabber and title. Preserve one `aria-current` item.

- [ ] **Step 5: Implement floor list/editor and security surfaces**

Use common `Card`, `Button`, `StatusBadge`, `FeedbackState` around existing state. Floor list exposes edit/register only for admin and a neutral read-only badge for viewer. Editor remains tool rail + canvas + side panel, but lease/read-only/conflict/version feedback follows scene 26 hierarchy. Do not move or rewrite save/restore/guard logic.

Password form uses current three fields and existing `validatePasswords`; render validation as danger feedback and success as success feedback. It must not claim a forced logout or navigate unless the existing API/session behavior already does so.

Replace only the current inline feedback markup at the existing decision points; keep each callback and state source unchanged. In `FloorEditorRoute.tsx`, render lease feedback from `activeLease`:

```tsx
{!activeLease.editable ? (
  <FeedbackState
    tone="warning"
    icon={LockKeyhole}
    title={activeLease.holderName ? `${activeLease.holderName}님이 이 도면을 편집 중입니다.` : "편집 권한을 확보하지 못했습니다."}
    description="현재 버전은 읽기 전용으로 확인할 수 있습니다."
  />
) : null}
```

In `FloorEditorView.tsx`, retain the existing `saveStatus` and `onReload` names:

```tsx
{saveStatus === "conflict" ? (
  <FeedbackState
    tone="danger"
    icon={TriangleAlert}
    title="최신 도면과 변경사항이 충돌했습니다."
    description="최신 버전을 다시 불러온 뒤 변경사항을 확인하세요."
    action={<Button variant="secondary" onClick={() => void onReload()}>최신 버전 다시 불러오기</Button>}
  />
) : null}
```

In `PasswordSettingsView.tsx`, retain `errorMessage`/`successMessage` and the current submit flow:

```tsx
{errorMessage ? (
  <FeedbackState tone="danger" icon={TriangleAlert} title="비밀번호를 변경하지 못했습니다." description={errorMessage} />
) : null}
{successMessage ? (
  <FeedbackState tone="success" icon={CircleCheck} title={successMessage} />
) : null}
```

- [ ] **Step 6: Complete four-viewport settings and editor coverage**

Update both Playwright specs to run 1440/1024/390/320. Assert desktop popover placement, mobile scrim/grabber/title sheet, role-specific links, site query preservation, floor admin/viewer actions, editor canvas/toolbar/properties/version regions, dialog/sheet scrollability, no overflow and 44px mobile targets. Exercise dirty cancel and confirm through real navigation events.

- [ ] **Step 7: Update settings and project status documentation**

Update `docs/menus/settings.md` under every required section with scenes 24~26 and the already completed scene 04~09 entry. Record real route-backed cards, role filtering, dirty guard, lease/conflict/version restore, current password semantics and HIL limitation.

Update `docs/project-status.md` to state login/operator/setup and scene 01~26 are complete only after all commands in Step 8 pass. State that API/DB/MQTT/firmware did not change, automatic browser checks are software evidence, and manual in-app Browser/HIL status is reported exactly as executed.

- [ ] **Step 8: Run focused GREEN, full Web regression, and build**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/shells/SettingsNavigationItem.test.tsx src/features/settings/SettingsShell.test.tsx src/features/settings/floor-plans/FloorPlanSettingsView.test.tsx src/features/settings/floor-plans/FloorEditorRoute.test.tsx src/features/floor-editor/FloorEditorView.test.tsx src/features/settings/security/PasswordSettingsView.test.tsx src/App.test.tsx
pnpm --filter @led-control/web exec playwright test e2e/settings-floor-editor.spec.ts e2e/floor-editor-layout.spec.ts --project=chromium
pnpm --filter @led-control/web test
pnpm --filter @led-control/web typecheck
pnpm --filter @led-control/web build
```

Expected: all commands exit 0; build may repeat the existing chunk-size warning but must not introduce a build error.

- [ ] **Step 9: Run final whole-UI Chromium and copy/overflow audits**

Run:

```bash
pnpm --filter @led-control/web exec playwright test --project=chromium
rg -n "ACK" apps/web/src --glob '!*.test.*'
git diff --check
git status --short
```

Expected: Playwright exits 0 with only pre-existing environment-gated skips; `rg` finds no user-visible `ACK` in production Web source; diff check is clean; status contains only Task 8 plus orchestrator documentation changes.

- [ ] **Step 10: Self-review scene coverage and functional boundary**

Review the final diff against the spec and confirm:

```text
01-03 Task 2  | 04-09 Task 3 | 10-12 Task 4 | 13-16 Task 5
17-21 Task 6 | 22-23 Task 7 | 24-26 Task 8 | common Task 1
```

Confirm there is no change under `apps/web/src/api`, `packages/shared`, `apps/api`, `apps/gateway`, `apps/esp32-h2-firmware`, Prisma/migrations, route paths, query keys, active-command store/session, editor store/history, or auth permission logic. Any such diff blocks completion until reverted or separately approved.

- [ ] **Step 11: Commit Task 8 and final convergence**

```bash
git add apps/web/src/features/shells/SettingsNavigationItem.tsx apps/web/src/features/shells/SettingsNavigationItem.test.tsx apps/web/src/features/settings apps/web/src/features/floor-editor apps/web/src/App.test.tsx apps/web/src/styles.css apps/web/e2e/settings-floor-editor.spec.ts apps/web/e2e/floor-editor-layout.spec.ts docs/menus/settings.md docs/project-status.md docs/superpowers/plans/2026-09-02-calm-operations-a-implementation.md
git commit -m "feat(web): complete corrected calm operations UI"
```

---

## Final acceptance checklist

- [ ] Scene 01 로그인에 세 운영 요약이 없고 실제 login flow가 유지된다.
- [ ] Scene 02~03 operator 목록·상태·dialog와 focus/mutation 계약이 유지된다.
- [ ] Scene 04~09 setup/claim/registration/recovery와 역할·polling·복구가 유지된다.
- [ ] Scene 10~12 monitoring desktop/mobile/exception과 1,000 fixture 경계가 유지된다.
- [ ] Scene 13~16 manual command/readiness/group와 command recovery가 유지된다.
- [ ] Scene 17~21 schedule/event CRUD·pagination·polling·validation·viewer가 유지된다.
- [ ] Scene 22~23 summary/series/no-data/cost semantics가 유지된다.
- [ ] Scene 24~26 settings/floor/security와 dirty/lease/conflict/version/password semantics가 유지된다.
- [ ] production Web source의 일반 사용자-visible copy에 `ACK`가 없다.
- [ ] 네 viewport에서 document overflow, 겹침, 잘린 action이 없다.
- [ ] `docs/menus/monitoring.md`, `control.md`, `statistics.md`, `settings.md`와 `docs/project-status.md`가 실제 결과와 일치한다.
- [ ] Web unit, typecheck, build, 전체 Chromium이 통과하고 software/HIL 증거가 구분된다.

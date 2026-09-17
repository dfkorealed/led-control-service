# Map-First Control Target Selection Implementation Plan

## Execution status (2026-09-17)

- [x] Tasks 1–10 implemented and reviewed task-by-task.
- [x] Final whole-branch review completed; findings 1–13 received one test-first fix wave in `38b8b72e`.
- [x] One scoped re-review completed; original findings 1–13 are resolved and the manual-selection-to-group shortcut is documented as deferred.
- [x] Follow-up fix: the group editor preserves a usable selector on 390×660 and 320×740 screens, while a separately bounded change list keeps 100-member edits from collapsing the desktop map. Browser regressions cover marker selection in both cases.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace list-first target picking in manual, schedule, vehicle-event, and fixture-group control flows with one responsive map-first selector that supports direct selection, saved groups, floor targets, mobile two-finger pinch zoom, and accessible list fallback.

**Architecture:** Extract monitoring map pan/zoom/fit into a shared `FloorMapViewport`, extend `FloorScene` with an explicit multi-selection contract, and place control-specific policy and UI in a focused `target-selection` feature folder. Existing command and automation APIs remain unchanged: UI selections resolve to stable fixture snapshots before schedule/event submission, while manual commands preserve their current target contract.

**Tech Stack:** React 18, TypeScript, TanStack Query, React Aria Components, Tailwind CSS v4 semantic tokens, Vitest + Testing Library, Playwright, React Konva.

**Spec:** `docs/superpowers/specs/2026-09-16-control-map-target-selection-design.md`

## Global Constraints

- Do not change Prisma schema, REST routes, MQTT contracts, BLE Mesh behavior, or firmware.
- Keep direct fixture selection capped at 1,000 fixtures.
- Keep saved fixture groups limited to 1–100 unique fixtures from one floor and one gateway.
- Until command fan-out exists, every executable selection must resolve to one gateway; the first direct fixture locks the selectable gateway.
- Schedule and vehicle-event group/floor choices save the currently resolved fixture IDs; later group membership changes do not mutate existing rules.
- Vehicle-event source selection remains fixture-only and must use `isVehicleEventSource` eligibility.
- Mobile `move`, `select`, and `area` modes must all allow two-pointer pinch zoom anchored at the pointer midpoint.
- Every coarse-pointer action and fixture marker hit target must be at least 44×44px; editable mobile fields must render at least 16px text.
- Use only approved semantic tokens, spacing values, typography, `compact=47.5rem`, and `tablet=64rem`; do not add arbitrary Tailwind values, literal colors, or a page-specific breakpoint.
- Reuse project UI wrappers (`Button`, `IconButton`, `ModalDialog`, `SelectBox`, `SearchField`, `Slider`, `TextField`, `SidePanel`) rather than styling native replacements.
- PC control pages must not create document-level vertical or horizontal scroll; map, list, history, and detail regions own their internal overflow.
- Preserve existing command lock, retry, verification, authorization, schedule overlap, automation single-gateway, and Mesh readiness behavior.
- Update `docs/menus/control.md`; update `docs/menus/monitoring.md` because monitoring consumes the shared viewport/scene contract.

---

## File Structure

### Shared floor map

- `apps/web/src/features/floor-map/map-gestures.ts`: pure pointer geometry, zoom clamp, midpoint anchor, and rectangle normalization.
- `apps/web/src/features/floor-map/map-gestures.test.ts`: pure gesture math coverage.
- `apps/web/src/features/floor-map/FloorMapViewport.tsx`: shared measured viewport, pan, wheel zoom, pinch zoom, fit, and area-selection shell.
- `apps/web/src/features/floor-map/FloorMapViewport.test.tsx`: pointer lifecycle, pinch precedence, click suppression, and resize tests.
- `apps/web/src/features/floor-map/FloorScene.tsx`: floor rendering plus explicit single/multi fixture marker state.
- `apps/web/src/features/floor-map/FloorScene.test.tsx`: marker selection, disabled state, hit target, and accessibility tests.

### Control selection domain and UI

- `apps/web/src/features/control/control-selection.ts`: `ControlSelection`, target conversion, resolver, stable ID helpers, limits, and gateway policy.
- `apps/web/src/features/control/control-selection.test.ts`: resolver and policy tests.
- `apps/web/src/features/control/target-selection/SpatialTargetSelector.tsx`: composed map-first selector and map snapshot state.
- `apps/web/src/features/control/target-selection/TargetSelectionToolbar.tsx`: mode, floor, gesture, search, and list actions.
- `apps/web/src/features/control/target-selection/FixtureSelectionDrawer.tsx`: accessible search/filter/list fallback and unplaced fixtures.
- `apps/web/src/features/control/target-selection/SelectionSummaryPanel.tsx`: selected/resolved/blocked summary shared by desktop panel and mobile sheet.
- `apps/web/src/features/control/target-selection/SpatialTargetSelector.test.tsx`: map/list synchronization, modes, mobile sheet, and missing-map behavior.
- `apps/web/src/features/control/target-selection/FixtureGroupMapEditor.tsx`: group name, boundary lock, map selection, and full-replacement payload composition.
- `apps/web/src/features/control/target-selection/FixtureGroupMapEditor.test.tsx`: 1–100, floor/gateway, edit diff, and configuring copy tests.

### Flow integrations

- `apps/web/src/features/monitoring/FloorMap.tsx` and tests: thin monitoring adapter over shared viewport and scene.
- `apps/web/src/features/control/ControlTargetPicker.tsx`: temporary compatibility wrapper, removed after all imports migrate.
- `apps/web/src/features/control/ControlView.tsx` and tests: manual map layout, responsive summary, and history disclosure.
- `apps/web/src/features/control/automation/ScheduleDialog.tsx` plus new `ScheduleDialog.test.tsx`: full-screen responsive selector step.
- `apps/web/src/features/control/automation/VehicleEventDialog.tsx` plus new `VehicleEventDialog.test.tsx`: map source/target steps and resolved target fixture IDs.
- `apps/web/src/features/control/FixtureGroupDialog.tsx` and tests: group list/management shell using `FixtureGroupMapEditor` for create/edit.

### Browser regression and docs

- `apps/web/e2e/control-map-target-selection.spec.ts`: map-first end-to-end browser contract.
- `apps/web/e2e/layout-assertions.spec.ts`: 1440/1024/390/320 overflow, safe-area, and target-size assertions.
- `docs/menus/control.md`: implemented workflows, snapshot semantics, mobile pinch, and hardware limits.
- `docs/menus/monitoring.md`: shared viewport/scene reuse and monitoring single-selection regression.

---

### Task 1: Extract and test the control selection domain

**Files:**
- Create: `apps/web/src/features/control/control-selection.ts`
- Create: `apps/web/src/features/control/control-selection.test.ts`
- Modify: `apps/web/src/features/control/ControlTargetPicker.tsx`
- Modify: `apps/web/src/features/control/automation/schedule-form.ts`
- Modify: `apps/web/src/features/control/automation/schedule-form.test.ts`

**Interfaces:**
- Produces: `ControlMode`, `ControlSelection`, `MAX_FIXTURE_SELECTION`, `ResolvedControlSelection`, `resolveControlSelection`, `toggleFixtureSelection`, `controlSelectionToDimmingTarget`.
- Consumes: `Dashboard`, `DashboardFixture`, `DimmingTarget`, `floorMeshReadiness`, and `fixtureGroupReadiness`.

- [ ] **Step 1: Write resolver tests for stable identity, limits, and gateway boundaries**

```ts
import { describe, expect, it } from "vitest";
import {
  MAX_FIXTURE_SELECTION,
  resolveControlSelection,
  toggleFixtureSelection
} from "./control-selection";

it("resolves fixture ids in stable order and rejects a second gateway", () => {
  const result = resolveControlSelection(dashboard, {
    mode: "fixtures",
    fixtureIds: [fixtureB, fixtureA, fixtureB]
  });

  expect(result.fixtureIds).toEqual([fixtureA, fixtureB]);
  expect(result.gatewayIds).toEqual([gatewayA, gatewayB]);
  expect(result.available).toBe(false);
  expect(result.unavailableReason).toBe("한 번의 제어 대상은 같은 게이트웨이에 연결되어야 합니다.");
});

it("does not add fixture 1001", () => {
  const current = Array.from({ length: MAX_FIXTURE_SELECTION }, (_, index) => `fixture-${index}`);
  expect(toggleFixtureSelection(current, "fixture-overflow")).toEqual({
    fixtureIds: current,
    limitReached: true
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --filter @led-control/web test -- src/features/control/control-selection.test.ts`

Expected: FAIL because `control-selection.ts` and exported functions do not exist.

- [ ] **Step 3: Implement the domain types and pure resolver**

```ts
export const MAX_FIXTURE_SELECTION = 1_000;

export type ControlMode = "fixtures" | "floor" | "group";
export type ControlSelection =
  | { mode: "fixtures"; fixtureIds: string[] }
  | { mode: "floor"; floorId: string }
  | { mode: "group"; groupId: string };

export interface ResolvedControlSelection {
  selection: ControlSelection;
  fixtureIds: string[];
  fixtures: DashboardFixture[];
  gatewayIds: string[];
  blockedFixtureIds: string[];
  available: boolean;
  unavailableReason: string | null;
}

export function toggleFixtureSelection(current: readonly string[], fixtureId: string) {
  const selected = new Set(current);
  if (selected.delete(fixtureId)) return { fixtureIds: [...selected].sort(), limitReached: false };
  if (selected.size >= MAX_FIXTURE_SELECTION) return { fixtureIds: [...selected].sort(), limitReached: true };
  selected.add(fixtureId);
  return { fixtureIds: [...selected].sort(), limitReached: false };
}
```

Implement `resolveControlSelection` without React state. Resolve current dashboard membership, deduplicate and sort IDs, derive gateway IDs, blocked fixtures, floor/group readiness, and one precise Korean unavailability reason. Do not silently discard missing IDs; report them as unavailable.

- [ ] **Step 4: Move existing exports to the domain file and update imports**

```ts
// ControlTargetPicker.tsx
import {
  MAX_FIXTURE_SELECTION,
  type ControlMode,
  type ControlSelection,
  toggleFixtureSelection
} from "./control-selection";

export type { ControlMode, ControlSelection } from "./control-selection";
export { controlSelectionToDimmingTarget } from "./control-selection";
```

Update `schedule-form.ts` to import `ControlSelection` and `controlSelectionToDimmingTarget` from `../control-selection`. Keep the compatibility exports until Task 8 removes the old picker.

- [ ] **Step 5: Run focused and dependent tests**

Run: `pnpm --filter @led-control/web test -- src/features/control/control-selection.test.ts src/features/control/automation/schedule-form.test.ts src/features/control/ControlView.test.tsx`

Expected: PASS with the existing schedule payload unchanged.

- [ ] **Step 6: Commit the domain boundary**

```bash
git add apps/web/src/features/control/control-selection.ts apps/web/src/features/control/control-selection.test.ts apps/web/src/features/control/ControlTargetPicker.tsx apps/web/src/features/control/automation/schedule-form.ts apps/web/src/features/control/automation/schedule-form.test.ts
git commit -m "refactor: extract control target selection domain"
```

---

### Task 2: Implement shared viewport gesture math and two-finger pinch zoom

**Files:**
- Create: `apps/web/src/features/floor-map/map-gestures.ts`
- Create: `apps/web/src/features/floor-map/map-gestures.test.ts`
- Create: `apps/web/src/features/floor-map/FloorMapViewport.tsx`
- Create: `apps/web/src/features/floor-map/FloorMapViewport.test.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.test.tsx`

**Interfaces:**
- Produces: `MapPoint`, `MapSelectionRect`, `MapInteractionMode`, `FloorMapViewport`, `pointerDistance`, `pointerMidpoint`, `clampMapZoom`, `anchoredScrollPosition`, `normalizeSelectionRect`.
- Consumes: `FloorMapSnapshot` and a scene child rendered inside the scaled map surface.

- [ ] **Step 1: Write pure gesture math tests**

```ts
it("zooms around the midpoint of two touch pointers", () => {
  const start = [{ x: 100, y: 100 }, { x: 200, y: 100 }] as const;
  const next = [{ x: 50, y: 100 }, { x: 250, y: 100 }] as const;
  expect(pointerDistance(...start)).toBe(100);
  expect(pointerDistance(...next)).toBe(200);
  expect(pointerMidpoint(...next)).toEqual({ x: 150, y: 100 });
  expect(clampMapZoom(1 * 200 / 100)).toBe(2);
});

it("keeps the content below the pinch midpoint anchored", () => {
  expect(anchoredScrollPosition({ scroll: 40, anchor: 150, fromZoom: 1, toZoom: 2 }))
    .toBe(230);
});
```

- [ ] **Step 2: Run the math test and verify it fails**

Run: `pnpm --filter @led-control/web test -- src/features/floor-map/map-gestures.test.ts`

Expected: FAIL because the gesture module does not exist.

- [ ] **Step 3: Implement pure geometry helpers**

```ts
export interface MapPoint { x: number; y: number }
export interface MapSelectionRect { left: number; top: number; right: number; bottom: number }
export type MapInteractionMode = "pan" | "select" | "area";

export function pointerDistance(left: MapPoint, right: MapPoint) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

export function pointerMidpoint(left: MapPoint, right: MapPoint): MapPoint {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

export function clampMapZoom(value: number) {
  return Math.round(Math.min(4, Math.max(0.1, value)) * 10) / 10;
}

export function anchoredScrollPosition(input: {
  scroll: number; anchor: number; fromZoom: number; toZoom: number;
}) {
  return ((input.scroll + input.anchor) / input.fromZoom) * input.toZoom - input.anchor;
}
```

Add `normalizeSelectionRect` to convert two map points into ordered bounds.

- [ ] **Step 4: Write viewport interaction tests before the component**

```ts
it("gives two-pointer pinch precedence over area selection and prevents a jump", () => {
  render(<ViewportHarness mode="area" />);
  const viewport = screen.getByRole("region", { name: "테스트 지도" });

  fireEvent.pointerDown(viewport, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
  fireEvent.pointerDown(viewport, { pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100 });
  fireEvent.pointerMove(viewport, { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100 });

  expect(viewport).toHaveAttribute("data-zoom", "2");
  expect(screen.queryByTestId("map-area-selection")).not.toBeInTheDocument();

  const scrollAfterPinch = viewport.scrollLeft;
  fireEvent.pointerUp(viewport, { pointerId: 2, pointerType: "touch" });
  fireEvent.pointerMove(viewport, { pointerId: 1, pointerType: "touch", clientX: 110, clientY: 100 });
  expect(viewport.scrollLeft).toBe(scrollAfterPinch);
});
```

Add these exact cases in the same file:

```ts
it.each(["pan", "select", "area"] as const)("supports pinch while mode is %s", (mode) => {
  render(<ViewportHarness mode={mode} />);
  performTwoPointerPinch(screen.getByRole("region", { name: "테스트 지도" }));
  expect(screen.getByRole("region", { name: "테스트 지도" })).toHaveAttribute("data-zoom", "2");
});

it("clamps wheel and button zoom to 0.1 through 4", () => {
  render(<ViewportHarness mode="pan" />);
  repeatZoomIn(50);
  expect(screen.getByRole("region", { name: "테스트 지도" })).toHaveAttribute("data-zoom", "4");
});

it("returns normalized map coordinates for area selection", () => {
  const onAreaSelect = vi.fn();
  render(<ViewportHarness mode="area" onAreaSelect={onAreaSelect} />);
  dragAreaFromBottomRightToTopLeft();
  expect(onAreaSelect).toHaveBeenCalledWith({ left: 100, top: 80, right: 300, bottom: 240 });
});
```

Include dedicated assertions that mouse pan changes scroll, fit resets zoom to `1`, pointer cancellation removes the selection rectangle, and the click immediately following a pinch does not select a marker.

- [ ] **Step 5: Implement `FloorMapViewport` with pointer tracking**

```ts
interface FloorMapViewportProps {
  snapshot: FloorMapSnapshot;
  ariaLabel: string;
  mode?: MapInteractionMode;
  children: ReactNode;
  onAreaSelect?: (rect: MapSelectionRect) => void;
  showControls?: boolean;
}

const activePointers = useRef(new Map<number, MapPoint>());
const pinch = useRef<null | {
  startDistance: number;
  startZoom: number;
  anchor: MapPoint;
  startScroll: MapPoint;
}>(null);
```

On the second active pointer, cancel pan/area state and create the pinch record. On move with two pointers, calculate distance ratio and midpoint-anchored scroll. On pointer up/cancel, clear the pinch and reset the remaining pointer origin; do not turn the remaining pointer into a continuing one-finger gesture. Preserve the existing native non-passive Ctrl/Cmd+wheel listener and `ResizeObserver` fit behavior.

- [ ] **Step 6: Convert monitoring `FloorMap` into a thin adapter**

```tsx
<FloorMapViewport snapshot={snapshot} ariaLabel="상하좌우로 이동하고 확대 축소할 수 있는 지도">
  <FloorScene
    snapshot={snapshot}
    fixtures={sceneFixtures}
    interactive={false}
    floorName={floor.name}
    selectedFixtureId={selectedFixtureId}
    onSelectFixture={onSelectFixture}
  />
</FloorMapViewport>
```

Keep the monitoring legend and copy in `FloorMap.tsx`; move only viewport geometry and zoom controls. Task 3 replaces the temporary legacy `selectedFixtureId` adapter with the explicit scene selection contract.

- [ ] **Step 7: Run viewport and monitoring tests**

Run: `pnpm --filter @led-control/web test -- src/features/floor-map/map-gestures.test.ts src/features/floor-map/FloorMapViewport.test.tsx src/features/monitoring/FloorMap.test.tsx`

Expected: PASS, including two-pointer pinch in every interaction mode.

- [ ] **Step 8: Commit shared map gestures**

```bash
git add apps/web/src/features/floor-map apps/web/src/features/monitoring/FloorMap.tsx apps/web/src/features/monitoring/FloorMap.test.tsx
git commit -m "feat: add shared floor map pinch viewport"
```

---

### Task 3: Extend floor scene markers for multi-selection and touch

**Files:**
- Modify: `apps/web/src/features/floor-map/FloorScene.tsx`
- Modify: `apps/web/src/features/floor-map/FloorScene.test.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.test.tsx`

**Interfaces:**
- Consumes: `FloorMapViewport` from Task 2.
- Produces: `FixtureSceneSelection` and the `FloorScene` `selection`/`onFixturePress` contract used by monitoring and control.

- [ ] **Step 1: Write marker contract tests**

```ts
it("renders multi-selected and disabled markers with 44px coarse hit targets", () => {
  render(
    <FloorScene
      snapshot={snapshot}
      fixtures={[fixtureA, fixtureB]}
      interactive={false}
      selection={{
        kind: "multiple",
        selectedFixtureIds: new Set([fixtureA.id]),
        disabledFixtureIds: new Set([fixtureB.id])
      }}
      coarsePointer
      onFixturePress={onFixturePress}
    />
  );

  expect(screen.getByRole("button", { name: /B1-L001.*선택됨/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: /B1-L002.*선택 불가/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: /B1-L001/ })).toHaveClass("max-compact:size-11!");
});
```

Verify single-selection monitoring still exposes `aria-current="true"` and does not expose multi-select semantics.

- [ ] **Step 2: Run the scene test and verify it fails**

Run: `pnpm --filter @led-control/web test -- src/features/floor-map/FloorScene.test.tsx`

Expected: FAIL because `selection`, `coarsePointer`, and `onFixturePress` are not supported.

- [ ] **Step 3: Implement the explicit selection contract**

```ts
export type FixtureSceneSelection =
  | { kind: "none" }
  | { kind: "single"; selectedFixtureIds: ReadonlySet<string> }
  | {
      kind: "multiple";
      selectedFixtureIds: ReadonlySet<string>;
      disabledFixtureIds: ReadonlySet<string>;
      disabledReasons?: ReadonlyMap<string, string>;
    };
```

Derive `selected`, `disabled`, accessible suffix, `aria-current` for single mode, and `aria-pressed` for multiple mode. Keep the visible dot at its current size and enlarge only the transparent button hit target at `max-compact`. Do not add literal colors or inline sizes.

- [ ] **Step 4: Update monitoring adapter and tests**

Construct one memoized `Set` for the selected fixture ID in monitoring. Keep existing status presentation, title, brightness level, map object, and image tests unchanged.

- [ ] **Step 5: Run scene and monitoring tests**

Run: `pnpm --filter @led-control/web test -- src/features/floor-map/FloorScene.test.tsx src/features/monitoring/FloorMap.test.tsx src/features/monitoring/MonitoringView.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit multi-selection markers**

```bash
git add apps/web/src/features/floor-map/FloorScene.tsx apps/web/src/features/floor-map/FloorScene.test.tsx apps/web/src/features/monitoring/FloorMap.tsx apps/web/src/features/monitoring/FloorMap.test.tsx
git commit -m "feat: support accessible map multi-selection"
```

---

### Task 4: Build the responsive spatial target selector

**Files:**
- Create: `apps/web/src/features/control/target-selection/SpatialTargetSelector.tsx`
- Create: `apps/web/src/features/control/target-selection/TargetSelectionToolbar.tsx`
- Create: `apps/web/src/features/control/target-selection/FixtureSelectionDrawer.tsx`
- Create: `apps/web/src/features/control/target-selection/SelectionSummaryPanel.tsx`
- Create: `apps/web/src/features/control/target-selection/SpatialTargetSelector.test.tsx`

**Interfaces:**
- Consumes: Task 1 resolver/domain, Task 2 viewport, Task 3 scene, `useFloorMapSnapshot`, `Dashboard`, and project UI primitives.
- Produces: `SpatialTargetSelector`, `SelectionSummaryPanel`, and `SpatialTargetSelectorProps` for manual/schedule/event/group flows.

- [ ] **Step 1: Write selector synchronization and fallback tests**

```ts
it("keeps map, list, and summary on one selection state", async () => {
  renderSelector({ selection: { mode: "fixtures", fixtureIds: [] } });
  fireEvent.click(await screen.findByRole("button", { name: /B2-L001/ }));

  expect(onChange).toHaveBeenLastCalledWith({ mode: "fixtures", fixtureIds: [fixtureA] });
  expect(screen.getByText("1개 선택")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "조명 목록 열기" }));
  expect(screen.getByRole("checkbox", { name: "B2-L001 선택" })).toBeChecked();
});

it("keeps unplaced fixtures in the list when no marker exists", async () => {
  renderSelector({ dashboard: dashboardWithUnplacedFixture });
  fireEvent.click(screen.getByRole("button", { name: "조명 목록 열기" }));
  expect(screen.getByText("미배치")).toBeInTheDocument();
});
```

Add the following named cases with these assertions:

```ts
it("opens the list fallback when the floor has no map snapshot", () => {
  floorMapQuery.mockReturnValue({ data: undefined, error: { status: 404 }, isLoading: false });
  renderSelector();
  expect(screen.getByText("등록된 도면이 없어 목록으로 선택합니다.")).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "조명 목록" })).toBeInTheDocument();
});

it("highlights group members without rendering a persisted boundary", () => {
  renderSelector({ selection: { mode: "group", groupId } });
  expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(2);
  expect(screen.queryByTestId("saved-group-polygon")).not.toBeInTheDocument();
});

it("requires confirmation before discarding a non-empty selection mode", () => {
  renderSelector({ selection: { mode: "fixtures", fixtureIds: [fixtureA] } });
  fireEvent.click(screen.getByRole("button", { name: "저장된 구역" }));
  expect(screen.getByRole("alertdialog", { name: "선택 방식 변경" })).toBeInTheDocument();
});
```

Also assert cached map data remains visible beside a refresh warning, floor mode resolves every current member, the first direct fixture disables other gateways, opening search focuses the search field, and the compact summary has explicit expand/collapse buttons.

- [ ] **Step 2: Run the selector test and verify it fails**

Run: `pnpm --filter @led-control/web test -- src/features/control/target-selection/SpatialTargetSelector.test.tsx`

Expected: FAIL because the target-selection components do not exist.

- [ ] **Step 3: Implement the public selector API**

```ts
export interface SpatialTargetSelectorProps {
  siteId: string;
  dashboard: Dashboard;
  selection: ControlSelection;
  disabled: boolean;
  allowedModes?: readonly ControlMode[];
  fixtureFilter?: (fixture: DashboardFixture) => boolean;
  requiredGatewayId?: string | null;
  interactionMode?: MapInteractionMode;
  onInteractionModeChange?: (mode: MapInteractionMode) => void;
  onChange: (selection: ControlSelection) => void;
}
```

Keep selected floor local but reconcile it when the selected group/floor changes. Fetch only the active floor map with `useFloorMapSnapshot(activeFloorId, siteId)`. Memoize the selected and disabled ID sets passed to `FloorScene`.

- [ ] **Step 4: Implement toolbar and list fallback using project primitives**

```tsx
<TargetSelectionToolbar
  allowedModes={allowedModes}
  selection={selection}
  activeFloorId={activeFloorId}
  floors={dashboard.floors}
  interactionMode={interactionMode}
  onModeChange={requestModeChange}
  onFloorChange={setActiveFloorId}
  onOpenList={() => setListOpen(true)}
/>
```

`FixtureSelectionDrawer` uses `ModalDialog`, `SearchField`, `SelectBox`, and `Checkbox`. On compact screens its dialog surface fills the available app content height and keeps the selection completion action above the safe-area/navigation region. Preserve the old status/floor filters and 100-item incremental rendering.

- [ ] **Step 5: Implement area selection and group/floor emphasis**

Convert the viewport `MapSelectionRect` to fixture IDs by testing each placed fixture's snapshot `x/y`. Apply eligibility and required gateway before updating selection. Saved group mode highlights its member markers and a group-name label only; do not render a stored polygon or claim that the selection rectangle is persisted.

- [ ] **Step 6: Implement responsive summary behavior**

On tablet and desktop render `SelectionSummaryPanel` as normal composition. Under `max-compact`, render the same semantic content in an in-flow bottom sheet with an explicit `선택 대상 펼치기/접기` button, not drag-only affordance. Keep the primary action supplied by each consumer outside this reusable summary.

- [ ] **Step 7: Run selector, UI policy, and type checks**

Run: `pnpm --filter @led-control/web test -- src/features/control/target-selection/SpatialTargetSelector.test.tsx`

Run: `pnpm --filter @led-control/web ui:check`

Run: `pnpm --filter @led-control/web typecheck`

Expected: all PASS with zero new UI policy violations.

- [ ] **Step 8: Commit the reusable selector**

```bash
git add apps/web/src/features/control/target-selection
git commit -m "feat: add responsive spatial target selector"
```

---

### Task 5: Replace manual control's list-first layout

**Files:**
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Modify: `apps/web/src/features/control/ControlView.test.tsx`
- Modify: `apps/web/src/features/control/CommandHistoryPanel.tsx`
- Modify: `apps/web/src/features/control/CommandHistoryPanel.test.tsx`

**Interfaces:**
- Consumes: `SpatialTargetSelector`, `SelectionSummaryPanel`, and `resolveControlSelection`.
- Produces: the final manual desktop/mobile composition while preserving the command request and outcome interfaces.

- [ ] **Step 1: Add failing manual layout and payload tests**

```ts
it("uses the map as the primary manual target picker", async () => {
  renderControl();
  expect(screen.getByRole("region", { name: "제어 대상 지도" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "조명 목록 열기" })).toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "밝기 실행" })).toBeInTheDocument();
});

it("submits the same stable fixture target selected from the map", async () => {
  renderControl();
  fireEvent.click(await screen.findByRole("button", { name: /B2-L001/ }));
  fireEvent.click(screen.getByRole("button", { name: "70%" }));
  fireEvent.click(screen.getByRole("button", { name: "1개 조명에 밝기 적용" }));

  await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
    "/commands/dimming",
    expect.objectContaining({ target: { type: "fixture", fixtureId: fixtureIds.b2First }, brightness: 70 }),
    expect.anything()
  ));
});
```

Add these explicit cases:

```ts
it("locks direct manual selection to the first fixture gateway", async () => {
  renderControl();
  fireEvent.click(await screen.findByRole("button", { name: /B2-L001/ }));
  expect(screen.getByRole("button", { name: /B1-L001.*선택 불가/ })).toBeDisabled();
});

it("keeps every map and brightness action disabled for a viewer", () => {
  renderControl({ userRole: "viewer" });
  expect(screen.getAllByRole("button", { name: /L00/ }).every((button) => button.hasAttribute("disabled"))).toBe(true);
  expect(screen.getByRole("slider", { name: "밝기" })).toBeDisabled();
});
```

Also assert an in-progress command disables map/list selection, the compact sheet contains the apply action above navigation, and selecting exactly one fixture initializes brightness from that fixture without changing multi-selection brightness.

- [ ] **Step 2: Run manual tests and verify they fail**

Run: `pnpm --filter @led-control/web test -- src/features/control/ControlView.test.tsx src/features/control/CommandHistoryPanel.test.tsx`

Expected: FAIL because manual control still renders `ControlTargetPicker` and the old layout.

- [ ] **Step 3: Replace internal `resolveSelection` with the shared resolver**

```ts
const resolvedSelection = useMemo(
  () => data ? resolveControlSelection(data, selection) : null,
  [data, selection]
);
const target = resolvedSelection?.available
  ? controlSelectionToDimmingTarget(selection)
  : null;
```

Preserve existing block messages, `controlsLocked`, request scoping, session storage, retry and verification behavior. Do not alter `submitCommand`, `sendCommand`, or command status semantics except to read `resolvedSelection.fixtureIds`.

- [ ] **Step 4: Compose map, summary, brightness, and history**

Use the shared selector as the flexible main pane and keep brightness/action in `SidePanel` on desktop. On compact screens place brightness/action in the selector summary sheet. Add a collapsed-by-default history disclosure on compact screens and a bounded bottom region on desktop; keep `CommandHistoryPanel` itself responsible for its internal list scroll.

- [ ] **Step 5: Run manual regression tests**

Run: `pnpm --filter @led-control/web test -- src/features/control/ControlView.test.tsx src/features/control/CommandHistoryPanel.test.tsx src/features/control/CommandOutcomeActions.test.tsx`

Expected: PASS, including existing unknown-outcome verification and retry tests.

- [ ] **Step 6: Commit manual map-first control**

```bash
git add apps/web/src/features/control/ControlView.tsx apps/web/src/features/control/ControlView.test.tsx apps/web/src/features/control/CommandHistoryPanel.tsx apps/web/src/features/control/CommandHistoryPanel.test.tsx
git commit -m "feat: make manual control map first"
```

---

### Task 6: Replace schedule target selection with the spatial selector

**Files:**
- Create: `apps/web/src/features/control/automation/ScheduleDialog.test.tsx`
- Modify: `apps/web/src/features/control/automation/ScheduleDialog.tsx`
- Modify: `apps/web/src/features/control/automation/ScheduleControlPanel.test.tsx`
- Modify: `apps/web/src/features/control/automation/automation-presenters.ts`
- Modify: `apps/web/src/features/control/automation/automation-presenters.test.ts`

**Interfaces:**
- Consumes: `SpatialTargetSelector`, `ControlSelection`, and the unchanged `scheduleFormToInput` target adapter.
- Produces: a responsive schedule target step whose submit payload remains `CreateScheduleInput`.

- [ ] **Step 1: Write schedule selector and snapshot-copy tests**

```ts
it("selects a saved group on the map and explains snapshot storage", async () => {
  renderScheduleDialog();
  fireEvent.click(screen.getByRole("button", { name: "제어 대상 선택" }));
  fireEvent.click(screen.getByRole("button", { name: "저장된 구역" }));
  fireEvent.click(screen.getByRole("button", { name: /B2 입구 구역 선택/ }));

  expect(screen.getByText("현재 2개 조명이 스케줄 대상으로 저장됩니다.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "2개 조명 선택 완료" }));
  expect(screen.getByText(/B2 입구 구역.*2개/)).toBeInTheDocument();
});
```

Add these exact schedule cases:

```ts
it("blocks a floor target that spans gateways", () => {
  renderScheduleDialog({ dashboard: multiGatewayDashboard });
  openTargetView();
  fireEvent.click(screen.getByRole("button", { name: "층 전체" }));
  fireEvent.click(screen.getByRole("button", { name: "B2" }));
  expect(screen.getByRole("button", { name: /선택 완료/ })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("같은 게이트웨이");
});

it("loads an existing persisted fixture snapshot as direct selection", () => {
  renderScheduleDialog({ schedule: persistedSchedule });
  openTargetView();
  expect(screen.getByRole("button", { name: "직접 선택" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("현재 저장된 조명 2개")).toBeInTheDocument();
});
```

Also assert direct marker selection, 404 map list fallback, `max-compact` full-screen dialog classes, target validation focus, and unchanged schedule submit payload.

- [ ] **Step 2: Run schedule tests and verify they fail**

Run: `pnpm --filter @led-control/web test -- src/features/control/automation/ScheduleDialog.test.tsx src/features/control/automation/ScheduleControlPanel.test.tsx`

Expected: FAIL because the dialog still renders `ControlTargetPicker`.

- [ ] **Step 3: Compose `SpatialTargetSelector` in the target view**

```tsx
<SpatialTargetSelector
  siteId={dashboard.site.id}
  dashboard={dashboard}
  selection={values.target}
  disabled={isPending}
  onChange={(target) => change({ target })}
/>
```

Keep `AutomationTargetPickerView` as the step container, but make it fill the dialog content area. Preserve focus return to `targetCardRef`, error IDs, advanced field validation, timezone copy, and submit locking.

- [ ] **Step 4: Add explicit snapshot semantics to the presenter**

When mode is `group` or `floor`, show the chosen label plus resolved fixture count while editing. After a persisted schedule reloads, show fixture snapshot semantics because the API response contains fixture IDs rather than the original selection source.

- [ ] **Step 5: Run schedule and contract tests**

Run: `pnpm --filter @led-control/web test -- src/features/control/automation/ScheduleDialog.test.tsx src/features/control/automation/ScheduleControlPanel.test.tsx src/features/control/automation/schedule-form.test.ts src/features/control/automation/automation-contracts.test.ts`

Expected: PASS with unchanged API payload schemas.

- [ ] **Step 6: Commit schedule map selection**

```bash
git add apps/web/src/features/control/automation/ScheduleDialog.tsx apps/web/src/features/control/automation/ScheduleDialog.test.tsx apps/web/src/features/control/automation/ScheduleControlPanel.test.tsx apps/web/src/features/control/automation/automation-presenters.ts apps/web/src/features/control/automation/automation-presenters.test.ts
git commit -m "feat: add map-first schedule targets"
```

---

### Task 7: Replace vehicle-event source and target selection

**Files:**
- Create: `apps/web/src/features/control/automation/VehicleEventDialog.test.tsx`
- Modify: `apps/web/src/features/control/automation/VehicleEventDialog.tsx`
- Modify: `apps/web/src/features/control/automation/VehicleEventControlPanel.test.tsx`
- Modify: `apps/web/src/features/control/automation/vehicle-event-form.ts`
- Modify: `apps/web/src/features/control/automation/vehicle-event-form.test.ts`
- Modify: `apps/web/src/features/control/automation/automation-presenters.ts`
- Modify: `apps/web/src/features/control/automation/automation-presenters.test.ts`

**Interfaces:**
- Consumes: `SpatialTargetSelector`, `resolveControlSelection`, `isVehicleEventSource`.
- Produces: source fixture-only map selection and target fixture/group/floor selection resolved to unchanged `sourceFixtureIds` and `targetFixtureIds` payloads.

- [ ] **Step 1: Write source eligibility and target resolution tests**

```ts
it("keeps event sources fixture-only and resolves a target group to fixture ids", async () => {
  renderVehicleEventDialog();

  fireEvent.click(screen.getByRole("button", { name: "감지 조명 선택" }));
  expect(screen.queryByRole("button", { name: "저장된 구역" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: sourceFixturePattern }));
  fireEvent.click(screen.getByRole("button", { name: "감지 조명 선택 완료" }));

  fireEvent.click(screen.getByRole("button", { name: "제어 조명 선택" }));
  fireEvent.click(screen.getByRole("button", { name: "저장된 구역" }));
  fireEvent.click(screen.getByRole("button", { name: /B2 입구 구역 선택/ }));
  fireEvent.click(screen.getByRole("button", { name: "2개 조명 선택 완료" }));
  fireEvent.click(screen.getByRole("button", { name: "이벤트 저장" }));

  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    sourceFixtureIds: [sourceFixtureId],
    targetFixtureIds: [targetFixtureA, targetFixtureB]
  }));
});
```

Add these exact cases:

```ts
it("disables target fixtures outside the selected source gateway", () => {
  renderVehicleEventDialog({ selectedSourceFixtureId: sourceA });
  openTargetView();
  expect(screen.getByRole("button", { name: /Gateway B.*선택 불가/ })).toBeDisabled();
});

it("shows an ineligible vehicle source but does not allow selection", () => {
  renderVehicleEventDialog();
  openSourceView();
  const source = screen.getByRole("button", { name: /차량 감지 모델 미설정/ });
  expect(source).toBeDisabled();
});
```

Also assert edit mode initializes both persisted ID arrays as direct selection and that group target completion stores a stable sorted ID snapshot.

- [ ] **Step 2: Run vehicle-event tests and verify they fail**

Run: `pnpm --filter @led-control/web test -- src/features/control/automation/VehicleEventDialog.test.tsx src/features/control/automation/VehicleEventControlPanel.test.tsx`

Expected: FAIL because both views currently allow only the list fixture mode.

- [ ] **Step 3: Add local UI selection identity without changing the API form**

```ts
const [sourceSelection, setSourceSelection] = useState<ControlSelection>({
  mode: "fixtures",
  fixtureIds: values.sourceFixtureIds
});
const [targetSelection, setTargetSelection] = useState<ControlSelection>({
  mode: "fixtures",
  fixtureIds: values.targetFixtureIds
});
```

On target selection completion, resolve the selection and call `change({ targetFixtureIds: resolved.fixtureIds })`. On source completion, copy the fixture IDs and derive the required target gateway. Reset local selection identity whenever `rule` changes. Do not add group/floor fields to the shared API contract or Prisma model.

- [ ] **Step 4: Render map selectors for source and target**

Source props use `allowedModes={["fixtures"]}` and `fixtureFilter={isVehicleEventSource}`. Target props use all three modes and `requiredGatewayId={sourceGatewayId}`. Preserve focus return, server errors, validation errors, pending lock, hold presets, dimming toggle, and brightness behavior.

- [ ] **Step 5: Run vehicle-event regression tests**

Run: `pnpm --filter @led-control/web test -- src/features/control/automation/VehicleEventDialog.test.tsx src/features/control/automation/VehicleEventControlPanel.test.tsx src/features/control/automation/vehicle-event-form.test.ts src/features/control/automation/automation-presenters.test.ts`

Expected: PASS with `VehicleEventRuleSnapshotV1` unchanged.

- [ ] **Step 6: Commit vehicle-event map selection**

```bash
git add apps/web/src/features/control/automation/VehicleEventDialog.tsx apps/web/src/features/control/automation/VehicleEventDialog.test.tsx apps/web/src/features/control/automation/VehicleEventControlPanel.test.tsx apps/web/src/features/control/automation/vehicle-event-form.ts apps/web/src/features/control/automation/vehicle-event-form.test.ts apps/web/src/features/control/automation/automation-presenters.ts apps/web/src/features/control/automation/automation-presenters.test.ts
git commit -m "feat: add map-first vehicle event targets"
```

---

### Task 8: Replace fixture-group membership editing with the map editor

**Files:**
- Create: `apps/web/src/features/control/target-selection/FixtureGroupMapEditor.tsx`
- Create: `apps/web/src/features/control/target-selection/FixtureGroupMapEditor.test.tsx`
- Modify: `apps/web/src/features/control/FixtureGroupDialog.tsx`
- Modify: `apps/web/src/features/control/FixtureGroupDialog.test.tsx`
- Delete: `apps/web/src/features/control/ControlTargetPicker.tsx` only after `rg` confirms no remaining imports.

**Interfaces:**
- Consumes: `SpatialTargetSelector`, group CRUD mutations already owned by `FixtureGroupDialog`, and `CreateFixtureGroupInput`.
- Produces: `FixtureGroupMapEditor` with `value`, `onChange`, `disabled`, and validation output.

- [ ] **Step 1: Write group map editor boundary tests**

```ts
it("locks floor and gateway after the first fixture and submits full replacement membership", async () => {
  renderGroupEditor();
  fireEvent.click(await screen.findByRole("button", { name: /B2-L001/ }));

  expect(screen.getByText("B2 · GW-B2 경계")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /B1-L001.*선택 불가/ })).toBeDisabled();

  fireEvent.change(screen.getByRole("textbox", { name: "구역 이름" }), { target: { value: "B2 입구" } });
  fireEvent.click(screen.getByRole("button", { name: "구역 저장" }));

  expect(onSubmit).toHaveBeenCalledWith({
    name: "B2 입구",
    floorId: floorB2,
    gatewayId: gatewayB2,
    fixtureIds: [fixtureB2A]
  });
});
```

Add these exact cases:

```ts
it.each([
  [[], "조명을 한 개 이상 선택하세요."],
  [fixtureIds(101), "구역에는 최대 100개 조명만 포함할 수 있습니다."]
])("rejects invalid membership cardinality", (fixtureIds, message) => {
  renderGroupEditor({ fixtureIds });
  fireEvent.click(screen.getByRole("button", { name: "구역 저장" }));
  expect(screen.getByRole("alert")).toHaveTextContent(message);
});

it("labels added and removed members while editing", () => {
  renderGroupEditor({ existingFixtureIds: [fixtureA, fixtureB] });
  toggleFixture(fixtureB);
  toggleFixture(fixtureC);
  expect(screen.getByText("제거 예정: B2-L002")).toBeInTheDocument();
  expect(screen.getByText("추가 예정: B2-L003")).toBeInTheDocument();
});
```

Also assert an unplaced fixture can be selected from the list, pending save locks every editor action, and a successful response with Mesh status `configuring` displays `Mesh 설정 중` rather than `제어 준비 완료`.

- [ ] **Step 2: Run group tests and verify they fail**

Run: `pnpm --filter @led-control/web test -- src/features/control/target-selection/FixtureGroupMapEditor.test.tsx src/features/control/FixtureGroupDialog.test.tsx`

Expected: FAIL because the group dialog still owns a checkbox list editor.

- [ ] **Step 3: Implement the group editor value contract**

```ts
export interface FixtureGroupEditorValue {
  groupId: string | null;
  name: string;
  floorId: string;
  gatewayId: string;
  fixtureIds: string[];
}

export interface FixtureGroupMapEditorProps {
  siteId: string;
  dashboard: Dashboard;
  value: FixtureGroupEditorValue;
  disabled: boolean;
  onChange: (value: FixtureGroupEditorValue) => void;
}
```

Use direct fixture selection only. Set floor/gateway from the first selected fixture if empty. When all fixtures are removed, keep the explicit floor/gateway selectors so the user controls whether the boundary changes; never silently move an existing group to another gateway.

- [ ] **Step 4: Integrate the editor into group management**

Keep group lifecycle cards, delete confirmation, resync, viewer read-only state, mutation cache updates, membership overrides, and return focus in `FixtureGroupDialog`. Replace only the create/edit membership form. Show `저장 후 Mesh 설정 중` before submit and existing mutation result status after submit.

- [ ] **Step 5: Remove the old picker after import audit**

Run: `rg -n "ControlTargetPicker" apps/web/src`

Expected before delete: no production import outside `ControlTargetPicker.tsx`; tests have migrated to `SpatialTargetSelector`.

Delete `ControlTargetPicker.tsx`, then run the same search and expect no matches.

- [ ] **Step 6: Run group and control tests**

Run: `pnpm --filter @led-control/web test -- src/features/control/target-selection/FixtureGroupMapEditor.test.tsx src/features/control/FixtureGroupDialog.test.tsx src/features/control/ControlView.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit map-based group management**

```bash
git add apps/web/src/features/control/target-selection/FixtureGroupMapEditor.tsx apps/web/src/features/control/target-selection/FixtureGroupMapEditor.test.tsx apps/web/src/features/control/FixtureGroupDialog.tsx apps/web/src/features/control/FixtureGroupDialog.test.tsx apps/web/src/features/control/ControlTargetPicker.tsx
git commit -m "feat: manage fixture groups from the map"
```

---

### Task 9: Add responsive, gesture, and workflow browser regression

**Files:**
- Create: `apps/web/e2e/control-map-target-selection.spec.ts`
- Modify: `apps/web/e2e/layout-assertions.spec.ts`
- Modify: `apps/web/e2e/calm-operations-manual-control.spec.ts`
- Modify: `apps/web/e2e/calm-operations-automation.spec.ts`

**Interfaces:**
- Consumes: completed UI and existing deterministic route fixtures.
- Produces: browser evidence for map-first selection, responsive layout, and unchanged command/automation requests.

- [ ] **Step 1: Add the map-first workflow spec**

```ts
test("manual map selection stays synchronized with the list and command payload", async ({ page }) => {
  let commandBody: Record<string, unknown> | null = null;
  await installControlMapRoutes(page, {
    onDimmingCommand: (body) => { commandBody = body; }
  });
  await page.goto(`/control?siteId=${ids.site}`);

  await page.getByRole("button", { name: /B2-L001/ }).click();
  await page.getByRole("button", { name: "조명 목록 열기" }).click();
  await expect(page.getByRole("checkbox", { name: "B2-L001 선택" })).toBeChecked();
  await page.getByRole("button", { name: "목록 닫기" }).click();
  await page.getByRole("button", { name: "1개 조명에 밝기 적용" }).click();

  expect(commandBody).toMatchObject({
    target: { type: "fixture", fixtureId: ids.fixture },
    brightness: 70
  });
});
```

Define `installControlMapRoutes` in the new spec using the existing route-fixture style: fulfill dashboard, floor-map, command status, schedule, vehicle-event and group endpoints, and pass the parsed dimming request body to `onDimmingCommand`. Add named tests that assert schedule group selection sends `{ type: "group", groupId }`, event target group selection sends its sorted current `targetFixtureIds`, group creation renders `configuring`, a `404` floor-map response opens the list fallback, and viewer mode never issues a POST.

- [ ] **Step 2: Add mobile viewport and target-size assertions**

```ts
for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 740 }]) {
  test(`mobile control fits ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installControlMapRoutes(page);
    await page.goto(`/control?siteId=${ids.site}`);
    await expectNoHorizontalOverflow(page);
    await expectMinimumTouchTargetsAfterScrolling(page, "[data-control-screen]");

    const action = page.getByRole("button", { name: /밝기 적용/ });
    const navigation = page.locator('[data-shell-navigation="compact"]');
    const [actionBox, navigationBox] = await Promise.all([action.boundingBox(), navigation.boundingBox()]);
    expect(actionBox).not.toBeNull();
    expect(navigationBox).not.toBeNull();
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(navigationBox!.y);
  });
}
```

Import `expectNoHorizontalOverflow` and `expectMinimumTouchTargetsAfterScrolling` from `e2e/support/layout-assertions.ts`. Extend that helper's current spatial-marker exclusion branch so this spec explicitly measures marker hit targets instead of excluding them.

At 1440×900 and 1024×768, assert document scroll height equals client height while map, history, and detail panels can scroll internally.

- [ ] **Step 3: Add synthetic two-pointer pinch browser coverage**

Use `page.locator(...).dispatchEvent("pointerdown", ...)` for two touch pointer IDs, move them apart, and assert `data-zoom` increases while no area rectangle remains. Release one pointer, move the other, and assert scroll does not jump. Record in the test name and docs that this is synthetic browser evidence, not native WebView touch validation.

- [ ] **Step 4: Run focused Chromium specs and verify failures before final fixes**

Run: `pnpm --filter @led-control/web exec playwright test e2e/control-map-target-selection.spec.ts e2e/layout-assertions.spec.ts e2e/calm-operations-manual-control.spec.ts e2e/calm-operations-automation.spec.ts --project=chromium --workers=1`

Expected: PASS because Tasks 1–8 already implement the contract. If a precise overflow, target-size, selector, or interaction assertion fails, fix production behavior rather than weakening the assertion unless it contradicts the approved spec.

- [ ] **Step 5: Re-run focused Chromium specs**

Run the same command.

Expected: PASS.

- [ ] **Step 6: Commit browser regression**

```bash
git add apps/web/e2e/control-map-target-selection.spec.ts apps/web/e2e/layout-assertions.spec.ts apps/web/e2e/calm-operations-manual-control.spec.ts apps/web/e2e/calm-operations-automation.spec.ts
git commit -m "test: cover map-first control workflows"
```

---

### Task 10: Update feature documentation and run final verification

**Files:**
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/monitoring.md`

**Interfaces:**
- Consumes: all completed tasks and verification output.
- Produces: accurate implemented, missing, improvement, related-file, and refresh-rule documentation required by `AGENTS.md`.

- [ ] **Step 1: Update control menu documentation**

Add implementation records for map-first manual/schedule/event selection, map group management, list fallback, mobile bottom sheet, 44px targets, two-finger pinch in every mode, single-gateway blocking, 1,000/100 limits, schedule/event snapshot semantics, and `configuring` group behavior.

Add explicit limitations under `부족하거나 개선이 필요한 기능`:

```markdown
- 모바일 두 손가락 확대·축소는 Web PointerEvent와 synthetic Chromium으로 검증했다. 실제 iOS/Android WebView의 safe area, gesture arbitration과 장시간 현장 사용성은 실기기 확인이 필요하다.
- 저장 구역은 fixture membership만 보존하며 polygon 경계는 저장하지 않는다. 맵의 영역 rectangle은 선택 도구이고 저장 데이터가 아니다.
- 스케줄·이벤트의 구역 선택은 저장 시점 fixture snapshot이다. 구역 멤버 변경은 기존 규칙에 자동 반영되지 않는다.
```

- [ ] **Step 2: Update monitoring menu documentation**

Record that monitoring now consumes shared `FloorMapViewport` and the explicit single-selection adapter, with no change to monitoring selection semantics. Record pinch/wheel/pan behavior and actual mobile-device validation as the same limitation.

- [ ] **Step 3: Run policy, type, unit, and build gates**

Run: `node --test apps/web/scripts/ui-policy.test.mjs`

Run: `pnpm --filter @led-control/web ui:check`

Run: `pnpm --filter @led-control/web typecheck`

Run: `pnpm --filter @led-control/web test`

Run: `pnpm --filter @led-control/web build`

Expected: every command exits 0; UI policy reports no new or baseline violations.

- [ ] **Step 4: Run the full serial Chromium suite**

Run: `pnpm --filter @led-control/web exec playwright test --project=chromium --workers=1`

Expected: all non-environment-gated Chromium tests PASS; gated tests remain explicitly skipped for their documented environment requirement.

- [ ] **Step 5: Inspect the final diff and unrelated workspace changes**

Run: `git diff --check`

Run: `git status --short`

Run: `git diff --stat`

Expected: no whitespace errors; only plan-scoped source, tests, and menu docs are staged for the final commit. Do not add `.chart-data-*`, `outputs/`, `docs/research/`, or unrelated energy-report changes.

- [ ] **Step 6: Commit documentation and verification state**

```bash
git add docs/menus/control.md docs/menus/monitoring.md
git commit -m "docs: record map-first control selection"
```

- [ ] **Step 7: Request final code review before integration**

Invoke `superpowers:requesting-code-review` over the complete implementation range. Resolve findings with `superpowers:receiving-code-review`, re-run the affected focused tests, then use `superpowers:verification-before-completion` before claiming completion or invoking `superpowers:finishing-a-development-branch`.

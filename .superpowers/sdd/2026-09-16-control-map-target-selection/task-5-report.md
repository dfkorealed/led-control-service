# Task 5 report — manual map-first control

## Status

COMPLETE. Manual control now uses the reviewed `SpatialTargetSelector` as its map-first target surface. The command payload contract and command recovery, retry, polling, authorization, and Mesh readiness behavior remain covered by regression tests.

## Files changed

- `apps/web/src/features/control/ControlView.tsx`
- `apps/web/src/features/control/CommandHistoryPanel.tsx`
- `apps/web/src/features/control/target-selection/SpatialTargetSelector.tsx`
- `apps/web/src/features/control/ControlView.test.tsx`
- `apps/web/src/features/control/target-selection/SpatialTargetSelector.test.tsx`
- `apps/web/src/App.test.tsx`
- `docs/menus/control.md`

No backend, database, REST, MQTT, BLE, or firmware files changed.

## RED → GREEN evidence

### RED

Before production edits, the new map-first manual-flow tests were run with:

```sh
pnpm --filter @led-control/web test -- src/features/control/ControlView.test.tsx src/features/control/CommandHistoryPanel.test.tsx
```

The command failed as expected: `ControlView.test.tsx` had 4 new map-first failures (no `제어 대상 지도`, accessible map marker selection, dynamic apply action, or disabled map target). `CommandHistoryPanel.test.tsx` passed 4 tests.

### Initial GREEN

```sh
pnpm --filter @led-control/web test -- src/features/control/ControlView.test.tsx -t 'uses the map as the primary manual target picker|submits the same stable fixture target selected from the map|locks direct manual selection to the first fixture gateway|keeps every map and brightness action disabled for a viewer'
```

Passed: 4/4 targeted tests (68 skipped). The viewer regression made Task 4's deferred global-disabled marker defect load-bearing. The smallest fix adds the selector's `disabled` prop to `disabledFixtureIds`; its focused selector regression now passes.

### Migrated behavior families

- Payload and brightness slice: 7 passed, 65 skipped.
- Gateway lock, 1,000-cap resolver, Mesh/readiness, drawer filter and unavailable-target slice: 9 passed, 63 skipped.
- Command lock, retry, status, authorization, history, desktop layout, and compact history disclosure are included in the complete focused ControlView/history regression below.
- App-level manual-flow tests now use map markers scoped to `제어 대상 지도`, saved-zone controls, and the dynamic apply action. This prevents accidentally interacting with the monitoring map during route transition.

### Complete focused GREEN

```sh
pnpm --filter @led-control/web test -- src/features/control/ControlView.test.tsx src/features/control/CommandHistoryPanel.test.tsx
```

Passed: 2 files, 76/76 tests.

```sh
pnpm --filter @led-control/web test -- src/features/control/target-selection/SpatialTargetSelector.test.tsx
```

Passed: 1 file, 17/17 tests, including global selector disabling.

```sh
pnpm --filter @led-control/web test -- src/App.test.tsx
```

Passed: 1 file, 69/69 tests.

## Verification

```sh
pnpm --filter @led-control/web test:ui-policy
pnpm --filter @led-control/web ui:check
pnpm --filter @led-control/web typecheck
pnpm --filter @led-control/web test
git diff --check
```

- UI policy tests: 53/53 passed.
- UI policy scan: 0 existing violations, 0 new/increased violations.
- Typecheck: passed.
- Full web suite: 94 files, 1,360/1,360 tests passed.
- `git diff --check`: passed.

## Self-review

- `ControlView` delegates target availability, one-gateway validation, Mesh readiness, and the 1,000-fixture cap to the shared `resolveControlSelection` policy; no list/map policy was copied back into the view.
- Direct selection is constrained by the selector before submission, while floor and saved-zone target payloads still use the unchanged dimming target conversion.
- The existing command-session lock, POST retry identity, verification/status polling, historical command disclosure, and authorization branches were preserved and exercised by the focused regression.
- Desktop uses bounded grid regions for map, execution, and history; the compact execution sheet is before a collapsed history disclosure. Map/drawer/detail/history regions own their overflow.
- The manual-control menu documentation records the map-first flow and limitations.

## Remaining concerns

None. The first full-web attempt exposed an unrelated `OperatorShell` loading wait that passed in isolation; a fresh complete rerun passed 94/94 files and 1,360/1,360 tests.

## Fix Round 1 — review remediation

### Scope

- Added the optional consumer-owned `compactSummary` slot to `SpatialTargetSelector`; `SelectionSummaryPanel` places it only in the expanded compact summary surface.
- Kept the desktop `SidePanel`, but moved its reusable brightness/preset/apply controls into a shared consumer component so no execution surface is visible twice at one breakpoint.
- Added visible and accessible unavailable explanations beside disabled floor/group choices and fixture drawer rows, preserving transport copy normalization for ACK wording.
- Made drawer-wide `disabled` unconditional so an already-selected fixture cannot stay actionable during permission or command locks.

### RED

```sh
pnpm --filter @led-control/web test -- src/features/control/ControlView.test.tsx src/features/control/target-selection/SpatialTargetSelector.test.tsx
```

Failed as expected: 4 tests failed. The compact summary had no consumer execution slot, disabled floor/group candidates had no accessible Mesh explanation, fixture Health/block detail was absent from the drawer checkbox description, and a selected drawer checkbox remained enabled after a global disabled transition.

### GREEN

After the minimal implementation, the same focused selector/ControlView command passed 91/91 tests. The first Mesh assertion then exposed a fixture-offline test fixture masking the intended Mesh failure; the fixture was corrected to be controllable for that readiness-specific scenario, and the focused run passed.

```sh
pnpm --filter @led-control/web test -- src/features/control/ControlView.test.tsx src/features/control/target-selection/SpatialTargetSelector.test.tsx src/features/control/CommandHistoryPanel.test.tsx src/features/control/CommandOutcomeActions.test.tsx
```

Passed: 4 files, 104/104 tests.

### Verification

- `pnpm --filter @led-control/web test:ui-policy`: 53/53 passed.
- `pnpm --filter @led-control/web ui:check`: 0 existing and 0 new/increased violations.
- `pnpm --filter @led-control/web typecheck`: passed.
- `pnpm --filter @led-control/web test`: 94 files, 1,362/1,362 tests passed.
- `git diff --check`: passed.

### Fix round self-review

- Compact brightness/apply controls are descendants of the expanded `선택 대상 요약`; the focused test proves containment, expansion/collapse, and order before the history disclosure. The desktop side panel is `hidden compact:flex`, while the slot belongs to the compact-only summary surface.
- Candidate reasons use the existing device-response mapper, so raw ACK copy remains absent. Fixture drawer descriptions include the block reason and Health fault codes and are visible through the shared `Checkbox` field description.
- The selector retains the existing per-fixture deselection exception, but `FixtureSelectionDrawer` now prioritizes the global disabled state for every checkbox.

# Map Camera Surface Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the common CAD map surface responsive and visually continuous while users pan, wheel-zoom, pinch-zoom, resize, or resume a tab.

**Architecture:** Keep `MapSceneCanvas` and its `MapSceneRenderer` alive for one authenticated map source scope. A shared imperative camera interaction path updates the DOM/Pixi/Konva transform on animation frames; React receives only the settled camera state. The raster backend retains currently visible cells until replacement coverage is prepared, then publishes the replacement in one frame.

**Tech Stack:** React 18, TypeScript, PixiJS, Konva, Zustand, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-18-cad-native-map-rendering-design.md`

## Global Constraints

- Existing display manifest v2 and canonical map contracts remain unchanged.
- Desktop and mobile memory budgets remain 128 MiB and 32 MiB respectively.
- A source scope change cancels work and releases resources; a camera, callback, revision, viewport-size, or editable/read-only prop update must not recreate the renderer.
- Static map, fixture status, and selection overlay use the same world-to-screen camera frame.
- No DOM query APIs are introduced in product code; canvas ownership remains ref based.

## Audit Traceability (2026-09-21)

| Invariant | Status before work | Evidence / gap | Owning task |
| --- | --- | --- | --- |
| Stable canvas/renderer | Partial | Revision and callback updates are stable, but `readOnly`, width-derived platform, and a new same-scope source object can remount the surface. | 1 |
| Imperative gesture updates | Partial | Editor mouse/wheel is coalesced; monitoring/control pinch writes React zoom each move and editor lacks Pointer Event pinch support. | 2 |
| Unified pointer lifecycle | Partial | Floor viewport has pointer capture/cancel; editor only listens to mouse events. | 2 |
| Shared layer coordinate system | Partial | Monitoring/control use `FloorMapViewport`; editor uses a parallel Konva camera path. Shared camera math is not isolated. | 2 |
| Atomic coverage swap | Partial | Existing cells are reused during settle, but a rebake drops the current cell before its replacement is ready. | 3 |
| Manifest compatibility | Complete | Common map display uses v2 and no contract change is needed. | 1-3 regression |
| Abort and disposal | Complete | Renderer epochs, abort controllers, and raster disposal fences exist. Rapid source-switch coverage remains a regression task. | 1, 3 |
| Memory/LRU visible protection | Partial | Budget/LRU exists, but atomic replacement must preserve visible cells when a new raster cannot be admitted. | 3 |
| Context loss/restoration | Complete | `CadSceneRenderer` listens for context lost/restored and reuses its backend lifecycle. Add surface-level regression only. | 1 |
| Edit behavior | Partial | Existing selection/undo/save tests pass; Pointer Event input must retain it. | 2 |
| Mobile resize/DPR/safe area | Partial | `ResizeObserver` and mobile memory policy exist; platform must not flip merely because a desktop viewport is narrow. | 1, 2 |

## Review Focus

- A same-scope API source object refresh must not remount its canvas or retain stale fetch functions.
- A fast pinch or wheel sequence must leave the map under the pointer and publish only a settled React zoom.
- A new raster cell that is still decoding must not blank the existing visible cell.
- An aborted replacement must not publish after source switch or unmount, and all budget allocations must return to zero.
- Mouse, touch, resize, orientation-like width changes, and read-only control/monitor surfaces must preserve hit coordinates.

### Task 1: Stabilize Common Map Surface Lifecycle

**Files:**
- Modify: `apps/web/src/features/map-scene/MapSceneCanvas.tsx`
- Modify: `apps/web/src/features/map-scene/MapSceneCanvas.test.tsx`

**Interfaces:**
- Consumes: `MapSceneSource.scopeKey`, `MapSceneCanvasHandle`, `MapSceneRenderer`.
- Produces: a renderer whose data source delegates to the latest same-scope source without recreating the canvas.

- [x] Write a failing lifecycle test for a same-scope source object plus read-only/viewport callback changes, asserting one canvas and renderer.
- [x] Run the focused test and confirm it fails because the mount effect depends on object/read-only identity.
- [x] Build a ref-backed source facade, key mount only by source scope and stable platform, and preserve the latest callbacks through `latest.current`.
- [x] Run `pnpm --filter @led-control/web test -- src/features/map-scene/MapSceneCanvas.test.tsx` and confirm it passes.
- [x] Commit `perf(web): keep common map surface stable across host updates` (`2768c30f`).

### Task 2: Coalesce Viewport Gestures Without React Tree Reconciliation

**Files:**
- Modify: `apps/web/src/features/floor-map/FloorMapViewport.tsx`
- Modify: `apps/web/src/features/floor-map/FloorMapViewport.test.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- Test: `apps/web/src/features/floor-editor/FloorEditorCanvas.common-map.test.tsx`

**Interfaces:**
- Consumes: `CadSceneCamera`, `FloorMapViewportOverlay.subscribe`, `screenToWorld`.
- Produces: an imperative camera path on the shared viewport and editor; Pointer Events update once per animation frame and emit a settled camera exactly once.

- [x] Write failing tests proving pinch/wheel uses one settled React commit while frame listeners receive the live camera, and editor touch pan/pinch preserves map-space coordinates.
- [x] Run focused tests and confirm current viewport writes zoom state on every pointer move and editor lacks touch handling.
- [x] Implement pointer capture, RAF coalescing, pointer cancel recovery, and 120ms settled commits without `deltaMode` branches.
- [x] Apply it to monitoring/control `FloorMapViewport`; migrate editor camera input to Pointer Events while preserving selection, drag, resize, undo, and save paths.
- [x] Run focused viewport/editor tests (85 PASS) and commit `perf(web): coalesce shared map camera gestures`.

### Task 3: Publish Raster Coverage Atomically

**Files:**
- Modify: `apps/web/src/features/map-scene/map-raster-backend.ts`
- Modify: `apps/web/src/features/map-scene/map-raster-backend.test.ts`

**Interfaces:**
- Consumes: `CadSceneMemoryBudget`, `CadRasterDisplayRequest`, raster cell signatures.
- Produces: staged raster cells that replace active Pixi cells only after all required visible coverage is ready for the current generation.

- [x] Write a delayed-decode test that asserts the old visible raster remains until the new generation publishes; the existing disposal regression covers aborted work never publishing.
- [x] Confirm by source audit that the prior rebake invoked `drop` before canvas creation/decode completed.
- [x] Stage final canvas allocation under a generation owner, atomically swap cells in one frame, defer stale-cell eviction until after publish, and retain visible coverage when budget admission fails.
- [x] Run raster/backend and common-map lifecycle tests; destroy releases staged and active allocations (8 raster + 5 canvas tests PASS).
- [x] Commit `perf(web): atomically swap settled map raster coverage` (`4d27734a`).

### Task 4: Integrate and Verify Shared Surfaces

**Files:**
- Modify: `docs/menus/settings.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/project-status.md`
- Modify: `docs/test-results/cad-native-map-2026-09-18.md`
- Modify: `docs/lesson_leared.md`

- [x] Verify integration through common monitoring host (`FloorScene.common-map`) source-identity/camera tests and control's shared `FloorMapViewport` composition; `MapSceneCanvas` lifecycle regression covers no renderer remount on same-scope host refresh.
- [x] Run web typecheck, web tests, web build, and `git diff --check`. Root gate is unchanged and not rerun for this web-only change.
- [x] Record exact pass/fail counts, memory-budget evidence, and explicitly deferred 500k, physical mobile GPU, and Linux cgroup checks.
- [x] Commit `docs(map): record camera resilience verification`.

## Scope Self-Review

- The plan covers all partial or missing traceability rows without changing map-display schema, DB, API, or hardware contracts.
- Existing context recovery, abort, and memory-cap mechanisms are regression-tested rather than duplicated.
- 500k-element, actual RN WebView GPU, and production Linux cgroup checks remain unclaimed until separately executed.

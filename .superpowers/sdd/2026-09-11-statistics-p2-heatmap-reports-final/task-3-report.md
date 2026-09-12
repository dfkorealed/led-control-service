# Task 3 — Heatmap UI report

## Scope delivered

- Added the site-scoped `useEnergyHeatmap` query with strict P2 response parsing and a cache key that includes scope, selected identity, metric, and range.
- Added `EnergyHeatmap`: 7×24 CSS grid, energy/brightness control, legend, selected-cell detail, and shared loading/error/empty states.
- Connected the active ranking item and dimension to the heatmap scope; its initial window resolves to the last 28 completed days in the site timezone.
- Contained the 24-column 44px cell grid in an internal horizontal scroller so narrow viewports do not create document-level horizontal overflow.

## TDD evidence

### RED

1. Added API tests for strict heatmap request/cache behavior and malformed response errors.
2. Added component tests for 7×24 cells, real zero versus missing data, metric selection, keyboard detail selection, and feedback states.
3. Added page integration coverage for the ranking selection scope and completed 28-day site-local window.
4. Ran:

```text
pnpm --filter @led-control/web exec vitest run src/api/energy.test.tsx src/features/statistics/analysis/EnergyHeatmap.test.tsx src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx
```

Expected failures were observed: `useEnergyHeatmap is not a function`, unresolved `EnergyHeatmap`, and the unconnected page heatmap assertion timed out.

### GREEN / refactor

Implemented the hook, component, integration, and responsive styles. The grid remains native-button based (rather than overriding buttons to `gridcell`) so keyboard interaction retains its correct button semantics. Tests were then rerun successfully:

```text
15 passed (3 files)
```

## Verification

```text
pnpm --filter @led-control/web typecheck
PASS (exit 0)

pnpm --filter @led-control/web test
PASS — 58 files, 658 tests

git diff --check
PASS (no output)
```

## Files

- `apps/web/src/api/energy.ts`
- `apps/web/src/api/energy.test.tsx`
- `apps/web/src/features/statistics/analysis/EnergyHeatmap.tsx`
- `apps/web/src/features/statistics/analysis/EnergyHeatmap.test.tsx`
- `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.tsx`
- `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx`
- `apps/web/src/styles.css`

## Self-review

- Only `energy` and `brightness` are accepted by the typed P2 metric contract.
- Null is rendered as unavailable data; numeric zero remains a value and uses a distinct visual level.
- Every cell is a 44×44 native button and supports click, Enter, and Space selection; the selected detail is announced with `role="status"`.
- The fixed-width 24-column grid is contained by a `max-width: 100%; overflow-x: auto` wrapper, while headers stack and card padding follows the 760px mobile rule.
- No P2-C/report/optimization controls were added.

## Concerns

- The component test environment does not calculate CSS layout. Responsive overflow protection is implemented and CSS-reviewed, while the full Web suite covers the interaction and state behavior. A browser viewport screenshot test can be added later if visual regression tooling is introduced.

## Fix Round 1

### Changes

- Prevented a pre-timezone heatmap request: the heatmap wrapper is disabled until the ranking response supplies the site timezone, then derives the completed 28-day window before enabling the query.
- Strengthened the page test with an `America/Los_Angeles` fixture and an assertion over every initial heatmap-hook call. It rejects the former UTC first call instead of accepting a later corrected call.
- Replaced the invalid ARIA `grid` wrapper with a labelled `group` around the independently operable native buttons.
- Added a dedicated metric-control class and a desktop `min-width`/`min-height` of 44px; the existing mobile statistics control rule remains at least 52px.
- Updated `docs/menus/statistics.md` with the heatmap behavior, constraints, and related implementation/test files.

### RED evidence

Command:

```text
pnpm --filter @led-control/shared build && pnpm --filter @led-control/web exec vitest run src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx src/features/statistics/analysis/EnergyHeatmap.test.tsx
```

Result: exit 1. `EnergyHeatmap.test.tsx` failed because there was no labelled `group` and no metric-control class. `StatisticsAnalysisPage.test.tsx` failed because it observed two calls: an incorrect first UTC range (`2026-08-14` through `2026-09-10`) followed by the site-local range (`2026-08-12` through `2026-09-08`).

### GREEN evidence

Command:

```text
pnpm --filter @led-control/shared build && pnpm --filter @led-control/web exec vitest run src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx src/features/statistics/analysis/EnergyHeatmap.test.tsx && pnpm --filter @led-control/web typecheck
```

Result: exit 0. Focused tests: 2 files, 7 tests passed. Typecheck passed.

Final verification:

```text
pnpm --filter @led-control/web test
PASS — 58 files, 658 tests

git diff --check
PASS (no output)
```

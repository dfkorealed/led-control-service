# Task 9 report

## Files

- Added `apps/web/e2e/control-map-target-selection.spec.ts` for browser-visible target-selection, request-payload, responsive, and synthetic pinch evidence.
- Updated automation and manual-control browser fixtures for the map-plus-drawer selection workflow.
- Updated `apps/web/e2e/support/layout-assertions.ts` and its spec so spatial markers are measured unless explicitly excluded.
- Updated map marker and compact interaction target dimensions, plus the map pointer-capture edge case.

## Regression mutations caught

- Selecting a spatial marker initially failed to update the list because the map captured its single pointer before native click dispatch. The test was RED, then the capture was limited to map gestures/two-pointer pinch (GREEN).
- The new cases catch changed dimming payloads, fixture snapshot/group requests, configuring lifecycle UI, 404 list fallback, and any viewer POST.
- Layout cases catch page overflow, non-scrolling map/history/detail panes, undersized controls or markers, and compact action overlap with navigation.
- Pinch cases catch missing zoom, area-selection rectangles during pinch, and post-lift pan jumps for pan/select/area. They use browser-synthetic `PointerEvent`s and are explicitly **not native WebView/HIL evidence**.

## Verification

- Focused Chromium: new target-selection plus layout specs passed, 42/42.
- Automation Chromium: 6/6 passed.
- Focused units: 55/55 passed; full web unit suite: 97 files, 1393 tests passed.
- `pnpm --filter @led-control/web typecheck`: passed.
- `pnpm --filter @led-control/web ui:check`: passed (0 existing and 0 new/increased violations).
- `git diff --check`: passed.

## Concerns

The final combined Chromium rerun should be retained as the final gate after the last manual-fixture migration; Chromium itself is available and has run all focused suites above.

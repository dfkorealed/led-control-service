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

## Continuation

Manual-spec RED evidence found stale list-first selectors in the 1440px/1366px fixture workflow and group editor; these were migrated to the public map, drawer, and exact listbox controls and the focused 1440px regression is GREEN. The 390px equivalents still expose compact-disclosure assumptions: command detail close, command progress, and brightness action are hidden until their compact disclosure is opened. These are stale test interaction failures, not a reproduced production layout regression; the final combined four-spec Chromium gate is therefore still not green at this checkpoint.

## Recovery Completion

Recovery completed on 2026-09-17; this section supersedes the incomplete continuation checkpoint above.

### Diagnosis and changes

- A fresh manual-only baseline reproduced **11 passed / 10 failed**. Compact 390px and 320px snapshots showed `선택 대상 펼치기` collapsed while command-detail close, restored command progress, or brightness actions were expected. `SelectionSummaryPanel` mounts these controls only when expanded, and a page reload resets that state. All content was reachable through the intended disclosure; no production visibility bug was reproduced.
- Added one reusable public-UI helper using the named summary region and disclosure button. It asserts `aria-expanded=false`, absent compact slider before opening, `aria-expanded=true` afterward, and visible slider/action contained in that summary. The command live region is empty before a command exists, so actual progress and terminal visibility remain asserted in the individual workflows. History disclosure state and contained search controls are also checked. Close/reopen, lost status-check response with identical request ID, safe reapply of the original brightness/target, in-flight lock, reload restoration, partial failure, success, timeout, viewer restrictions, and blocked-target coverage remain intact.
- Scoped feedback text to the opened execution surface so the hidden desktop copy cannot cause strict-locator ambiguity on compact layouts.
- The three desktop stability cases also contained a stale interaction: selecting a fixture already marked faulty is now correctly disabled by map-first selection. The test selects the long-name fixture while healthy using the drawer, then its route fixture reports a fault through normal dashboard polling. It verifies the current aggregate fault alert, preserved selected name, disabled apply action, no dimming request, and every original position, size, bounds, scroll, and overflow assertion.
- The first combined run was **68 passed / 1 failed**: the synthetic pan-mode pinch captured scrollLeft=0 before the already-scheduled animation frame applied the legitimate anchor scroll (84). The test now reads its pinch baseline on the next animation frame after the zoom commit, retaining exact post-lift scroll equality and all zoom/area assertions. No timeout, sleep, forced click, layout tolerance, or public-UI bypass was added.
- Recovery changes are restricted to the two browser specs and this report. Production code and menu behavior did not change, so no menu document update was necessary.

### Final verification

Executed from `/Users/kim-jh/Documents/led-control-service/.worktrees/control-map-target-selection`, in the required manual-then-combined order after the final test change:

```bash
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-manual-control.spec.ts --project=chromium --workers=1
# 21 passed (39.7s); no failures or skips

pnpm --filter @led-control/web exec playwright test e2e/control-map-target-selection.spec.ts e2e/layout-assertions.spec.ts e2e/calm-operations-manual-control.spec.ts e2e/calm-operations-automation.spec.ts --project=chromium --workers=1
# 69 passed (1.2m); no failures or skips

pnpm --filter @led-control/web typecheck
# passed

pnpm --filter @led-control/web ui:check
# passed: 0 existing violations; 0 new/increased violations

git diff --check
# passed
```

The combined result contains manual **21/21**, automation **6/6**, and target-selection plus layout **42/42**. Since recovery made no production changes, focused/full web unit suites were not repeated; their earlier **55/55** and **1393/1393** evidence above remains prior-run evidence, not a fresh recovery run.

### Concerns

No remaining recovery blocker. These are deterministic Chromium route-fixture results; synthetic PointerEvents do not establish native WebView touch or hardware/HIL behavior. Initial invocations found a leftover previous Playwright process occupying port 15174; that same-worktree run was interrupted and all recorded final commands owned their own normal Vite server lifecycle.

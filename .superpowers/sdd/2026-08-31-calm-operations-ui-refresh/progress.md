# SDD ledger — plan: docs/superpowers/plans/2026-08-31-calm-operations-ui-refresh.md

Workspace: `/Users/kim-jh/Documents/led-control-service/.worktrees/calm-operations-ui-refresh`
Branch: `codex/calm-operations-ui-refresh`
Start HEAD: `b29d945fc55f22501c698953106b849afcbedb20`
Baseline: Web 34 files / 352 tests passed; typecheck passed; build passed with pre-existing >500 kB chunk warning.

## Preflight task self-consistency

| Task | Tests vs implementation | Files vs later consumers | Finding |
| --- | --- | --- | --- |
| 1 | Primitive semantics are tested before the new files and token CSS | Public exports are consumed by Tasks 3–6 | Clean; exact wrapper markup may be adjusted if TypeScript requires without changing interfaces. |
| 2 | Hover/focus/coarse-pointer behavior and removed internal settings nav are observable | Produces the flattened settings shell consumed by Task 6 and E2E in Task 7 | Clean; `SettingsNavigationItem` owns interaction state while `settingsSectionsFor` remains the role filter. |
| 3 | Monitoring heading, metric groups and selected detail are observable | Produces monitoring layout consumed by Task 7 | Clean; all data/query/registration logic is explicitly preserved. |
| 4 | Control page, tabs, execution region and automation status are observable | Produces three-mode layout consumed by Task 7 | Clean; existing state machines are explicitly outside visual refactor scope. |
| 5 | Statistics KPI groups and chart accessibility are observable | Produces statistics layout consumed by Task 7 | Clean; null gaps and summary/series isolation remain binding. |
| 6 | Settings overview, forms and editor regions are observable | Consumes Task 2 shell and produces settings layouts consumed by Task 7 | Clean; setup, lease, dirty and password safety behavior stays unchanged. |
| 7 | Browser viewport, overflow, touch and settings navigation behavior are observable | Consumes Tasks 2–6 and produces final verification evidence for Task 8 | Plan defect: after Tasks 2–6, new assertions may already pass, so RED is not guaranteed. |
| 8 | Documentation is checked against final verification evidence | Consumes every prior task and closes the plan/status records | Clean; completion remains conditional on actual command results. |

## Preflight shared-file and interface scan

| Pair | Shared file/interface | Finding |
| --- | --- | --- |
| 1 ↔ 2 | `styles.css`, UI token/class contracts | Task 2 consumes Task 1 tokens; sequential order is correct. |
| 1 ↔ 3 | `styles.css`, primitive exports | Task 3 consumes stable Task 1 exports; no conflict. |
| 1 ↔ 4 | `styles.css`, primitive exports | Task 4 consumes stable Task 1 exports; no conflict. |
| 1 ↔ 5 | `styles.css`, primitive exports | Task 5 consumes stable Task 1 exports; no conflict. |
| 1 ↔ 6 | `styles.css`, primitive exports | Task 6 consumes stable Task 1 exports; no conflict. |
| 1 ↔ 7 | `styles.css`, responsive token behavior | Task 7 may refine but must not rename Task 1 public tokens. |
| 1 ↔ 8 | plan checkboxes and final validation evidence | Task 8 records Task 1 results only; no code conflict. |
| 2 ↔ 3 | primary shell width/content layout through `styles.css` | Monitoring must fit the shell produced by Task 2; sequential order is correct. |
| 2 ↔ 4 | primary shell width/content layout through `styles.css` | Control must fit the shell produced by Task 2; sequential order is correct. |
| 2 ↔ 5 | primary shell width/content layout through `styles.css` | Statistics must fit the shell produced by Task 2; sequential order is correct. |
| 2 ↔ 6 | `SettingsShell`, `SettingsShell.test.tsx`, settings content classes | Task 6 builds on the flattened shell and must not reintroduce internal navigation. |
| 2 ↔ 7 | settings disclosure behavior and responsive CSS/E2E | Task 7 verifies Task 2 behavior and may only fix concrete responsive defects. |
| 2 ↔ 8 | settings plan/status evidence | Task 8 records navigation verification; no implementation conflict. |
| 3 ↔ 4 | `styles.css` common layout/card selectors | Feature selectors stay scoped; shared primitive selectors are owned by Task 1. |
| 3 ↔ 5 | `styles.css` metric/page selectors | Both consume primitives; feature-specific styles must not redefine primitive semantics. |
| 3 ↔ 6 | `styles.css` responsive/content selectors | Keep feature blocks scoped to avoid cascade regressions. |
| 3 ↔ 7 | monitoring layout and Playwright flow | Task 7 consumes Task 3 DOM labels; no rename without updating tests. |
| 3 ↔ 8 | `monitoring.md`, final evidence | Task 8 reviews, not rewrites, verified Task 3 claims. |
| 4 ↔ 5 | `styles.css` tab/card/button selectors | Use shared classes plus feature modifiers; no contract conflict. |
| 4 ↔ 6 | `styles.css` table/dialog/form selectors | Preserve scoped automation/settings selectors to prevent cross-feature leakage. |
| 4 ↔ 7 | control DOM labels and Playwright flow | Task 7 consumes Task 4 accessible labels and three-mode behavior. |
| 4 ↔ 8 | `control.md`, final evidence | Task 8 reviews actual Task 4 test evidence; no conflict. |
| 5 ↔ 6 | `styles.css` page/card/form layout | Feature modifiers remain scoped; shared primitives are unchanged. |
| 5 ↔ 7 | statistics DOM labels and Playwright flow | Task 7 consumes Task 5 chart and KPI contracts. |
| 5 ↔ 8 | `statistics.md`, final evidence | Task 8 preserves estimation/HIL limitations from Task 5. |
| 6 ↔ 7 | settings/editor DOM labels and Playwright flow | Task 7 consumes Task 6 toolbar/form/route contracts. |
| 6 ↔ 8 | `settings.md`, final evidence | Task 8 preserves role and HIL limitations from Task 6. |
| 7 ↔ 8 | Playwright/full verification output | Task 8 records exact Task 7 evidence; no conflict. |

Ruling: Task 7 does not manufacture a failing test if its new browser contract already passes after Tasks 2–6. It must still add the assertions first, run them, record whether they expose a real gap, and only change CSS for an observed failure. This preserves the spec and honest tests; if wrong, Task 7 may produce tests without a RED cycle for already-satisfied behavior, but avoids a fake regression.

Task 1: minor (deferred): `Card` has no focused primitive contract test; final review will decide whether consumer coverage is sufficient.
Task 1: reviewer could not independently verify commands from the diff; controller confirmed the report contains focused 4/4, full 356/356, typecheck and build evidence for commit `b309552`.
Task 1: fix round 1/5 (2 addressed, 0 open — duplicate inner `data-tone` removed; icon accessibility contract covered; commits `b309552`..`3e5d872`).
Task 1: complete (commits `65d1002`..`3e5d872`, review clean).
Task 2: Ruling: the plan's `left: calc(100% + 10px)` conflicts with the spec's single hover boundary and immediate boundary-leave closing. Remove the physical pointer gap and retain visual separation with border/shadow; if wrong, the popover will sit closer to the sidebar than the initial CSS sketch but remain reliably reachable.
Task 2: minor (deferred): use exact matching for the `/settings` overview submenu active state so deeper routes do not mark two entries active.
Task 2: minor (deferred): focused unit coverage does not yet exercise every outside-pointer, mouse-leave, boundary-blur, route-change and focus-restoration close path; Task 7 browser coverage and final review must triage.
Task 2: first scoped re-review was inconclusive because that reviewer could not access the report/diff; no implementation change was made and a fresh reviewer inspected the same package.
Task 2: fix round 1/5 (2 addressed, 0 open — hover gap removed; 44px selector and focus-visible styles added; commits `f76f6ff`..`d38afff`).
Task 2: complete (commits `91e62e9`..`d38afff`, review clean).
Task 3: Ruling: satisfy non-color map status without rendering persistent text on every one of up to 1,000 markers. Use a visible icon+text map legend plus non-color marker shape/border differences, preserving marker accessible names and scale; if wrong, users may need hover/focus for fixture-specific text, but the map remains readable and performant.
Task 3: Ruling: the reviewer statement that no mobile single-column rule exists is factually too broad because `@media (max-width: 760px)` already sets `.detail-panel` to one column. The 761–1120px half-width squeeze is real and must be fixed; if wrong, tablet layout may use more width than the original two-column sketch but avoids an empty column.
Task 3: fix round 1/5 (2 addressed, 0 open — constant map legend/non-color marker forms; full-width tablet detail stack; commits `0524f2c`..`e2e58cc`).
Task 3: complete (commits `a0cb1cd`..`e2e58cc`, review clean).
Task 4: fix round 1/5 (5 addressed — neutral contrast, mobile header actions, live-region separation, h2/h3 hierarchy, shared ref-forwarding Button; commits `a714aa1`..`74ae77e`).
Task 4: fix round 2/5 (2 addressed — monitoring neutral cascade contrast and control h3 typography; commits `74ae77e`..`6a127b1`).
Task 4: complete (commits `1d58726`..`6a127b1`, 116 control tests, typecheck and production build passed; final re-review clean).
Task 5: fix round 1/5 (5 addressed — MetricCard status/value-unit contract, 390/320 KPI grid, 44px range buttons, active-series empty state, negative savings semantics; commits `30e3615`..`f235ee1`).
Task 5: fix round 2/5 (1 addressed — App integration assertions aligned without weakening site/query/cache checks; commits `f235ee1`..`c35b672`).
Task 5: complete (commits `fea0a1f`..`c35b672`, 24 focused tests and 6 Chromium statistics flows passed; final re-review clean).
Cross-task regression after Task 5: full Web suite exposed four Task 3 monitoring App assertions still targeting removed `B1/B2 운영 현황` copy. They are not caused by the Task 5 fix diff; resolve against the Task 3 accessibility contract before Task 6.
Task 3: supplemental fix round 2/5 complete (four App monitoring assertions aligned to current semantic landmarks without runtime changes; commit `c9cb009`; 375 full Web tests and independent review passed).
Task 6: fix round 1/5 (2 addressed — six App integration assertions and 44x44 editor toolbar/revision targets; commits `ea10760`..`c917087`).
Task 6: complete (commits `ca9bf13`..`c917087`, 72 settings/editor tests, 378 full Web tests, typecheck/build and independent Chromium dimension review passed).
Task 7: Ruling: the global 44px touch-target rule does not justify enlarging each dense spatial floor-map marker until hit areas overlap. Preserve the compact marker scale and Konva hit semantics required by Task 3, remove the false 44px marker claim, and provide a visible 44px mobile fixture selector as the equivalent selection path; if wrong, direct marker tapping remains below 44px even though every fixture is reachable through the compliant selector, but the map stays selectable, legible and performant at up to 1,000 fixtures.
Task 7: fix round 1/5 (5 addressed — exhaustive interactive-root helper, mobile fixture selector/compact marker ruling, hermetic Playwright server, desktop/coarse ARIA, expanded viewport coverage; commits `13643d6`..`9b776d9`).
Task 7: fix round 2/5 (1 addressed — associated labels, viewport/overflow clipping and pointer reachability; commits `9b776d9`..`a1000b0`).
Task 7: fix round 3/5 (3 addressed — continuous 44x44 hit area, all labels/input fallback, fixed containing blocks; commits `a1000b0`..`7a88b83`).
Task 7: fix round 4/5 (1 addressed by fresh escalated implementer — scroll each associated label/input candidate; commits `7a88b83`..`fe0f4e8`).
Task 7: complete (commits `7ba136b`..`fe0f4e8`, helper Chromium 23/23, focused Chromium 45/45, Web 379/379, typecheck/build and final re-review passed).

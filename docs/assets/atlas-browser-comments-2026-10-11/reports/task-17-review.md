# Task 17 — final independent integration review

- Reviewer: `comments_final_review_20261011`, one read-only integration seat; no subagents, checkout/index mutations, or test/browser reruns.
- Range: `d8dbfcd10a6b5a00bafbfca65cb8652d0bb08508..e9d72b91675bf8a179e33d1b3a1b8143ff34142b`.
- Binding requirements: appended Tasks 13–17 and 2026-10-11 constraints in `docs/superpowers/plans/2026-10-10-atlas-ui-fidelity.md`, including the approved schedule CTA move. Tasks 1–12 are historical.
- Inspected product/test/menu-document diffs, surrounding shared components and selection/focus/time-format paths, customer site schema/access contract, the three canonical task reports, and final static log tails. Also inspected the in-progress E2E working diff: real wheel scrolling plus measurement diagnostics and overview checks, without geometry/style overrides or relaxed visibility/44px assertions.

## Strengths

- The selector deletion is restricted to switching-only components/hook/dialog/tests. `useSites`, dashboard/query scope, URL parameters, and logout dirty guard remain. `Site.adminUserId @unique`, `SiteMembership.userId @unique`, and `SiteAccessService.listAccessibleSiteIds()` substantiate the current single-customer-site contract.
- DataGrid applies explicit alignment consistently to header, sort button, table cell, and compact card value while preserving undefined defaults. Schedule/group consumers specify name-left and other-column-center; custom group action/status layouts also center their contents.
- Manual control uses the existing inspection slot for the real selected fixture list and its clear action, without duplicating the list on the right or changing execution/draft/UUID/ACK/recovery owners. Schedule creation remains a unique ref-backed action both with and without the global-list contract; delete fallback focus retains that ref. Existing event/read-only access remains intact.
- Statistics changes reuse SearchField and FilterPanel actions/reset. The overview retains one accessible h1, report creation remains available, and actual timeZone/ISO formatting and job/filter/download lifetimes are unchanged.
- All four affected menu documents were updated in the implementation commits and retain the five required documentation categories. Tests adjust intentionally removed UI expectations and add real interaction/assertion coverage; no skip/timeout/geometry weakening was found. The working E2E helper uses real wheel input and still requires complete visibility, 44px dimensions, and center-point hit testing.

## Issues

### Critical (Must Fix)

None found.

### Important (Should Fix)

1. **[P2, ADDRESSED in `4802b641`] The short mobile monitoring page could not scroll its log action above fixed navigation.**
   - File: `apps/web/src/features/monitoring/MonitoringView.tsx:405` (finite flex layout and compact natural minimum; related screen safe padding at line 353).
   - Evidence: root/QA reported the controlled 390×600 case failing both the initial seven-case run and a local recheck. Document height is 779, `scrollY=179` is already the maximum, and an additional real wheel delta of 83 outside the canvas does not move it. The log button bottom is 591 while fixed navigation begins at 532; center-point hit testing is false. This reviewer did not rerun the browser.
   - Impact: a short-screen user cannot reach the complete recent-log action through ordinary page scroll. This violates the explicit short-mobile scroll/tool-access requirement even though the tall mobile map now fills available height.
   - Fix: preserve sufficient scrollable space after the overflowing natural minimum on compact monitoring, without shrinking the 240px canvas or changing camera/renderer ownership. Recheck the failed short-screen case and the directly affected tall-map layout on the corrected source. Root has already assigned the scoped correction to the monitoring owner.

### Minor (Nice to Have)

None found. Task/status and final verification entries are intentionally still open during active QA; close them using the final evidence before handoff rather than recording premature completion.

### Additional runtime finding after initial approval

2. **[P2, ADDRESSED in `45b22fce` / `b70f037f`] Long desktop site information collapsed the metric track and covered header actions.**
   - File: `apps/web/src/features/shells/CustomerShell.tsx:316` (desktop grid tracks); related account link touch area at line337.
   - Root's subsequent representative-image inspection and QA RED reproduced metric children reaching1177 past actions start1088 at1280px, and reaching723 past actions start568 at760px with theme center inaccessible. Earlier document-overflow/gap checks did not catch this internal overlap; that original evidence remains preserved.
   - `45b22fce` reserves intrinsic summary/action tracks and assigns remaining width to the truncating site label. The new `minmax(0,1fr)_auto_auto` layout fixes the cause without changing mobile layout, query/URL/access, logout, or component owners. Four menu documents record it.
   - The first corrected-grid run passed all three-width overlap assertions but the additional continuous44px helper exposed the unchanged base account link's rounded44×44 hit shape. Root explicitly accepted a same-header-only correction under `docs/ui-spacing.md`'s continuous44px contract. `b70f037f` changes only that link's min-height/min-width to existing52px utilities, retaining href, semantics, focus, mobile-hidden condition, and account/security logic; four menu documents record the distinction from the original overlap.

## Evidence and limits

- Canonical owner reports: Task 13 direct five suites 190 PASS; Task 14 seven suites 373 PASS; Task 15 four suites 155 PASS. These are reported scoped executions, not reviewer reruns or whole-Web coverage.
- Task 13's separate SettingsShell `현장 관리` group failure is documented as reproduced by the identical test at base `d8dbfcd1`. The failing test/product are unchanged; the SettingsShell test diff only removes the deleted source filename. It is retained as a baseline failure, not counted as PASS.
- Final source `e9d72b91` static results supplied by root and corroborated by log tails: typecheck exit 0, UI policy 79 PASS/0 FAIL/0 SKIP, UI violations 0/0, build exit 0 with the existing large-chunk warning. Root reports identical product-source fingerprints before/after the batch.
- Runtime source evidence is not seven PASS: initial seven cases were five PASS/two FAIL; local recheck made dark reports PASS using actual scrolling, while short monitoring still failed. The latter blocks readiness until its correction is checked. The reviewer makes no final pixel/geometry claim from unit class assertions.
- API/DB/shared contracts, dependency/tokens, remote/deployment, device/HIL behavior were not changed by this diff.

## Declined to judge — executor ruling required

- Restoring the customer site picker, removed ATLAS/ENERGY labels, schedule sync badges, group Gateway/version/address metadata, or adding replacement detail UI: explicitly removed/excluded by the current user requirements; their absence is not a regression finding.
- Whole Web/E2E/Lab/HIL, native WebView, GPU/performance, and production/deployment behavior: outside the explicit LEAN validation boundary, and no corresponding product changes or evidence are claimed.
- The existing SettingsShell home-card group failure: unchanged base failure with preserved evidence, not a new correction-scope defect. Root should retain its known-failure status.
- Historical Tasks 1–12 and prior full-matrix results: completed earlier and explicitly excluded from this execution; their evidence is not counted as current verification.

## Scoped correction recheck — same seat

- Reviewed only `e9d72b91..4802b64148fb469720349aec972cb324a637e0db`: three files, seven insertions/two deletions. Normal compact monitoring screen adds `max-compact:min-h-min` so its natural minimum includes trailing fixed-navigation padding; the existing unit assertion and monitoring menu note explain that ownership. The full-view branch, map `flex-1`, 240px canvas minimum, renderer/camera, and all other product owners remain unchanged. No new Critical/Important issue was found.
- Independently read the saved final geometry and `.last-run.json` (`passed`, no failedTests). At 390×600 the document now measures 847px and reaches scrollY247; the 109.90625×44 log action is y479/bottom523, above navTop532, with `reachable=true` and writes0. The same previously blocked case proceeds through short manual actions, all recorded reachable with 44px minimum sizes, and writes0.
- Tall578 and tall681 keep map height630, panel bottom1141, navTop1159 (18px remaining gap), equal header cells131.5/157.25 respectively, and writes0. Thus the local evidence covers both the failed short-screen path and the affected successful tall-map layout.
- Root/QA report the scoped three-case run at source `4802b641` as PASS, exit0/13.4s. This reviewer verified the current MonitoringView SHA-256 equals QA's `0cf542fd923d535279eeb86181ceb30432f1d08f39ee6f866074f396aa8eac9e`. No reviewer tests or browsers were run.
- Scoped static logs confirm UI violations0/0 and `tsc --noEmit && vite build` success; the existing930.29kB large-chunk warning remains. Owner direct unit evidence is two PASS/103 unselected and is not treated as pixel verification.
- Final runtime evidence is seven unique cases across three runs/twelve executions: initial7 = five PASS/two FAIL, local2 = one PASS/one FAIL, corrected-height3 = three PASS. This is not a final-HEAD seven-case batch PASS. Original failures remain preserved. `task-16-report.md` was still receiving its final update at this read; the final-results metrics were inspected directly.
- Executor explicitly accepted all four declined-to-judge rulings above: intentional removals, LEAN-excluded environments, unchanged SettingsShell baseline failure, and historical Tasks1–12. Nothing is silently discarded.

## Additional header scoped recheck — same seat

- Reviewed only the two header product corrections and their four-menu notes, the owner report, saved final geometry, and final static logs. No additional suite/browser or full review was run. The actual CustomerShell SHA-256 is `d51f945290f73b0fee1394ea89a6e98f5b1fa21d84e0ae70b14b4e5dee814c1e`, matching QA's source at `b70f037f`.
- Final saved geometry confirms context/summary/action separation at1440,1280,760. Actual metric-child right edges end at1224,1064,544; action groups begin1240,1080,560 respectively (16px separation). All four metric children stay inside the summary allocation, metric gaps remain12px, all three action targets are52×52 with reachable centers, writes0, and the760px document has equal scroll/client widths760.
- The unchanged shared strict touch helper is still invoked after the per-width geometry checks; final `.last-run.json` is `passed` with no failures. QA reports the same PC case PASS, exit0/8.9s. The original overlap RED and first-grid-run account-link failure are retained, not counted as passing runs.
- Final `header-hit-fix-ui-check.log` has0/0 violations; `header-hit-fix-build.log` confirms `tsc --noEmit && vite build` success in6.98s, with the same930.29kB known chunk warning. The earlier79-test policy result was not rerun or represented as fresh at this source.
- Updated aggregate: seven unique browser cases across six runs/fifteen executions (7+2+3+1+1+1), with source-specific failure/correction history. This is not a final-HEAD seven-case batch PASS. The earlier short-mobile fix remains addressed; these later product changes affect only desktop header tracks/account hit size.
- Root explicitly accepted the narrowly scoped existing account-link hit-shape correction after runtime evidence. No further product-scope expansion is requested. New/outstanding Critical/Important/Minor findings:0/0/0.

## Final recommendations

Preserve the source-specific original failure and correction evidence during documentation closeout. Complete the planned checklist/status/menu evidence and clean-HEAD/local-merge checks; no additional product repair or broad test rerun is requested by this review.

## Assessment

**Ready to merge? Yes.**

Both runtime P2 findings are addressed by scoped layout corrections with actual short/tall and three-width header evidence; the approved existing header-link hit-area follow-up also passes. Final code review has no outstanding Critical/Important/Minor findings; documentation closeout and clean-HEAD integration remain executor responsibilities, with the known baseline failure, known bundle warning, and source-specific validation limits retained.

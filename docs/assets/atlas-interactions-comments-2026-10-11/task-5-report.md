# Task 5 — independent integrated review (new interaction comments)

Status: final source/evidence review complete. This is the new21-comment task with C8 excluded (20 implemented), not the earlier29-comment task.

- Review range: `cc6b9a7a9210afed6f17ec8f5f85ee512cbe3d9b..437ebc39`.
- Requirements: `docs/superpowers/plans/2026-10-11-atlas-interactions-comments.md`, the recorded numeric-date-segment width exception and C17 desktop/mobile layout ruling, applicable root/Web AGENTS and reviewer template.
- Reviewer is the single independent read-only seat. No subagents, tests, browsers, servers, API/remote writes, index/HEAD changes, or implementation edits. This ignored report is the only reviewer write.
- Inspected actual product/test/menu diffs, surrounding gesture and FloorScene physical activation logic, registered overlay ownership, finder camera/detail callbacks, report job actions, and canonical Task1–3 reports/ledger. Final Task4 assessment below uses prepared reports, raw logs, actual PNG/JSON and the QA-only commit, without repeating the full review or executing additional tests.
- Final checkout `67364847b58f5b5ad0fe671eb27bd1aaacc990bb`: `437ebc39..67364847` contains the scoped browser spec/evidence only (71 files); `apps/web/src` diff is empty. Product approval remains tied to frozen `437ebc39`.

## Strengths

- Common UI changes are opt-in: Popover retains default desktop/ordinary behavior; mobile FilterPanel/finder use React Aria modal and the existing registered overlay/back owner. Date draft/validation/controller logic and TimePicker segment geometry remain unchanged. Calendar is an actual SVG with a square44px trigger, and the narrower date digits are explicitly documented rather than misrepresented as44px targets.
- DataGrid details use stable typed row keys and component-scoped IDs, preserve expansion across sorting/responsive changes, and leave unspecified consumers unchanged. Reports retain download/regenerate permissions and handlers, original time/ISO formatting, status/expiry, sanitized failure guidance, and page-owned job/polling lifetimes.
- Manual-cad is enabled only by manual-workspace. Mouse middle/Space navigation, left marquee, touch pan, threshold-delayed marker capture, keyboard detail0, and existing cancellation/pinch/lock paths have focused tests. FloorScene product code and default editor/monitoring behavior are unchanged; brightness/selection/command owners stay with existing handlers.
- Monitoring removes duplicate finder controls while retaining loaded-row search, cursor/partial-error information, map focus/pin callbacks, unplaced-detail paths, and all five renderer vocabulary entries. Header only removes the customer-name prefix; previously corrected layout/hit geometry is unchanged.
- C8 `StatisticsOperationalInfo.tsx` and its test have zero diff. Statistics representation changes preserve actual data/null/zero/negative savings and chart null gaps. Four affected menu documents record common changes with the required five categories and the runtime limits.
- Tests assert state/interaction outcomes, stable row ownership, real calendar semantics, and guarded command behavior; removal of obsolete selector/tool/metadata expectations is consistent with the new specification. Unit geometry mocks are not treated as browser evidence.

## Issues

### Critical (Must Fix)

None identified in the reviewed source.

### Important (Should Fix)

None identified in the reviewed source. The two required runtime evidence gaps described below are now closed; neither was asserted to be a confirmed product defect.

### Minor (Nice to Have)

None raised. Root owns the remaining plan/status closeout and integration decision; they are not product defects.

## Evidence cohorts

- Task1 reports common unique118 plus statistics169 =287 unique direct tests, accumulated across source-specific runs, not one final whole-batch run. The attempted independent RankingDetailPanel test file did not exist and was not counted; its chart is exercised through consumers.
- Task2 reports a final same-product five-suite295 PASS run. Original gesture RED and stale-reset/tool-expectation failures remain documented.
- Task3 reports staged failures and failed-case-only GREEN reruns, not a final all-suite PASS; the sidebar's first failure cause remains undetermined and its focused rerun PASS is distinguished.
- Original static source77f8608f: type/build exit0, policy78PASS/1FAIL and UI check1 due to unapproved `rounded-t-panel`. Frozen437ebc39 changes that style only to the approved panel token with explicit zero lower corners; owner47PASS and fresh policy/UI/build success are recorded by QA. No token/policy/debt relaxation occurred.
- Required browser gate is satisfied by the separated runs detailed below, not by a final six-case batch PASS.
- The known SettingsShell134 baseline failure and existing large-chunk warning are retained and not repaired or counted as passing here.

## Final Task4 evidence assessment

- Read the canonical and permanent Task4 reports, evidence README, final raw browser log, final case2 native-input assertions/JSON, and inspected actual 320px sheet, 577px dark report-details and marker-origin screenshots. The permanent evidence is under `docs/assets/atlas-interactions-comments-2026-10-11/`.
- Accurate cohort: six unique browser cases, seven runs, 21 executions (`6+6+3+3+1+1+1`). Initial run0/6; fixture-fixed3/6 (cases1/2/4); locator-fixed0/3; contract-fixed3/3 (cases3/5/6); two additional marker gate setup failures before the gesture; final body-restored case2 1/1, exit0,11.6s. Original failures and intermediate evidence are preserved. This is not a final-HEAD all-six batch result.
- Browser checks cover native PC blank7/8px threshold, marquee/cancellation/middle/Space/wheel; touch hold/no area/swipe/pinch cancellation; monitoring name-number finder/selected pin/five legend entries;390/320 bottom-sheet anchoring/date line/keyboard/nested calendar focus/last close;577 dark report summaries/details/actions enabled/stable expanded row; overview PC/mobile actual tick bounds and unchanged C8 text/values.
- Reviewer gate1 was missing native marker-origin delayed capture evidence. It is closed: actual marker center is a `BUTTON`,48×48, bottom493.703125 above nav532; native32px swipe moves camera(0,0)→(8,8) with entire selection unchanged and no area; subsequent taps toggle false then true. This directly exercises the new marker-origin ownership boundary, beyond blank-origin pan or synthetic unit input.
- Reviewer gate2 was the test helper's incorrect fixed-navigation selector and insufficient partial-visibility bound. It is closed: actual `[data-shell-navigation="compact"]`, full clear bottom376<=nav532,44px height, and continuous44 hit helper pass. The product was not changed to satisfy these gates.
- The two marker setup failures were actual pre-gesture hit failures, not proven product defects: body scroll388 left the map at y-3 behind sticky header118. Final native gutter wheel restores body0/map y385 before bounded native marker recenter. Raw camera/rect/hit data distinguishes this from CSS/camera injection or forced clicks. Product, thresholds, timeouts and retry policy remained unchanged.
- Remaining limits are acceptable for the approved20-comment LEAN readiness: unplaced/pageerror/viewer download transport/nested select have focused owner-unit rather than direct browser assertions; only the overview plot has actual runtime tick geometry, while the other two plots use inspected common code and unit token coverage. No browser claim is extended to those paths, real device/DB/HIL, native WebView/GPU, or every chart/theme/viewport combination.

## Declined to judge — executor rulings accepted

Root explicitly accepted each of the following six set-aside behaviors and recorded the rulings in the ledger; these are not silently dropped findings.

- C8 operational-insight redesign/new metrics: explicitly excluded by the user; its source/test are unchanged.
- Restoring removed tool switches, manual group shortcut, duplicate finder/select, quick-period helpers, savings badges, or captions: intentional UI removals under the new comments, not missing-feature findings.
- Server-wide fixture-number search/new DTO/API or real device behavior: approved scope is name-string matching within loaded cursor pages; no server/hardware changes are made or claimed.
- Individual date numeric segments at44px width and forced single-line complete heading/date on narrow phones: explicitly documented physical-width exceptions; group/calendar/general controls and readable complete dates retain their contracts and scoped runtime evidence.
- Whole Web/E2E/Lab/HIL/native WebView/GPU and known unchanged SettingsShell baseline/chunk warning: outside the user's LEAN correction boundary; no corresponding completion claim.
- Prior29-comment task and older whole-matrix evidence: not rerun or counted as new-task verification.

## Assessment (final)

**Ready to merge? Yes — for the reviewed UI product branch (`437ebc39` product, `67364847` QA-only evidence).**

The source matches the approved20-comment scope, no confirmed Critical/Important/Minor issue remains, and the narrowly required native-input/visibility gates are now supported by actual evidence. The initial pending verdict is superseded by this evidence assessment, not by weakening the gate or claiming a whole-suite PASS.

This is **not approval of an unreviewed merge with MAIN `34d5a375`**. MAIN independently advanced with public-web/deployment work after the base. User integration authority is still pending; no merge/cleanup is authorized here. If root later integrates both histories, the actual Button/public-variant and configuration intersections require the agreed scoped follow-up, not a repeat audit of this unchanged product range.

Skill used: `superpowers:requesting-code-review`, including its independent reviewer template. No implementation or additional test/browser execution was performed by this review seat.

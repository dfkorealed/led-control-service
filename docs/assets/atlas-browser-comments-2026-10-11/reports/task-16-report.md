# Task 16 focused UI evidence

Checkout: `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-browser-comments-20261011`.
Branch: `codex/atlas-browser-comments-20261011`. Test preparation commit: `d80fc43e`. Mobile action correction commit: `72bbd2e1` (same test source as successful three-case execution). Final header test-only correction commit: `18f5a0eb` (same test source as final successful header case; no product changes in either test-only commit).
Final status: seven unique focused cases have passing evidence across six runs / fifteen executions (7+2+3+1+1+1). The strengthened PC header case finally passes at source `b70f037f`; original overlap and pre-existing account-link continuous-hit failure remain separately preserved. This is not a fresh all-seven run at final HEAD: each repair received only its explicitly authorized affected-case checks, and the other cases retain source-specific evidence.

Final mobile execution source HEAD: `4802b64148fb469720349aec972cb324a637e0db` (`fix(web): preserve monitoring bottom scroll space on compact screens`). Verified working `MonitoringView.tsx` SHA256 at execution: `0cf542fd923d535279eeb86181ceb30432f1d08f39ee6f866074f396aa8eac9e`. The tests use Task15's completed statistics code, subsequently committed as `e9d72b91`; the final monitoring repair does not modify that code. Initial execution did not capture a contemporaneous HEAD, so it is not presented as a fresh final-HEAD all-seven result.

## Commands and exits

All commands used the explicit checkout above. Node/pnpm prefix: `PATH=/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH`.

- `pnpm --filter @led-control/web exec playwright test e2e/atlas-ui-fidelity.spec.ts --grep 'browser comments' --list`: exit 0; seven unique cases registered; browser not started.
- `git diff --check -- apps/web/e2e/atlas-ui-fidelity.spec.ts`: exit 0.
- Before each browser command, `lsof -nP -iTCP:15186 -sTCP:LISTEN`: exit 1 with empty output, proving no existing listener was reused.
- `E2E_WEB_PORT=15186 pnpm --filter @led-control/web exec playwright test e2e/atlas-ui-fidelity.spec.ts --grep 'browser comments' --workers=1 --reporter=list`: exit 1, 5 passed / 2 failed, 23.3s. Default timeout and expect timeout unchanged.
- `E2E_WEB_PORT=15186 pnpm --filter @led-control/web exec playwright test e2e/atlas-ui-fidelity.spec.ts --grep 'browser comments (short mobile|dark mobile reports)' --workers=1 --reporter=list --output=.superpowers-task16-local-results`: exit 1, dark reports passed / short monitoring failed, 12.4s. Generated output moved intact into this checkout's `task-16-local-results` sibling directory.
- After the product repair, `E2E_WEB_PORT=15186 pnpm --filter @led-control/web exec playwright test e2e/atlas-ui-fidelity.spec.ts --grep 'browser comments (tall mobile|short mobile)' --workers=1 --reporter=list --output=/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-browser-comments-20261011/.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-final-results`: exit 0, 3 passed, 13.4s. Short manual's previously unexecuted second half also passed. No all-seven replay was performed.

The default Playwright webServer owned port 15186 and shut down on command completion. Existing ports 5173/4000/63200 were not used or stopped. Only controlled API fixtures were used; successful cases assert `writes=[]`. No previous Tasks 1–12 matrix, real backend lab, hardware, deployment or remote write ran. Final Web static gates are owned by root and are not duplicated here.

## Original failures and investigation

The initial two failures preserved full viewport / fixed navigation assertions: short monitoring ticker bottom 591 exceeded navigation top 532; dark report reset bottom 844 exceeded navigation top 776. `scrollIntoViewIfNeeded()` only considers the browser viewport, so it can leave an action behind a fixed navigation overlay.

The harness now sends real document wheel input from x=2, outside canvas gesture capture, and measures again. No CSS, viewport, native event, timeout, skip or expectation threshold was fabricated or relaxed. The report reset moved from y=800/bottom=844/scrollY=5 to y=714/bottom=758/scrollY=91 with navTop=776, became reachable, and passed unchanged 44px/full visibility assertions.

Short monitoring was a confirmed product failure: at 390×600, documentHeight=779, document scrollY=179=max(779−600). Ticker action remained x=251.09375, y=547, width=109.90625, height=44, bottom=591, navTop=532, headerBottom=118, center reachable=false. An additional real body wheel delta 83 left scrollY=179 and identical bounds. Its bottom 59px was inaccessible beneath fixed navigation even at maximum document scroll. Returned to root/monitoring owner; assertions preserved. Ancestor scroll-container height/clientHeight/scrollTop/maximum diagnostics were added.

The product repair added `max-compact:min-h-min` to the existing monitoring screen, including its actual bottom navigation padding in the natural minimum. Final short data: documentHeight=847 / document clientHeight=600 / scrollY=247=max247; ticker action x251.09375,y479,width109.90625,height44,bottom523<navTop532, center reachable=true. The actual trailing scroll extent grew by exactly68px. Ancestors retained `overflowY:visible`; document HTML is the scroll owner (scrollHeight847,clientHeight600,scrollTop247). The 240px canvas minimum remains asserted, and tall maps retain630px height. No requirement was reduced to obtain this result.

## Successful geometry and visual inspection

Tall 578×1227: map x=15,y=350,width=548,height=630; containing panel y=300,height=841,bottom=1141; nav top=1159, gap=18. Four header cells all 131.5px wide. Zoom 52×52 at y=993/bottom=1045; ticker action 109.90625×44 at y=1088/bottom=1132; both reachable above navigation.

Tall 681×1227: map x=15,y=350,width=651,height=630; panel y=300,height=841,bottom=1141; nav top=1159, gap=18. Four header cells all 157.25px wide. Zoom 52×52 and ticker action 109.90625×44, both reachable above navigation.

PC: plain current-site information, no switcher/listbox, intrinsic header metrics (<260px, uniform 12px gap), removed monitoring eyebrow/map title; actual canvas loaded. Manual central selected list and upper-right clear, no right-side chips/brightness draft badge; brightness input DOM owner/value31 survived real theme toggle, resize and clear; writes0. Schedule sole CTA in list toolbar, cancel focus restoration, enabled-only activation/removed period caption, every non-name table column header/body center; groups removed Gateway column, ready badge-only, centered non-name cells; writes0.

Dark reports: controlled overview data/energy4.25/statistics SVG settled before checking single sr-only h1 height≤1/no overview CTA/ENERGY; actual completed report card settled. Common search/reset/filter/CSV entry worked without mutations. Actual measured reset width85.515625×44, final bottom758<nav776; CSV139.21875×44 bottom771; filter67.6875×44 bottom719. Popover targets retained unchanged 44×44 usable touch checks and horizontal overflow check. Reports' original formatted time tags remain visible while the removed timezone caption is absent.

The following PNGs were opened for actual rendered visual QA: light tall578 and681, original short monitoring failure, original dark reset failure, final dark reports. All show real fixture map markers/report content rather than loading placeholders.

Final repair's tall578/681 and short-manual PNGs were also opened and inspected. Short manual successfully measured full visible and reachable44px targets for list, pan, individual selection, area selection and zoom; preserved brightness value31; map minimum240; no horizontal overflow; writes0. Its final viewport screenshot shows the actual fixture map, legend/camera tools, central empty selection list and execution summary after natural scrolling. It does not claim a command was sent or a hardware result.

## Evidence paths (relative to checkout)

Original results preserved intact in `.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-initial-results/`, including five passing PNG+JSON metrics pairs and both original `test-failed-1.png`/`error-context.md`.

- Tall578: `apps/web/test-results/atlas-ui-fidelity-browser--42a8f-ills-remaining-shell-height-chromium/comments-tall-578.png` and `comments-tall-578-metrics.json`.
- Tall681: `apps/web/test-results/atlas-ui-fidelity-browser--eb1e4-ills-remaining-shell-height-chromium/comments-tall-681.png` and `comments-tall-681-metrics.json`.
- PC summary: `apps/web/test-results/atlas-ui-fidelity-browser--9d461-header-metrics-stay-compact-chromium/comments-pc-monitoring.png` and metrics JSON.
- Manual: `apps/web/test-results/atlas-ui-fidelity-browser--26c2b-e-brightness-draft-survives-chromium/comments-manual-central-clear.png` and metrics JSON.
- Tables: `apps/web/test-results/atlas-ui-fidelity-browser--7c80f-nment-preserve-read-only-UI-chromium/comments-pc-tables.png` and metrics JSON.
- Local short failure: `.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-local-results/atlas-ui-fidelity-browser--a9324-nitoring-and-manual-actions-chromium/test-failed-1.png` and `error-context.md`.
- Dark filters and final reports: `.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-local-results/atlas-ui-fidelity-browser--f1047-nd-filters-remain-reachable-chromium/comments-dark-reports-filters.png`, `comments-dark-reports.png` and corresponding JSON files; all PNG/JSON were also attached through `TestInfo.attach` using file paths.

Representative absolute PNG paths for root review (final monitoring source4802b641; dark statistics product sourcee9d72b91 unchanged by monitoring repair):

- `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-browser-comments-20261011/.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-final-results/atlas-ui-fidelity-browser--42a8f-ills-remaining-shell-height-chromium/comments-tall-578.png`
- `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-browser-comments-20261011/.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-final-results/atlas-ui-fidelity-browser--eb1e4-ills-remaining-shell-height-chromium/comments-tall-681.png`
- `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-browser-comments-20261011/.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-final-results/atlas-ui-fidelity-browser--a9324-nitoring-and-manual-actions-chromium/comments-short-manual.png`
- `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-browser-comments-20261011/.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-local-results/atlas-ui-fidelity-browser--f1047-nd-filters-remain-reachable-chromium/comments-dark-reports.png`

Each final PNG has an adjacent `*-metrics.json` and path-based attachment. Final short monitoring additionally has `comments-short-monitoring.png`/metrics in the short manual case directory. Original results remain preserved separately and are not replaced by passing evidence.

## Handoff

- Browser verification complete for this delegated scope; final test-only correction commit `72bbd2e1` created after root's serialization approval. This report and its generated screenshots/metrics remain in the explicitly requested ignored canonical checkout location. Post-run15186 listener check was empty (owned server stopped); final test diff whitespace check exit0.
- Root integrates static gates, final review and local merge separately. Controlled browser evidence is not hardware/HIL or native WebView evidence.

## Additional header overlap review (separate execution count)

Root's visual inspection of the PC1280 manual screenshot found summary text overlapping the bell/theme actions. The existing PC metrics case was strengthened in place (seven unique cases remain) to resize1440→1280→760, capture all three actual settled screenshots/bounds before asserting, and measure site context, summary `dl`, each actual cell, actions, and every button/account link center reachability. Intrinsic metrics<260px, gap12px, no document overflow and unchanged44px geometry/continuous touch criteria remain.

Additional RED command: `E2E_WEB_PORT=15186 pnpm --filter @led-control/web exec playwright test e2e/atlas-ui-fidelity.spec.ts --grep 'browser comments PC: current site' --workers=1 --reporter=list --output=/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-browser-comments-20261011/.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-header-red-results`. Exit1, one case failed. Original `CustomerShell.tsx` SHA256: `f822c2bdeca3a3c3e155041ea44a47699a9d50080b4f402761634b6c53c5a54d`.

RED1280: context x248..990.078125, summary dl x1006.078125..1072 (width65.921875) but actual children extend to1177.296875; actions start1088. Theme52×52 center is not reachable because summary content overlaps it. RED760: context108..536; summary552..552(width0) but children extend723.21875; actions568..732, theme center not reachable. Both still have gap12px and document scrollWidth=clientWidth, proving why the original compact/overflow checks alone missed the overlap. Original1440/1280/760 PNG+JSON and full error-context remain in `task-16-header-red-results/atlas-ui-fidelity-browser--9d461-header-metrics-stay-compact-chromium/`.

Owner repaired the desktop header column recipe to `[minmax(0,1fr)_auto_auto]`, reserving actual metrics/actions intrinsic widths while allowing the site text to truncate. GREEN attempt command is identical except output suffix `task-16-header-green-results`. Execution HEAD `45b22fcee4d3d1175ba8143ce22c82ba729ad728` with repaired working `CustomerShell.tsx` SHA256 `c2109b34f1fa751be38050eda5c63fb878e6f2ee235a19c89fc71c72953b8796`. Exit1, one case failed solely at the final shared continuous-touch helper. All three widths passed context/actual-cell/action NON-overlap, target center reachability, geometry≥44px, gap12px and no overflow assertions.

GREEN1280: context248..884.78125; summary900.78125..1072(width171.21875), every actual cell within summary; actions1088..1252. Bell/theme52×52 and account link44×44 all have center reachable=true. Final failure is the existing account link's44×44 rounded-control shape: shared helper measured geometryWidth=44,geometryHeight=44,hasMinimumArea=false for `내 계정 및 보안`. Bell/theme52×52 pass. This target was included because root requested each clickable header target; the criterion was not weakened or suppressed. Root/owner were notified for an explicit same-header scope ruling before further repair or rerun.

The1280 repaired-header PNG was opened and visually inspected; summary/actions no longer overlap. Intermediate additional executions: RED1 + attempted GREEN1, separate from the earlier three runs/twelve executions. No all-seven rerun occurred. All headerPNG+JSON files were saved with `TestInfo.outputPath` and attached by path.

Root's explicit ruling used `docs/ui-spacing.md:92` continuous44px hit-shape contract and authorized a same-header minimum repair rather than relaxing the test. Owner changed only the existing account `Link` target `min-h-11/min-w-11`→`min-h-13/min-w-13`, preserving its href/semantics/focus and mobile hiding. This rounded44×44 link defect predated the browser-comment correction and is recorded separately from the newly found summary overlap.

Final GREEN command is the same one-case command above with output suffix `task-16-header-final-results`. Exit0, one passed,8.9s. Execution source HEAD `b70f037f647addb5d6734fbd92c0ccd254c915e4`; actual `CustomerShell.tsx` SHA256 `d51f945290f73b0fee1394ea89a6e98f5b1fa21d84e0ae70b14b4e5dee814c1e`. Final1440/1280/760 context, actual four summary cells and actions are separate; all three clickable actions are52×52 and center reachable at each width; gap12px/no horizontal overflow/writes0. At the final760 viewport the unchanged shared continuous44px touch helper also passes for all three actual actions. Final760 context108..356.78125,summary372.78125..544(width171.21875),actions560..732(width172), with16px separation on both sides of summary. Final1280/760 PNGs were opened and visually inspected to confirm actual render. All source assertions remain unchanged from their relevant failing checks.

Final extra executions: three one-case runs (header RED1 + partial GREEN/link failure1 + final GREEN1). Combined with the original7+2+3, this is six runs/fifteen executions of seven unique cases. Existing Tasks1–12/full seven-suite replay never ran. Root authorized final test-only scoped commit; report/screenshots remain in the requested ignored canonical checkout. Last15186 listener check is empty and test diff whitespace check exit0.

Final header screenshot and adjacent JSON paths for durable root copy:

- `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-browser-comments-20261011/.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-header-final-results/atlas-ui-fidelity-browser--9d461-header-metrics-stay-compact-chromium/comments-pc-header-1440.png`
- `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-browser-comments-20261011/.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-header-final-results/atlas-ui-fidelity-browser--9d461-header-metrics-stay-compact-chromium/comments-pc-header-1440-metrics.json`
- `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-browser-comments-20261011/.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-header-final-results/atlas-ui-fidelity-browser--9d461-header-metrics-stay-compact-chromium/comments-pc-header-1280.png`
- `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-browser-comments-20261011/.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-header-final-results/atlas-ui-fidelity-browser--9d461-header-metrics-stay-compact-chromium/comments-pc-header-1280-metrics.json`
- `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-browser-comments-20261011/.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-header-final-results/atlas-ui-fidelity-browser--9d461-header-metrics-stay-compact-chromium/comments-pc-header-760.png`
- `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-browser-comments-20261011/.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-header-final-results/atlas-ui-fidelity-browser--9d461-header-metrics-stay-compact-chromium/comments-pc-header-760-metrics.json`

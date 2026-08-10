# Final Whole-Branch Review

- Range: f133473..681d818 (70 commits)
- Plan: docs/superpowers/plans/2026-07-21-settings-foundation-floor-editor.md
- Diff package: .superpowers/sdd/2026-07-21-settings-foundation-floor-editor/final-review-f133473..681d818.diff
- Review mode: read-only product and integration review

**Verdict: NOT READY**

**Finding counts: Critical 1, Important 6, Minor 2**

## Strengths

- The role and tenant model is substantially clearer than the base branch. SiteAccessService centralizes admin ownership, operator membership, capability checks, and opaque 404 behavior, while commissioning endpoints retain explicit operator guards.
- The migration is non-destructive toward existing domain rows, deliberately preserves legacy users, backfills existing customer viewers, and adds revision/audit structures without recreating Floor, Fixture, FloorPlan, or FloorMapObject data. All 17 migrations applied successfully to a fresh PostgreSQL database.
- Atomic save and restore use Serializable PostgreSQL transactions, optimistic mapRevision updates, canonical snapshots, SHA-256 metadata, revision rows, and audit rows. The real PostgreSQL integration suite passed all 12 cases, including rollback, stale revisions, cross-tenant access, restore, legacy state, and concurrent saves.
- The approved viewer floor-plan contract is implemented consistently: the floor list remains readable, direct editor URLs redirect before editor-state/lease calls, and mutation requests are rejected with 403 by the API.
- Redis lease acquire, renewal, release, stale-token handling, and force-release audit behavior are carefully implemented with token-checked Lua operations. The disposable real-Redis integration test passed.
- The browser regression exercises desktop/mobile layouts and 1,000 fixture rendering and selection. The editor computes an O(n) diff and sends only the changed fixture in that scenario.
- The Korean settings documentation honestly separates browser route fixtures from real backend, hardware, BLE, and staging evidence. Those missing external proofs are not counted as product defects below.

## Critical Findings (1)

### C1. The production web image does not build

**Locations:** apps/web/Dockerfile:5-10; apps/web/package.json:14-16; apps/web/container-contract.node.mjs:9-19

The Docker build copies only the root workspace manifests and apps/web. It does not copy packages/shared/package.json or the shared source, and it never builds @led-control/shared. A fresh build fails at Dockerfile line 10 with TS2307 for @led-control/shared in floor-editor.ts and editor-diff.ts. The local web build succeeds only because the host workspace already contains the built shared package.

The static container contract test still passes because it checks nginx text patterns and never builds the image. Therefore the documented production deep-route container cannot be produced from this branch.

**Fix:** Copy the shared package manifest before pnpm install, copy its source into the build stage, run the shared build before the web build, and add a real docker build smoke check to CI. Keep the nginx contract test, but do not use it as a substitute for constructing the image.

## Important Findings (6)

### I1. SiteMembership lifecycle and the viewer organization invariant are incomplete

**Locations:** apps/api/src/auth/auth.service.ts:73-93; apps/api/src/access/site-access.service.ts:16-31; apps/api/src/access/site-access.service.ts:54-58; apps/api/prisma/schema.prisma:536-547; apps/api/prisma/migrations/20260721120000_simplify_roles_and_floor_revisions/migration.sql:46-52; docs/database-schema.md:664-684

Invitation.siteId is documented as the target site, but signup consumes the invitation and creates only the User. It never creates the SiteMembership needed by a newly invited operator or viewer. The migration backfills only viewers who existed at migration time, and the only production membership writer is initial-site setup for the creating operator. New scoped users therefore have no usable site assignment path.

SiteAccessService also treats any membership as enough for viewer read access and lists every membership without checking that a viewer's Site belongs to the viewer's customer Organization. A malformed or future incorrectly assigned cross-customer membership therefore violates the stated tenant contract and exposes that site's data.

**Fix:** In the signup transaction, validate Invitation.siteId according to role and organization type and create the membership atomically for scoped roles, or explicitly reject signup until a valid assignment exists. For viewers, enforce Site.organizationId equals user.organizationId in both assert and listAccessibleSiteIds. Preserve the intended cross-customer assignment model only for service-provider operators. Add real PostgreSQL tests for viewer/operator invitation signup, missing assignments, and a cross-customer viewer membership.

### I2. Statistics ignores the selected site and can show data under the wrong site heading

**Locations:** apps/web/src/App.tsx:48-54; apps/web/src/App.tsx:108-114; apps/web/src/features/statistics/StatisticsView.tsx:1-8; apps/web/src/api/energy.ts:10-14; apps/api/src/energy/energy.service.ts:26-34; apps/api/src/access/site-access.service.ts:41-58

The shell reads the siteId query parameter and uses it for the top-bar dashboard, monitoring, control, and settings. Statistics receives no siteId, uses a global energy-estimate cache key, and calls /energy/default/estimate. The API then selects the first accessible membership/site without deterministic ordering.

For an operator or multi-site admin, switching to site B can leave the page labelled as site B while rendering energy from site A. The global query key also reuses the same result across site switches.

**Fix:** Add a site-scoped estimate endpoint, authorize it with SiteAccess read, pass siteId into StatisticsView, and key the query by siteId. Keep a deterministic default only as an explicit fallback. Add a two-site UI/API regression that verifies both the heading and energy values switch together.

### I3. Viewer control UI remains interactive even though the API correctly rejects it

**Locations:** apps/web/src/App.tsx:108-110; apps/web/src/features/control/ControlView.tsx:9-30; apps/web/src/features/control/ControlView.tsx:32-50; apps/web/src/features/control/ControlView.tsx:112-179; apps/api/src/commands/commands.service.ts:32-39; docs/menus/control.md:18-22

ControlView receives no user role. For a viewer it can display "transmission available", leaves the brightness, preset, target, and Apply controls active, and sends POST /commands/dimming. The API then returns 403 and the UI reports a generic device/gateway failure.

Server authorization remains secure, but the UI/API authorization contract and the menu documentation are inconsistent, and the failure message misdiagnoses a permissions denial as an equipment problem.

**Fix:** Pass the authenticated role into ControlView, render a clear read-only state for viewers, disable all mutation controls, and never issue the POST. Retain the server-side 403 and add viewer UI plus direct-API tests.

### I4. The Redis lease is advisory and is not fenced to save or restore

**Locations:** apps/api/src/floor-editor/floor-editor.controller.ts:40-65; apps/api/src/floor-editor/floor-editor.service.ts:125-165; apps/api/src/floor-editor/floor-editor.service.ts:205-277; apps/web/src/api/floor-editor.ts:39-40; apps/web/src/api/floor-editor.ts:63-67; apps/web/e2e/settings-floor-editor.spec.ts:99-120

Atomic save and restore accept expectedRevision but no lease token, and the service never asks EditorLeaseService to validate ownership. The browser contract test explicitly expects a save without any lease to return 200.

Revision checking prevents two atomic saves with the same revision from both committing, but it does not make the lease exclusive. An authorized stale or non-browser client can commit while another user holds the lease, making the legitimate holder lose with 409. An old in-flight request can also commit after its lease expires and a successor acquires the editor.

**Fix:** Require lease ownership for save and restore. Use a monotonic fencing value that is issued on acquisition and checked against Floor state inside the PostgreSQL transaction; a Redis-only precheck is insufficient because the lease can expire between the check and commit. Add two-client tests covering expiry or force-release, successor acquisition, stale-holder save/restore rejection, and successor commit.

### I5. Legacy editor mutations bypass revision, audit, and lease concurrency

**Locations:** apps/api/src/floor-editor/floor-editor.controller.ts:68-102; apps/api/src/floor-editor/floor-editor.service.ts:346-425; apps/api/src/floor-editor/floor-editor.integration.spec.ts:443-447; apps/web/src/api/floor-editor.ts:70-108; docs/menus/settings.md:131-137; docs/menus/settings.md:249-250; docs/menus/settings.md:299

The retained PATCH/POST/DELETE endpoints write normalized editor tables directly. They do not increment Floor.mapRevision, create FloorMapRevision, record floor-editor audit entries, or honor the editor lease. The integration suite explicitly verifies that a legacy mutation can leave mapRevision at 0 with no revision or audit row.

This makes the compatibility window unsafe: a new editor can hold baseline revision N, a legacy client can mutate the same floor without changing N, and the new editor can then save successfully instead of receiving 409, silently overwriting the legacy change. Revision history can also claim a latest snapshot that no longer matches current normalized rows.

**Fix:** During any rolling-deployment compatibility period, route every legacy mutation through the same revisioned, audited, fenced transaction, even if old clients cannot provide expectedRevision. Once the new web is deployed, remove the endpoints and unused client exports as the plan already requires. Add a legacy-versus-atomic race regression proving stale atomic clients receive 409.

### I6. Logout bypasses the dirty-navigation guard and discards unsaved editor state

**Locations:** apps/web/src/App.tsx:57-60; apps/web/src/App.tsx:102-104; apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx:241-330

The dirty guard handles beforeunload, anchors, browser history, cancel, and the site switcher. The always-visible Logout control is a button, so the anchor capture does not see it. handleLogout immediately revokes the session and clears React Query. A user can therefore edit a map, click Logout, and lose the draft without the promised confirmation.

**Fix:** Move dirty-state blocking into a shared authenticated-shell navigation/logout guard, or make logout request confirmation through the editor guard before revoking the session. Clear the draft and query cache only after approval. Add a real BrowserRouter/Playwright regression for cancel and confirm logout from a dirty editor.

## Minor Findings (2)

### M1. Completion tracking and Korean menu documentation contradict the implementation

**Locations:** docs/menus/settings.md:269; docs/menus/settings.md:293; docs/menus/statistics.md:11; docs/menus/monitoring.md:26; docs/menus/control.md:20; .superpowers/sdd/progress.md:71-75; docs/superpowers/plans/2026-07-21-settings-foundation-floor-editor.md:817-852; docs/superpowers/plans/2026-07-21-settings-foundation-floor-editor.md:870-927

Settings lists SiteMembership-scoped APIs as unimplemented even though they are central to this branch. It links readers to the stale root ledger, which still marks Tasks 7-11 pending, while the scoped ledger marks them complete. Statistics still describes organization-default behavior, monitoring documents a nonexistent /floors/:floorId/fixtures route instead of the site-scoped route, and control claims viewer UI disabling that does not exist. Task 10 and 11 checkboxes also remain unchecked despite the completion ledger.

**Fix:** Make the scoped ledger canonical and link it directly, reconcile the plan/root ledger status, correct the route and selected-site descriptions, and update control documentation together with I3. This is also required by the plan's documentation completion condition.

### M2. The site switcher drops the customer name returned for cross-customer operators

**Locations:** apps/api/src/sites/sites.service.ts:13-22; apps/web/src/api/queries.ts:46-60; apps/web/src/features/sites/SiteSwitcher.tsx:30-36

GET /sites returns customerName, but the web type discards it and the selector renders only site.name. A service-provider operator assigned to identically named sites at different customers cannot distinguish them, increasing the chance of acting on the wrong tenant.

**Fix:** Preserve customerName in SiteSummary and render customer plus site for operators, with a duplicate-name regression.

## Residual Risks

- Browser role flows use Playwright route fixtures. The real-auth browser test was skipped, so there is no staging proof of cookie/session, UI, API, PostgreSQL, and Redis operating as one end-to-end system. This is evidence debt, not an additional product finding.
- The disposable PostgreSQL migration and 12 floor-editor integration tests passed, but no production-clone migration rehearsal or large legacy-data timing was available.
- The real-Redis test covers token Lua behavior, not Redis failover, multi-instance API fencing, or a full save transaction. I4 is the concrete product gap; infrastructure failover remains a separate operational risk.
- The 1,000 fixture browser case passed, and a disposable local PostgreSQL restore of 1,000 fixtures completed in about 2.36 seconds. Authenticated API p95, remote-database latency, revision-retention growth, and the current large Vite chunks remain unverified at staging scale.
- The object-storage integration and private floor-plan delivery pipeline were not proven. Long-lived public asset URLs are already documented as a follow-up and must be treated as a production rollout gate for sensitive building plans.
- Raspberry Pi, ESP32-H2, BLE mesh, claim/provisioning, command delivery, and OTA hardware evidence remain absent as documented. They are not included in the finding counts above.

## Verification Evidence

- pnpm typecheck: passed.
- pnpm lint: passed.
- pnpm test: passed across the workspace; API 318, web 131, gateway 115, shared 14, mobile 1, and root 14 tests passed, with environment-gated suites skipped by default.
- Targeted Playwright settings, 1,000 fixture, and layout regression: 7 passed.
- Fresh PostgreSQL prisma migrate deploy: all 17 migrations applied.
- Real PostgreSQL floor-editor integration: 12 passed.
- Real Redis lease integration: 1 passed.
- Local pnpm web production build: passed with existing chunk-size warnings.
- Static web container contract: passed.
- Fresh docker build for apps/web/Dockerfile: failed because @led-control/shared is absent from the image build context.

## Final Verdict

**NOT READY.** The production image failure alone blocks release. Tenant membership lifecycle, selected-site statistics, viewer control consistency, lease fencing, legacy mutation coexistence, and logout data loss also prevent the branch from meeting its production and plan-completion claims. The missing hardware and staging evidence is explicitly separated as residual risk and is not the reason for this verdict.

## Scoped Final Re-review

Scope: corrective range `681d818..aafadf5` only. This adjudication re-checks the original C1, I1-I6, and M1-M2 findings. Per the requested scope, it relies on the corrective diff, the fix report, and focused source/test inspection; full suites were not rerun. Previously documented hardware and staging evidence gaps remain residual risks, not findings in this re-review.

### Resolved Findings

- **C1 - RESOLVED.** The web image now copies and builds `@led-control/shared` before the application build (`apps/web/Dockerfile:5-13`). The container contract checks that workspace dependency explicitly and executes a real Docker build when Docker is available (`tests/container-contract.node.mjs:64-93`). The fix report records a successful fresh image build.
- **I1 - RESOLVED.** Signup validates the invitation's site assignment inside the same serializable transaction that consumes the invitation and creates both the user and membership (`apps/api/src/auth/auth.service.ts:73-105`, `apps/api/src/auth/auth.service.ts:216-258`). Viewer access additionally requires a membership whose site belongs to the user's organization (`apps/api/src/sites/site-access.service.ts:27-59`). Real-PostgreSQL tests cover missing and cross-organization sites plus concurrent rollback without consuming the invitation (`apps/api/test/auth.integration.spec.ts:194-397`).
- **I2 - RESOLVED.** Statistics is site-scoped end to end: the API accepts and authorizes `siteId`, the query key and request URL include it, and switching sites fetches and displays the selected site's result (`apps/api/src/energy/energy.controller.ts:22-28`, `apps/web/src/hooks/useEnergyEstimate.ts:6-16`, `apps/web/src/App.test.tsx:1487-1572`).
- **I3 - RESOLVED.** `ControlView` receives the authenticated role and disables every command-producing control for viewers while guarding submission itself (`apps/web/src/App.tsx:386-393`, `apps/web/src/components/ControlView.tsx:89-175`). Regression coverage verifies that viewer interaction sends no control mutation (`apps/web/src/App.test.tsx:1212-1274`); API mutation authorization remains authoritative.
- **I4 - RESOLVED.** Lease ownership is now fenced by a monotonically increasing PostgreSQL fence plus token hash. Acquire, renew, release, save, and restore lock the floor row and evaluate authoritative database time after lock acquisition (`apps/api/src/floors/editor-lease.service.ts:64-174`, `apps/api/src/floors/floor-editor.service.ts:495-543`). Therefore a save that linearizes before expiry completes before a successor can acquire, while a stale or lock-waiting predecessor fails after the successor advances the fence. Redis is only a best-effort mirror, so cache loss cannot bypass the PostgreSQL check. The restored integration cases exercise expiry during lock waits, Redis deletion, successor acquisition, force release, and stale save/restore rejection (`apps/api/test/editor-lease.integration.spec.ts:227-430`).
- **I5 - RESOLVED.** The three legacy mutation routes and their service implementations were removed; the controller exposes only the atomic revision endpoints (`apps/api/src/floors/floor-editor.controller.ts:38-66`). Web callers use atomic save/restore only, and the controller contract test asserts the old handlers are absent (`apps/api/src/floors/floor-editor.controller.spec.ts:169-177`).
- **I6 - RESOLVED.** Logout checks both the editor store and history sentinel before invalidating auth. Cancellation preserves the session and draft; confirmation discards the draft before logout and clears authenticated query state (`apps/web/src/App.tsx:59-78`). Unit and browser regressions cover both branches (`apps/web/src/App.test.tsx:1818-1918`, `apps/web/e2e/settings-floor-editor.spec.ts:688-741`).
- **M2 - RESOLVED.** Site summaries retain `customerName`, and the switcher renders customer plus site with a fallback; duplicate-name coverage verifies disambiguation (`apps/web/src/types/site.ts:1-7`, `apps/web/src/components/SiteSwitcher.tsx:51-68`, `apps/web/src/components/SiteSwitcher.test.tsx:82-105`).
- **Test-integrity concern - RESOLVED.** The final corrective commits restore real PostgreSQL invitation transaction tests and PostgreSQL-plus-Redis lease/save race tests. Legacy endpoint tests disappeared because those endpoints were intentionally removed, while legacy persisted-data save/restore compatibility remains covered in `apps/api/src/floors/floor-editor.service.spec.ts:543-831`. The remaining production revision paths retain database integration coverage in `apps/api/test/floor-editor.integration.spec.ts:251-510`.

### Open Finding

- **M1 - PARTIALLY RESOLVED, still open (Minor).** The ledgers and most menu documentation now match the implementation, but three concrete documentation contradictions remain:
  - `docs/menus/monitoring.md:26` documents `GET /floors/:floorId/fixtures`; the implemented route is `GET /sites/:siteId/floors/:floorId/fixtures` (`apps/api/src/fixtures/fixtures.controller.ts:7`).
  - `docs/menus/settings.md:267` still lists SiteMembership-based site scoping as unimplemented even though signup and `SiteAccessService` now enforce it. If this means membership administration, it must say so explicitly; otherwise remove the item.
  - `docs/database-schema.md:238` describes `Floor.editorLeaseHolderId` as a foreign key to `User.id`, but both the Prisma model and migration store a nullable scalar without a relation or foreign-key constraint (`apps/api/prisma/schema.prisma:157`, `apps/api/prisma/migrations/20260808124000_add_floor_editor_lease/migration.sql:4`). Correct the schema document or add the documented constraint in a separately reviewed migration.

### Residual Risk Adjudication

The original real-hardware, staging, failover, production-clone migration, object-storage, and remote-latency gaps remain accurately documented. They were not introduced or concealed by this corrective range and do not reopen C1 or I1-I6. The fix report's full-suite, browser, integration, workspace-build, and Docker results were reviewed as supplied rather than rerun in this intentionally scoped pass.

### Scoped Verdict

**READY, with one non-blocking Minor documentation finding.** Open counts: Critical 0, Important 0, Minor 1. All original release-blocking correctness and security findings are resolved; M1 remains open only for the precise documentation corrections above.

## Orchestrator Closure

The remaining M1 documentation inconsistencies were resolved in `f3c6e4d`:

- monitoring now documents `GET /sites/:siteId/floors/:floorId/fixtures`
- settings distinguishes implemented SiteMembership access APIs from the still-unimplemented user and operator-assignment management UI
- the database schema document records `editorLeaseHolderId` as an intentionally unconstrained snapshot field rather than a foreign key

Fresh orchestrator verification then passed workspace typecheck, lint and tests, focused Playwright 6/6, API/Web builds, the real Docker image smoke build, PostgreSQL migration and invitation/revision integration, PostgreSQL+Redis lease integration, and `git diff --check`.

**Closure verdict: READY. Open counts: Critical 0, Important 0, Minor 0.**

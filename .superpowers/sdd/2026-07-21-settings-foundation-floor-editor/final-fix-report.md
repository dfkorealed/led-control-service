# Final Fix Report

기준 계획: `docs/superpowers/plans/2026-07-21-settings-foundation-floor-editor.md`
기준 리뷰: `.superpowers/sdd/2026-07-21-settings-foundation-floor-editor/final-review.md`
Fix wave base: `681d818173c6f8cdac9c2cf8bd6707d74ac638a9`

## Commits

- `219dfe3` `fix(access): enforce scoped site selection contracts`
- `cc72fa7` `fix(floor-editor): fence saves and remove legacy mutations`
- `2c2eb5b` `docs(settings): reconcile ledgers and final fix evidence`
- `ef1c577` `fix(auth-statistics): harden signup rollback and site switching`
- `3e41953` `fix(floor-editor): restore coverage and authoritative lease timing`
- `e773d5e` `docs(settings): record corrective final-fix evidence`
- `ca2cce8` `test(auth): pin admin organization-wide signup`

## Corrective Follow-up

- 2026-08-10 self-audit found three concrete gaps after `219dfe3`/`cc72fa7`/`2c2eb5b`:
  - restored floor-editor coverage had been weakened instead of adapted
  - AuthService signup had no self-contained real PostgreSQL integration for atomic scoped membership creation/rollback
  - authoritative lease time was still captured too early for row-lock wait expiry checks, and the statistics regression did not exercise the real selected-site UUID path
- `ef1c577` adds the missing real PostgreSQL signup coverage, maps concurrent signup unique conflicts back to the existing Bad Request contract, and hardens the selected-site statistics regression with real route/site switching.
- `3e41953` restores the pre-`681d818` floor-editor save/restore coverage footprint, adds new real PostgreSQL/Redis stale-successor expiry and force-release regressions, and changes both lease validators to read PostgreSQL time only after the authority row lock is acquired.

## Findings

### C1. Web Docker image now includes and builds `@led-control/shared`

- RED:
  - authoritative whole-branch review recorded the pre-fix failure: fresh `apps/web/Dockerfile` builds failed with `TS2307` because the image did not copy or build `packages/shared`
  - the new regression contract was written first in `apps/web/container-contract.node.mjs` to assert shared workspace manifests/source are copied and the shared package is built before `@led-control/web`
- GREEN:
  - `node --test apps/web/container-contract.node.mjs`
  - static nginx/API contract 3/3 passed
  - Docker smoke build passed on this machine with Docker available

### I1. Invitation signup now creates valid scoped memberships and rejects invalid viewer assignments

- RED:
  - `apps/api/src/auth/auth.service.spec.ts` initially failed because signup consumed the invitation without creating `SiteMembership`, and viewer invitations with missing or cross-customer `siteId` were not rejected
  - `apps/api/src/access/site-access.service.spec.ts` initially failed because a malformed cross-customer viewer membership still granted read access and appeared in accessible-site lists
  - `AUTH_TEST_DATABASE_URL='postgresql://led:led@127.0.0.1:54329/led_control?schema=public' pnpm --filter @led-control/api exec jest src/auth/auth.integration.spec.ts --runInBand`
  - the new real PostgreSQL suite first failed during the corrective pass because concurrent signup surfaced a raw Prisma `P2002` instead of the branch’s Bad Request contract
- GREEN:
  - `pnpm test`
  - `AUTH_TEST_DATABASE_URL='postgresql://led:led@127.0.0.1:54329/led_control?schema=public' pnpm --filter @led-control/api exec jest src/auth/auth.integration.spec.ts --runInBand`
  - real PostgreSQL signup coverage now proves:
    - operator invitation signup creates `SiteMembership` atomically
    - viewer invitation signup creates `SiteMembership` atomically
    - missing/cross-organization viewer assignments are rejected without consuming the invitation
    - the invalid-site defensive branch is exercised through a Prisma query extension because the database foreign key prevents persisting a dangling invitation `siteId`
    - transaction rollback leaves both invitation and membership unchanged when a competing signup wins after the precheck
  - focused unit coverage proves admin signup remains organization-wide and does not query a site or create `SiteMembership`, even if the invitation carries `siteId`
  - `site-access.service.spec.ts` continues to enforce the viewer organization invariant in both `assert` and `listAccessibleSiteIds`

### I2. Statistics now follows the selected site and uses site-scoped auth/cache keys

- RED:
  - `apps/web/src/App.test.tsx` initially failed because `/statistics?siteId=site-2` still called `/energy/default/estimate`
  - the corrective regression `switches statistics estimates with the selected site instead of reusing another site's cache` first failed because the mock still exercised a stale hard-coded site id instead of the real selected-site UUID path
- GREEN:
  - `pnpm test`
  - `pnpm --filter @led-control/web exec vitest run src/App.test.tsx -t "statistics"`
  - `pnpm --filter @led-control/api exec jest src/energy/energy.service.spec.ts --runInBand`
  - web coverage now proves both the initial site-scoped fetch and a two-site route switch with distinct query keys and values
  - API coverage now proves site-scoped authorization/isolation and a deterministic explicit fallback ordering

### I3. Viewer control is now clearly read-only and never posts a mutation

- RED:
  - `apps/web/src/App.test.tsx` regression `renders control as read-only for viewers and never posts a command` failed before the fix because the viewer UI left mutation controls active and attempted `POST /commands/dimming`
- GREEN:
  - `pnpm test`
  - viewer control tests now assert disabled controls, no POST, and no misleading device-failure message
  - direct API authorization remains covered by existing `403` command tests

### I4. Lease authority is now PostgreSQL-fenced inside the save/restore transaction

- RED:
  - `apps/api/src/floor-editor/editor-lease.integration.spec.ts` initially failed because a stale predecessor could still save or restore after expiry/force-release and successor acquisition
  - `apps/web/src/api/floor-editor.test.ts` initially failed because `leaseToken` and `leaseFence` were not propagated
  - the corrective row-lock regressions first failed because both `EditorLeaseService` and `FloorEditorService` captured `dbNow` too early, before PostgreSQL finished waiting on the locked authority row
- GREEN:
  - `DATABASE_URL='postgresql://led:led@127.0.0.1:54329/led_control?schema=public' FLOOR_EDITOR_TEST_DATABASE_URL='postgresql://led:led@127.0.0.1:54329/led_control?schema=public' pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.integration.spec.ts --runInBand`
  - `DATABASE_URL='postgresql://led:led@127.0.0.1:54329/led_control?schema=public' FLOOR_EDITOR_TEST_DATABASE_URL='postgresql://led:led@127.0.0.1:54329/led_control?schema=public' REDIS_URL='redis://127.0.0.1:6389/15' RUN_REDIS_INTEGRATION='true' pnpm --filter @led-control/api exec jest src/floor-editor/editor-lease.integration.spec.ts --runInBand`
  - `pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.service.spec.ts src/floor-editor/editor-lease.service.spec.ts --runInBand`
  - coverage now includes:
    - restored non-legacy atomic save/restore, rollback, asset, validation, tenant-opacity, revision/audit, and concurrency coverage adapted to `leaseToken`/`leaseFence`
    - real PostgreSQL + Redis successor fencing after expiry and force release
    - stale predecessor save and restore rejection even when Redis state is missing
    - valid successor save and restore success
    - save/restore and renew expiry rejection after authoritative PostgreSQL row-lock waits
    - Redis release failure tolerance with PostgreSQL authority preserved
    - `leaseFence` validation aligned to PostgreSQL `INT4`
    - independent final `mapRevision` conflict guarding

### I5. Legacy editor mutation endpoints and unused web exports are removed

- RED:
  - `apps/api/src/floor-editor/floor-editor.controller.spec.ts` regression `removes legacy per-object mutation handlers once atomic editor save is authoritative` failed before the fix because the legacy mutation handlers were still mounted
  - the whole-branch review also documented the stale-overwrite bypass via the legacy path
- GREEN:
  - `pnpm test`
  - controller/service/web export coverage now proves only the fenced atomic editor path remains

### I6. Dirty editor logout now confirms before session revoke and preserves the draft on cancel

- RED:
  - browser regression initially failed in Playwright because the shell did not reliably transition back to the login view after a confirmed logout
  - focused unit regression was then added first in `apps/web/src/App.test.tsx` to pin the auth-query transition
- GREEN:
  - `pnpm --filter @led-control/web exec vitest run src/App.test.tsx -t "returns to the login view after a confirmed logout from a dirty editor"`
  - `pnpm --filter @led-control/web exec playwright test e2e/settings-floor-editor.spec.ts --grep "dirty editor logout keeps the draft on cancel and logs out only after confirmation"`
  - cancel keeps the editor route and session; confirm discards dirty state, posts `/auth/logout`, and returns to the login screen

### M1. Canonical docs/routes/selected-site ledger status are reconciled

- RED:
  - the whole-branch review recorded stale Task 10/11 checkbox state and menu/root-ledger contradictions
- GREEN:
  - updated:
    - `docs/menus/control.md`
    - `docs/menus/settings.md`
    - `docs/menus/statistics.md`
    - `docs/database-schema.md`
    - `docs/superpowers/plans/2026-07-21-settings-foundation-floor-editor.md`
    - `.superpowers/sdd/progress.md`
    - `.superpowers/sdd/2026-07-21-settings-foundation-floor-editor/progress.md`
  - historical truth is preserved and the final fix wave is recorded as a post-Task-11 whole-branch correction

### M2. Site selector now preserves and renders `customerName`

- RED:
  - `apps/web/src/features/sites/SiteSwitcher.test.tsx` duplicate-site-name regression failed before the fix because the selector discarded `customerName`
- GREEN:
  - `pnpm test`
  - duplicate customer/site-name coverage now renders `고객사명 · 현장명`

## Migrations

- Added Prisma migration: `apps/api/prisma/migrations/20260810104000_add_floor_editor_lease_authority/migration.sql`
- Added `Floor.editorLeaseFence`, `editorLeaseTokenHash`, `editorLeaseHolderId`, `editorLeaseHolderName`, `editorLeaseAcquiredAt`, `editorLeaseExpiresAt`

## Verification

- `pnpm typecheck` — passed
- `pnpm lint` — passed
- `pnpm test` — passed
  - root node tests 14 passed
  - shared 14 passed
  - web 137 passed
  - api 305 passed, 25 skipped
  - gateway 115 passed
  - mobile 1 passed
- `DATABASE_URL='postgresql://led:led@127.0.0.1:54329/led_control?schema=public' pnpm --filter @led-control/api exec prisma migrate deploy` — passed
- `DATABASE_URL='postgresql://led:led@127.0.0.1:54329/led_control?schema=public' pnpm --filter @led-control/api exec prisma migrate reset --force --skip-seed` — passed on disposable DB
- `AUTH_TEST_DATABASE_URL='postgresql://led:led@127.0.0.1:54329/led_control?schema=public' pnpm --filter @led-control/api exec jest src/auth/auth.integration.spec.ts --runInBand` — 6 passed
- `pnpm --filter @led-control/api exec jest src/auth/auth.service.spec.ts --runInBand` — 10 passed
- `DATABASE_URL='postgresql://led:led@127.0.0.1:54329/led_control?schema=public' FLOOR_EDITOR_TEST_DATABASE_URL='postgresql://led:led@127.0.0.1:54329/led_control?schema=public' pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.integration.spec.ts --runInBand` — 9 passed
- `DATABASE_URL='postgresql://led:led@127.0.0.1:54329/led_control?schema=public' FLOOR_EDITOR_TEST_DATABASE_URL='postgresql://led:led@127.0.0.1:54329/led_control?schema=public' REDIS_URL='redis://127.0.0.1:6389/15' RUN_REDIS_INTEGRATION='true' pnpm --filter @led-control/api exec jest src/floor-editor/editor-lease.integration.spec.ts --runInBand` — 6 passed
- `pnpm --filter @led-control/web exec playwright test e2e/settings-floor-editor.spec.ts e2e/monitoring-1000.spec.ts` — 6 passed
- `pnpm --filter @led-control/web build && pnpm --filter @led-control/api build` — passed
- `node --test apps/web/container-contract.node.mjs` — 3 passed, including Docker smoke build
- `docker build -f apps/web/Dockerfile -t led-control-web-fixwave .` — passed
- `git diff --check` — passed

## Residual Risks

- Browser E2E still uses route fixtures, so this wave does not add a staging-authenticated full-stack browser proof of cookie/session + PostgreSQL + Redis together.
- Web production build still emits large Vite chunk warnings; this is unchanged evidence debt, not a correctness regression.
- Hardware, BLE mesh, Raspberry Pi, and ESP32-H2 evidence remain out of scope for this fix wave and are unchanged from the final review residual risks.

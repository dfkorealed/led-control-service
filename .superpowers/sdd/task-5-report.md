# Task 5 Report

## Status

DONE

## Commit

- Task implementation: `b62167e4d2f94d7eeb4e451ab888936103b2f0c3` (`feat(setup): restrict commissioning to assigned operators`)

## Changed Files

- Setup: `apps/api/src/setup/setup.controller.ts`, `setup.service.ts`, and focused specs now create customer Organization, Site, Floors, and operator SiteMembership in one Serializable transaction.
- Commissioning: `apps/api/src/gateway-onboarding/*` and `apps/api/src/registration/*` now require operator role plus SiteAccess `commission`; customer admin/viewer receive 403 and unassigned operators receive opaque 404 from SiteAccess.
- Floor assets: `apps/api/src/floor-editor/floor-assets.*` now use SiteAccess `read` for ready-asset listing and `manage` for upload intent/complete.
- Web: `apps/web/src/api/setup.ts`, `features/setup/SetupWizard.tsx`, `App.tsx`, settings, and monitoring now require customer company name and render installation-pending for admin/viewer with no accessible site.
- Docs: `docs/menus/settings.md` and `docs/menus/monitoring.md` reflect the new commissioning and empty-state contracts.
- Regression coverage: focused API/web specs and the gateway PKI E2E fixture were updated for typed operators and memberships.

## Verification

Executed after the final code changes:

```text
pnpm --filter @led-control/api exec jest src/setup src/gateway-onboarding src/registration src/floor-editor/floor-assets.service.spec.ts --runInBand
PASS: 8 test suites, 42 tests

pnpm --filter @led-control/web exec vitest run src/features/setup src/App.test.tsx
PASS: 3 test files, 25 tests

pnpm --filter @led-control/api typecheck
PASS: shared build and tsc --noEmit

pnpm --filter @led-control/web typecheck
PASS: tsc --noEmit
```

## Self-Review

- Confirmed setup no longer injects the service-provider organization into a customer site; the created customer Organization ID is used for the Site and the operator membership is created in the same Serializable transaction.
- Confirmed controller roles guards and service-level role checks both protect gateway claim/inventory and every registration-session action.
- Confirmed SiteAccess is called before commissioning mutations, preserving opaque 404 behavior for unassigned/cross-tenant operators.
- Confirmed customer admin can manage floor asset uploads while viewer can only use the read path.
- Confirmed the empty dashboard shape and production runtime mock-device policy were not changed.

## Concerns

- No database-backed end-to-end commissioning run was executed because Task 5 requested focused unit/web tests and typechecks only. The database-gated PKI E2E test fixture was updated to model the required service-provider operator membership.

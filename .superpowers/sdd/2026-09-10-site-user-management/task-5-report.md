# Task 5 Report: Dashboard Capability and Manual Control Authorization

## Scope

- Added the persisted `SiteCapabilities` matrix to non-empty and empty dashboard responses.
- Changed manual dimming command authorization from the old role-wide viewer rejection and `manage` requirement to the `control` capability.
- Reauthorized manual dimming writes inside the transaction with `assertControlInTransaction`, including the unique-conflict retry transaction.
- Kept schedule, vehicle event, fixture group, registration, and floor editor authorization unchanged. Their existing `manage` or `commission` checks continue to require the assigned admin.

## TDD Evidence

1. Added dashboard capability matrix expectations for assigned admin, read member, and control member. Added manual command expectations for read rejection and control-member transaction reauthorization.
2. RED command:

   ```sh
   pnpm --filter @led-control/api exec jest src/sites/sites.service.spec.ts src/commands/commands.service.spec.ts --runInBand
   ```

   Result: failed as expected. The dashboard did not include `capabilities`; manual commands still rejected every `viewer` role and used `manage` transaction authorization.

3. Implemented dashboard capability projection and control authorization.
4. GREEN command:

   ```sh
   pnpm --filter @led-control/api exec jest src/sites/sites.service.spec.ts src/commands/commands.service.spec.ts --runInBand
   ```

   Result: 32 tests passed.

## Regression Verification

```sh
pnpm --filter @led-control/api exec jest src/sites/sites.service.spec.ts src/commands/commands.service.spec.ts src/automation src/fixture-groups src/registration src/floor-editor --runInBand
```

Result: 23 suites passed, 4 integration suites skipped because their optional database configuration was unset; 266 tests passed and 71 were skipped.

```sh
pnpm --filter @led-control/api typecheck
git diff --check -- apps/api/src/sites/sites.service.ts apps/api/src/sites/sites.service.spec.ts apps/api/src/commands/commands.service.ts apps/api/src/commands/commands.service.spec.ts
```

Result: API typecheck and whitespace validation passed.

## Self-review

- Dashboard reads capabilities only through `SiteAccessService.capabilities`, so the response uses the same assigned-admin and membership `read/control` matrix as server authorization.
- Manual command creation performs a cheap preflight `control` check, then reauthorizes after the transaction lock. A read member is denied before the write transaction and a control member cannot inherit any admin-only capability.
- Existing automation, fixture-group, registration, and floor-editor suites passed without changing their source. This preserves their admin-only `manage` or `commission` contracts.
- The Task 5 ruling now limits this work to existing manual brightness command creation. The repository has no manual-command cancellation API, UI, or device contract; any future cancellation feature requires a separately scoped design.

## Files

- `apps/api/src/sites/sites.service.ts`
- `apps/api/src/sites/sites.service.spec.ts`
- `apps/api/src/commands/commands.service.ts`
- `apps/api/src/commands/commands.service.spec.ts`

## Fix Round 1

### 1. Setup dashboard cache safety

- `completeInitialSite` and `addFloors` now call `SitesService.getDashboard(user, siteId)` after their committed transaction instead of capability-free `getDashboardById`.
- Service tests require both responses to retain the caller-scoped capability matrix. The controller contract test verifies both routes return that response unchanged.
- RED command:

  ```sh
  pnpm --filter @led-control/api exec jest src/setup/setup.service.spec.ts src/setup/setup.controller.spec.ts --runInBand
  ```

  Result: 2 expected failures. Both setup mutations still called `getDashboardById`, so no caller-scoped dashboard cache payload could be guaranteed.

- GREEN command: the same command passed 13 tests after switching to `getDashboard(user, siteId)`.

### 2. Concurrent client-request recovery authorization

- Added a regression case where the first transaction reaches a client-request unique conflict and the second transaction observes `control -> read` access. The request now returns 403 before it can read or return the concurrent command.
- The current implementation already used `assertControlInTransaction` in both transactions. To prove the new test detects the intended regression, the retry path was temporarily changed to `assertManageInTransaction`; the focused case failed because it returned the existing command. The source was restored to `assertControlInTransaction` and the full command suite passed.

### Fix Round Verification

```sh
pnpm --filter @led-control/api exec jest src/setup src/commands/commands.service.spec.ts src/sites/sites.service.spec.ts --runInBand
pnpm --filter @led-control/api typecheck
pnpm --filter @led-control/api build
```

Result: focused tests passed (`46 passed`, `4` optional database tests skipped), API typecheck passed, and API build passed.

### Fix Round Self-review

- Setup mutations obtain the dashboard only after their serializable transaction commits. `getDashboard` rechecks the caller's readable access and returns the same capability contract used by normal dashboard requests.
- The retry authorization occurs before the retry transaction reads the idempotent command, so a user whose membership was downgraded cannot retrieve a prior command through the duplicate request path.
- No spec or plan ruling files were staged or changed by this fix round.

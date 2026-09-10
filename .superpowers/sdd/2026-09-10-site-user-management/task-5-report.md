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
- The current repository has no manual-command cancellation controller route, service method, shared request schema, or Web caller. Therefore no cancellation behavior could be safely tested or changed within the Task 5 file boundary. Adding it requires a separately scoped API contract and an explicit device/automation behavior decision for ending an active manual override.

## Files

- `apps/api/src/sites/sites.service.ts`
- `apps/api/src/sites/sites.service.spec.ts`
- `apps/api/src/commands/commands.service.ts`
- `apps/api/src/commands/commands.service.spec.ts`

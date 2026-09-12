# Task 2 — Heatmap API report

## Implementation

- Added `EnergyHeatmapService` as the reusable aggregation boundary for both the HTTP endpoint and the later report-document builder.
- Added authenticated `GET /energy/sites/:siteId/heatmap` routing and registered the service in `EnergyModule`.
- The service parses the request with `energyHeatmapQuerySchema` and validates its serialized response with `energyHeatmapResponseSchema`.
- Aggregation always emits the contract-required 168 `(weekday, hour)` cells in weekday/hour order. Energy sums `estimatedKwh`; brightness is `brightnessWeightedSeconds / knownSeconds`.
- A cell with observed seconds and zero energy/brightness is serialized as `0`; one with no known seconds is `null`. Multiple UTC buckets for the same local weekday/hour, including the repeated fall-back DST hour, share one cell.
- Selection applies fixture tracking/retirement validity, floor dimension validity, and group identity/dimension/membership validity at every aggregate's local date.
- Site read authorization occurs before the site, scope, or hourly-aggregate queries. Site-scoped identity lookup always includes `siteId`, so foreign fixture, floor, and group identities produce `404`.

## TDD evidence

1. Added the service and integration specs before creating `energy-heatmap.service.ts`.
2. RED command:

   ```text
   pnpm --filter @led-control/api exec jest src/energy/energy-heatmap.service.spec.ts --runInBand
   ```

   Result: failed because `./energy-heatmap.service` did not exist (`TS2307`).
3. Added the endpoint delegation expectation before the controller method and dependency were added.
4. RED command repeated with the focused spec.

   Result: failed because `EnergyController` had one constructor argument and no `getSiteHeatmap` method (`TS2554`, `TS2339`).
5. Implemented the minimum service, route, and module registration; then reran the focused spec.

   Result: 5 passed, 0 failed.

## Verification

| Command | Result |
| --- | --- |
| `pnpm --filter @led-control/api exec jest src/energy/energy-heatmap.service.spec.ts --runInBand` | 1 suite passed; 5 tests passed |
| `pnpm --filter @led-control/api exec jest src/energy/energy-heatmap.integration.spec.ts --runInBand` | skipped because neither `ENERGY_QUERY_TEST_DATABASE_URL` nor `FIXTURE_STATE_TEST_DATABASE_URL` was set |
| `pnpm --filter @led-control/api exec jest src/energy/energy.controller.spec.ts src/energy/energy-heatmap.service.spec.ts src/energy/energy-heatmap.integration.spec.ts --runInBand` | 2 suites passed / 1 skipped; 7 tests passed / 1 skipped |
| `pnpm --filter @led-control/api typecheck` | passed |
| `git diff --check` | passed |
| `pnpm --filter @led-control/api test -- --runInBand` | 102 suites passed / 22 skipped; 948 tests passed / 196 skipped |

## Files

- `apps/api/src/energy/energy-heatmap.service.ts`
- `apps/api/src/energy/energy-heatmap.service.spec.ts`
- `apps/api/src/energy/energy-heatmap.integration.spec.ts`
- `apps/api/src/energy/energy.controller.ts`
- `apps/api/src/energy/energy.module.ts`

## Self-review

- Confirmed no P2-C, carbon, or optimization metric is accepted: the shared heatmap contract only permits `energy` and `brightness`.
- Confirmed the shared contract enforces no more than 92 inclusive dates and exact 168-cell output ordering.
- Confirmed scope authorization is invoked before all Prisma reads in the service.
- Confirmed existing energy controller routes remain unchanged.

## Concerns

- The PostgreSQL integration spec is present but was not executable in this workspace because the opt-in test database URL was absent. Its Prisma path and all API TypeScript were typechecked; the deterministic behavior is covered by the unit suite.

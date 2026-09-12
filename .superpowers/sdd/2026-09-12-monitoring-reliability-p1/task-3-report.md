# Task 3 Web cached freshness와 상태 원인 통일 보고서

## Status

DONE_WITH_CONCERNS

- Base: `3d4de25` (`docs: record monitoring reliability backend completion`)
- Implementation commit: `557f2b568dda7a9306bdfa76194d7077cd32ac44`

## RED → GREEN evidence

- RED: `pnpm --filter @led-control/web exec vitest run src/api/queries.test.tsx src/features/monitoring/fixture-status-presentation.test.ts src/features/monitoring/MonitoringView.test.tsx` returned exit 1: three query-policy assertions received `600000`/`false`/`retry:false` instead of literal `30000`/`true`/`2`; cached dashboard error replaced the map with `현황 데이터를 불러오지 못했습니다.`; stale snapshot had no alert; the new presenter module was unresolved. Total: 5 failed tests and 1 unresolved test suite.
- GREEN focused: same scope plus `FloorMap.test.tsx` and `FloorScene.test.tsx` passed 5 files / 64 tests after implementation.
- Green typecheck: `pnpm --filter @led-control/web typecheck` passed after updating typed Web dashboard fixtures for the required metadata.
- First full-Web run exposed one affected test, not an unrelated baseline: `App.test.tsx` expected a single failed dashboard request even though the new required monitoring policy retries twice. The test now supplies three failures and confirms the fourth manual retry. Final `pnpm --filter @led-control/web test` passed 60 files / 688 tests; `pnpm --filter @led-control/web build` passed, with the pre-existing-size warning for the 1,269.79 kB minified main bundle (379.53 kB gzip); `git diff --check` passed.

## Implemented contract

- `Dashboard` requires `generatedAt` and `monitoringPolicy`; every floor fixture page requires `generatedAt`. Monitoring dashboard, fixture, and map queries use `30,000ms` interval/stale time, `retry: 2`, and `refetchOnWindowFocus: true`; the independent Control dashboard stays at 3 seconds.
- Dashboard cache is rendered even when its background query errors. Manual refresh retains the existing dashboard+fixture+map `Promise.allSettled` flow. Cached fixture/map and selected floor/fixture remain rendered on failure.
- Freshness uses the oldest valid `generatedAt` among every current-floor fixture page: exactly 60 seconds is fresh, greater than 60 seconds is stale. Query errors produce a persistent retry banner. The last-update copy uses the server ISO, not `dataUpdatedAt` or browser receipt time; future timestamps show `시간 차이 확인` with their original ISO and malformed values warn safely.
- `fixture-status-presentation.ts` supplies one label, description, recommendation, tone, and state key to selector copy, FloorMap marker accessibility labels, StatusBadge, and detailed cause/recommendation. FloorScene receives an optional precomputed presentation so floor-editor consumers remain compatible.

## Scope and remaining work

- Updated monitoring menu/status documentation; corrected the prior Task 2 contradiction: the 30-second sweep already automatically collects and resolves incident conditions. This Task does not claim incident UI, policy dialog, push/HIL, DB migration, or deployment completion.
- Task 4 incident tab/policy dialog and Task 5 full Chromium/integration final gate remain.

## Changed files

- Query contract/policy: `apps/web/src/api/queries.ts`, its test, and typed dashboard fixtures/tests used by control/setup/App.
- Monitoring presentation: `apps/web/src/features/monitoring/MonitoringView.tsx`, `FloorMap.tsx`, new `fixture-status-presentation.ts`, their tests, and the compatible `apps/web/src/features/floor-map/FloorScene.tsx` interface.
- Status records: `docs/menus/monitoring.md` and `docs/project-status.md`.

## Fix round 1

DONE_WITH_CONCERNS

- Base: `54bf9a4464f26d425464d37e87ecc487d649c98e`
- Implementation commit: `021ee8f396cff5e43b9a522e0ffe9be462dce405` (`fix(web): evaluate monitoring snapshots at exact boundary`)

### RED → GREEN evidence

- RED: before production changes, `pnpm --filter @led-control/web exec vitest run src/features/monitoring/MonitoringView.test.tsx` exited 1 with 7 failures out of 28 tests. The new regressions showed an immediately arrived current snapshot being marked future, no stale banner after the 60,001ms boundary, a normal page hiding future/overflowed/missing metadata on another page, and a danger banner during initial fixture load and floor switching. The pre-existing cached-data assertions also failed because their mock fixture pages lacked the now-required `generatedAt` metadata; those fixtures were updated to model the production contract.
- GREEN focused: `pnpm --filter @led-control/web exec vitest run src/api/queries.test.tsx src/features/monitoring/fixture-status-presentation.test.ts src/features/monitoring/MonitoringView.test.tsx src/features/monitoring/FloorMap.test.tsx src/features/floor-map/FloorScene.test.tsx` passed 5 files / 69 tests.
- GREEN full Web: `pnpm --filter @led-control/web test` passed 60 files / 693 tests. `pnpm --filter @led-control/web typecheck` passed. `pnpm --filter @led-control/web build` passed (2,437 modules); its only concern is the existing Vite chunk-size warning for the 1,270.39 kB minified main bundle (379.76 kB gzip). `git diff --check` passed.

### Corrected freshness contract

- A changed fixture-page response is evaluated against `Date.now()` in that render. The component schedules one cleanup-safe timeout for the first relevant transition: the strict stale boundary at `generatedAt + 60,001ms`, or a near future timestamp becoming current. It does not retain a one-second polling tick; far-future timestamps do not overflow browser timer limits and are instead re-evaluated on the normal query refresh.
- Exactly 60,000ms remains fresh; 60,001ms is stale. Every fixture page is validated independently using a canonical millisecond UTC ISO format plus finite parse and `toISOString()` round-trip, which rejects JavaScript calendar normalization such as `2026-02-30`. Any missing, non-string, malformed, or future page remains a metadata warning even if another page is current; stale age still uses the oldest valid page.
- No fixture pages with no error is a pending state and renders the existing loading feedback without a stale banner. It is distinct from malformed metadata, so switching to an unqueried floor retains the current floor/fixture selection behavior without a false danger state.

### Scope and remaining work

- This correction is limited to Task 3 monitoring Web cache/freshness behavior and its regressions; it makes no Task 4 incident-tab/policy-dialog/API changes.
- Task 4 incident tab/policy dialog and Task 5 full Chromium/integration final gate remain. The bundle-size warning above remains a non-blocking concern.

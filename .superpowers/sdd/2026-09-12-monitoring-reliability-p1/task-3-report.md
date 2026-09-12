# Task 3 Web cached freshness와 상태 원인 통일 보고서

## Status

DONE_WITH_CONCERNS

- Base: `3d4de25` (`docs: record monitoring reliability backend completion`)
- Head/commit: pending final Task 3 commit

## RED → GREEN evidence

- RED: `pnpm --filter @led-control/web exec vitest run src/api/queries.test.tsx src/features/monitoring/fixture-status-presentation.test.ts src/features/monitoring/MonitoringView.test.tsx` returned exit 1: three query-policy assertions received `600000`/`false`/`retry:false` instead of literal `30000`/`true`/`2`; cached dashboard error replaced the map with `현황 데이터를 불러오지 못했습니다.`; stale snapshot had no alert; the new presenter module was unresolved. Total: 5 failed tests and 1 unresolved test suite.
- GREEN focused: same scope plus `FloorMap.test.tsx` and `FloorScene.test.tsx` passed 5 files / 64 tests after implementation.
- Green typecheck: `pnpm --filter @led-control/web typecheck` passed after updating typed Web dashboard fixtures for the required metadata.

## Implemented contract

- `Dashboard` requires `generatedAt` and `monitoringPolicy`; every floor fixture page requires `generatedAt`. Monitoring dashboard, fixture, and map queries use `30,000ms` interval/stale time, `retry: 2`, and `refetchOnWindowFocus: true`; the independent Control dashboard stays at 3 seconds.
- Dashboard cache is rendered even when its background query errors. Manual refresh retains the existing dashboard+fixture+map `Promise.allSettled` flow. Cached fixture/map and selected floor/fixture remain rendered on failure.
- Freshness uses the oldest valid `generatedAt` among every current-floor fixture page: exactly 60 seconds is fresh, greater than 60 seconds is stale. Query errors produce a persistent retry banner. The last-update copy uses the server ISO, not `dataUpdatedAt` or browser receipt time; future timestamps show `시간 차이 확인` with their original ISO and malformed values warn safely.
- `fixture-status-presentation.ts` supplies one label, description, recommendation, tone, and state key to selector copy, FloorMap marker accessibility labels, StatusBadge, and detailed cause/recommendation. FloorScene receives an optional precomputed presentation so floor-editor consumers remain compatible.

## Scope and remaining work

- Updated monitoring menu/status documentation; corrected the prior Task 2 contradiction: the 30-second sweep already automatically collects and resolves incident conditions. This Task does not claim incident UI, policy dialog, push/HIL, DB migration, or deployment completion.
- Task 4 incident tab/policy dialog and Task 5 full Chromium/integration final gate remain.

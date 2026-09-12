# Task 1 Report: API health, request context, structured observability

## Status

Implemented Task 1 in the isolated worktree on `codex/p0p1-platform-deploy-observability`. No schema, migration, shared contract, Web, Gateway, firmware, production infrastructure, secret, or external system was changed.

## Delivered behavior

- Added unauthenticated `GET /health/live`, `GET /health/ready`, and `GET /health/metrics` endpoints.
- Liveness performs no dependency I/O. Readiness uses `Promise.allSettled` over the existing Prisma, Redis, MQTT, and Object Storage clients with an injected clock and a per-probe `1,000ms` deadline.
- Readiness returns exactly `status`, four fixed `checks`, and `timestamp`; caught dependency errors never enter the response. The actual Nest module close order marks readiness stopping before dependency destroy hooks.
- Added `RequestContext.run(requestId, fn)` and `getRequestId()` using `AsyncLocalStorage`. Valid request IDs are propagated; unsafe IDs are replaced with UUID v4 and reflected in the response header.
- Added one-line JSON application/HTTP logging with allowlisted HTTP fields. Cookie, authorization, body, query, stack, raw device identifiers, and unmatched raw paths are excluded.
- Added bounded in-memory metrics for HTTP total/4xx/5xx/latency sum/max, current readiness, and four fixed dependency failure counters. No tenant, path, credential, or request ID label is accepted.
- Preserved the existing API TLS construction, body-parser order after the new request middleware, CORS, Vault/CRL runtime setup, Nest shutdown hooks, and runtime cleanup path.

## TDD RED evidence

1. Health/readiness/metrics initial RED:
   - Command: `pnpm --filter @led-control/api exec jest src/observability/health.controller.spec.ts src/observability/readiness.service.spec.ts src/observability/observability-metrics.service.spec.ts --runInBand`
   - Exit: `1`
   - Expected failure: all three suites failed with `TS2307` because the new controller/services did not exist.
2. Request context/logger initial RED:
   - Command: `pnpm --filter @led-control/api exec jest src/observability/request-context.middleware.spec.ts src/observability/structured-logger.service.spec.ts --runInBand`
   - Exit: `1`
   - Expected failure: both suites failed with `TS2307` because the middleware/logger did not exist.
3. Existing-client probe RED:
   - Command: `pnpm --filter @led-control/api exec jest src/observability/dependency-readiness.spec.ts --runInBand`
   - Exit: `1`
   - Expected failure: `TS2339` for missing `probeReadiness` on Prisma, Redis, MQTT, and Object Storage services.
4. Redis startup ownership RED:
   - Command: `pnpm --filter @led-control/api exec jest src/redis/redis.provider.spec.ts --runInBand`
   - Exit: `1`
   - Expected failure: module initialization created zero clients instead of the required one existing client (`Expected 1, Received 0`).
5. Metrics route and raw device redaction RED:
   - Command: `pnpm --filter @led-control/api exec jest src/observability/health.controller.spec.ts src/observability/structured-logger.service.spec.ts --runInBand`
   - Exit: `1`
   - Expected failures: `/health/metrics` returned 404 and the structured error entry retained `deviceId`.
6. Unmatched path normalization RED:
   - Command: `pnpm --filter @led-control/api exec jest src/observability/request-context.middleware.spec.ts --runInBand`
   - Exit: `1`
   - Expected failure: the HTTP log retained `/sites/tenant-secret/devices/raw-device-secret` rather than fixed `/:unmatched`.

## GREEN and verification evidence

- Baseline before changes: API `112 suites / 1,103 passed / 289 skipped`, exit `0`.
- Focused final: `8 suites / 26 tests`, all passed, exit `0`.
- Full API final: `119 suites / 1,127 passed / 289 environment-dependent skipped`, exit `0`.
- `pnpm --filter @led-control/api typecheck`: exit `0`.
- `pnpm --filter @led-control/api build`: exit `0`.
- `git diff --check`: exit `0`.

The recurring pnpm launcher warning that the root `package.json#pnpm` field is not read by the locally installed pnpm remained unchanged from baseline and is documented repository policy; it did not hide a test, typecheck, or build failure.

## Files

- Created `apps/api/src/observability/health.controller.ts` and focused HTTP tests.
- Created `apps/api/src/observability/readiness.service.ts` and timeout/error/shutdown tests.
- Created `apps/api/src/observability/request-context.middleware.ts` and real concurrent HTTP/context tests.
- Created `apps/api/src/observability/structured-logger.service.ts` and JSON-line/redaction tests.
- Created `apps/api/src/observability/observability-metrics.service.ts` and fixed-label tests.
- Created `apps/api/src/observability/observability.module.ts` and actual Nest DI/destroy-order test.
- Modified `apps/api/src/app.module.ts`, `apps/api/src/main.ts`, and the existing Prisma/Redis/MQTT/Object Storage services.
- Updated `docs/agent-operations.md`, `docs/project-status.md`, and only the Task 1 checklist in the active plan.

## Self-review

- Confirmed health responses and metric snapshots are explicit allowlists and contain no caught errors, URLs, SQL, tenant/body/query/header values, credentials, or stacks.
- Confirmed readiness never creates a Redis or MQTT client. Redis creates its one owned client during normal module initialization; MQTT continues to use its existing production initialization and reconnect policy.
- Confirmed dependency keys and HTTP metric fields are fixed, so caller-controlled cardinality cannot grow the metric key set.
- Confirmed real Nest HTTP behavior covers 200/503, response request ID, concurrent isolation, and unmatched path normalization. Actual Nest module teardown covers readiness-before-dependency destruction.
- Confirmed no second dependency clients, schema/migration changes, shared contract changes, or menu behavior changes were introduced.

## Concerns and exclusions

- Metrics are intentionally process-local and reset on restart. No durable metrics backend, dashboard, alert routing, or log shipping exists yet.
- This task used controlled dependency doubles and did not contact a real PostgreSQL, Redis, MQTT broker, or Object Storage endpoint. Task 2 owns disposable production Compose fail/recover smoke and healthcheck consumption.
- Production container/image, migration-before-app ordering, TLS Web proxy, Web recovery UI, final runbook, actual deployment, user DB migration, secret operations, and Raspberry Pi/BlueZ/ESP32-H2 HIL remain later-task or excluded work.

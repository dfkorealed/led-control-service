# Task 6 — CSV, private report storage, durable worker and API

Completed in `codex/statistics-p2-reports`, worktree `/Users/kim-jh/Documents/led-control-service/.worktrees/statistics-p2-reports`.

## Implementation

- CSV exports the existing common document's title, metadata, summary, ordered table raw/display cells, heatmap cells, notes, identifier and fingerprint. `Readable.from` encodes rows under backpressure; the controller returns `StreamableFile`, never a complete CSV string. Output has UTF-8 BOM, CRLF row separators, quoted/escaped strings, null blanks and spreadsheet formula-prefix protection including leading whitespace/control characters.
- POST accepts the exact shared report request without section selection, stores actor/user/login/request snapshots and a canonical SHA-256 request hash, and returns a shared queued job with HTTP 202. Active dedupe is scoped to site + immutable actor + request hash; P2002 races resolve to the winning active job.
- As required by the design, POST does not capture aggregates. The first leased worker attempt invokes the existing RepeatableRead snapshot service and persists data/document/fingerprint under live-owner fencing. Renderers receive only the stored document returned by the DB or the existing immutable snapshot on retries. The worker independently validates the document fingerprint and renderer's extracted manifest.
- The worker claims with a PostgreSQL `FOR UPDATE SKIP LOCKED` CTE, uses a 30-second lease with 10-second live renewal, prevents overlapping local polls, advances progress and allows at most three attempts. Every snapshot/progress/renewal/failure/completion write checks ID, processing status, owner, attempt number and unexpired DB-clock lease. A crashed third attempt becomes terminal failed without a fourth claim.
- All raw SQL clock assignments and comparisons explicitly use `AT TIME ZONE 'UTC'`, matching Prisma's timestamp-without-time-zone columns even when PostgreSQL sessions run in Asia/Seoul.
- XLSX/PDF is selected from the stored job format. Files use `reports/{siteId}/{reportId}/attempt-{1..3}.{xlsx|pdf}`. The worker and storage reject zero/>25 MiB files; completion requires HEAD size, MIME and SHA-256 agreement and records a seven-day expiry.
- Report object operations use a separate private bucket, an exact report-key allowlist, checksum-enabled HEAD, no-store object metadata and safe ASCII attachment filenames. Downloads require completed, not deleted, unexpired, same-site/same-report keys and issue a real signed GetObject URL for 300 seconds. Expiry is checked after authorization/DB reads so a delayed query cannot sign an already-expired report.
- Lists select at most 50 newest site jobs without loading data/document/actor snapshots. Detail/list project completed files past expiry as expired. Site read authorization always precedes report/snapshot queries; inaccessible sites and cross-site report IDs are hidden with 404.
- Providers are registered in EnergyModule with StorageModule. The production poller is unref'd, avoids duplicate initialization and is cleared on shutdown; it does not automatically start under NODE_ENV=test. Per-attempt heartbeat timers are cleared in finally/shutdown.

## Routes

| Method | Route | Result |
| --- | --- | --- |
| POST | `/energy/sites/:siteId/reports` | 202 shared job |
| GET | `/energy/sites/:siteId/reports` | latest 50 shared jobs |
| GET | `/energy/sites/:siteId/reports/:reportId` | shared job |
| GET | `/energy/sites/:siteId/reports/:reportId/download` | shared 300-second download descriptor |
| GET | `/energy/sites/:siteId/exports/csv` | streamed CSV; exact from/to/scope/identityId query |

All successful report/CSV responses have `Cache-Control: no-store`.

## Storage/deployment compatibility

- Added `OBJECT_STORAGE_REPORT_BUCKET` (default `energy-reports`) to StorageModule and `.env.example`.
- Existing local `floor-assets` has anonymous download policy, so reports cannot share it. Local compose now creates the separate report bucket with `mc anonymous set none`; identical public/report bucket configuration is rejected.
- Public floor upload descriptors, bucket/key layout, public URLs and deletion behavior remain intact. Real MinIO regression exposed an existing public HEAD omission: without `ChecksumMode: ENABLED`, its existing test's SHA-256 metadata was absent. Added that request option. Public floor anonymous download remains HTTP 200; report anonymous download is HTTP 403.

## RED/GREEN evidence

1. Wrote CSV/private-storage tests first. The initial missing-module/method compile failure was followed by minimal unimplemented signatures and a proper RED run: **20 failed / 5 existing passed**. Implemented streaming, quoting/formula protection, allowlists, private operations and real signing; CSV's **11 tests** and storage's initial **14 tests** became green in focused runs. The environment-wiring regression later brought storage's unit suite to 15 tests.
2. Jobs service signatures produced **19 failed** tests for authorization, request validation, dedupe/race, projection and download. After inspecting the design's worker-first capture rule, a separate RED explicitly rejected aggregate capture in POST (**1 failed / 18 passed**); final POST only queues the request. Jobs/storage focused final run: **35 passed**.
3. Worker signatures against real PostgreSQL and real renderers produced **14 failed / 1 passed**. GREEN covered actual locking/leases, snapshot reuse, XLSX/PDF byte manifests, HEAD mismatches, retry exhaustion, stale ownership and expiry.
4. Real HTTP tests imported the actual EnergyModule, AuthService/SessionAuthGuard, SiteAccessService and PostgreSQL. Missing routes produced **3 failed** tests (404 in place of 202/CSV/401). Provider/route implementation made all three pass.
5. StorageModule environment test failed with actual bucket `energy-reports` instead of configured private bucket; environment wiring made it pass.
6. Real MinIO private-report integration passed, while the existing public HEAD test failed because its checksum was omitted. Adding explicit checksum mode made the complete storage run **17/17** pass, including anonymous public-floor GET and private-report signed/unsigned GET behavior.
7. Live-heartbeat regression was mutation-checked: changing renewal from 10s to 60s made the slow-storage test fail, restoring 10s made it pass. The fixture explicitly orders its second queued row to avoid UUID ordering when two inserts share the same millisecond.
8. Download-after-delayed-read regression initially issued a signed URL after expiry (**1 failed / 19 skipped**). Moving the default time check after DB reads made it pass.
9. Self-review tested absolute worker time in the actual Asia/Seoul PostgreSQL session. The initial assertion showed **32,399,997 ms drift** while relative 30-second/seven-day assertions passed. Explicit UTC SQL fixed it. The worker test URL now forces Asia/Seoul so CI's UTC default cannot mask this regression. Final focused worker/HTTP run: **19/19** passed.

Test fixture corrections were limited to Node's byte-stream chunk coalescing (observe data events for emitted rows), PostgreSQL JSONB object-key ordering (compare independent path/value sets rather than object insertion order), and explicit ordering of equal-createdAt jobs. These were test assumptions, not production behavior changes.

## Final verification

- `pnpm --filter @led-control/api typecheck` — exit 0 after final UTC changes.
- `pnpm --filter @led-control/api build` — exit 0 after final UTC changes; shared and automation-engine dependency builds passed.
- Default full API regression before final UTC hardening: **110 suites / 1,017 tests passed**, 23 suites / 223 opt-in tests skipped.
- Final full API regression **with isolated PostgreSQL and MinIO enabled**, after all production changes: **115 suites / 1,048 tests passed**, 18 suites / 192 unrelated opt-in tests skipped, zero failures, 36.127 seconds.
- Earlier combined energy/storage/schema run: **27 suites / 211 tests passed**. Final full run additionally covers the absolute-time regression and all other API suites.
- `docker compose config --quiet` — exit 0.
- `git diff --check` — exit 0.

Final full command (only throwaway loopback services):

```sh
ENERGY_REPORT_TEST_DATABASE_URL=postgresql://report_worker_test@127.0.0.1:55486/report_worker_test \
ENERGY_QUERY_TEST_DATABASE_URL=postgresql://report_worker_test@127.0.0.1:55486/report_worker_test \
FIXTURE_STATE_TEST_DATABASE_URL=postgresql://report_worker_test@127.0.0.1:55486/report_worker_test \
RUN_OBJECT_STORAGE_INTEGRATION=true RUN_REPORT_STORAGE_INTEGRATION=true \
OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:19586 OBJECT_STORAGE_BUCKET=public-floors \
OBJECT_STORAGE_REPORT_BUCKET=private-reports OBJECT_STORAGE_ACCESS_KEY=report-test-access \
OBJECT_STORAGE_SECRET_KEY=report-test-secret-local \
pnpm --filter @led-control/api exec jest --runInBand
```

Compiled smoke used `NODE_ENV=test node /tmp/led-report-worker-PaqyUW/smoke.cjs`, requiring the actual `dist/src` jobs/access/snapshot/CSV/worker/renderers and real Prisma/S3 clients. It created an isolated admin/site, queued/deduped both formats, ran each worker, fetched signed URLs, compared actual file manifests/checksums, rejected anonymous access and streamed CSV:

```text
xlsx: 63147 bytes, 1460 verified document leaves; signed 200 / anonymous 403
pdf: 5888220 bytes, 1460 verified document leaves; signed 200 / anonymous 403
CSV: 11931 streamed bytes, BOM and document metadata verified
```

## Isolation and cleanup

- Initialized a separate PostgreSQL cluster at `/tmp/led-report-worker-PaqyUW/data`, user/database `report_worker_test`, loopback port 55486. All 54 existing migrations deployed successfully into the new database. No external database was used.
- Started only the throwaway `led-report-task6-storage-paqyuw` MinIO container on loopback port 19586, using the cached project MinIO image and disposable credentials. Created disposable public/private buckets for the storage tests.
- Test/smoke rows and objects were cleaned within their own UUID scopes. The MinIO container was stopped and automatically removed (`--rm`); its disposable data is gone. PostgreSQL was stopped with `pg_ctl ... stop -m fast`; its temporary data and smoke script remain for diagnostic reproduction. No external services were changed.

## Files

- New: `apps/api/src/energy/reports/energy-csv-export.service.ts` and `.spec.ts`.
- New: `apps/api/src/energy/reports/energy-report-jobs.service.ts` and `.spec.ts`.
- New: `apps/api/src/energy/reports/energy-report-worker.service.ts` and `.spec.ts`.
- New: `apps/api/src/energy/reports/energy-report-api.spec.ts`.
- Updated: `apps/api/src/energy/energy.controller.ts`, `energy.module.ts`.
- Updated: `apps/api/src/storage/object-storage.service.ts`, `.spec.ts`, `object-storage.integration.spec.ts`, `storage.module.ts`.
- Updated: `.env.example`, `docker-compose.yml`.
- Updated: `docs/menus/statistics.md`, `docs/project-status.md`.
- Added this task report. No DB schema/migration changes were needed.

## Self-review and handoff concerns

- No P2-C/carbon/optimization behavior or extra report calculations were added. Existing snapshot/builder/renderers are reused; API/file manifests were checked for prohibited fields/wording.
- DB and S3 boundaries are precise in unit tests; worker and HTTP integrations exercise real PostgreSQL, real renderers, real authorization/session handling, and actual MinIO in transport checks. No renderer mocks or subagents were used.
- Physical seven-day file expiry, stale-attempt object cleanup and 90-day metadata retention remain Task 8. Failed uploads are deleted only after a successful fenced failure transition. An expired/stale worker or an uncertain completion acknowledgement leaves its attempt object for cleanup, preventing deletion of a legitimately committed file.
- Cleanup must use the private report methods and all attempt keys for that job; never redirect report deletion through the public floor bucket. Only attempts 1–3 with `.xlsx`/`.pdf` are allowed.
- Deployment must provision `OBJECT_STORAGE_REPORT_BUCKET` as private. The code rejects using the public floor bucket, and local compose provisions the private bucket; it cannot enforce an arbitrary externally changed bucket policy.
- CSV output strings stream, but the input document snapshot and XLSX/PDF rendering bytes still live in memory. POST validates the shared shape immediately; completed dates and scoped identity validity are decided on the first worker capture and can therefore end in a failed job.
- Web integration remains Task 7. Tests here do not claim physical hardware verification.

## Task checklist

- [x] CSV BOM/quoting/formula protection/streaming RED and implementation.
- [x] Private put/head/delete/300-second signed download and key allowlist RED and implementation.
- [x] POST/list/detail/download, active dedupe, 30-second lease, SKIP LOCKED, progress, retry/fencing.
- [x] Stored-document-only rendering and attempt-specific private keys.
- [x] 25 MiB bound, seven-day expiry, safe filenames and tenant-safe 404.
- [x] Focused RED/GREEN, actual PostgreSQL/MinIO, full API tests, typecheck/build, compiled smoke and diff checks.

## Fix Round 1 — shutdown and terminal-winner races

Both Important review findings were verified and fixed with focused TDD. No subagents were used.

### Changes

- `claimNext()` now checks shutdown before the exhausted-attempt sweep and again after that awaited sweep. `runOnce()` rechecks shutdown after the awaited claim. Destruction during either DB boundary cannot start a new claim query, snapshot capture, renderer, upload or heartbeat. A claim already committed by the DB remains at its original lease deadline for normal recovery; shutdown does not revive or prolong it.
- The same await-boundary audit found renewal could return after destruction and permit rendering. `pulse()` now rechecks shutdown/lease loss after the DB renewal response; shutdown also bypasses fresh failure/deletion queries against dependencies being destroyed.
- POST dedupe now performs at most three INSERT attempts. Each P2002 performs an active winner lookup; if the winner became terminal and disappeared from that lookup, the next INSERT retries against the same DB partial unique index. A successful retry returns the normal shared job. Repeated churn ends with a retryable HTTP 409 instead of a raw Prisma error/HTTP 500. Unrelated DB errors are not retried.
- Updated `docs/menus/statistics.md` with these runtime behaviors. No shared API/schema/storage-format changes were needed.

### RED/GREEN commands and results

Shutdown tests hold the actual DB-method promise boundary open, destroy the worker, then release the claim/sweep. The real snapshot service remains installed, with its transaction boundary instrumented to detect any forbidden read; interval creation is observed directly.

```sh
pnpm --filter @led-control/api exec jest src/energy/reports/energy-report-worker.service.spec.ts --runInBand -t 'shutdown occurs'
```

- RED: **2 failed, 16 skipped**. Pending claim returned `true` instead of `false` and started attempt work; shutdown during the sweep still issued the claim query.
- GREEN after shutdown guards: **2 passed, 16 skipped**. No snapshot transaction, heartbeat or post-shutdown lease update starts.

The additional renewal-await regression was run with the same file and `-t 'shutdown occurs during the awaited'`: RED was **1 failed, 18 skipped**, showing the real Excel renderer ran after destruction. After the fresh post-renewal shutdown check and no-new-failure-writes guard, `-t 'shutdown occurs'` passed **3 tests, 16 skipped**. Renderer instrumentation calls through to the real renderer; its behavior is not mocked.

```sh
pnpm --filter @led-control/api exec jest src/energy/reports/energy-report-jobs.service.spec.ts --runInBand -t 'terminal|unrelated to uniqueness'
```

- RED: **2 failed, 1 passed, 20 skipped**. Both terminal-winner branches leaked `{ code: "P2002" }`; the unrelated-error no-retry guard already passed.
- Tests cover successful second INSERT, a maximum of three INSERTs/four active lookups under repeated churn, and preserving unrelated database errors.

Real PostgreSQL race test inserts a competing active row after the service's empty lookup, observes the real partial-index P2002, commits that winner as failed before returning the exception, and then allows recovery. It uses a Prisma query extension only to schedule this DB boundary; all reads, inserts, constraint enforcement and terminal transitions run against PostgreSQL.

```sh
ENERGY_REPORT_TEST_DATABASE_URL=postgresql://report_worker_test@127.0.0.1:55486/report_worker_test \
pnpm --filter @led-control/api exec jest src/energy/reports/energy-report-jobs.service.spec.ts --runInBand -t 'real unique-index'
```

- RED: **1 failed, 23 skipped**, with real `PrismaClientKnownRequestError: Unique constraint failed on (siteId, requestedByActorId, requestHash)`.
- After retry implementation, the combined focused command below passed **6 tests, 36 skipped**, including the real DB race. Its final DB state is exactly one failed competitor and one new active job.

```sh
ENERGY_REPORT_TEST_DATABASE_URL=postgresql://report_worker_test@127.0.0.1:55486/report_worker_test \
pnpm --filter @led-control/api exec jest src/energy/reports/energy-report-jobs.service.spec.ts \
src/energy/reports/energy-report-worker.service.spec.ts --runInBand \
-t 'terminal|unrelated to uniqueness|real unique-index|shutdown occurs'
```

### Final verification

- Relevant report/storage/HTTP/controller suites with isolated PostgreSQL and MinIO enabled, before the additional renewal-await guard: `pnpm --filter @led-control/api exec jest src/energy/reports src/storage src/energy/energy.controller.spec.ts --runInBand` — **12 suites, 100 tests passed**, 27.486 seconds. The storage environment values were the same disposable loopback values in the full command below; this includes real signed/anonymous S3 transport and actual HTTP auth/access. The final full run below rechecks these suites plus the additional regression.
- `pnpm --filter @led-control/api typecheck && pnpm --filter @led-control/api build` — exit 0; shared/automation dependencies and API checks/build passed.
- Final full command:

```sh
ENERGY_REPORT_TEST_DATABASE_URL=postgresql://report_worker_test@127.0.0.1:55486/report_worker_test \
ENERGY_QUERY_TEST_DATABASE_URL=postgresql://report_worker_test@127.0.0.1:55486/report_worker_test \
FIXTURE_STATE_TEST_DATABASE_URL=postgresql://report_worker_test@127.0.0.1:55486/report_worker_test \
RUN_OBJECT_STORAGE_INTEGRATION=true RUN_REPORT_STORAGE_INTEGRATION=true \
OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:19586 OBJECT_STORAGE_BUCKET=public-floors \
OBJECT_STORAGE_REPORT_BUCKET=private-reports OBJECT_STORAGE_ACCESS_KEY=report-test-access \
OBJECT_STORAGE_SECRET_KEY=report-test-secret-local \
pnpm --filter @led-control/api exec jest --runInBand
```

```text
Test Suites: 18 skipped, 115 passed, 115 of 133 total
Tests:       192 skipped, 1055 passed, 1247 total
Snapshots:   0 total
Time:        35.478 s
```

- `git diff --check` — exit 0.
- Reused only the previously created throwaway PostgreSQL cluster and launched a fresh disposable MinIO container with the same isolated name/ports. Both were stopped again; MinIO was automatically removed. External services/data were not touched.
- Remaining handoff constraints are unchanged: an already-claimed shutdown row may wait until its original 30-second lease expires; sustained dedupe churn can return 409 for client retry. Physical report/attempt-object cleanup remains Task 8.

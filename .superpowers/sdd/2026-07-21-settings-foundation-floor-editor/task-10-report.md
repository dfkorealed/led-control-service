# Task 10 Report: Redis 편집 lease

기준 브랜치: `codex/mvp1-cloud-web`

## 구현 요약

- `REDIS_URL`을 필수로 검증하는 Nest `RedisModule`과 단일 lazy ioredis client를 추가했다. API bootstrap이 shutdown hook을 활성화해 signal 종료 시 생성된 client만 `quit()`한다.
- 층별 key `floor-editor:lease:{floorId}`에 `{ userId, userName, token, acquiredAt }` JSON을 `SET NX EX 90`으로 저장한다.
- `POST /floors/:floorId/editor-lease`는 최초 획득과 같은 token의 heartbeat 갱신을 처리한다. 갱신과 normal/force 해제는 Lua에서 현재 token을 비교한 뒤에만 TTL 갱신 또는 삭제한다.
- lease API는 대상 floor의 `manage` SiteAccess를 확인한다. normal release는 holder user와 token 모두를 확인하고, operator/admin force release는 durable requested/attempted audit 뒤 감사한 holder token만 삭제하며 success 또는 stale_token 결과를 별도 audit으로 남긴다.
- Web route는 진입 시 lease를 얻고 editable token을 30초마다 갱신한다. 충돌, 갱신 실패, token 상실, 획득 실패와 floor 전환 중에는 편집 surface 전체를 읽기 전용으로 유지한다. 정상 unmount는 token release를 요청하며 비정상 종료는 90초 TTL에 맡긴다.
- revision optimistic concurrency와 기존 dirty sentinel/navigation guard는 그대로 유지했다.

## RED / GREEN 기록

### RED

1. `pnpm --filter @led-control/api exec jest src/redis/redis.provider.spec.ts src/floor-editor/editor-lease.service.spec.ts --runInBand`
   - `../redis/redis.provider`, `./editor-lease.service`를 찾지 못해 2 suite가 실패했다. provider lifecycle, conflict, TTL 재시도, token Lua 경계, authorization/audit 요구를 production code 없이 먼저 고정했다.
2. `pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.controller.spec.ts --runInBand`
   - `controller.acquireLease is not a function`으로 실패했다. API controller 위임 계약을 먼저 추가했다.
3. `pnpm --filter @led-control/web exec vitest run src/api/floor-editor.test.ts src/features/settings/floor-plans/FloorEditorRoute.test.tsx`
   - `acquireFloorEditorLease is not a function`, read-only alert 부재, normal unmount release 부재로 3 test가 실패했다.
4. `pnpm --filter @led-control/web exec vitest run src/features/floor-editor/FloorEditorView.test.tsx`
   - route-owned `readOnly`에서 dirty save button이 활성화되어 1 test가 실패했다.

### GREEN

- Focused API: `pnpm --filter @led-control/api exec jest src/redis/redis.provider.spec.ts src/floor-editor/editor-lease.service.spec.ts src/floor-editor/floor-editor.controller.spec.ts --runInBand` -> 3 suites, 14 tests passed.
- Focused Web: `pnpm --filter @led-control/web exec vitest run src/api/floor-editor.test.ts src/features/settings/floor-plans/FloorEditorRoute.test.tsx src/features/floor-editor/FloorEditorView.test.tsx` -> 3 files, 48 tests passed.
- Affected API suite: `pnpm --filter @led-control/api exec jest src/redis src/floor-editor --runInBand` -> 5 suites, 79 tests passed; `floor-editor.integration.spec.ts`는 `FLOOR_EDITOR_TEST_DATABASE_URL` 미설정으로 12 tests skipped.
- Affected Web suite: `pnpm --filter @led-control/web exec vitest run src/features/settings/floor-plans` -> 2 files, 21 tests passed.
- Full Web suite: `pnpm --filter @led-control/web test` -> 16 files, 123 tests passed.
- Type/build: `pnpm --filter @led-control/api typecheck`, `pnpm --filter @led-control/api build`, `pnpm --filter @led-control/web build` passed.
- Hygiene: `git diff --check` passed before the implementation commit.

## 커밋

- `4182f45 feat(floor-editor): prevent concurrent floor edits`

## 변경 파일

- API: `apps/api/src/redis/redis.module.ts`, `redis.provider.ts`, `redis.provider.spec.ts`, `apps/api/src/floor-editor/editor-lease.service.ts`, `editor-lease.service.spec.ts`, `floor-editor.controller.ts`, `floor-editor.controller.spec.ts`, `floor-editor.module.ts`.
- Web: `apps/web/src/api/floor-editor.ts`, `floor-editor.test.ts`, `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`, `FloorEditorRoute.test.tsx`, `apps/web/src/features/floor-editor/FloorEditorView.tsx`, `FloorEditorView.test.tsx`.
- Operations/docs: `.env.example`, `docs/menus/settings.md`, this report and SDD progress ledger.

## Self-review

- Redis client construction is lazy but configuration validation is performed by Nest lifecycle before serving traffic; teardown clears the stored reference before awaiting `quit()`.
- Redis scripts are the final authority for renew/release, so a stale reader cannot extend or remove a successor token. Force release also uses the audited token rather than an unconditional `DEL`.
- The lease service authorizes before Redis access and never returns a holder token to a non-holder. Missing/corrupt/expired lease state is conservative read-only rather than editable.
- The route binds editable state to the current `floorId`; an old floor's successful lease cannot temporarily enable mutations after a parameter transition. `FloorEditorView` gates save, restore, tools, canvas, uploader, and property edits without changing dirty-navigation behavior.
- No database schema changed, so `docs/database-schema.md` was intentionally not updated.

## Concerns

- The Redis boundary unit tests use an ioredis double; a multi-process browser/API test against a provisioned Redis instance is still needed for deployment-level expiry and network-failure evidence. `FLOOR_EDITOR_TEST_DATABASE_URL` was absent, so the existing DB integration suite remained skipped.
- Web production build still reports the pre-existing large-chunk warning for the PDF/editor bundle; the build succeeds but code splitting remains a future performance task.

## Fix Round 1

### RED

- `pnpm --filter @led-control/api exec jest src/api-lifecycle.spec.ts src/floor-editor/editor-lease.service.spec.ts src/floor-editor/editor-lease.redis.integration.spec.ts src/floor-editor/floor-editor.controller.spec.ts --runInBand` initially failed because startup shutdown wiring and exported script seams did not exist, force release recorded only a premature `success`, and body-less lease calls threw `TypeError`.
- `pnpm --filter @led-control/web exec vitest run src/features/settings/floor-plans/FloorEditorRoute.test.tsx` then failed for all three intended races: a second heartbeat started while the first was pending, an old-floor completion cleared the new floor token, and a delayed cleanup release left a same-floor remount read-only without retrying.

### GREEN

- API now calls `enableShutdownHooks()` during bootstrap through a tested lifecycle seam. Missing lease bodies default to `{}`, invalid `null` remains a controlled `400`, and force release records durable `requested/attempted` before Lua deletion followed by truthful `success` or `stale_token` result audit.
- Web lease state is owned by each effect closure. Renewal is single-flight; lease loss is terminal for that effect; stale floor completions cannot publish or clear another effect; initial read-only acquisition retries only on the bounded 250ms, 500ms, 1s, 2s, 4s, 8s schedule.
- Real Redis evidence: `RUN_REDIS_INTEGRATION=true REDIS_URL=redis://127.0.0.1:6379/15 pnpm --filter @led-control/api exec jest src/floor-editor/editor-lease.redis.integration.spec.ts --runInBand` passed. The UUID-scoped ephemeral key retained `current-token` after both stale-token Lua renew and delete returned `0`.

### Remaining Concerns

- The focused real-Redis test proves script token comparison in a local isolated database, but a deployed multi-process browser/API/Redis expiry test and the existing PostgreSQL floor-editor integration suite still require their dedicated environment configuration.

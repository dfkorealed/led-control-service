# P0/P1 조명 제어 신뢰성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** timeout을 실제 적용 실패로 오판하지 않고 후속 상태 조회로 수렴시키며, 중복 물리 제어를 막고 명령 이력을 다시 열 수 있게 한다.

**Architecture:** `Command.outcome`이 물리 결과를, `CommandDispatch.status/kind`가 전송 단계를 표현한다. 상태 조회도 기존 dispatch/outbox/ACK 경로를 사용하되 Set 대신 Gateway의 Generic OnOff/Lightness Get을 실행한다. API가 겹치는 unknown 명령을 차단하고 Web은 HTTP 동일 요청 확인, 실제 상태 확인, 검증 후 안전 재적용을 별도 행동으로 제공한다.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, MQTT QoS 1, Vitest/Jest, React 18, TanStack Query

**Spec:** `docs/superpowers/specs/2026-09-12-p0-p1-control-reliability-design.md`

## Global Constraints

- 자동 또는 background 밝기 Set 재전송을 추가하지 않는다.
- 상태 조회 최대 시도는 명령당 3회다.
- 기존 command status는 유지하고 API consumer는 기존 timeout ACK wire를 수용한다. 구버전 publisher/Gateway/API 혼합 배포는 안전하지 않으며 모두 준비된 뒤 status-check producer/API·UI를 활성화한다.
- 새 production 코드를 쓰기 전에 해당 회귀 테스트를 추가하고 예상 이유로 RED를 확인한다.
- migration 파일은 생성하되 사용자 DB에 적용하지 않는다.
- software 검증과 실제 다중 fixture/층/그룹/전원 장애 HIL을 문서에서 구분한다.
- main checkout과 다른 worktree를 수정하거나 main에 merge하지 않는다.

---

### Task 1: CommandTimeoutService single-flight와 shutdown drain

**Files:**
- Modify: `apps/api/src/commands/command-timeout.service.spec.ts`
- Modify: `apps/api/src/commands/command-timeout.service.ts`

**Interfaces:**
- Produces: `stopAndDrain(): Promise<void>`, single-flight private scheduled runner, sanitized Logger error kind
- Preserves: `closeExpired(now?: Date): Promise<{ timedOut: number }>`는 직접 호출 시 reject 전달

- [x] **Step 1: lifecycle RED 테스트 작성** — deferred `findMany`로 첫 tick을 멈추고 두 번째 tick에서 DB 호출이 늘지 않음, Prisma `{ code: "P1001" }` reject가 unhandled rejection 없이 `P1001`만 log, destroy가 active batch 전에는 resolve하지 않고 이후 resolve함을 fake timer로 검증한다.
- [x] **Step 2: focused RED 실행** — `pnpm --filter @led-control/shared build && pnpm --filter @led-control/api exec jest src/commands/command-timeout.service.spec.ts --runInBand`; overlap/drain/logger assertion이 현재 구현에서 실패해야 한다.
- [x] **Step 3: 최소 구현** — `activeBatch`, `stopPromise`, `stopped`, `runScheduledBatch()`, `errorKind()`를 OutboxPublisher 패턴으로 추가하고 `onModuleDestroy()`가 `stopAndDrain()`을 반환하게 한다. log는 `command timeout batch failed (error=P1001)` 형태만 허용한다.
- [x] **Step 4: 기존 race 회귀 재실행** — pending outbox claim, publisher 선점, timeout 선점, transaction rollback, published/accepted 종료 테스트가 새 scheduled wrapper 아래에서도 그대로 통과하는지 확인한다. 상태별 outcome 분류는 schema가 생성되는 Task 3에서 추가한다.
- [x] **Step 5: focused GREEN과 commit** — 위 Jest 통과 후 `git commit -am "fix(api): serialize command timeout worker"`.

### Task 2: outcome·status-check DB 및 shared 계약

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260912090000_command_outcome_status_check/migration.sql`
- Modify: `packages/shared/src/gateway-contracts.ts`
- Modify: `packages/shared/src/gateway-contracts.test.ts`
- Modify: `apps/api/src/mqtt/outbox-publisher.service.ts`
- Modify: `apps/api/src/mqtt/outbox-publisher.service.spec.ts`
- Modify: `docs/database-schema.md`

**Interfaces:**
- Produces: `CommandOutcome = pending|applied|not_applied|partially_applied|unknown`, `CommandDispatchKind = dimming|status_check`
- Produces: `gatewayStatusCheckCommandDraftV2Schema`, published/compatibility schemas, `GatewayStatusCheckCommand*` types, MQTT kind `status-check`
- Produces: nullable legacy-safe `Command.outcome`, dispatch `kind`, `verificationAttempt`, unique nullable `clientRequestId`
- Final review 보정: nullable `MqttOutbox.deliveryAttemptedAt`, 발행 시도 이후 expiry/dead-letter/pending timeout은 `unknown`, 사전 검증 거절은 `not_applied`

- [x] **Step 1: shared RED 계약 테스트** — status-check topic, strict draft/published payload, publish-relative expiry, unique 1..64 fixture IDs, attempt 1..3, no requester PII를 assert한다.
- [x] **Step 2: Prisma/shared 최소 구현** — enum과 nullable 필드 migration을 작성하고 기존 행 backfill은 하지 않는다. generated Prisma client는 `pnpm --filter @led-control/api prisma:generate`로만 갱신한다.
- [x] **Step 3: publisher RED 테스트** — `kind=status_check` outbox가 dimming parser/override/group snapshot을 거치지 않고 status-check published payload와 MQTT expiry를 만들며, response loss 재claim은 같은 persisted generation을 사용함을 assert한다.
- [x] **Step 4: publisher 다형화 구현** — dispatch select에 kind를 포함하고 kind별 parser/preparer를 작은 함수로 분리한다. 공통 lease/publish/terminal 처리 코드는 한 경로에 유지한다.
- [x] **Step 5: 검증과 commit** — shared tests, publisher spec, API typecheck를 통과하고 `git commit -m "feat(control): add status check command contract" ...`로 관련 파일만 commit한다.

### Task 3: API 불확실 outcome 수렴과 상태 조회 생성

**Files:**
- Modify: `apps/api/src/commands/command-timeout.service.ts`
- Modify: `apps/api/src/commands/command-timeout.service.spec.ts`
- Create: `apps/api/src/commands/command-verification.service.ts`
- Create: `apps/api/src/commands/command-verification.service.spec.ts`
- Modify: `apps/api/src/commands/commands.controller.ts`
- Modify: `apps/api/src/commands/commands.controller.spec.ts`
- Modify: `apps/api/src/commands/commands.module.ts`
- Modify: `apps/api/src/commands/commands.service.ts`
- Modify: `apps/api/src/commands/commands.service.spec.ts`

**Interfaces:**
- Produces: `requestStatusCheck(user, commandId, { clientRequestId })`
- Consumes: Task 2 status-check draft schema/topic and dispatch fields
- Produces: 409 code `uncertain_command_requires_status_check`, `status_check_in_progress`, `status_check_attempts_exhausted`

- [x] **Step 1: verification RED 테스트** — read/control scope 은닉, unknown 전용 허용, 동일 clientRequestId idempotency, in-flight 차단, attempt 1..3, 네 번째 거부, dispatch/results/outbox 동일 transaction 생성을 검증한다.
- [x] **Step 2: verification service 구현** — 원 command와 dispatch를 transaction lock하고 gateway sequence를 증가시킨 뒤 status-check dispatch, pending fixture results, outbox를 생성한다. 응답은 dispatch ID, attempt, terminal status URL을 반환한다.
- [x] **Step 3: 겹침 차단 RED 테스트** — unknown command fixture set과 하나라도 겹치는 새 dimming은 409, not_applied/applied/null legacy는 기존 규칙대로 진행함을 검증한다.
- [x] **Step 4: 겹침 차단 구현** — target resolution 뒤 같은 site의 `outcome=unknown` fixture JSON 목록을 bounded read해 Set 교집합을 검사한다. 이 검사는 automation lock transaction 안에서 수행한다.
- [x] **Step 5: timeout 분류 구현과 GREEN** — Task 1의 pending/published/accepted/status_check 기대값을 구현하고 controller/service focused specs와 API typecheck를 통과한다.
- [x] **Step 6: commit** — `git commit -m "feat(api): verify uncertain lighting commands" ...`.

### Task 4: Gateway status Get 실행과 restart/duplicate 내구성

**Files:**
- Create: `apps/gateway/src/commands/gateway-status-check-handler.ts`
- Create: `apps/gateway/src/commands/gateway-status-check-handler.test.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/index.test.ts`
- Modify: `apps/gateway/src/commands/command-journal.ts`
- Modify: `apps/gateway/src/commands/command-journal.test.ts`

**Interfaces:**
- Consumes: `BleMeshAdapter.resyncLightingFixtures()`와 `onLightingObservation()`
- Produces: `handleGatewayStatusCheck(adapter, journal, command, onAccepted, options): Promise<GatewayCommandResult>`
- Publishes: 기존 acceptance/device-status ACK topic; observed fixture는 brightness, 미관측 fixture는 `timed_out`

- [x] **Step 1: Gateway RED 테스트** — 전체 관측, 일부 status loss, expiry 전 실행 금지, acceptance 직후 journal restart, completed duplicate 재사용, 중복 MQTT delivery가 두 번째 Get을 실행하지 않음을 검증한다.
- [x] **Step 2: handler 최소 구현** — acceptance durable write 후 관측 listener를 설치하고 targeted resync를 실행해 fixture별 결과를 만든다. listener cleanup과 AbortSignal deadline을 보장한다.
- [x] **Step 3: runtime RED 테스트** — status-check topic subscribe/deferred PUBACK, acceptance/device-status publish 순서, publish 실패 뒤 broker redelivery의 journal replay를 검증한다.
- [x] **Step 4: runtime 연결 구현** — command parser/handler를 등록하고 dimming과 동일한 durable receipt boundary를 사용한다. shutdown은 진행 중 handler를 drain한다.
- [x] **Step 5: Gateway focused test/typecheck/commit** — handler, journal, index specs와 `pnpm --filter @led-control/gateway typecheck` 통과 후 `git commit -m "feat(gateway): verify command outcome with status get" ...`.

### Task 5: API ACK reconciliation과 명령 이력

**Files:**
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.spec.ts`
- Modify: `apps/api/src/commands/command-status.service.ts`
- Modify: `apps/api/src/commands/command-status.service.spec.ts`
- Modify: `apps/api/src/commands/commands.controller.ts`
- Modify: `apps/api/src/commands/commands.controller.spec.ts`

**Interfaces:**
- Produces: command detail `outcome`, `verificationAttemptCount`, dispatch `kind/verificationAttempt`
- Produces: `listCommands(user, { siteId, query?, stage?, cursor?, limit? })`
- Allows: timeout unknown dimming dispatch의 late device-status ACK 1회 수렴

- [x] **Step 1: ACK RED 테스트** — restart timed_out ACK→unknown, 늦은 succeeded ACK→applied, 늦은 duplicate 무변경, mixed result→partially_applied, status-check 전부 일치/불일치/혼합/미관측 outcome을 검증한다.
- [x] **Step 2: transaction reconciliation 구현** — row lock에 kind/outcome을 포함하고 kind별 terminal 처리 함수를 분리한다. 늦은 ACK는 `unknown + timeout error code` 조건에서만 허용한다.
- [x] **Step 3: detail/history RED 테스트** — site scope 은닉, 최신순 `(createdAt,id)` cursor, limit 1..100, ID prefix/fixture name query, stage filter, detail 재오픈용 outcome/dispatch metadata를 검증한다.
- [x] **Step 4: history 구현** — query DTO를 명시적으로 parse하고 목록에는 요약만, 상세에는 fixture 결과 전체를 반환한다. 검색은 입력 길이를 제한하고 site predicate를 모든 OR branch에 유지한다.
- [x] **Step 5: API focused 및 integration 검증** — command, mqtt, timeout specs와 API typecheck를 통과하고 `git commit -m "feat(api): reconcile and search control commands" ...`.

### Task 6: Web 실제 상태 확인·안전 재적용·명령 이력 UI

**Files:**
- Modify: `apps/web/src/api/commands.ts`
- Modify: `apps/web/src/api/commands.test.ts`
- Create: `apps/web/src/features/control/CommandHistoryPanel.tsx`
- Create: `apps/web/src/features/control/CommandHistoryPanel.test.tsx`
- Create: `apps/web/src/features/control/CommandOutcomeActions.tsx`
- Create: `apps/web/src/features/control/CommandOutcomeActions.test.tsx`
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Modify: `apps/web/src/features/control/ControlView.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 5 detail/list API and Task 3 status-check POST
- Preserves: failed POST의 동일 `clientRequestId` 재전송
- Produces: `unknown` 상태 확인, `not_applied` 안전 재적용, history search/filter/detail reopen

- [x] **Step 1: API hook RED 테스트** — list cursor/query encoding, status-check body idempotency, detail stage `verification_required|verified_applied|verified_not_applied|verified_partial` polling 종료 규칙을 검증한다.
- [x] **Step 2: action component RED 테스트** — unknown에는 Set 버튼 없이 “실제 상태 확인”, 3회 소진 경고; not_applied에만 “안전하게 다시 적용”; applied/partial에 설명만 표시함을 검증한다.
- [x] **Step 3: history component RED 테스트** — debounce 검색, 상태 필터, 더 보기 cursor, row 선택 detail 조회, 닫고 다시 열기를 검증한다.
- [x] **Step 4: 컴포넌트 구현** — reusable Button/Card/StatusBadge를 사용하고 새 카드 두 개를 control 폴더에 분리한다. 진행 중 status-check는 기존 controls lock에 포함한다.
- [x] **Step 5: ControlView 통합 RED/GREEN** — HTTP response loss 버튼은 “동일 요청 확인(새 제어 아님)” 문구, terminal unknown은 상태 확인, 검증 not_applied 후에만 새 clientRequestId 재적용, history에서 기존 상세 재오픈을 검증한다.
- [x] **Step 6: Web focused test/typecheck/build/commit** — `commands`, 세 컴포넌트 테스트, `pnpm --filter @led-control/web typecheck`, build 통과 후 `git commit -m "feat(web): add safe command recovery and history" ...`.

### Task 7: 문서 수렴, 전체 검증, HIL 분리

**Files:**
- Modify: `docs/menus/control.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-12-p0-p1-control-reliability.md`

**Interfaces:**
- Consumes: Tasks 1~6 fresh 검증 결과
- Produces: software 완료 범위와 남은 HIL을 분리한 정본 문서 및 체크리스트

- [x] **Step 1: 메뉴/스키마 문서 갱신** — outcome, status-check, history, safe retry, migration 미적용, 권한과 한계를 기록한다.
- [x] **Step 2: 상태판 갱신** — software tests와 실제 다중 fixture/층/그룹/전원차단/gateway kill/broker loss HIL을 별도 표로 기록한다.
- [x] **Step 3: 전체 검증** — shared build/test, API typecheck/test/build, Gateway typecheck/test/build, Web typecheck/test/build, `git diff --check`를 fresh 실행한다.
- [x] **Step 4: migration 정적 검증** — `prisma validate`, migration SQL review와 schema doc 일치를 확인하되 migrate 명령은 실행하지 않는다.
- [x] **Step 5: 최종 review 수정** — branch 전체 review의 Critical/Important를 수정하고 관련 focused+전체 검증을 다시 실행한다.
- [x] **Step 6: checklist와 commit** — 실제 test 수, skip, 남은 HIL, commit 목록을 본 문서에 기록하고 `git commit -m "docs: record control reliability verification" ...`.

#### Task 7 최초 검증 (2026-09-12, `465984c` 시점)

- Focused deferred-minor 검증: `pnpm --filter @led-control/shared build && pnpm --filter @led-control/api exec jest src/commands/command-verification.service.spec.ts src/mqtt/outbox-publisher.service.spec.ts --runInBand` — 2 suites, 51/51 passed. 이때 publisher fake는 `publishClaimed`를 직접 호출하고 모든 row update에 성공을 반환했으므로 실제 `claimBatch` 재획득과 published/expiry 분기는 증명하지 못했다. 이 결과만으로 Task 2 reclaim minor를 닫았던 판단은 아래 최종 수정에서 정정한다. 65개 대상의 두 번째 chunk outbox insert 실패가 소유 transaction을 reject하는 회귀를 추가했다.
- Shared: `pnpm --filter @led-control/shared build && pnpm --filter @led-control/shared test` — build 성공, 14 files·200/200 passed.
- API: `pnpm --filter @led-control/api typecheck && pnpm --filter @led-control/api test -- --runInBand && pnpm --filter @led-control/api build` — typecheck/build 성공, 112 suites·1,158 passed, 27 suites·272 environment-gated skipped. Skipped integration은 통과로 간주하지 않으며 PostgreSQL-backed event-ledger partial-index/concurrent ACK race 검증도 미실행 상태다.
- Gateway: `pnpm --filter @led-control/gateway typecheck && pnpm --filter @led-control/gateway test && pnpm --filter @led-control/gateway build` — typecheck/build 성공, 65 files·624/624 passed, bundle `573.7kb`.
- Web: `pnpm --filter @led-control/web typecheck && pnpm --filter @led-control/web test && pnpm --filter @led-control/web build` — typecheck/build 성공, 61 files·715/715 passed. Main bundle `1,275.95 kB`/gzip `381.15 kB`와 기존 500 kB chunk-size warning은 남는다.
- Chromium: `pnpm --filter @led-control/web exec playwright test e2e/calm-operations-manual-control.spec.ts --project=chromium` — 21/21 passed. `FORCE_COLOR` 때문에 `NO_COLOR`가 무시된다는 비기능 Node 경고가 출력됐다.
- Prisma: `DATABASE_URL='postgresql://placeholder:placeholder@127.0.0.1:1/placeholder?schema=public' pnpm --filter @led-control/api exec prisma validate --schema prisma/schema.prisma` — 비접속 process-local placeholder URL로 schema valid. `20260912090000_command_outcome_status_check/migration.sql`의 enum, nullable legacy outcome, dispatch kind/default, attempt/request identity와 unique index를 schema/document와 대조했다. `prisma migrate` 계열 명령은 실행하지 않았고 사용자 DB는 변경하지 않았다.
- Review: Task 1 시작점 `9caff67e36c1007ae0060bebb3afce6336657b78`부터 Task 6 HEAD `f9ca6567ec1ceb5b7514efeb5543b0f37a5c805a`까지 diff와 단계별 review 기록을 재확인했다. 이 단계별 확인 뒤 최종 전체 review에서 BlueZ timeout 분류와 PUBACK 유실 뒤 terminal outcome에 Important 2건을 확인했다. Task 3의 chunk 실패 회귀는 유지하고, Task 2 reclaim minor는 아래 실제 claimBatch 기반 회귀로 보완한다. PostgreSQL concurrent ACK 검증은 환경 의존 미실행으로 남긴다.
- Software/HIL 경계: software는 dispatch당 64개 chunk, 최대 3 logical attempts, timeout worker single-flight/drain, status Get durable receipt/replay, device-status `eventId`/hash dedupe, history/상세 재열기와 `not_applied` safe retry를 검증한다. 자동 Set retry는 없다. 실제 다중 fixture·층·저장 구역·Mesh Group·전원 차단·broker loss·Gateway process kill HIL은 실행하지 않았다.
- Commit 목록: `dd6e23f`, `601670f`, `3346c2a`, `9efab97`, `5bc2474`, `9428915`, `a7cb777`, `7408241`, `453d1d3`, `fa9bfa1`, `cdc3faf`, `97dda95`, `034a2e1`, `d7eee6b`, `04d56a0`, `f9ca656`; Task 7은 `docs: record control reliability verification`으로 기록한다.

#### 최종 전체 review 보정 (2026-09-12, 기준 `465984c`)

- [x] **Important 1** — 실제 BlueZ→Gateway handler의 Lightness Status 유실을 `timed_out`으로 보정했다. API는 기존 `failed + STATUS_TIMEOUT`의 원문 aggregate를 검증한 뒤 timeout evidence를 저장하며 unknown/Get 허용·Set overlap 차단까지 통과했다.
- [x] **Important 2** — MQTT 호출 전 `deliveryAttemptedAt`을 commit한다. 발행 뒤 PUBACK 유실의 expiry/dead-letter와 pending worker timeout은 unknown으로 닫고 late ACK 수렴을 허용한다. 발행 전 validation은 not_applied로 유지하며 dispatch 전이에 실패한 terminal writer는 results/parent를 쓰지 않는다. 모든 publisher mutation은 automation lock 뒤에 위치하고 MQTT 대기 중에는 transaction을 유지하지 않는다.
- [x] **Task 2 reclaim minor** — 기존 직접 `publishClaimed` fake의 과장된 reclaim 주장을 정정했다. 신규 stateful persistence 경계가 실제 `processBatch/claimBatch`를 실행하고, 같은 generation/남은 TTL로 retry 성공 후 published row는 재claim하지 않는 경로와 PUBACK 유실 뒤 별도 expiry terminal 경로를 각각 검증한다. 실제 PostgreSQL 잠금/rollback 증거로 확대하지 않는다.
- [x] **문서·호환성** — DB 흐름의 event/hash dedupe는 device-status로 한정했다. 구버전 혼합 배포는 안전하지 않으며 신규 publisher·Gateway·API consumer가 준비된 뒤 status-check producer/API와 UI를 활성화하도록 명시했다. 사용자 DB migration과 HIL은 수행하지 않았다.
- [x] **RED** — `pnpm --filter @led-control/api exec jest src/commands/command-delivery-reliability.spec.ts --runInBand`: 최초 12 failed/3 baseline passed. `pnpm --filter @led-control/gateway exec vitest run src/mesh/bluez-mesh-adapter.test.ts -t 'lost Lightness Status'`: 1 failed/38 이름 필터 skipped. 예상 실패는 각각 pending/not_applied 오분류·발행 기록 누락·잠금 순서와 Gateway failed ACK였다.
- [x] **Focused GREEN** — `pnpm --filter @led-control/api exec jest src/commands/command-delivery-reliability.spec.ts src/mqtt/outbox-publisher.service.spec.ts src/mqtt/mqtt.service.spec.ts src/commands/command-timeout.service.spec.ts src/commands/command-verification.service.spec.ts src/commands/commands.service.spec.ts --runInBand`: 6 suites·209/209. Gateway 어댑터·dimming/status-check handler 3 files·77/77. 신규 API lifecycle는 최종 18개다. Dispatch 전이 gate를 잠시 제거한 mutation 검증은 1 failed/17 이름 필터 skipped로 결과/parent 중복 write를 잡았고, 복구 후 전체 API를 재실행했다.
- [x] **최종 전체 GREEN** — `pnpm --filter @led-control/api typecheck && pnpm --filter @led-control/api exec jest --runInBand`: typecheck 성공, 113 suites·1,176 passed, 27 suites·272 environment-gated skipped. `pnpm --filter @led-control/gateway exec vitest run`: 65 files·625/625. Gateway typecheck와 API/Gateway build 성공, Gateway bundle `573.8kb`. `pnpm --filter @led-control/shared exec vitest run`: 14 files·200/200. Web·Chromium은 위 최초 검증을 유지하며 이번 보정에서는 재실행하지 않았다.
- [x] **Prisma/정적 검증** — `pnpm --filter @led-control/api prisma:generate`, `pnpm --filter @led-control/api exec prisma format --schema prisma/schema.prisma`, `DATABASE_URL='postgresql://placeholder:placeholder@127.0.0.1:1/placeholder?schema=public' pnpm --filter @led-control/api exec prisma validate --schema prisma/schema.prisma` 성공. `git diff --check` 통과. 어떤 migrate 명령도 실행하지 않았고 PostgreSQL partial-index/concurrent ACK 및 실제 HIL은 여전히 미실행이다.

상세 보고서: `.superpowers/sdd/2026-09-12-p0-p1-control-reliability/final-fix-report.md`. 최종 보정은 `fix(control): preserve uncertain delivery outcomes` 커밋으로 기록한다.

# P0/P1 조명 제어 신뢰성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** timeout을 실제 적용 실패로 오판하지 않고 후속 상태 조회로 수렴시키며, 중복 물리 제어를 막고 명령 이력을 다시 열 수 있게 한다.

**Architecture:** `Command.outcome`이 물리 결과를, `CommandDispatch.status/kind`가 전송 단계를 표현한다. 상태 조회도 기존 dispatch/outbox/ACK 경로를 사용하되 Set 대신 Gateway의 Generic OnOff/Lightness Get을 실행한다. API가 겹치는 unknown 명령을 차단하고 Web은 HTTP 동일 요청 확인, 실제 상태 확인, 검증 후 안전 재적용을 별도 행동으로 제공한다.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, MQTT QoS 1, Vitest/Jest, React 18, TanStack Query

**Spec:** `docs/superpowers/specs/2026-09-12-p0-p1-control-reliability-design.md`

## Global Constraints

- 자동 또는 background 밝기 Set 재전송을 추가하지 않는다.
- 상태 조회 최대 시도는 명령당 3회다.
- 기존 command status와 ACK payload는 rolling compatibility를 유지한다.
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

- [ ] **Step 1: Gateway RED 테스트** — 전체 관측, 일부 status loss, expiry 전 실행 금지, acceptance 직후 journal restart, completed duplicate 재사용, 중복 MQTT delivery가 두 번째 Get을 실행하지 않음을 검증한다.
- [ ] **Step 2: handler 최소 구현** — acceptance durable write 후 관측 listener를 설치하고 targeted resync를 실행해 fixture별 결과를 만든다. listener cleanup과 AbortSignal deadline을 보장한다.
- [ ] **Step 3: runtime RED 테스트** — status-check topic subscribe/deferred PUBACK, acceptance/device-status publish 순서, publish 실패 뒤 broker redelivery의 journal replay를 검증한다.
- [ ] **Step 4: runtime 연결 구현** — command parser/handler를 등록하고 dimming과 동일한 durable receipt boundary를 사용한다. shutdown은 진행 중 handler를 drain한다.
- [ ] **Step 5: Gateway focused test/typecheck/commit** — handler, journal, index specs와 `pnpm --filter @led-control/gateway typecheck` 통과 후 `git commit -m "feat(gateway): verify command outcome with status get" ...`.

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

- [ ] **Step 1: ACK RED 테스트** — restart timed_out ACK→unknown, 늦은 succeeded ACK→applied, 늦은 duplicate 무변경, mixed result→partially_applied, status-check 전부 일치/불일치/혼합/미관측 outcome을 검증한다.
- [ ] **Step 2: transaction reconciliation 구현** — row lock에 kind/outcome을 포함하고 kind별 terminal 처리 함수를 분리한다. 늦은 ACK는 `unknown + timeout error code` 조건에서만 허용한다.
- [ ] **Step 3: detail/history RED 테스트** — site scope 은닉, 최신순 `(createdAt,id)` cursor, limit 1..100, ID prefix/fixture name query, stage filter, detail 재오픈용 outcome/dispatch metadata를 검증한다.
- [ ] **Step 4: history 구현** — query DTO를 명시적으로 parse하고 목록에는 요약만, 상세에는 fixture 결과 전체를 반환한다. 검색은 입력 길이를 제한하고 site predicate를 모든 OR branch에 유지한다.
- [ ] **Step 5: API focused 및 integration 검증** — command, mqtt, timeout specs와 API typecheck를 통과하고 `git commit -m "feat(api): reconcile and search control commands" ...`.

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

- [ ] **Step 1: API hook RED 테스트** — list cursor/query encoding, status-check body idempotency, detail stage `verification_required|verified_applied|verified_not_applied|verified_partial` polling 종료 규칙을 검증한다.
- [ ] **Step 2: action component RED 테스트** — unknown에는 Set 버튼 없이 “실제 상태 확인”, 3회 소진 경고; not_applied에만 “안전하게 다시 적용”; applied/partial에 설명만 표시함을 검증한다.
- [ ] **Step 3: history component RED 테스트** — debounce 검색, 상태 필터, 더 보기 cursor, row 선택 detail 조회, 닫고 다시 열기를 검증한다.
- [ ] **Step 4: 컴포넌트 구현** — reusable Button/Card/StatusBadge를 사용하고 새 카드 두 개를 control 폴더에 분리한다. 진행 중 status-check는 기존 controls lock에 포함한다.
- [ ] **Step 5: ControlView 통합 RED/GREEN** — HTTP response loss 버튼은 “동일 요청 확인(새 제어 아님)” 문구, terminal unknown은 상태 확인, 검증 not_applied 후에만 새 clientRequestId 재적용, history에서 기존 상세 재오픈을 검증한다.
- [ ] **Step 6: Web focused test/typecheck/build/commit** — `commands`, 세 컴포넌트 테스트, `pnpm --filter @led-control/web typecheck`, build 통과 후 `git commit -m "feat(web): add safe command recovery and history" ...`.

### Task 7: 문서 수렴, 전체 검증, HIL 분리

**Files:**
- Modify: `docs/menus/control.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-12-p0-p1-control-reliability.md`

**Interfaces:**
- Consumes: Tasks 1~6 fresh 검증 결과
- Produces: software 완료 범위와 남은 HIL을 분리한 정본 문서 및 체크리스트

- [ ] **Step 1: 메뉴/스키마 문서 갱신** — outcome, status-check, history, safe retry, migration 미적용, 권한과 한계를 기록한다.
- [ ] **Step 2: 상태판 갱신** — software tests와 실제 다중 fixture/층/그룹/전원차단/gateway kill/broker loss HIL을 별도 표로 기록한다.
- [ ] **Step 3: 전체 검증** — shared build/test, API typecheck/test/build, Gateway typecheck/test/build, Web typecheck/test/build, `git diff --check`를 fresh 실행한다.
- [ ] **Step 4: migration 정적 검증** — `prisma validate`, migration SQL review와 schema doc 일치를 확인하되 migrate 명령은 실행하지 않는다.
- [ ] **Step 5: 최종 review 수정** — branch 전체 review의 Critical/Important를 수정하고 관련 focused+전체 검증을 다시 실행한다.
- [ ] **Step 6: checklist와 commit** — 실제 test 수, skip, 남은 HIL, commit 목록을 본 문서에 기록하고 `git commit -m "docs: record control reliability verification" ...`.

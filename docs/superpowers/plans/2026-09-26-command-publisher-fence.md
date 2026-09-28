# Command Publisher and Retention Fence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 중앙 DB의 3개월 만료 Command 원본을 지우기 전 모든 구세대 Set 발행·전달·RF 실행 가능성을 소진했음을 확인하는 다중 API/브로커/보관 worker 경계를 만든다.

**Architecture:** `CommandPublishEpoch`를 DB의 Set 발행 세대로 두고, Set 전용 mTLS egress와 broker admission fence를 기존 Get/수집 연결에서 분리한다. Quiesce는 DB permit과 broker 구세대 거부·Gateway 실행 drain을 모두 확인하고, 보호된 retention worker는 그 증거 없이는 disposable DB에서도 삭제하지 않는다. 운영 broker의 반롤백 admission과 실장비 RF 증거가 없는 환경에서 production purge는 계속 OFF다.

**Tech Stack:** NestJS, Prisma/PostgreSQL, MQTT v5/Mosquitto mTLS, Jest, disposable PostgreSQL/Mosquitto, SQL protected cutover.

**Spec:** `docs/superpowers/specs/2026-09-26-command-retention-wire-safety-design.md`

## Global Constraints

- 최근 3개월은 Central DB UTC 요청 시각에서 3 calendar months를 역산한 rolling 경계다. `Command.createdAt < cutoff`만 삭제하며 경계와 같은 행은 보존한다. 기존 보호 DB role/HMAC/hold/late ACK 경계는 약화하지 않는다.
- Set 발행은 10초 wire TTL과 2초 expiry guard를 유지한다. DB permit 소실 뒤 MQTT.js deferred QoS1도 broker에서 구세대 수락 0이어야 한다.
- Set quiesce는 원본 만료 전 legacy status-check Get, 원본 만료 후 Get-only recovery, monitoring/ACK/telemetry를 막지 않는다.
- `COMMAND_RETENTION_PURGE_ENABLED=1`과 recovery POST는 broker 반롤백·DB 시각 건전성·구 Gateway census·RF drain HIL을 증명할 때까지 계속 hard reject다. 운영 DB migration/초기화/배포는 계획 실행으로 암묵 승인되지 않는다.
- Schema를 바꾸면 `docs/database-schema.md`, 제어/모니터링 메뉴 동작을 바꾸면 해당 `docs/menus/{control,monitoring}.md`를 함께 갱신한다.

## Review Focus

1. DB backend kill 후 old API의 deferred QoS1 publish → broker 수락 0 (Task 3, 4, 6).
2. 구 broker ACL/CRL로 재시작·롤백 → 구세대 입장 거부 또는 broker 기동 거부 (Task 5, 6).
3. 응답 없는 API member/오프라인 Gateway → 자동 안전 판정 금지, purge 0 (Task 4, 6).
4. Set quiesce 중 legacy Get/recovery Get과 monitoring → 기존 발행/수신 가능 (Task 2, 3, 6).
5. DB clock step/failover 또는 최대 `expiresAt` attempt 누락 → barrier 무효, 원본 삭제 0 (Task 1, 4, 6).

## File Map and Ownership

- DB/epoch owner: `apps/api/prisma/schema.prisma`, additive migration, new `apps/api/src/mqtt/command-publish-epoch.service.ts`, `apps/api/src/commands/command-retention-worker.ts`, protected SQL and `docs/database-schema.md`.
- Publisher owner: `apps/api/src/mqtt/outbox-publisher.service.ts`, new legacy Get publisher and Set egress client, `mqtt.module.ts`, `mqtt.service.ts` plus tests.
- Broker/infrastructure owner: `infra/mosquitto.acl.example`, `scripts/dev-runtime.mjs`, production compose/runbook and broker fault tests. Stock Mosquitto ACL/CRL does not by itself prove irreversible admission; its production integration is a separate explicit gate.
- Shared dependency: Gateway plan Task 1 defines `publishEpoch: number` and clock topics. Do not edit shared contract files concurrently.

### Task 1: Additive epoch and attempt envelope

**Files:** Modify `apps/api/prisma/schema.prisma`; create an additive `apps/api/prisma/migrations/<timestamp>_command_publish_epoch/migration.sql`; create `apps/api/src/mqtt/command-publish-epoch.service.ts` and `.spec.ts`; modify `docs/database-schema.md`.

**Interfaces:** `CommandPublishEpoch` has monotonic positive integer `generation`, `status` (`active|quiescing|fenced|retired`), transition timestamps; `CommandPublishMember` records generation/worker ID, quiesce ACK and broker identity; `CommandPublishAttempt` retains each attempted Set's epoch and maximum absolute `expiresAt` without raw payload. A protected `CommandPurgeBarrierEvidence` row later holds worker-signed broker/Gateway/clock digests, not command payload. `CommandPublishEpochService.currentForSet(tx)` returns only active generation, and `maxUnsettledExpiry(tx,generation)` fails on missing/legacy envelopes.

- [ ] **Step 1 — RED test:** Disposable DB rejects duplicate/retired active generation, invalid transition, attempt without valid Set relation; exact max expiry includes attempted-but-unacknowledged Set and fails on legacy unknown expiry.
- [ ] **Step 2 — Run RED:** `COMMAND_RETENTION_TEST=1 pnpm --filter @led-control/api exec jest src/mqtt/command-publish-epoch.integration.spec.ts --runInBand`; expect missing schema/service failure.
- [ ] **Step 3 — Implement:** Add migration/model/service, protected transition constraints, indexes and least-privilege roles; do not copy command payload/idempotency key into evidence rows. Update DB schema document.
- [ ] **Step 4 — Run GREEN:** Repeat Step 2, run `pnpm --filter @led-control/api prisma:generate` and API typecheck; expect exit 0.
- [ ] **Step 5 — Commit:** Commit Task 1 files only.

### Task 2: Separate Set from both Get publishers

**Files:** Modify `apps/api/src/mqtt/outbox-publisher.service.ts`, `outbox-publisher.service.spec.ts`, `mqtt.module.ts`; create `legacy-status-check-publisher.service.ts` and `.spec.ts`; preserve `recovery-outbox-publisher.service.ts` and its tests.

**Interfaces:** `OutboxPublisherService` claims/prepares/publishes only `CommandDispatchKind.dimming`; `LegacyStatusCheckPublisherService` owns only `status_check` and retains its original-Command cutoff; `RecoveryOutboxPublisherService` remains parent-free Get-only. Each kind has its own topic-restricted publish path and lease; no Set epoch lock is required for Get.

- [ ] **Step 1 — RED test:** Mixed outbox yields exactly one Set and one legacy Get owner; quiescing Set does not claim/prepare/publish Set but both Get paths still publish; no duplicate lease or wrong topic.
- [ ] **Step 2 — Run RED:** `pnpm --filter @led-control/api exec jest src/mqtt/outbox-publisher.service.spec.ts src/mqtt/legacy-status-check-publisher.service.spec.ts src/mqtt/recovery-outbox-publisher.service.spec.ts --runInBand`; expect new split assertions to fail.
- [ ] **Step 3 — Implement:** Split SQL claim filter, prepare and terminal retry by `kind`; register live providers only after their focused tests pass, retaining existing Get ACK/status semantics.
- [ ] **Step 4 — Run GREEN:** Repeat Step 2 and API typecheck; expect exit 0.
- [ ] **Step 5 — Commit:** Commit Task 2 files/tests; update `docs/menus/control.md` if Get behavior/status text changes.

### Task 3: Generation-scoped Set MQTT egress and ACL narrowing

**Files:** Create `apps/api/src/mqtt/command-set-mqtt.service.ts` and `.spec.ts`; modify `mqtt.module.ts`, `mqtt.service.ts`, `outbox-publisher.service.ts`, `infra/mosquitto.acl.example`, `scripts/dev-runtime.mjs`, `scripts/dev-mqtt-acl.integration.test.mjs`, `docker-compose.production.yml` and relevant production runbook.

**Interfaces:** `CommandSetMqttService.publish(generation,topic,payload,expirySeconds)` uses a dedicated mTLS identity/client ID for the active epoch, `clean:true`, session expiry 0, and refuses missing DB registration. Shared `MqttService.publishTopic` explicitly rejects dimming topic; broker ACL denies dimming to legacy `api-service` but permits its exact Get/ACK/state/other existing topics. A command-client close callback is not broker drain proof.

- [ ] **Step 1 — RED test:** Old `api-service` and retired generation cannot publish dimming; active generation can, and old client retains required non-Set subscriptions/publishes. Deferred QoS1 after local timeout cannot bypass a broker deny.
- [ ] **Step 2 — Run RED:** `pnpm --filter @led-control/api exec jest src/mqtt/command-set-mqtt.service.spec.ts --runInBand` and `node --test scripts/dev-mqtt-acl.integration.test.mjs`; expect new deny tests to fail.
- [ ] **Step 3 — Implement:** Separate command client lifecycle, exact topic ACLs and credential configuration; do not replace legacy client until all required non-Set topics are enumerated and tested.
- [ ] **Step 4 — Run GREEN:** Repeat Step 2, API typecheck and production compose configuration tests; expect exit 0.
- [ ] **Step 5 — Commit:** Commit Task 3 files/tests and runbook. Keep purge OFF.

### Task 4: Epoch-aware Set claim, publish permit and DB clock continuity

**Files:** Modify `apps/api/src/mqtt/outbox-publisher.service.ts`, `.spec.ts`, `outbox-publisher-permit.integration.spec.ts`; create `command-publish-quiesce.service.ts` and `.spec.ts`; consume the API clock-health gate from Gateway plan Task 2.

**Interfaces:** Set claim/prepare/attempt/publish query `currentForSet(tx)` under the existing shared advisory permit key `8052026092501`; persist `CommandPublishAttempt` before MQTT; reject epoch or DB-clock-health loss without generating a new wire window. `CommandPublishQuiesceService.begin()` takes the exclusive permit, changes active→quiescing, and gathers member ACKs; missing ACK never expires into success.

- [ ] **Step 1 — RED test:** Two publishers race a quiesce; no later Set claim/prepare, DB backend kill releases SQL permit but old generation broker publish is denied, clock step/failover invalidates attempt. Preserve unknown on lost PUBACK.
- [ ] **Step 2 — Run RED:** `COMMAND_RETENTION_TEST=1 pnpm --filter @led-control/api exec jest src/mqtt/outbox-publisher-permit.integration.spec.ts src/mqtt/command-publish-quiesce.service.spec.ts --runInBand`; expect new race assertions to fail.
- [ ] **Step 3 — Implement:** Add epoch checks to every Set stage and attempt envelope; keep lock order `automation mutation → shared publish permit`, and release it before waiting for an exclusive permit. Do not let a DB transaction outlive a broker drain wait.
- [ ] **Step 4 — Run GREEN:** Repeat Step 2, API full focused MQTT tests/typecheck; expect exit 0.
- [ ] **Step 5 — Commit:** Commit Task 4 files/tests.

### Task 5: Broker antirollback admission evidence

**Files:** Create `apps/api/src/mqtt/broker-generation-fence.ts` and `.spec.ts`; extend `scripts/dev-mqtt-acl.integration.test.mjs`, `infra/mosquitto.acl.example`, production deployment runbook and compose checks.

**Interfaces:** `BrokerGenerationFence.verifyRetired(generation): Promise<BrokerFenceEvidence>` must attest **every** broker node: old cert revoked, old session/queue discarded, fresh old-generation publish denied, and admission minimum generation persisted across restart/ACL/CRL rollback. The production adapter denies by default where stock Mosquitto cannot supply immutable admission evidence; a mock/disposable adapter may prove the contract but cannot authorize production purge.

- [ ] **Step 1 — RED test:** A one-time ACL rejection or client `end()` cannot yield evidence; restarting stock broker with old ACL/CRL makes verifier fail and purge stay OFF; missing broker node or stale evidence blocks transition. A secure-admission test double must deny retired generations after rollback.
- [ ] **Step 2 — Run RED:** `pnpm --filter @led-control/api exec jest src/mqtt/broker-generation-fence.spec.ts --runInBand` and `node --test scripts/dev-mqtt-acl.integration.test.mjs`; expect new assertions to fail.
- [ ] **Step 3 — Implement:** Build a fail-closed evidence interface and disposable broker fault harness; document the external immutable admission/CA revocation control required for the production adapter. Do not label ACL reload alone as antirollback or claim stock Mosquitto passes that gate.
- [ ] **Step 4 — Run GREEN:** Repeat Step 2 plus production compose smoke/config tests; expect exit 0 and production evidence remains unavailable until externally provisioned.
- [ ] **Step 5 — Commit:** Commit Task 5 files/tests/runbook.

### Task 6: Monotonic drain barrier and protected retention integration

**Files:** Create `apps/api/src/commands/command-purge-barrier.service.ts` and tests, `apps/api/src/mqtt/gateway-command-drain.service.ts` and tests; modify `command-retention-worker.ts`, `.spec.ts`, `.integration.spec.ts`, protected delete SQL/cutover test, `apps/api/src/commands/command-recovery-rollout.guard.ts`, `docs/database-schema.md` and `docs/menus/control.md`.

**Interfaces:** `GatewayCommandDrainService.verify(generation)` queries the complete active Gateway inventory, issues Task 1 scoped nonce drain requests and validates exact scope/epoch/version/bootId, zero queued/submitted/unconfirmed Set work, plus old offline session revocation. `CommandPurgeBarrier.assertReady(tx,generation)` requires fenced epoch, trusted same-primary DB clock, Task 5 all-node broker evidence, Task 1 max attempted absolute expiry, independent monotonic wait of `max(expiry-at-fence incl. 2s lead, 10s Gateway sample age) + measured submit→RF upper bound`, and the verified Gateway census. A separate restricted worker signs `CommandPurgeBarrierEvidence` for exact generation/clock-primary/broker/Gateway digests; API runtime cannot write or sign it. Worker restart/failover/clock step resets barrier; protected DB delete rechecks the same generation and signed evidence. Missing evidence returns a bounded reason, deletes 0.

- [ ] **Step 1 — RED test:** Missing member, legacy attempt, clock step, wrong drain nonce/scope/version, offline old Gateway, queued/submitted RF, broker rollback or barrier restart all yield deleted=0; valid disposable evidence deletes only `createdAt < cutoff`, preserves holds/Get and exact-boundary Command.
- [ ] **Step 2 — Run RED:** `COMMAND_RETENTION_TEST=1 pnpm --filter @led-control/api exec jest src/commands/command-purge-barrier.service.spec.ts src/commands/command-retention-worker.integration.spec.ts --runInBand`; expect new barrier assertions to fail.
- [ ] **Step 3 — Implement:** Gate the existing test-only protected worker/SQL with immutable evidence token and final transaction recheck; retain production hard reject until external broker admission, DB-host clock attestation, Gateway census and Pi/BlueZ/BIO HIL are independently signed off.
- [ ] **Step 4 — Run GREEN:** Repeat Step 2, API full tests/typecheck/build and `git diff --check`; expect exit 0. Record overdue/backlog, not raw payload, on blocked candidates.
- [ ] **Step 5 — Commit:** Commit Task 6 files/tests/docs. Do not run production migration/reset or enable purge/recovery POST.

### Task 7: Clock refusal ACK and late-case attribution

**Files:** Modify `apps/api/src/mqtt/mqtt.service.ts`, `mqtt.service.spec.ts`, `apps/api/src/commands/command-status.service.ts` and `.spec.ts`; add focused tests beside `command-late-set-ack.service.ts` and `command-recovery-ack.service.ts`.

**Interfaces:** Existing `COMMAND_EXPIRED` mapping remains. `GATEWAY_CLOCK_UNTRUSTED` is a terminal pre-RF refusal attributed to the exact site/gateway/dispatch/target, never a successful fixture observation or automatic Set retry. Already-sent/unknown cases remain in hold/status-check, including late ACK after original deletion.

- [ ] **Step 1 — RED test:** Wrong site/gateway/dispatch refusal changes 0 commands; valid pre-RF refusal is terminal with Set retry 0; late RF-uncertain ACK stays in the hold route and never fabricates `not_applied`.
- [ ] **Step 2 — Run RED:** `pnpm --filter @led-control/api exec jest src/mqtt/mqtt.service.spec.ts src/commands/command-status.service.spec.ts src/commands/command-late-set-ack.service.spec.ts --runInBand`; expect new assertions to fail.
- [ ] **Step 3 — Implement:** Add narrow ACK/result mapping and preserve the existing protected late-Set and Get-only recovery ownership order.
- [ ] **Step 4 — Run GREEN:** Repeat Step 2, API full Jest/typecheck/build; expect exit 0.
- [ ] **Step 5 — Commit:** Commit Task 7 API files/tests and `docs/menus/control.md`.

### Task 8: Control screen failure explanation

**Files:** Modify `apps/web/src/features/control/CommandHistoryPanel.tsx`, `.test.tsx`, `apps/web/src/api/commands.ts` and `.test.ts` only if needed; update `docs/menus/control.md`.

**Interfaces:** Reuse the existing command-status and verification affordance: show a concise Korean clock-untrusted refusal for exact failed Set; do not offer automatic re-execution or hide an unknown/partial status behind that message. Existing three-month history window stays server-defined.

- [ ] **Step 1 — RED test:** A `GATEWAY_CLOCK_UNTRUSTED` failed command shows the refusal and no automatic retry; unknown/partial still shows status-check; old `COMMAND_EXPIRED` presentation remains.
- [ ] **Step 2 — Run RED:** `pnpm --filter @led-control/web exec vitest run src/features/control/CommandHistoryPanel.test.tsx src/api/commands.test.ts`; expect new assertion to fail.
- [ ] **Step 3 — Implement:** Map only the new terminal reason in existing shared UI components; avoid a new card or mock-only state.
- [ ] **Step 4 — Run GREEN:** Repeat Step 2, run `pnpm --filter @led-control/web typecheck`, `pnpm --filter @led-control/web build`, `pnpm --filter @led-control/web ui:check` and `pnpm --filter @led-control/web exec playwright test e2e/calm-operations-manual-control.spec.ts --project=chromium --workers=1`; expect exit 0.
- [ ] **Step 5 — Commit:** Commit Task 8 Web/test/menu doc files.

## Handoff

Start after [Gateway clock plan](2026-09-26-command-gateway-clock.md) Task 1 establishes the shared wire. Publisher Task 1 must precede Gateway Task 2's DB responder; remaining publisher Tasks 2→7 follow in order and integrate only after Gateway Tasks 3–6. Control-page owner takes Task 8 after Task 7's API result is fixed. Backend owner serializes Tasks 1, 2, 4, 6, 7 on schema/publisher/worker files; broker owner can review Task 3/5 independently after exact topic ACL inventory. The primary agent updates the Final Atlas master checklist from reviewed agent results and runs whole-branch regression only after all owners stop editing. Operational antirollback/clock/HIL evidence is a separate release gate, never inferred from green disposable tests.

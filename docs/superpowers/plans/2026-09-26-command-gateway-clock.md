# Command Gateway Clock Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 중앙 DB Command의 MQTT dimming Set만 DB 기준 시간·발행 세대로 검증하고, 거부·재시작·RF 대기 중에도 기존 로컬 자동화와 Get을 보존한다.

**Architecture:** 공유 wire 계약은 `publishEpoch` 양의 안전 정수와 scope/nonce DB-clock 응답을 정의한다. API는 primary DB와 clock-health gate가 건강할 때만 10초짜리 표본을 제공하고, Gateway는 Linux boot-time 기반 상한을 캐시해 수신·journal·queue·각 하드웨어 write 경계에서 Set을 fail-closed로 판정한다. 운영 cutover 전에는 legacy Set 처리를 유지하되 purge는 OFF다.

**Tech Stack:** TypeScript, Zod, NestJS, Prisma/PostgreSQL, MQTT v5 mTLS, Vitest/Jest, Raspberry Pi Linux.

**Spec:** `docs/superpowers/specs/2026-09-26-command-retention-wire-safety-design.md`

## Global Constraints

- Set 유효기간 10,000ms, 기존 만료 guard 2,000ms, DB 표본 최대 나이 10,000ms, 최대 RTT 1,000ms, 10초 단조 오차 예산 100ms. 경계는 `DB 상한 < expiresAt - 2초`일 때만 통과한다.
- 중앙 DB Command에서 발행한 MQTT dimming Set만 새 시각 정책 대상이다. Gateway 로컬 일정·센서 자동화, Get/status-check, 모니터링 수집, heartbeat는 기존 동작을 유지한다.
- 미확정 RF는 `not_applied`로 단정하지 않는다. Gateway 로컬 journal·telemetry outbox·automation state의 보관/삭제 정책은 변경하지 않는다.
- `COMMAND_RETENTION_PURGE_ENABLED=1` 및 recovery POST는 broker fence·DB clock-health·구 Gateway drain·실장비 HIL 이전에 계속 거부한다. 운영 DB migration/초기화/배포는 이 계획의 실행 대상이 아니다.
- 메뉴 동작을 바꾸는 작업에서 `docs/menus/control.md`를 같은 작업에 갱신한다. schema 변경은 `docs/database-schema.md`를 갱신한다.

## Review Focus

1. 다른 site/gateway의 time 응답이나 Set payload → journal/RF 0 (Task 1, 3, 4).
2. DB failover/시각 step 또는 Pi suspend/재부팅 중 cache 표본 → 새 Set RF 0 (Task 2, 3).
3. journal 수락 후 자동화 prepare와 만료 사이 crash → pendingManualControls 영구 잔류 0 (Task 5).
4. BIO brightness write 뒤 force-on 전에 신뢰 소실 → 두 번째 write 0, 결과는 unknown/partial (Task 6).
5. 24시간 journal prune 뒤 지연 QoS1 DUP → 새 RF 0; legacy Get/local automation은 정상 (Task 4, 6).

## File Map and Ownership

- Shared contract owner: `packages/shared/src/gateway-contracts.ts`, `gateway-contracts.test.ts`, `index.ts`, `command-delivery.ts`.
- API clock owner: new `apps/api/src/mqtt/command-clock-responder.service.ts`, `command-db-clock-health.service.ts` and tests; `mqtt.service.ts`, `mqtt.module.ts`. `CommandDbClockHealth` is an injected gate with default deny until primary-host 100ms sync/step evidence exists; no fake healthy production default.
- Gateway owner: new `apps/gateway/src/commands/{db-clock-proof,linux-boot-clock}.ts` and tests; `index.ts`, command handler/journal, automation runtime, BlueZ/BIO adapters and focused tests. The API owner must finish Task 2 before Gateway end-to-end tests.

### Task 1: Shared epoch and scoped clock wire

**Files:** Modify `packages/shared/src/gateway-contracts.ts`, `gateway-contracts.test.ts`, `index.ts`; add `packages/shared/src/command-clock-contracts.ts` and `.test.ts`.

**Interfaces:** Produce a new strict `gatewayDimmingCommandEpochPublishedV2Schema` with `publishEpoch: number` (`Number.isSafeInteger`, >0), while leaving the current published schema usable by pre-cutover API builds; post-cutover publisher adopts the new schema in the sibling plan. Add the epoch schema to the compatibility union alongside legacy stored-journal shapes. Produce `mqttTopicsV2.commandClockRequest/Response(siteId,gatewayId)` and strict `commandClockRequestSchema` `{siteId,gatewayId,nonce}` / `commandClockResponseSchema` `{siteId,gatewayId,nonce,publishEpoch,dbNow}`; nonce is UUID, `dbNow` UTC ISO. Produce separate `commandDrainRequest/Response` topics and strict nonce/scope/epoch/version/bootId/queued/submitted/unconfirmed-count schemas for API↔Gateway drain evidence.

- [ ] **Step 1 — RED test:** Parse valid epoch Set and matching time/drain round-trips; reject absent/negative/unsafe epoch, mismatched scope and malformed nonce/count. Assert the old producer schema and compatibility parser still read pre-cutover Set.
- [ ] **Step 2 — Run RED:** `pnpm --filter @led-control/shared exec vitest run src/gateway-contracts.test.ts src/command-clock-contracts.test.ts`; expect new contract tests to fail.
- [ ] **Step 3 — Implement:** Add schemas/topics/export without weakening the strict post-cutover schema or existing 10s expiry validation.
- [ ] **Step 4 — Run GREEN:** Repeat Step 2 and `pnpm --filter @led-control/shared build`; expect exit 0.
- [ ] **Step 5 — Commit:** Commit only Task 1 contract/test files.

### Task 2: Primary-DB clock responder and health gate

**Files:** Create `apps/api/src/mqtt/command-clock-responder.service.ts` and `.spec.ts`, `command-db-clock-health.service.ts` and `.spec.ts`, `command-clock-responder.integration.spec.ts`; modify `apps/api/src/mqtt/mqtt.service.ts`, `mqtt.module.ts`.

**Interfaces:** `CommandClockResponderService.respond(topicScope, request): Promise<CommandClockResponse | null>` consumes Task 1. It reads `clock_timestamp()` plus the active epoch from the same primary Prisma transaction after `CommandDbClockHealth.assertHealthy(tx)`; null means no response. The clock-health production provider denies absent, stale, >100ms-offset, step, or primary-switch evidence. The broker topic ACL, not untrusted payload text, binds request scope. This task consumes the additive epoch table from publisher plan Task 1; work on the responder starts after that migration is available.

- [ ] **Step 1 — RED test:** Wrong topic/payload scope, DB outage, missing/stale clock evidence, quiescing epoch yield no response; healthy primary returns its DB UTC time/epoch and original nonce; time response is non-retained.
- [ ] **Step 2 — Run RED:** `pnpm --filter @led-control/api exec jest src/mqtt/command-clock-responder.service.spec.ts --runInBand`; expect failures for missing service/routing.
- [ ] **Step 3 — Implement:** Add focused responder and MQTT subscription/routing; keep Get, ACK, telemetry handlers unchanged. Keep production health gate deny-by-default until central DB host attestation is deployed.
- [ ] **Step 4 — Run GREEN:** Repeat Step 2, run `COMMAND_RETENTION_TEST=1 pnpm --filter @led-control/api exec jest src/mqtt/command-clock-responder.integration.spec.ts --runInBand`, then API typecheck; expect exit 0.
- [ ] **Step 5 — Commit:** Commit Task 2 API files; do not enable purge.

### Task 3: Gateway suspend-inclusive clock proof

**Files:** Create `apps/gateway/src/commands/linux-boot-clock.ts`, `linux-boot-clock.test.ts`, `db-clock-proof.ts`, `db-clock-proof.test.ts`; modify `apps/gateway/src/index.ts`, `index.test.ts`.

**Interfaces:** `LinuxBootClock.sample(): {bootId:string, milliseconds:number}` uses Linux boot identity plus suspend-inclusive boot elapsed time; `DbClockProof.observe(request, response, start, end)` and `allows(publishEpoch, expiresAt, now)` provide synchronous cached permit. Reject RTT >1,000ms, sample age >10,000ms, uncertainty ≥2,000ms, boot/monotonic discontinuity; invalidation on MQTT reconnect and epoch mismatch. Proof never uses `SystemClockTrustProvider` as DB-offset evidence.

- [ ] **Step 1 — RED test:** Probe nonce/scope/reorder and cutoff boundaries; test 1,000/1,001ms RTT, 10,000/10,001ms age, 100ms error budget, boot change and monotonic regression; all invalid cases deny Set.
- [ ] **Step 2 — Run RED:** `pnpm --filter @led-control/gateway exec vitest run src/commands/linux-boot-clock.test.ts src/commands/db-clock-proof.test.ts --maxWorkers=1 --minWorkers=1`; expect missing implementation.
- [ ] **Step 3 — Implement:** Use Linux `/proc` boot-time/boot-ID adapter with injectable reads; add nonce-correlated MQTT request/response and reconnect invalidation in `index.ts`. If target Pi cannot prove suspend-inclusive semantics, runtime fails closed after cutover.
- [ ] **Step 4 — Run GREEN:** Repeat Step 2, then `index.test.ts` and Gateway typecheck; expect exit 0.
- [ ] **Step 5 — Commit:** Commit Gateway proof files/tests only.

### Task 4: Set intake, journal, and epoch cutover

**Files:** Modify `apps/gateway/src/index.ts`, `index.test.ts`, `commands/gateway-command-handler.ts`, `gateway-command-handler.test.ts`, `commands/command-journal.ts`, `command-journal.test.ts`.

**Interfaces:** Gateway-local `GATEWAY_COMMAND_EPOCH_CUTOVER=1` is the per-Gateway (therefore per-site installation) cutover switch. After cutover, scope mismatch, missing/wrong epoch, invalid proof or expired Set yields durable terminal ACK with existing `COMMAND_EXPIRED` or new `GATEWAY_CLOCK_UNTRUSTED`; before cutover existing legacy behavior remains while purge stays OFF. Check at receive, before journal accept, after fsync/accepted ACK, and dequeue. Do not turn refusal into fixture-state success.

- [ ] **Step 1 — RED test:** Cover cross-site payload, missing epoch before/after cutover, untrusted clock, fsync delay, queue delay, DUP after 24h journal prune. Assert refusal ACK replays with RF 0 and Get handler unaffected.
- [ ] **Step 2 — Run RED:** `pnpm --filter @led-control/gateway exec vitest run src/index.test.ts src/commands/gateway-command-handler.test.ts src/commands/command-journal.test.ts --maxWorkers=1 --minWorkers=1`; expect new assertions to fail.
- [ ] **Step 3 — Implement:** Pass Task 3 permit through handler with a typed refusal reason; preserve existing accepted-restart indeterminate behavior where RF might have begun.
- [ ] **Step 4 — Run GREEN:** Repeat Step 2 and Gateway typecheck; expect exit 0.
- [ ] **Step 5 — Commit:** Commit Task 4 Gateway files/tests and the corresponding `docs/menus/control.md` update.

### Task 5: Durable manual-prepare abort before RF

**Files:** Modify `apps/gateway/src/automation/schedule-runtime.ts`, `schedule-runtime.test.ts`, `apps/gateway/src/index.ts`, `commands/gateway-command-handler.ts`, `commands/command-journal.ts` and their tests.

**Interfaces:** Add idempotent `abortManualControl(sourceId, fixtureIds)` to the runtime/coordinator. A pre-RF terminal refusal persists abort intent and clears only matching `pendingManualControls`/pending transitions; journal recovery replays the intent after a crash. Once any hardware write may have started, do not abort as definitely not-applied.

- [ ] **Step 1 — RED test:** Crash after prepare, after journal terminal commit, and during abort; replay must clear matching pending state exactly once, leave another command untouched, and resume local schedule. Post-write uncertainty remains unknown/partial.
- [ ] **Step 2 — Run RED:** `pnpm --filter @led-control/gateway exec vitest run src/automation/schedule-runtime.test.ts src/commands/gateway-command-handler.test.ts src/commands/command-journal.test.ts --maxWorkers=1 --minWorkers=1`; expect new assertions to fail.
- [ ] **Step 3 — Implement:** Add narrow durable abort state/replay and coordinator hook; avoid success handoff or fabricated fixture observation on refusal.
- [ ] **Step 4 — Run GREEN:** Repeat Step 2 and Gateway typecheck; expect exit 0.
- [ ] **Step 5 — Commit:** Commit Task 5 files/tests and revise `docs/menus/control.md` for refusal/recovery behavior.

### Task 6: Physical write veto, drain proof, and regression gate

**Files:** Modify `apps/gateway/src/gateway.ts`, `mesh/bluez-mesh-adapter.ts`, `adapters/bio-usb-dongle-adapter.ts`, `bio/bio-dongle-client.ts`, `bio/bio-usb-transport.ts` and focused tests; add `apps/gateway/src/commands/command-rf-drain.ts` and test.

**Interfaces:** A synchronous cached `mayStartWrite()` permit is checked immediately before every BlueZ `Send` and BIO native write, including BIO brightness→force-on phases. `CommandRfDrain.snapshot()` reports queued/submitted/confirmed-or-cancelled Set work; it must not claim physical RF completion from a D-Bus/USB submission callback. Gateway replies to a scoped nonce/epoch `commandDrainRequest` with this snapshot, boot ID and software version using Task 1 response schema. HIL must provide a measured submit→RF upper bound before production purge.

- [ ] **Step 1 — RED test:** Expire proof between two BIO writes and while BlueZ/BIO queued; assert no later write, preserve partial/unknown after first write. Show a submitted-but-unconfirmed operation prevents certified drain; wrong-scope/nonce drain request yields no usable response.
- [ ] **Step 2 — Run RED:** `pnpm --filter @led-control/gateway exec vitest run src/mesh/bluez-mesh-adapter.test.ts src/adapters/bio-usb-dongle-adapter.test.ts src/bio/bio-usb-transport.test.ts src/commands/command-rf-drain.test.ts --maxWorkers=1 --minWorkers=1`; expect new assertions to fail.
- [ ] **Step 3 — Implement:** Thread the cached veto through the adapter boundary, distinguish pre-write from submitted state, and expose conservative drain evidence. Keep physical-completion certification false until Pi/BlueZ/BIO HIL.
- [ ] **Step 4 — Run GREEN:** Repeat Step 2, then Gateway full test/typecheck/build and Get/local automation regression tests; expect exit 0.
- [ ] **Step 5 — Commit:** Commit Task 6 files/tests and `docs/menus/control.md`; report unresolved HIL gate without enabling purge.

## Handoff

Execute Task 1 first, publisher plan Task 1 next, then this plan Task 2; Gateway Tasks 3→6 can follow the shared contract. Do not let API and Gateway owners edit shared wire files simultaneously. The sibling [publisher fence plan](2026-09-26-command-publisher-fence.md) only integrates after Gateway Tasks 3–6. The primary agent updates the Final Atlas master checklist after each reviewed agent result. Production purge remains OFF until both plans and external broker/DB/Gateway evidence pass.

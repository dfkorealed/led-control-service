# BIO Periodic Presence Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 등록된 BIO 센서통신모듈을 Gateway가 10분마다 read-only 조회하고, 실제 출력 상태를 추측하지 않은 채 서비스의 생존 상태를 갱신하며 마지막 성공 후 20분 초과 시 offline으로 판정한다.

**Architecture:** `fixture-presence`를 기존 `fixture-state`와 분리된 ordered MQTT event로 추가한다. BIO adapter는 UUID/address를 재검증한 뒤 brightness 설정 GET과 control-mode GET을 직렬 실행하고, Gateway durable state outbox를 통해 API에 전달한다. API는 liveness와 BIO metadata만 저장하고 energy/output checkpoint를 보존하며, Web은 10분 refresh policy를 사용한다.

**Tech Stack:** TypeScript, Zod, Vitest, NestJS, Prisma/PostgreSQL, MQTT QoS 1, React Query

**Spec:** `docs/superpowers/specs/2026-09-14-bio-periodic-presence-polling-design.md`

## Global Constraints

- Gateway 장치 resync와 Web monitoring refresh 기본 간격은 정확히 `600_000ms`다.
- Fixture operational freshness와 Site 기본 stale 기준은 정확히 `1_200초`이며 경계는 fresh, 1ms 초과부터 stale이다.
- API freshness sweep은 내부 판정 worker이므로 `30_000ms`를 유지한다.
- Energy `KNOWN_STATE_WINDOW_MS=180_000`은 실제 output state의 신뢰 구간이므로 변경하지 않는다.
- Sensor mode에서 설정 밝기를 실제 밝기 또는 power state로 기록하지 않는다.
- BIO polling은 address, brightness, mode를 변경하는 write frame을 전송하지 않는다.
- MQTT event는 application ACK 전까지 owner-only durable outbox에 남아야 한다.
- 예외적 프로토콜·freshness 로직에는 확인된 사실과 값의 의미를 한국어 주석으로 남긴다.
- DB 구조 변경과 설정·제어·모니터링 동작 변경은 같은 작업에서 관련 문서를 갱신한다.

---

## File Structure

- `packages/shared/src/gateway-contracts.ts`: presence wire schema, topic과 public type
- `packages/shared/src/freshness.ts`: 10분 poll 및 20분 operational freshness 단일 상수
- `apps/gateway/src/runtime/background-mesh-resync.ts`: 겹치지 않는 완료 후 10분 정규 timer
- `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts`: confirmed BIO read-only poll과 presence 관측
- `apps/gateway/src/gateway.ts`: adapter 내부 presence 관측 interface
- `apps/gateway/src/state/state-event-outbox.ts`: fixture-state/presence durable union
- `apps/gateway/src/index.ts`: presence listener, event sequence, outbox enqueue
- `apps/api/src/fixtures/fixture-presence-ingestion.service.ts`: liveness 전용 원자적 ingestion
- `apps/api/src/mqtt/mqtt.service.ts`: presence subscription, durable PUBACK, application ACK
- `apps/api/prisma/schema.prisma`: BIO metadata와 presence checkpoint
- `apps/web/src/api/queries.ts`: 10분 monitoring refresh와 nullable BIO metadata
- `docs/database-schema.md`, `docs/menus/*.md`: 운영 의미와 한계

---

### Task 1: Shared presence 계약과 freshness 상수

**Files:**
- Modify: `packages/shared/src/gateway-contracts.ts`
- Modify: `packages/shared/src/gateway-contracts.test.ts`
- Modify: `packages/shared/src/freshness.ts`
- Modify: `packages/shared/src/freshness.test.ts`

**Interfaces:**
- Produces: `FIXTURE_PRESENCE_POLL_INTERVAL_MS = 600_000`
- Produces: `FIXTURE_OPERATIONAL_FRESHNESS_MS = 1_200_000`
- Produces: `fixtureOperationalFreshSince(now: Date): Date`
- Produces: `fixturePresenceV2Schema`, `FixturePresenceV2`
- Produces: `mqttTopicsV2.fixturePresence(siteId, gatewayId)`

- [ ] **Step 1: Write failing contract and boundary tests**

Add literal assertions proving the topic, strict absence of output fields, and exact freshness boundary:

```ts
expect(mqttTopicsV2.fixturePresence(siteId, gatewayId)).toBe(
  `sites/${siteId}/gateways/${gatewayId}/state/fixture-presence`
);
const presence = {
  eventId, siteId, gatewayId, fixtureId, sequence: 11, occurredAt,
  controlMode: "sensor", rawHighBrightness: 127,
  configuredBrightness: null, rssi: -41, hopCount: null
};
expect(fixturePresenceV2Schema.parse(presence)).toEqual(presence);
expect(() => fixturePresenceV2Schema.parse({ ...presence, brightness: 38, powerOn: true })).toThrow();

const now = new Date("2026-09-14T00:20:00.000Z");
expect(fixtureOperationalFreshSince(now)).toEqual(new Date("2026-09-14T00:00:00.000Z"));
expect(FIXTURE_PRESENCE_POLL_INTERVAL_MS).toBe(600_000);
expect(FIXTURE_OPERATIONAL_FRESHNESS_MS).toBe(1_200_000);
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @led-control/shared test -- gateway-contracts.test.ts freshness.test.ts
```

Expected: FAIL because the presence schema/topic and fixture constants are not exported.

- [ ] **Step 3: Add the minimal shared implementation**

Implement the constants and strict schema:

```ts
export const FIXTURE_PRESENCE_POLL_INTERVAL_MS = 10 * 60 * 1_000;
export const FIXTURE_OPERATIONAL_FRESHNESS_MS = 20 * 60 * 1_000;
export function fixtureOperationalFreshSince(now: Date) {
  return new Date(now.getTime() - FIXTURE_OPERATIONAL_FRESHNESS_MS);
}

export const fixturePresenceV2Schema = orderedGatewayEventSchema.extend({
  fixtureId: z.string().uuid(),
  controlMode: z.enum(["sensor", "force-off", "force-on"]),
  rawHighBrightness: z.number().int().min(0).max(0xff),
  configuredBrightness: z.number().int().min(0).max(100).nullable(),
  rssi: z.number().max(0).nullable(),
  hopCount: z.number().int().nonnegative().nullable()
}).strict();
```

Add the exact topic builder and exported inferred type.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command, then:

```bash
pnpm --filter @led-control/shared typecheck
pnpm --filter @led-control/shared build
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/gateway-contracts.ts packages/shared/src/gateway-contracts.test.ts packages/shared/src/freshness.ts packages/shared/src/freshness.test.ts
git commit -m "feat(shared): define fixture presence contract"
```

---

### Task 2: Gateway full-resync 10분 scheduler

**Files:**
- Modify: `apps/gateway/src/runtime/background-mesh-resync.ts`
- Modify: `apps/gateway/src/runtime/background-mesh-resync.test.ts`

**Interfaces:**
- Consumes: `FIXTURE_PRESENCE_POLL_INTERVAL_MS`
- Produces: `BackgroundMeshResyncOptions.pollIntervalMs?: number`
- Preserves: immediate `schedule()`, exponential retry, rerun coalescing, bounded shutdown

- [ ] **Step 1: Write failing fake-timer tests**

Add tests that observe real worker calls rather than timer internals:

```ts
it("runs again ten minutes after a successful pass without overlap", async () => {
  vi.useFakeTimers();
  try {
    const first = deferred<typeof completeReport>();
    const run = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(completeReport);
    const worker = new BackgroundMeshResyncWorker({ run, onReport: vi.fn(), pollIntervalMs: 600_000 });
    worker.schedule();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(1);
    first.resolve(completeReport);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await worker.stopAndDrain();
  } finally { vi.useRealTimers(); }
});
```

Add a second test that stops after a successful pass, advances 600,000ms, and asserts no new call. Add a validation test rejecting `pollIntervalMs` values `0`, `-1`, `1.5`, and `Number.MAX_SAFE_INTEGER + 1`.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @led-control/gateway test -- src/runtime/background-mesh-resync.test.ts
```

Expected: FAIL because a successful pass currently arms no regular timer.

- [ ] **Step 3: Implement one non-overlapping regular timer**

Import the shared default, validate the constructor option, and add `pollTimer`. After a drain settles without a pending immediate rerun, call `armPoll()`; `armPoll()` calls `schedule()` once after the interval and uses `unref()`. `schedule()` clears an armed poll timer before starting immediate work so reconnect and manual resync reset the next regular deadline. `stopAndDrain()` clears retry and poll timers before aborting.

Keep retry behavior authoritative for incomplete/error passes: a retry is armed immediately by existing backoff, while the regular poll is armed only after the next complete pass. Add a detailed comment explaining that fixed-delay scheduling prevents USB requests from overlapping when a pass itself is slow.

- [ ] **Step 4: Verify GREEN and regression behavior**

```bash
pnpm --filter @led-control/gateway test -- src/runtime/background-mesh-resync.test.ts src/automation/schedule-runtime.test.ts
```

Expected: existing retry/coalescing/shutdown tests and new 10-minute tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/runtime/background-mesh-resync.ts apps/gateway/src/runtime/background-mesh-resync.test.ts
git commit -m "feat(gateway): schedule ten minute fixture resync"
```

---

### Task 3: BIO read-only presence 관측

**Files:**
- Modify: `apps/gateway/src/gateway.ts`
- Modify: `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts`
- Modify: `apps/gateway/src/adapters/bio-usb-dongle-adapter.test.ts`

**Interfaces:**
- Produces: `BleMeshFixturePresence`
- Produces: optional `BleMeshAdapter.onFixturePresence(listener): unsubscribe`
- Consumes: `BioDongleClient.readBrightness(target, control)` and `readDeviceInfo(target, control)`
- Produces: truthful `BleMeshResyncReport`

- [ ] **Step 1: Write failing BIO resync tests**

Extend the client fake with complete response shapes and add a success test:

```ts
f.mappings.listConfirmed.mockResolvedValue([confirmedMapping()]);
f.client.scan.mockResolvedValue([{ ...discovered, logicalAddress: 0x0101 }]);
f.client.readBrightness.mockResolvedValue({
  kind: "high-brightness-report", nativeUuid: discovered.nativeUuid,
  networkId: discovered.networkId, logicalAddress: 0x0101,
  rawHighBrightness: 127, brightnessPercent: null
});
f.client.readDeviceInfo.mockResolvedValue({
  kind: "control-mode-report", nativeUuid: discovered.nativeUuid,
  networkId: discovered.networkId, logicalAddress: 0x0101, mode: "sensor"
});
const received: BleMeshFixturePresence[] = [];
f.adapter.onFixturePresence((value) => received.push(value));

await expect(f.adapter.resyncFixtureStates()).resolves.toEqual({
  total: 1, configured: 1, observed: 1, healthPending: 0, timedOut: 0, failed: 0
});
expect(received).toEqual([{
  fixtureId: provisioningCommand.nodeId, controlMode: "sensor",
  rawHighBrightness: 127, configuredBrightness: null,
  rssi: -41, hopCount: null, observedAt: "2026-09-13T00:00:02.000Z"
}]);
```

Add independent tests for wrong UUID/address, brightness-only partial response, `BioUsbError("TIMEOUT")`, continuing to a second mapping after the first fails, AbortSignal stopping before the next fixture, and a throwing listener not failing the observation pass. Assert `setOutput`, `assignAddressOnce`, `restoreSensorMode`, and `startIdentify` are never called by resync.

Add targeted resync tests for all three modes: `sensor` emits presence but no lighting observation, `force-off` emits `{brightness: 0, powerOn: false}`, and `force-on` with a table-backed percent emits `{brightness: configuredBrightness, powerOn: true}`. A `force-on` response whose raw brightness has no table-backed percent must emit presence only. Assert `resyncLightingFixtures([fixtureId])` never queries an unrequested confirmed mapping.

- [ ] **Step 2: Run the adapter test and verify RED**

```bash
pnpm --filter @led-control/gateway test -- src/adapters/bio-usb-dongle-adapter.test.ts
```

Expected: FAIL because BIO resync returns `unobservedResync` and exposes no presence listener.

- [ ] **Step 3: Implement the minimal serial poll**

Add this adapter-side shape:

```ts
export interface BleMeshFixturePresence {
  fixtureId: string;
  controlMode: "sensor" | "force-off" | "force-on";
  rawHighBrightness: number;
  configuredBrightness: number | null;
  rssi: number | null;
  hopCount: number | null;
  observedAt: string;
}
```

Add `readBrightness` and `readDeviceInfo` to `BioClientPort`, a listener `Set`, and a serial `for...of` loop. Run one `refreshDiscovery({ signal })`, require exact device UUID/native UUID/logical address, construct `BioVerifiedLampTarget`, then call the two GET methods with `{ signal }`. Count a `BioUsbError` code `TIMEOUT` as `timedOut`; count other per-device failures as `failed`. Emit only after both GETs complete and wrap each listener call so a consumer cannot invalidate adapter observation.

Factor the confirmed mapping loop so full and targeted resync share identity checks and GET ordering. Targeted resync also emits `BleMeshLightingObservation` only for exact `force-off` and table-backed `force-on`; sensor and unmapped raw brightness never become output observations. Reuse the codec-provided `brightnessPercent` rather than recalculating raw bytes. Add comments that sensor mode reports configured high brightness, not instantaneous LED output, and that the serial loop exists because the dongle has one global response correlation slot.

- [ ] **Step 4: Verify GREEN**

```bash
pnpm --filter @led-control/gateway test -- src/adapters/bio-usb-dongle-adapter.test.ts src/bio/bio-dongle-client.test.ts
pnpm --filter @led-control/gateway typecheck
```

Expected: tests and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/gateway.ts apps/gateway/src/adapters/bio-usb-dongle-adapter.ts apps/gateway/src/adapters/bio-usb-dongle-adapter.test.ts
git commit -m "feat(gateway): observe BIO fixture presence"
```

---

### Task 4: Gateway durable presence outbox와 runtime 연결

**Files:**
- Modify: `apps/gateway/src/state/state-event-outbox.ts`
- Modify: `apps/gateway/src/state/state-event-outbox.test.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/index.test.ts`

**Interfaces:**
- Consumes: `FixturePresenceV2`, `BleMeshFixturePresence`
- Produces: `GatewayStateEvent = FixtureStateV2 | FixturePresenceV2`
- Produces: `createFixturePresencePublisher(...)`
- Preserves: existing state outbox JSON version 1 and application ACK deletion contract

- [ ] **Step 1: Write failing outbox compatibility tests**

Create one fixture-state and one fixture-presence event, enqueue both, recreate `StateEventOutbox` from the same temporary file, and assert the restored records retain their distinct topics in FIFO order. ACK the first event and assert only the second remains. Add a corrupt-record test whose presence payload is stored under the fixture-state topic and must fail initialization.

Add an index publisher test with a literal presence input and assert the emitted payload has a generated UUID/sequence, `occurredAt=observedAt`, no `brightness`, no `powerOn`, and topic `mqttTopicsV2.fixturePresence(...)`.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @led-control/gateway test -- src/state/state-event-outbox.test.ts src/index.test.ts
```

Expected: FAIL because the outbox parser only accepts `FixtureStateV2` and the Gateway has no presence publisher.

- [ ] **Step 3: Generalize the outbox without weakening validation**

Define:

```ts
export type GatewayStateEvent = FixtureStateV2 | FixturePresenceV2;
```

Parse each stored record by exact topic: fixture-state topic uses `fixtureStateV2Schema`; fixture-presence topic uses `fixturePresenceV2Schema`; every other topic fails closed. Update publisher callback and clone/equality helpers for the union. Preserve payload byte recomputation, scope checks, duplicate event-id rejection, file mode and capacity reservation behavior.

In `index.ts`, install a presence intake only when `adapter.onFixturePresence` exists. It must reserve one outbox slot before attaching, unsubscribe after consuming that slot, enqueue via the durable outbox, re-arm after success, and use the same capacity recovery full-resync fence as fixture status intake. Build the wire event as:

```ts
fixturePresenceV2Schema.parse({
  siteId, gatewayId, eventId: randomUUID(), sequence: await eventSequence.next(),
  occurredAt: presence.observedAt, fixtureId: presence.fixtureId,
  controlMode: presence.controlMode,
  rawHighBrightness: presence.rawHighBrightness,
  configuredBrightness: presence.configuredBrightness,
  rssi: presence.rssi, hopCount: presence.hopCount
});
```

Add comments explaining why presence shares durability with state but never acquires state/energy semantics.

- [ ] **Step 4: Verify GREEN and restart behavior**

```bash
pnpm --filter @led-control/gateway test -- src/state/state-event-outbox.test.ts src/index.test.ts src/runtime/background-mesh-resync.test.ts
pnpm --filter @led-control/gateway build
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/state/state-event-outbox.ts apps/gateway/src/state/state-event-outbox.test.ts apps/gateway/src/index.ts apps/gateway/src/index.test.ts
git commit -m "feat(gateway): persist BIO presence events"
```

---

### Task 5: Presence DB schema와 energy-safe API ingestion

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260918120000_bio_fixture_presence_polling/migration.sql`
- Create: `apps/api/src/fixtures/fixture-presence-ingestion.service.ts`
- Create: `apps/api/src/fixtures/fixture-presence-ingestion.service.spec.ts`
- Create: `apps/api/src/fixtures/fixture-presence-ingestion.integration.spec.ts`
- Modify: `apps/api/src/monitoring-incidents/monitoring-schema.integration.spec.ts`

**Interfaces:**
- Produces: `FixturePresenceIngestionService.ingest(gatewayId, input, receivedAt)`
- Produces Fixture columns: `bioControlMode`, `bioConfiguredBrightness`, `bioRawHighBrightness`, `lastPresenceEventId`, `lastPresenceSequence`, `lastPresenceOccurredAt`
- Preserves: output state and every energy checkpoint/aggregate

- [ ] **Step 1: Write failing ingestion behavior tests**

Seed a claimed Gateway, MeshNode, Fixture, and EnergyFixtureIdentity. Ingest a sensor presence at a fixed API receive time and assert:

```ts
expect(saved).toMatchObject({
  lastSeenAt: receivedAt,
  rssi: -41,
  hopCount: null,
  bioControlMode: "sensor",
  bioConfiguredBrightness: null,
  bioRawHighBrightness: 127,
  brightness: 38,
  powerOn: null,
  lastStateEventId: previousStateEventId,
  lastPresenceEventId: presence.eventId,
  lastPresenceSequence: BigInt(presence.sequence),
  lastPresenceOccurredAt: new Date(presence.occurredAt)
});
expect(await prisma.fixtureEnergyDailyAggregate.count()).toBe(0);
expect(await prisma.fixtureEnergyHourlyAggregate.count()).toBe(0);
```

Add tests for exact duplicate ACK, altered replay rejection, wrong gateway/site/fixture scope, stale sequence, reverse time, future timestamp, and restoration only from persisted `fixture_stale`/`gateway_offline`. Assert `command_failed`, fault and `provisioning_waiting_state` survive a successful presence.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @led-control/api exec jest src/fixtures/fixture-presence-ingestion.service.spec.ts src/fixtures/fixture-presence-ingestion.integration.spec.ts --runInBand
```

Expected: FAIL because the Prisma fields and ingestion service do not exist.

- [ ] **Step 3: Add migration and regenerate Prisma**

The migration must:

```sql
ALTER TABLE "Site" ALTER COLUMN "fixtureStaleAfterSeconds" SET DEFAULT 1200;
UPDATE "Site" SET "fixtureStaleAfterSeconds" = 1200 WHERE "fixtureStaleAfterSeconds" = 180;
ALTER TABLE "Fixture"
  ADD COLUMN "bioControlMode" TEXT,
  ADD COLUMN "bioConfiguredBrightness" INTEGER,
  ADD COLUMN "bioRawHighBrightness" INTEGER,
  ADD COLUMN "lastPresenceEventId" TEXT,
  ADD COLUMN "lastPresenceSequence" BIGINT,
  ADD COLUMN "lastPresenceOccurredAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Fixture_lastPresenceEventId_key" ON "Fixture"("lastPresenceEventId");
```

Add named CHECK constraints for the three BIO value ranges and an all-null-or-all-present checkpoint constraint. Change Prisma Site default to `1200`, add the six nullable Fixture fields, and run:

```bash
pnpm --filter @led-control/api prisma:generate
```

- [ ] **Step 4: Implement presence-only transaction semantics**

Use `fixturePresenceV2Schema`, `canonicalPayloadHash`, `gatewayEventIsTooFarInFuture`, and `compareAndAdvanceGatewayEvent` with `eventType: "fixture_presence"` and `scopeKey: fixtureId`. Lock the Site, Gateway, and Fixture in that order and verify the Fixture belongs to both wire scopes. Persist a `ProcessedGatewayEvent` row for accepted/rejected ordering outcomes.

For accepted events, update only the six presence fields, `lastSeenAt`, `rssi`, `hopCount`, plus conditional restoration of freshness-produced offline state. Do not import or call energy aggregation helpers. Return the same `{eventId, sequence, fixtureId, status}` shape used by `applicationStateIngestedAckV2Schema`.

- [ ] **Step 5: Verify GREEN and schema contract**

```bash
pnpm --filter @led-control/api exec jest src/fixtures/fixture-presence-ingestion.service.spec.ts src/fixtures/fixture-presence-ingestion.integration.spec.ts src/monitoring-incidents/monitoring-schema.integration.spec.ts --runInBand
pnpm --filter @led-control/api typecheck
```

Expected: all commands exit 0 and existing state fields remain unchanged in the integration assertion.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260918120000_bio_fixture_presence_polling apps/api/src/fixtures/fixture-presence-ingestion.service.ts apps/api/src/fixtures/fixture-presence-ingestion.service.spec.ts apps/api/src/fixtures/fixture-presence-ingestion.integration.spec.ts apps/api/src/monitoring-incidents/monitoring-schema.integration.spec.ts
git commit -m "feat(api): ingest BIO fixture presence"
```

---

### Task 6: MQTT durable presence delivery와 application ACK

**Files:**
- Modify: `apps/api/src/mqtt/mqtt.module.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.spec.ts`
- Modify: `apps/api/src/mqtt/mqtt-v2-state.spec.ts`
- Modify: `apps/api/src/mqtt/topic-scope.spec.ts`

**Interfaces:**
- Consumes: `FixturePresenceIngestionService.ingest`
- Produces: QoS 1 DB-commit-before-PUBACK handling for both fixture state topics
- Produces: existing `state-ingested` application ACK for presence

- [ ] **Step 1: Write failing MQTT boundary tests**

Add tests proving:

1. connect subscribes to `sites/+/gateways/+/state/fixture-presence` at QoS 1;
2. custom ACK reserves the gateway queue, commits presence ingestion, then calls MQTT `done(0)`;
3. DB failure closes the stream without broker PUBACK;
4. exact application ACK contains presence event id/sequence/fixture id;
5. wrong topic scope and forged suffix are rejected;
6. the normal message listener does not execute presence ingestion a second time after custom ACK.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @led-control/api exec jest src/mqtt/mqtt.service.spec.ts src/mqtt/mqtt-v2-state.spec.ts src/mqtt/topic-scope.spec.ts --runInBand
```

Expected: FAIL because presence is neither subscribed nor handled by the durable path.

- [ ] **Step 3: Add one shared durable observation dispatcher**

Register `FixturePresenceIngestionService` in `mqtt.module.ts` and inject a narrow `Pick<..., "ingest">` into `MqttService`. Replace fixture-state-only suffix checks with an exact predicate:

```ts
function isDurableFixtureObservationTopic(topic: string) {
  return topic.endsWith("/state/fixtures") || topic.endsWith("/state/fixture-presence");
}
```

The custom ACK path must dispatch state topics to `FixtureStateIngestionService` and presence topics to `FixturePresenceIngestionService`, validate exact `parseGatewayTopic(...).channel`, publish the existing `applicationStateIngestedAckV2Schema`, and only then return broker success. Preserve per-Gateway inbound serialization and stream-close-on-transaction-failure behavior.

Add detailed comments differentiating MQTT PUBACK from the application ACK and explaining why both event types share the same durable queue.

- [ ] **Step 4: Verify GREEN**

```bash
pnpm --filter @led-control/shared build
pnpm --filter @led-control/api exec jest src/mqtt/mqtt.service.spec.ts src/mqtt/mqtt-v2-state.spec.ts src/mqtt/topic-scope.spec.ts --runInBand
pnpm --filter @led-control/api build
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mqtt/mqtt.module.ts apps/api/src/mqtt/mqtt.service.ts apps/api/src/mqtt/mqtt.service.spec.ts apps/api/src/mqtt/mqtt-v2-state.spec.ts apps/api/src/mqtt/topic-scope.spec.ts
git commit -m "feat(api): receive durable fixture presence"
```

---

### Task 7: 20분 freshness와 Web 10분 refresh

**Files:**
- Modify: `apps/api/src/fixtures/fixture-freshness.service.ts`
- Modify: `apps/api/src/fixtures/fixture-freshness.service.spec.ts`
- Modify: `apps/api/src/fixture-identify/fixture-identify.service.ts`
- Modify: `apps/api/src/fixture-identify/fixture-identify.service.spec.ts`
- Modify: `apps/api/src/monitoring-incidents/monitoring-conditions.ts`
- Modify: `apps/api/src/monitoring-incidents/monitoring-conditions.spec.ts`
- Modify: `apps/api/src/sites/sites.service.ts`
- Modify: `apps/api/src/sites/sites.service.spec.ts`
- Modify: `apps/api/src/fixtures/fixtures.service.ts`
- Modify: `apps/api/src/fixtures/fixtures.service.spec.ts`
- Modify: `apps/web/src/api/queries.ts`
- Modify: `apps/web/src/api/queries.test.tsx`
- Modify: `apps/web/src/test/fixtures.ts`

**Interfaces:**
- Consumes: `FIXTURE_OPERATIONAL_FRESHNESS_MS`, `fixtureOperationalFreshSince`
- Produces: default monitoring policy `{ gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 1200 }`
- Produces API metadata: `bioControlMode`, `bioConfiguredBrightness`, `bioRawHighBrightness`
- Produces Web `MONITORING_REFRESH_INTERVAL_MS = 600_000`

- [ ] **Step 1: Write failing 20-minute boundary tests**

Change operational tests to use literal cases:

```ts
it.each([
  [1_200_000, false],
  [1_200_001, true]
] as const)("marks fixture age %d stale=%s", (age, stale) => {
  // Assert the service or policy result, not the constant itself.
});
```

Add identify assertions that lastSeen exactly 1,200,000ms old is accepted and 1,200,001ms old throws `fixture_offline`. Update default Site policy expectations from 180 to 1200. Add API response assertions for nullable BIO metadata without changing brightness.

Change Web query tests to assert `refetchInterval` and `staleTime` are `600_000` while `refetchOnWindowFocus=true` and `retry=2` remain.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @led-control/api exec jest src/fixtures/fixture-freshness.service.spec.ts src/fixture-identify/fixture-identify.service.spec.ts src/monitoring-incidents/monitoring-conditions.spec.ts src/sites/sites.service.spec.ts src/fixtures/fixtures.service.spec.ts --runInBand
pnpm --filter @led-control/web test -- src/api/queries.test.tsx
```

Expected: FAIL on the current 180-second and 30-second behavior.

- [ ] **Step 3: Replace duplicated operational literals and update DTO projections**

Use `fixtureOperationalFreshSince(now)` in identify and `FIXTURE_OPERATIONAL_FRESHNESS_MS` in the persisted freshness sweep. Change only `DEFAULT_MONITORING_POLICY.fixtureStaleAfterSeconds` to `1200`; keep `gatewayOfflineAfterSeconds=90` and `FIXTURE_FRESHNESS_POLL_MS` default 30,000.

Project the three nullable BIO metadata fields from both dashboard and paginated floor fixtures. In Web, set:

```ts
export const MONITORING_REFRESH_INTERVAL_MS = 10 * 60 * 1_000;
```

Do not modify query invalidation or focus refetch behavior. Add comments distinguishing configured BIO brightness from actual `brightness`.

- [ ] **Step 4: Verify GREEN and control boundary**

```bash
pnpm --filter @led-control/api exec jest src/fixtures/fixture-freshness.service.spec.ts src/fixture-identify/fixture-identify.service.spec.ts src/monitoring-incidents/monitoring-conditions.spec.ts src/sites/sites.service.spec.ts src/fixtures/fixtures.service.spec.ts src/monitoring-incidents/monitoring-control-boundary.integration.spec.ts --runInBand
pnpm --filter @led-control/web test -- src/api/queries.test.tsx
pnpm --filter @led-control/web typecheck
```

Expected: exact 20-minute boundary and 10-minute Web policy tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fixtures apps/api/src/fixture-identify apps/api/src/monitoring-incidents/monitoring-conditions.ts apps/api/src/monitoring-incidents/monitoring-conditions.spec.ts apps/api/src/sites/sites.service.ts apps/api/src/sites/sites.service.spec.ts apps/web/src/api/queries.ts apps/web/src/api/queries.test.tsx apps/web/src/test/fixtures.ts
git commit -m "feat: apply ten minute polling freshness policy"
```

---

### Task 8: 문서, 전체 검증과 Gateway HIL

**Files:**
- Modify: `docs/database-schema.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/settings.md`

**Interfaces:**
- Documents: DB fields, 10-minute polling, 20-minute stale, state/presence distinction
- Verifies: no BIO write during poll and live service receives presence

- [ ] **Step 1: Update required documentation**

Record the following exact facts:

- `database-schema.md`: Site default 1200; six Fixture presence/BIO fields and CHECK constraints; presence ingestion never touches energy state.
- `monitoring.md`: Gateway read-only poll and Web refresh are 10 minutes; 20 minutes is fresh and 20 minutes + 1ms is stale; API sweep remains 30 seconds; sensor mode output remains unknown.
- `control.md`: a fresh presence restores control eligibility only when no fault/command failure/provisioning blocker remains; command read-back still emits actual fixture-state.
- `settings.md`: manufacturer app is unnecessary after direct USB registration; confirmed UUID/address mapping is the only poll target; poll sends GET only.

Preserve every menu document section: `구현 완료`, `미구현`, `부족하거나 개선이 필요한 기능`, `관련 파일`, `갱신 규칙`.

- [ ] **Step 2: Run static and focused regression gates**

```bash
git diff --check
pnpm --filter @led-control/shared test
pnpm --filter @led-control/gateway test
pnpm --filter @led-control/api exec jest --runInBand
pnpm --filter @led-control/web test
pnpm typecheck
pnpm build
```

Expected: every command exits 0 with no unexpected warnings. If a failure exposes a product regression, add one failing focused test before changing production code, then rerun this gate.

- [ ] **Step 3: Verify live BIO polling without writes**

On the Gateway test deployment, preserve redacted trace evidence for one registered fixture and verify this sequence only:

```text
scan response with confirmed UUID/address
readHighBrightness request/response
readControlMode request/response
fixture-presence MQTT publish
state-ingested application ACK
```

Assert no `assignAddress`, `setBrightness`, `setControlMode`, `identify`, or sensor-restore write appears between poll start and completion. Confirm API `lastSeenAt` advances, BIO metadata matches the response, and stored `brightness`/`powerOn` do not change.

- [ ] **Step 4: Verify timing policy safely**

Use fake clocks or test-only interval overrides rather than waiting 20 real minutes. Demonstrate one successful pass, one missed 10-minute pass that remains fresh, and the 20-minute + 1ms boundary becoming stale. Restore production interval values before building the deployment image.

- [ ] **Step 5: Review final diff and commit**

```bash
git diff --check
git status --short
git add docs/database-schema.md docs/menus/monitoring.md docs/menus/control.md docs/menus/settings.md
git commit -m "docs: explain BIO presence polling semantics"
```

The existing MQTT ACL already allows the scoped `state/#` namespace, so no ACL expansion is required. The final review must confirm `KNOWN_STATE_WINDOW_MS` remains 180,000 and no polling path calls a BIO write method.

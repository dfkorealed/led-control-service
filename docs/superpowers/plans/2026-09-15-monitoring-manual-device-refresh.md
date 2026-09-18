# Monitoring Manual Device Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the monitoring refresh button actively verify the selected floor's physical fixture reachability and show a twice-unreachable fixture as offline without waiting 20 minutes.

**Architecture:** A dedicated monitoring-refresh aggregate snapshots server-selected fixtures, publishes read-only per-Gateway commands through a durable outbox, and collects durable Gateway presence/unreachable results. The API resolves results transactionally into refresh rows and fixture reachability state; the Web polls only the aggregate and then refetches its existing dashboard/fixture/map queries.

**Tech Stack:** TypeScript, Zod, NestJS, Prisma/PostgreSQL, MQTT v5 QoS 1, Node.js Gateway, React 18, TanStack Query, Vitest/Jest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-15-monitoring-manual-device-refresh-design.md`

## Global Constraints

- The request targets only fixtures registered on the currently selected active floor; browser input never supplies fixture or Gateway IDs.
- The probe is read-only: it must not change brightness, power, BIO control mode, address, group membership, Health state, or energy checkpoints.
- A fixture becomes offline only after two probe passes both return a verified `not_found`, `read_timeout`, or `read_failed` result while its Gateway is fresh.
- Gateway/MQTT delivery failure produces `unverified`, never fixture-level offline.
- BIO sensor presence must not be converted into actual brightness or power.
- Existing 600,000ms automatic polling, 1,200-second stale policy, and fixed Gateway freshness remain unchanged.
- HTTP requests are idempotent, one active refresh per site/floor is reused, terminal retries have a 30-second cooldown, and the request deadline is 30 seconds.
- Limit one refresh to 1,000 fixtures and each Gateway command batch to 64 unique fixtures.
- Maintain lock order `Site → Gateway → Fixture → MonitoringRefresh` and reject late results that would overwrite a newer observation.
- Update `docs/database-schema.md`, `docs/menus/monitoring.md`, and `docs/menus/control.md` in the same implementation.

---

### Task 1: Shared monitoring-refresh wire contracts

**Files:**
- Modify: `packages/shared/src/gateway-contracts.ts`
- Modify: `packages/shared/src/gateway-contracts.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `fixturePresenceCheckCommandV1Schema`, `fixtureUnreachableV1Schema`, `fixturePresenceCheckCompletedV1Schema`, `fixturePresenceCheckCompletedAckV1Schema` and inferred exported types.
- Produces MQTT topic builders: `fixturePresenceCheck`, `fixtureUnreachable`, `fixturePresenceCheckCompleted`, `fixturePresenceCheckCompletedAck`.
- Extends: `fixturePresenceV2Schema` with optional paired `refreshId` and `batchId`; both must be present together or absent together.

- [ ] **Step 1: Write failing contract tests**

```ts
it("binds a read-only fixture presence check to one site, gateway, refresh and batch", () => {
  const parsed = fixturePresenceCheckCommandV1Schema.parse({
    siteId: "11111111-1111-4111-8111-111111111111",
    gatewayId: "22222222-2222-4222-8222-222222222222",
    refreshId: "33333333-3333-4333-8333-333333333333",
    batchId: "44444444-4444-4444-8444-444444444444",
    idempotencyKey: "55555555-5555-4555-8555-555555555555",
    sequence: 7,
    targetFixtureIds: ["66666666-6666-4666-8666-666666666666"],
    requestedAt: "2026-09-15T08:00:00.000Z",
    expiresAt: "2026-09-15T08:00:30.000Z"
  });
  expect(parsed.targetFixtureIds).toEqual(["66666666-6666-4666-8666-666666666666"]);
  expect(mqttTopicsV2.fixturePresenceCheck(parsed.siteId, parsed.gatewayId))
    .toBe("sites/11111111-1111-4111-8111-111111111111/gateways/22222222-2222-4222-8222-222222222222/commands/fixture-presence-check");
});

it("rejects partial refresh identity and unreachable payload data that can imply output", () => {
  expect(() => fixturePresenceV2Schema.parse({ ...presence, refreshId: ids.refresh }))
    .toThrow();
  expect(() => fixtureUnreachableV1Schema.parse({ ...unreachable, brightness: 0 }))
    .toThrow();
});
```

- [ ] **Step 2: Run the shared contract test and verify RED**

Run: `pnpm --filter @led-control/shared test -- src/gateway-contracts.test.ts`

Expected: FAIL because the four schemas and topic builders do not exist.

- [ ] **Step 3: Implement strict schemas and exports**

```ts
const monitoringRefreshIdentitySchema = z.object({
  refreshId: z.string().uuid(),
  batchId: z.string().uuid()
});

export const fixturePresenceCheckCommandV1Schema = gatewayScopeSchema
  .merge(monitoringRefreshIdentitySchema)
  .extend({
    idempotencyKey: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    targetFixtureIds: z.array(z.string().uuid()).min(1).max(64),
    requestedAt: z.string().datetime(),
    expiresAt: z.string().datetime()
  })
  .superRefine((value, context) => {
    if (new Set(value.targetFixtureIds).size !== value.targetFixtureIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetFixtureIds"], message: "fixture ids must be unique" });
    }
    if (Date.parse(value.expiresAt) <= Date.parse(value.requestedAt)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiresAt must follow requestedAt" });
    }
  });

export const fixtureUnreachableV1Schema = orderedGatewayEventSchema
  .merge(monitoringRefreshIdentitySchema)
  .extend({ fixtureId: z.string().uuid(), reason: z.enum(["not_found", "read_timeout", "read_failed"]) })
  .strict();
```

Define the completion payload with the same scope/refresh/batch identity and exact `targetFixtureIds`; define its ACK as `siteId`, `gatewayId`, `refreshId`, `batchId`; keep every object strict. Add a refinement to `fixturePresenceV2Schema` that rejects only-one-of refresh/batch identity.

- [ ] **Step 4: Verify GREEN and package exports**

Run: `pnpm --filter @led-control/shared test -- src/gateway-contracts.test.ts src/package-exports.test.ts`

Expected: both files PASS and both ESM/CommonJS packages export the new symbols.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/shared/src/gateway-contracts.ts packages/shared/src/gateway-contracts.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): define monitoring refresh contracts"
```

---

### Task 2: Persist the refresh aggregate and reachability precedence

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260915090000_monitoring_manual_refresh/migration.sql`
- Modify: `apps/api/src/monitoring-incidents/monitoring-schema.integration.spec.ts`
- Modify: `apps/api/src/monitoring-incidents/monitoring-conditions.ts`
- Modify: `apps/api/src/monitoring-incidents/monitoring-conditions.spec.ts`

**Interfaces:**
- Produces Prisma enums `MonitoringRefreshStatus`, `MonitoringRefreshBatchStatus`, `MonitoringRefreshFixtureStatus`.
- Produces models `MonitoringRefresh`, `MonitoringRefreshBatch`, `MonitoringRefreshFixture` and `Fixture.lastUnreachableAt`.
- Extends `MonitoringConditionTarget.fixture` with `lastUnreachableAt: Date | null`.

- [ ] **Step 1: Write failing schema and status-precedence tests**

```ts
it("treats a newer verified unreachable result as immediately stale", () => {
  const now = new Date("2026-09-15T08:00:10.000Z");
  const result = monitoringFixtureState({
    reportedStatus: "online",
    reportedStatusReason: "reported",
    lastSeenAt: new Date("2026-09-15T08:00:00.000Z"),
    lastUnreachableAt: new Date("2026-09-15T08:00:05.000Z"),
    healthFaultCodes: [],
    healthLastSeenAt: now
  }, { lastHeartbeatAt: now }, policy, now);
  expect(result).toEqual({ status: "offline", statusReason: "fixture_stale" });
});

it("keeps a newer successful observation online after an older unreachable result", () => {
  const now = new Date("2026-09-15T08:00:10.000Z");
  const result = monitoringFixtureState({
    reportedStatus: "online",
    reportedStatusReason: "reported",
    lastSeenAt: new Date("2026-09-15T08:00:06.000Z"),
    lastUnreachableAt: new Date("2026-09-15T08:00:05.000Z"),
    healthFaultCodes: [],
    healthLastSeenAt: now
  }, { lastHeartbeatAt: now }, policy, now);
  expect(result.status).toBe("online");
});
```

Add a migration integration assertion that the three tables, all enum/check constraints, foreign keys, indexes, and nullable `Fixture.lastUnreachableAt` exist after the migration.

- [ ] **Step 2: Run targeted API tests and verify RED**

Run: `pnpm --filter @led-control/api test -- --runInBand src/monitoring-incidents/monitoring-conditions.spec.ts src/monitoring-incidents/monitoring-schema.integration.spec.ts`

Expected: FAIL because the Prisma field/models and immediate unreachable precedence are absent.

- [ ] **Step 3: Add Prisma models and migration**

```prisma
model MonitoringRefresh {
  id                 String                  @id @default(uuid())
  siteId             String
  floorId            String
  requestedById      String?
  clientRequestId    String
  status             MonitoringRefreshStatus @default(pending)
  totalFixtures      Int
  onlineFixtures     Int                     @default(0)
  offlineFixtures    Int                     @default(0)
  unverifiedFixtures Int                     @default(0)
  deadlineAt         DateTime
  completedAt        DateTime?
  createdAt          DateTime                 @default(now())
  updatedAt          DateTime                 @updatedAt
  batches            MonitoringRefreshBatch[]
  fixtureResults     MonitoringRefreshFixture[]

  @@unique([siteId, requestedById, clientRequestId])
  @@index([siteId, floorId, status])
  @@index([createdAt])
}
```

Add `site Site @relation(fields: [siteId], references: [id], onDelete: Cascade)`, `floor Floor @relation(fields: [floorId], references: [id], onDelete: Cascade)`, and `requestedBy User? @relation(fields: [requestedById], references: [id], onDelete: SetNull)` to the parent. Add `refresh MonitoringRefresh @relation(fields: [refreshId], references: [id], onDelete: Cascade)` and `gateway Gateway @relation(fields: [gatewayId], references: [id], onDelete: Cascade)` to each batch; add exact `refreshId`, `batchId`, and `fixtureId` cascade relations to each child. Add `MqttOutbox.monitoringRefreshBatchId String? @unique` with `monitoringRefreshBatch MonitoringRefreshBatch? @relation(fields: [monitoringRefreshBatchId], references: [id], onDelete: Cascade)`. The SQL migration must enforce nonnegative counters, terminal timestamps only on terminal states, JSON-array targets, and child outcome/timestamp consistency.

- [ ] **Step 4: Implement reachability precedence**

```ts
const manuallyUnreachable = fixture.lastUnreachableAt !== null &&
  (fixture.lastSeenAt === null || fixture.lastUnreachableAt.getTime() > fixture.lastSeenAt.getTime());

if (type === "fixture_stale") {
  return fixture.reportedStatusReason !== "provisioning_waiting_state" &&
    target.gateway != null && !gatewayOffline &&
    (manuallyUnreachable || fixture.lastSeenAt === null ||
      fixture.lastSeenAt.getTime() < now.getTime() - policy.fixtureStaleAfterSeconds * 1000);
}
```

- [ ] **Step 5: Generate Prisma client and verify GREEN**

Run: `pnpm --filter @led-control/api prisma:generate`

Run: `pnpm --filter @led-control/api test -- --runInBand src/monitoring-incidents/monitoring-conditions.spec.ts src/monitoring-incidents/monitoring-schema.integration.spec.ts`

Expected: PASS, including exact fresh/stale boundary regressions.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/api/prisma apps/api/src/monitoring-incidents/monitoring-conditions.ts apps/api/src/monitoring-incidents/monitoring-conditions.spec.ts apps/api/src/monitoring-incidents/monitoring-schema.integration.spec.ts
git commit -m "feat(api): persist monitoring refresh state"
```

---

### Task 3: Create, publish, expire, and read monitoring refresh requests

**Files:**
- Create: `apps/api/src/monitoring-refresh/monitoring-refresh.dto.ts`
- Create: `apps/api/src/monitoring-refresh/monitoring-refresh.service.ts`
- Create: `apps/api/src/monitoring-refresh/monitoring-refresh.service.spec.ts`
- Create: `apps/api/src/monitoring-refresh/monitoring-refresh.controller.ts`
- Create: `apps/api/src/monitoring-refresh/monitoring-refresh.controller.spec.ts`
- Create: `apps/api/src/monitoring-refresh/monitoring-refresh-outbox.service.ts`
- Create: `apps/api/src/monitoring-refresh/monitoring-refresh-outbox.service.spec.ts`
- Create: `apps/api/src/monitoring-refresh/monitoring-refresh-expiry.service.ts`
- Create: `apps/api/src/monitoring-refresh/monitoring-refresh-expiry.service.spec.ts`
- Create: `apps/api/src/monitoring-refresh/monitoring-refresh.module.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces `MonitoringRefreshService.create(user, siteId, floorId, input)` and `.get(user, siteId, refreshId)`.
- Produces POST/GET routes from the spec.
- Produces a dedicated outbox publisher for `MqttOutbox.monitoringRefreshBatchId` rows and an expiry worker with a 30-second deadline.

- [ ] **Step 1: Write failing service tests for trusted target selection and idempotency**

```ts
it("snapshots only server-selected active-floor fixtures and chunks each gateway at 64", async () => {
  prisma.floor.findFirst.mockResolvedValue({ id: floorId, siteId, status: "active" });
  prisma.fixture.findMany.mockResolvedValue(makeFixtures(65, gatewayId));
  const result = await service.create(viewer, siteId, floorId, { clientRequestId });
  expect(result).toMatchObject({ status: "pending", totalFixtures: 65 });
  expect(prisma.monitoringRefreshBatch.create).toHaveBeenCalledTimes(2);
  expect(prisma.monitoringRefreshBatch.create.mock.calls[0][0].data.targetFixtureIds).toHaveLength(64);
  expect(prisma.monitoringRefreshBatch.create.mock.calls[1][0].data.targetFixtureIds).toHaveLength(1);
});

it("returns the same request for an identical client id and rejects a different floor", async () => {
  prisma.monitoringRefresh.findUnique.mockResolvedValue(existingRefresh);
  await expect(service.create(viewer, siteId, floorId, { clientRequestId })).resolves.toMatchObject({ id: existingRefresh.id });
  await expect(service.create(viewer, siteId, otherFloorId, { clientRequestId }))
    .rejects.toMatchObject({ response: { code: "monitoring_refresh_payload_conflict" } });
});
```

Add tests for read capability, missing/inactive floor, zero fixtures, 1,001 fixture rejection, active request reuse, terminal 30-second cooldown, safe integer sequence, and sanitized responses.

- [ ] **Step 2: Run the service tests and verify RED**

Run: `pnpm --filter @led-control/api test -- --runInBand src/monitoring-refresh/monitoring-refresh.service.spec.ts`

Expected: FAIL because the module and service do not exist.

- [ ] **Step 3: Implement request creation and GET projection**

```ts
async create(user: AuthenticatedUser, siteId: string, floorId: string, input: { clientRequestId: string }) {
  await this.siteAccess.assert(user, siteId, "read");
  return this.prisma.$transaction(async (tx) => {
    await this.siteAccess.assertReadInTransaction(tx, user, siteId);
    const floor = await tx.floor.findFirst({ where: { id: floorId, siteId, status: "active" } });
    if (!floor) throw new NotFoundException("floor not found");
    const fixtures = await tx.fixture.findMany({
      where: { floorId, siteId, meshNode: { isNot: null } },
      select: { id: true, meshNode: { select: { gatewayId: true } } },
      orderBy: { id: "asc" },
      take: 1001
    });
    return this.createSnapshot(tx, user, floor, fixtures, input.clientRequestId);
  });
}
```

Validate `{ clientRequestId: uuid }` with strict Zod parsing. Group by Gateway, sort fixture IDs, chunk at 64, increment each Gateway sequence, create refresh/batch/child/outbox rows in one transaction, and return only the documented projection.

- [ ] **Step 4: Write failing controller, publisher, and expiry tests**

```ts
it("publishes only monitoring refresh rows with a bounded MQTT expiry", async () => {
  await publisher.runScheduledBatch();
  expect(mqtt.publishTopic).toHaveBeenCalledWith(
    mqttTopicsV2.fixturePresenceCheck(siteId, gatewayId),
    expect.objectContaining({ refreshId, batchId, expiresAt: deadlineAt.toISOString() }),
    { messageExpiryInterval: 30, timeoutMs: 20_000 }
  );
});

it("expires unresolved fixtures as unverified without changing Fixture", async () => {
  await expiry.expire(new Date("2026-09-15T08:00:31.000Z"));
  expect(prisma.monitoringRefreshFixture.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "unverified" } }));
  expect(prisma.fixture.updateMany).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Implement controller, publisher, expiry worker, and module wiring**

```ts
@Post("sites/:siteId/floors/:floorId/monitoring-refreshes")
create(@Param("siteId") siteId: string, @Param("floorId") floorId: string,
  @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
  return this.service.create(user, siteId, floorId, parseMonitoringRefreshInput(body));
}

@Get("sites/:siteId/monitoring-refreshes/:refreshId")
get(@Param("siteId") siteId: string, @Param("refreshId") refreshId: string,
  @CurrentUser() user: AuthenticatedUser) {
  return this.service.get(user, siteId, refreshId);
}
```

Model publisher locking, bounded retry, PUBACK recording, dead-letter handling, `.unref()` timers, and sanitized logging after the existing provisioning outbox services. The expiry service runs every second, locks expired pending aggregates, marks pending child/batch rows unverified/expired, aggregates counters, and never updates Fixture rows.

- [ ] **Step 6: Verify Task 3 GREEN**

Run: `pnpm --filter @led-control/api test -- --runInBand src/monitoring-refresh`

Expected: all new unit/controller/module tests PASS with no open timer handles.

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/api/src/monitoring-refresh apps/api/src/app.module.ts
git commit -m "feat(api): dispatch manual monitoring refresh"
```

---

### Task 4: Execute two-pass read-only probes on the Gateway

**Files:**
- Modify: `apps/gateway/src/gateway.ts`
- Modify: `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts`
- Modify: `apps/gateway/src/adapters/bio-usb-dongle-adapter.test.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.test.ts`
- Create: `apps/gateway/src/commands/fixture-presence-check-handler.ts`
- Create: `apps/gateway/src/commands/fixture-presence-check-handler.test.ts`
- Create: `apps/gateway/src/state/monitoring-refresh-journal.ts`
- Create: `apps/gateway/src/state/monitoring-refresh-journal.test.ts`
- Modify: `apps/gateway/src/state/state-event-outbox.ts`
- Modify: `apps/gateway/src/state/state-event-outbox.test.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/index.test.ts`

**Interfaces:**
- Produces `BleMeshAdapter.probeFixturePresence(fixtureIds, signal): Promise<BleMeshFixtureProbeResult[]>`.
- Produces `BleMeshFixtureProbeResult = { fixtureId; outcome: "online" | "not_found" | "read_timeout" | "read_failed"; presence? }`.
- Produces `handleFixturePresenceCheck(adapter, journal, command, publisher, options): Promise<void>` and durable `MonitoringRefreshJournal` terminal replay.

- [ ] **Step 1: Write failing adapter tests for per-fixture outcomes**

```ts
it("returns exact online and timeout outcomes without treating sensor settings as output", async () => {
  mappings.listConfirmed.mockResolvedValue([firstMapping, secondMapping]);
  client.scan.mockResolvedValue([firstDevice, secondDevice]);
  client.readBrightness.mockResolvedValueOnce(firstBrightness).mockRejectedValueOnce(new BioUsbError("TIMEOUT", "read timeout"));
  client.readDeviceInfo.mockResolvedValueOnce({ ...firstIdentity, mode: "sensor" });
  await expect(adapter.probeFixturePresence([firstId, secondId]))
    .resolves.toEqual([
      expect.objectContaining({ fixtureId: firstId, outcome: "online", presence: expect.objectContaining({ controlMode: "sensor" }) }),
      { fixtureId: secondId, outcome: "read_timeout" }
    ]);
  expect(lightingObservation).not.toHaveBeenCalled();
});
```

Add BlueZ assertions that OnOff/Lightness observation means online and no Set opcode is issued. A `Node1.Send` D-Bus `TIMEOUT`/`ETIMEDOUT` is `transport_unavailable` and leaves the batch unverified; only an observation response timeout after a successful Send is a fixture `read_timeout`.

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `pnpm --filter @led-control/gateway test -- src/adapters/bio-usb-dongle-adapter.test.ts src/mesh/bluez-mesh-adapter.test.ts`

Expected: FAIL because `probeFixturePresence` is absent.

- [ ] **Step 3: Extract and implement the common probe path**

```ts
export interface BleMeshFixtureProbeResult {
  fixtureId: string;
  outcome: "online" | "not_found" | "read_timeout" | "read_failed";
  presence?: BleMeshFixturePresence;
}

async probeFixturePresence(fixtureIds: string[], signal?: AbortSignal) {
  const requested = new Set(fixtureIds);
  const mappings = (await this.mappings.listConfirmed()).filter((row) => requested.has(row.fixtureId));
  return this.probeConfirmedMappings(mappings, fixtureIds, signal);
}
```

Keep one BIO discovery scan per pass, exact UUID/native UUID/address checks, serial brightness GET then mode GET, sanitized error classification, and listener delivery only after a verified response. Refactor existing resync methods to aggregate these real probe results rather than duplicate transport logic.

- [ ] **Step 4: Write failing handler and journal tests for two passes and replay**

```ts
it("retries only first-pass failures and emits unreachable after the second failure", async () => {
  adapter.probeFixturePresence
    .mockResolvedValueOnce([{ fixtureId: firstId, outcome: "online", presence }, { fixtureId: secondId, outcome: "not_found" }])
    .mockResolvedValueOnce([{ fixtureId: secondId, outcome: "not_found" }]);
  await handleFixturePresenceCheck(adapter, journal, command, emit);
  expect(adapter.probeFixturePresence).toHaveBeenNthCalledWith(1, [firstId, secondId], expect.any(AbortSignal));
  expect(adapter.probeFixturePresence).toHaveBeenNthCalledWith(2, [secondId], expect.any(AbortSignal));
  expect(emit.unreachable).toHaveBeenCalledWith(expect.objectContaining({ fixtureId: secondId, reason: "not_found" }));
});

it("replays an exact durable terminal without probing the adapter twice after restart", async () => {
  await firstJournal.complete(identity, terminalEvents);
  const recovered = new MonitoringRefreshJournal(path, scope);
  await handleFixturePresenceCheck(adapter, recovered, command, emit);
  expect(adapter.probeFixturePresence).not.toHaveBeenCalled();
  expect(emit.completed).toHaveBeenCalledWith(terminalEvents.completed);
});
```

- [ ] **Step 5: Implement journal, handler, outbox union, and runtime wiring**

```ts
export async function handleFixturePresenceCheck(
  adapter: Pick<BleMeshAdapter, "probeFixturePresence">,
  journal: MonitoringRefreshJournal,
  command: FixturePresenceCheckCommandV1,
  publisher: MonitoringRefreshEventPublisher,
  options: { retryDelayMs?: number; now?: () => Date; signal?: AbortSignal } = {}
) {
  const exact = await journal.accept(command);
  if (exact.terminal) return publisher.replay(exact.terminal);
  const first = await adapter.probeFixturePresence(command.targetFixtureIds, options.signal);
  const retryIds = first.filter((row) => row.outcome !== "online").map((row) => row.fixtureId);
  const second = retryIds.length === 0 ? [] : await adapter.probeFixturePresence(retryIds, options.signal);
  return publisher.persistAndPublish(await journal.complete(command, mergeProbePasses(first, second)));
}
```

Extend `StateEventOutbox` to persist `FixtureUnreachableV1` alongside state/presence and acknowledge it with the existing fixture-scoped state ACK. Store batch completion in `MonitoringRefreshJournal` and republish it until the dedicated completion ACK arrives. Add command/completion ACK subscriptions and safe shutdown draining in `index.ts`.

- [ ] **Step 6: Verify Gateway GREEN**

Run: `pnpm --filter @led-control/gateway test -- src/adapters/bio-usb-dongle-adapter.test.ts src/mesh/bluez-mesh-adapter.test.ts src/commands/fixture-presence-check-handler.test.ts src/state/monitoring-refresh-journal.test.ts src/state/state-event-outbox.test.ts src/index.test.ts`

Expected: PASS, including duplicate, altered replay, expiry, shutdown, 64-fixture, and no-write-opcode cases.

- [ ] **Step 7: Commit Task 4**

```bash
git add apps/gateway/src
git commit -m "feat(gateway): probe monitoring fixtures on demand"
```

---

### Task 5: Ingest reachability results and converge refresh state

**Files:**
- Create: `apps/api/src/monitoring-refresh/monitoring-refresh-ingestion.service.ts`
- Create: `apps/api/src/monitoring-refresh/monitoring-refresh-ingestion.service.spec.ts`
- Create: `apps/api/src/monitoring-refresh/monitoring-refresh.integration.spec.ts`
- Modify: `apps/api/src/fixtures/fixture-presence-ingestion.service.ts`
- Modify: `apps/api/src/fixtures/fixture-presence-ingestion.service.spec.ts`
- Modify: `apps/api/src/energy/fixture-state-ingestion.service.ts`
- Modify: `apps/api/src/energy/fixture-state-ingestion.service.spec.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.spec.ts`
- Modify: `apps/api/src/mqtt/mqtt.module.ts`
- Modify: `apps/api/src/fixtures/fixture-freshness.service.ts`
- Modify: `apps/api/src/fixtures/fixture-freshness.service.spec.ts`

**Interfaces:**
- Produces `MonitoringRefreshIngestionService.ingestUnreachable(topic, event, receivedAt)` and `.completeBatch(topic, event, receivedAt)`.
- Extends presence ingestion to accept optional refresh identity and resolve an online child row in the same transaction.
- Produces completion ACK only after every expected fixture result is terminal.

- [ ] **Step 1: Write failing unit tests for online recovery and offline precedence**

```ts
it("stores a verified unreachable result as offline without changing reported output", async () => {
  await service.ingestUnreachable(topic, unreachable, receivedAt);
  expect(tx.fixture.update).toHaveBeenCalledWith({
    where: { id: fixtureId },
    data: { lastUnreachableAt: receivedAt, status: "offline", statusReason: "fixture_stale" }
  });
  expect(tx.monitoringRefreshFixture.update).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ status: "offline", errorCode: "not_found" })
  }));
  expect(tx.fixture.update.mock.calls[0][0].data).not.toHaveProperty("brightness");
  expect(tx.fixture.update.mock.calls[0][0].data).not.toHaveProperty("reportedStatus");
});

it("lets a newer presence win over a delayed unreachable result", async () => {
  lockedFixture.lastSeenAt = new Date("2026-09-15T08:00:06.000Z");
  refresh.createdAt = new Date("2026-09-15T08:00:00.000Z");
  await service.ingestUnreachable(topic, unreachable, new Date("2026-09-15T08:00:07.000Z"));
  expect(tx.fixture.update).not.toHaveBeenCalled();
  expect(tx.monitoringRefreshFixture.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "online" }) }));
});
```

Add tests for wrong site/gateway/batch/fixture scope, stale deadline, Gateway heartbeat offline, duplicate event, reverse sequence/time, raw error sanitization, and lock order.

- [ ] **Step 2: Run ingestion tests and verify RED**

Run: `pnpm --filter @led-control/api test -- --runInBand src/monitoring-refresh/monitoring-refresh-ingestion.service.spec.ts`

Expected: FAIL because the ingestion service is absent.

- [ ] **Step 3: Implement transactional result ingestion**

```ts
async ingestUnreachable(topic: string, raw: unknown, receivedAt: Date) {
  const event = fixtureUnreachableV1Schema.parse(raw);
  assertFixtureUnreachableTopic(topic, event.siteId, event.gatewayId);
  return this.prisma.$transaction(async (tx) => {
    const context = await this.lockContext(tx, event);
    if (context.refresh.deadlineAt < receivedAt || !isMonitoringGatewayOnline(context.gateway.lastHeartbeatAt, context.sitePolicy, receivedAt)) {
      return this.resolveFixture(tx, context, "unverified", receivedAt);
    }
    if (context.fixture.lastSeenAt && context.fixture.lastSeenAt >= context.refresh.createdAt) {
      return this.resolveFixture(tx, context, "online", receivedAt);
    }
    await tx.fixture.update({
      where: { id: context.fixture.id },
      data: { lastUnreachableAt: receivedAt, status: "offline", statusReason: "fixture_stale" }
    });
    return this.resolveFixture(tx, context, "offline", receivedAt, event.reason);
  });
}
```

Load `context.sitePolicy` from the locked Site row so heartbeat evaluation uses the actual policy. Lock Site, Gateway, Fixture, refresh, batch, and child row in the documented order using bounded transactions.

- [ ] **Step 4: Write failing tests for presence recovery, completion, and expiry races**

```ts
it("clears manual unreachable only after a newer state or presence observation", async () => {
  await presenceService.ingest(topic, { ...presence, refreshId, batchId }, receivedAt);
  expect(tx.fixture.update).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ lastSeenAt: receivedAt, lastUnreachableAt: null })
  }));
});

it("aggregates child rows once and ACKs completion only when every fixture is terminal", async () => {
  tx.monitoringRefreshFixture.groupBy.mockResolvedValue([
    { status: "online", _count: { _all: 1 } },
    { status: "offline", _count: { _all: 1 } }
  ]);
  const result = await service.completeBatch(topic, completed, receivedAt);
  expect(result.ack).toEqual(expect.objectContaining({ refreshId, batchId }));
  expect(tx.monitoringRefresh.update).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ status: "completed", onlineFixtures: 1, offlineFixtures: 1, unverifiedFixtures: 0 })
  }));
});
```

- [ ] **Step 5: Wire MQTT handlers and success recovery**

Subscribe to `state/fixture-unreachable` and `events/fixture-presence-check-completed`. Route presence events with refresh identity through the existing presence transaction, publish state ACK only after commit, publish completion ACK only after child aggregation, and close the MQTT connection on identity/hash conflict to preserve broker redelivery behavior. Clear `lastUnreachableAt` in both accepted fixture-state and fixture-presence writes; preserve `command_failed`, Health, brightness, power, and energy rules.

```ts
await client.subscribeAsync([
  "sites/+/gateways/+/state/fixture-unreachable",
  "sites/+/gateways/+/events/fixture-presence-check-completed"
], { qos: 1 });

if (topic.endsWith("/state/fixture-unreachable")) {
  const ack = await monitoringRefreshIngestion.ingestUnreachable(topic, payload, receivedAt);
  await this.publishStateIngestedAck(ack);
}
if (topic.endsWith("/events/fixture-presence-check-completed")) {
  const ack = await monitoringRefreshIngestion.completeBatch(topic, payload, receivedAt);
  await this.publishMonitoringRefreshCompletedAck(ack);
}
```

- [ ] **Step 6: Add PostgreSQL lifecycle integration coverage**

```ts
it("converges two online fixtures to one online and one offline, then recovers", async () => {
  const refresh = await createRefreshFor([firstFixture, secondFixture]);
  await ingestPresence(refresh, firstFixture, at(1));
  await ingestUnreachable(refresh, secondFixture, at(2), "not_found");
  await complete(refresh, at(3));
  expect(await floorStatuses()).toEqual([
    { id: firstFixture, status: "online" },
    { id: secondFixture, status: "offline" }
  ]);
  await ingestPresenceWithoutRefresh(secondFixture, at(4));
  expect(await floorStatuses()).toEqual([
    { id: firstFixture, status: "online" },
    { id: secondFixture, status: "online" }
  ]);
});
```

- [ ] **Step 7: Verify API GREEN**

Run: `pnpm --filter @led-control/api test -- --runInBand src/monitoring-refresh src/fixtures/fixture-presence-ingestion.service.spec.ts src/fixtures/fixture-freshness.service.spec.ts src/energy/fixture-state-ingestion.service.spec.ts src/mqtt/mqtt.service.spec.ts`

Expected: all unit and available PostgreSQL integration cases PASS; environment-gated integration remains explicitly reported if no database URL exists.

- [ ] **Step 8: Commit Task 5**

```bash
git add apps/api/src/monitoring-refresh apps/api/src/fixtures apps/api/src/energy/fixture-state-ingestion.service.ts apps/api/src/energy/fixture-state-ingestion.service.spec.ts apps/api/src/mqtt
git commit -m "feat(api): apply monitoring reachability results"
```

---

### Task 6: Connect the monitoring refresh button to the hardware job

**Files:**
- Create: `apps/web/src/api/monitoring-refresh.ts`
- Create: `apps/web/src/api/monitoring-refresh.test.ts`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/features/monitoring/MonitoringView.test.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.monitoring.test.tsx`
- Modify: `apps/web/e2e/calm-operations-monitoring.spec.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces `startMonitoringRefresh(siteId, floorId, clientRequestId, signal)`.
- Produces `getMonitoringRefresh(siteId, refreshId, signal)`.
- Produces `waitForMonitoringRefresh(input): Promise<MonitoringRefreshResult>` with 500ms polling and abort support.

- [ ] **Step 1: Write failing API polling tests**

```ts
it("polls the server terminal URL until the refresh completes", async () => {
  apiPost.mockResolvedValue({ id: refreshId, status: "pending", totalFixtures: 2, terminalStatusUrl });
  apiGet.mockResolvedValueOnce({ id: refreshId, status: "pending" })
    .mockResolvedValueOnce({ id: refreshId, status: "completed", totalFixtures: 2, onlineFixtures: 1, offlineFixtures: 1, unverifiedFixtures: 0 });
  await expect(waitForMonitoringRefresh({ siteId, floorId, clientRequestId, pollMs: 0 }))
    .resolves.toMatchObject({ status: "completed", onlineFixtures: 1, offlineFixtures: 1 });
  expect(apiGet).toHaveBeenCalledTimes(2);
});

it("aborts polling when the selected floor changes", async () => {
  const controller = new AbortController();
  const pending = waitForMonitoringRefresh({ siteId, floorId, clientRequestId, signal: controller.signal, pollMs: 10 });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});
```

- [ ] **Step 2: Run API tests and verify RED**

Run: `pnpm --filter @led-control/web test -- src/api/monitoring-refresh.test.ts`

Expected: FAIL because the client module does not exist.

- [ ] **Step 3: Implement the typed API client and abortable polling**

```ts
export async function waitForMonitoringRefresh(input: WaitForMonitoringRefreshInput) {
  const started = await startMonitoringRefresh(input.siteId, input.floorId, input.clientRequestId, input.signal);
  if (started.status !== "pending") return started;
  while (true) {
    await abortableDelay(input.pollMs ?? 500, input.signal);
    const current = await getMonitoringRefresh(input.siteId, started.id, input.signal);
    if (current.status !== "pending") return current;
  }
}
```

Parse every response defensively, accept only the five documented statuses and nonnegative counters, and derive the GET URL from `siteId + refreshId` instead of trusting an arbitrary server URL.

- [ ] **Step 4: Write the failing MonitoringView behavior test**

```tsx
it("updates two fixtures to one normal and one offline after a hardware refresh", async () => {
  refreshApi.waitForMonitoringRefresh.mockResolvedValue({
    id: "refresh-id", status: "completed", totalFixtures: 2,
    onlineFixtures: 1, offlineFixtures: 1, unverifiedFixtures: 0,
    completedAt: "2026-09-15T08:00:05.000Z"
  });
  fixtureRefetch.mockImplementation(async () => {
    fixtureQuery.data = floorPage([onlineFixture, { ...offlineFixture, status: "offline", statusReason: "fixture_stale" }]);
  });
  fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
  expect(screen.getByRole("button", { name: "장치 상태 확인 중" })).toBeDisabled();
  await waitFor(() => expect(screen.getByRole("group", { name: "정상" })).toHaveTextContent("1"));
  expect(screen.getByRole("group", { name: "오프라인" })).toHaveTextContent("1");
});
```

Add tests for zero fixtures, active-click lock, partial/failed/expired copy, POST failure, final query failure, floor/site switch abort, unmount abort, and ignoring late callbacks.

- [ ] **Step 5: Run MonitoringView test and verify RED**

Run: `pnpm --filter @led-control/web test -- src/features/monitoring/MonitoringView.test.tsx`

Expected: FAIL because the button still performs HTTP-only refetches.

- [ ] **Step 6: Implement the UI state machine**

```ts
async function handleRefresh() {
  if (!floor || refreshAbortRef.current) return;
  const controller = new AbortController();
  refreshAbortRef.current = controller;
  setIsManualRefreshing(true);
  try {
    const terminal = fixtures.length === 0 ? null : await waitForMonitoringRefresh({
      siteId: siteId ?? data.site.id,
      floorId: floor.id,
      clientRequestId: crypto.randomUUID(),
      signal: controller.signal
    });
    if (!controller.signal.aborted) setHardwareRefreshFailure(copyForTerminal(terminal));
  } catch (error) {
    if (!isAbortError(error)) setHardwareRefreshFailure("장치 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  } finally {
    if (!controller.signal.aborted) await refetchMonitoringSources();
    if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
    if (!controller.signal.aborted) setIsManualRefreshing(false);
  }
}
```

Extract `refetchMonitoringSources` from the existing manual refresh logic so map/dashboard/fixture error preservation remains in one place. Abort the controller on unmount and before floor/site changes. Keep the existing button component and responsive toolbar; add only the smallest error-copy style needed.

- [ ] **Step 7: Add Chromium integration coverage**

Route POST/GET fixture responses so the initial page has two online fixtures and the terminal refetch returns one online/one offline. Assert `전체 2`, `정상 1`, `오프라인 1`, the offline marker label, selected fixture detail, button loading state, and absence of horizontal overflow at 1440, 1024, 390, and 320 widths. Add a partial-result test that preserves verified statuses and shows the sanitized warning.

```ts
await page.getByRole("button", { name: "새로고침" }).click();
await expect(page.getByRole("button", { name: "장치 상태 확인 중" })).toBeDisabled();
await expect(page.getByRole("group", { name: "전체 조명" })).toContainText("2");
await expect(page.getByRole("group", { name: "정상" })).toContainText("1");
await expect(page.getByRole("group", { name: "오프라인" })).toContainText("1");
await expect(page.getByRole("button", { name: "B2-L002 오프라인 70%" })).toBeVisible();
expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
```

- [ ] **Step 8: Verify Web GREEN**

Run: `pnpm --filter @led-control/web test -- src/api/monitoring-refresh.test.ts src/features/monitoring/MonitoringView.test.tsx src/features/shells/CustomerShell.monitoring.test.tsx`

Run: `pnpm --filter @led-control/web exec playwright test e2e/calm-operations-monitoring.spec.ts --project=chromium`

Expected: unit tests and all monitoring Chromium cases PASS.

- [ ] **Step 9: Commit Task 6**

```bash
git add apps/web/src/api/monitoring-refresh.ts apps/web/src/api/monitoring-refresh.test.ts apps/web/src/features/monitoring apps/web/src/features/shells/CustomerShell.monitoring.test.tsx apps/web/e2e/calm-operations-monitoring.spec.ts apps/web/src/styles.css
git commit -m "feat(web): refresh physical fixture status"
```

---

### Task 7: Retention, documentation, end-to-end verification, and integration

**Files:**
- Modify: `apps/api/src/retention/data-retention.service.ts`
- Modify: `apps/api/src/retention/data-retention.service.spec.ts`
- Modify: `apps/api/src/retention/data-retention.integration.spec.ts`
- Modify: `docs/database-schema.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `apps/web/e2e/real-backend-lab-support.spec.ts`
- Optional HIL evidence only when hardware is attached: `docs/hil/2026-09-15-monitoring-manual-refresh.md`

**Interfaces:**
- Produces seven-day cascade retention for terminal monitoring refresh aggregates.
- Produces current menu/database documentation and final software/HIL evidence with explicit limits.

- [ ] **Step 1: Write failing retention tests**

```ts
it("deletes only terminal monitoring refreshes older than seven days", async () => {
  await service.run(new Date("2026-09-15T08:00:00.000Z"));
  expect(tx.monitoringRefresh.deleteMany).toHaveBeenCalledWith({
    where: {
      status: { in: ["completed", "partial", "failed", "expired"] },
      completedAt: { lt: new Date("2026-09-08T08:00:00.000Z") }
    }
  });
});
```

The integration case creates old terminal, recent terminal, and old pending rows; only the old terminal parent and its cascade children disappear.

- [ ] **Step 2: Run retention tests and verify RED**

Run: `pnpm --filter @led-control/api test -- --runInBand src/retention/data-retention.service.spec.ts src/retention/data-retention.integration.spec.ts`

Expected: FAIL because monitoring refresh rows are not yet retained/cleaned.

- [ ] **Step 3: Implement bounded seven-day retention**

Add monitoring refresh deletion to the existing per-sweep transaction and cap it within the service's current total deletion budget. Never delete pending rows; rely on FK cascade only for terminal batch/fixture children and their acknowledged outbox rows.

```ts
await tx.monitoringRefresh.deleteMany({
  where: {
    id: { in: terminalRefreshIdsWithinRemainingBudget },
    status: { in: ["completed", "partial", "failed", "expired"] },
    completedAt: { lt: monitoringRefreshCutoff }
  }
});
```

- [ ] **Step 4: Update required documentation**

In `docs/database-schema.md`, document all three models, `Fixture.lastUnreachableAt`, outbox relation, lock order, 7-day retention, and migration name. In `docs/menus/monitoring.md`, replace the HTTP-only refresh contract with read-only two-pass hardware verification and the exact user copy. In `docs/menus/control.md`, document immediate control blocking after verified unreachable and recovery only through newer presence/state. Preserve the required `구현 완료`, `미구현`, `부족하거나 개선이 필요한 기능`, `관련 파일`, `갱신 규칙` sections.

- [ ] **Step 5: Add deterministic real-backend transport coverage**

Extend the existing disposable lab to publish one online presence and one twice-unreachable terminal for a two-fixture floor. Assert the production API returns one online and one offline, duplicate Gateway results do not change counters, and a later presence restores both online. If PostgreSQL/Redis/MQTT dependencies are unavailable, keep the test opt-in and record that limitation rather than substituting a mock as HIL proof.

```ts
const started = await request.post(`/api/sites/${siteId}/floors/${floorId}/monitoring-refreshes`, {
  data: { clientRequestId }
});
expect(started.ok()).toBe(true);
await lab.publishRefreshPresence(firstFixtureId, refreshId, firstBatchId);
await lab.publishRefreshUnreachable(secondFixtureId, refreshId, firstBatchId, "not_found");
await lab.publishRefreshCompleted(refreshId, firstBatchId);
await expect.poll(() => lab.floorStatusCounts(siteId, floorId)).toEqual({ online: 1, offline: 1 });
await lab.publishPresence(secondFixtureId);
await expect.poll(() => lab.floorStatusCounts(siteId, floorId)).toEqual({ online: 2, offline: 0 });
```

- [ ] **Step 6: Run the complete verification matrix**

Run: `pnpm lint`

Run: `pnpm typecheck`

Run: `pnpm build`

Run: `pnpm test`

Run: `pnpm --filter @led-control/web exec playwright test e2e/calm-operations-monitoring.spec.ts --project=chromium`

Run when its documented disposable services are available: `pnpm --filter @led-control/web exec playwright test e2e/real-backend-lab-support.spec.ts --project=chromium`

Expected: all non-opt-in checks exit 0; opt-in integration reports its explicit skip reason or passes.

- [ ] **Step 7: Run physical two-fixture HIL when equipment is attached**

Record exact Gateway version, API revision, device identities in redacted form, timestamps, and outcomes for: both online → physically power off one → click refresh → `정상 1 / 오프라인 1` → restore power → click refresh → `정상 2 / 오프라인 0`. Do not mark HIL complete when the USB dongle or both fixtures are unavailable.

- [ ] **Step 8: Commit Task 7**

```bash
git add apps/api/src/retention docs/database-schema.md docs/menus/monitoring.md docs/menus/control.md apps/web/e2e/real-backend-lab-support.spec.ts docs/hil/2026-09-15-monitoring-manual-refresh.md
git commit -m "docs: verify manual monitoring refresh"
```

When no HIL evidence file was created, omit that path from `git add` and state the hardware limitation in `docs/menus/monitoring.md`.

- [ ] **Step 9: Request independent code review and merge**

Review the full branch against the spec for data races, stale-event precedence, raw error leakage, outbox/journal durability, read-only behavior, accessibility, and test evidence. Resolve findings with new failing tests, rerun the affected and full verification matrices, then merge `codex/manual-monitoring-device-refresh` into the latest `codex/mvp1-cloud-web` while preserving unrelated working-tree files.

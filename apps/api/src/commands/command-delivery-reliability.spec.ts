import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AutomationClock } from "../automation/automation-clock";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { MqttService } from "../mqtt/mqtt.service";
import { OutboxPublisherService } from "../mqtt/outbox-publisher.service";
import { LegacyStatusCheckPublisherService } from "../mqtt/legacy-status-check-publisher.service";
import { CommandDispatchService } from "./command-dispatch.service";
import { CommandTimeoutService } from "./command-timeout.service";
import { CommandVerificationService } from "./command-verification.service";
import { CommandSafetyDigest } from "./command-safety-digest";
import { CommandsService } from "./commands.service";

const ids = {
  command: "11111111-1111-4111-8111-111111111111", dispatch: "22222222-2222-4222-8222-222222222222",
  key: "33333333-3333-4333-8333-333333333333", site: "44444444-4444-4444-8444-444444444444",
  gateway: "55555555-5555-4555-8555-555555555555", fixture: "66666666-6666-4666-8666-666666666666"
};
const floorId = "77777777-7777-4777-8777-777777777777";
const user = { id: "operator", role: "operator" } as AuthenticatedUser;
const startedAt = new Date("2026-09-12T00:00:00.000Z");
const identity = { commandId: ids.command, dispatchId: ids.dispatch, idempotencyKey: ids.key,
  siteId: ids.site, gatewayId: ids.gateway, sequence: 1 };
const draft = { ...identity, targetType: "fixture", targetId: ids.fixture, targetFixtureIds: [ids.fixture],
  deliveryMode: "unicast", brightness: 65, requestedAt: startedAt.toISOString() };

describe("command delivery uncertainty across publisher, ACK ingestion and recovery", () => {
  it.each(["failed", "timed_out"])("ingests BlueZ %s + STATUS_TIMEOUT as unknown and permits Get while protecting overlapping Set", async (status) => {
    const h = harness();
    await h.ack(status, [{ fixtureId: ids.fixture, status, faultCode: "STATUS_TIMEOUT" }]);
    expect(h.command.outcome).toBe("unknown");
    expect(h.dispatch).toMatchObject({ status: "timed_out", errorCode: "STATUS_TIMEOUT" });
    expect(h.results[0]).toMatchObject({ status: "timed_out", brightness: null, faultCode: "STATUS_TIMEOUT" });
    await expectRecoveryEligible(h);
    expect(h.unlockedMutations).toEqual([]);
  });

  it("validates the raw legacy aggregate before normalizing timeout evidence", async () => {
    const h = harness();
    await h.ack("timed_out", [{ fixtureId: ids.fixture, status: "failed", faultCode: "STATUS_TIMEOUT" }]);
    expect(h.dispatch.errorCode).toBe("ack_status_mismatch");
    expect(h.command.outcome).toBe("unknown");
    expect(h.results[0].faultCode).toBeNull();
  });

  it("closes lost PUBACK then persisted-generation expiry as unknown after a real reclaim", async () => {
    const h = harness();
    await h.publisher().processBatch();
    expect(h.outbox.deliveryAttemptedAt).toEqual(startedAt);
    expect(h.outbox.publishedAt).toBeNull();
    h.advance(11_000);
    await h.publisher().processBatch();
    expect(h.mqtt.publishTopic).toHaveBeenCalledTimes(1);
    expect(h.dispatch.errorCode).toBe("COMMAND_DELIVERY_EXPIRED");
    expect(h.command.outcome).toBe("unknown");
    await expectRecoveryEligible(h);
    expect(h.unlockedMutations).toEqual([]);
  });

  it("closes the last uncertain publish attempt as unknown at dead-letter", async () => {
    const h = harness();
    h.outbox.attempts = 9;
    await h.publisher().processBatch();
    expect(h.outbox).toMatchObject({ attempts: 10, deadLetteredAt: startedAt, deliveryAttemptedAt: startedAt });
    expect(h.dispatch.errorCode).toBe("MQTT_DEAD_LETTER");
    expect(h.command.outcome).toBe("unknown");
    await expectRecoveryEligible(h);
    expect(h.unlockedMutations).toEqual([]);
  });

  it("keeps a proven pre-send dead-letter not_applied even when claim attempts exist", async () => {
    const h = harness();
    h.outbox.attempts = 9;
    h.outbox.payload = { invalid: true };
    await h.publisher().processBatch();
    expect(h.mqtt.publishTopic).not.toHaveBeenCalled();
    expect(h.outbox.deliveryAttemptedAt).toBeNull();
    expect(h.dispatch.errorCode).toBe("MQTT_DEAD_LETTER");
    expect(h.command.outcome).toBe("not_applied");
    await expect(h.verification.requestStatusCheck(user, ids.command, { clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ response: { code: "command_outcome_not_unknown" } });
    await h.ack();
    expect(h.command.outcome).toBe("not_applied");
    expect(h.unlockedMutations).toEqual([]);
  });

  it.each(["MQTT_DEAD_LETTER", "COMMAND_DELIVERY_EXPIRED"])("accepts a conclusive late ACK after uncertain %s and never consumes it twice", async (errorCode) => {
    const h = harness();
    if (errorCode === "MQTT_DEAD_LETTER") h.outbox.attempts = 9;
    await h.publisher().processBatch();
    if (errorCode === "COMMAND_DELIVERY_EXPIRED") { h.advance(11_000); await h.publisher().processBatch(); }
    const ack = h.payload();
    await h.ingest(ack);
    expect(h.command.outcome).toBe("applied");
    expect(h.results[0]).toMatchObject({ status: "succeeded", brightness: 65 });
    const writes = h.resultWrites();
    await h.ingest(ack);
    expect(h.resultWrites()).toBe(writes);
  });

  it("preserves a conclusive late ACK after publisher terminal failure", async () => {
    const h = harness();
    h.outbox.attempts = 9;
    await h.publisher().processBatch();
    expect(h.mqtt.publishTopic).toHaveBeenCalledTimes(1);
    expect(h.outbox.deadLetteredAt).toEqual(startedAt);
    const beforeAckWrites = h.writeCalls();
    const beforeAckResults = h.resultWrites();
    await h.ack();
    expect(h.dispatch.status).toBe("completed");
    expect(h.command.outcome).toBe("applied");
    expect(h.results[0]).toMatchObject({ status: "succeeded", brightness: 65 });
    expect(h.resultWrites()).toBe(beforeAckResults + 1);
    expect(h.writeCalls()).toEqual({ results: beforeAckWrites.results + 1, command: beforeAckWrites.command + 1 });
    expect(h.unlockedMutations).toEqual([]);
  });

  it.each([[true, "unknown"], [false, "partially_applied"]])(
    "preserves attempted=%s delivery evidence when another dimming dispatch succeeds", async (attempted, expected) => {
      const h = harness();
      const sibling = { ...h.dispatch, id: randomUUID(), status: "accepted" };
      const fixtureId = randomUUID();
      h.dispatches.push(sibling);
      h.results.push({ dispatchId: sibling.id, fixtureId, status: "pending", brightness: null, faultCode: null });
      h.outbox.attempts = 9;
      if (!attempted) h.outbox.payload = { invalid: true };
      await h.publisher().processBatch();
      await h.ingest({ ...h.payload(), dispatchId: sibling.id, results: [{ fixtureId, status: "succeeded", brightness: 65 }] });
      expect(h.command.outcome).toBe(expected);
    }
  );

  it("retains publish uncertainty when the pending timeout worker closes an expired lease", async () => {
    const h = harness();
    await h.publisher().processBatch();
    h.advance(16 * 60_000);
    await h.timeout.closeExpired(h.now());
    expect(h.command.outcome).toBe("unknown");
    expect(h.dispatch.errorCode).toBe("ACCEPTANCE_TIMEOUT");
    await expectRecoveryEligible(h);
    await h.ack();
    expect(h.command.outcome).toBe("applied");
  });

  it("commits the durable attempt before MQTT and never sends after losing the marker lease fence", async () => {
    const h = harness();
    const marks: unknown[] = [];
    h.mqtt.publishTopic.mockImplementationOnce(async () => {
      // The final legacy Set transaction keeps its dispatch row locked through
      // native enqueue/PUBACK so terminal ACK cannot commit ahead of the wire.
      expect(h.activeTransactions()).toBe(1);
      marks.push(h.outbox.deliveryAttemptedAt);
    });
    await h.publisher().processBatch();
    expect(h.activeTransactions()).toBe(0);
    expect(marks).toEqual([startedAt]);
    expect(h.unlockedMutations).toEqual([]);
    const lost = harness({ loseAttemptFence: true });
    await lost.publisher().processBatch();
    expect(lost.mqtt.publishTopic).not.toHaveBeenCalled();
    expect(lost.outbox.deliveryAttemptedAt).toBeNull();
  });

  it("publishes a legacy timed draft using only a fresh delivery generation", async () => {
    const h = harness();
    h.outbox.payload = { ...draft, overrideUntil: new Date(startedAt.getTime() + 5_000).toISOString() };
    await h.publisher().processBatch();
    expect(h.mqtt.publishTopic).toHaveBeenCalledTimes(1);
    const published = h.mqtt.publishTopic.mock.calls[0][1];
    expect(published).not.toHaveProperty("overrideUntil");
    expect(published).not.toHaveProperty("overrideRemainingMs");
    expect(published).toMatchObject({
      deliveryGeneratedAt: startedAt.toISOString(),
      deliveryWindowMs: 10_000,
      expiresAt: new Date(startedAt.getTime() + 10_000).toISOString()
    });
  });

  it("reclaims a status-check with the same generation and reduced TTL, then never reclaims its published row", async () => {
    const h = harness({ statusCheck: true });
    await h.publisher().processBatch();
    const generation = structuredClone(h.outbox.payload);
    h.advance(3_200);
    h.mqtt.publishTopic.mockResolvedValueOnce(undefined);
    await h.publisher().processBatch();
    expect(h.mqtt.publishTopic).toHaveBeenNthCalledWith(2, h.outbox.topic, generation, {
      messageExpiryInterval: 6, timeoutMs: 20_000
    });
    h.advance(8_000);
    expect(await h.publisher().claimBatch()).toEqual([]);
    expect(h.mqtt.publishTopic).toHaveBeenCalledTimes(2);
    expect(h.outbox.deadLetteredAt).toBeNull();
    expect(h.command.outcome).toBe("unknown");
  });

  it.each(["expiry", "dead-letter"])("closes status-check publisher %s without deciding the original outcome", async (mode) => {
    const h = harness({ statusCheck: true });
    if (mode === "dead-letter") h.outbox.attempts = 9;
    await h.publisher().processBatch();
    if (mode === "expiry") { h.advance(11_000); await h.publisher().processBatch(); }
    expect(h.outbox.deadLetteredAt).not.toBeNull();
    expect(h.command.outcome).toBe("unknown");
    expect(h.unlockedMutations).toEqual([]);
  });
});

async function expectRecoveryEligible(h: ReturnType<typeof harness>) {
  await expect(h.commands.createDimmingCommand(user, { siteId: ids.site, clientRequestId: randomUUID(),
    target: { type: "fixture", fixtureId: ids.fixture }, brightness: 65 }))
    .rejects.toMatchObject({ response: { code: "uncertain_command_requires_status_check" } });
  await expect(h.verification.requestStatusCheck(user, ids.command, { clientRequestId: randomUUID() }))
    .resolves.toMatchObject({ verificationAttempt: 1 });
}

// Stateful DB boundary, not a PostgreSQL substitute: real services own claims,
// mutations, ACK validation and recovery decisions. Persisted rows enforce fences
// across separate worker instances; raw SQL locking/rollback still needs integration.
function harness(options: { statusCheck?: boolean; loseAttemptFence?: boolean } = {}) {
  let now = new Date(startedAt);
  const command: any = { id: ids.command, siteId: ids.site, brightness: 65, targetFixtureIds: [ids.fixture],
    status: options.statusCheck ? "failed" : "pending", outcome: options.statusCheck ? "unknown" : "pending" };
  const dispatch: any = { id: ids.dispatch, commandId: ids.command, gatewayId: ids.gateway,
    kind: options.statusCheck ? "status_check" : "dimming", verificationAttempt: options.statusCheck ? 1 : null,
    status: "pending", errorCode: null, deliveryMode: "unicast", destinationAddress: null,
    meshControlGroupId: null, meshControlGroupVersion: null, createdAt: startedAt };
  const results: any[] = [{ dispatchId: ids.dispatch, fixtureId: ids.fixture, status: "pending", brightness: null, faultCode: null }];
  const dispatches: any[] = [dispatch];
  const outbox: any = { id: "outbox-1", dispatchId: ids.dispatch, attempts: 0, createdAt: startedAt,
    nextAttemptAt: startedAt, publishedAt: null, deliveryAttemptedAt: null, deadLetteredAt: null,
    leaseExpiresAt: null, lockedBy: null, lockedAt: null,
    topic: `sites/${ids.site}/gateways/${ids.gateway}/commands/${options.statusCheck ? "status-check" : "dimming"}`,
    payload: options.statusCheck ? { ...identity, originalCommandId: ids.command, targetFixtureIds: [ids.fixture],
      expectedBrightness: 65, verificationAttempt: 1, requestedAt: startedAt.toISOString() } : draft };
  const outboxes = [outbox];
  const events = new Map<unknown, unknown>();
  const unlockedMutations: string[] = [];
  let resultWrites = 0;
  const writeCalls = { results: 0, command: 0 };
  let activeTransactions = 0;
  const client = (context: { locked: boolean }) => {
    const mutation = (name: string) => { if (!context.locked) unlockedMutations.push(name); };
    const table = (name: string, rows: any[]) => ({
      findUnique: async ({ where }: any) => rows.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where = {} }: any = {}) => rows.filter((row) => matches(name === "outbox" ? { ...row, dispatch } : row, where)),
      count: async ({ where }: any) => rows.filter((row) => matches(name === "outbox" ? { ...row, dispatch } : row, where)).length,
      updateMany: async ({ where, data }: any) => {
        mutation(name);
        if (name === "results" || name === "command") writeCalls[name] += 1;
        if (options.loseAttemptFence && name === "outbox" && data.deliveryAttemptedAt) return { count: 0 };
        const selected = rows.filter((row) => matches(name === "outbox" ? { ...row, dispatch } : row, where));
        selected.forEach((row) => Object.assign(row, structuredClone(data)));
        if (name === "results") resultWrites += selected.length;
        return { count: selected.length };
      },
      create: async ({ data }: any) => { mutation(name); const row = { id: randomUUID(), status: "pending", ...data }; rows.push(row); return row; },
      createMany: async ({ data }: any) => { mutation(name); rows.push(...data); return { count: data.length }; }
    });
    const tx: any = {
      $executeRaw: async () => { context.locked = true; return 1; },
      $queryRaw: async (query: any, ...parameters: any[]) => {
        const sql = Array.isArray(query) ? query.join("") : query.text;
        const values = Array.isArray(query) ? parameters : query.values;
        if (sql.includes('FROM "Site"')) return [{ id: ids.site }];
        if (sql.includes('FROM "MqttOutbox"')) {
          mutation("claim-row-lock");
          return outboxes.filter((row) => row.publishedAt === null && row.deadLetteredAt === null && row.dispatchId !== null
            && (!sql.includes('dispatch."kind"') || values.includes(dispatch.kind))
            && row.nextAttemptAt <= now && (row.leaseExpiresAt === null || row.leaseExpiresAt <= now)).map(({ id }) => ({ id }));
        }
        if (sql.includes('INSERT INTO "ProcessedGatewayEvent"')) {
          mutation("event-ledger");
          const [eventId, gatewayId, eventType, payloadHash] = values;
          if (events.has(eventId)) return [];
          events.set(eventId, { eventId, gatewayId, eventType, payloadHash }); return [{ eventId }];
        }
        if (sql.includes('FROM "CommandFixtureResult"')) return results.filter((row) => row.dispatchId === values[0]);
        if (sql.includes('FROM "CommandDispatch" AS d') && sql.includes('FOR UPDATE OF d')) {
          return dispatches.filter((row) => row.id === values[0] && row.commandId === values[1]
            && row.gatewayId === values[2] && command.siteId === values[3]
            && row.kind === "dimming" && ["pending", "published", "accepted"].includes(row.status))
            .map((row) => ({ id: row.id }));
        }
        if (sql.includes('FROM "CommandDispatch"')) return dispatches.filter((row) => row.id === values[0] || row.commandId === values[0])
          .map((row) => ({ ...row, outcome: command.outcome, brightness: command.brightness }));
        if (sql.includes('FROM "Command"')) return [command];
        throw new Error(`unsupported test query: ${sql}`);
      },
      command: table("command", [command]), commandDispatch: table("dispatch", dispatches),
      commandFixtureResult: table("results", results), mqttOutbox: table("outbox", outboxes),
      processedGatewayEvent: { findUnique: async ({ where }: any) => events.get(where.eventId) },
      gatewayRecommissionJob: { findFirst: async () => null },
      gateway: { update: async () => ({ id: ids.gateway, siteId: ids.site, nextCommandSequence: 2n }) },
      fixture: { findMany: async () => [{ id: ids.fixture, floorId, name: "Light", status: "online",
        meshNode: { gatewayId: ids.gateway, gateway: { lastHeartbeatAt: new Date() } } }] },
      floor: { findMany: async () => [{ id: floorId }] },
      monitoringActivity: { createMany: async () => ({ count: 1 }) }
    };
    tx.command.findUnique = async ({ where }: any) => where.id === ids.command ? { ...command, dispatches } : null;
    tx.commandDispatch.findMany = async ({ where = {} }: any = {}) => dispatches.filter((row) => matches(row, where))
      .map((row) => ({ ...row, command, fixtureResults: results.filter((result) => result.dispatchId === row.id) }));
    tx.mqttOutbox.findMany = async ({ where }: any) => outboxes.filter((row) => matches({ ...row, dispatch }, where))
      .map((row) => ({ ...structuredClone(row), dispatch: { ...dispatch } }));
    return tx;
  };
  const prisma: any = client({ locked: false });
  prisma.$transaction = async (operation: (tx: any) => Promise<unknown>) => {
    activeTransactions += 1;
    try { return await operation(client({ locked: false })); }
    finally { activeTransactions -= 1; }
  };
  const snapshot = new AutomationSnapshotService(new AutomationClock());
  const access = { assert: async () => undefined, assertControlInTransaction: async () => undefined };
  const clock = { now: () => now };
  const mqtt = { publishTopic: jest.fn<Promise<void>, any[]>().mockRejectedValue(new Error("PUBACK lost after broker accepted Set")) };
  const payload = (status = "succeeded", items = [{ fixtureId: ids.fixture, status: "succeeded", brightness: 65 }]) => ({
    ...identity, eventId: randomUUID(), status, results: items, occurredAt: now.toISOString()
  });
  const ingest = (ack: unknown) => new MqttService(prisma, {} as never).handleMessage(
    `sites/${ids.site}/gateways/${ids.gateway}/acks/device-status`, Buffer.from(JSON.stringify(ack))
  );
  return { command, dispatch, dispatches, results, outbox, mqtt, unlockedMutations, payload, ingest,
    writeCalls: () => ({ ...writeCalls }), activeTransactions: () => activeTransactions,
    ack: (status?: string, items?: any[]) => ingest(payload(status, items)),
    now: () => now, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, resultWrites: () => resultWrites,
    publisher: () => options.statusCheck
      ? new LegacyStatusCheckPublisherService(prisma, mqtt as never, { workerId: randomUUID(), random: () => 0, clock: () => now })
      : new OutboxPublisherService(prisma, mqtt as never, { workerId: randomUUID(), random: () => 0, clock: () => now }),
    timeout: new CommandTimeoutService(prisma, snapshot),
    verification: new CommandVerificationService(prisma, access as never, snapshot, clock),
    // The optional digest is supplied by the in-flight activity projection; the
    // committed service version ignores this extra test-harness dependency.
    commands: new (CommandsService as unknown as new (...args: any[]) => CommandsService)(
      prisma, new CommandDispatchService(), access as never, {} as never, snapshot, clock, new CommandSafetyDigest()) };
}

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === "OR") return value.some((branch: any) => matches(row, branch));
    if (key === "AND") return value.every((branch: any) => matches(row, branch));
    const actual = row[key];
    if (value && typeof value === "object" && !(value instanceof Date)) {
      return Object.entries(value).every(([operator, expected]: [string, any]) => {
        if (operator === "in") return expected.includes(actual);
        if (operator === "equals") return isDeepStrictEqual(
          JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected))
        );
        if (operator === "not") return actual !== expected;
        if (operator === "gt") return actual != null && actual > expected;
        if (operator === "gte") return actual != null && actual >= expected;
        if (operator === "lt") return actual != null && actual < expected;
        if (operator === "lte") return actual != null && actual <= expected;
        return matches(actual ?? {}, { [operator]: expected });
      });
    }
    return value instanceof Date ? actual?.getTime() === value.getTime() : actual === value;
  });
}

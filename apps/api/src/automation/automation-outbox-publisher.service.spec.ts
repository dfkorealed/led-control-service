import { AutomationOutboxPublisherService } from "./automation-outbox-publisher.service";

const NOW = new Date("2026-08-30T02:00:00.000Z");
const SITE_ID = "00000000-0000-4000-8000-000000000001";
const GATEWAY_ID = "00000000-0000-4000-8000-000000000002";

describe("AutomationOutboxPublisherService", () => {
  it("claims config and application ACK variants with disjoint SKIP LOCKED leases", async () => {
    const configTx = claimTx(configRecord());
    const ackTx = claimTx(ackRecord());
    const transactions = [configTx, ackTx];
    const prisma = {
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(transactions.shift()))
    };
    const service = new AutomationOutboxPublisherService(prisma as never, {} as never, {
      workerId: "automation-worker",
      clock: () => NOW
    });

    await expect(service.claimConfigBatch(NOW)).resolves.toEqual([configRecord({ lockedBy: "automation-worker" })]);
    await expect(service.claimApplicationAckBatch(NOW)).resolves.toEqual([ackRecord({ lockedBy: "automation-worker" })]);

    const configSql = configTx.$queryRaw.mock.calls[0][0].strings.join(" ");
    expect(configSql).toContain('"dispatchId" IS NULL');
    expect(configSql).toContain('"applicationAckKey" IS NULL');
    expect(configSql).toContain('"revision" IS NOT NULL');
    expect(configSql).toContain('"supersededAt" IS NULL');
    expect(configSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(configTx.$executeRaw.mock.calls[0][0].strings.join(" ")).toContain('desired."desiredRevision" > outbox."revision"');

    const ackSql = ackTx.$queryRaw.mock.calls[0][0].strings.join(" ");
    expect(ackSql).toContain('"dispatchId" IS NULL');
    expect(ackSql).toContain('"applicationAckKey" IS NOT NULL');
    expect(ackSql).toContain('"revision" IS NULL');
    expect(ackSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(configTx.mqttOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        lockedBy: "automation-worker",
        lockedAt: NOW,
        leaseExpiresAt: new Date("2026-08-30T02:00:30.000Z")
      }
    }));
    expect(ackTx.mqttOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lockedBy: "automation-worker" })
    }));
  });

  it("publishes the exact stored topic and payload with QoS 1 timeout and no command expiry", async () => {
    const record = ackRecord();
    const prisma = publishPrisma();
    const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) };
    const service = new AutomationOutboxPublisherService(prisma as never, mqtt as never, {
      workerId: "automation-worker",
      clock: () => NOW
    });

    await service.publishClaimed(record as never);

    expect(mqtt.publishTopic).toHaveBeenCalledWith(record.topic, record.payload, {
      messageExpiryInterval: null,
      timeoutMs: 10_000
    });
    expect(mqtt.publishTopic.mock.calls[0][1]).toBe(record.payload);
    const successUpdate = prisma.mqttOutbox.updateMany.mock.calls.at(-1)?.[0];
    expect(successUpdate.where).toMatchObject({
      id: record.id,
      lockedBy: "automation-worker",
      publishedAt: null,
      deadLetteredAt: null,
      supersededAt: null,
      leaseExpiresAt: { gt: NOW }
    });
    expect(successUpdate.data).not.toHaveProperty("payload");
    expect(successUpdate.data).not.toHaveProperty("payloadHash");
  });

  it("does not publish after lease ownership is lost", async () => {
    const prisma = publishPrisma({ renewCount: 0 });
    const mqtt = { publishTopic: jest.fn() };
    const service = new AutomationOutboxPublisherService(prisma as never, mqtt as never, {
      workerId: "automation-worker",
      clock: () => NOW
    });

    await service.publishClaimed(ackRecord() as never);

    expect(mqtt.publishTopic).not.toHaveBeenCalled();
  });

  it("supersedes a claimed stale config before publish and retains its stored snapshot", async () => {
    const record = configRecord();
    const prisma = publishPrisma({ supersededCount: 1 });
    const mqtt = { publishTopic: jest.fn() };
    const service = new AutomationOutboxPublisherService(prisma as never, mqtt as never, {
      workerId: "automation-worker",
      clock: () => NOW
    });

    await service.publishClaimed(record as never);

    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    const supersedeSql = prisma.$executeRaw.mock.calls[0][0];
    expect(supersedeSql.strings.join(" ")).toContain('desired."desiredRevision" > outbox."revision"');
    expect(supersedeSql.values).toEqual(expect.arrayContaining([record.id, "automation-worker", NOW]));
  });

  it("retries config indefinitely with capped backoff instead of command deadletter behavior", async () => {
    const record = configRecord({
      attempts: 99,
      createdAt: new Date("2026-08-01T00:00:00.000Z")
    });
    const prisma = publishPrisma();
    const mqtt = { publishTopic: jest.fn().mockRejectedValue(new Error("broker unavailable")) };
    const service = new AutomationOutboxPublisherService(prisma as never, mqtt as never, {
      workerId: "automation-worker",
      random: () => 0,
      clock: () => NOW
    });

    await service.publishClaimed(record as never);

    const retry = prisma.mqttOutbox.updateMany.mock.calls.at(-1)?.[0];
    expect(retry.data).toMatchObject({
      attempts: 100,
      nextAttemptAt: new Date("2026-08-30T02:01:00.000Z"),
      lastError: "mqtt_publish_failed",
      lockedBy: null,
      leaseExpiresAt: null
    });
    expect(retry.data).not.toHaveProperty("deadLetteredAt");
    expect(prisma.commandDispatch).toBeUndefined();
  });

  it("moves an exhausted application ACK to retained deadletter without touching command state", async () => {
    const record = ackRecord({ attempts: 9 });
    const prisma = publishPrisma();
    const mqtt = { publishTopic: jest.fn().mockRejectedValue(new Error("private payload detail")) };
    const service = new AutomationOutboxPublisherService(prisma as never, mqtt as never, {
      workerId: "automation-worker",
      random: () => 0,
      clock: () => NOW
    });

    await service.publishClaimed(record as never);

    const deadletter = prisma.mqttOutbox.updateMany.mock.calls.at(-1)?.[0];
    expect(deadletter.data).toMatchObject({
      attempts: 10,
      deadLetteredAt: NOW,
      lastError: "mqtt_publish_failed",
      lockedBy: null,
      leaseExpiresAt: null
    });
    expect(deadletter.data).not.toHaveProperty("payload");
    expect(deadletter.data).not.toHaveProperty("payloadHash");
    expect(JSON.stringify(deadletter)).not.toContain("private payload detail");
    expect(prisma.commandDispatch).toBeUndefined();
  });

  it("uses jittered exponential ACK retry before the finite terminal threshold", async () => {
    const record = ackRecord({ attempts: 2 });
    const prisma = publishPrisma();
    const mqtt = { publishTopic: jest.fn().mockRejectedValue(new Error("offline")) };
    const service = new AutomationOutboxPublisherService(prisma as never, mqtt as never, {
      workerId: "automation-worker",
      random: () => 0.5,
      clock: () => NOW
    });

    await service.publishClaimed(record as never);

    expect(prisma.mqttOutbox.updateMany.mock.calls.at(-1)?.[0].data).toMatchObject({
      attempts: 3,
      nextAttemptAt: new Date("2026-08-30T02:00:04.400Z")
    });
    expect(prisma.mqttOutbox.updateMany.mock.calls.at(-1)?.[0].data).not.toHaveProperty("deadLetteredAt");
  });

  it("waits for the active publish and starts no later row after shutdown begins", async () => {
    jest.useFakeTimers();
    const active = deferred<void>();
    const service = new AutomationOutboxPublisherService({} as never, {} as never, {
      workerId: "automation-worker",
      pollMs: 1_000,
      drainTimeoutMs: 15_000
    });
    jest.spyOn(service, "claimConfigBatch").mockResolvedValue([
      configRecord({ id: "config-1" }),
      configRecord({ id: "config-2" })
    ] as never);
    jest.spyOn(service, "claimApplicationAckBatch").mockResolvedValue([]);
    const publish = jest.spyOn(service, "publishClaimed")
      .mockReturnValueOnce(active.promise)
      .mockResolvedValue(undefined);

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(publish).toHaveBeenCalledTimes(1);

      let drained = false;
      const stopping = service.stopAndDrain().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);

      active.resolve();
      await stopping;
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      active.resolve();
      await service.stopAndDrain();
      jest.useRealTimers();
    }
  });
});

function claimTx(record: ReturnType<typeof configRecord> | ReturnType<typeof ackRecord>) {
  return {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([{ id: record.id }]),
    mqttOutbox: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([{ ...record, lockedBy: "automation-worker" }])
    }
  };
}

function publishPrisma(options: { renewCount?: number; supersededCount?: number } = {}) {
  const mqttOutbox = {
    updateMany: jest.fn()
      .mockResolvedValueOnce({ count: options.renewCount ?? 1 })
      .mockResolvedValue({ count: 1 }),
    count: jest.fn().mockResolvedValue(1)
  };
  const prisma: any = {
    mqttOutbox,
    $executeRaw: jest.fn().mockResolvedValue(options.supersededCount ?? 0)
  };
  return prisma;
}

function configRecord(overrides: Record<string, unknown> = {}) {
  const payload = { schemaVersion: 1, gatewayId: GATEWAY_ID, revision: 4, stored: "snapshot" };
  return {
    id: "config-outbox",
    dispatchId: null,
    gatewayId: GATEWAY_ID,
    applicationAckKey: null,
    revision: 4,
    payloadHash: `sha256:${"a".repeat(64)}`,
    topic: `sites/${SITE_ID}/gateways/${GATEWAY_ID}/commands/automation/config-sync`,
    payload,
    attempts: 0,
    createdAt: new Date("2026-08-30T01:59:00.000Z"),
    ...overrides
  };
}

function ackRecord(overrides: Record<string, unknown> = {}) {
  const payload = {
    schemaVersion: 1,
    gatewayId: GATEWAY_ID,
    eventId: "00000000-0000-4000-8000-000000000003",
    sequence: 9,
    reportPayloadHash: `sha256:${"b".repeat(64)}`,
    ingestedAt: "2026-08-30T01:59:00.000Z"
  };
  return {
    id: "ack-outbox",
    dispatchId: null,
    gatewayId: GATEWAY_ID,
    applicationAckKey: `automation-execution:${GATEWAY_ID}:event:9:${payload.reportPayloadHash}`,
    revision: null,
    payloadHash: `sha256:${"c".repeat(64)}`,
    topic: `sites/${SITE_ID}/gateways/${GATEWAY_ID}/acks/automation/execution-ingested`,
    payload,
    attempts: 0,
    createdAt: new Date("2026-08-30T01:59:00.000Z"),
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

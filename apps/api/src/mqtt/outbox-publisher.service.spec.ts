import { Logger } from "@nestjs/common";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { LegacyStatusCheckPublisherService } from "./legacy-status-check-publisher.service";
import { CommandTimeoutService } from "../commands/command-timeout.service";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { AutomationClock } from "../automation/automation-clock";

const dimmingPayload = {
  commandId: "11111111-1111-4111-8111-111111111111",
  dispatchId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "33333333-3333-4333-8333-333333333333",
  sequence: 1,
  siteId: "44444444-4444-4444-8444-444444444444",
  gatewayId: "55555555-5555-4555-8555-555555555555",
  targetType: "fixture",
  targetId: "66666666-6666-4666-8666-666666666666",
  targetFixtureIds: ["66666666-6666-4666-8666-666666666666"],
  deliveryMode: "unicast",
  brightness: 65,
  requestedAt: "2026-07-11T00:00:00.000Z"
};
const historicalDimmingPayload = {
  ...dimmingPayload,
  requestedBy: "77777777-7777-4777-8777-777777777777"
};
const deliveryGeneration = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const meshControlGroupId = "88888888-8888-4888-8888-888888888888";
const meshDimmingPayload = {
  ...dimmingPayload,
  targetType: "floor",
  targetId: "99999999-9999-4999-8999-999999999999",
  targetFixtureIds: [
    "66666666-6666-4666-8666-666666666666",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  ],
  deliveryMode: "mesh_group",
  destinationAddress: "0xc000",
  meshControlGroupId,
  meshControlGroupVersion: 3
};

const meshDispatch = {
  commandId: "command-1",
  gatewayId: meshDimmingPayload.gatewayId,
  deliveryMode: "mesh_group",
  destinationAddress: "0xc000",
  meshControlGroupId,
  meshControlGroupVersion: 3
};

function meshRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "outbox-1",
    dispatchId: meshDimmingPayload.dispatchId,
    topic: `sites/${meshDimmingPayload.siteId}/gateways/${meshDimmingPayload.gatewayId}/commands/dimming`,
    payload: meshDimmingPayload,
    attempts: 0,
    createdAt: new Date("2026-07-11T00:00:00.000Z"),
    dispatch: meshDispatch,
    ...overrides
  };
}

describe("OutboxPublisherService", () => {
  afterEach(() => {
    delete process.env.COMMAND_RETENTION_PUBLISH_CUTOFF;
    delete process.env.COMMAND_RETENTION_PUBLISH_FENCE;
    delete process.env.COMMAND_SET_EGRESS_ENABLED;
  });

  it("claims only dimming dispatches, leaving legacy Get rows for their own lease", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      mqttOutbox: { updateMany: jest.fn() }
    };
    const prisma: any = { $transaction: jest.fn((work: (client: any) => Promise<unknown>) => work(tx)) };
    const snapshot = { lockMutation: jest.fn().mockResolvedValue(undefined) };
    const publisher = new OutboxPublisherService(prisma, {} as never, { workerId: "set-worker" }, snapshot as never);

    await expect(publisher.claimBatch(new Date("2026-07-11T00:01:00.000Z"))).resolves.toEqual([]);

    const query = tx.$queryRaw.mock.calls[0][0];
    expect(query.strings.join(" ")).toContain('dispatch."kind" =');
    expect(query.values).toContain("dimming");
    expect(tx.mqttOutbox.updateMany).not.toHaveBeenCalled();
  });

  it("never prepares a status-check row handed to the Set publisher", async () => {
    const prisma: any = { $transaction: jest.fn(), mqttOutbox: { count: jest.fn() } };
    const mqtt = { publishTopic: jest.fn() };
    const publisher = new OutboxPublisherService(prisma, mqtt as never, { workerId: "set-worker" });
    await publisher.publishClaimed({ ...meshRecord(), dispatch: { ...meshDispatch, kind: "status_check" } } as never);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
  });

  it("never prepares a Set row whose topic points to Get or another site", async () => {
    const prisma: any = { $transaction: jest.fn(), mqttOutbox: { count: jest.fn() } };
    const mqtt = { publishTopic: jest.fn() };
    const publisher = new OutboxPublisherService(prisma, mqtt as never, { workerId: "set-worker" });
    await publisher.publishClaimed({ ...meshRecord(), topic:
      `sites/${dimmingPayload.siteId}/gateways/${dimmingPayload.gatewayId}/commands/status-check` } as never);
    await publisher.publishClaimed({ ...meshRecord(), topic:
      `sites/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/gateways/${dimmingPayload.gatewayId}/commands/dimming` } as never);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
  });

  it("does not prepare Set after its own worker is stopped", async () => {
    const prisma: any = { $transaction: jest.fn(), mqttOutbox: { count: jest.fn() } };
    const mqtt = { publishTopic: jest.fn() };
    const set = new OutboxPublisherService(prisma, mqtt as never, { workerId: "set-worker" });
    await set.stopAndDrain();

    await set.publishClaimed(meshRecord() as never);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
  });

  it("holds the shared DB permit through MQTT completion and releases it before terminal state writes", async () => {
    process.env.COMMAND_RETENTION_PUBLISH_CUTOFF = "1";
    process.env.COMMAND_RETENTION_PUBLISH_FENCE = "1";
    process.env.COMMAND_SET_EGRESS_ENABLED = "1";
    const now = new Date("2026-07-11T00:01:00.000Z");
    const inFlight = deferred<void>();
    let permitHeld = false;
    let publishStarted = false;
    const order: string[] = [];
    const prisma: any = {
      $executeRaw: jest.fn().mockImplementation(async (sql: { strings?: string[] }) => {
        if (sql.strings?.join("").includes("pg_advisory_xact_lock_shared")) {
          permitHeld = true;
          order.push("permit");
        }
        return 1;
      }),
      $queryRaw: jest.fn().mockResolvedValue([{ now }]),
      command: { findUnique: jest.fn().mockResolvedValue({ createdAt: new Date("2026-07-10T00:00:00.000Z") }) },
      mqttOutbox: {
        count: jest.fn().mockResolvedValue(1),
        findUnique: jest.fn().mockResolvedValue({
          id: "outbox-1", dispatchId: meshDimmingPayload.dispatchId,
          lockedBy: "fenced-worker", publishedAt: null, deadLetteredAt: null,
          deliveryAttemptedAt: now,
          leaseExpiresAt: new Date("2026-07-11T00:01:30.000Z"), payload: { ...dimmingPayload,
            deliveryGeneration, deliveryGeneratedAt: now.toISOString(), deliveryWindowMs: 10_000,
            expiresAt: "2026-07-11T00:01:10.000Z", publishEpoch: 7 }
        }),
        updateMany: jest.fn().mockImplementation(async ({ data }: any) => {
          if (data.publishedAt) order.push("published-state");
          return { count: 1 };
        })
      },
      gatewayRecommissionJob: { count: jest.fn().mockResolvedValue(0) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => {
      try { return await callback(prisma); }
      finally { permitHeld = false; order.push("transaction-end"); }
    });
    const mqtt = { publishTopic: jest.fn(async () => {
      publishStarted = true;
      expect(permitHeld).toBe(true);
      order.push("mqtt");
      await inFlight.promise;
    }) };
    const epoch = epochDependencies(prisma, now);
    const egress = { assertPublisherIdentity: jest.fn(), publish: jest.fn((_generation, _topic, _payload, authorize) =>
      authorize((expiry: number) => { expect(expiry).toBe(8); return mqtt.publishTopic(); })) };
    const publisher = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "fenced-worker", clock: () => now, deliveryGeneration: () => deliveryGeneration
    }, undefined, egress as never, epoch.epochs as never, epoch.health as never);
    const publishing = publisher.publishClaimed({ ...meshRecord(), payload: dimmingPayload,
      dispatch: { ...meshDispatch, kind: "dimming" } } as never);
    try {
      for (let i = 0; i < 100 && !publishStarted; i++) await Promise.resolve();
      expect(publishStarted).toBe(true);
      expect(permitHeld).toBe(true);
    } finally {
      inFlight.resolve();
      await publishing;
    }
    expect(order.indexOf("permit")).toBeLessThan(order.indexOf("mqtt"));
    expect(order.indexOf("mqtt")).toBeLessThan(order.indexOf("transaction-end", order.indexOf("mqtt")));
    expect(order.indexOf("transaction-end", order.indexOf("mqtt"))).toBeLessThan(order.indexOf("published-state"));
    expect(egress.publish).toHaveBeenCalledWith(7, expect.any(String), expect.objectContaining({ publishEpoch: 7 }), expect.any(Function));
  });

  it("uses DB time inside the permit to block a Set that crossed the UTC cutoff after attempt commit", async () => {
    process.env.COMMAND_RETENTION_PUBLISH_CUTOFF = "1";
    process.env.COMMAND_RETENTION_PUBLISH_FENCE = "1";
    process.env.COMMAND_SET_EGRESS_ENABLED = "1";
    const appNow = new Date("2026-05-31T11:59:59.999Z");
    const dbNow = new Date("2026-05-31T12:00:00.001Z");
    const command = { createdAt: new Date("2026-02-28T12:00:00.000Z"), outcome: null };
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ now: dbNow }]),
      command: { findUnique: jest.fn().mockResolvedValue(command), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      mqttOutbox: { count: jest.fn().mockResolvedValue(1),
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: appNow }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      gatewayRecommissionJob: { count: jest.fn().mockResolvedValue(0) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const epoch = epochDependencies(prisma, dbNow);
    epoch.health.assertHealthy.mockResolvedValueOnce(appNow).mockResolvedValueOnce(appNow).mockResolvedValueOnce(appNow);
    const publisher = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "fenced-worker", clock: () => appNow, deliveryGeneration: () => deliveryGeneration
    }, undefined, { assertPublisherIdentity: jest.fn(), publish: jest.fn((_generation, _topic, _payload, authorize) =>
      authorize(mqtt.publishTopic)) } as never, epoch.epochs as never, epoch.health as never);
    await publisher.publishClaimed({ ...meshRecord(), payload: dimmingPayload,
      dispatch: { ...meshDispatch, kind: "dimming" } } as never);
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: "COMMAND_DELIVERY_EXPIRED" })
    }));
  });

  it.each(["reclaimed", "recommissioning"])("does not report a %s outbox as published", async (reason) => {
    process.env.COMMAND_RETENTION_PUBLISH_CUTOFF = "1";
    process.env.COMMAND_RETENTION_PUBLISH_FENCE = "1";
    process.env.COMMAND_SET_EGRESS_ENABLED = "1";
    const now = new Date("2026-07-11T00:01:00.000Z");
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ now }]),
      command: { findUnique: jest.fn().mockResolvedValue({ createdAt: new Date("2026-07-10T00:00:00.000Z") }) },
      mqttOutbox: {
        count: jest.fn().mockResolvedValue(1),
        findUnique: jest.fn().mockResolvedValue({
          dispatchId: meshDimmingPayload.dispatchId,
          lockedBy: reason === "reclaimed" ? "other-worker" : "fenced-worker",
          publishedAt: null, deadLetteredAt: null, deliveryAttemptedAt: now,
          leaseExpiresAt: new Date("2026-07-11T00:01:30.000Z"),
          payload: { ...dimmingPayload, deliveryGeneration, deliveryGeneratedAt: now.toISOString(),
            deliveryWindowMs: 10_000, expiresAt: "2026-07-11T00:01:10.000Z", publishEpoch: 7 }
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      gatewayRecommissionJob: { count: jest.fn().mockResolvedValue(reason === "recommissioning" ? 1 : 0) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const epoch = epochDependencies(prisma, now);
    const egress = { assertPublisherIdentity: jest.fn(), publish: jest.fn((_generation, _topic, _payload, authorize) =>
      authorize(mqtt.publishTopic)) };
    const publisher = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "fenced-worker", clock: () => now, deliveryGeneration: () => deliveryGeneration
    }, undefined, egress as never, epoch.epochs as never, epoch.health as never);
    await publisher.publishClaimed({ ...meshRecord(), payload: dimmingPayload,
      dispatch: { ...meshDispatch, kind: "dimming" } } as never);
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(egress.publish).toHaveBeenCalledTimes(1);
    expect(prisma.mqttOutbox.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ publishedAt: expect.any(Date) })
    }));
  });

  it("never creates a fresh delivery generation for a >3-month Set draft after restart", async () => {
    process.env.COMMAND_RETENTION_PUBLISH_CUTOFF = "1";
    const oldCommand = { outcome: null, createdAt: new Date("2026-02-28T11:59:59.999Z") };
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      command: { findUnique: jest.fn().mockResolvedValue(oldCommand), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      mqttOutbox: { findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const generate = jest.fn(() => deliveryGeneration);
    const publisher = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "retention-worker", clock: () => new Date("2026-05-31T12:00:00.000Z"), deliveryGeneration: generate
    });
    await publisher.publishClaimed({ ...meshRecord(), dispatch: { ...meshDispatch, kind: "dimming" }, payload: dimmingPayload } as never);
    expect(generate).not.toHaveBeenCalled();
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: "COMMAND_DELIVERY_EXPIRED", status: "failed" })
    }));
  });

  it("blocks Set after attempt commit crosses the UTC cutoff before the first MQTT send", async () => {
    process.env.COMMAND_RETENTION_PUBLISH_CUTOFF = "1";
    let now = new Date("2026-05-31T11:59:59.999Z");
    const boundaryCommand = { outcome: null, createdAt: new Date("2026-02-28T12:00:00.000Z") };
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      command: { findUnique: jest.fn().mockResolvedValue(boundaryCommand), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      mqttOutbox: { findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: now }),
        count: jest.fn().mockResolvedValue(1),
        updateMany: jest.fn(async ({ data }: any) => {
          if (data.deliveryAttemptedAt) now = new Date("2026-05-31T12:00:00.001Z");
          return { count: 1 };
        }) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const publisher = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "cutoff-worker", clock: () => now, deliveryGeneration: () => deliveryGeneration
    });
    await publisher.publishClaimed({ ...meshRecord(), dispatch: { ...meshDispatch, kind: "dimming" }, payload: dimmingPayload } as never);
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: "COMMAND_DELIVERY_EXPIRED" })
    }));
  });

  it.each([
    { restartAt: "2026-07-11T00:01:03.200Z", remainingTtl: 6 },
    { restartAt: "2026-07-11T00:01:10.000Z", remainingTtl: 0 }
  ])("preserves a legacy published deadline after PUBACK loss and restart at $restartAt", async ({ restartAt, remainingTtl }) => {
    const originalDelivery = {
      deliveryGeneration,
      deliveryGeneratedAt: "2026-07-11T00:01:00.000Z",
      deliveryWindowMs: 10_000,
      expiresAt: "2026-07-11T00:01:10.000Z"
    };
    // The previous publisher durably wrote this generation before sending MQTT;
    // its PUBACK was lost, so a new process claims the still-unpublished row.
    let durablePayload = {
      ...historicalDimmingPayload, ...originalDelivery,
      overrideUntil: "2026-07-11T01:00:00.000Z", overrideRemainingMs: 3_540_000
    } as Record<string, unknown>;
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mqttOutbox: {
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: new Date(originalDelivery.deliveryGeneratedAt) }),
        updateMany: jest.fn(async ({ data }) => {
          if (data.payload) durablePayload = structuredClone(data.payload);
          return { count: 1 };
        }),
        count: jest.fn().mockResolvedValue(1)
      },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      command: { findUnique: jest.fn().mockResolvedValue({ outcome: "pending" }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback) => callback(prisma));
    const expectedPayload = { ...dimmingPayload, ...originalDelivery };
    const mqtt = { publishTopic: jest.fn(async (_topic, payload) => {
      expect(durablePayload).toEqual(expectedPayload);
      expect(payload).toEqual(expectedPayload);
    }) };
    const newGeneration = jest.fn(() => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const restarted = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "restarted-worker", clock: () => new Date(restartAt), deliveryGeneration: newGeneration
    });
    await restarted.publishClaimed({
      id: "outbox-1", dispatchId: "dispatch-1", topic: `sites/${dimmingPayload.siteId}/gateways/${dimmingPayload.gatewayId}/commands/dimming`,
      payload: durablePayload, attempts: 1, createdAt: new Date("2026-07-11T00:00:00.000Z"),
      dispatch: { commandId: "command-1" }
    } as never);

    expect(durablePayload).toEqual(expectedPayload);
    expect(newGeneration).not.toHaveBeenCalled();
    if (remainingTtl > 0) {
      expect(mqtt.publishTopic).toHaveBeenCalledWith(expect.any(String), expectedPayload, {
        messageExpiryInterval: remainingTtl, timeoutMs: 20_000
      });
    } else {
      expect(mqtt.publishTopic).not.toHaveBeenCalled();
      expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: "timed_out", errorCode: "COMMAND_DELIVERY_EXPIRED" })
      }));
      expect(prisma.command.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ outcome: "unknown" })
      }));
    }
  });

  it("prepares status-check without dimming guards and reuses an explicitly supplied persisted generation", async () => {
    let now = new Date("2026-07-11T00:01:00.000Z");
    const draft = {
      commandId: dimmingPayload.commandId, dispatchId: dimmingPayload.dispatchId,
      siteId: dimmingPayload.siteId, gatewayId: dimmingPayload.gatewayId,
      idempotencyKey: dimmingPayload.idempotencyKey, sequence: 2,
      originalCommandId: dimmingPayload.commandId, targetFixtureIds: dimmingPayload.targetFixtureIds,
      expectedBrightness: 65, verificationAttempt: 1, requestedAt: dimmingPayload.requestedAt
    };
    const stored = { payload: draft as Record<string, unknown>, attempts: 0 };
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mqttOutbox: {
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }),
        updateMany: jest.fn().mockImplementation(({ data }) => {
          if (data.payload) stored.payload = structuredClone(data.payload);
          if (typeof data.attempts === "number") stored.attempts = data.attempts;
          return Promise.resolve({ count: 1 });
        }),
        count: jest.fn().mockResolvedValue(1)
      },
      meshControlGroup: { findUnique: jest.fn().mockRejectedValue(new Error("must not load a dimming snapshot")) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      command: { findUnique: jest.fn().mockResolvedValue({ outcome: "pending" }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockImplementationOnce(async (_topic, payload) => {
      expect(stored.payload).toEqual(payload);
      throw new Error("simulated PUBACK loss");
    }).mockResolvedValue(undefined) };
    const service = new LegacyStatusCheckPublisherService(prisma, mqtt as never, {
      workerId: "worker-1", random: () => 0, clock: () => now, deliveryGeneration: () => deliveryGeneration
    });
    const record = {
      ...meshRecord(),
      topic: `sites/${draft.siteId}/gateways/${draft.gatewayId}/commands/status-check`,
      // A status check of an old mesh command must not require its current group snapshot.
      dispatch: { ...meshDispatch, kind: "status_check" as const }
    };
    await service.publishClaimed({ ...record, payload: stored.payload } as never);
    const published = {
      ...draft, deliveryGeneration, deliveryGeneratedAt: "2026-07-11T00:01:00.000Z",
      deliveryWindowMs: 10_000, expiresAt: "2026-07-11T00:01:10.000Z"
    };
    expect(stored.payload).toEqual(published);
    expect(mqtt.publishTopic).toHaveBeenNthCalledWith(1, record.topic, published, { messageExpiryInterval: 10, timeoutMs: 20_000 });
    now = new Date("2026-07-11T00:01:03.200Z");
    await service.publishClaimed({ ...record, payload: stored.payload, attempts: stored.attempts } as never);
    expect(mqtt.publishTopic).toHaveBeenNthCalledWith(2, record.topic, published, { messageExpiryInterval: 6, timeoutMs: 20_000 });
    expect(prisma.meshControlGroup.findUnique).not.toHaveBeenCalled();

    expect(prisma.command.updateMany).not.toHaveBeenCalled();
  });

  it("contains an initial claim failure, recovers on the next tick, and stops after destroy", async () => {
    jest.useFakeTimers();
    const unhandledRejection = jest.fn();
    const loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation();
    process.on("unhandledRejection", unhandledRejection);
    const service = new OutboxPublisherService({} as never, {} as never, { workerId: "command-outbox-worker", pollMs: 1_000 });
    const claimBatch = jest.spyOn(service, "claimBatch")
      .mockRejectedValueOnce(Object.assign(new Error("payload-secret"), { code: "P2028" }))
      .mockResolvedValue([]);

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);

      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("worker=command-outbox-worker, error=P2028"));
      expect(loggerError.mock.calls.flat().join(" ")).not.toContain("payload-secret");

      await jest.advanceTimersByTimeAsync(1_000);
      expect(claimBatch).toHaveBeenCalledTimes(2);

      const stopping = service.stopAndDrain();
      expect(service.stopAndDrain()).toBe(stopping);
      await stopping;
      await jest.advanceTimersByTimeAsync(2_000);
      expect(claimBatch).toHaveBeenCalledTimes(2);
    } finally {
      await service.stopAndDrain();
      process.off("unhandledRejection", unhandledRejection);
      loggerError.mockRestore();
      jest.useRealTimers();
    }
  });

  it("redacts untrusted error codes, names, and messages from scheduler logs", async () => {
    jest.useFakeTimers();
    const loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation();
    const service = new OutboxPublisherService({} as never, {} as never, { workerId: "command-outbox-worker", pollMs: 1_000 });
    jest.spyOn(service, "claimBatch")
      .mockRejectedValueOnce(Object.assign(new Error("message-secret"), {
        code: "P2028-code-secret",
        name: "name-secret-with-code"
      }))
      .mockRejectedValueOnce(Object.assign(new Error("other-message-secret"), { name: "name-secret-without-code" }));

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(1_000);

      expect(loggerError).toHaveBeenNthCalledWith(1, expect.stringContaining("error=UNEXPECTED_ERROR"));
      expect(loggerError).toHaveBeenNthCalledWith(2, expect.stringContaining("error=UNEXPECTED_ERROR"));
      const logs = loggerError.mock.calls.flat().join(" ");
      expect(logs).not.toContain("P2028-code-secret");
      expect(logs).not.toContain("name-secret");
      expect(logs).not.toContain("message-secret");
    } finally {
      await service.stopAndDrain();
      loggerError.mockRestore();
      jest.useRealTimers();
    }
  });

  it("does not overlap a slow scheduled claim", async () => {
    jest.useFakeTimers();
    const pendingClaim = deferred<[]>();
    const service = new OutboxPublisherService({} as never, {} as never, { workerId: "command-outbox-worker", pollMs: 1_000 });
    const claimBatch = jest.spyOn(service, "claimBatch")
      .mockReturnValueOnce(pendingClaim.promise)
      .mockResolvedValue([]);

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(3_000);
      expect(claimBatch).toHaveBeenCalledTimes(1);

      pendingClaim.resolve([]);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(claimBatch).toHaveBeenCalledTimes(2);
    } finally {
      pendingClaim.resolve([]);
      await service.stopAndDrain();
      jest.useRealTimers();
    }
  });

  it("waits for an in-flight publish on destroy without starting another publish", async () => {
    jest.useFakeTimers();
    const activePublish = deferred<void>();
    const service = new OutboxPublisherService({} as never, {} as never, { workerId: "command-outbox-worker", pollMs: 1_000 });
    const claimBatch = jest.spyOn(service, "claimBatch").mockResolvedValue([
      meshRecord({ id: "outbox-1" }),
      meshRecord({ id: "outbox-2" })
    ] as never);
    const publishClaimed = jest.spyOn(service, "publishClaimed")
      .mockReturnValueOnce(activePublish.promise)
      .mockResolvedValue(undefined);
    let destroyCompleted = false;

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(publishClaimed).toHaveBeenCalledTimes(1);

      const destroying = service.stopAndDrain().then(() => { destroyCompleted = true; });
      await Promise.resolve();
      const completedBeforeRelease = destroyCompleted;
      await jest.advanceTimersByTimeAsync(3_000);

      activePublish.resolve();
      await destroying;
      await jest.advanceTimersByTimeAsync(0);

      expect({
        completedBeforeRelease,
        claimCalls: claimBatch.mock.calls.length,
        publishCalls: publishClaimed.mock.calls.length
      }).toEqual({ completedBeforeRelease: false, claimCalls: 1, publishCalls: 1 });
    } finally {
      activePublish.resolve();
      await service.stopAndDrain();
      jest.useRealTimers();
    }
  });

  it("durably fixes one wire generation before publish and retries the exact payload with remaining MQTT TTL", async () => {
    let now = new Date("2026-07-11T00:01:00.000Z");
    const stored = {
      payload: { ...dimmingPayload, expiresAt: "2026-07-11T00:00:10.000Z" } as Record<string, unknown>,
      attempts: 0
    };
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mqttOutbox: {
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }),
        updateMany: jest.fn().mockImplementation(({ data }) => {
          if (data.payload) stored.payload = structuredClone(data.payload);
          if (typeof data.attempts === "number") stored.attempts = data.attempts;
          return Promise.resolve({ count: 1 });
        }),
        count: jest.fn().mockResolvedValue(1)
      },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = {
      publishTopic: jest.fn()
        .mockImplementationOnce(async (_topic, payload) => {
          expect(stored.payload).toEqual(payload);
          throw new Error("simulated PUBACK loss");
        })
        .mockResolvedValueOnce(undefined)
    };
    const service = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      random: () => 0,
      clock: () => now,
      deliveryGeneration: () => deliveryGeneration
    } as never);
    const baseRecord = {
      id: "outbox-1",
      dispatchId: "dispatch-1",
      topic: `sites/${dimmingPayload.siteId}/gateways/${dimmingPayload.gatewayId}/commands/dimming`,
      attempts: 0,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      dispatch: { commandId: "command-1" }
    };

    await service.publishClaimed({ ...baseRecord, payload: stored.payload } as never);
    const preparedPayload = structuredClone(stored.payload);
    expect(preparedPayload).toEqual({
      ...dimmingPayload,
      deliveryGeneration,
      deliveryGeneratedAt: "2026-07-11T00:01:00.000Z",
      deliveryWindowMs: 10_000,
      expiresAt: "2026-07-11T00:01:10.000Z"
    });

    now = new Date("2026-07-11T00:01:03.200Z");
    await service.publishClaimed({
      ...baseRecord,
      payload: stored.payload,
      attempts: stored.attempts
    } as never);

    expect(mqtt.publishTopic).toHaveBeenCalledTimes(2);
    expect(mqtt.publishTopic.mock.calls[1][1]).toEqual(preparedPayload);
    expect(mqtt.publishTopic.mock.calls[1][2]).toEqual({ messageExpiryInterval: 6, timeoutMs: 20_000 });
    expect(stored.payload).toEqual(preparedPayload);
  });

  it("publishes a delayed legacy timed command without carrying its override expiry forward", async () => {
    const now = new Date("2026-07-11T00:02:00.000Z");
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mqttOutbox: {
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1)
      },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      command: {
        findUnique: jest.fn().mockResolvedValue({ outcome: "pending" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const service = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => now
    });

    await service.publishClaimed({
      id: "outbox-1",
      dispatchId: "dispatch-1",
      topic: `sites/${dimmingPayload.siteId}/gateways/${dimmingPayload.gatewayId}/commands/dimming`,
      payload: { ...dimmingPayload, overrideUntil: "2026-07-11T00:01:00.000Z" },
      attempts: 0,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      dispatch: { commandId: "command-1" }
    } as never);

    expect(mqtt.publishTopic).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.objectContaining({ overrideUntil: expect.anything(), overrideRemainingMs: expect.anything() }),
      { messageExpiryInterval: 10, timeoutMs: 20_000 }
    );
  });

  it("replaces a legacy near-expiry payload with a fixed ten-second delivery generation", async () => {
    const now = new Date("2026-07-11T00:01:00.000Z");
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mqttOutbox: {
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1)
      },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    let durablePayload: unknown;
    const mqtt = {
      publishTopic: jest.fn().mockImplementation(async (_topic, payload) => {
        expect(durablePayload).toEqual(payload);
      })
    };
    prisma.mqttOutbox.updateMany.mockImplementation(({ data }: { data: { payload?: unknown } }) => {
      if (data.payload) durablePayload = structuredClone(data.payload);
      return Promise.resolve({ count: 1 });
    });
    const service = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => now,
      deliveryGeneration: () => deliveryGeneration
    } as never);

    await service.publishClaimed({
      id: "outbox-1",
      dispatchId: "dispatch-1",
      topic: `sites/${dimmingPayload.siteId}/gateways/${dimmingPayload.gatewayId}/commands/dimming`,
      payload: {
        ...dimmingPayload,
        overrideUntil: "2026-07-11T00:01:03.500Z",
        // Round 2 publishers used publish + 10s even when the override ended sooner.
        expiresAt: "2026-07-11T00:01:10.000Z"
      },
      attempts: 0,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      dispatch: { commandId: "command-1" }
    } as never);

    expect(mqtt.publishTopic).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        deliveryGeneration,
        deliveryGeneratedAt: "2026-07-11T00:01:00.000Z",
        deliveryWindowMs: 10_000,
        expiresAt: "2026-07-11T00:01:10.000Z"
      }),
      { messageExpiryInterval: 10, timeoutMs: 20_000 }
    );
    expect(mqtt.publishTopic.mock.calls[0][1]).not.toHaveProperty("overrideUntil");
    expect(mqtt.publishTopic.mock.calls[0][1]).not.toHaveProperty("overrideRemainingMs");
  });

  it("retries a legacy timed command after its former override expiry", async () => {
    let now = new Date("2026-07-11T00:01:00.000Z");
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mqttOutbox: {
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1)
      },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      command: { findUnique: jest.fn().mockResolvedValue({ outcome: "pending" }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockRejectedValue(new Error("PUBACK unavailable")) };
    const service = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      random: () => 0,
      clock: () => now
    });
    const record = {
      id: "outbox-1",
      dispatchId: "dispatch-1",
      topic: `sites/${dimmingPayload.siteId}/gateways/${dimmingPayload.gatewayId}/commands/dimming`,
      payload: { ...dimmingPayload, overrideUntil: "2026-07-11T00:01:05.000Z" },
      attempts: 0,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      dispatch: { commandId: "command-1" }
    };

    await service.publishClaimed(record as never);
    now = new Date("2026-07-11T00:01:06.000Z");
    await service.publishClaimed({ ...record, attempts: 1 } as never);

    expect(mqtt.publishTopic).toHaveBeenCalledTimes(2);
    expect(prisma.commandDispatch.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: "MANUAL_OVERRIDE_EXPIRED" })
    }));
  });

  it("rejects a stored payload with arbitrary keys instead of treating it as a retryable full payload", async () => {
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mqttOutbox: { findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const service = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => new Date("2026-07-11T00:01:00.000Z")
    } as never);

    await service.publishClaimed({
      id: "outbox-1",
      dispatchId: "dispatch-1",
      topic: `sites/${dimmingPayload.siteId}/gateways/${dimmingPayload.gatewayId}/commands/dimming`,
      payload: {
        ...dimmingPayload,
        expiresAt: "2026-07-11T00:01:10.000Z",
        arbitraryLegacyKey: true
      },
      attempts: 0,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      dispatch: { commandId: "command-1" }
    } as never);

    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastError: expect.stringContaining("arbitraryLegacyKey") })
    }));
  });

  it("uses a fresh clock after snapshot validation and refuses an already expired lease", async () => {
    const beforeSnapshot = new Date("2026-07-11T00:01:00.000Z");
    const afterSnapshot = new Date("2026-07-11T00:01:31.000Z");
    let current = beforeSnapshot;
    const existingLeaseExpiresAt = new Date("2026-07-11T00:01:30.000Z");
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      meshControlGroup: {
        findUnique: jest.fn().mockImplementation(async () => {
          current = afterSnapshot;
          return {
            gatewayId: meshDimmingPayload.gatewayId,
            groupAddress: "0xc000",
            configurationVersion: 3,
            status: "ready"
          };
        })
      },
      mqttOutbox: {
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }),
        updateMany: jest.fn().mockImplementation(({ where }) => Promise.resolve({
          count: where.leaseExpiresAt && existingLeaseExpiresAt > where.leaseExpiresAt.gt ? 1 : 0
        })),
        count: jest.fn()
      }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const service = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => current
    } as never);

    await service.publishClaimed(meshRecord() as never);

    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ leaseExpiresAt: { gt: afterSnapshot } })
    }));
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
  });

  it("rechecks worker ownership and lease immediately before MQTT publish", async () => {
    const now = new Date("2026-07-11T00:01:00.000Z");
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mqttOutbox: {
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0)
      }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const service = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => now
    } as never);

    await service.publishClaimed({
      id: "outbox-1",
      dispatchId: "dispatch-1",
      topic: `sites/${dimmingPayload.siteId}/gateways/${dimmingPayload.gatewayId}/commands/dimming`,
      payload: dimmingPayload,
      attempts: 0,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      dispatch: { commandId: "command-1" }
    } as never);

    expect(prisma.mqttOutbox.count).toHaveBeenCalledWith({
      where: {
        id: "outbox-1",
        dispatch: { kind: "dimming" },
        lockedBy: "worker-1",
        publishedAt: null,
        deadLetteredAt: null
      }
    });
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
  });

  it.each([
    ["leaves less time than the publish timeout", "2026-07-11T00:01:11.000Z"],
    ["returns after the lease expires", "2026-07-11T00:01:31.000Z"]
  ])("does not publish when the final ownership query %s", async (_caseName, fenceReturnedAt) => {
    const preparedAt = new Date("2026-07-11T00:01:00.000Z");
    let current = preparedAt;
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mqttOutbox: {
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockImplementation(async () => {
          current = new Date(fenceReturnedAt);
          return 1;
        })
      },
      commandDispatch: { updateMany: jest.fn() }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) };
    const service = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => current
    });

    await service.publishClaimed({
      id: "outbox-1",
      dispatchId: "dispatch-1",
      topic: `sites/${dimmingPayload.siteId}/gateways/${dimmingPayload.gatewayId}/commands/dimming`,
      payload: dimmingPayload,
      attempts: 0,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      dispatch: { commandId: "command-1" }
    } as never);

    expect(prisma.mqttOutbox.count).toHaveBeenCalledTimes(1);
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
  });

  it("claims rows under a worker lease before publishing", async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ id: "outbox-1" }]),
      mqttOutbox: {
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ id: "outbox-1", lockedBy: "worker-1" }])
      }
    };
    const prisma = { $transaction: jest.fn(async (callback: (value: any) => Promise<unknown>) => callback(tx)) };
    const service = new OutboxPublisherService(prisma as never, {} as never, { workerId: "worker-1" });
    const now = new Date("2026-07-11T00:00:00.000Z");

    await expect(service.claimBatch(now)).resolves.toEqual([{ id: "outbox-1", lockedBy: "worker-1" }]);
    expect(tx.$queryRaw.mock.calls[0][0].strings.join(" ")).toContain('"dispatchId" IS NOT NULL');
    expect(tx.mqttOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["outbox-1"] }, dispatch: { kind: "dimming" }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      data: { lockedBy: "worker-1", lockedAt: now, leaseExpiresAt: new Date("2026-07-11T00:00:30.000Z") }
    });
    expect(tx.mqttOutbox.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: {
        dispatch: {
          select: {
            commandId: true,
            kind: true,
            gatewayId: true,
            deliveryMode: true,
            destinationAddress: true,
            meshControlGroupId: true,
            meshControlGroupVersion: true
          }
        }
      }
    }));
  });

  it("moves an exhausted attempted publish to dead-letter with a timed-out dispatch", async () => {
    let attemptedAt: Date | null = null;
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mqttOutbox: {
        findUnique: jest.fn(async () => ({ deliveryAttemptedAt: attemptedAt })),
        updateMany: jest.fn(async ({ data }) => {
          if (data.deliveryAttemptedAt) attemptedAt = data.deliveryAttemptedAt;
          return { count: 1 };
        }),
        count: jest.fn().mockResolvedValue(1)
      },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      command: { findUnique: jest.fn().mockResolvedValue({ outcome: "pending" }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockRejectedValue(new Error("broker unavailable")) };
    const service = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      random: () => 0,
      clock: () => new Date("2026-07-11T00:01:00.000Z")
    });
    const record = {
      id: "outbox-1",
      dispatchId: "dispatch-1",
      topic: `sites/${dimmingPayload.siteId}/gateways/${dimmingPayload.gatewayId}/commands/dimming`,
      payload: dimmingPayload,
      attempts: 9,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      dispatch: { commandId: "command-1" }
    };

    await service.publishClaimed(record as never);

    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: "outbox-1", dispatch: { kind: "dimming" }, lockedBy: "worker-1", publishedAt: null, deadLetteredAt: null },
      data: expect.objectContaining({ attempts: 10, deadLetteredAt: new Date("2026-07-11T00:01:00.000Z"), lockedBy: null })
    });
    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith({
      where: { id: "dispatch-1", status: { in: ["pending", "published", "accepted"] } },
      data: { status: "timed_out", completedAt: new Date("2026-07-11T00:01:00.000Z"), errorCode: "MQTT_DEAD_LETTER", errorMessage: "broker unavailable" }
    });
  });

  it("scrubs a historical requester while durably creating the publish generation", async () => {
    const preparedAt = new Date("2026-07-11T00:01:00.000Z");
    const fenceReturnedAt = new Date("2026-07-11T00:01:05.000Z");
    const publishedAt = new Date("2026-07-11T00:01:06.000Z");
    let current = preparedAt;
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mqttOutbox: {
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockImplementation(async () => {
          current = fenceReturnedAt;
          return 1;
        })
      },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = {
      publishTopic: jest.fn().mockImplementation(async () => {
        current = publishedAt;
      })
    };
    const service = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => current,
      deliveryGeneration: () => deliveryGeneration
    } as never);
    const record = {
      id: "outbox-1",
      dispatchId: "dispatch-1",
      topic: "sites/44444444-4444-4444-8444-444444444444/gateways/55555555-5555-4555-8555-555555555555/commands/dimming",
      payload: historicalDimmingPayload,
      attempts: 0,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      dispatch: { commandId: "command-1" }
    };
    await service.publishClaimed(record as never);

    const expectedPayload = {
      ...dimmingPayload,
      deliveryGeneration,
      deliveryGeneratedAt: "2026-07-11T00:01:00.000Z",
      deliveryWindowMs: 10_000,
      expiresAt: "2026-07-11T00:01:10.000Z"
    };
    expect(prisma.mqttOutbox.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: "outbox-1",
        dispatch: { kind: "dimming" },
        lockedBy: "worker-1",
        publishedAt: null,
        deadLetteredAt: null,
        leaseExpiresAt: { gt: preparedAt }
      },
      data: { leaseExpiresAt: new Date("2026-07-11T00:01:30.000Z"), payload: expectedPayload }
    });
    expect(mqtt.publishTopic).toHaveBeenCalledWith(record.topic, expectedPayload, {
      messageExpiryInterval: 5,
      timeoutMs: 20_000
    });
    expect(prisma.mqttOutbox.updateMany).toHaveBeenLastCalledWith({
      where: { id: "outbox-1", dispatch: { kind: "dimming" }, lockedBy: "worker-1", publishedAt: null, deadLetteredAt: null },
      data: {
        payload: expectedPayload,
        publishedAt,
        lastError: null,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null
      }
    });
  });

  it("does not publish when its lease expired before payload preparation", async () => {
    const now = new Date("2026-07-11T00:01:00.000Z");
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mqttOutbox: { findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }), updateMany: jest.fn().mockResolvedValue({ count: 0 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const service = new OutboxPublisherService(prisma, mqtt as never, { workerId: "worker-1", clock: () => now });
    const record = {
      id: "outbox-1",
      dispatchId: "dispatch-1",
      topic: `sites/${dimmingPayload.siteId}/gateways/${dimmingPayload.gatewayId}/commands/dimming`,
      payload: dimmingPayload,
      attempts: 0,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      dispatch: { commandId: "command-1" }
    };

    await service.publishClaimed(record as never);

    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ leaseExpiresAt: { gt: now } })
    }));
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
  });

  it("keeps a valid publisher lease while a publish promise is pending so timeout skips the dispatch", async () => {
    const publishNow = new Date("2026-07-11T00:16:00.000Z");
    const timeoutNow = new Date("2026-07-11T00:16:10.000Z");
    const publishStarted = deferred<void>();
    const releasePublish = deferred<void>();
    let activeLeaseExpiresAt: Date | null = null;
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      meshControlGroup: { findUnique: jest.fn() },
      mqttOutbox: {
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          if (data.leaseExpiresAt) activeLeaseExpiresAt = data.leaseExpiresAt;
          if (where.OR) {
            return Promise.resolve({ count: activeLeaseExpiresAt! > timeoutNow ? 0 : 1 });
          }
          return Promise.resolve({ count: 1 });
        }),
        count: jest.fn().mockResolvedValue(1)
      },
      commandDispatch: {
        findMany: jest.fn().mockResolvedValue([
          { id: dimmingPayload.dispatchId, commandId: dimmingPayload.commandId, status: "pending" }
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      commandFixtureResult: { updateMany: jest.fn() },
      command: { findUnique: jest.fn().mockResolvedValue({ outcome: "pending" }), updateMany: jest.fn() }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = {
      publishTopic: jest.fn().mockImplementation(async () => {
        publishStarted.resolve();
        await releasePublish.promise;
      })
    };
    const publisher = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => publishNow
    });
    const record = {
      id: "outbox-1",
      dispatchId: dimmingPayload.dispatchId,
      topic: `sites/${dimmingPayload.siteId}/gateways/${dimmingPayload.gatewayId}/commands/dimming`,
      payload: dimmingPayload,
      attempts: 0,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      dispatch: { commandId: dimmingPayload.commandId }
    };

    const publishing = publisher.publishClaimed(record as never);
    await publishStarted.promise;
    await expect(new CommandTimeoutService(prisma, new AutomationSnapshotService(new AutomationClock())).closeExpired(
      timeoutNow
    )).resolves.toEqual({ timedOut: 0 });

    releasePublish.resolve();
    await publishing;
    expect(prisma.commandFixtureResult.updateMany).not.toHaveBeenCalled();
  });

  it("publishes a mesh command only when its ready group snapshot still matches", async () => {
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      meshControlGroup: {
        findUnique: jest.fn().mockResolvedValue({
          gatewayId: meshDimmingPayload.gatewayId,
          groupAddress: "0xc000",
          configurationVersion: 3,
          status: "ready"
        })
      },
      mqttOutbox: {
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1)
      },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) };
    const service = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => new Date("2026-07-11T00:01:00.000Z")
    });

    await service.publishClaimed(meshRecord() as never);

    expect(prisma.meshControlGroup.findUnique).toHaveBeenCalledWith({
      where: { id: meshControlGroupId },
      select: { gatewayId: true, groupAddress: true, configurationVersion: true, status: true }
    });
    expect(mqtt.publishTopic).toHaveBeenCalledTimes(1);
  });

  it("retries without publishing while the same mesh group version is configuring", async () => {
    const now = new Date("2026-07-11T00:01:00.000Z");
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      meshControlGroup: {
        findUnique: jest.fn().mockResolvedValue({
          gatewayId: meshDimmingPayload.gatewayId,
          groupAddress: "0xc000",
          configurationVersion: 3,
          status: "configuring"
        })
      },
      mqttOutbox: { findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const mqtt = { publishTopic: jest.fn() };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      random: () => 0,
      clock: () => now
    });

    await service.publishClaimed(meshRecord() as never);

    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: "outbox-1", dispatch: { kind: "dimming" }, lockedBy: "worker-1", publishedAt: null, deadLetteredAt: null },
      data: expect.objectContaining({
        attempts: 1,
        nextAttemptAt: new Date("2026-07-11T00:01:01.000Z"),
        lastError: "mesh control group configuration is not ready"
      })
    });
  });

  it.each([
    ["missing", null],
    ["version mismatch", {
      gatewayId: meshDimmingPayload.gatewayId,
      groupAddress: "0xc000",
      configurationVersion: 4,
      status: "ready"
    }],
    ["address mismatch", {
      gatewayId: meshDimmingPayload.gatewayId,
      groupAddress: "0xc001",
      configurationVersion: 3,
      status: "ready"
    }],
    ["gateway mismatch", {
      gatewayId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      groupAddress: "0xc000",
      configurationVersion: 3,
      status: "ready"
    }],
    ["failed", {
      gatewayId: meshDimmingPayload.gatewayId,
      groupAddress: "0xc000",
      configurationVersion: 3,
      status: "failed"
    }]
  ])("fails a stale mesh command immediately for %s", async (_caseName, currentGroup) => {
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      meshControlGroup: { findUnique: jest.fn().mockResolvedValue(currentGroup) },
      mqttOutbox: { findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      command: { findUnique: jest.fn().mockResolvedValue({ outcome: "pending" }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const now = new Date("2026-07-11T00:01:00.000Z");
    const service = new OutboxPublisherService(prisma, mqtt as never, { workerId: "worker-1", clock: () => now });

    await service.publishClaimed(meshRecord() as never);

    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith({
      where: { id: meshDimmingPayload.dispatchId, status: { in: ["pending", "published", "accepted"] } },
      data: expect.objectContaining({
        status: "failed",
        completedAt: now,
        errorCode: "MESH_GROUP_STALE"
      })
    });
    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: "outbox-1", dispatch: { kind: "dimming" }, lockedBy: "worker-1", publishedAt: null, deadLetteredAt: null },
      data: expect.objectContaining({ attempts: 1, deadLetteredAt: now })
    });
  });

  it("fails a mesh command when its persisted dispatch snapshot differs from the payload", async () => {
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      meshControlGroup: { findUnique: jest.fn() },
      mqttOutbox: { findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      command: { findUnique: jest.fn().mockResolvedValue({ outcome: "pending" }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const service = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => new Date("2026-07-11T00:01:00.000Z")
    });

    await service.publishClaimed(meshRecord({
      dispatch: { ...meshDispatch, meshControlGroupVersion: 2 }
    }) as never);

    expect(prisma.meshControlGroup.findUnique).not.toHaveBeenCalled();
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: "MESH_GROUP_STALE" })
    }));
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((value) => { resolve = value; });
  return { promise, resolve };
}

function sequenceClock(...values: Date[]) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function epochDependencies(prisma: any, now: Date) {
  prisma.commandPublishMember = { findFirst: jest.fn().mockResolvedValue({ generation: 7, workerId: "fenced-worker" }) };
  prisma.commandPublishAttempt = { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue({ generation: 7 }) };
  prisma.mqttOutbox.findFirst = jest.fn(async () => ({ payload: { ...dimmingPayload, publishEpoch: 7,
    deliveryGeneration, deliveryGeneratedAt: "2026-07-11T00:01:00.000Z", deliveryWindowMs: 10_000,
    expiresAt: "2026-07-11T00:01:10.000Z" } }));
  // Match the durable prepare write, independently of later DB-clock observations.
  const originalUpdate = prisma.mqttOutbox.updateMany.getMockImplementation();
  prisma.mqttOutbox.updateMany.mockImplementation(async (args: any) => {
    if (args.data.payload) prisma.mqttOutbox.findFirst.mockResolvedValue({ payload: args.data.payload });
    return originalUpdate ? originalUpdate(args) : { count: 1 };
  });
  return { epochs: { currentForSet: jest.fn().mockResolvedValue(7) }, health: { assertHealthy: jest.fn().mockResolvedValue(now) } };
}

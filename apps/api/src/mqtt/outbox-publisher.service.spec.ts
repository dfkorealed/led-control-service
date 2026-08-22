import { OutboxPublisherService } from "./outbox-publisher.service";

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
  requestedBy: "77777777-7777-4777-8777-777777777777",
  requestedAt: "2026-07-11T00:00:00.000Z"
};

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
  it("claims rows under a worker lease before publishing", async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "outbox-1" }]),
      mqttOutbox: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ id: "outbox-1", lockedBy: "worker-1" }])
      }
    };
    const prisma = { $transaction: jest.fn(async (callback: (value: any) => Promise<unknown>) => callback(tx)) };
    const service = new OutboxPublisherService(prisma as never, {} as never, { workerId: "worker-1" });
    const now = new Date("2026-07-11T00:00:00.000Z");

    await expect(service.claimBatch(now)).resolves.toEqual([{ id: "outbox-1", lockedBy: "worker-1" }]);
    expect(tx.mqttOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["outbox-1"] }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      data: { lockedBy: "worker-1", lockedAt: now, leaseExpiresAt: new Date("2026-07-11T00:00:30.000Z") }
    });
    expect(tx.mqttOutbox.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: {
        dispatch: {
          select: {
            commandId: true,
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

  it("moves an exhausted record to dead-letter and fails its dispatch", async () => {
    const prisma: any = {
      mqttOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      command: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockRejectedValue(new Error("broker unavailable")) };
    const service = new OutboxPublisherService(prisma, mqtt as never, { workerId: "worker-1", random: () => 0 });
    const record = {
      id: "outbox-1",
      dispatchId: "dispatch-1",
      topic: "sites/s/gateways/g/commands/dimming",
      payload: dimmingPayload,
      attempts: 9,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      dispatch: { commandId: "command-1" }
    };

    await service.publishClaimed(record as never, new Date("2026-07-11T00:01:00.000Z"));

    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: "outbox-1", lockedBy: "worker-1", publishedAt: null },
      data: expect.objectContaining({ attempts: 10, deadLetteredAt: new Date("2026-07-11T00:01:00.000Z"), lockedBy: null })
    });
    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith({
      where: { id: "dispatch-1", status: { in: ["pending", "published"] } },
      data: { status: "failed", completedAt: new Date("2026-07-11T00:01:00.000Z"), errorCode: "MQTT_DEAD_LETTER", errorMessage: "broker unavailable" }
    });
  });

  it("persists a publish-relative expiry before publishing with the matching MQTT expiry", async () => {
    const prisma: any = {
      mqttOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) };
    const service = new OutboxPublisherService(prisma, mqtt as never, { workerId: "worker-1" });
    const record = {
      id: "outbox-1",
      dispatchId: "dispatch-1",
      topic: "sites/44444444-4444-4444-8444-444444444444/gateways/55555555-5555-4555-8555-555555555555/commands/dimming",
      payload: dimmingPayload,
      attempts: 0,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      dispatch: { commandId: "command-1" }
    };
    const publishedAt = new Date("2026-07-11T00:01:00.000Z");

    await service.publishClaimed(record as never, publishedAt);

    const expectedPayload = { ...dimmingPayload, expiresAt: "2026-07-11T00:01:10.000Z" };
    expect(prisma.mqttOutbox.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "outbox-1", lockedBy: "worker-1", publishedAt: null, deadLetteredAt: null },
      data: { payload: expectedPayload }
    });
    expect(mqtt.publishTopic).toHaveBeenCalledWith(record.topic, expectedPayload, { messageExpiryInterval: 10 });
  });

  it("publishes a mesh command only when its ready group snapshot still matches", async () => {
    const prisma: any = {
      meshControlGroup: {
        findUnique: jest.fn().mockResolvedValue({
          gatewayId: meshDimmingPayload.gatewayId,
          groupAddress: "0xc000",
          configurationVersion: 3,
          status: "ready"
        })
      },
      mqttOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) };
    const service = new OutboxPublisherService(prisma, mqtt as never, { workerId: "worker-1" });

    await service.publishClaimed(meshRecord() as never, new Date("2026-07-11T00:01:00.000Z"));

    expect(prisma.meshControlGroup.findUnique).toHaveBeenCalledWith({
      where: { id: meshControlGroupId },
      select: { gatewayId: true, groupAddress: true, configurationVersion: true, status: true }
    });
    expect(mqtt.publishTopic).toHaveBeenCalledTimes(1);
  });

  it("retries without publishing while the same mesh group version is configuring", async () => {
    const prisma: any = {
      meshControlGroup: {
        findUnique: jest.fn().mockResolvedValue({
          gatewayId: meshDimmingPayload.gatewayId,
          groupAddress: "0xc000",
          configurationVersion: 3,
          status: "configuring"
        })
      },
      mqttOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const mqtt = { publishTopic: jest.fn() };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      random: () => 0
    });
    const now = new Date("2026-07-11T00:01:00.000Z");

    await service.publishClaimed(meshRecord() as never, now);

    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: "outbox-1", lockedBy: "worker-1", publishedAt: null, deadLetteredAt: null },
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
      meshControlGroup: { findUnique: jest.fn().mockResolvedValue(currentGroup) },
      mqttOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      command: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const service = new OutboxPublisherService(prisma, mqtt as never, { workerId: "worker-1" });
    const now = new Date("2026-07-11T00:01:00.000Z");

    await service.publishClaimed(meshRecord() as never, now);

    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith({
      where: { id: meshDimmingPayload.dispatchId, status: { in: ["pending", "published"] } },
      data: expect.objectContaining({
        status: "failed",
        completedAt: now,
        errorCode: "MESH_GROUP_STALE"
      })
    });
    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: "outbox-1", lockedBy: "worker-1", publishedAt: null },
      data: expect.objectContaining({ attempts: 1, deadLetteredAt: now })
    });
  });

  it("fails a mesh command when its persisted dispatch snapshot differs from the payload", async () => {
    const prisma: any = {
      meshControlGroup: { findUnique: jest.fn() },
      mqttOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      command: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const service = new OutboxPublisherService(prisma, mqtt as never, { workerId: "worker-1" });

    await service.publishClaimed(meshRecord({
      dispatch: { ...meshDispatch, meshControlGroupVersion: 2 }
    }) as never, new Date("2026-07-11T00:01:00.000Z"));

    expect(prisma.meshControlGroup.findUnique).not.toHaveBeenCalled();
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: "MESH_GROUP_STALE" })
    }));
  });
});

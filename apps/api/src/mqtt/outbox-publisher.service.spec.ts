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
});

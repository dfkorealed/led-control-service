import { createGatewayCommandExpiry, gatewayStatusCheckCommandPublishedV2Schema, mqttTopicsV2 } from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { RecoveryOutboxPublisherService } from "./recovery-outbox-publisher.service";
import { CommandPublishQuiesceService } from "./command-publish-quiesce.service";

const now = new Date("2026-09-25T12:00:00.000Z");
const ids = { site: randomUUID(), gateway: randomUUID(), original: randomUUID(), hold: randomUUID(),
  dispatch: randomUUID(), key: randomUUID(), fixture: randomUUID(), outbox: randomUUID() };
const draft = { siteId: ids.site, gatewayId: ids.gateway, commandId: ids.original,
  originalCommandId: ids.original, dispatchId: ids.dispatch, idempotencyKey: ids.key, sequence: 11,
  targetFixtureIds: [ids.fixture], expectedBrightness: 70, verificationAttempt: 1,
  requestedAt: "2026-09-25T11:59:59.000Z" };

function harness() {
  const record = { id: ids.outbox, dispatchId: ids.dispatch,
    topic: mqttTopicsV2.gatewayCommand(ids.site, ids.gateway, "status-check"), payload: draft,
    attempts: 0, createdAt: new Date(now.getTime() - 1000), deliveryAttemptedAt: null,
    dispatch: { id: ids.dispatch, holdId: ids.hold, gatewayId: ids.gateway, status: "pending",
      hold: { id: ids.hold, siteId: ids.site, originalCommandId: ids.original } } };
  const tx: any = {
    recoveryOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    recoveryDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(record.dispatch) },
    unresolvedCommandHold: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
  };
  const prisma: any = { ...tx,
    $transaction: jest.fn(async (work: (client: any) => Promise<unknown>) => work(tx)) };
  const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) };
  const snapshot = { lockMutation: jest.fn().mockResolvedValue(undefined) };
  const service = new (RecoveryOutboxPublisherService as any)(prisma, mqtt, snapshot,
    { workerId: "recovery-worker", clock: () => now, generation: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  return { service, prisma, tx, mqtt, snapshot, record };
}

describe("RecoveryOutboxPublisherService Get-only transport", () => {
  it("keeps parent-free recovery Get available after epoch quiesce with Set fencing enabled", async () => {
    const { service, prisma, tx, mqtt, record } = harness();
    let status = "active";
    tx.$executeRaw = jest.fn(async () => 1);
    tx.commandPublishEpoch = { findFirst: async () => ({ generation: 7, status }),
      update: async ({ data }: any) => { status = data.status; } };
    prisma.commandPublishMember = { findMany: async () => [] };
    const previous = process.env.COMMAND_RETENTION_PUBLISH_FENCE;
    process.env.COMMAND_RETENTION_PUBLISH_FENCE = "1";
    try {
      await new CommandPublishQuiesceService(prisma).begin();
      expect(status).toBe("quiescing");
      await service.publishClaimed(record);
      expect(mqtt.publishTopic).toHaveBeenCalledWith(record.topic,
        expect.objectContaining({ originalCommandId: ids.original }), expect.anything());
      expect(prisma.command).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.COMMAND_RETENTION_PUBLISH_FENCE;
      else process.env.COMMAND_RETENTION_PUBLISH_FENCE = previous;
    }
  });

  it("publishes a strictly parsed Get with 10-second expiry, never querying or writing Command", async () => {
    const { service, prisma, mqtt, record } = harness();
    await service.publishClaimed(record);
    expect(mqtt.publishTopic).toHaveBeenCalledTimes(1);
    const [topic, payload, options] = mqtt.publishTopic.mock.calls[0];
    expect(topic).toBe(record.topic);
    expect(gatewayStatusCheckCommandPublishedV2Schema.parse(payload)).toEqual(payload);
    expect(payload).toMatchObject({ commandId: ids.original, originalCommandId: ids.original,
      targetFixtureIds: [ids.fixture], expectedBrightness: 70 });
    expect(payload).not.toHaveProperty("brightness");
    expect(options).toMatchObject({ messageExpiryInterval: expect.any(Number), timeoutMs: 20_000 });
    expect(prisma.command).toBeUndefined();
  });

  it("does not mint a fresh Get generation for a stale queued request", async () => {
    const { service, mqtt, record, tx } = harness();
    record.createdAt = new Date(now.getTime() - 16 * 60_000);
    await service.publishClaimed(record);
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(tx.recoveryDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "failed", errorCode: "RECOVERY_DELIVERY_EXPIRED" })
    }));
  });

  it("never publishes if the hold disappeared after claim", async () => {
    const { service, tx, mqtt, record } = harness();
    tx.recoveryDispatch.findUnique.mockResolvedValue(null);
    await service.publishClaimed(record);
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
  });

  it("closes a claimed outbox when its dispatch became accepted before publish, preventing endless reclaims", async () => {
    const { service, tx, mqtt, record } = harness();
    tx.recoveryDispatch.findUnique.mockResolvedValue({ ...record.dispatch, status: "accepted" });
    await service.publishClaimed(record);
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(tx.recoveryOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ publishedAt: now, lockedBy: null, leaseExpiresAt: null })
    }));
  });

  it("closes a claimed outbox when acceptance wins after prepare but before MQTT send", async () => {
    const { service, tx, mqtt, record } = harness();
    tx.recoveryDispatch.findUnique.mockResolvedValueOnce(record.dispatch)
      .mockResolvedValue({ ...record.dispatch, status: "accepted" });
    await service.publishClaimed(record);
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(tx.recoveryOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ publishedAt: now, lockedBy: null, leaseExpiresAt: null })
    }));
  });

  it("does not renew an expired prior wire generation after PUBACK uncertainty", async () => {
    const { service, tx, mqtt, record } = harness();
    const { messageExpiryInterval, ...delivery } = createGatewayCommandExpiry(
      new Date(now.getTime() - 11_000), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    record.payload = { ...draft, ...delivery };
    await service.publishClaimed(record);
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(tx.recoveryDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "failed", errorCode: "RECOVERY_DELIVERY_EXPIRED" })
    }));
  });

  it("keeps the same durable Get generation after broker PUBACK loss instead of inventing a Set", async () => {
    const { service, tx, mqtt, record } = harness();
    mqtt.publishTopic.mockRejectedValueOnce(new Error("PUBACK lost"));
    await service.publishClaimed(record);
    expect(mqtt.publishTopic).toHaveBeenCalledTimes(1);
    const prepared = tx.recoveryOutbox.updateMany.mock.calls.find(([arg]: any[]) => arg.data.payload)?.[0].data.payload;
    expect(gatewayStatusCheckCommandPublishedV2Schema.parse(prepared)).toEqual(prepared);
    expect(tx.recoveryOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ attempts: 1, lastError: "RECOVERY_PUBLISH_RETRY" })
    }));
    expect(tx.recoveryDispatch.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "completed" })
    }));
  });
});

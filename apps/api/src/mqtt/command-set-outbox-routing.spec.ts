import { OutboxPublisherService } from "./outbox-publisher.service";
import { LegacyStatusCheckPublisherService } from "./legacy-status-check-publisher.service";

describe("Set egress outbox cutover routing", () => {
  const now = new Date("2026-09-26T00:00:00Z");
  const id = "11111111-1111-4111-8111-111111111111";
  const generation = "22222222-2222-4222-8222-222222222222";
  const originalFlag = process.env.COMMAND_SET_EGRESS_ENABLED;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.COMMAND_SET_EGRESS_ENABLED;
    else process.env.COMMAND_SET_EGRESS_ENABLED = originalFlag;
  });
  it.each([false, true])("preserves legacy status-check Get with Set cutover=%s", async (cutover) => {
    process.env.COMMAND_SET_EGRESS_ENABLED = cutover ? "1" : "0";
    const { publisher, mqtt, set, record } = fixture("status_check");
    await publisher.publishClaimed(record);
    expect(mqtt.publishTopic).toHaveBeenCalledTimes(1);
    expect(set.publish).not.toHaveBeenCalled();
  });
  it("preserves legacy Set while the cutover remains OFF", async () => {
    process.env.COMMAND_SET_EGRESS_ENABLED = "0";
    const { publisher, mqtt, record } = fixture("dimming");
    await publisher.publishClaimed(record);
    expect(mqtt.publishTopic).toHaveBeenCalledTimes(1);
  });
  it("never falls back to shared MQTT for legacy wire when cutover is ON", async () => {
    process.env.COMMAND_SET_EGRESS_ENABLED = "1";
    const { publisher, mqtt, set, record, prisma } = fixture("dimming");
    await publisher.publishClaimed(record);
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(set.publish).not.toHaveBeenCalled();
    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastError: expect.stringMatching(/epoch/) })
    }));
  });
  function fixture(kind: "dimming" | "status_check") {
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mqttOutbox: { count: jest.fn().mockResolvedValue(1), updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ deliveryAttemptedAt: null }) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn((work) => work(prisma));
    const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) }, set = { publish: jest.fn() };
    const Owner = kind === "dimming" ? OutboxPublisherService : LegacyStatusCheckPublisherService;
    const publisher = new Owner(prisma, mqtt as never, { clock: () => now, workerId: "worker",
      deliveryGeneration: () => generation }, { lockMutation: jest.fn() } as never, set as never);
    const payload = { commandId: id, dispatchId: id, idempotencyKey: id, sequence: 1, siteId: id, gatewayId: id,
      targetFixtureIds: [id], requestedAt: now.toISOString(), ...(kind === "dimming"
        ? { targetType: "fixture", targetId: id, deliveryMode: "unicast", brightness: 50 }
        : { originalCommandId: id, expectedBrightness: 50, verificationAttempt: 1 }) };
    const record: any = { id, dispatchId: id, payload, attempts: 0, createdAt: now,
      topic: `sites/${id}/gateways/${id}/commands/${kind === "dimming" ? "dimming" : "status-check"}`,
      dispatch: { commandId: id, kind, gatewayId: id, deliveryMode: "unicast", destinationAddress: null,
        meshControlGroupId: null, meshControlGroupVersion: null } };
    prisma.$queryRaw = jest.fn((query: { text: string; values: string[] }) => {
      expect(query.text).toContain("FOR UPDATE OF d");
      expect(query.values).toEqual([record.dispatchId, record.dispatch.commandId,
        record.dispatch.gatewayId, record.payload.siteId]);
      return [{ id: record.dispatchId }];
    });
    return { publisher, mqtt, set, record, prisma };
  }
});

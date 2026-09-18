import { Logger } from "@nestjs/common";
import { mqttTopicsV2 } from "@led-control/shared";
import { MonitoringRefreshOutboxService } from "./monitoring-refresh-outbox.service";

const siteId = "11111111-1111-4111-8111-111111111111";
const gatewayId = "22222222-2222-4222-8222-222222222222";
const refreshId = "33333333-3333-4333-8333-333333333333";
const batchId = "44444444-4444-4444-8444-444444444444";
const fixtureId = "55555555-5555-4555-8555-555555555555";
const idempotencyKey = "66666666-6666-4666-8666-666666666666";
const startedAt = new Date("2026-09-15T08:00:00.000Z");
const deadlineAt = new Date("2026-09-15T08:00:30.000Z");

const payload = {
  refreshId,
  batchId,
  idempotencyKey,
  sequence: 1,
  siteId,
  gatewayId,
  targetFixtureIds: [fixtureId],
  requestedAt: startedAt.toISOString(),
  expiresAt: deadlineAt.toISOString()
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "outbox-1",
    monitoringRefreshBatchId: batchId,
    topic: mqttTopicsV2.fixturePresenceCheck(siteId, gatewayId),
    payload,
    attempts: 0,
    createdAt: startedAt,
    deliveryAttemptedAt: null,
    batch: { id: batchId, refreshId, status: "pending" },
    ...overrides
  };
}

function harness(clock = () => startedAt) {
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    mqttOutbox: {
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([])
    },
    monitoringRefreshBatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    monitoringRefreshFixture: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([{ status: "unverified", _count: { _all: 1 } }])
    },
    monitoringRefresh: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
  };
  prisma.$transaction = jest.fn((callback) => callback(prisma));
  const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) };
  const service = new MonitoringRefreshOutboxService(prisma, mqtt as never, {
    workerId: "monitoring-refresh-worker",
    random: () => 0,
    clock,
    pollMs: 1_000
  });
  return { service, prisma, mqtt };
}

describe("MonitoringRefreshOutboxService", () => {
  it("publishes only monitoring refresh rows with a bounded MQTT expiry and records PUBACK", async () => {
    const { service, prisma, mqtt } = harness();
    jest.spyOn(service, "claimBatch").mockResolvedValue([record()] as never);

    await service.runScheduledBatch();

    expect(mqtt.publishTopic).toHaveBeenCalledWith(
      mqttTopicsV2.fixturePresenceCheck(siteId, gatewayId),
      expect.objectContaining({ refreshId, batchId, expiresAt: deadlineAt.toISOString() }),
      { messageExpiryInterval: 30, timeoutMs: 20_000 }
    );
    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ publishedAt: startedAt, lockedBy: null })
    }));
    expect(prisma.monitoringRefreshBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "published", publishedAt: startedAt }
    }));
  });

  it("retries with bounded backoff and stores only a sanitized failure code", async () => {
    const { service, prisma, mqtt } = harness();
    mqtt.publishTopic.mockRejectedValue(new Error("broker-password-secret"));

    await service.publishClaimed(record() as never);

    expect(prisma.mqttOutbox.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        attempts: 1,
        nextAttemptAt: new Date("2026-09-15T08:00:01.000Z"),
        lastError: "mqtt_publish_failed",
        lockedBy: null
      })
    }));
    expect(JSON.stringify(prisma.mqttOutbox.updateMany.mock.calls)).not.toContain("broker-password-secret");
  });

  it("dead-letters exhausted delivery as unverified without mutating Fixture", async () => {
    const { service, prisma, mqtt } = harness();
    mqtt.publishTopic.mockRejectedValue(new Error("native-usb-secret"));

    await service.publishClaimed(record({ attempts: 2 }) as never);

    expect(prisma.monitoringRefreshFixture.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { batchId, status: "pending" },
      data: { status: "unverified", errorCode: "delivery_failed", observedAt: startedAt }
    }));
    expect(prisma.monitoringRefreshBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "failed", errorCode: "delivery_failed", completedAt: startedAt }
    }));
    expect(prisma.fixture).toBeUndefined();
    expect(JSON.stringify(prisma.mqttOutbox.updateMany.mock.calls)).not.toContain("native-usb-secret");
  });

  it("expires a command that reaches its wire deadline without publishing", async () => {
    const { service, prisma, mqtt } = harness(() => deadlineAt);

    await service.publishClaimed(record() as never);

    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.monitoringRefreshBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "expired", errorCode: "refresh_deadline_exceeded", completedAt: deadlineAt }
    }));
    expect(prisma.monitoringRefresh.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "expired" })
    }));
  });

  it("contains scheduled failures, redacts logs, unreferences its timer, and drains on shutdown", async () => {
    jest.useFakeTimers();
    const loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation();
    const { service } = harness();
    const claim = jest.spyOn(service, "claimBatch")
      .mockRejectedValueOnce(Object.assign(new Error("payload-secret"), { code: "P2028" }))
      .mockResolvedValue([]);
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("error=P2028"));
      expect(loggerError.mock.calls.flat().join(" ")).not.toContain("payload-secret");
      await service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(2_000);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      await service.stopAndDrain();
      process.off("unhandledRejection", unhandled);
      loggerError.mockRestore();
      jest.useRealTimers();
    }
  });
});

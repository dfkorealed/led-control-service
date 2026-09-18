import { Logger } from "@nestjs/common";
import { MonitoringRefreshExpiryService } from "./monitoring-refresh-expiry.service";

const refreshId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-09-15T08:00:31.000Z");

function harness() {
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: refreshId }]),
    monitoringRefresh: {
      findUnique: jest.fn().mockResolvedValue({
        id: refreshId,
        status: "pending",
        deadlineAt: new Date("2026-09-15T08:00:30.000Z"),
        totalFixtures: 2
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    monitoringRefreshFixture: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([
        { status: "online", _count: { _all: 1 } },
        { status: "unverified", _count: { _all: 1 } }
      ])
    },
    monitoringRefreshBatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    mqttOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
  };
  prisma.$transaction = jest.fn((callback) => callback(prisma));
  const service = new MonitoringRefreshExpiryService(prisma, { pollMs: 1_000 });
  return { service, prisma };
}

describe("MonitoringRefreshExpiryService", () => {
  it("expires unresolved fixtures as unverified, aggregates counters, and never changes Fixture", async () => {
    const { service, prisma } = harness();

    await expect(service.expire(now)).resolves.toEqual({ expired: 1 });

    const lockSql = prisma.$queryRaw.mock.calls[0][0].sql as string;
    expect(lockSql).toContain('FROM "MonitoringRefresh"');
    expect(lockSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(prisma.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.mqttOutbox.updateMany.mock.invocationCallOrder[0]);
    expect(prisma.monitoringRefreshFixture.updateMany).toHaveBeenCalledWith({
      where: { refreshId, status: "pending" },
      data: { status: "unverified", errorCode: "refresh_deadline_exceeded", observedAt: now }
    });
    expect(prisma.monitoringRefreshBatch.updateMany).toHaveBeenCalledWith({
      where: { refreshId, status: { in: ["pending", "published"] } },
      data: { status: "expired", errorCode: "refresh_deadline_exceeded", completedAt: now }
    });
    expect(prisma.monitoringRefresh.updateMany).toHaveBeenCalledWith({
      where: { id: refreshId, status: "pending" },
      data: {
        status: "partial",
        onlineFixtures: 1,
        offlineFixtures: 0,
        unverifiedFixtures: 1,
        completedAt: now
      }
    });
    expect(prisma.fixture).toBeUndefined();
  });

  it("uses expired when no fixture result was verified and fences unpublished outbox rows", async () => {
    const { service, prisma } = harness();
    prisma.monitoringRefreshFixture.groupBy.mockResolvedValue([
      { status: "unverified", _count: { _all: 2 } }
    ]);

    await service.expire(now);

    expect(prisma.monitoringRefresh.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "expired", unverifiedFixtures: 2 })
    }));
    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        monitoringRefreshBatch: { refreshId },
        publishedAt: null,
        deadLetteredAt: null
      },
      data: {
        deadLetteredAt: now,
        lastError: "refresh_deadline_exceeded",
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null
      }
    });
  });

  it("contains polling failures, sanitizes logs, and leaves no timer after shutdown", async () => {
    jest.useFakeTimers();
    const loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation();
    const { service } = harness();
    const expire = jest.spyOn(service, "expire")
      .mockRejectedValueOnce(Object.assign(new Error("sql-secret"), { code: "P2028" }))
      .mockResolvedValue({ expired: 0 });

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(expire).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("error=P2028"));
      expect(loggerError.mock.calls.flat().join(" ")).not.toContain("sql-secret");
      await service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(2_000);
      expect(expire).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      await service.stopAndDrain();
      loggerError.mockRestore();
      jest.useRealTimers();
    }
  });
});

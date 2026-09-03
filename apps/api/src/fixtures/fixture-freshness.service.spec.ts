import { FixtureFreshnessService } from "./fixture-freshness.service";

describe("FixtureFreshnessService", () => {
  it("marks gateway and fixture stale states with distinct reasons", async () => {
    const prisma = {
      fixture: {
        updateMany: jest.fn().mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 1 })
      }
    };
    const service = new FixtureFreshnessService(prisma as never);
    const now = new Date("2026-07-11T00:05:00.000Z");

    await expect(service.markStaleFixtures(now)).resolves.toEqual({ gatewayOffline: 2, fixtureStale: 1 });
    expect(prisma.fixture.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        OR: [{ statusReason: { not: "provisioning_waiting_state" } }, { statusReason: null }],
        meshNode: {
          gateway: {
            OR: [{ lastHeartbeatAt: { lt: new Date("2026-07-11T00:03:30.000Z") } }, { lastHeartbeatAt: null }]
          }
        }
      },
      data: { status: "offline", statusReason: "gateway_offline" }
    });
    expect(prisma.fixture.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        AND: [
          { status: { not: "offline" } },
          { OR: [{ statusReason: { not: "provisioning_waiting_state" } }, { statusReason: null }] },
          { OR: [{ lastStateOccurredAt: { lt: new Date("2026-07-11T00:02:00.000Z") } }, { lastStateOccurredAt: null }] }
        ]
      },
      data: { status: "offline", statusReason: "fixture_stale" }
    });
  });

  it("contains a scheduled sweep failure and keeps the interval alive", async () => {
    jest.useFakeTimers();
    const previousPollMs = process.env.FIXTURE_FRESHNESS_POLL_MS;
    process.env.FIXTURE_FRESHNESS_POLL_MS = "10";
    try {
      const prisma = {
        fixture: {
          updateMany: jest.fn()
            .mockRejectedValueOnce(Object.assign(new Error("database unavailable"), { code: "P1001" }))
            .mockResolvedValue({ count: 0 })
        }
      };
      const service = new FixtureFreshnessService(prisma as never);
      const loggerError = jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);

      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(10);
      expect(loggerError).toHaveBeenCalledWith("fixture freshness sweep failed (error=P1001)");

      await jest.advanceTimersByTimeAsync(10);
      expect(prisma.fixture.updateMany).toHaveBeenCalledTimes(3);
      service.onModuleDestroy();
    } finally {
      if (previousPollMs === undefined) delete process.env.FIXTURE_FRESHNESS_POLL_MS;
      else process.env.FIXTURE_FRESHNESS_POLL_MS = previousPollMs;
      jest.useRealTimers();
    }
  });
});

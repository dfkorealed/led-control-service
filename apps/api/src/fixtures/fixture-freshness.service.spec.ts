import { FixtureFreshnessService } from "./fixture-freshness.service";

describe("FixtureFreshnessService", () => {
  const now = new Date("2026-09-12T00:10:00.000Z");
  function setup() {
    const sites = [
      { id: "strict", gatewayOfflineAfterSeconds: 30, fixtureStaleAfterSeconds: 60 },
      { id: "lenient", gatewayOfflineAfterSeconds: 120, fixtureStaleAfterSeconds: 240 }
    ];
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "locked" }]),
      site: { findUnique: jest.fn(({ where }) => Promise.resolve(sites.find((site) => site.id === where.id))) },
      fixture: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const prisma = { ...tx, site: { findMany: jest.fn().mockResolvedValue(sites) },
      $transaction: jest.fn((work) => work(tx)) };
    // PostgreSQL tests validate these predicates and all incident side effects.
    const reconciler = { reconcile: jest.fn().mockResolvedValue(undefined) };
    return { prisma, tx, reconciler, service: new (FixtureFreshnessService as any)(prisma, reconciler) as FixtureFreshnessService };
  }

  it("keeps fixed control freshness across Site policies and reconciles monitoring afterward", async () => {
    const { service, tx, reconciler } = setup();
    await expect(service.markStaleFixtures(now)).resolves.toEqual({ gatewayOffline: 2, fixtureStale: 2 });
    expect(tx.fixture.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ siteId: "strict", meshNode: { gateway: {
        OR: [{ lastHeartbeatAt: { lt: new Date("2026-09-12T00:08:30.000Z") } }, { lastHeartbeatAt: null }]
      } } })
    }));
    expect(tx.fixture.updateMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
      where: expect.objectContaining({ siteId: "lenient", meshNode: { gateway: {
        OR: [{ lastHeartbeatAt: { lt: new Date("2026-09-12T00:08:30.000Z") } }, { lastHeartbeatAt: null }]
      } } })
    }));
    expect(reconciler.reconcile).toHaveBeenCalledTimes(2);
    expect(tx.fixture.updateMany.mock.invocationCallOrder[1]).toBeLessThan(reconciler.reconcile.mock.invocationCallOrder[0]);
  });

  it("bounds each transaction, continues after first-Site failure, and retries it next tick without logging tenant data", async () => {
    const { service, prisma, reconciler } = setup();
    const log = jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error("strict tenant details"), { code: "strict\nsecret" }));
    await expect(service.markStaleFixtures(now)).resolves.toEqual({ gatewayOffline: 1, fixtureStale: 1 });
    expect(reconciler.reconcile).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "lenient" }), now);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 2000, timeout: 5000 });
    expect(log).toHaveBeenCalledWith("fixture freshness site sweep failed (error=UNEXPECTED_ERROR)");
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/strict|secret/);
    await expect(service.markStaleFixtures(now)).resolves.toEqual({ gatewayOffline: 2, fixtureStale: 2 });
    expect(reconciler.reconcile).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "strict" }), now);
  });

  it("does not launch overlapping scheduled sweeps and resumes after a failure", async () => {
    jest.useFakeTimers();
    const previous = process.env.FIXTURE_FRESHNESS_POLL_MS;
    process.env.FIXTURE_FRESHNESS_POLL_MS = "10";
    const { service } = setup();
    let reject!: (error: unknown) => void;
    const sweep = jest.spyOn(service, "markStaleFixtures")
      .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValue({ gatewayOffline: 0, fixtureStale: 0 });
    const log = jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(40);
      expect(sweep).toHaveBeenCalledTimes(1);
      reject(Object.assign(new Error("database unavailable"), { code: "P1001" }));
      await jest.advanceTimersByTimeAsync(10);
      expect(log).toHaveBeenCalledWith("fixture freshness sweep failed (error=P1001)");
      expect(sweep).toHaveBeenCalledTimes(2);
    } finally {
      service.onModuleDestroy();
      if (previous === undefined) delete process.env.FIXTURE_FRESHNESS_POLL_MS;
      else process.env.FIXTURE_FRESHNESS_POLL_MS = previous;
      jest.useRealTimers();
    }
  });
});

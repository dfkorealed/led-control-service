import { Prisma } from "@prisma/client";
import { FixtureFreshnessService } from "./fixture-freshness.service";

describe("FixtureFreshnessService", () => {
  const now = new Date("2026-09-12T00:10:00.000Z");
  function setup() {
    const sites = [
      { id: "strict", gatewayOfflineAfterSeconds: 30, fixtureStaleAfterSeconds: 60 },
      { id: "lenient", gatewayOfflineAfterSeconds: 120, fixtureStaleAfterSeconds: 240 }
    ];
    const tx = {
      $queryRaw: jest.fn(async (query: Prisma.Sql) => query.sql.includes("WITH candidates") ? [{ changed: 1n }] : [{ id: "locked" }]),
      site: { findUnique: jest.fn(({ where }) => Promise.resolve(sites.find((site) => site.id === where.id))) }
    };
    const prisma = { ...tx, site: { findMany: jest.fn().mockResolvedValue(sites) },
      $transaction: jest.fn((work) => work(tx)) };
    // PostgreSQL tests validate these predicates and all incident side effects.
    const reconciler = { reconcile: jest.fn().mockResolvedValue(undefined) };
    return { prisma, tx, reconciler, service: new (FixtureFreshnessService as any)(prisma, reconciler) as FixtureFreshnessService };
  }

  const transitions = (tx: ReturnType<typeof setup>["tx"]) => tx.$queryRaw.mock.calls
    .map(([query]) => query).filter((query) => query.sql.includes("WITH candidates"));

  it("projects old visible status in the same set-based transaction as each transition", async () => {
    const { service, tx } = setup();
    await service.markStaleFixtures(now);
    expect(transitions(tx)).toHaveLength(4);
    for (const query of transitions(tx)) {
      expect(query.sql).toContain("WITH candidates AS MATERIALIZED");
      expect(query.sql).toContain('UPDATE "Fixture" f');
      expect(query.sql).toContain('INSERT INTO "MonitoringActivity"');
      expect(query.sql).toContain('FROM updated u WHERE u."status" <> \'offline\'::"FixtureStatus"');
      expect(query.sql).toContain('f."reportedStatusReason" IS DISTINCT FROM \'provisioning_waiting_state\'');
    }
  });

  it("keeps fixed control freshness across Site policies and reconciles monitoring afterward", async () => {
    const { service, tx, reconciler } = setup();
    await expect(service.markStaleFixtures(now)).resolves.toEqual({ gatewayOffline: 2, fixtureStale: 2 });
    expect(transitions(tx)[0].values).toContain("strict");
    expect(transitions(tx)[0].values).toContainEqual(new Date("2026-09-12T00:08:30.000Z"));
    expect(transitions(tx)[2].values).toContain("lenient");
    expect(transitions(tx)[2].values).toContainEqual(new Date("2026-09-12T00:08:30.000Z"));
    expect(reconciler.reconcile).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw.mock.invocationCallOrder[4]).toBeLessThan(reconciler.reconcile.mock.invocationCallOrder[0]);
  });

  it.each([
    [1_200_000, false],
    [1_200_001, true]
  ] as const)("marks fixture age %d stale=%s", async (age, stale) => {
    const { service, tx } = setup();
    await service.markStaleFixtures(now);

    const cutoff = transitions(tx)[1].values.find((value) => value instanceof Date &&
      value.getTime() === now.getTime() - 1_200_000) as Date;
    expect(cutoff).toEqual(new Date(now.getTime() - 1_200_000));
    expect(new Date(now.getTime() - age).getTime() < cutoff.getTime()).toBe(stale);
  });

  it("persists a verified manual failure even before the twenty-minute cutoff", async () => {
    const { service, tx } = setup();
    await service.markStaleFixtures(now);
    expect(transitions(tx)[1].sql).toContain('f."lastUnreachableAt" > f."lastSeenAt"');
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

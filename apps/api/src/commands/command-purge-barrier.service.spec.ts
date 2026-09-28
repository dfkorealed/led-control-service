import { CommandPurgeBarrier } from "./command-purge-barrier.service";

function fixture() {
  let monotonic = 100;
  const dbAt = new Date("2026-09-27T00:00:00.000Z");
  const snapshot = { generation: 7, status: "fenced", fencedAt: dbAt, dbNow: dbAt,
    primaryId: "primary-1", continuityId: "continuity-1", healthy: true,
    clockDigest: "a".repeat(64), memberDigest: "b".repeat(64), memberCount: 1, missingMembers: 0,
    cutoff: new Date("2026-06-27T00:00:00.000Z") };
  let legacy = false;
  let maxExpiry: Date | null = new Date(dbAt.getTime() + 15000);
  const tx: any = { $queryRaw: async (query: any) => {
    const sql = query.sql ?? query.join?.("") ?? "";
    if (sql.includes('MAX("expiresAt")')) return [{ expiresAt: maxExpiry }];
    if (sql.includes('LEFT JOIN "MqttOutbox"')) return legacy ? [{ id: "legacy" }] : [];
    if (sql.includes('FROM "CommandPublishEpoch" WHERE')) return [{ generation: 7 }];
    return [snapshot];
  } };
  const broker: any = { status: "verified", scope: "disposable", generation: 7,
    digest: "c".repeat(64), inventoryRevision: "brokers-1", productionPurgeAllowed: false,
    verifiedAtMonotonicMs: monotonic, expiresAtMonotonicMs: monotonic + 1000 };
  const gateway: any = { status: "verified", generation: 7, digest: "d".repeat(64),
    inventoryRevision: "gateways-1", submitToRfUpperBoundMs: 500, productionPurgeAllowed: false,
    verifiedAtMonotonicMs: monotonic, expiresAtMonotonicMs: monotonic + 1000 };
  const options = { broker: { verifyRetired: async () => ({ ...broker }) },
    gateways: { verify: async () => ({ ...gateway }) }, monotonicNow: () => monotonic };
  const barrier = new CommandPurgeBarrier(options);
  const advance = (ms: number) => {
    monotonic += ms; snapshot.dbNow = new Date(snapshot.dbNow.getTime() + ms);
    for (const evidence of [broker, gateway]) {
      evidence.verifiedAtMonotonicMs = monotonic; evidence.expiresAtMonotonicMs = monotonic + 1000;
    }
  };
  const check = async () => { await barrier.refresh(7); return barrier.assertReady(tx, 7); };
  return { barrier, options, tx, snapshot, broker, gateway, advance, check,
    legacy: () => { legacy = true; }, setExpiry: (value: Date | null) => { maxExpiry = value; } };
}

describe("Command purge monotonic barrier", () => {
  it("waits the greater expiry + two-second lead or sample age, then measured RF bound", async () => {
    const f = fixture();
    expect(await f.check()).toMatchObject({ ready: false, reason: "drain_wait_pending" });
    f.advance(17499);
    expect(await f.check()).toMatchObject({ ready: false });
    f.advance(1);
    expect(await f.check()).toMatchObject({ ready: true, evidence: { generation: 7,
      minimumWaitMs: 17500, monotonicWaitMs: 17500, productionPurgeAllowed: false } });
  });

  it("always waits cached sample age even with no attempted Set", async () => {
    const f = fixture(); f.setExpiry(null);
    await f.check(); f.advance(10499);
    expect(await f.check()).toMatchObject({ ready: false });
    f.advance(1);
    expect(await f.check()).toMatchObject({ ready: true, evidence: { minimumWaitMs: 10500 } });
  });

  it.each(["missingMember", "legacyAttempt", "clockStep", "failover", "unhealthyClock", "brokerRollback",
    "missingRf", "epochChange"])("fails closed for %s after an otherwise complete wait", async kind => {
    const f = fixture(); await f.check(); f.advance(18000);
    if (kind === "missingMember") f.snapshot.missingMembers = 1;
    if (kind === "legacyAttempt") f.legacy();
    if (kind === "clockStep") f.snapshot.dbNow = new Date(f.snapshot.dbNow.getTime() + 101);
    if (kind === "failover") f.snapshot.primaryId = "primary-2";
    if (kind === "unhealthyClock") f.snapshot.healthy = false;
    if (kind === "brokerRollback") f.broker.status = "unavailable";
    if (kind === "missingRf") f.gateway.status = "unavailable";
    if (kind === "epochChange") f.snapshot.status = "retired";
    expect(await f.check()).toMatchObject({ ready: false });
  });

  it("restarts the whole wait after worker restart and requires fresh evidence on consumption", async () => {
    const f = fixture(); await f.check(); f.advance(18000);
    const restarted = new CommandPurgeBarrier(f.options);
    await restarted.refresh(7);
    expect(await restarted.assertReady(f.tx, 7)).toMatchObject({ ready: false, reason: "drain_wait_pending" });
    expect(await f.check()).toMatchObject({ ready: true });
    f.advance(1000);
    expect(await f.barrier.assertReady(f.tx, 7)).toMatchObject({ ready: false, reason: "drain_evidence_unavailable" });
  });

  it("does not revive a clock-stepped epoch on a later healthy sample", async () => {
    const f = fixture(); await f.check(); f.advance(18000);
    f.snapshot.dbNow = new Date(f.snapshot.dbNow.getTime() + 101);
    expect(await f.check()).toMatchObject({ ready: false });
    await f.check(); f.advance(18000);
    expect(await f.check()).toMatchObject({ ready: false, reason: "barrier_continuity_reset" });
  });

  it("retains the original wait bound while authorized deletes reduce remaining attempts", async () => {
    const f = fixture(); await f.check(); f.advance(18000);
    expect(await f.check()).toMatchObject({ ready: true });
    f.setExpiry(null);
    expect(await f.check()).toMatchObject({ ready: true, evidence: { minimumWaitMs: 17500 } });
  });
});

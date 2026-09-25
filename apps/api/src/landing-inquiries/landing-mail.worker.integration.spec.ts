import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { LandingMailWorker } from "./landing-mail.worker";
import { LandingMailTransport, LandingMailDeliveryError } from "./landing-mail.transport";

const databaseUrl = process.env.LANDING_MAIL_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
describeDatabase("landing worker PostgreSQL outcomes and exclusive claims", () => {
  let db: PrismaService;
  let otherDb: PrismaService;
  let worker: LandingMailWorker;
  let other: LandingMailWorker;
  const send = jest.fn();
  const now = new Date("2026-09-25T00:00:00Z");
  const oldDatabase = process.env.DATABASE_URL;
  const ids: string[] = [];
  beforeAll(() => {
    // Only an explicit disposable DB URL enables this suite. Cleanup owns generated IDs.
    process.env.DATABASE_URL = databaseUrl;
    db = new PrismaService(); otherDb = new PrismaService();
    worker = new LandingMailWorker(db, { send } as unknown as LandingMailTransport);
    other = new LandingMailWorker(otherDb, { send } as unknown as LandingMailTransport);
  });
  beforeEach(() => { send.mockReset().mockResolvedValue("provider_accepted"); });
  afterEach(async () => { await db.landingInquiry.deleteMany({ where: { id: { in: ids.splice(0) } } }); });
  afterAll(async () => {
    await worker?.onModuleDestroy(); await other?.onModuleDestroy();
    await db?.$disconnect(); await otherDb?.$disconnect();
    if (oldDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldDatabase;
  });
  async function inquiry(extra: Record<string, unknown> = {}) {
    const row = await db.landingInquiry.create({ data: {
      idempotencyKey: randomUUID(), reference: randomUUID(), payloadHash: "hash", companyName: "Company",
      contactName: "Person", email: "reply@example.com", phone: "", message: "hello",
      consentVersion: "landing-2026-09-v1-90d", consentAt: now, createdAt: now,
      expiresAt: new Date("2026-12-24T00:00:00Z"), nextAttemptAt: now,
      ...(extra.expiresAt ? { createdAt: new Date((extra.expiresAt as Date).getTime() - 90 * 86400000) } : {}), ...extra
    } });
    ids.push(row.id); return row;
  }
  it("two workers claim a row once and persist provider acceptance", async () => {
    const row = await inquiry();
    await Promise.all([worker.deliverDue(now), other.deliverDue(now)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db.landingInquiry.findUnique({ where: { id: row.id } })).toMatchObject({
      deliveryStatus: "provider_accepted", attemptCount: 1, leaseOwner: null, nextAttemptAt: null, providerAcceptedAt: now
    });
  });
  it("backs off confirmed rejection finitely and stops after five attempts", async () => {
    const row = await inquiry();
    send.mockRejectedValue(new LandingMailDeliveryError("retryable", "MAIL_RATE_LIMITED"));
    await worker.deliverDue(now);
    expect(await db.landingInquiry.findUnique({ where: { id: row.id } })).toMatchObject({
      deliveryStatus: "retry_wait", attemptCount: 1, nextAttemptAt: new Date("2026-09-25T00:01:00Z"), lastErrorCode: "MAIL_RATE_LIMITED"
    });
    expect(await worker.deliverDue(now)).toBe(0);
    for (let attempt = 2; attempt <= 5; attempt++) {
      const current = await db.landingInquiry.findUniqueOrThrow({ where: { id: row.id } });
      await worker.deliverDue(current.nextAttemptAt!);
    }
    expect(await db.landingInquiry.findUnique({ where: { id: row.id } })).toMatchObject({ deliveryStatus: "failed", attemptCount: 5, nextAttemptAt: null });
    expect(await worker.deliverDue(new Date("2026-09-26T00:00:00Z"))).toBe(0);
  });
  it.each([
    [new LandingMailDeliveryError("uncertain", "MAIL_ACCEPTANCE_UNKNOWN"), "delivery_uncertain", "MAIL_ACCEPTANCE_UNKNOWN"],
    [new LandingMailDeliveryError("permanent", "MAIL_REJECTED"), "failed", "MAIL_REJECTED"],
    [new Error("private upstream response"), "delivery_uncertain", "MAIL_ACCEPTANCE_UNKNOWN"]
  ])("closes terminal outcomes without automatic resend", async (error, status, code) => {
    const row = await inquiry(); send.mockRejectedValue(error);
    await worker.deliverDue(now); await worker.deliverDue(new Date("2026-09-26T00:00:00Z"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db.landingInquiry.findUnique({ where: { id: row.id } })).toMatchObject({ deliveryStatus: status, lastErrorCode: code, nextAttemptAt: null });
  });
  it("closes expired leases as uncertain and does not steal live leases", async () => {
    const stale = await inquiry({ leaseOwner: "dead-process", leaseExpiresAt: now, attemptCount: 1 });
    const live = await inquiry({ leaseOwner: "alive-process", leaseExpiresAt: new Date(now.getTime() + 1000) });
    expect(await worker.deliverDue(now)).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await db.landingInquiry.findUnique({ where: { id: stale.id } })).toMatchObject({ deliveryStatus: "delivery_uncertain", lastErrorCode: "MAIL_LEASE_EXPIRED" });
    expect(await db.landingInquiry.findUnique({ where: { id: live.id } })).toMatchObject({ leaseOwner: "alive-process" });
  });
  it("bounds each run to ten sends and excludes expired inquiry content", async () => {
    for (let index = 0; index < 12; index++) await inquiry();
    await inquiry({ expiresAt: now });
    expect(await worker.deliverDue(now)).toBe(10);
    expect(send).toHaveBeenCalledTimes(10);
    expect(await db.landingInquiry.count({ where: { id: { in: ids }, deliveryStatus: "queued" } })).toBe(3);
  });
  it("prunes at most 100 expired records and keeps unexpired records", async () => {
    for (let index = 0; index < 101; index++) await inquiry({ expiresAt: now });
    const keep = await inquiry();
    expect(await worker.pruneExpired(now)).toBe(100);
    expect(await db.landingInquiry.findUnique({ where: { id: keep.id } })).not.toBeNull();
    expect(await worker.pruneExpired(now)).toBe(1);
    expect(await worker.pruneExpired(now)).toBe(0);
  });
  it("refreshes the clock for each claim when a preceding send delays the batch", async () => {
    await inquiry(); await inquiry();
    jest.useFakeTimers({ now, doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "performance", "hrtime"] });
    const leases: Date[] = [];
    send.mockImplementation(async () => {
      const claimed = await db.landingInquiry.findFirstOrThrow({ where: { id: { in: ids }, leaseOwner: { not: null } } });
      leases.push(claimed.leaseExpiresAt!);
      jest.setSystemTime(new Date("2026-09-25T00:03:00Z"));
      return "provider_accepted";
    });
    try {
      await worker.deliverDue();
      expect(leases).toEqual([new Date("2026-09-25T00:02:00Z"), new Date("2026-09-25T00:05:00Z")]);
    } finally { jest.useRealTimers(); }
  });
  it("keeps acceptance persistence failures leased until terminal uncertain recovery", async () => {
    const row = await inquiry();
    const save = jest.spyOn(db.landingInquiry, "updateMany").mockRejectedValueOnce(new Error("database unavailable"));
    try { await expect(worker.deliverDue(now)).rejects.toThrow("database unavailable"); }
    finally { save.mockRestore(); }
    expect(await db.landingInquiry.findUnique({ where: { id: row.id } })).toMatchObject({ deliveryStatus: "queued", attemptCount: 1, leaseOwner: expect.any(String) });
    await other.deliverDue(new Date("2026-09-25T00:02:01Z"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db.landingInquiry.findUnique({ where: { id: row.id } })).toMatchObject({ deliveryStatus: "delivery_uncertain", lastErrorCode: "MAIL_LEASE_EXPIRED" });
  });
  it("disables test timers and drains in-flight delivery on shutdown", async () => {
    const timer = jest.spyOn(global, "setInterval");
    worker.onModuleInit(); expect(timer).not.toHaveBeenCalled(); timer.mockRestore();
    await inquiry();
    let started!: () => void; const beginning = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    send.mockImplementationOnce(async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); return "provider_accepted"; });
    const running = worker.deliverDue(now); await beginning;
    let drained = false; const stopping = worker.onModuleDestroy().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    release(); await running; await stopping; expect(drained).toBe(true);
    expect(await worker.deliverDue(now)).toBe(0);
  });
});

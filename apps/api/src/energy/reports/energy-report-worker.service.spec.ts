import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { EnergyReportWorkerService } from "./energy-report-worker.service";
import { EnergyReportSnapshotService } from "./energy-report-snapshot.service";
import { EnergyReportDocumentBuilder } from "./energy-report-document.builder";
import { ExcelEnergyReportRenderer, extractExcelReportManifest } from "./excel-energy-report.renderer";
import { PdfEnergyReportRenderer } from "./pdf-energy-report.renderer";
import { extractPdfReportManifest } from "./pdf-report-manifest";
import { ObjectStorageService } from "../../storage/object-storage.service";
import { expectedManifest } from "./report-renderer.test-support";
import { EnergyReportCleanupService } from "./energy-report-cleanup.service";
import { SiteDeletionCleanupService } from "../../operator-site-admins/site-deletion-cleanup.service";

describe("report worker lifecycle", () => {
  it("does not start snapshot capture or a heartbeat when shutdown occurs during a pending claim", async () => {
    let resolveClaim!: (rows: unknown[]) => void;
    let markClaimStarted!: () => void;
    const started = new Promise<void>(resolve => { markClaimStarted = resolve; });
    const claim = new Promise<unknown[]>(resolve => { resolveClaim = resolve; });
    const prisma = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn(() => { markClaimStarted(); return claim; }),
      $transaction: jest.fn().mockRejectedValue(new Error("unexpected snapshot read after shutdown"))
    };
    const snapshots = new EnergyReportSnapshotService(prisma as never, new EnergyReportDocumentBuilder());
    const worker = new EnergyReportWorkerService(prisma as never, {} as never, snapshots, new ExcelEnergyReportRenderer(), new PdfEnergyReportRenderer());
    const timer = jest.spyOn(global, "setInterval");
    try {
      const pending = worker.runOnce();
      await started;
      worker.onModuleDestroy();
      resolveClaim([{ id: randomUUID(), siteId: randomUUID(), format: "xlsx", attemptCount: 1, documentSnapshot: null,
        requestSnapshot: { from: "2026-09-01", to: "2026-09-02", scope: "site", identityId: randomUUID(), format: "xlsx" } }]);
      expect(await pending).toBe(false);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(timer).not.toHaveBeenCalled();
      // No post-shutdown update revives the lease; its original deadline remains reclaimable.
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    } finally { worker.onModuleDestroy(); timer.mockRestore(); }
  });

  it("does not issue a new claim query when shutdown occurs during the exhausted-attempt sweep", async () => {
    let resolveSweep!: (count: number) => void;
    const sweep = new Promise<number>(resolve => { resolveSweep = resolve; });
    const prisma = { $executeRaw: jest.fn(() => sweep), $queryRaw: jest.fn().mockResolvedValue([]) };
    const worker = new EnergyReportWorkerService(prisma as never, {} as never, {} as never, new ExcelEnergyReportRenderer(), new PdfEnergyReportRenderer());
    const pending = worker.runOnce();
    worker.onModuleDestroy();
    resolveSweep(0);
    expect(await pending).toBe(false);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("does not start rendering when shutdown occurs during the awaited lease renewal", async () => {
    const reportId = randomUUID(); const siteId = randomUUID();
    const document = new EnergyReportDocumentBuilder().build(reportId,
      { from: "2026-09-01", to: "2026-09-02", scope: "site", identityId: siteId, format: "xlsx" },
      { schemaVersion: 1, capturedAt: new Date().toISOString(), site: { id: siteId, name: "Shutdown", timeZone: "UTC" },
        comparisonRange: { from: "2026-08-30", to: "2026-08-31" }, fixtures: [] });
    let worker: EnergyReportWorkerService;
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: reportId, siteId, format: "xlsx", attemptCount: 1, documentSnapshot: document }]),
      siteDeletionCleanup: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: async (run: (tx: unknown) => unknown) => run(prisma),
      $executeRaw: jest.fn(async query => {
        if (query.values[0] === 25) { worker.onModuleDestroy(); return 1; }
        return 0;
      })
    };
    const excel = new ExcelEnergyReportRenderer();
    const render = jest.spyOn(excel, "render"); // Call-through instrumentation; rendering remains real.
    worker = new EnergyReportWorkerService(prisma as never, {} as never, {} as never, excel, new PdfEnergyReportRenderer());
    try {
      await worker.runOnce();
      expect(render).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    }
    finally { worker.onModuleDestroy(); render.mockRestore(); }
  });

  it("does not start polling under NODE_ENV=test", () => {
    const timer = jest.spyOn(global, "setInterval");
    const worker = new EnergyReportWorkerService({} as never, {} as never, {} as never, new ExcelEnergyReportRenderer(), new PdfEnergyReportRenderer());
    worker.onModuleInit();
    expect(timer).not.toHaveBeenCalled();
    worker.onModuleDestroy();
    timer.mockRestore();
  });
  it("starts one unref poller in production and releases it on module destruction", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const timer = jest.spyOn(global, "setInterval");
    const clear = jest.spyOn(global, "clearInterval");
    const worker = new EnergyReportWorkerService({} as never, {} as never, {} as never, new ExcelEnergyReportRenderer(), new PdfEnergyReportRenderer());
    try {
      worker.onModuleInit(); worker.onModuleInit();
      expect(timer).toHaveBeenCalledTimes(1);
      const handle = timer.mock.results[0].value as NodeJS.Timeout;
      expect(handle.hasRef()).toBe(false);
      worker.onModuleDestroy();
      expect(clear).toHaveBeenCalledWith(handle);
    } finally { worker.onModuleDestroy(); process.env.NODE_ENV = previous; timer.mockRestore(); clear.mockRestore(); }
  });
});

const databaseUrl = process.env.ENERGY_REPORT_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("report worker PostgreSQL + real renderers", () => {
  const organizationId = randomUUID();
  const siteId = randomUUID();
  let prisma: PrismaClient;
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  let putHook: (() => Promise<void>) | undefined;
  let headOverride: Record<string, unknown>;
  const putKeys: string[] = [];
  let worker: EnergyReportWorkerService;
  let storage: ObjectStorageService;
  const makeWorker = (client = prisma) => {
    storage = new ObjectStorageService({ send: async (command: any) => {
      expect(command.input.Bucket).toBe("private-reports");
      const key = command.input.Key;
      if (command instanceof PutObjectCommand) {
        putKeys.push(key);
        objects.set(key, { bytes: Buffer.from(command.input.Body as Buffer), contentType: command.input.ContentType! });
        await putHook?.();
        return {};
      }
      if (command instanceof HeadObjectCommand) {
        const stored = objects.get(key)!;
        return { ContentLength: stored.bytes.length, ContentType: stored.contentType,
          ChecksumSHA256: createHash("sha256").update(stored.bytes).digest("base64"), ...headOverride };
      }
      if (command instanceof DeleteObjectCommand) { objects.delete(key); return {}; }
      throw new Error("unexpected S3 command");
    } } as never, { bucket: "public-floors", reportBucket: "private-reports", publicBaseUrl: "https://public.example" });
    return new EnergyReportWorkerService(client as never, storage,
      new EnergyReportSnapshotService(client as never, new EnergyReportDocumentBuilder()), new ExcelEnergyReportRenderer(), new PdfEnergyReportRenderer());
  };
  const enqueue = (format: "xlsx" | "pdf" = "xlsx", extra: Record<string, unknown> = {}) => prisma.energyReportJob.create({ data: {
    siteId, requestedByActorId: randomUUID(), requestedByLoginIdSnapshot: "reader", requestHash: "a".repeat(64), format,
    requestSnapshot: { from: "2026-09-01", to: "2026-09-02", scope: "site", identityId: siteId, format }, ...extra
  } });
  const load = (id: string) => prisma.energyReportJob.findUniqueOrThrow({ where: { id } });
  const expire = (id: string) => prisma.$executeRaw`UPDATE "EnergyReportJob" SET "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "id" = ${id}`;

  beforeAll(async () => {
    // Keep this regression meaningful even when the CI database defaults to UTC.
    const workerDatabaseUrl = new URL(databaseUrl!);
    workerDatabaseUrl.searchParams.set("options", "-c timezone=Asia/Seoul");
    prisma = new PrismaClient({ datasourceUrl: workerDatabaseUrl.toString() });
    await prisma.organization.create({ data: { id: organizationId, name: "Report worker isolated test", type: "customer" } });
    await prisma.site.create({ data: { id: siteId, organizationId, name: "원래 현장", timeZone: "UTC" } });
  });
  beforeEach(async () => {
    await prisma.energyReportJob.deleteMany({ where: { siteId } });
    await prisma.energyReportObjectCleanup.deleteMany({ where: { siteId } });
    await prisma.site.update({ where: { id: siteId }, data: { name: "원래 현장" } });
    objects.clear(); putKeys.length = 0; putHook = undefined; headOverride = {}; worker = makeWorker();
  });
  afterEach(() => worker.onModuleDestroy());
  afterAll(async () => {
    await prisma.site.delete({ where: { id: siteId } });
    await prisma.energyReportObjectCleanup.deleteMany({ where: { siteId } });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it("claims one row per owner with a 30-second lease and never claims a live processing row", async () => {
    await enqueue(); await enqueue();
    const other = makeWorker();
    const [first, second] = await Promise.all([worker.claimNext(), other.claimNext()]);
    expect(first?.id).not.toBe(second?.id);
    expect(first).toMatchObject({ status: "processing", attemptCount: 1, progressPercent: 1 });
    expect(Math.abs(first!.startedAt!.getTime() - Date.now())).toBeLessThan(1000);
    expect(first?.leaseOwner).not.toBe(second?.leaseOwner);
    expect(first!.leaseExpiresAt!.getTime() - first!.startedAt!.getTime()).toBeGreaterThanOrEqual(29_900);
    expect(first!.leaseExpiresAt!.getTime() - first!.startedAt!.getTime()).toBeLessThanOrEqual(30_100);
    expect(await other.claimNext()).toBeNull();
  });

  it("skips a row held by a different transaction without waiting for its lock", async () => {
    const first = await enqueue(); const second = await enqueue();
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "EnergyReportJob" WHERE "id" = ${first.id} FOR UPDATE`;
      const result = await worker.claimNext();
      expect(result?.id).toBe(second.id);
    }, { timeout: 3000 });
  });

  it("reaps a delayed third-attempt PUT after site cascade and already completed 305-second cleanup", async () => {
    const deletedSiteId = randomUUID();
    await prisma.site.create({ data: { id: deletedSiteId, organizationId, name: "Delayed upload", timeZone: "UTC" } });
    const job = await enqueue("xlsx", { siteId: deletedSiteId, attemptCount: 2,
      requestSnapshot: { from: "2026-09-01", to: "2026-09-02", scope: "site", identityId: deletedSiteId, format: "xlsx" } });
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const paused = new Proxy(prisma, { get(target, property) {
      if (property === "$executeRaw") return async (query: any) => {
        const result = await target.$executeRaw(query);
        // The DB renewal committed successfully. Delay only its response, before PUT starts.
        if (query.values[0] === 60) { expect(result).toBe(1); started(); await gate; }
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    worker = makeWorker(paused);
    const pending = worker.runOnce();
    const deletion = new SiteDeletionCleanupService(prisma as never, {} as never, storage);
    const cleanup = new EnergyReportCleanupService(prisma as never, storage);
    const sweepTime = new Date(Date.now() + 10 * 60_000);
    try {
      await entered;
      await expire(job.id);
      expect(await makeWorker().claimNext()).toBeNull(); // Retires crashed attempt 3; never grants attempt 4.
      const marker = await deletion.prepareReportDeletion(deletedSiteId);
      await prisma.site.delete({ where: { id: deletedSiteId } });
      await prisma.siteDeletionCleanup.update({ where: { id: marker.id }, data: { createdAt: new Date(0), nextAttemptAt: new Date(0), lastError: null } });
      expect(await deletion.processNow(marker.id)).toEqual({ status: "completed" });
      await cleanup.prune(sweepTime); // The durable reaper has already completed a successful pass, too.
      expect(objects.size).toBe(0);
      release(); await pending;
      expect(putKeys).toEqual([`reports/${deletedSiteId}/${job.id}/attempt-3.xlsx`]);
      expect(objects.size).toBe(1); // An arbitrarily late successful PUT is not prevented by a DB fence.
      await cleanup.prune(new Date(sweepTime.getTime() + 60_000));
      expect(objects.size).toBe(0);
      expect(await prisma.siteDeletionCleanup.findUnique({ where: { id: marker.id } })).toMatchObject({ completedAt: expect.any(Date) });
      expect(await prisma.energyReportJob.findUnique({ where: { id: job.id } })).toBeNull();
    } finally {
      release(); await pending;
      await prisma.site.deleteMany({ where: { id: deletedSiteId } });
      await prisma.energyReportObjectCleanup.deleteMany({ where: { siteId: deletedSiteId } });
      await prisma.siteDeletionCleanup.deleteMany({ where: { siteId: deletedSiteId } });
    }
  });

  it.each(["xlsx", "pdf"] as const)("captures, renders stored document to %s, verifies actual S3 bytes and completes for seven days", async format => {
    const job = await enqueue(format);
    let progressAtUpload = 0;
    putHook = async () => { progressAtUpload = (await load(job.id)).progressPercent; };
    expect(await worker.runOnce()).toBe(true);
    const completed = await load(job.id);
    expect(completed).toMatchObject({ status: "completed", progressPercent: 100, attemptCount: 1, leaseOwner: null, leaseExpiresAt: null,
      objectKey: `reports/${siteId}/${job.id}/attempt-1.${format}`, failureCode: null });
    expect(progressAtUpload).toBeGreaterThan(1);
    expect(progressAtUpload).toBeLessThan(100);
    expect(completed.expiresAt!.getTime() - completed.completedAt!.getTime()).toBe(7 * 86_400_000);
    expect(Math.abs(completed.completedAt!.getTime() - Date.now())).toBeLessThan(1000);
    const stored = objects.get(completed.objectKey!)!;
    expect(completed.sizeBytes).toBe(stored.bytes.length);
    expect(completed.sizeBytes).toBeLessThanOrEqual(25 * 1024 * 1024);
    expect(completed.contentSha256).toBe(createHash("sha256").update(stored.bytes).digest("hex"));
    const manifest = await (format === "xlsx" ? extractExcelReportManifest(stored.bytes) : extractPdfReportManifest(stored.bytes));
    // PostgreSQL JSONB reorders object keys. Compare every path/value independently;
    // serialized section/row ordering is already enforced by the real renderer manifest.
    const byPath = (left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path);
    expect([...manifest].sort(byPath)).toEqual(expectedManifest(completed.documentSnapshot).sort(byPath));
    expect(JSON.stringify(manifest)).not.toMatch(/known|coverage|forecast|baseline|예상|추정/i);
  }, 30_000);

  it("retries at most three times and preserves the first snapshot despite later data changes", async () => {
    const job = await enqueue();
    putHook = async () => { throw new Error("S3 boundary unavailable"); };
    await worker.runOnce();
    const first = await load(job.id);
    expect(first).toMatchObject({ status: "queued", attemptCount: 1, progressPercent: 0, startedAt: null, leaseOwner: null });
    expect(first.documentSnapshot).not.toBeNull();
    await prisma.site.update({ where: { id: siteId }, data: { name: "나중 현장" } });
    await worker.runOnce(); await worker.runOnce();
    const failed = await load(job.id);
    expect(failed).toMatchObject({ status: "failed", attemptCount: 3, leaseOwner: null, failureCode: "REPORT_STORAGE_UNAVAILABLE" });
    expect(failed.documentSnapshot).toEqual(first.documentSnapshot);
    expect(failed.dataSnapshot).toEqual(first.dataSnapshot);
    expect(await worker.runOnce()).toBe(false);
    expect(putKeys.map(key => key.slice(key.lastIndexOf("/") + 1))).toEqual(["attempt-1.xlsx", "attempt-2.xlsx", "attempt-3.xlsx"]);
    expect(objects.size).toBe(0);
  });

  it.each([{ ContentLength: 1 }, { ChecksumSHA256: "wrong" }, { ChecksumSHA256: undefined }, { ContentType: "text/plain" }])(
    "does not complete a HEAD verification mismatch %j", async mismatch => {
      const job = await enqueue(); headOverride = mismatch;
      await worker.runOnce();
      expect(await load(job.id)).toMatchObject({ status: "queued", attemptCount: 1, objectKey: null, completedAt: null });
      expect(objects.size).toBe(0);
    }
  );

  it("fences a stale upload owner from completion or state changes after a new worker reclaims its expired lease", async () => {
    const job = await enqueue();
    const other = makeWorker();
    putHook = async () => {
      await expire(job.id);
      expect(await other.claimNext()).toMatchObject({ id: job.id, attemptCount: 2 });
    };
    await worker.runOnce();
    expect(await load(job.id)).toMatchObject({ status: "processing", attemptCount: 2, objectKey: null, progressPercent: 1 });
    expect(objects.has(`reports/${siteId}/${job.id}/attempt-2.xlsx`)).toBe(false);
  });

  it("does not renew or complete an expired lease even if nobody reclaimed it yet", async () => {
    const job = await enqueue();
    putHook = async () => { await expire(job.id); };
    await worker.runOnce();
    expect(await load(job.id)).toMatchObject({ status: "processing", attemptCount: 1, objectKey: null, completedAt: null });
  });

  it("renews a live lease during slow storage and prevents overlapping local polls", async () => {
    const job = await enqueue();
    // Both inserts can share the same millisecond; explicitly order the waiting job
    // so this test never relies on random UUID ordering for equal createdAt values.
    const waiting = await enqueue("xlsx", { createdAt: new Date(Date.now() + 1000) });
    putHook = async () => {
      const before = await load(job.id);
      expect(await worker.runOnce()).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 10_500));
      const after = await load(job.id);
      expect(after.leaseExpiresAt!.getTime() - before.leaseExpiresAt!.getTime()).toBeGreaterThan(9000);
      expect(after.attemptCount).toBe(1);
    };
    await worker.runOnce();
    expect(await load(job.id)).toMatchObject({ status: "completed", attemptCount: 1 });
    expect(await load(waiting.id)).toMatchObject({ status: "queued", attemptCount: 0 });
    expect(putKeys).toHaveLength(1);
  }, 20_000);

  it("dead-letters a third crashed attempt and never grants a fourth attempt", async () => {
    const job = await enqueue();
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await worker.claimNext()).toMatchObject({ id: job.id, attemptCount: attempt });
      await expire(job.id);
    }
    expect(await worker.claimNext()).toBeNull();
    expect(await load(job.id)).toMatchObject({ status: "failed", attemptCount: 3, leaseOwner: null, failureCode: "REPORT_ATTEMPTS_EXHAUSTED" });
  });

  it("leaves invalid completed-date requests without a document or uploaded object", async () => {
    const job = await enqueue("xlsx", { requestSnapshot: { from: "2099-01-01", to: "2099-01-02", scope: "site", identityId: siteId, format: "xlsx" } });
    await worker.runOnce();
    expect(await load(job.id)).toMatchObject({ status: "queued", documentSnapshot: null, objectKey: null });
    expect(putKeys).toEqual([]);
  });
});

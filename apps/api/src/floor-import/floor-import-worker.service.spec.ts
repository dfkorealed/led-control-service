import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FloorImportWorkerService } from "./floor-import-worker.service";

function claimedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(), floorId: randomUUID(), sourceAssetId: randomUUID(), renderedAssetId: null,
    sourceFormat: "dxf", status: "processing", stage: "downloading", progressPercent: 1,
    attemptCount: 1, parserVersion: null, detectorVersion: null, leaseOwner: "owner",
    leaseExpiresAt: new Date(Date.now() + 30_000), failureCode: null, failureMessage: null,
    startedAt: new Date(), reviewRequiredAt: null, appliedAt: null, completedAt: null,
    failedAt: null, cancelledAt: null, createdAt: new Date(), updatedAt: new Date(), ...overrides
  } as any;
}

describe("FloorImportWorkerService", () => {
  it("claims queued and expired processing work with SKIP LOCKED while retiring expired third attempts", async () => {
    const row = claimedJob();
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: row.id }])
        .mockResolvedValueOnce([row])
    };
    const worker = new FloorImportWorkerService(prisma, {} as any, {} as any, {} as any, {} as any, {
      tempRoot: tmpdir(), pollIntervalMs: 1000
    });
    await expect(worker.claimNext()).resolves.toMatchObject({ id: row.id, attemptCount: 1 });
    expect(prisma.$executeRaw.mock.calls[0][0].strings.join(" ")).toContain("attemptCount");
    expect(prisma.$queryRaw.mock.calls[1][0].strings.join(" ")).toContain("FOR UPDATE SKIP LOCKED");
    await worker.onModuleDestroy();
  });

  it("runs download -> converter -> parser -> rule detector -> disabled AI -> SVG -> private asset and candidate upsert", async () => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-test-"));
    const row = claimedJob();
    const source = { objectKey: `floors/${row.floorId}/source.dxf`, sizeBytes: BigInt(1024), sha256: "a".repeat(64), mimeType: "application/dxf" };
    const candidate = { sourceEntityId: "insert-1", layerName: "LIGHT", blockName: "LED", position: { x: 2, y: 3, z: 0 },
      rotation: 30, confidence: 0.95, method: "rule", evidence: ["layer_pattern"] };
    const dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n1\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n";
    const attempt = { jobId: row.id, floorId: row.floorId, attemptCount: row.attemptCount,
      assetId: randomUUID(), objectKey: `floors/${row.floorId}/${row.id}-attempt-${row.attemptCount}.svg` };
    const storageOrder: string[] = [];
    const finalTransactions: any[] = [];
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: row.id }])
        .mockResolvedValueOnce([row]),
      floorAsset: { findUniqueOrThrow: jest.fn().mockResolvedValue(source), findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (run: (tx: any) => unknown) => {
        const tx: any = {
          floorAsset: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          floorImportAttemptCleanup: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          floorImportCandidate: { upsert: jest.fn().mockResolvedValue({}) },
          $executeRaw: jest.fn().mockResolvedValue(1)
        };
        const result = await run(tx); finalTransactions.push(tx); return result;
      })
    };
    const storage: any = {
      downloadFloorAssetToFile: jest.fn(async (_key: string, path: string) => writeFile(path, dxf)),
      putFloorRenderedObject: jest.fn().mockImplementation(async () => { storageOrder.push("put"); }),
      verifyFloorRenderedObject: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined)
    };
    const converter: any = { convert: jest.fn(async ({ inputPath, outputPath }: any) => {
      await writeFile(outputPath, await readFile(inputPath));
      return { outputPath, outputBytes: Buffer.byteLength(dxf) };
    }) };
    const rules: any = { detect: jest.fn().mockResolvedValue([candidate]) };
    const disabledAi: any = { detect: jest.fn().mockResolvedValue([]) };
    const cleanup: any = {
      armAttempt: jest.fn().mockImplementation(async () => { storageOrder.push("ledger"); return attempt; }),
      requestCleanup: jest.fn()
    };
    const worker = new FloorImportWorkerService(prisma, storage, converter, rules, disabledAi,
      { tempRoot: root, pollIntervalMs: 1000 }, cleanup);
    try {
      await expect(worker.runOnce()).resolves.toBe(true);
      expect(storage.downloadFloorAssetToFile).toHaveBeenCalledWith(source.objectKey, expect.any(String), expect.objectContaining({
        expectedSha256: source.sha256, maxBytes: 50 * 1024 * 1024
      }));
      expect(converter.convert).toHaveBeenCalled();
      expect(rules.detect).toHaveBeenCalled();
      expect(disabledAi.detect).toHaveBeenCalled();
      expect(storageOrder).toEqual(["ledger", "put"]);
      expect(storage.putFloorRenderedObject).toHaveBeenCalledWith(
        attempt.objectKey, expect.any(Buffer),
        { width: 12, height: 12 }, expect.any(AbortSignal)
      );
      const finalTx = finalTransactions.at(-1);
      expect(finalTx.floorImportCandidate.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          detectionMethod: "rule_based", provider: null, model: null, inputDigest: null,
          x: 3, y: 8, rotation: -30
        })
      }));
      expect(finalTx).not.toHaveProperty("fixture");
      expect(finalTx).not.toHaveProperty("meshNode");
      const completionSql = finalTx.$executeRaw.mock.calls[0][0];
      expect(completionSql.strings.join(" ")).toContain("review_required");
      expect(finalTx.floorAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: attempt.assetId, objectKey: attempt.objectKey, status: "pending" },
        data: expect.objectContaining({ status: "ready" })
      }));
      expect(finalTx.floorImportAttemptCleanup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ jobId: row.id, attemptCount: row.attemptCount, committedAt: null }),
        data: expect.objectContaining({ committedAt: expect.any(Date) })
      }));
      expect(completionSql.values).toContain(attempt.assetId);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await worker.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("contains a failed attempt, retries at most three times, and removes terminal partial objects", async () => {
    const row = claimedJob({ attemptCount: 3 });
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValueOnce([{ id: row.id }]).mockResolvedValueOnce([row]),
      floorAsset: { findUniqueOrThrow: jest.fn().mockResolvedValue({ objectKey: "floors/f/source.dxf", sizeBytes: 10n, sha256: "a".repeat(64), mimeType: "application/dxf" }) }
    };
    const storage: any = { downloadFloorAssetToFile: jest.fn().mockRejectedValue(new Error("private path")), deleteObject: jest.fn() };
    const worker = new FloorImportWorkerService(prisma, storage, {} as any, {} as any, {} as any, { tempRoot: tmpdir(), pollIntervalMs: 1000 });
    await worker.runOnce();
    const failureSql = prisma.$executeRaw.mock.calls.at(-1)[0];
    expect(failureSql.strings.join(" ")).toContain("'failed'");
    expect(failureSql.values).not.toContain("private path");
    await worker.onModuleDestroy();
  });

  it("drains an active attempt on shutdown, aborts external work, and leaves the lease recoverable", async () => {
    const row = claimedJob(); let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValueOnce([{ id: row.id }]).mockResolvedValueOnce([row]),
      floorAsset: { findUniqueOrThrow: jest.fn().mockResolvedValue({ objectKey: "floors/f/source.dxf", sizeBytes: 10n, sha256: "a".repeat(64), mimeType: "application/dxf" }) }
    };
    const storage: any = { downloadFloorAssetToFile: jest.fn(async (_key: string, _path: string, options: any) => {
      entered();
      await Promise.race([gate, new Promise<void>((_, reject) => options.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
    }) };
    const worker = new FloorImportWorkerService(prisma, storage, {} as any, {} as any, {} as any, { tempRoot: tmpdir(), pollIntervalMs: 1000 });
    const running = worker.runOnce(); await started;
    await worker.onModuleDestroy(); release();
    await expect(running).resolves.toBe(true);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1); // Exhausted sweep only; no retry/failure write after shutdown.
  });

  it("defers an uploaded object interrupted by shutdown to its durable attempt ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-shutdown-test-"));
    const row = claimedJob();
    const dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n1\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n";
    let uploadEntered!: () => void;
    const uploading = new Promise<void>(resolve => { uploadEntered = resolve; });
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValueOnce([{ id: row.id }]).mockResolvedValueOnce([row]),
      floorAsset: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          objectKey: `floors/${row.floorId}/source.dxf`, sizeBytes: BigInt(Buffer.byteLength(dxf)),
          sha256: "a".repeat(64), mimeType: "application/dxf"
        }),
        findUnique: jest.fn().mockResolvedValue(null)
      }
    };
    const storage: any = {
      downloadFloorAssetToFile: jest.fn(async (_key: string, path: string) => writeFile(path, dxf)),
      putFloorRenderedObject: jest.fn(async (_key: string, _bytes: Buffer, _viewport: unknown, signal: AbortSignal) => {
        uploadEntered();
        await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }),
      deleteObject: jest.fn().mockResolvedValue(undefined)
    };
    const converter: any = { convert: jest.fn(async ({ inputPath, outputPath }: any) => {
      await writeFile(outputPath, await readFile(inputPath));
      return { outputPath, outputBytes: Buffer.byteLength(dxf) };
    }) };
    const detector: any = { detect: jest.fn().mockResolvedValue([]) };
    const cleanup: any = {
      armAttempt: jest.fn().mockResolvedValue({ jobId: row.id, floorId: row.floorId, attemptCount: row.attemptCount,
        assetId: randomUUID(), objectKey: `floors/${row.floorId}/${row.id}-attempt-${row.attemptCount}.svg` }),
      requestCleanup: jest.fn().mockResolvedValue("deferred")
    };
    const worker = new FloorImportWorkerService(prisma, storage, converter, detector, detector, {
      tempRoot: root, pollIntervalMs: 1000
    }, cleanup);
    try {
      const running = worker.runOnce();
      await uploading;
      const writesBeforeShutdown = prisma.$executeRaw.mock.calls.length;
      await worker.onModuleDestroy();
      await expect(running).resolves.toBe(true);
      expect(cleanup.requestCleanup).toHaveBeenCalledWith(expect.objectContaining({ jobId: row.id, attemptCount: row.attemptCount }));
      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(writesBeforeShutdown); // Leave the in-flight lease for expiry recovery.
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

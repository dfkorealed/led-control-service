import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FloorImportAttemptCleanupService, type FloorImportAttemptIdentity } from "./floor-import-attempt-cleanup.service";

const identity = (): FloorImportAttemptIdentity => {
  const floorId = randomUUID(); const jobId = randomUUID();
  return {
    jobId, floorId, attemptCount: 1, assetId: randomUUID(),
    objectKey: `floors/${floorId}/${jobId}-attempt-1.svg`
  };
};

describe("FloorImportAttemptCleanupService", () => {
  it("does not delete on an asset-ledger read error and leaves the durable attempt tombstone for reconciliation", async () => {
    const attempt = identity();
    const prisma: any = {
      floorAsset: { findUnique: jest.fn().mockRejectedValue(new Error("database unavailable")) },
      floorImportAttemptCleanup: { updateMany: jest.fn() }
    };
    const storage: any = { deleteObject: jest.fn() };
    const service = new FloorImportAttemptCleanupService(prisma, storage, { tempRoot: tmpdir(), pollIntervalMs: 1000 });

    await expect(service.requestCleanup(attempt)).resolves.toBe("deferred");
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(prisma.floorImportAttemptCleanup.updateMany).not.toHaveBeenCalled();
  });

  it("deletes immediately only after the database confirms that the attempt asset ledger is absent", async () => {
    const attempt = identity();
    const prisma: any = {
      floorAsset: { findUnique: jest.fn().mockResolvedValue(null) },
      floorImportAttemptCleanup: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const storage: any = { deleteObject: jest.fn().mockResolvedValue(undefined) };
    const service = new FloorImportAttemptCleanupService(prisma, storage, { tempRoot: tmpdir(), pollIntervalMs: 1000 });

    await expect(service.requestCleanup(attempt)).resolves.toBe("deleted");
    expect(storage.deleteObject).toHaveBeenCalledWith(attempt.objectKey);
    expect(prisma.floorImportAttemptCleanup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { jobId: attempt.jobId, attemptCount: attempt.attemptCount, committedAt: null, leaseOwner: null }
    }));
  });

  it("does not delete a confirmed-null object when the reconciliation tombstone cannot be claimed", async () => {
    const attempt = identity();
    const prisma: any = {
      floorAsset: { findUnique: jest.fn().mockResolvedValue(null) },
      floorImportAttemptCleanup: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }
    };
    const storage: any = { deleteObject: jest.fn() };
    const service = new FloorImportAttemptCleanupService(prisma, storage, { tempRoot: tmpdir(), pollIntervalMs: 1000 });

    await expect(service.requestCleanup(attempt)).resolves.toBe("deferred");
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("defers a pending attempt asset to its durable cleanup ledger instead of deleting inline", async () => {
    const attempt = identity();
    const prisma: any = {
      floorAsset: { findUnique: jest.fn().mockResolvedValue({
        id: attempt.assetId, objectKey: attempt.objectKey, status: "pending"
      }) },
      floorImportAttemptCleanup: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const storage: any = { deleteObject: jest.fn() };
    const service = new FloorImportAttemptCleanupService(prisma, storage, { tempRoot: tmpdir(), pollIntervalMs: 1000 });

    await expect(service.requestCleanup(attempt)).resolves.toBe("deferred");
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(prisma.floorImportAttemptCleanup.updateMany).toHaveBeenCalled();
  });

  it("preserves a ready asset when the final transaction committed but its response was lost", async () => {
    const attempt = identity();
    const prisma: any = {
      floorAsset: { findUnique: jest.fn().mockResolvedValue({
        id: attempt.assetId, objectKey: attempt.objectKey, status: "ready"
      }) },
      floorImportAttemptCleanup: { updateMany: jest.fn() }
    };
    const storage: any = { deleteObject: jest.fn() };
    const service = new FloorImportAttemptCleanupService(prisma, storage, { tempRoot: tmpdir(), pollIntervalMs: 1000 });

    await expect(service.requestCleanup(attempt)).resolves.toBe("retained");
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(prisma.floorImportAttemptCleanup.updateMany).not.toHaveBeenCalled();
  });

  it("does not remove the pending asset ledger after cleanup lease ownership is lost", async () => {
    const attempt = identity();
    const cleanup = {
      ...attempt,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: new Date(),
      lastCleanedAt: null,
      lastError: null,
      committedAt: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const tx = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: attempt.assetId, objectKey: attempt.objectKey, status: "pending" }])
        .mockResolvedValueOnce([]),
      floorAsset: { deleteMany: jest.fn() },
      floorImportAttemptCleanup: { updateMany: jest.fn() }
    };
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValueOnce([cleanup]).mockResolvedValueOnce([]),
      $transaction: jest.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
      floorAsset: { findUnique: jest.fn().mockResolvedValue({
        id: attempt.assetId, objectKey: attempt.objectKey, status: "pending"
      }) },
      floorImportJob: { findFirst: jest.fn().mockResolvedValue(null) },
      floorImportAttemptCleanup: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }
    };
    const storage: any = { deleteObject: jest.fn().mockResolvedValue(undefined) };
    const service = new FloorImportAttemptCleanupService(prisma, storage, { tempRoot: tmpdir(), pollIntervalMs: 1000 });

    await service.sweepAttempts(new Date("2026-09-17T12:00:00.000Z"));

    expect(storage.deleteObject).toHaveBeenCalledWith(attempt.objectKey);
    expect(tx.floorAsset.deleteMany).not.toHaveBeenCalled();
    expect(tx.floorImportAttemptCleanup.updateMany).not.toHaveBeenCalled();
  });

  it("removes only stale owned temp directories and preserves fresh or unrelated paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-cleanup-test-"));
    const stale = join(root, `floor-import-${randomUUID()}-attempt-1-stale`);
    const fresh = join(root, `floor-import-${randomUUID()}-attempt-1-fresh`);
    const unrelated = join(root, "other-temp");
    await Promise.all([mkdir(stale), mkdir(fresh), mkdir(unrelated)]);
    const now = new Date("2026-09-17T12:00:00.000Z");
    await utimes(stale, new Date(now.getTime() - 16 * 60_000), new Date(now.getTime() - 16 * 60_000));
    await utimes(fresh, new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));
    const service = new FloorImportAttemptCleanupService({} as any, {} as any, { tempRoot: root, pollIntervalMs: 1000 });
    try {
      await expect(service.sweepStaleTemp(now)).resolves.toEqual({ scanned: 2, deleted: 1 });
      await expect(access(stale)).rejects.toThrow();
      await expect(access(fresh)).resolves.toBeUndefined();
      await expect(access(unrelated)).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("runs reconciliation at startup and periodically, then drains it on shutdown", async () => {
    jest.useFakeTimers();
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const service = new FloorImportAttemptCleanupService({} as any, {} as any, { tempRoot: tmpdir(), pollIntervalMs: 1000 });
    const attempts = jest.spyOn(service, "sweepAttempts").mockResolvedValue(undefined);
    const temp = jest.spyOn(service, "sweepStaleTemp").mockResolvedValue({ scanned: 0, deleted: 0 });
    try {
      service.onModuleInit();
      await (service as any).activeSweep; await Promise.resolve();
      expect(attempts).toHaveBeenCalledTimes(1);
      expect(temp).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(60_000);
      await (service as any).activeSweep; await Promise.resolve();
      expect(attempts).toHaveBeenCalledTimes(2);
      expect(temp).toHaveBeenCalledTimes(2);
      await service.onModuleDestroy();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      jest.useRealTimers();
    }
  });
});

import { FloorAssetCleanupService } from "./floor-asset-cleanup.service";

describe("FloorAssetCleanupService", () => {
  it("claims expired pending uploads before deleting the object and ledger row", async () => {
    const expiredAt = new Date("2026-09-12T00:00:05.000Z");
    const now = new Date("2026-09-12T00:00:10.000Z");
    const prisma: any = {
      floorAsset: {
        findMany: jest.fn()
          .mockResolvedValueOnce([{ id: "asset-1", objectKey: "floors/floor-1/file.png" }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      $queryRaw: jest.fn().mockResolvedValue([])
    };
    const storage: any = { deleteObject: jest.fn().mockResolvedValue(undefined) };
    const service = new FloorAssetCleanupService(prisma, storage);

    await expect(service.processPending(now)).resolves.toEqual({ processed: 1, deleted: 1 });
    expect(prisma.floorAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "pending",
        OR: expect.arrayContaining([{ uploadExpiresAt: { lte: expiredAt } }])
      }),
      take: 25
    }));
    expect(storage.deleteObject).toHaveBeenCalledWith("floors/floor-1/file.png");
    expect(prisma.floorAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: "asset-1", status: "pending", cleanupStartedAt: now }
    });
  });

  it("releases the cleanup claim when object deletion fails", async () => {
    const now = new Date("2026-09-12T00:00:10.000Z");
    const prisma: any = {
      floorAsset: {
        findMany: jest.fn()
          .mockResolvedValueOnce([{ id: "asset-1", objectKey: "floors/floor-1/file.png" }]),
        updateMany: jest.fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 1 }),
        deleteMany: jest.fn()
      },
      $queryRaw: jest.fn().mockResolvedValue([])
    };
    const storage: any = { deleteObject: jest.fn().mockRejectedValue(new Error("storage unavailable")) };
    const service = new FloorAssetCleanupService(prisma, storage);

    await expect(service.processPending(now)).resolves.toEqual({ processed: 1, deleted: 0 });
    expect(prisma.floorAsset.updateMany).toHaveBeenLastCalledWith({
      where: { id: "asset-1", status: "pending", cleanupStartedAt: now },
      data: { cleanupStartedAt: null }
    });
    expect(prisma.floorAsset.deleteMany).not.toHaveBeenCalled();
  });

  it("recovers ledgers abandoned before their signed URL expiry was persisted", async () => {
    const now = new Date("2026-09-12T01:00:00.000Z");
    const prisma: any = {
      floorAsset: {
        findMany: jest.fn()
          .mockResolvedValueOnce([])
      },
      $queryRaw: jest.fn().mockResolvedValue([])
    };
    const service = new FloorAssetCleanupService(prisma, { deleteObject: jest.fn() } as any);

    await service.processPending(now);

    expect(prisma.floorAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { uploadExpiresAt: null, createdAt: { lte: new Date("2026-09-12T00:45:00.000Z") } }
        ])
      })
    }));
  });

  it("claims and deletes unreferenced ready assets only after the 24 hour grace period", async () => {
    const now = new Date("2026-09-13T00:00:00.000Z");
    const graceAt = new Date("2026-09-12T00:00:00.000Z");
    const candidate = {
      id: "asset-ready",
      floorId: "floor-1",
      objectKey: "floors/floor-1/ready.png"
    };
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([candidate])
        .mockResolvedValueOnce([{ referenced: false }]),
      floorAsset: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const prisma: any = {
      floorAsset: {
        findMany: jest.fn()
          .mockResolvedValueOnce([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn()
      },
      $queryRaw: jest.fn().mockResolvedValue([candidate]),
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx))
    };
    const storage: any = { deleteObject: jest.fn().mockResolvedValue(undefined) };
    const service = new FloorAssetCleanupService(prisma, storage);

    await expect(service.processPending(now)).resolves.toEqual({ processed: 1, deleted: 1 });

    expect(prisma.$queryRaw.mock.calls[0][0].values).toContainEqual(graceAt);
    expect(storage.deleteObject).toHaveBeenCalledWith(candidate.objectKey);
    expect(prisma.floorAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: candidate.id, status: "ready", cleanupStartedAt: now }
    });
  });

  it("does not claim or delete a ready asset referenced by a floor plan or revision", async () => {
    const now = new Date("2026-09-13T00:00:00.000Z");
    const candidate = {
      id: "asset-ready",
      floorId: "floor-1",
      objectKey: "floors/floor-1/ready.png"
    };
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([candidate])
        .mockResolvedValueOnce([{ referenced: true }]),
      floorAsset: { updateMany: jest.fn() }
    };
    const prisma: any = {
      floorAsset: {
        findMany: jest.fn()
          .mockResolvedValueOnce([]),
        deleteMany: jest.fn(),
        updateMany: jest.fn()
      },
      $queryRaw: jest.fn().mockResolvedValue([candidate]),
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx))
    };
    const storage: any = { deleteObject: jest.fn() };
    const service = new FloorAssetCleanupService(prisma, storage);

    await expect(service.processPending(now)).resolves.toEqual({ processed: 1, deleted: 0 });

    expect(tx.floorAsset.updateMany).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(prisma.floorAsset.deleteMany).not.toHaveBeenCalled();
  });
});

import { FloorAssetCleanupService } from "./floor-asset-cleanup.service";

describe("FloorAssetCleanupService", () => {
  it("claims expired pending uploads before deleting the object and ledger row", async () => {
    const expiredAt = new Date("2026-09-12T00:00:05.000Z");
    const now = new Date("2026-09-12T00:00:10.000Z");
    const candidate = { id: "asset-1", floorId: "floor-1", objectKey: "floors/floor-1/file.png", cleanupStartedAt: null };
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([candidate]),
      floorAsset: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const prisma: any = {
      floorAsset: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      $queryRaw: jest.fn().mockResolvedValueOnce([candidate]).mockResolvedValueOnce([]),
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx))
    };
    const storage: any = { deleteObject: jest.fn().mockResolvedValue(undefined) };
    const service = new FloorAssetCleanupService(prisma, storage);

    await expect(service.processPending(now)).resolves.toEqual({ processed: 1, deleted: 1 });
    expect(prisma.$queryRaw.mock.calls[0][0].values).toContainEqual(expiredAt);
    expect(prisma.$queryRaw.mock.calls[0][0].strings.join(" ")).toContain('FROM "FloorImportAttemptCleanup"');
    expect(tx.$queryRaw.mock.calls[0][0].strings.join(" ")).toContain("FOR UPDATE OF floor, asset");
    expect(storage.deleteObject).toHaveBeenCalledWith("floors/floor-1/file.png");
    expect(prisma.floorAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: "asset-1", status: "pending", cleanupStartedAt: now }
    });
  });

  it("releases the cleanup claim when object deletion fails", async () => {
    const now = new Date("2026-09-12T00:00:10.000Z");
    const candidate = { id: "asset-1", floorId: "floor-1", objectKey: "floors/floor-1/file.png", cleanupStartedAt: null };
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([candidate]),
      floorAsset: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const prisma: any = {
      floorAsset: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn()
      },
      $queryRaw: jest.fn().mockResolvedValueOnce([candidate]).mockResolvedValueOnce([]),
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx))
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
      floorAsset: {},
      $queryRaw: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([])
    };
    const service = new FloorAssetCleanupService(prisma, { deleteObject: jest.fn() } as any);

    await service.processPending(now);

    expect(prisma.$queryRaw.mock.calls[0][0].values)
      .toContainEqual(new Date("2026-09-12T00:45:00.000Z"));
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
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn()
      },
      $queryRaw: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([candidate]),
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx))
    };
    const storage: any = { deleteObject: jest.fn().mockResolvedValue(undefined) };
    const service = new FloorAssetCleanupService(prisma, storage);

    await expect(service.processPending(now)).resolves.toEqual({ processed: 1, deleted: 1 });

    expect(prisma.$queryRaw.mock.calls[1][0].values).toContainEqual(graceAt);
    expect(storage.deleteObject).toHaveBeenCalledWith(candidate.objectKey);
    expect(prisma.floorAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: candidate.id, status: "ready", cleanupStartedAt: now }
    });
  });

  it("keeps the ready cleanup claim when object deletion fails", async () => {
    const now = new Date("2026-09-13T00:00:00.000Z");
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
        deleteMany: jest.fn(),
        updateMany: jest.fn()
      },
      $queryRaw: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([candidate]),
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx))
    };
    const storage: any = { deleteObject: jest.fn().mockRejectedValue(new Error("storage unavailable")) };
    const service = new FloorAssetCleanupService(prisma, storage);

    await expect(service.processPending(now)).resolves.toEqual({ processed: 1, deleted: 0 });

    expect(prisma.floorAsset.updateMany).not.toHaveBeenCalled();
    expect(prisma.floorAsset.deleteMany).not.toHaveBeenCalled();
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
        deleteMany: jest.fn(),
        updateMany: jest.fn()
      },
      $queryRaw: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([candidate]),
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx))
    };
    const storage: any = { deleteObject: jest.fn() };
    const service = new FloorAssetCleanupService(prisma, storage);

    await expect(service.processPending(now)).resolves.toEqual({ processed: 1, deleted: 0 });

    expect(tx.floorAsset.updateMany).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(prisma.floorAsset.deleteMany).not.toHaveBeenCalled();
  });

  it("excludes source and rendered assets referenced by an import job before cleanup claim", async () => {
    const prisma: any = {
      floorAsset: {},
      $queryRaw: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([])
    };
    const service = new FloorAssetCleanupService(prisma, { deleteObject: jest.fn() } as any);
    await service.processPending(new Date("2026-09-17T00:00:00.000Z"));
    const pendingSql = prisma.$queryRaw.mock.calls[0][0].strings.join(" ");
    expect(pendingSql).toContain('FROM "FloorImportAttemptCleanup"');
    expect(pendingSql).toContain('attempt."assetId" = asset."id"');
    const readySql = prisma.$queryRaw.mock.calls[1][0].strings.join(" ");
    expect(readySql).toContain('FROM "FloorImportJob"');
    expect(readySql).toContain('job."sourceAssetId" = asset."id"');
    expect(readySql).toContain('job."renderedAssetId" = asset."id"');
    expect(readySql).toContain('FROM "FloorImportRegion"');
    expect(readySql).toContain('region."previewAssetId" = asset."id"');
    expect(readySql).toContain('FROM "FloorCadScene"');
    expect(readySql).toContain('scene."manifestAssetId" = asset."id"');
    expect(readySql).toContain('FROM "FloorCadTile"');
    expect(readySql).toContain('tile."assetId" = asset."id"');
  });
});

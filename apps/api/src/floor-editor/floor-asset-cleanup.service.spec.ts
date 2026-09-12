import { FloorAssetCleanupService } from "./floor-asset-cleanup.service";

describe("FloorAssetCleanupService", () => {
  it("claims expired pending uploads before deleting the object and ledger row", async () => {
    const expiredAt = new Date("2026-09-12T00:00:05.000Z");
    const now = new Date("2026-09-12T00:00:10.000Z");
    const prisma: any = {
      floorAsset: {
        findMany: jest.fn().mockResolvedValue([{ id: "asset-1", objectKey: "floors/floor-1/file.png" }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    const storage: any = { deleteObject: jest.fn().mockResolvedValue(undefined) };
    const service = new FloorAssetCleanupService(prisma, storage);

    await expect(service.processPending(now)).resolves.toEqual({ processed: 1, deleted: 1 });
    expect(prisma.floorAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "pending", uploadExpiresAt: { lte: expiredAt } }),
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
        findMany: jest.fn().mockResolvedValue([{ id: "asset-1", objectKey: "floors/floor-1/file.png" }]),
        updateMany: jest.fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 1 }),
        deleteMany: jest.fn()
      }
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
});

import { SiteDeletionCleanupService } from "./site-deletion-cleanup.service";

describe("SiteDeletionCleanupService", () => {
  it("deletes assets, revokes every inventory certificate, and completes the durable job", async () => {
    const prisma = createPrisma({
      id: "cleanup-1",
      objectKeys: ["floors/floor-1/map.png"],
      inventoryIds: ["inventory-1"],
      attempts: 1,
      createdAt: new Date(Date.now() - 10 * 60 * 1_000)
    });
    const storage = { deleteObject: jest.fn().mockResolvedValue({}) };
    const certificates = { revokeInventoryCertificates: jest.fn().mockResolvedValue({ revoked: 2 }) };
    const service = new SiteDeletionCleanupService(prisma as never, certificates as never, storage as never);

    await expect(service.processNow("cleanup-1")).resolves.toEqual({ status: "completed" });

    expect(storage.deleteObject).toHaveBeenCalledWith("floors/floor-1/map.png");
    expect(certificates.revokeInventoryCertificates).toHaveBeenCalledWith("inventory-1");
    expect(prisma.siteDeletionCleanup.update).toHaveBeenCalledWith({
      where: { id: "cleanup-1" },
      data: { completedAt: expect.any(Date), lockedAt: null, leaseExpiresAt: null, lastError: null }
    });
  });

  it("keeps a failed cleanup pending with a bounded retry and sanitized error", async () => {
    const prisma = createPrisma({
      id: "cleanup-1",
      objectKeys: ["floors/floor-1/map.png"],
      inventoryIds: [],
      attempts: 1,
      createdAt: new Date(Date.now() - 10 * 60 * 1_000)
    });
    const storage = { deleteObject: jest.fn().mockRejectedValue(new Error("secret endpoint detail")) };
    const service = new SiteDeletionCleanupService(
      prisma as never,
      { revokeInventoryCertificates: jest.fn() } as never,
      storage as never
    );

    await expect(service.processNow("cleanup-1")).resolves.toEqual({ status: "pending" });
    expect(prisma.siteDeletionCleanup.update).toHaveBeenCalledWith({
      where: { id: "cleanup-1" },
      data: expect.objectContaining({
        nextAttemptAt: expect.any(Date),
        lockedAt: null,
        leaseExpiresAt: null,
        lastError: "EXTERNAL_CLEANUP_FAILED"
      })
    });
  });

  it("does not process a job already leased by another API instance", async () => {
    const prisma = createPrisma({
      id: "cleanup-1", objectKeys: [], inventoryIds: [], attempts: 1, createdAt: new Date()
    });
    prisma.siteDeletionCleanup.updateMany.mockResolvedValue({ count: 0 });
    const storage = { deleteObject: jest.fn() };
    const service = new SiteDeletionCleanupService(
      prisma as never,
      { revokeInventoryCertificates: jest.fn() } as never,
      storage as never
    );

    await expect(service.processNow("cleanup-1")).resolves.toEqual({ status: "skipped" });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("waits for outstanding presigned upload URLs to expire before deleting objects", async () => {
    const prisma = createPrisma({
      id: "cleanup-1",
      objectKeys: ["floors/floor-1/pending.png"],
      inventoryIds: ["inventory-1"],
      attempts: 1,
      createdAt: new Date()
    });
    const storage = { deleteObject: jest.fn() };
    const certificates = { revokeInventoryCertificates: jest.fn().mockResolvedValue({ revoked: 1 }) };
    const service = new SiteDeletionCleanupService(prisma as never, certificates as never, storage as never);

    await expect(service.processNow("cleanup-1")).resolves.toEqual({ status: "pending" });

    expect(certificates.revokeInventoryCertificates).toHaveBeenCalledWith("inventory-1");
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(prisma.siteDeletionCleanup.update).toHaveBeenCalledWith({
      where: { id: "cleanup-1" },
      data: expect.objectContaining({
        nextAttemptAt: expect.any(Date),
        lastError: "UPLOAD_URL_EXPIRY_PENDING"
      })
    });
  });
});

function createPrisma(job: { id: string; objectKeys: string[]; inventoryIds: string[]; attempts: number; createdAt: Date }) {
  return {
    siteDeletionCleanup: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockResolvedValue(job),
      findMany: jest.fn().mockResolvedValue([])
    }
  };
}

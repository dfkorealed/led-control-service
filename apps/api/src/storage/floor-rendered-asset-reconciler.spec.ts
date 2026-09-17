import { FloorRenderedAssetReconciler } from "./floor-rendered-asset-reconciler";

const asset = {
  id: "asset-1",
  objectKey: "floors/floor-1/render.svg",
  mimeType: "image/svg+xml",
  contentEncoding: "unknown",
  sizeBytes: 128n,
  sha256: "a".repeat(64)
};

describe("FloorRenderedAssetReconciler", () => {
  it.each([null, "gzip"] as const)("atomically reconciles an unknown ledger to %s", async contentEncoding => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ contentEncoding }]),
      floorAsset: { findUnique: jest.fn() }
    };
    const storage: any = {
      inspectFloorRenderedMetadata: jest.fn().mockResolvedValue({ width: 41, height: 29, contentEncoding })
    };

    await expect(new FloorRenderedAssetReconciler(prisma, storage).reconcile(asset))
      .resolves.toEqual({ width: 41, height: 29, contentEncoding });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.floorAsset.findUnique).not.toHaveBeenCalled();
  });

  it("does not mutate the ledger when HEAD fails or metadata does not match", async () => {
    const prisma: any = { $queryRaw: jest.fn() };
    const storage: any = {
      inspectFloorRenderedMetadata: jest.fn().mockRejectedValue(new Error("HEAD mismatch"))
    };

    await expect(new FloorRenderedAssetReconciler(prisma, storage).reconcile(asset)).rejects.toThrow("HEAD mismatch");
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("accepts a concurrent reconciliation only when the committed encoding matches HEAD", async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      floorAsset: { findUnique: jest.fn().mockResolvedValue({ ...asset, contentEncoding: "gzip" }) }
    };
    const storage: any = {
      inspectFloorRenderedMetadata: jest.fn().mockResolvedValue({ width: 41, height: 29, contentEncoding: "gzip" })
    };
    const reconciler = new FloorRenderedAssetReconciler(prisma, storage);

    await expect(reconciler.reconcile(asset)).resolves.toEqual({ width: 41, height: 29, contentEncoding: "gzip" });
    prisma.floorAsset.findUnique.mockResolvedValueOnce({ ...asset, contentEncoding: null });
    await expect(reconciler.reconcile(asset)).rejects.toThrow("changed concurrently");
  });

  it("keeps known identity and gzip ledgers on exact HEAD verification without a DB write", async () => {
    const prisma: any = { $queryRaw: jest.fn() };
    const storage: any = {
      readFloorRenderedMetadata: jest.fn().mockResolvedValue({ width: 41, height: 29 })
    };
    const reconciler = new FloorRenderedAssetReconciler(prisma, storage);

    await expect(reconciler.reconcile({ ...asset, contentEncoding: null }))
      .resolves.toEqual({ width: 41, height: 29, contentEncoding: null });
    await expect(reconciler.reconcile({ ...asset, contentEncoding: "gzip" }))
      .resolves.toEqual({ width: 41, height: 29, contentEncoding: "gzip" });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

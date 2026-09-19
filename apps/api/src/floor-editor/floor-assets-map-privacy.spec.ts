import { NotFoundException } from "@nestjs/common";
import { FloorAssetsController } from "./floor-assets.controller";
import { FloorAssetsService } from "./floor-assets.service";

const mapKinds = ["map_manifest", "map_chunk", "map_index", "map_changeset", "map_stage_part",
  "map_display_manifest", "map_display_tile"];

function fixture() {
  // Ready describes uploaded bytes, not a published generation. No current
  // document exists in this fixture; these belong to an uncommitted preparation.
  const assets = [...mapKinds, "original", "rendered", "cad_region_preview"].map(kind => ({
    id: kind, floorId: "floor", kind, status: "ready", objectKey: `floors/floor/${kind}`,
    mimeType: "application/octet-stream", contentEncoding: null, sizeBytes: 10n,
    sha256: "a".repeat(64), cleanupStartedAt: null
  }));
  const matches = (asset: typeof assets[number], where: any) =>
    (!where.id || asset.id === where.id) && asset.floorId === where.floorId &&
    (!where.status || asset.status === where.status) &&
    (!where.kind?.in || where.kind.in.includes(asset.kind)) &&
    (!where.kind?.notIn || !where.kind.notIn.includes(asset.kind));
  const prisma = {
    floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor", siteId: "site" }) },
    floorAsset: {
      findMany: jest.fn(async ({ where }) => assets.filter(asset => matches(asset, where))),
      findFirst: jest.fn(async ({ where }) => assets.find(asset => matches(asset, where)) ?? null),
      update: jest.fn()
    },
    $transaction: jest.fn(async (work: (tx: unknown) => unknown): Promise<unknown> => work(prisma)),
    $queryRaw: jest.fn().mockResolvedValue([{ floorStatus: "active" }])
  };
  const access = { assert: jest.fn(), assertManageInTransaction: jest.fn() };
  const storage = { createFloorAssetDownloadUrl: jest.fn().mockResolvedValue("https://signed.example"), headObject: jest.fn() };
  const controller = new FloorAssetsController(new FloorAssetsService(prisma as never, storage as never, access as never));
  return { assets, prisma, storage, controller };
}

describe("legacy asset routes exclude unpublished map assets", () => {
  it("lists only legacy public kinds while a map generation is prepared", async () => {
    const { controller } = fixture();
    const listed = await controller.listAssets("floor", {} as never);
    expect(listed.map(asset => asset.kind)).toEqual(["original", "rendered", "cad_region_preview"]);
  });

  it.each(mapKinds)("does not sign %s through the generic content route", async kind => {
    const { controller, storage } = fixture();
    await expect(controller.content("floor", kind, {} as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.createFloorAssetDownloadUrl).not.toHaveBeenCalled();
  });

  it.each(mapKinds)("does not expose ready %s through idempotent upload completion", async kind => {
    const { controller, storage, prisma } = fixture();
    await expect(controller.completeUpload("floor", kind, {} as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(mapKinds)("does not promote pending %s through upload completion", async kind => {
    const { controller, assets, storage, prisma } = fixture();
    assets.find(asset => asset.kind === kind)!.status = "pending";
    await expect(controller.completeUpload("floor", kind, {} as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(prisma.floorAsset.update).not.toHaveBeenCalled();
  });

  it("defensively refuses internal and unknown kinds even if a query returns them", async () => {
    const { controller, prisma, storage, assets } = fixture();
    const internal = [...assets.filter(asset => mapKinds.includes(asset.kind)),
      { ...assets[0], id: "future", kind: "future_internal" }];
    prisma.floorAsset.findMany.mockResolvedValue(internal);
    await expect(controller.listAssets("floor", {} as never)).resolves.toEqual([]);
    for (const asset of internal) {
      prisma.floorAsset.findFirst.mockResolvedValue(asset);
      await expect(controller.content("floor", asset.id, {} as never)).rejects.toBeInstanceOf(NotFoundException);
      await expect(controller.completeUpload("floor", asset.id, {} as never)).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(storage.createFloorAssetDownloadUrl).not.toHaveBeenCalled();
    expect(storage.headObject).not.toHaveBeenCalled();
  });

  it("rechecks the allowed kind after locking a pending upload", async () => {
    const { controller, assets, prisma, storage } = fixture();
    const asset = assets.find(value => value.kind === "original")!;
    asset.status = "pending";
    storage.headObject.mockResolvedValue({ ContentType: asset.mimeType, ContentLength: 10,
      ChecksumSHA256: Buffer.from(asset.sha256, "hex").toString("base64") });
    prisma.$queryRaw.mockResolvedValue([{ ...asset, kind: "map_chunk", floorStatus: "active" }]);
    await expect(controller.completeUpload("floor", asset.id, {} as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.headObject).toHaveBeenCalledTimes(1);
    expect(prisma.floorAsset.update).not.toHaveBeenCalled();
  });
});

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { FloorAssetsService } from "./floor-assets.service";

describe("FloorAssetsService", () => {
  it("creates a pending tenant-scoped upload intent", async () => {
    const prisma: any = {
      floor: { findFirst: jest.fn().mockResolvedValue({ id: "floor-1" }) },
      floorAsset: { create: jest.fn().mockResolvedValue({ id: "asset-1", status: "pending" }) }
    };
    const storage: any = {
      createUploadDescriptor: jest.fn().mockResolvedValue({
        objectKey: "floors/floor-1/file.png",
        uploadUrl: "https://signed.example",
        publicUrl: "https://assets.example/floors/floor-1/file.png",
        expiresInSeconds: 300
      })
    };
    const service = new FloorAssetsService(prisma, storage);

    await expect(
      service.createUploadIntent("floor-1", "org-1", {
        kind: "original",
        mimeType: "image/png",
        sizeBytes: 1024,
        sha256: "a".repeat(64)
      })
    ).resolves.toMatchObject({ assetId: "asset-1", uploadUrl: "https://signed.example" });
    expect(prisma.floorAsset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        floorId: "floor-1",
        kind: "original",
        status: "pending",
        sizeBytes: 1024n,
        objectKey: "floors/floor-1/file.png"
      })
    });
  });

  it("marks an upload ready only after object metadata matches", async () => {
    const checksum = "a".repeat(64);
    const prisma: any = {
      floorAsset: {
        findFirst: jest.fn().mockResolvedValue({
          id: "asset-1",
          objectKey: "floors/floor-1/file.png",
          mimeType: "image/png",
          sizeBytes: 1024n,
          sha256: checksum,
          publicUrl: "https://assets.example/file.png",
          status: "pending"
        }),
        update: jest.fn().mockResolvedValue({ id: "asset-1", status: "ready", publicUrl: "https://assets.example/file.png" })
      }
    };
    const storage: any = {
      headObject: jest.fn().mockResolvedValue({
        ContentType: "image/png",
        ContentLength: 1024,
        ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64")
      })
    };

    await expect(new FloorAssetsService(prisma, storage).completeUpload("floor-1", "asset-1", "org-1")).resolves.toMatchObject({
      id: "asset-1",
      status: "ready"
    });
  });

  it("rejects checksum mismatch and cross-tenant assets", async () => {
    const asset = {
      id: "asset-1",
      objectKey: "file.png",
      mimeType: "image/png",
      sizeBytes: 10n,
      sha256: "a".repeat(64),
      status: "pending"
    };
    const prisma: any = {
      floorAsset: { findFirst: jest.fn().mockResolvedValue(asset), update: jest.fn() }
    };
    const storage: any = {
      headObject: jest.fn().mockResolvedValue({ ContentType: "image/png", ContentLength: 10, ChecksumSHA256: "wrong" })
    };
    await expect(new FloorAssetsService(prisma, storage).completeUpload("floor-1", "asset-1", "org-1")).rejects.toBeInstanceOf(
      BadRequestException
    );

    prisma.floorAsset.findFirst.mockResolvedValue(null);
    await expect(new FloorAssetsService(prisma, storage).completeUpload("floor-1", "asset-other", "org-1")).rejects.toBeInstanceOf(
      NotFoundException
    );
  });
});

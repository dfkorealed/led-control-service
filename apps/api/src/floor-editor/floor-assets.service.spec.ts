import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { SiteAccessService } from "../access/site-access.service";
import { FloorAssetsService } from "./floor-assets.service";

describe("FloorAssetsService", () => {
  const admin: AuthenticatedUser = {
    id: "admin-1", organizationId: "customer-org", organizationType: "customer", email: "admin@example.com",
    name: "Admin", role: "admin", status: "active"
  };
  const viewer: AuthenticatedUser = { ...admin, id: "viewer-1", role: "viewer" };

  it("allows a customer admin to create an upload intent but rejects a viewer", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: { create: jest.fn().mockResolvedValue({ id: "asset-1", status: "pending" }) }
    };
    const storage: any = {
      createUploadDescriptor: jest.fn().mockResolvedValue({
        objectKey: "floors/floor-1/file.png", uploadUrl: "https://signed.example", publicUrl: "https://assets.example/file.png", expiresInSeconds: 300
      })
    };
    const siteAccess = { assert: jest.fn().mockImplementation((user: AuthenticatedUser, _siteId: string, capability: string) => {
      if (capability === "manage" && user.role === "viewer") throw new ForbiddenException();
      return { id: "site-1" };
    }) } as unknown as SiteAccessService;
    const service = new FloorAssetsService(prisma, storage, siteAccess);
    const uploadInput = { kind: "original" as const, mimeType: "image/png", sizeBytes: 1024, sha256: "a".repeat(64) };

    await expect(service.createUploadIntent(admin, "floor-1", uploadInput)).resolves.toBeDefined();
    await expect(service.createUploadIntent(viewer, "floor-1", uploadInput)).rejects.toBeInstanceOf(ForbiddenException);
    expect((siteAccess as any).assert).toHaveBeenNthCalledWith(1, admin, "site-1", "manage");
    expect((siteAccess as any).assert).toHaveBeenNthCalledWith(2, viewer, "site-1", "manage");
  });

  it("uses read access when listing ready floor assets", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: { findMany: jest.fn().mockResolvedValue([{ id: "asset-1", status: "ready" }]) }
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    const service = new FloorAssetsService(prisma, {} as any, siteAccess as unknown as SiteAccessService);

    await expect(service.listAssets(viewer, "floor-1")).resolves.toEqual([{ id: "asset-1", status: "ready" }]);
    expect(siteAccess.assert).toHaveBeenCalledWith(viewer, "site-1", "read");
  });
  it("creates a pending tenant-scoped upload intent", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
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
    const service = new FloorAssetsService(prisma, storage, { assert: jest.fn().mockResolvedValue({ id: "site-1" }) } as unknown as SiteAccessService);

    await expect(
      service.createUploadIntent(admin, "floor-1", {
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
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
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

    await expect(new FloorAssetsService(prisma, storage, { assert: jest.fn().mockResolvedValue({ id: "site-1" }) } as unknown as SiteAccessService).completeUpload(admin, "floor-1", "asset-1")).resolves.toMatchObject({
      id: "asset-1",
      status: "ready"
    });
  });

  it("requires manage access before completing an upload", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: { findFirst: jest.fn() }
    };
    const siteAccess = { assert: jest.fn().mockRejectedValue(new NotFoundException("site not found")) };
    const service = new FloorAssetsService(prisma, {} as any, siteAccess as unknown as SiteAccessService);

    await expect(service.completeUpload(admin, "floor-1", "asset-1")).rejects.toBeInstanceOf(NotFoundException);
    expect(siteAccess.assert).toHaveBeenCalledWith(admin, "site-1", "manage");
    expect(prisma.floorAsset.findFirst).not.toHaveBeenCalled();
  });

  it("returns an opaque 404 before listing assets for an inaccessible site", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-other" }) },
      floorAsset: { findMany: jest.fn() }
    };
    const siteAccess = { assert: jest.fn().mockRejectedValue(new NotFoundException("site not found")) };
    const service = new FloorAssetsService(prisma, {} as any, siteAccess as unknown as SiteAccessService);

    await expect(service.listAssets(admin, "floor-1")).rejects.toBeInstanceOf(NotFoundException);
    expect(siteAccess.assert).toHaveBeenCalledWith(admin, "site-other", "read");
    expect(prisma.floorAsset.findMany).not.toHaveBeenCalled();
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
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: { findFirst: jest.fn().mockResolvedValue(asset), update: jest.fn() }
    };
    const storage: any = {
      headObject: jest.fn().mockResolvedValue({ ContentType: "image/png", ContentLength: 10, ChecksumSHA256: "wrong" })
    };
    const service = new FloorAssetsService(prisma, storage, { assert: jest.fn().mockResolvedValue({ id: "site-1" }) } as unknown as SiteAccessService);
    await expect(service.completeUpload(admin, "floor-1", "asset-1")).rejects.toBeInstanceOf(
      BadRequestException
    );

    prisma.floorAsset.findFirst.mockResolvedValue(null);
    await expect(service.completeUpload(admin, "floor-1", "asset-other")).rejects.toBeInstanceOf(
      NotFoundException
    );
  });
});

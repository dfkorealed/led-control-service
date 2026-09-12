import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { SiteAccessService } from "../access/site-access.service";
import { FloorAssetsService } from "./floor-assets.service";

describe("FloorAssetsService", () => {
  const admin: AuthenticatedUser = {
    id: "admin-1", organizationId: "customer-org", organizationType: "customer", loginId: "fixture_user",
    name: "Admin", role: "admin", mustChangePassword: false, status: "active"
  };
  const viewer: AuthenticatedUser = { ...admin, id: "viewer-1", role: "viewer" };

  it("allows a customer admin to create an upload intent but rejects a viewer", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: { create: jest.fn().mockResolvedValue({ id: "asset-1", status: "pending" }) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "floor-1", siteId: "site-1" }])
    };
    prisma.$transaction = jest.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma));
    const storage: any = {
      prepareFloorAssetUpload: jest.fn().mockReturnValue({
        objectKey: "floors/floor-1/file.png", checksumBase64: "checksum", expiresInSeconds: 300
      }),
      createFloorAssetUploadUrl: jest.fn().mockResolvedValue("https://signed.example")
    };
    const siteAccess = { assert: jest.fn().mockImplementation((user: AuthenticatedUser, _siteId: string, capability: string) => {
      if (capability === "manage" && user.role === "viewer") throw new ForbiddenException();
      return { id: "site-1" };
    }), assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" }) } as unknown as SiteAccessService;
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
      floorAsset: { findMany: jest.fn().mockResolvedValue([{ id: "asset-1", status: "ready", sizeBytes: 1024n }]) }
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    const service = new FloorAssetsService(prisma, {} as any, siteAccess as unknown as SiteAccessService);

    const assets = await service.listAssets(viewer, "floor-1");
    expect(assets).toEqual([{
      id: "asset-1",
      status: "ready",
      sizeBytes: 1024,
      accessPath: "/api/floors/floor-1/assets/asset-1/content"
    }]);
    expect(assets[0]).not.toHaveProperty("publicUrl");
    expect(() => JSON.stringify(assets)).not.toThrow();
    expect(siteAccess.assert).toHaveBeenCalledWith(viewer, "site-1", "read");
  });

  it("authorizes and signs only a ready asset from the requested floor", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: {
        findFirst: jest.fn().mockResolvedValue({ objectKey: "floors/floor-1/file.png" })
      }
    };
    const storage: any = {
      createFloorAssetDownloadUrl: jest.fn().mockResolvedValue("https://download.example/signed")
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    const service = new FloorAssetsService(prisma, storage, siteAccess as unknown as SiteAccessService);

    await expect(service.getContentRedirect(viewer, "floor-1", "asset-1"))
      .resolves.toEqual({ url: "https://download.example/signed" });
    expect(siteAccess.assert).toHaveBeenCalledWith(viewer, "site-1", "read");
    expect(prisma.floorAsset.findFirst).toHaveBeenCalledWith({
      where: { id: "asset-1", floorId: "floor-1", status: "ready" },
      select: { objectKey: true }
    });
  });
  it("creates a pending tenant-scoped upload intent", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: { create: jest.fn().mockResolvedValue({ id: "asset-1", status: "pending" }) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "floor-1", siteId: "site-1" }])
    };
    prisma.$transaction = jest.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma));
    const storage: any = {
      prepareFloorAssetUpload: jest.fn().mockReturnValue({
        objectKey: "floors/floor-1/file.png",
        checksumBase64: "checksum",
        expiresInSeconds: 300
      }),
      createFloorAssetUploadUrl: jest.fn().mockResolvedValue("https://signed.example")
    };
    const service = new FloorAssetsService(prisma, storage, {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" })
    } as unknown as SiteAccessService);

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

  it("commits a pending upload ledger before presigning and keeps it when presign fails", async () => {
    const order: string[] = [];
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: {
        create: jest.fn().mockImplementation(async () => {
          order.push("ledger");
          return { id: "asset-1", status: "pending" };
        })
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "floor-1", siteId: "site-1" }])
    };
    prisma.$transaction = jest.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma));
    const storage: any = {
      prepareFloorAssetUpload: jest.fn().mockImplementation(() => {
        order.push("prepare");
        return {
          objectKey: "floors/floor-1/file.png",
          checksumBase64: Buffer.from("a".repeat(64), "hex").toString("base64"),
          expiresInSeconds: 300
        };
      }),
      createFloorAssetUploadUrl: jest.fn().mockImplementation(async () => {
        order.push("presign");
        throw new Error("signer unavailable");
      })
    };
    const siteAccess: any = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1", organizationId: "customer-org" })
    };

    await expect(new FloorAssetsService(prisma, storage, siteAccess).createUploadIntent(admin, "floor-1", {
      kind: "original",
      mimeType: "image/png",
      sizeBytes: 1024,
      sha256: "a".repeat(64)
    })).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(order).toEqual(["prepare", "ledger", "presign"]);
    expect(prisma.floorAsset.create).toHaveBeenCalled();
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
          status: "pending"
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
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

  it("rejects completion after the pending upload has been claimed for cleanup", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: {
        findFirst: jest.fn().mockResolvedValue({
          id: "asset-1",
          objectKey: "floors/floor-1/file.png",
          mimeType: "image/png",
          sizeBytes: 1024n,
          sha256: "a".repeat(64),
          status: "pending",
          cleanupStartedAt: new Date()
        })
      }
    };
    const storage: any = { headObject: jest.fn() };
    const service = new FloorAssetsService(prisma, storage, {
      assert: jest.fn().mockResolvedValue({ id: "site-1" })
    } as unknown as SiteAccessService);

    await expect(service.completeUpload(admin, "floor-1", "asset-1")).rejects.toBeInstanceOf(ConflictException);
    expect(storage.headObject).not.toHaveBeenCalled();
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

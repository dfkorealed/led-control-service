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

  it("rejects an upload intent when the transaction-locked floor is archived", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: {
        create: jest.fn().mockResolvedValue({ id: "asset-1", status: "pending" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "floor-1", siteId: "site-1", floorStatus: "archived" }])
    };
    prisma.$transaction = jest.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma));
    const storage: any = {
      prepareFloorAssetUpload: jest.fn().mockReturnValue({
        objectKey: "floors/floor-1/file.png", expiresInSeconds: 300
      }),
      createFloorAssetUploadUrl: jest.fn().mockResolvedValue("https://signed.example")
    };
    const siteAccess: any = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" })
    };

    await expect(new FloorAssetsService(prisma, storage, siteAccess).createUploadIntent(admin, "floor-1", {
      kind: "original", mimeType: "application/dxf", sizeBytes: 1024, sha256: "a".repeat(64)
    })).rejects.toEqual(new ConflictException({ code: "floor_archived" }));

    expect(prisma.floorAsset.create).not.toHaveBeenCalled();
    expect(storage.createFloorAssetUploadUrl).not.toHaveBeenCalled();
  });

  it("does not finalize or return an upload intent when archive commits after presigning", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: {
        create: jest.fn().mockResolvedValue({ id: "asset-1", status: "pending" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: "floor-1", siteId: "site-1", floorStatus: "active" }])
        .mockResolvedValueOnce([{ id: "floor-1", siteId: "site-1", floorStatus: "archived" }])
    };
    prisma.$transaction = jest.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma));
    const storage: any = {
      prepareFloorAssetUpload: jest.fn().mockReturnValue({
        objectKey: "floors/floor-1/file.png", expiresInSeconds: 300
      }),
      createFloorAssetUploadUrl: jest.fn().mockResolvedValue("https://signed.example")
    };
    const siteAccess: any = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" })
    };

    await expect(new FloorAssetsService(prisma, storage, siteAccess).createUploadIntent(admin, "floor-1", {
      kind: "original", mimeType: "application/dxf", sizeBytes: 1024, sha256: "a".repeat(64)
    })).rejects.toEqual(new ConflictException({ code: "floor_archived" }));

    expect(storage.createFloorAssetUploadUrl).toHaveBeenCalledTimes(1);
    expect(prisma.floorAsset.updateMany).not.toHaveBeenCalled();
  });

  it("allows a customer admin to create an upload intent but rejects a viewer", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: {
        create: jest.fn().mockResolvedValue({ id: "asset-1", status: "pending" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "floor-1", siteId: "site-1", floorStatus: "active" }])
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
    const uploadInput = { kind: "original" as const, mimeType: "application/dxf", sizeBytes: 1024, sha256: "a".repeat(64) };

    await expect(service.createUploadIntent(admin, "floor-1", uploadInput)).resolves.toBeDefined();
    await expect(service.createUploadIntent(viewer, "floor-1", uploadInput)).rejects.toBeInstanceOf(ForbiddenException);
    expect((siteAccess as any).assert).toHaveBeenNthCalledWith(1, admin, "site-1", "manage");
    expect((siteAccess as any).assert).toHaveBeenNthCalledWith(2, viewer, "site-1", "manage");
  });

  it("rejects a new PDF upload intent before creating or signing an asset", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: {
        create: jest.fn().mockResolvedValue({ id: "asset-1", status: "pending" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      $queryRaw: jest.fn().mockResolvedValue([{ floorStatus: "active" }])
    };
    prisma.$transaction = jest.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma));
    const storage: any = {
      prepareFloorAssetUpload: jest.fn().mockReturnValue({
        objectKey: "floors/floor-1/file.pdf", expiresInSeconds: 300
      }),
      createFloorAssetUploadUrl: jest.fn().mockResolvedValue("https://signed.example")
    };
    const siteAccess: any = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" })
    };

    await expect(new FloorAssetsService(prisma, storage, siteAccess).createUploadIntent(admin, "floor-1", {
      kind: "original", mimeType: "application/pdf", sizeBytes: 1024, sha256: "a".repeat(64)
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(siteAccess.assert).toHaveBeenCalledWith(admin, "site-1", "manage");
    expect(storage.prepareFloorAssetUpload).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.floorAsset.create).not.toHaveBeenCalled();
    expect(storage.createFloorAssetUploadUrl).not.toHaveBeenCalled();
  });

  it.each(["image/png", "image/jpeg"])(
    "rejects a new %s upload intent before creating or signing an asset",
    async (mimeType) => {
      const prisma: any = {
        floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
        floorAsset: { create: jest.fn() },
        $transaction: jest.fn()
      };
      const storage: any = {
        prepareFloorAssetUpload: jest.fn(),
        createFloorAssetUploadUrl: jest.fn()
      };
      const siteAccess: any = {
        assert: jest.fn().mockResolvedValue({ id: "site-1" }),
        assertManageInTransaction: jest.fn()
      };

      await expect(new FloorAssetsService(prisma, storage, siteAccess).createUploadIntent(admin, "floor-1", {
        kind: "original", mimeType, sizeBytes: 1024, sha256: "a".repeat(64)
      })).rejects.toThrow("unsupported floor asset MIME type");

      expect(storage.prepareFloorAssetUpload).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.floorAsset.create).not.toHaveBeenCalled();
      expect(storage.createFloorAssetUploadUrl).not.toHaveBeenCalled();
    }
  );

  it.each(["image/png", "image/jpeg"])(
    "rejects a public rendered %s upload intent before creating or signing an asset",
    async (mimeType) => {
      const prisma: any = {
        floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
        floorAsset: { create: jest.fn() },
        $transaction: jest.fn()
      };
      const storage: any = {
        prepareFloorAssetUpload: jest.fn(),
        createFloorAssetUploadUrl: jest.fn()
      };
      const siteAccess: any = {
        assert: jest.fn().mockResolvedValue({ id: "site-1" }),
        assertManageInTransaction: jest.fn()
      };

      await expect(new FloorAssetsService(prisma, storage, siteAccess).createUploadIntent(admin, "floor-1", {
        kind: "rendered", mimeType, sizeBytes: 1024, sha256: "a".repeat(64)
      })).rejects.toThrow("invalid floor asset kind");

      expect(storage.prepareFloorAssetUpload).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.floorAsset.create).not.toHaveBeenCalled();
      expect(storage.createFloorAssetUploadUrl).not.toHaveBeenCalled();
    }
  );

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
        findFirst: jest.fn().mockResolvedValue({
          kind: "original", objectKey: "floors/floor-1/file.png", mimeType: "image/png",
          contentEncoding: null, sizeBytes: 10n, sha256: "a".repeat(64)
        })
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
      select: { id: true, kind: true, objectKey: true, mimeType: true, contentEncoding: true, sizeBytes: true, sha256: true }
    });
  });

  it("keeps existing ready PDF assets listable and downloadable", async () => {
    const asset = {
      id: "asset-pdf", kind: "original", status: "ready", objectKey: "floors/floor-1/legacy.pdf",
      mimeType: "application/pdf", contentEncoding: null, sizeBytes: 1024n, sha256: "a".repeat(64)
    };
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: {
        findMany: jest.fn().mockResolvedValue([asset]),
        findFirst: jest.fn().mockResolvedValue(asset)
      }
    };
    const storage: any = {
      createFloorAssetDownloadUrl: jest.fn().mockResolvedValue("https://download.example/legacy-pdf")
    };
    const siteAccess: any = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    const service = new FloorAssetsService(prisma, storage, siteAccess);

    await expect(service.listAssets(viewer, "floor-1")).resolves.toEqual([expect.objectContaining({
      id: "asset-pdf",
      mimeType: "application/pdf",
      accessPath: "/api/floors/floor-1/assets/asset-pdf/content"
    })]);
    await expect(service.getContentRedirect(viewer, "floor-1", "asset-pdf"))
      .resolves.toEqual({ url: "https://download.example/legacy-pdf" });
    expect(storage.createFloorAssetDownloadUrl).toHaveBeenCalledWith("floors/floor-1/legacy.pdf");
  });

  it("reconciles an unknown rendered SVG before signing content", async () => {
    const asset = {
      id: "asset-1", kind: "rendered", objectKey: "floors/floor-1/render.svg", mimeType: "image/svg+xml",
      contentEncoding: "unknown", sizeBytes: 321n, sha256: "b".repeat(64)
    };
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: { findFirst: jest.fn().mockResolvedValue(asset) }
    };
    const storage: any = { createFloorAssetDownloadUrl: jest.fn().mockResolvedValue("https://download.example/signed") };
    const reconciler: any = { reconcile: jest.fn().mockResolvedValue({ width: 10, height: 20, contentEncoding: "gzip" }) };
    const service = new FloorAssetsService(
      prisma, storage, { assert: jest.fn() } as any, reconciler
    );

    await expect(service.getContentRedirect(viewer, "floor-1", asset.id))
      .resolves.toEqual({ url: "https://download.example/signed" });
    expect(reconciler.reconcile).toHaveBeenCalledWith(asset);
  });

  it("signs legacy identity and gzip rendered SVGs only after exact object HEAD verification", async () => {
    const asset: {
      kind: string; objectKey: string; mimeType: string; contentEncoding: string | null; sizeBytes: bigint; sha256: string;
    } = {
      kind: "rendered", objectKey: "floors/floor-1/render.svg", mimeType: "image/svg+xml",
      contentEncoding: null, sizeBytes: 321n, sha256: "b".repeat(64)
    };
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: { findFirst: jest.fn().mockResolvedValue(asset) }
    };
    const storage: any = {
      readFloorRenderedMetadata: jest.fn().mockResolvedValue({ width: 10, height: 20 }),
      createFloorAssetDownloadUrl: jest.fn().mockResolvedValue("https://download.example/signed")
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    const service = new FloorAssetsService(prisma, storage, siteAccess as unknown as SiteAccessService);

    await expect(service.getContentRedirect(viewer, "floor-1", "asset-1"))
      .resolves.toEqual({ url: "https://download.example/signed" });
    expect(storage.readFloorRenderedMetadata).toHaveBeenCalledWith(asset.objectKey, {
      sizeBytes: 321, sha256: asset.sha256, mimeType: "image/svg+xml", contentEncoding: null
    });
    expect(storage.createFloorAssetDownloadUrl).toHaveBeenCalledWith(asset.objectKey);

    asset.contentEncoding = "gzip";
    storage.createFloorAssetDownloadUrl.mockClear();
    storage.readFloorRenderedMetadata.mockRejectedValue(new Error("encoding replaced"));
    await expect(service.getContentRedirect(viewer, "floor-1", "asset-1"))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(storage.readFloorRenderedMetadata).toHaveBeenCalledWith(asset.objectKey, {
      sizeBytes: 321, sha256: asset.sha256, mimeType: "image/svg+xml", contentEncoding: "gzip"
    });
    expect(storage.createFloorAssetDownloadUrl).not.toHaveBeenCalled();
  });

  it("returns 503 without a public fallback when content signing fails", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: {
        findFirst: jest.fn().mockResolvedValue({
          kind: "original", objectKey: "floors/floor-1/file.png", mimeType: "image/png",
          contentEncoding: null, sizeBytes: 10n, sha256: "a".repeat(64)
        })
      }
    };
    const storage: any = {
      createFloorAssetDownloadUrl: jest.fn().mockRejectedValue(new Error("signer unavailable"))
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    const service = new FloorAssetsService(prisma, storage, siteAccess as unknown as SiteAccessService);

    await expect(service.getContentRedirect(viewer, "floor-1", "asset-1"))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(storage.createFloorAssetDownloadUrl).toHaveBeenCalledTimes(1);
  });
  it("creates a pending tenant-scoped upload intent", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: {
        create: jest.fn().mockResolvedValue({ id: "asset-1", status: "pending" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "floor-1", siteId: "site-1", floorStatus: "active" }])
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
        mimeType: "application/dxf",
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
      $queryRaw: jest.fn().mockResolvedValue([{ id: "floor-1", siteId: "site-1", floorStatus: "active" }])
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
      mimeType: "application/dxf",
      sizeBytes: 1024,
      sha256: "a".repeat(64)
    })).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(order).toEqual(["prepare", "ledger", "presign"]);
    expect(prisma.floorAsset.create).toHaveBeenCalled();
  });

  it("starts the upload expiry clock only after presigning succeeds", async () => {
    jest.useFakeTimers();
    const ledgerCreatedAt = new Date("2026-09-12T00:00:00.000Z");
    const signedAt = new Date("2026-09-12T00:02:00.000Z");
    jest.setSystemTime(ledgerCreatedAt);
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: {
        create: jest.fn().mockResolvedValue({ id: "asset-1", status: "pending" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "floor-1", siteId: "site-1", floorStatus: "active" }])
    };
    prisma.$transaction = jest.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma));
    const storage: any = {
      prepareFloorAssetUpload: jest.fn().mockReturnValue({
        objectKey: "floors/floor-1/file.png",
        checksumBase64: "checksum",
        expiresInSeconds: 300
      }),
      createFloorAssetUploadUrl: jest.fn().mockImplementation(async () => {
        jest.setSystemTime(signedAt);
        return "https://signed.example";
      })
    };
    const service = new FloorAssetsService(prisma, storage, {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" })
    } as unknown as SiteAccessService);

    try {
      await expect(service.createUploadIntent(admin, "floor-1", {
        kind: "original", mimeType: "application/dxf", sizeBytes: 1024, sha256: "a".repeat(64)
      })).resolves.toMatchObject({ uploadUrl: "https://signed.example" });
      expect(prisma.floorAsset.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ uploadExpiresAt: null })
      });
      expect(prisma.floorAsset.updateMany).toHaveBeenCalledWith({
        where: { id: "asset-1", status: "pending", uploadExpiresAt: null, cleanupStartedAt: null },
        data: { uploadExpiresAt: new Date("2026-09-12T00:07:00.000Z") }
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not return a signed URL when the atomic expiry update fails", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: {
        create: jest.fn().mockResolvedValue({ id: "asset-1", status: "pending" }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "floor-1", siteId: "site-1", floorStatus: "active" }])
    };
    prisma.$transaction = jest.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma));
    const storage: any = {
      prepareFloorAssetUpload: jest.fn().mockReturnValue({ objectKey: "floors/floor-1/file.png", expiresInSeconds: 300 }),
      createFloorAssetUploadUrl: jest.fn().mockResolvedValue("https://signed.example")
    };
    const service = new FloorAssetsService(prisma, storage, {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" })
    } as unknown as SiteAccessService);

    await expect(service.createUploadIntent(admin, "floor-1", {
      kind: "original", mimeType: "application/dxf", sizeBytes: 1024, sha256: "a".repeat(64)
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.floorAsset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ uploadExpiresAt: null })
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
          status: "pending"
        }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{
        id: "asset-1", floorId: "floor-1", siteId: "site-1", floorStatus: "active", objectKey: "floors/floor-1/file.png",
        mimeType: "image/png", sizeBytes: 1024n, sha256: checksum, status: "pending", cleanupStartedAt: null
      }])
    };
    prisma.$transaction = jest.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma));
    prisma.floorAsset.update = jest.fn().mockResolvedValue({
      id: "asset-1", floorId: "floor-1", objectKey: "floors/floor-1/file.png", mimeType: "image/png",
      sizeBytes: 1024n, sha256: checksum, status: "ready", cleanupStartedAt: null, readyAt: new Date()
    });
    const storage: any = {
      headObject: jest.fn().mockResolvedValue({
        ContentType: "image/png",
        ContentLength: 1024,
        ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64")
      })
    };

    const siteAccess = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" })
    } as unknown as SiteAccessService;
    await expect(new FloorAssetsService(prisma, storage, siteAccess).completeUpload(admin, "floor-1", "asset-1")).resolves.toMatchObject({
      id: "asset-1",
      status: "ready"
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect((siteAccess as any).assertManageInTransaction).toHaveBeenCalledWith(prisma, admin, "site-1");
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it("does not promote an upload when archive commits before the post-HEAD floor lock", async () => {
    const checksum = "a".repeat(64);
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: {
        findFirst: jest.fn().mockResolvedValue({
          id: "asset-1", objectKey: "floors/floor-1/file.png", mimeType: "image/png",
          sizeBytes: 1024n, sha256: checksum, status: "pending", cleanupStartedAt: null
        }),
        update: jest.fn().mockResolvedValue({
          id: "asset-1", floorId: "floor-1", objectKey: "floors/floor-1/file.png", mimeType: "image/png",
          sizeBytes: 1024n, sha256: checksum, status: "ready", cleanupStartedAt: null, readyAt: new Date()
        })
      },
      $queryRaw: jest.fn().mockResolvedValue([{
        id: "asset-1", floorId: "floor-1", siteId: "site-1", floorStatus: "archived",
        objectKey: "floors/floor-1/file.png", mimeType: "image/png", sizeBytes: 1024n,
        sha256: checksum, status: "pending", cleanupStartedAt: null
      }])
    };
    prisma.$transaction = jest.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma));
    const storage: any = { headObject: jest.fn().mockResolvedValue({
      ContentType: "image/png", ContentLength: 1024,
      ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64")
    }) };
    const siteAccess: any = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" })
    };

    await expect(new FloorAssetsService(prisma, storage, siteAccess).completeUpload(admin, "floor-1", "asset-1"))
      .rejects.toEqual(new ConflictException({ code: "floor_archived" }));

    expect(storage.headObject).toHaveBeenCalledTimes(1);
    expect(prisma.floorAsset.update).not.toHaveBeenCalled();
  });

  it("rejects idempotent completion of a ready asset on an archived floor", async () => {
    const asset = {
      id: "asset-1", floorId: "floor-1", objectKey: "floors/floor-1/file.png", mimeType: "image/png",
      sizeBytes: 1024n, sha256: "a".repeat(64), status: "ready", readyAt: new Date()
    };
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: { findFirst: jest.fn().mockResolvedValue(asset), update: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ floorStatus: "archived" }])
    };
    prisma.$transaction = jest.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma));
    const storage: any = { headObject: jest.fn() };
    const siteAccess: any = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" })
    };

    await expect(new FloorAssetsService(prisma, storage, siteAccess).completeUpload(admin, "floor-1", "asset-1"))
      .rejects.toEqual(new ConflictException({ code: "floor_archived" }));

    expect(storage.headObject).not.toHaveBeenCalled();
    expect(prisma.floorAsset.update).not.toHaveBeenCalled();
  });

  it("reauthorizes after HEAD and refuses promotion when admin access was revoked", async () => {
    const checksum = "a".repeat(64);
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
      floorAsset: {
        findFirst: jest.fn().mockResolvedValue({
          id: "asset-1", objectKey: "floors/floor-1/file.png", mimeType: "image/png",
          sizeBytes: 1024n, sha256: checksum, status: "pending", cleanupStartedAt: null
        }),
        updateMany: jest.fn()
      }
    };
    prisma.$transaction = jest.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma));
    const storage: any = { headObject: jest.fn().mockResolvedValue({
      ContentType: "image/png", ContentLength: 1024, ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64")
    }) };
    const siteAccess = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockRejectedValue(new NotFoundException("site not found"))
    } as unknown as SiteAccessService;

    await expect(new FloorAssetsService(prisma, storage, siteAccess).completeUpload(admin, "floor-1", "asset-1"))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(storage.headObject).toHaveBeenCalled();
    expect(prisma.floorAsset.updateMany).not.toHaveBeenCalled();
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

  it("returns 404 when the uploaded floor object is missing", async () => {
    const service = completionServiceWithHeadError(Object.assign(new Error("missing"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 }
    }));

    await expect(service.completeUpload(admin, "floor-1", "asset-1")).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ message: "uploaded floor asset object not found" })
    });
  });

  it.each([
    ["a bounded HEAD timeout", Object.assign(new Error("aborted"), { name: "TimeoutError" })],
    ["an object storage outage", Object.assign(new Error("unavailable"), { $metadata: { httpStatusCode: 503 } })]
  ])("returns 503 for %s", async (_case, error) => {
    const service = completionServiceWithHeadError(error);

    await expect(service.completeUpload(admin, "floor-1", "asset-1")).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ message: "floor asset storage is temporarily unavailable" })
    });
  });

  it("reports storage authorization failure as 503 instead of hiding it as 404", async () => {
    const service = completionServiceWithHeadError(Object.assign(new Error("denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 404 }
    }));

    await expect(service.completeUpload(admin, "floor-1", "asset-1")).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ message: "floor asset storage authorization failed" })
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

function completionServiceWithHeadError(error: Error) {
  const prisma: any = {
    floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }) },
    floorAsset: {
      findFirst: jest.fn().mockResolvedValue({
        id: "asset-1",
        floorId: "floor-1",
        objectKey: "floors/floor-1/file.png",
        mimeType: "image/png",
        sizeBytes: 1024n,
        sha256: "a".repeat(64),
        status: "pending",
        cleanupStartedAt: null
      })
    },
    $transaction: jest.fn()
  };
  const storage: any = { headObject: jest.fn().mockRejectedValue(error) };
  const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) } as unknown as SiteAccessService;
  return new FloorAssetsService(prisma, storage, siteAccess);
}

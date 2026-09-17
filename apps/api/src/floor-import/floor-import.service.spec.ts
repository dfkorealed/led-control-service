import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { hashEditorLeaseToken } from "../floor-editor/editor-lease-token";
import { FloorImportService } from "./floor-import.service";
import { PROVIDED_SAMPLE_DWG_SHA256 } from "./lighting-detector-registry";

const user = {
  id: randomUUID(), organizationId: randomUUID(), organizationType: "customer" as const,
  loginId: "floor-admin", name: "Floor Admin", role: "admin" as const,
  status: "active" as const, mustChangePassword: false
};

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(), floorId: randomUUID(), sourceAssetId: randomUUID(), renderedAssetId: null,
    sourceFormat: "dxf", status: "queued", stage: "queued", progressPercent: 0,
    attemptCount: 0, parserVersion: null, detectorVersion: null, failureCode: null,
    startedAt: null, reviewRequiredAt: null, appliedAt: null, completedAt: null,
    failedAt: null, cancelledAt: null, createdAt: new Date("2026-09-17T00:00:00.000Z"),
    updatedAt: new Date("2026-09-17T00:00:00.000Z"), ...overrides
  };
}

describe("FloorImportService", () => {
  it("rejects client-selected detector profiles", async () => {
    const service = new FloorImportService({} as any, {} as any, {} as any);
    await expect(service.create(user, randomUUID(), {
      sourceAssetId: randomUUID(), sourceFormat: "dxf", detectorProfileId: "site-drawing-20260803-v1"
    })).rejects.toBeInstanceOf(BadRequestException);
  });
  it("requires manage access and creates a queued job only for a same-floor ready original with matching format", async () => {
    const floorId = randomUUID(); const sourceAssetId = randomUUID(); const created = job({ floorId, sourceAssetId });
    const tx: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1", status: "active" }) },
      $queryRaw: jest.fn().mockResolvedValue([{
        id: sourceAssetId, floorId, floorStatus: "active", kind: "original", status: "ready",
        mimeType: "application/dxf", sha256: "a".repeat(64), cleanupStartedAt: null
      }]),
      floorAsset: { findFirst: jest.fn().mockResolvedValue({
        id: sourceAssetId, floorId, kind: "original", status: "ready", mimeType: "application/dxf", cleanupStartedAt: null
      }) },
      floorImportJob: { create: jest.fn().mockResolvedValue(created) }
    };
    const prisma: any = {
      floor: tx.floor,
      $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx))
    };
    const access: any = {
      assert: jest.fn().mockResolvedValue({ id: "site-1", organizationId: user.organizationId }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1", organizationId: user.organizationId })
    };
    const service = new FloorImportService(prisma, access, { record: jest.fn() } as any);

    await expect(service.create(user, floorId, { sourceAssetId, sourceFormat: "dxf" })).resolves.toMatchObject({
      jobId: created.id, floorId, sourceAssetId, status: "queued", progressPercent: 0
    });
    expect(tx.floorImportJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ detectorProfileId: "generic-lighting-v1" })
    }));
    expect(access.assert).toHaveBeenCalledWith(user, "site-1", "manage");
    expect(access.assertManageInTransaction).toHaveBeenCalledWith(tx, user, "site-1");
    expect(tx.$queryRaw.mock.calls[0][0].strings.join(" ")).toContain("FOR UPDATE OF floor, asset");
  });

  it("auto-resolves the approved sample source digest without accepting a Web profile choice", async () => {
    const floorId = randomUUID(); const sourceAssetId = randomUUID();
    const created = job({ floorId, sourceAssetId, detectorProfileId: "site-drawing-20260803-v1" });
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: sourceAssetId, floorId, floorStatus: "active", kind: "original", status: "ready",
        mimeType: "application/dwg", sha256: PROVIDED_SAMPLE_DWG_SHA256, cleanupStartedAt: null
      }]),
      floorImportJob: { create: jest.fn().mockResolvedValue(created) }
    };
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx))
    };
    const access: any = {
      assert: jest.fn(),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1", organizationId: user.organizationId })
    };
    const service = new FloorImportService(prisma, access, { record: jest.fn() } as any);

    await expect(service.create(user, floorId, { sourceAssetId, sourceFormat: "dwg" }))
      .resolves.toMatchObject({ detectorProfileId: "site-drawing-20260803-v1" });
    expect(tx.floorImportJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ detectorProfileId: "site-drawing-20260803-v1" })
    }));
  });

  it("rejects a source asset that cleanup claimed before the create transaction acquired its locks", async () => {
    const floorId = randomUUID(); const sourceAssetId = randomUUID();
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: sourceAssetId, floorId, floorStatus: "active", kind: "original", status: "ready",
        mimeType: "application/dxf", cleanupStartedAt: new Date()
      }]),
      floorImportJob: { create: jest.fn() }
    };
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx))
    };
    const service = new FloorImportService(
      prisma,
      { assert: jest.fn(), assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1", organizationId: user.organizationId }) } as any,
      { record: jest.fn() } as any
    );
    await expect(service.create(user, floorId, { sourceAssetId, sourceFormat: "dxf" }))
      .rejects.toThrow("source asset must be a ready original");
    expect(tx.floorImportJob.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ sourceFormat: "dwg", mimeType: "application/dxf" }, BadRequestException],
    [{ sourceFormat: "dxf", mimeType: "application/pdf" }, BadRequestException]
  ])("rejects source format and MIME mismatch %#", async (input, errorType) => {
    const floorId = randomUUID(); const sourceAssetId = randomUUID();
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      $transaction: jest.fn((run: (client: any) => unknown) => run({
        $queryRaw: jest.fn().mockResolvedValue([{
          id: sourceAssetId, floorId, floorStatus: "active", kind: "original", status: "ready",
          mimeType: input.mimeType, cleanupStartedAt: null
        }]),
        floor: { findUnique: jest.fn().mockResolvedValue({ status: "active" }) },
        floorAsset: { findFirst: jest.fn().mockResolvedValue({
          id: sourceAssetId, floorId, kind: "original", status: "ready", mimeType: input.mimeType, cleanupStartedAt: null
        }) }
      }))
    };
    const access: any = { assert: jest.fn(), assertManageInTransaction: jest.fn() };
    const service = new FloorImportService(prisma, access, { record: jest.fn() } as any);
    await expect(service.create(user, floorId, { sourceAssetId, sourceFormat: input.sourceFormat })).rejects.toBeInstanceOf(errorType);
  });

  it("maps the database active-job unique conflict to a stable conflict response", async () => {
    const floorId = randomUUID(); const sourceAssetId = randomUUID();
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: sourceAssetId, floorId, floorStatus: "active", kind: "original", status: "ready",
        mimeType: "application/dxf", sha256: "a".repeat(64), cleanupStartedAt: null
      }]),
      floor: { findUnique: jest.fn().mockResolvedValue({ status: "active" }) },
      floorAsset: { findFirst: jest.fn().mockResolvedValue({ id: sourceAssetId, floorId, kind: "original", status: "ready", mimeType: "application/dxf", cleanupStartedAt: null }) },
      floorImportJob: { create: jest.fn().mockRejectedValue({ code: "P2002", meta: { target: "FloorImportJob_floorId_active_key" } }) }
    };
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx))
    };
    const access: any = { assert: jest.fn(), assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1", organizationId: user.organizationId }) };
    const service = new FloorImportService(prisma, access, { record: jest.fn() } as any);
    await expect(service.create(user, floorId, { sourceAssetId, sourceFormat: "dxf" })).rejects.toThrow("an active floor import already exists");
  });

  it("uses read access and returns a candidate-only read model without fixture identity", async () => {
    const floorId = randomUUID(); const jobId = randomUUID(); const candidateId = randomUUID();
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      floorImportJob: { findFirst: jest.fn().mockResolvedValue({ id: jobId }) },
      floorImportCandidate: { findMany: jest.fn().mockResolvedValue([{
        id: candidateId, sourceEntityId: "insert-1", layerName: "LIGHT", blockName: "LED",
        x: 10, y: 20, rotation: 90, confidence: 0.95, detectionMethod: "rule_based",
        provider: null, model: null, inputDigest: null, reviewStatus: "pending"
      }]) }
    };
    const access: any = { assert: jest.fn() };
    const service = new FloorImportService(prisma, access, { record: jest.fn() } as any);
    const result = await service.listCandidates(user, floorId, jobId);
    expect(result).toEqual({ jobId, candidates: [expect.objectContaining({ id: candidateId, sourceEntityId: "insert-1" })] });
    expect(result.candidates[0]).not.toHaveProperty("fixtureId");
    expect(result.candidates[0]).not.toHaveProperty("meshNodeId");
    expect(prisma.floorImportCandidate.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2_000 }));
    expect(access.assert).toHaveBeenCalledWith(user, "site-1", "read");
  });

  it("reauthorizes manage access and reads only durable active states in one transaction", async () => {
    const floorId = randomUUID();
    const renderedAssetId = randomUUID();
    const active = job({
      floorId,
      renderedAssetId,
      status: "review_required",
      renderedAsset: {
        id: renderedAssetId,
        objectKey: `floors/${floorId}/${renderedAssetId}.svg`,
        status: "ready",
        mimeType: "image/svg+xml",
        contentEncoding: "gzip",
        sizeBytes: 256n,
        sha256: "b".repeat(64),
        cleanupStartedAt: null
      }
    });
    const tx: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      $executeRaw: jest.fn().mockResolvedValue(0),
      floorImportJob: { findFirst: jest.fn().mockResolvedValue(active) }
    };
    const prisma: any = { $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)) };
    const access: any = { assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" }) };
    const storage = { readFloorRenderedMetadata: jest.fn().mockResolvedValue({ width: 640, height: 360 }) };
    const service = new FloorImportService(prisma, access, { record: jest.fn() } as any, storage as any);

    await expect(service.getActive(user, floorId)).resolves.toEqual({
      job: expect.objectContaining({
        jobId: active.id,
        status: "review_required",
        renderedViewport: { width: 640, height: 360 }
      })
    });
    expect(access.assertManageInTransaction).toHaveBeenCalledWith(tx, user, "site-1");
    expect(tx.floorImportJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { floorId, status: { in: ["queued", "processing", "review_required"] } }
    }));
    expect(tx.$executeRaw.mock.calls[0][0].strings.join(" ")).toContain("INTERVAL '2 minutes'");
    expect(storage.readFloorRenderedMetadata).toHaveBeenCalledWith(
      `floors/${floorId}/${renderedAssetId}.svg`,
      { sizeBytes: 256, sha256: "b".repeat(64), mimeType: "image/svg+xml", contentEncoding: "gzip" }
    );
  });

  it("returns an empty active-job envelope after tenant and role authorization", async () => {
    const floorId = randomUUID();
    const tx: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      $executeRaw: jest.fn().mockResolvedValue(0),
      floorImportJob: { findFirst: jest.fn().mockResolvedValue(null) }
    };
    const prisma: any = { $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)) };
    const access: any = { assertManageInTransaction: jest.fn() };
    const service = new FloorImportService(prisma, access, { record: jest.fn() } as any);

    await expect(service.getActive(user, floorId)).resolves.toEqual({ job: null });
    expect(access.assertManageInTransaction).toHaveBeenCalledWith(tx, user, "site-1");
  });

  it("does not query applying as a recoverable active state after bounded reconciliation", async () => {
    const floorId = randomUUID();
    const tx: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      $executeRaw: jest.fn().mockResolvedValue(1),
      floorImportJob: { findFirst: jest.fn().mockResolvedValue(null) }
    };
    const service = new FloorImportService(
      { $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)) } as any,
      { assertManageInTransaction: jest.fn() } as any,
      { record: jest.fn() } as any
    );

    await expect(service.getActive(user, floorId)).resolves.toEqual({ job: null });
    const staleSql = tx.$executeRaw.mock.calls[0][0].strings.join(" ");
    expect(staleSql).toContain('"status" = \'applying\'');
    expect(staleSql).toContain('clock_timestamp() - INTERVAL \'2 minutes\'');
    expect(staleSql).toContain('"status" = \'failed\'');
  });

  it("returns the same validated viewport from the readable job endpoint", async () => {
    const floorId = randomUUID();
    const renderedAssetId = randomUUID();
    const reviewJob = job({
      floorId,
      renderedAssetId,
      status: "review_required",
      renderedAsset: {
        id: renderedAssetId,
        objectKey: `floors/${floorId}/${renderedAssetId}.svg`,
        status: "ready",
        mimeType: "image/svg+xml",
        contentEncoding: "gzip",
        sizeBytes: 512n,
        sha256: "c".repeat(64),
        cleanupStartedAt: null
      }
    });
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      floorImportJob: { findFirst: jest.fn().mockResolvedValue(reviewJob) }
    };
    const access: any = { assert: jest.fn() };
    const service = new FloorImportService(
      prisma,
      access,
      { record: jest.fn() } as any,
      { readFloorRenderedMetadata: jest.fn().mockResolvedValue({ width: 640, height: 360 }) } as any
    );

    await expect(service.get(user, floorId, reviewJob.id)).resolves.toMatchObject({
      jobId: reviewJob.id,
      renderedViewport: { width: 640, height: 360 }
    });
    expect(access.assert).toHaveBeenCalledWith(user, "site-1", "read");
  });

  it("cancels an active job with a fenced state transition and leaves terminal jobs unchanged", async () => {
    const floorId = randomUUID(); const row = job({ floorId, status: "processing", leaseOwner: "worker", leaseExpiresAt: new Date() });
    const cancelled = job({ ...row, status: "cancelled", leaseOwner: null, leaseExpiresAt: null, cancelledAt: new Date() });
    const tx: any = { floorImportJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue(cancelled) } };
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx))
    };
    const access: any = { assert: jest.fn(), assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1", organizationId: user.organizationId }) };
    const service = new FloorImportService(prisma, access, { record: jest.fn() } as any);
    await expect(service.cancel(user, floorId, row.id)).resolves.toMatchObject({ status: "cancelled" });
    expect(tx.floorImportJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: row.id, floorId, status: { in: ["queued", "processing", "review_required"] } },
      data: expect.objectContaining({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null })
    }));
  });

  it("applies the rendered background and candidate review atomically without mutating fixtures or map objects", async () => {
    const floorId = randomUUID(); const jobId = randomUUID(); const sourceAssetId = randomUUID();
    const renderedAssetId = randomUUID(); const acceptedId = randomUUID(); const rejectedId = randomUUID();
    const floor = {
      id: floorId, siteId: "site-1", status: "active", mapRevision: 4, editorLeaseFence: 8,
      editorLeaseTokenHash: hashEditorLeaseToken("lease-token"), editorLeaseExpiresAt: new Date("2026-09-17T00:10:00.000Z"),
      floorPlan: null,
      fixtures: [{ id: randomUUID(), name: "Existing", ratedWatt: 40, x: 1, y: 2, size: 20, placementStatus: "placed", positionVerifiedAt: null }],
      mapObjects: [{ id: randomUUID(), type: "rectangle", x: 3, y: 4, width: 10, height: 20, rotation: 0, points: null,
        text: null, strokeColor: "#000000", fillColor: null, strokeWidth: 2, fontSize: null, zIndex: 0, locked: false, visible: true }]
    };
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{
          status: floor.status, mapRevision: floor.mapRevision, editorLeaseFence: floor.editorLeaseFence,
          editorLeaseTokenHash: floor.editorLeaseTokenHash, editorLeaseExpiresAt: floor.editorLeaseExpiresAt,
          dbNow: new Date("2026-09-17T00:00:00.000Z"), jobStatus: "review_required",
          sourceAssetId, renderedAssetId, renderedMimeType: "image/svg+xml", renderedContentEncoding: "gzip",
          renderedObjectKey: `floors/${floorId}/${renderedAssetId}.svg`, renderedSizeBytes: 256n,
          renderedSha256: "b".repeat(64)
        }]),
      floorImportCandidate: {
        findMany: jest.fn().mockResolvedValue([{ id: acceptedId }, { id: rejectedId }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      floorImportJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      floorPlan: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
      floor: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ ...floor, mapRevision: 5, floorPlan: {
          imageUrl: `/api/floors/${floorId}/assets/${renderedAssetId}/content`, sourceType: "image",
          originalFileUrl: `/api/floors/${floorId}/assets/${sourceAssetId}/content`,
          renderedImageUrl: `/api/floors/${floorId}/assets/${renderedAssetId}/content`, width: 640, height: 480, gridSize: 10
        } })
      },
      floorMapRevision: { create: jest.fn().mockResolvedValue({}) }
    };
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      floorImportJob: { findFirst: jest.fn().mockResolvedValue({ renderedAsset: {
        id: renderedAssetId, objectKey: `floors/${floorId}/${renderedAssetId}.svg`, status: "ready",
        mimeType: "image/svg+xml", contentEncoding: "gzip", sizeBytes: 256n, sha256: "b".repeat(64), cleanupStartedAt: null
      } }) },
      $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx))
    };
    const access: any = {
      assert: jest.fn().mockResolvedValue({ organizationId: user.organizationId }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1", organizationId: user.organizationId })
    };
    const audit: any = { record: jest.fn().mockResolvedValue({}) };
    const storage = { readFloorRenderedMetadata: jest.fn().mockResolvedValue({ width: 640, height: 480 }) };
    const service = new (FloorImportService as any)(prisma, access, audit, storage);

    const result = await service.apply(user, floorId, jobId, {
      expectedRevision: 4, leaseToken: "lease-token", leaseFence: 8, candidateIds: [acceptedId]
    });

    expect(result).toMatchObject({ jobId, status: "completed", revision: 5, acceptedCandidateIds: [acceptedId] });
    expect(storage.readFloorRenderedMetadata).toHaveBeenCalledWith(`floors/${floorId}/${renderedAssetId}.svg`, {
      sizeBytes: 256, sha256: "b".repeat(64), mimeType: "image/svg+xml", contentEncoding: "gzip"
    });
    expect(tx.$queryRaw.mock.calls[0][0].strings.join(" ")).toContain("FOR UPDATE OF floor, job, source, rendered");
    expect(tx.floorPlan.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { floorId },
      create: expect.objectContaining({ floorId, sourceType: "image", width: 640, height: 480 })
    }));
    expect(tx.floorImportCandidate.updateMany).toHaveBeenCalledTimes(2);
    expect(tx).not.toHaveProperty("fixture.updateMany");
    expect(tx).not.toHaveProperty("floorMapObject.deleteMany");
    expect(tx.floorMapRevision.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      floorId, revision: 5, snapshot: expect.objectContaining({
        fixtures: [expect.objectContaining({ id: floor.fixtures[0].id, ratedWatt: "40" })],
        objects: floor.mapObjects
      })
    }) }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: "floor_import.applied", targetId: jobId, transaction: tx
    }));
  });

  it.each([
    ["stale lease", { editorLeaseFence: 9 }, "floor editor lease is no longer active"],
    ["stale revision", { mapRevision: 5 }, "floor editor revision conflict"]
  ])("rejects apply with %s", async (_label, floorOverride, message) => {
    const floorId = randomUUID(); const jobId = randomUUID(); const renderedAssetId = randomUUID();
    const tx: any = { $queryRaw: jest.fn().mockResolvedValue([{ status: "active", mapRevision: 4, editorLeaseFence: 8,
      editorLeaseTokenHash: hashEditorLeaseToken("lease-token"), editorLeaseExpiresAt: new Date("2026-09-17T00:10:00.000Z"),
      dbNow: new Date("2026-09-17T00:00:00.000Z"), jobStatus: "review_required", sourceAssetId: randomUUID(), renderedAssetId,
      renderedMimeType: "image/svg+xml", renderedContentEncoding: "gzip", renderedObjectKey: "floors/f/render.svg",
      renderedSizeBytes: 256n, renderedSha256: "b".repeat(64), ...floorOverride }]) };
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      floorImportJob: { findFirst: jest.fn().mockResolvedValue({ renderedAsset: {
        id: renderedAssetId, objectKey: "floors/f/render.svg", status: "ready", mimeType: "image/svg+xml", contentEncoding: "gzip",
        sizeBytes: 256n, sha256: "b".repeat(64), cleanupStartedAt: null
      } }) },
      $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx))
    };
    const service = new FloorImportService(
      prisma,
      { assert: jest.fn(), assertManageInTransaction: jest.fn() } as any,
      { record: jest.fn() } as any,
      { readFloorRenderedMetadata: jest.fn().mockResolvedValue({ width: 640, height: 480 }) } as any
    );
    await expect(service.apply(user, floorId, jobId, {
      expectedRevision: 4, leaseToken: "lease-token", leaseFence: 8, candidateIds: []
    })).rejects.toThrow(message);
  });

  it("rejects apply when the rendered ledger identity changes after HEAD verification", async () => {
    const floorId = randomUUID(); const jobId = randomUUID(); const renderedAssetId = randomUUID();
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      floorImportJob: { findFirst: jest.fn().mockResolvedValue({ renderedAsset: {
        id: renderedAssetId, objectKey: `floors/${floorId}/render.svg`, status: "ready", mimeType: "image/svg+xml", contentEncoding: "gzip",
        sizeBytes: 256n, sha256: "b".repeat(64), cleanupStartedAt: null
      } }) },
      $transaction: jest.fn((run: (client: any) => unknown) => run({
        $queryRaw: jest.fn().mockResolvedValue([{
          status: "active", mapRevision: 4, editorLeaseFence: 8,
          editorLeaseTokenHash: hashEditorLeaseToken("lease-token"), editorLeaseExpiresAt: new Date("2026-09-17T00:10:00.000Z"),
          dbNow: new Date("2026-09-17T00:00:00.000Z"), jobStatus: "review_required", sourceAssetId: randomUUID(),
          renderedAssetId, renderedMimeType: "image/svg+xml", renderedContentEncoding: "gzip", renderedObjectKey: `floors/${floorId}/render.svg`,
          renderedSizeBytes: 256n, renderedSha256: "c".repeat(64)
        }])
      }))
    };
    const service = new FloorImportService(
      prisma,
      { assert: jest.fn(), assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1", organizationId: user.organizationId }) } as any,
      { record: jest.fn() } as any,
      { readFloorRenderedMetadata: jest.fn().mockResolvedValue({ width: 640, height: 480 }) } as any
    );

    await expect(service.apply(user, floorId, jobId, {
      expectedRevision: 4, leaseToken: "lease-token", leaseFence: 8, candidateIds: []
    })).rejects.toThrow("rendered floor asset changed concurrently");
  });

  it("does not disclose a floor or job outside the caller's readable site", async () => {
    const prisma: any = { floor: { findUnique: jest.fn().mockResolvedValue({ id: randomUUID(), siteId: "site-1" }) } };
    const access: any = { assert: jest.fn().mockRejectedValue(new ForbiddenException()) };
    const service = new FloorImportService(prisma, access, { record: jest.fn() } as any);
    await expect(service.get(user, randomUUID(), randomUUID())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma).not.toHaveProperty("floorImportJob.findFirst");
  });
});

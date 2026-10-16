import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { hashEditorLeaseToken } from "../floor-editor/editor-lease-token";
import { FloorImportService } from "./floor-import.service";
import { activeFixtureRegistrationWhere } from "../fixtures/fixture-registration-removal-policy";
import { PROVIDED_SAMPLE_DWG_SHA256 } from "./lighting-detector-registry";

const user = {
  id: randomUUID(), organizationId: randomUUID(), organizationType: "customer" as const,
  loginId: "floor-admin", name: "Floor Admin", role: "admin" as const,
  status: "active" as const, mustChangePassword: false
};
const EMPTY_REGION_DIGEST = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

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
  function regionListing(count = 1817) {
    const floorId = randomUUID(); const jobId = randomUUID();
    const regions = Array.from({ length: count }, (_, index) => ({
      regionId: `region-${index}`, minX: 0, minY: 0, maxX: 100, maxY: 100,
      primitiveCount: 2, textCount: 1, lightCandidateCount: 0,
      previewWidth: 100, previewHeight: 100, selectedAt: null,
      previewAsset: {
        id: randomUUID(), objectKey: "unused", status: "ready", kind: "cad_region_preview",
        mimeType: "image/svg+xml", contentEncoding: "gzip", sizeBytes: 64n,
        sha256: "a".repeat(64), cleanupStartedAt: null
      }
    }));
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site" }) },
      $queryRaw: jest.fn(async () => regions.map(region => ({
        regionId: region.regionId, minX: "0", minY: "0", maxX: "100", maxY: "100"
      }))),
      floorImportJob: { findFirst: jest.fn().mockResolvedValue({ id: jobId, excludedRegionPrimitiveCount: 7, regions }) }
    };
    const storage: any = { readCadRegionPreviewMetadata: jest.fn() };
    const service = new FloorImportService(prisma, { assert: jest.fn() } as any, {} as any, storage);
    return { floorId, jobId, regions, prisma, storage, service };
  }

  it("lists all 1817 persisted regions without storage and uses a bounded DB query", async () => {
    const fixture = regionListing();
    const response = await fixture.service.listRegions(user, fixture.floorId, fixture.jobId);
    expect(response.regions).toHaveLength(1817);
    expect(response.regions.at(-1)).toMatchObject({ regionId: "region-1816", textCount: 1, lightCandidateCount: 0 });
    expect(fixture.storage.readCadRegionPreviewMetadata).not.toHaveBeenCalled();
    expect(fixture.prisma.floorImportJob.findFirst.mock.calls[0][0].select.regions.take).toBe(16385);
  });

  it.each(["textCount", "lightCandidateCount", "previewWidth", "previewHeight"])("rejects legacy null %s without storage or invented zeroes", async field => {
    const fixture = regionListing(2);
    (fixture.regions[1] as any)[field] = null;
    await expect(fixture.service.listRegions(user, fixture.floorId, fixture.jobId)).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.storage.readCadRegionPreviewMetadata).not.toHaveBeenCalled();
  });

  it("rejects the sentinel row instead of truncating excessive region results", async () => {
    const fixture = regionListing(16385);
    await expect(fixture.service.listRegions(user, fixture.floorId, fixture.jobId)).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.storage.readCadRegionPreviewMetadata).not.toHaveBeenCalled();
  });

  it("rejects a UTF-8 response above 16 MiB without storage or truncation", async () => {
    const fixture = regionListing(10000);
    fixture.regions.forEach((region, index) => { region.regionId = `${"한".repeat(500)}${index}`; });
    await expect(fixture.service.listRegions(user, fixture.floorId, fixture.jobId)).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.storage.readCadRegionPreviewMetadata).not.toHaveBeenCalled();
  });

  it("does not create a permanently queued job when the CAD worker is disabled", async () => {
    const prisma: any = { $transaction: jest.fn() };
    const service = new FloorImportService(
      prisma,
      {} as any,
      {} as any,
      undefined,
      undefined,
      { tempRoot: "/tmp", pollIntervalMs: 1000, enabled: false }
    );

    await expect(service.create(user, randomUUID(), {
      sourceAssetId: randomUUID(), sourceFormat: "dwg"
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

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

  it("uses read access and returns empty candidates without reading or rewriting historical rows", async () => {
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
    expect(result).toEqual({ jobId, candidates: [] });
    expect(prisma.floorImportCandidate.findMany).not.toHaveBeenCalled();
    expect(access.assert).toHaveBeenCalledWith(user, "site-1", "read");
  });

  it.each([false, true])("rejects nonempty candidateIds before legacy/prepared work (prepared=%s)", async prepared => {
    const floorId = randomUUID(); const jobId = randomUUID();
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      floorImportJob: { findFirst: jest.fn().mockResolvedValue({ preparedMapGenerationId: randomUUID() }) },
      $transaction: jest.fn()
    };
    const preparation: any = { readPrepared: jest.fn() };
    const service = new (FloorImportService as any)(prisma, { assert: jest.fn() }, { record: jest.fn() },
      undefined, undefined, undefined, prepared ? preparation : undefined, prepared ? {} : undefined);
    await expect(service.apply(user, floorId, jobId, {
      expectedRevision: 0, leaseToken: "lease-token", leaseFence: 1,
      confirmMapReset: true, candidateIds: [randomUUID()]
    })).rejects.toThrow(BadRequestException);
    expect(prisma.floorImportJob.findFirst).not.toHaveBeenCalled();
    expect(preparation.readPrepared).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns the accepted candidates from the completed import backing the current floor background", async () => {
    const floorId = randomUUID();
    const jobId = randomUUID();
    const renderedAssetId = randomUUID();
    const candidateId = randomUUID();
    const renderedAssetPath = `/api/floors/${floorId}/assets/${renderedAssetId}/content`;
    const tx: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({
        id: floorId,
        siteId: "site-1",
        mapRevision: 9,
        floorPlan: {
          imageUrl: renderedAssetPath,
          renderedImageUrl: renderedAssetPath,
          width: 640,
          height: 360
        }
      }) },
      floorImportJob: { findFirst: jest.fn().mockResolvedValue({
        id: jobId,
        renderedAssetId,
        appliedAt: new Date("2026-09-17T00:00:00.000Z"),
        candidates: [{
          id: candidateId, sourceEntityId: "insert-1", layerName: "LIGHT", blockName: "LED",
          x: 10, y: 20, rotation: 90, confidence: 0.95, detectionMethod: "rule_based",
          provider: null, model: null, inputDigest: null, profileVersion: "rules-v1",
          profileDigest: "a".repeat(64), reviewStatus: "accepted"
        }]
      }) }
    };
    const prisma: any = { $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)) };
    const access: any = { assertReadInTransaction: jest.fn() };
    const service = new FloorImportService(prisma, access, { record: jest.fn() } as any);

    await expect(service.getAppliedOverlay(user, floorId)).resolves.toEqual({
      overlay: {
        floorId,
        jobId,
        revision: 9,
        renderedAssetId,
        renderedAssetPath,
        renderedViewport: { width: 640, height: 360 },
        appliedAt: "2026-09-17T00:00:00.000Z",
        candidates: [expect.objectContaining({ id: candidateId, reviewStatus: "accepted" })]
      }
    });
    expect(access.assertReadInTransaction).toHaveBeenCalledWith(tx, user, "site-1");
    expect(tx.floorImportJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        floorId,
        renderedAssetId,
        status: "completed",
        appliedAt: { not: null },
        completedAt: { not: null }
      })
    }));
    expect(tx.floorImportJob.findFirst.mock.calls[0][0].where).not.toHaveProperty("status.in");
  });

  it("returns no applied overlay when the current background is not a completed CAD render", async () => {
    const floorId = randomUUID();
    const tx: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({
        id: floorId,
        siteId: "site-1",
        mapRevision: 9,
        floorPlan: {
          imageUrl: "/api/floors/another-floor/assets/not-current/content",
          renderedImageUrl: "/api/floors/another-floor/assets/not-current/content",
          width: 640,
          height: 360
        }
      }) },
      floorImportJob: { findFirst: jest.fn() }
    };
    const service = new FloorImportService(
      { $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)) } as any,
      { assertReadInTransaction: jest.fn() } as any,
      { record: jest.fn() } as any
    );

    await expect(service.getAppliedOverlay(user, floorId)).resolves.toEqual({ overlay: null });
    expect(tx.floorImportJob.findFirst).not.toHaveBeenCalled();
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
      where: { floorId, status: { in: ["queued", "processing", "region_selection_required", "review_required"] } }
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

  it("returns the same validated viewport for a legacy identity-encoded review job", async () => {
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
        contentEncoding: null,
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
    const storage = { readFloorRenderedMetadata: jest.fn().mockResolvedValue({ width: 640, height: 360 }) };
    const service = new FloorImportService(
      prisma,
      access,
      { record: jest.fn() } as any,
      storage as any
    );

    await expect(service.get(user, floorId, reviewJob.id)).resolves.toMatchObject({
      jobId: reviewJob.id,
      renderedViewport: { width: 640, height: 360 }
    });
    expect(access.assert).toHaveBeenCalledWith(user, "site-1", "read");
    expect(storage.readFloorRenderedMetadata).toHaveBeenCalledWith(
      `floors/${floorId}/${renderedAssetId}.svg`,
      { sizeBytes: 512, sha256: "c".repeat(64), mimeType: "image/svg+xml", contentEncoding: null }
    );
  });

  it("reconciles an unknown rendered SVG before returning review data", async () => {
    const floorId = randomUUID();
    const renderedAssetId = randomUUID();
    const renderedAsset = {
      id: renderedAssetId, objectKey: `floors/${floorId}/${renderedAssetId}.svg`, status: "ready",
      mimeType: "image/svg+xml", contentEncoding: "unknown", sizeBytes: 512n,
      sha256: "d".repeat(64), cleanupStartedAt: null
    };
    const reviewJob = job({ floorId, renderedAssetId, status: "review_required", renderedAsset });
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      floorImportJob: { findFirst: jest.fn().mockResolvedValue(reviewJob) }
    };
    const reconciler: any = {
      reconcile: jest.fn().mockResolvedValue({ width: 800, height: 600, contentEncoding: "gzip" })
    };
    const service = new FloorImportService(
      prisma, { assert: jest.fn() } as any, { record: jest.fn() } as any, {} as any, reconciler
    );

    await expect(service.get(user, floorId, reviewJob.id)).resolves.toMatchObject({
      jobId: reviewJob.id, renderedViewport: { width: 800, height: 600 }
    });
    expect(reconciler.reconcile).toHaveBeenCalledWith(expect.objectContaining({ id: renderedAssetId, contentEncoding: "unknown" }));
  });

  it("cancels an active job with a fenced state transition and leaves terminal jobs unchanged", async () => {
    const floorId = randomUUID(); const row = job({ floorId, status: "processing", leaseOwner: "worker", leaseExpiresAt: new Date() });
    const cancelled = job({ ...row, status: "cancelled", leaseOwner: null, leaseExpiresAt: null, cancelledAt: new Date() });
    const tx: any = { $queryRaw: jest.fn().mockResolvedValue([{ id: floorId }]), floorImportJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue(cancelled) } };
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx))
    };
    const access: any = { assert: jest.fn(), assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1", organizationId: user.organizationId }) };
    const service = new FloorImportService(prisma, access, { record: jest.fn() } as any);
    await expect(service.cancel(user, floorId, row.id)).resolves.toMatchObject({ status: "cancelled" });
    expect(tx.floorImportJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: row.id, floorId,
        status: { in: ["queued", "processing", "region_selection_required", "review_required"] }
      },
      data: expect.objectContaining({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null, preparedMapGenerationId: null })
    }));
  });

  it.each(["geometry", "historical candidates", "unselected legacy digest", "missing digest"])("applies geometry without candidate writes or fails closed: %s", async mode => {
    const floorId = randomUUID(); const jobId = randomUUID(); const sourceAssetId = randomUUID();
    const renderedAssetId = randomUUID(); const acceptedId = randomUUID(); const rejectedId = randomUUID();
    const floor = {
      id: floorId, siteId: "site-1", status: "active", mapRevision: 4, editorLeaseFence: 8,
      editorLeaseTokenHash: hashEditorLeaseToken("lease-token"), editorLeaseExpiresAt: new Date("2026-09-17T00:10:00.000Z"),
      floorPlan: null,
      fixtures: Array.from({ length: 4 }, (_, index) => ({
        id: randomUUID(), name: `Existing ${index + 1}`, ratedWatt: 40, x: 0, y: 0,
        size: 20, placementStatus: "unplaced", positionVerifiedAt: null
      })),
      mapObjects: [],
      lightSlots: [{ id: randomUUID(), x: 12, y: 34, rotation: 15, assignedFixtureId: null }]
    };
    const tx: any = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{
          status: floor.status, mapRevision: floor.mapRevision, editorLeaseFence: floor.editorLeaseFence,
          editorLeaseTokenHash: floor.editorLeaseTokenHash, editorLeaseExpiresAt: floor.editorLeaseExpiresAt,
          dbNow: new Date("2026-09-17T00:00:00.000Z"), jobStatus: "review_required",
          excludedRegionPrimitiveCount: 0,
          sourceAssetId, renderedAssetId, renderedMimeType: "image/svg+xml", renderedContentEncoding: "gzip",
          renderedObjectKey: `floors/${floorId}/${renderedAssetId}.svg`, renderedSizeBytes: 256n,
          renderedSha256: "b".repeat(64)
        }]),
      floorImportCandidate: {
        findMany: jest.fn().mockResolvedValue(mode !== "historical candidates" ? [] : [
          { id: acceptedId, x: 12, y: 34, rotation: 15 },
          { id: rejectedId, x: 56, y: 78, rotation: 0 }
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      floorImportRegion: { findMany: jest.fn().mockResolvedValue([
        { regionId: "selected", candidateIdentityDigest: EMPTY_REGION_DIGEST },
        { regionId: "unselected", candidateIdentityDigest: mode === "unselected legacy digest" ? "a".repeat(64)
          : mode === "missing digest" ? null : EMPTY_REGION_DIGEST }
      ]) },
      floorImportJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      floorPlan: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
      floorCadScene: {
        findUnique: jest.fn().mockResolvedValue({ version: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      floorMapObject: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
      fixture: { updateMany: jest.fn().mockResolvedValue({ count: 4 }) },
      floorLightSlot: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 })
      },
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
      floorImportRegion: { findFirst: jest.fn().mockResolvedValue(null) },
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

    const applying = service.apply(user, floorId, jobId, {
      expectedRevision: 4, leaseToken: "lease-token", leaseFence: 8,
      confirmMapReset: true, candidateIds: []
    });
    if (mode !== "geometry") {
      await expect(applying).rejects.toBeInstanceOf(ConflictException);
      await expect(applying).rejects.toThrow(/cancel.*re-import/i);
      expect(tx.floorImportCandidate.updateMany).not.toHaveBeenCalled();
      expect(tx.floorLightSlot.deleteMany).not.toHaveBeenCalled();
      expect(tx.floorImportJob.updateMany).not.toHaveBeenCalled();
      expect(tx.floorMapObject.deleteMany).not.toHaveBeenCalled();
      expect(tx.fixture.updateMany).not.toHaveBeenCalled();
      expect(tx.floorPlan.upsert).not.toHaveBeenCalled();
      expect(tx.floorMapRevision.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      return;
    }
    const result = await applying;

    expect(result).toMatchObject({
      jobId, status: "completed", revision: 5, acceptedCandidateIds: [],
      deletedObjectCount: 2, unplacedFixtureCount: 4, deletedSlotCount: 1, createdSlotCount: 0
    });
    expect(storage.readFloorRenderedMetadata).toHaveBeenCalledWith(`floors/${floorId}/${renderedAssetId}.svg`, {
      sizeBytes: 256, sha256: "b".repeat(64), mimeType: "image/svg+xml", contentEncoding: "gzip"
    });
    expect(tx.$queryRaw.mock.calls[0][0].strings.join(" ")).toContain("FOR UPDATE OF floor, job, source, rendered");
    expect(tx.floorPlan.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { floorId },
      create: expect.objectContaining({ floorId, sourceType: "image", width: 640, height: 480 })
    }));
    expect(tx.floorImportCandidate.updateMany).not.toHaveBeenCalled();
    expect(tx.floorMapObject.deleteMany).toHaveBeenCalledWith({ where: { floorId } });
    expect(tx.fixture.updateMany).toHaveBeenCalledWith({
      where: { floorId, ...activeFixtureRegistrationWhere },
      data: { placementStatus: "unplaced", positionVerifiedAt: null, x: 0, y: 0 }
    });
    expect(tx.floor.findUnique).toHaveBeenCalledWith(expect.objectContaining({ include: expect.objectContaining({
      fixtures: { where: activeFixtureRegistrationWhere, orderBy: { id: "asc" } }
    }) }));
    expect(tx.floorLightSlot.deleteMany).toHaveBeenCalledWith({ where: { floorId } });
    expect(tx.floorCadScene.deleteMany).toHaveBeenCalledWith({ where: { floorId } });
    expect(tx.floorLightSlot.createMany).not.toHaveBeenCalled();
    expect(tx.floorMapRevision.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      floorId, revision: 5, snapshot: expect.objectContaining({
        fixtures: expect.arrayContaining([
          expect.objectContaining({ id: floor.fixtures[0].id, ratedWatt: "40", placementStatus: "unplaced", x: 0, y: 0 })
        ]),
        objects: [],
        lightSlots: floor.lightSlots
      })
    }) }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: "floor_import.applied", targetId: jobId, transaction: tx
    }));
  });

  it.each(["geometry", "unselected legacy digest", "missing digest"])("validates every persisted digest after prepared apply locks: %s", async mode => {
    const floorId = randomUUID(), jobId = randomUUID(), generationId = randomUUID();
    const now = new Date("2026-09-17T00:00:00.000Z");
    const ref = { formatVersion: 1, generationId, revision: 1, width: 640, height: 512, gridSize: 10, elementCount: 1,
      manifest: { assetId: randomUUID(), sha256: "a".repeat(64), byteSize: 100, decodedByteSize: 500 } };
    const events: string[] = [];
    const floor = { id: floorId, siteId: "site-1", status: "active", mapRevision: 0, editorLeaseHolderId: user.id,
      editorLeaseFence: 8, editorLeaseTokenHash: hashEditorLeaseToken("lease-token"),
      editorLeaseExpiresAt: new Date("2026-09-17T00:10:00.000Z"), floorPlan: null, fixtures: [], mapObjects: [], lightSlots: [] };
    const tx: any = {
      $queryRaw: jest.fn(async (query: any) => {
        const sql = (query.strings ?? query).join(" ");
        if (sql.includes('FROM "FloorImportJob"')) events.push("job locked");
        return sql.includes(" AS now") ? [{ now }] : [];
      }),
      $executeRaw: jest.fn().mockResolvedValue(0),
      floor: { findUniqueOrThrow: jest.fn().mockResolvedValue(floor), update: jest.fn() },
      floorImportJob: { findFirst: jest.fn().mockResolvedValue({ id: jobId, status: "review_required", renderedAssetId: randomUUID(),
        preparedMapGenerationId: generationId, excludedRegionPrimitiveCount: 0, preparedMapGeneration: {
          status: "prepared", baseRevision: 1, sourceGenerationId: null, sourceRevision: null
        } }), update: jest.fn() },
      floorImportRegion: { findMany: jest.fn(async () => {
        events.push("region digest read");
        return [{ regionId: "selected", candidateIdentityDigest: EMPTY_REGION_DIGEST },
          { regionId: "unselected", candidateIdentityDigest: mode === "unselected legacy digest" ? "a".repeat(64)
            : mode === "missing digest" ? null : EMPTY_REGION_DIGEST }];
      }) },
      floorImportCandidate: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      floorMapDocument: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      floorMapGeneration: { update: jest.fn() },
      floorMapRevision: { create: jest.fn().mockResolvedValue({ id: randomUUID() }) },
      floorMapObject: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      floorLightSlot: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      floorCadScene: { deleteMany: jest.fn() },
      fixture: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      floorPlan: { upsert: jest.fn() }
    };
    const prisma: any = { floor: { findUnique: jest.fn().mockResolvedValue(floor) },
      floorImportJob: { findFirst: jest.fn().mockResolvedValue({ preparedMapGenerationId: generationId }) },
      $transaction: jest.fn((run: (client: any) => unknown) => run(tx)) };
    const access: any = { assert: jest.fn(), assertManageInTransaction: jest.fn().mockResolvedValue({ organizationId: user.organizationId }) };
    const audit: any = { record: jest.fn() };
    const preparation: any = { readPrepared: jest.fn().mockResolvedValue(ref), readDisplayManifest: jest.fn() };
    const store: any = { readManifest: jest.fn(), pinRevision: jest.fn() };
    const service = new FloorImportService(prisma, access, audit, undefined, undefined, undefined, preparation, store);
    const applying = service.apply(user, floorId, jobId, { expectedRevision: 0, leaseToken: "lease-token", leaseFence: 8,
      candidateIds: [], confirmMapReset: true });
    if (mode !== "geometry") {
      await expect(applying).rejects.toBeInstanceOf(ConflictException);
      await expect(applying).rejects.toThrow(/cancel.*re-import/i);
      for (const mutation of [tx.floorImportJob.update, tx.floorMapObject.deleteMany, tx.floorLightSlot.deleteMany,
        tx.fixture.updateMany, tx.floorPlan.upsert, tx.floorCadScene.deleteMany, tx.floorMapRevision.create,
        tx.floorMapDocument.create, tx.floorMapGeneration.update, tx.floor.update, audit.record, store.pinRevision]) {
        expect(mutation).not.toHaveBeenCalled();
      }
    } else {
      await expect(applying).resolves.toMatchObject({ status: "completed", mapDocument: ref, createdSlotCount: 0, acceptedCandidateIds: [] });
    }
    expect(events).toEqual(["job locked", "region digest read"]);
    expect(tx.$executeRaw.mock.calls[0][0].join(""))
      .toBe('SELECT "lock_automation_membership_mutation"()');
    if (mode !== "geometry") expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.floorImportCandidate.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["stale lease", { editorLeaseFence: 9 }, "floor editor lease is no longer active"],
    ["stale revision", { mapRevision: 5 }, "floor editor revision conflict"]
  ])("rejects apply with %s", async (_label, floorOverride, message) => {
    const floorId = randomUUID(); const jobId = randomUUID(); const renderedAssetId = randomUUID();
    const tx: any = { $executeRaw: jest.fn().mockResolvedValue(0), $queryRaw: jest.fn().mockResolvedValue([{ status: "active", mapRevision: 4, editorLeaseFence: 8,
      editorLeaseTokenHash: hashEditorLeaseToken("lease-token"), editorLeaseExpiresAt: new Date("2026-09-17T00:10:00.000Z"),
      dbNow: new Date("2026-09-17T00:00:00.000Z"), jobStatus: "review_required", sourceAssetId: randomUUID(), renderedAssetId,
      excludedRegionPrimitiveCount: 0,
      renderedMimeType: "image/svg+xml", renderedContentEncoding: "gzip", renderedObjectKey: "floors/f/render.svg",
      renderedSizeBytes: 256n, renderedSha256: "b".repeat(64), ...floorOverride }]) };
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      floorImportRegion: { findFirst: jest.fn().mockResolvedValue(null) },
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
      expectedRevision: 4, leaseToken: "lease-token", leaseFence: 8,
      confirmMapReset: true, candidateIds: []
    })).rejects.toThrow(message);
  });

  it("rejects apply when the rendered ledger identity changes after HEAD verification", async () => {
    const floorId = randomUUID(); const jobId = randomUUID(); const renderedAssetId = randomUUID();
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      floorImportRegion: { findFirst: jest.fn().mockResolvedValue(null) },
      floorImportJob: { findFirst: jest.fn().mockResolvedValue({ renderedAsset: {
        id: renderedAssetId, objectKey: `floors/${floorId}/render.svg`, status: "ready", mimeType: "image/svg+xml", contentEncoding: "gzip",
        sizeBytes: 256n, sha256: "b".repeat(64), cleanupStartedAt: null
      } }) },
      $transaction: jest.fn((run: (client: any) => unknown) => run({
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([{
          status: "active", mapRevision: 4, editorLeaseFence: 8,
          editorLeaseTokenHash: hashEditorLeaseToken("lease-token"), editorLeaseExpiresAt: new Date("2026-09-17T00:10:00.000Z"),
          dbNow: new Date("2026-09-17T00:00:00.000Z"), jobStatus: "review_required", sourceAssetId: randomUUID(),
          excludedRegionPrimitiveCount: 0,
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
      expectedRevision: 4, leaseToken: "lease-token", leaseFence: 8,
      confirmMapReset: true, candidateIds: []
    })).rejects.toThrow("rendered floor asset changed concurrently");
  });

  it("fails closed before candidate or map mutation when a locked legacy job lacks excluded-region metadata", async () => {
    const floorId = randomUUID(); const jobId = randomUUID(); const renderedAssetId = randomUUID();
    const findCandidates = jest.fn();
    const deleteObjects = jest.fn();
    const tx: any = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([{
        status: "active", mapRevision: 4, editorLeaseFence: 8,
        editorLeaseTokenHash: hashEditorLeaseToken("lease-token"), editorLeaseExpiresAt: new Date("2026-09-17T00:10:00.000Z"),
        dbNow: new Date("2026-09-17T00:00:00.000Z"), jobStatus: "review_required",
        excludedRegionPrimitiveCount: null, sourceAssetId: randomUUID(), renderedAssetId,
        renderedMimeType: "image/svg+xml", renderedContentEncoding: "gzip",
        renderedObjectKey: `floors/${floorId}/render.svg`, renderedSizeBytes: 256n, renderedSha256: "b".repeat(64)
      }]),
      floorImportCandidate: { findMany: findCandidates },
      floorMapObject: { deleteMany: deleteObjects }
    };
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }) },
      floorImportRegion: { findFirst: jest.fn().mockResolvedValue(null) },
      floorImportJob: { findFirst: jest.fn().mockResolvedValue({ renderedAsset: {
        id: renderedAssetId, objectKey: `floors/${floorId}/render.svg`, status: "ready",
        mimeType: "image/svg+xml", contentEncoding: "gzip", sizeBytes: 256n,
        sha256: "b".repeat(64), cleanupStartedAt: null
      } }) },
      $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx))
    };
    const service = new FloorImportService(
      prisma,
      { assert: jest.fn(), assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1", organizationId: user.organizationId }) } as any,
      { record: jest.fn() } as any,
      { readFloorRenderedMetadata: jest.fn().mockResolvedValue({ width: 640, height: 480 }) } as any
    );

    await expect(service.apply(user, floorId, jobId, {
      expectedRevision: 4, leaseToken: "lease-token", leaseFence: 8,
      confirmMapReset: true, candidateIds: []
    })).rejects.toThrow(/re-import required/i);
    expect(tx.$queryRaw.mock.calls[0][0].strings.join(" ")).toContain('job."excludedRegionPrimitiveCount"');
    expect(findCandidates).not.toHaveBeenCalled();
    expect(deleteObjects).not.toHaveBeenCalled();
  });

  it("does not disclose a floor or job outside the caller's readable site", async () => {
    const prisma: any = { floor: { findUnique: jest.fn().mockResolvedValue({ id: randomUUID(), siteId: "site-1" }) } };
    const access: any = { assert: jest.fn().mockRejectedValue(new ForbiddenException()) };
    const service = new FloorImportService(prisma, access, { record: jest.fn() } as any);
    await expect(service.get(user, randomUUID(), randomUUID())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma).not.toHaveProperty("floorImportJob.findFirst");
  });
});

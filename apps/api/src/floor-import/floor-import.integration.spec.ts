import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditService } from "../audit/audit.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuthService } from "../auth/auth.service";
import { FloorAssetCleanupService } from "../floor-editor/floor-asset-cleanup.service";
import { FloorAssetsService } from "../floor-editor/floor-assets.service";
import { FloorEditorService } from "../floor-editor/floor-editor.service";
import { FloorMapService } from "../floor-map/floor-map.service";
import { FloorEditorModule } from "../floor-editor/floor-editor.module";
import { hashEditorLeaseToken } from "../floor-editor/editor-lease-token";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";
import { ObjectStorageService } from "../storage/object-storage.service";
import { buildCadScene } from "./cad-scene-builder";
import { computeCandidateRegionDigests } from "./cad-candidate-region-digest";
import { ChildProcessCadCoreExecutor } from "./cad-core-executor";
import { cadRegionPreviewPersistenceIdentity, cadScenePersistenceIdentity } from "./cad-scene-persistence";
import { FloorImportService } from "./floor-import.service";
import { CAD_IMPORT_WORKER_OPTIONS, FloorImportWorkerService } from "./floor-import-worker.service";
import { FloorImportAttemptCleanupService } from "./floor-import-attempt-cleanup.service";
import { FloorImportModule } from "./floor-import.module";
import { FixedLightingDetectorRegistry, PROVIDED_SAMPLE_DWG_SHA256 } from "./lighting-detector-registry";

const enabled = process.env.FLOOR_IMPORT_INTEGRATION === "1";
const EMPTY_CANDIDATE_IDENTITY_DIGEST = createHash("sha256").update(JSON.stringify([]), "utf8").digest("hex");
(enabled ? describe : describe.skip)("floor import PostgreSQL lifecycle", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let prisma: PrismaClient;
  let databaseUrl: string;
  const organizationId = randomUUID();
  const userId = randomUUID();
  const siteId = randomUUID();
  const floorId = randomUUID();
  const user = {
    id: userId, organizationId, organizationType: "customer" as const, loginId: "cad-admin",
    name: "CAD Admin", role: "admin" as const, status: "active" as const, mustChangePassword: false
  };
  const access = {
    assert: jest.fn().mockResolvedValue({ id: siteId, organizationId }),
    assertReadInTransaction: jest.fn().mockResolvedValue({ id: siteId, organizationId }),
    assertManageInTransaction: jest.fn().mockResolvedValue({ id: siteId, organizationId })
  };
  const storage: any = { readFloorRenderedMetadata: jest.fn().mockResolvedValue({ width: 640, height: 480 }) };
  const terminalProfile = {
    detectorProfileId: "generic-lighting-v1" as const,
    detectorProfileVersion: "legacy-unknown",
    detectorProfileDigest: "0".repeat(64)
  };

  beforeAll(async () => {
    cluster = await disposablePostgres();
    databaseUrl = cluster.database();
    const deployed = cluster.deploy(databaseUrl);
    if (deployed.status !== 0) throw new Error(deployed.stderr || deployed.stdout);
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    await prisma.organization.create({ data: { id: organizationId, name: "CAD import", type: "customer" } });
    await prisma.user.create({ data: {
      id: userId, organizationId, loginId: user.loginId, name: user.name, passwordHash: "unused", role: "admin"
    } });
    await prisma.site.create({ data: { id: siteId, organizationId, adminUserId: userId, name: "CAD site", timeZone: "UTC" } });
    await prisma.floor.create({ data: { id: floorId, siteId, name: "CAD floor", level: 1 } });
  }, 90_000);

  beforeEach(async () => {
    await prisma.floorImportAttemptCleanup.deleteMany();
    await prisma.floorImportJob.deleteMany({ where: { floorId } });
    await prisma.floorMapRevision.deleteMany({ where: { floorId } });
    await prisma.floorMapObject.deleteMany({ where: { floorId } });
    await prisma.lightingSchedule.deleteMany({ where: { siteId } });
    await prisma.fixtureGroup.deleteMany({ where: { siteId } });
    await prisma.fixture.deleteMany({ where: { floorId } });
    await prisma.floorPlan.deleteMany({ where: { floorId } });
    await prisma.floorAsset.deleteMany({ where: { floorId } });
    await prisma.auditLog.deleteMany({ where: { siteId } });
    await prisma.floor.update({ where: { id: floorId }, data: {
      mapRevision: 0, editorLeaseFence: 0, editorLeaseTokenHash: null,
      editorLeaseHolderId: null, editorLeaseHolderName: null,
      editorLeaseAcquiredAt: null, editorLeaseExpiresAt: null
    } });
    await prisma.site.update({ where: { id: siteId }, data: { adminUserId: userId } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    cluster?.stop();
  });

  async function sourceAsset(mimeType = "application/dxf", sha256 = "a".repeat(64)) {
    const id = randomUUID();
    return prisma.floorAsset.create({ data: {
      id, floorId, kind: "original", status: "ready", objectKey: `floors/${floorId}/${id}.${mimeType.includes("dwg") ? "dwg" : "dxf"}`,
      mimeType, sizeBytes: 128n, sha256, readyAt: new Date()
    } });
  }

  async function renderedAsset() {
    const id = randomUUID();
    return prisma.floorAsset.create({ data: {
      id, floorId, kind: "rendered", status: "ready",
      objectKey: `floors/${floorId}/${id}.svg`, mimeType: "image/svg+xml",
      contentEncoding: "gzip",
      sizeBytes: 256n, sha256: "b".repeat(64), readyAt: new Date()
    } });
  }

  async function regionPreviewAsset(suffix: string) {
    const id = randomUUID();
    return prisma.floorAsset.create({ data: {
      id, floorId, kind: "cad_region_preview", status: "ready",
      objectKey: `floors/${floorId}/${suffix}-${id}.svg`, mimeType: "image/svg+xml",
      contentEncoding: "gzip", sizeBytes: 64n, sha256: suffix.repeat(64).slice(0, 64), readyAt: new Date()
    } });
  }

  async function writeNativeCoreArtifacts(
    jobId: string,
    artifactDirectory: string,
    region: {
      regionId: string;
      bounds: { minX: number; minY: number; maxX: number; maxY: number };
      primitiveCount: number;
      textCount: number;
      lightCandidateCount: number;
      area: number;
    }
  ) {
    const identity = cadScenePersistenceIdentity(jobId, region.regionId);
    const previewIdentity = cadRegionPreviewPersistenceIdentity(jobId, region.regionId);
    const built = buildCadScene({
      version: 1, bounds: region.bounds, blocks: [],
      entities: [{
        type: "line", sourceEntityId: "fixture-line", layer: "WALL",
        start: { x: region.bounds.minX, y: region.bounds.minY, z: 0 },
        end: { x: region.bounds.maxX, y: region.bounds.maxY, z: 0 }
      }]
    }, { ...region, primitiveCount: 1 }, {
      sceneId: identity.sceneId,
      manifestAssetId: identity.manifestAssetId,
      tileAssetId: identity.tileAssetId
    });
    const previewBytes = Buffer.from("preview");
    const previewFilename = `${previewIdentity.assetId}.svg`;
    const manifestFilename = `${identity.manifestAssetId}.json`;
    await writeFile(join(artifactDirectory, previewFilename), previewBytes);
    await writeFile(join(artifactDirectory, manifestFilename), built.manifestPayload);
    for (const tile of built.tiles) {
      await writeFile(join(artifactDirectory, `${tile.descriptor.assetId}.bin`), tile.payload);
    }
    return {
      regionPreviews: [{
        regionId: region.regionId,
        assetId: previewIdentity.assetId,
        filename: previewFilename,
        sizeBytes: previewBytes.byteLength,
        sha256: createHash("sha256").update(previewBytes).digest("hex"),
        viewport: { width: 1_200, height: 1_200 }
      }],
      scene: {
        sceneId: identity.sceneId,
        manifestAssetId: identity.manifestAssetId,
        manifestFilename,
        manifestByteSize: built.manifest.byteSize,
        manifestSha256: built.manifest.sha256,
        width: built.manifest.width,
        height: built.manifest.height,
        sourceBounds: { ...built.manifest.sourceBounds },
        transform: { ...built.manifest.transform }
      }
    };
  }

  function service() {
    return new FloorImportService(prisma as never, access as never, new AuditService(prisma as never), storage as never);
  }

  function worker() {
    return new FloorImportWorkerService(
      prisma as never, {} as never, {} as never, {} as never, {} as never,
      { tempRoot: "/tmp", pollIntervalMs: 1000, enabled: false }
    );
  }

  it("enforces one active job per floor and releases the key after cancellation", async () => {
    const first = await sourceAsset(); const second = await sourceAsset();
    const imports = service();
    const created = await imports.create(user, floorId, { sourceAssetId: first.id, sourceFormat: "dxf" });
    await expect(imports.create(user, floorId, { sourceAssetId: second.id, sourceFormat: "dxf" }))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(imports.cancel(user, floorId, created.jobId)).resolves.toMatchObject({ status: "cancelled" });
    await expect(imports.create(user, floorId, { sourceAssetId: second.id, sourceFormat: "dxf" }))
      .resolves.toMatchObject({ status: "queued", sourceAssetId: second.id });
  });

  it("persists 1817 fractional regions through selection, native apply and editor/map manifest reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-metadata-"));
    const source = await sourceAsset();
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, sourceFormat: "dxf", detectorProfileId: "generic-lighting-v1"
    } });
    const regions = Array.from({ length: 1817 }, (_, index) => ({
      regionId: `region-${String(index).padStart(24, "0")}`,
      bounds: { minX: 2961649.2519802507 + index * 200, minY: -370361.30238082947,
        maxX: 2961749.2519802507 + index * 200, maxY: -370261.30238082947 },
      primitiveCount: 2, textCount: 1, lightCandidateCount: 0, area: 10_000
    }));
    const regionPreviews = regions.map(region => {
      const identity = cadRegionPreviewPersistenceIdentity(job.id, region.regionId);
      return { regionId: region.regionId, assetId: identity.assetId, filename: `${identity.assetId}.svg`,
        sizeBytes: 64, sha256: "b".repeat(64), viewport: { width: 100, height: 100 } };
    });
    const verified = new Map<string, any>();
    let manifestPayload: Buffer | undefined;
    const workerStorage: any = {
      downloadFloorAssetToFile: jest.fn(async (_key, path) => writeFile(path, "source")),
      putFloorRenderedObjectFile: jest.fn(async (key, _path, rendered, viewport) => {
        verified.set(key, { sizeBytes: rendered.sizeBytes, sha256: rendered.sha256,
          contentType: "image/svg+xml", contentEncoding: "gzip",
          metadata: { "cad-width": String(viewport.width), "cad-height": String(viewport.height) } });
      }),
      verifyFloorRenderedObject: jest.fn(), deleteObject: jest.fn(),
      putCadSceneObjectFile: jest.fn(),
      verifyCadSceneObject: jest.fn(async (key, expected) => {
        // Metadata must not be published while any object is still unverified.
        if (verified.size === 1816) {
          expect(await prisma.floorImportRegion.count({ where: { jobId: job.id } })).toBe(0);
          expect(await prisma.floorAsset.count({ where: { floorId, kind: "cad_region_preview", status: "ready" } })).toBe(0);
        }
        verified.set(key, expected);
      })
    };
    const registry = new FixedLightingDetectorRegistry();
    const profile = registry.get("generic-lighting-v1");
    const core: any = { execute: jest.fn().mockResolvedValue({
      profileId: "generic-lighting-v1", profileVersion: profile.profileVersion, profileDigest: profile.profileDigest,
      regions, regionPreviews, candidates: [], candidateRegionAssignments: [], excludedRegionPrimitiveCount: 7,
      rendered: { viewport: { width: 100, height: 100 } }
    }) };
    const converter: any = { convert: jest.fn(async ({ outputPath }) => writeFile(outputPath, "converted")) };
    const cleanup = new FloorImportAttemptCleanupService(prisma as never, workerStorage,
      { tempRoot: root, pollIntervalMs: 1000, enabled: false });
    const worker = new FloorImportWorkerService(prisma as never, workerStorage, converter, registry, core,
      { tempRoot: root, pollIntervalMs: 1000, enabled: false }, cleanup);
    try {
      expect(await worker.runOnce()).toBe(true);
      expect(verified.size).toBe(1817);
      expect(await prisma.floorImportRegion.count({ where: { jobId: job.id } })).toBe(1817);
      expect(await prisma.floorImportRegion.findFirstOrThrow({ where: { jobId: job.id }, orderBy: { regionId: "desc" } }))
        .toMatchObject({ textCount: 1, lightCandidateCount: 0, previewWidth: 100, previewHeight: 100 });
      const send = jest.fn(async (command: any) => {
        const expected = verified.get(command.input.Key)!;
        return { ContentLength: expected.sizeBytes, ContentType: expected.contentType,
          ContentEncoding: expected.contentEncoding, ChecksumSHA256: Buffer.from(expected.sha256, "hex").toString("base64"),
          Metadata: expected.metadata,
          ...(expected.contentType === "application/json" ? { Body: (async function* () { yield manifestPayload!; })() } : {}) };
      });
      const presignGet = jest.fn().mockResolvedValue("https://private.invalid/preview");
      const realStorage = new ObjectStorageService({ send } as never, { bucket: "isolated", publicBaseUrl: "", presignGet });
      const imports = new FloorImportService(prisma as never, access as never, new AuditService(prisma as never), realStorage);
      const listed = await imports.listRegions(user, floorId, job.id);
      expect(listed.regions).toHaveLength(1817);
      expect(listed.excludedRegionPrimitiveCount).toBe(7);
      expect(listed.regions.at(-1)?.regionId).toBe(regions.at(-1)!.regionId);
      expect(listed.regions[0].bounds).toEqual(regions[0].bounds);
      expect(listed.regions.at(-1)!.bounds).toEqual(regions.at(-1)!.bounds);
      expect(send).not.toHaveBeenCalled();
      const selected = await imports.selectRegion(user, floorId, job.id, { regionId: regions.at(-1)!.regionId });
      expect(selected.selectedRegionId).toBe(regions.at(-1)!.regionId);
      expect(selected.regions).toHaveLength(1817);
      expect(send).not.toHaveBeenCalled();
      const assets = new FloorAssetsService(prisma as never, realStorage, access as never);
      const preview = selected.regions.at(-1)!.preview;
      await expect(assets.getContentRedirect(user, floorId, preview.assetId)).resolves.toEqual({ url: "https://private.invalid/preview" });
      expect(send).toHaveBeenCalledTimes(1);
      const validHead = await send.mock.results[0].value;
      // Exercise the real storage verifier, not a stubbed integrity decision.
      for (const change of [
        { ContentLength: 65 }, { ContentType: "text/plain" }, { ContentEncoding: undefined },
        { ChecksumSHA256: "invalid" },
        { Metadata: { ...validHead.Metadata, "cad-region-id": "wrong" } },
        { Metadata: { ...validHead.Metadata, "cad-max-x": "0" } },
        { Metadata: { ...validHead.Metadata, "cad-text-count": "0" } },
        { Metadata: { ...validHead.Metadata, "cad-width": "99" } }
      ]) {
        send.mockResolvedValueOnce({ ...validHead, ...change } as any);
        await expect(assets.getContentRedirect(user, floorId, preview.assetId)).rejects.toBeInstanceOf(ServiceUnavailableException);
      }
      expect(send).toHaveBeenCalledTimes(9);
      expect(presignGet).toHaveBeenCalledTimes(1);
      const detection = await core.execute.mock.results[0].value;
      core.execute.mockImplementationOnce(async ({ renderedPath, artifactDirectory }: any) => {
        await writeFile(renderedPath, "gzip-svg");
        const artifacts = await writeNativeCoreArtifacts(job.id, artifactDirectory, regions.at(-1)!);
        manifestPayload = await readFile(join(artifactDirectory, artifacts.scene.manifestFilename));
        return { ...detection, scene: artifacts.scene, regionPreviews: [], selectedCandidates: [],
          rendered: { sizeBytes: 8, sha256: "f".repeat(64), contentEncoding: "gzip", viewport: { width: 1200, height: 1200 } } };
      });
      expect(await worker.runOnce()).toBe(true);
      expect(await prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "review_required" });
      const selectedCore = await core.execute.mock.results[1].value;
      const scene = selectedCore.scene;
      const leaseToken = "fractional-native-apply";
      await prisma.floor.update({ where: { id: floorId }, data: {
        editorLeaseFence: 1, editorLeaseTokenHash: hashEditorLeaseToken(leaseToken),
        editorLeaseHolderId: userId, editorLeaseHolderName: user.name,
        editorLeaseAcquiredAt: new Date(), editorLeaseExpiresAt: new Date(Date.now() + 60_000)
      } });
      await expect(imports.apply(user, floorId, job.id, {
        expectedRevision: 0, leaseToken, leaseFence: 1, candidateIds: [], confirmMapReset: true
      })).resolves.toMatchObject({ status: "completed", revision: 1 });
      const persisted = await prisma.$queryRawUnsafe<Array<{
        minX: string; minY: string; maxX: string; maxY: string; equal: boolean;
      }>>(`SELECT scene."sourceMinX"::text AS "minX", scene."sourceMinY"::text AS "minY",
        scene."sourceMaxX"::text AS "maxX", scene."sourceMaxY"::text AS "maxY",
        (scene."sourceMinX" = region."minX" AND scene."sourceMinY" = region."minY"
          AND scene."sourceMaxX" = region."maxX" AND scene."sourceMaxY" = region."maxY") AS equal
        FROM "FloorCadScene" scene JOIN "FloorImportRegion" region ON region.id = scene."sourceRegionId"
        WHERE scene.id = $1`, scene.sceneId);
      expect(persisted[0].equal).toBe(true);
      expect(Object.fromEntries(["minX", "minY", "maxX", "maxY"].map(key =>
        [key, Number(persisted[0][key as "minX"])]))).toEqual(scene.sourceBounds);
      const editor = new FloorEditorService(prisma as never, access as never, new AuditService(prisma as never));
      const maps = new FloorMapService(prisma as never, access as never);
      const editorState = await editor.getEditorState(floorId, user);
      const snapshot = await maps.getSnapshot(user, siteId, floorId);
      const sceneState = await maps.getCadSceneState(user, siteId, floorId);
      expect(editorState.floor.cadScene).toEqual(snapshot.cadScene);
      expect(sceneState.scene).toEqual(snapshot.cadScene);
      expect(snapshot.cadScene).toMatchObject({ id: scene.sceneId, sourceImportJobId: job.id,
        width: scene.width, height: scene.height,
        manifestContentPath: `/floors/${floorId}/import-jobs/${job.id}/scene/manifest/content` });
      const manifestReads = jest.spyOn(realStorage, "readCadSceneManifest");
      await imports.getSceneManifestContent(user, floorId, job.id);
      const readManifest = await manifestReads.mock.results[0].value;
      expect(readManifest.sourceBounds).toEqual(scene.sourceBounds);
      expect(readManifest.transform).toEqual(scene.transform);
      const headsBeforeLegacyReads = send.mock.calls.length;
      await prisma.floorImportRegion.updateMany({ where: { jobId: job.id }, data: {
        textCount: null, lightCandidateCount: null, previewWidth: null, previewHeight: null
      } });
      await expect(imports.listRegions(user, floorId, job.id)).rejects.toBeInstanceOf(ConflictException);
      await expect(assets.getContentRedirect(user, floorId, preview.assetId)).rejects.toBeInstanceOf(ConflictException);
      expect(send).toHaveBeenCalledTimes(headsBeforeLegacyReads);
    } finally {
      await worker.onModuleDestroy();
      await cleanup.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps legacy null metadata explicit and rolls back selection; SQL rejects partial or invalid metadata", async () => {
    const source = await sourceAsset();
    const previews = [await regionPreviewAsset("c"), await regionPreviewAsset("d")];
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, sourceFormat: "dxf", status: "region_selection_required",
      stage: "region_selection_required", progressPercent: 70, attemptCount: 1,
      startedAt: new Date(), reviewRequiredAt: new Date(), excludedRegionPrimitiveCount: 0, ...terminalProfile
    } });
    await prisma.floorImportRegion.createMany({ data: previews.map((preview, index) => ({
      jobId: job.id, regionId: `region-${index}`, minX: 0, minY: 0, maxX: 100, maxY: 100,
      primitiveCount: 2, candidateIdentityDigest: EMPTY_CANDIDATE_IDENTITY_DIGEST, previewAssetId: preview.id
    })) });
    await expect(service().selectRegion(user, floorId, job.id, { regionId: "region-1" })).rejects.toThrow(/re-import required/);
    expect(await prisma.floorImportRegion.count({ where: { jobId: job.id, selectedAt: { not: null } } })).toBe(0);
    expect(await prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "region_selection_required" });
    for (const data of [
      { textCount: 0 },
      { textCount: 3, lightCandidateCount: 0, previewWidth: 100, previewHeight: 100 },
      { textCount: 0, lightCandidateCount: -1, previewWidth: 100, previewHeight: 100 },
      { textCount: 0, lightCandidateCount: 0, previewWidth: 2401, previewHeight: 100 },
      { textCount: 0, lightCandidateCount: 0, previewWidth: 100, previewHeight: 1601 }
    ]) {
      await expect(prisma.floorImportRegion.updateMany({ where: { jobId: job.id }, data })).rejects.toThrow();
    }
    expect(await prisma.floorImportRegion.findFirstOrThrow({ where: { jobId: job.id } })).toMatchObject({
      textCount: null, lightCandidateCount: null, previewWidth: null, previewHeight: null
    });
  });

  it("keeps a multi-region import unapplied until one authorized selection requeues it", async () => {
    const source = await sourceAsset();
    const firstPreview = await regionPreviewAsset("c");
    const secondPreview = await regionPreviewAsset("d");
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, sourceFormat: "dxf",
      status: "region_selection_required", stage: "region_selection_required",
      progressPercent: 70, attemptCount: 1, startedAt: new Date(), reviewRequiredAt: new Date(),
      excludedRegionPrimitiveCount: 4,
      ...terminalProfile
    } });
    await prisma.floorImportRegion.createMany({ data: [
      {
        jobId: job.id, regionId: "region-111111111111111111111111",
        minX: 0, minY: 0, maxX: 100, maxY: 80, primitiveCount: 12,
        textCount: 2, lightCandidateCount: 1, previewWidth: 1_200, previewHeight: 960,
        candidateIdentityDigest: "1".repeat(64),
        previewAssetId: firstPreview.id
      },
      {
        jobId: job.id, regionId: "region-222222222222222222222222",
        minX: 500, minY: 500, maxX: 620, maxY: 590, primitiveCount: 8,
        textCount: 1, lightCandidateCount: 0, previewWidth: 1_200, previewHeight: 900,
        candidateIdentityDigest: EMPTY_CANDIDATE_IDENTITY_DIGEST,
        previewAssetId: secondPreview.id
      }
    ] });
    storage.readCadRegionPreviewMetadata = jest.fn(async (objectKey: string) => objectKey.includes(firstPreview.id)
      ? { width: 1_200, height: 960, textCount: 2, lightCandidateCount: 1, area: 8_000 }
      : { width: 1_200, height: 900, textCount: 1, lightCandidateCount: 0, area: 10_800 });

    const imports = service();
    await expect(imports.apply(user, floorId, job.id, {
      expectedRevision: 0, leaseToken: "unused", leaseFence: 0,
      candidateIds: [], confirmMapReset: true
    })).rejects.toBeInstanceOf(ConflictException);
    await expect(imports.listRegions(user, floorId, job.id)).resolves.toMatchObject({
      jobId: job.id,
      selectionStatus: "selection_required",
      selectedRegionId: null,
      excludedRegionPrimitiveCount: 4,
      regions: [
        { regionId: "region-111111111111111111111111", textCount: 2, lightCandidateCount: 1 },
        { regionId: "region-222222222222222222222222", textCount: 1, lightCandidateCount: 0 }
      ]
    });

    await expect(imports.selectRegion(user, floorId, job.id, {
      regionId: "region-222222222222222222222222"
    })).resolves.toMatchObject({
      jobId: job.id,
      selectionStatus: "selected",
      selectedRegionId: "region-222222222222222222222222"
    });
    await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toMatchObject({
      status: "queued", stage: "queued", progressPercent: 0, attemptCount: 0,
      startedAt: null, reviewRequiredAt: null, renderedAssetId: null
    });
    await expect(prisma.floorImportRegion.findMany({
      where: { jobId: job.id, selectedAt: { not: null } }
    })).resolves.toHaveLength(1);
    await expect(imports.selectRegion(user, floorId, job.id, {
      regionId: "region-111111111111111111111111"
    })).rejects.toBeInstanceOf(ConflictException);
    expect(storage.readCadRegionPreviewMetadata).not.toHaveBeenCalled();
  });

  it("grants a fresh scene-build retry budget when a third-attempt multi-region job is selected", async () => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-region-retry-"));
    const source = await sourceAsset();
    const selectedPreview = await regionPreviewAsset("a");
    const otherPreview = await regionPreviewAsset("b");
    const selectedRegion = {
      regionId: "region-aaaaaaaaaaaaaaaaaaaaaaaa",
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      primitiveCount: 1, textCount: 0, lightCandidateCount: 0, area: 10_000
    };
    const otherRegion = {
      regionId: "region-bbbbbbbbbbbbbbbbbbbbbbbb",
      bounds: { minX: 200, minY: 200, maxX: 300, maxY: 300 },
      primitiveCount: 1, textCount: 0, lightCandidateCount: 0, area: 10_000
    };
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, sourceFormat: "dxf",
      status: "region_selection_required", stage: "region_selection_required", progressPercent: 70,
      attemptCount: 3, startedAt: new Date(), reviewRequiredAt: new Date(),
      excludedRegionPrimitiveCount: 0, ...terminalProfile
    } });
    await prisma.floorImportRegion.createMany({ data: [
      {
        jobId: job.id, regionId: selectedRegion.regionId, ...selectedRegion.bounds,
        primitiveCount: selectedRegion.primitiveCount,
        textCount: 0, lightCandidateCount: 0, previewWidth: 1_200, previewHeight: 1_200,
        candidateIdentityDigest: EMPTY_CANDIDATE_IDENTITY_DIGEST,
        previewAssetId: selectedPreview.id
      },
      {
        jobId: job.id, regionId: otherRegion.regionId, ...otherRegion.bounds,
        primitiveCount: otherRegion.primitiveCount,
        textCount: 0, lightCandidateCount: 0, previewWidth: 1_200, previewHeight: 1_200,
        candidateIdentityDigest: EMPTY_CANDIDATE_IDENTITY_DIGEST,
        previewAssetId: otherPreview.id
      }
    ] });
    storage.readCadRegionPreviewMetadata = jest.fn().mockResolvedValue({
      width: 1_200, height: 1_200, textCount: 0, lightCandidateCount: 0, area: 10_000
    });
    await service().selectRegion(user, floorId, job.id, { regionId: selectedRegion.regionId });
    await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } }))
      .resolves.toMatchObject({ status: "queued", attemptCount: 0 });

    const dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n1\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n";
    const objects = new Set<string>();
    const workerStorage = {
      downloadFloorAssetToFile: jest.fn(async (_key: string, path: string) => writeFile(path, dxf)),
      putFloorRenderedObjectFile: jest.fn(async (key: string) => { objects.add(key); }),
      verifyFloorRenderedObject: jest.fn(async (key: string) => {
        if (!objects.has(key)) throw new Error("missing rendered object");
      }),
      putCadSceneObjectFile: jest.fn(async (key: string) => { objects.add(key); }),
      verifyCadSceneObject: jest.fn(async (key: string) => {
        if (!objects.has(key)) throw new Error("missing CAD object");
      }),
      deleteObject: jest.fn(async (key: string) => { objects.delete(key); })
    };
    const converter = { convert: jest.fn(async ({ inputPath, outputPath }: { inputPath: string; outputPath: string }) => {
      await writeFile(outputPath, await readFile(inputPath));
      return { outputPath, outputBytes: Buffer.byteLength(dxf) };
    }) };
    const registry = new FixedLightingDetectorRegistry();
    const profile = registry.get("generic-lighting-v1");
    const core = { execute: jest.fn(async ({ renderedPath, artifactDirectory }: {
      renderedPath: string; artifactDirectory: string;
    }) => {
      await writeFile(renderedPath, "gzip-svg");
      const artifacts = await writeNativeCoreArtifacts(job.id, artifactDirectory, selectedRegion);
      return {
        profileId: "generic-lighting-v1" as const,
        profileVersion: profile.profileVersion!, profileDigest: profile.profileDigest!,
        modelEntityCount: 2, blockCount: 0, candidates: [], selectedCandidates: [],
        candidateRegionAssignments: [],
        excludedRegionPrimitiveCount: 0, regions: [selectedRegion, otherRegion],
        regionPreviews: [], scene: artifacts.scene,
        candidateTransformMatch: {
          candidateCount: 0, matchedCount: 0, matchRate: null, tolerancePx: 0.01, maxDeltaPx: 0
        },
        rendered: {
          sizeBytes: 8, rawSizeBytes: 64, sha256: "6".repeat(64),
          viewport: { width: 1_200, height: 1_200 }, renderedOccurrences: 2, contentEncoding: "gzip" as const
        }
      };
    }) };
    const cleanup = new FloorImportAttemptCleanupService(prisma as never, workerStorage as never, {
      tempRoot: root, pollIntervalMs: 1_000, enabled: false
    });
    const importWorker = new FloorImportWorkerService(
      prisma as never, workerStorage as never, converter as never, registry, core as never,
      { tempRoot: root, pollIntervalMs: 1_000, enabled: false }, cleanup
    );
    try {
      await expect(importWorker.runOnce()).resolves.toBe(true);
      expect(core.execute).toHaveBeenCalledWith(expect.objectContaining({
        selectedRegionId: selectedRegion.regionId,
        expectedCandidateRegionDigests: {
          [selectedRegion.regionId]: EMPTY_CANDIDATE_IDENTITY_DIGEST,
          [otherRegion.regionId]: EMPTY_CANDIDATE_IDENTITY_DIGEST
        }
      }));
      await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({ status: "review_required", progressPercent: 100, attemptCount: 1 });
    } finally {
      await importWorker.onModuleDestroy();
      await cleanup.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a coherent child reassignment against PostgreSQL canonical region digests", async () => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-canonical-reassignment-"));
    const child = join(root, "coherent-reassignment.cjs");
    const source = await sourceAsset();
    const selectedRegion = {
      regionId: "region-eeeeeeeeeeeeeeeeeeeeeeee",
      bounds: { minX: 0, minY: 0, maxX: 1_600, maxY: 900 },
      primitiveCount: 1, textCount: 0, lightCandidateCount: 1, area: 1_440_000
    };
    const otherRegion = {
      regionId: "region-ffffffffffffffffffffffff",
      bounds: { minX: 2_000, minY: 0, maxX: 3_000, maxY: 900 },
      primitiveCount: 2, textCount: 0, lightCandidateCount: 1, area: 900_000
    };
    const originalAssignments = [
      { sourceEntityId: "selected-light", regionId: selectedRegion.regionId },
      { sourceEntityId: "other-region-light", regionId: otherRegion.regionId }
    ];
    const digests = computeCandidateRegionDigests(
      [selectedRegion.regionId, otherRegion.regionId],
      originalAssignments,
      originalAssignments.map(assignment => assignment.sourceEntityId)
    );
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, sourceFormat: "dxf", detectorProfileId: "generic-lighting-v1",
      status: "queued", stage: "queued", progressPercent: 0, attemptCount: 2
    } });
    await prisma.floorImportRegion.createMany({ data: [
      {
        jobId: job.id, regionId: selectedRegion.regionId, ...selectedRegion.bounds,
        primitiveCount: selectedRegion.primitiveCount, candidateIdentityDigest: digests[selectedRegion.regionId],
        selectedAt: new Date()
      },
      {
        jobId: job.id, regionId: otherRegion.regionId, ...otherRegion.bounds,
        primitiveCount: otherRegion.primitiveCount, candidateIdentityDigest: digests[otherRegion.regionId]
      }
    ] });
    const profile = new FixedLightingDetectorRegistry().get("generic-lighting-v1");
    const reassignedResult = {
      profileId: "generic-lighting-v1",
      profileVersion: profile.profileVersion,
      profileDigest: profile.profileDigest,
      modelEntityCount: 3,
      blockCount: 0,
      candidates: [
        {
          sourceEntityId: "selected-light", layerName: "LIGHT", blockName: "LED",
          x: 100, y: 100, rotation: 0, confidence: 0.95, method: "rule",
          sourcePosition: { x: 400, y: 500 }
        },
        {
          sourceEntityId: "other-region-light", layerName: "LIGHT", blockName: "LED",
          x: 200, y: 200, rotation: 30, confidence: 0.9, method: "rule",
          sourcePosition: { x: 2_500, y: 450 }
        }
      ],
      selectedCandidates: [],
      candidateRegionAssignments: [
        { sourceEntityId: "selected-light", regionId: otherRegion.regionId },
        { sourceEntityId: "other-region-light", regionId: otherRegion.regionId }
      ],
      excludedRegionPrimitiveCount: 0,
      regions: [
        { ...selectedRegion, lightCandidateCount: 0 },
        { ...otherRegion, lightCandidateCount: 2 }
      ],
      candidateTransformMatch: {
        candidateCount: 2, matchedCount: 2, matchRate: 1, tolerancePx: 0.01, maxDeltaPx: 0
      },
      rendered: {
        sizeBytes: 8, rawSizeBytes: 64, sha256: "6".repeat(64),
        viewport: { width: 1_200, height: 1_200 }, renderedOccurrences: 3,
        excludedEntityCount: 0, unsupportedEntityCounts: {}, contentEncoding: "gzip"
      },
      regionPreviews: [],
      scene: {
        sceneId: "11111111-1111-4111-8111-111111111111",
        manifestAssetId: "22222222-2222-4222-8222-222222222222",
        manifestFilename: "22222222-2222-4222-8222-222222222222.json",
        manifestByteSize: 512, manifestSha256: "d".repeat(64), width: 512, height: 512,
        sourceBounds: selectedRegion.bounds,
        transform: { scaleX: 0.25, scaleY: -0.25, translateX: 0, translateY: 481 }
      }
    };
    await writeFile(child, `process.on("message", () => {
      process.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, result: reassignedResult }))}, () => process.exit(0));
    });`);
    const dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n1\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n";
    const workerStorage = {
      downloadFloorAssetToFile: jest.fn(async (_key: string, path: string) => writeFile(path, dxf)),
      putFloorRenderedObjectFile: jest.fn(),
      putCadSceneObjectFile: jest.fn()
    };
    const converter = { convert: jest.fn(async ({ inputPath, outputPath }: { inputPath: string; outputPath: string }) => {
      await writeFile(outputPath, await readFile(inputPath));
      return { outputPath, outputBytes: Buffer.byteLength(dxf) };
    }) };
    const importWorker = new FloorImportWorkerService(
      prisma as never,
      workerStorage as never,
      converter as never,
      new FixedLightingDetectorRegistry(),
      new ChildProcessCadCoreExecutor({ entryPath: child, maxOldSpaceMb: 32, timeoutMs: 5_000 }),
      { tempRoot: root, pollIntervalMs: 1_000, enabled: false }
    );
    try {
      await expect(importWorker.runOnce()).resolves.toBe(true);
      await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toMatchObject({
        status: "failed", attemptCount: 3, failureCode: "CAD_IMPORT_PARSE_FAILED"
      });
      expect(workerStorage.putFloorRenderedObjectFile).not.toHaveBeenCalled();
      expect(workerStorage.putCadSceneObjectFile).not.toHaveBeenCalled();
      await expect(prisma.floorImportCandidate.count({ where: { jobId: job.id } })).resolves.toBe(0);
    } finally {
      await importWorker.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed when a legacy selection-required region has no canonical candidate digest", async () => {
    const source = await sourceAsset();
    const previews = [await regionPreviewAsset("e"), await regionPreviewAsset("f")];
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, sourceFormat: "dxf",
      status: "region_selection_required", stage: "region_selection_required",
      progressPercent: 70, attemptCount: 1, startedAt: new Date(), reviewRequiredAt: new Date(),
      excludedRegionPrimitiveCount: 0,
      ...terminalProfile
    } });
    const regionIds = ["region-cccccccccccccccccccccccc", "region-dddddddddddddddddddddddd"];
    await prisma.floorImportRegion.createMany({ data: regionIds.map((regionId, index) => ({
      jobId: job.id,
      regionId,
      minX: index * 200,
      minY: index * 200,
      maxX: index * 200 + 100,
      maxY: index * 200 + 100,
      primitiveCount: 1,
      previewAssetId: previews[index].id
    })) });
    storage.readCadRegionPreviewMetadata = jest.fn().mockResolvedValue({
      width: 1_200, height: 1_200, textCount: 0, lightCandidateCount: 0, area: 10_000
    });

    await expect(service().selectRegion(user, floorId, job.id, { regionId: regionIds[0] }))
      .rejects.toThrow(/re-import required/i);
    await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } }))
      .resolves.toMatchObject({ status: "region_selection_required", attemptCount: 1 });
    await expect(prisma.floorImportRegion.count({
      where: { jobId: job.id, selectedAt: { not: null } }
    })).resolves.toBe(0);
  });

  it("validates private scene content and atomically activates the selected native scene", async () => {
    const source = await sourceAsset();
    const rendered = await renderedAsset();
    const preview = await regionPreviewAsset("e");
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, renderedAssetId: rendered.id, sourceFormat: "dxf",
      status: "review_required", stage: "review_required", progressPercent: 100,
      attemptCount: 1, startedAt: new Date(), reviewRequiredAt: new Date(),
      excludedRegionPrimitiveCount: 0, ...terminalProfile
    } });
    const region = {
      regionId: "region-333333333333333333333333",
      bounds: { minX: 0, minY: 0, maxX: 1_000, maxY: 1_000 },
      primitiveCount: 1, textCount: 0, lightCandidateCount: 0, area: 1_000_000
    };
    const persistedRegion = await prisma.floorImportRegion.create({ data: {
      jobId: job.id, regionId: region.regionId, minX: region.bounds.minX, minY: region.bounds.minY,
      maxX: region.bounds.maxX, maxY: region.bounds.maxY, primitiveCount: region.primitiveCount,
      previewAssetId: preview.id, selectedAt: new Date()
    } });
    const identity = cadScenePersistenceIdentity(job.id, region.regionId);
    const built = buildCadScene({
      version: 1,
      bounds: region.bounds,
      blocks: [],
      entities: [{
        type: "line", sourceEntityId: "native-line", layer: "WALL",
        start: { x: 10, y: 10, z: 0 }, end: { x: 990, y: 990, z: 0 }
      }]
    }, region, {
      sceneId: identity.sceneId,
      manifestAssetId: identity.manifestAssetId,
      tileAssetId: identity.tileAssetId
    });
    await prisma.floorAsset.createMany({ data: [
      {
        id: built.manifest.manifestAssetId, floorId, kind: "cad_manifest", status: "ready",
        objectKey: identity.manifestObjectKey(floorId), mimeType: "application/json",
        sizeBytes: BigInt(built.manifest.byteSize), sha256: built.manifest.sha256, readyAt: new Date()
      },
      ...built.tiles.map(tile => ({
        id: tile.descriptor.assetId, floorId, kind: "cad_tile" as const, status: "ready" as const,
        objectKey: identity.tileObjectKey(floorId, tile.descriptor),
        mimeType: "application/vnd.led-control.cad-tile",
        sizeBytes: BigInt(tile.descriptor.byteSize), sha256: tile.descriptor.sha256, readyAt: new Date()
      }))
    ] });
    storage.readCadSceneManifest = jest.fn().mockResolvedValue(built.manifest);
    storage.verifyCadSceneObject = jest.fn().mockResolvedValue(undefined);
    storage.createFloorAssetDownloadUrl = jest.fn(async (objectKey: string) => `https://private.invalid/${objectKey}`);

    const imports = service();
    await expect(imports.getSceneManifestContent(user, floorId, job.id)).resolves.toEqual({
      url: `https://private.invalid/${identity.manifestObjectKey(floorId)}`
    });
    const tile = built.manifest.tiles[0];
    await expect(imports.getSceneTileContent(user, floorId, job.id, {
      tileX: tile.tileX, tileY: tile.tileY, lod: tile.lod, part: tile.part
    })).resolves.toEqual({
      url: `https://private.invalid/${identity.tileObjectKey(floorId, tile)}`
    });
    expect(storage.verifyCadSceneObject).toHaveBeenLastCalledWith(
      identity.tileObjectKey(floorId, tile),
      expect.objectContaining({
        sizeBytes: tile.byteSize, sha256: tile.sha256, bounds: tile.bounds,
        contentType: "application/vnd.led-control.cad-tile"
      })
    );
    await expect(imports.getSceneTileContent(user, floorId, job.id, {
      tileX: 64, tileY: 0, lod: 0, part: 0
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(imports.getSceneTileContent(user, floorId, job.id, {
      tileX: 0, tileY: 63, lod: 0, part: 0
    })).rejects.toBeInstanceOf(NotFoundException);

    await prisma.floor.update({ where: { id: floorId }, data: {
      editorLeaseFence: 4, editorLeaseTokenHash: hashEditorLeaseToken("native-lease"),
      editorLeaseHolderId: userId, editorLeaseHolderName: user.name,
      editorLeaseAcquiredAt: new Date(), editorLeaseExpiresAt: new Date(Date.now() + 60_000)
    } });
    await expect(imports.apply(user, floorId, job.id, {
      expectedRevision: 0, leaseToken: "native-lease", leaseFence: 4,
      candidateIds: [], confirmMapReset: true
    })).resolves.toMatchObject({ status: "completed", revision: 1 });
    await expect(prisma.floorCadScene.findUniqueOrThrow({ where: { floorId }, include: { tiles: true } }))
      .resolves.toMatchObject({
        id: identity.sceneId,
        sourceImportJobId: job.id,
        sourceRegionId: persistedRegion.id,
        manifestAssetId: identity.manifestAssetId,
        width: built.manifest.width,
        height: built.manifest.height,
        tileCount: built.manifest.tileCount,
        tiles: expect.arrayContaining(built.manifest.tiles.map(descriptor => expect.objectContaining({
          tileX: descriptor.tileX, tileY: descriptor.tileY, lod: descriptor.lod,
          part: descriptor.part, assetId: descriptor.assetId,
          byteSize: BigInt(descriptor.byteSize), minX: descriptor.bounds.minX,
          minY: descriptor.bounds.minY, maxX: descriptor.bounds.maxX, maxY: descriptor.bounds.maxY
        })))
      });
    await expect(prisma.floorPlan.findUniqueOrThrow({ where: { floorId } })).resolves.toMatchObject({
      sourceType: "cad", width: built.manifest.width, height: built.manifest.height,
      gridSize: built.manifest.gridSize
    });
  });

  it("reauthorizes active lookup after a concurrent PostgreSQL admin revocation", async () => {
    const source = await sourceAsset();
    await prisma.floorImportJob.create({ data: { floorId, sourceAssetId: source.id, sourceFormat: "dxf" } });
    const replacement = await prisma.user.create({ data: {
      organizationId, loginId: `active_replacement_${randomUUID()}`, name: "Replacement Admin",
      passwordHash: "unused", role: "admin"
    } });
    const revoker = new PrismaClient({ datasourceUrl: databaseUrl });
    const imports = new FloorImportService(
      prisma as never,
      new SiteAccessService(prisma as never),
      new AuditService(prisma as never),
      storage as never
    );
    let release!: () => void; let locked!: () => void;
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    const siteLocked = new Promise<void>(resolve => { locked = resolve; });
    const revoking = revoker.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`;
      await tx.site.update({ where: { id: siteId }, data: { adminUserId: replacement.id } });
      locked();
      await releaseGate;
    }, { timeout: 10_000 });
    await siteLocked;

    const reading = imports.getActive(user, floorId);
    try {
      await waitForSiteLockWait(prisma, 3000);
    } finally {
      release();
    }
    await revoking;

    await expect(reading).rejects.toBeInstanceOf(NotFoundException);
    await revoker.$disconnect();
  }, 15_000);

  it("keeps applying transaction-local and recovers only DB-clock rows older than two minutes", async () => {
    const source = await sourceAsset();
    const rendered = await renderedAsset();
    const review = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, renderedAssetId: rendered.id, sourceFormat: "dxf",
      status: "review_required", stage: "review_required", progressPercent: 100,
      attemptCount: 1, startedAt: new Date(), reviewRequiredAt: new Date(), ...terminalProfile
    } });
    const transactionClient = new PrismaClient({ datasourceUrl: databaseUrl });
    let release!: () => void; let applying!: () => void;
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    const applyingWritten = new Promise<void>(resolve => { applying = resolve; });
    const applyingTransaction = transactionClient.$transaction(async tx => {
      await tx.floorImportJob.update({
        where: { id: review.id }, data: { status: "applying", stage: "applying" }
      });
      applying();
      await releaseGate;
      const now = new Date();
      await tx.floorImportJob.update({
        where: { id: review.id }, data: {
          status: "completed", stage: "completed", appliedAt: now, completedAt: now
        }
      });
    }, { timeout: 10_000 });
    await applyingWritten;

    await expect(service().getActive(user, floorId)).resolves.toMatchObject({
      job: { jobId: review.id, status: "review_required" }
    });
    release();
    await applyingTransaction;
    await expect(service().getActive(user, floorId)).resolves.toEqual({ job: null });

    const staleSource = await sourceAsset();
    const staleRendered = await renderedAsset();
    const stale = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: staleSource.id, renderedAssetId: staleRendered.id, sourceFormat: "dxf",
      status: "applying", stage: "applying", progressPercent: 100, attemptCount: 1,
      startedAt: new Date(Date.now() - 180_000), reviewRequiredAt: new Date(Date.now() - 180_000), ...terminalProfile
    } });
    await prisma.$executeRaw`UPDATE "FloorImportJob" SET "updatedAt" = clock_timestamp() - INTERVAL '121 seconds' WHERE "id" = ${stale.id}`;
    await expect(service().getActive(user, floorId)).resolves.toEqual({ job: null });
    await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: stale.id } })).resolves.toMatchObject({
      status: "failed", stage: "failed", failureCode: "CAD_IMPORT_STALE_APPLYING", failedAt: expect.any(Date)
    });

    const freshSource = await sourceAsset();
    const freshRendered = await renderedAsset();
    const fresh = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: freshSource.id, renderedAssetId: freshRendered.id, sourceFormat: "dxf",
      status: "applying", stage: "applying", progressPercent: 100, attemptCount: 1,
      startedAt: new Date(), reviewRequiredAt: new Date(), ...terminalProfile
    } });
    await prisma.$executeRaw`UPDATE "FloorImportJob" SET "updatedAt" = clock_timestamp() WHERE "id" = ${fresh.id}`;
    await expect(service().getActive(user, floorId)).resolves.toEqual({ job: null });
    await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: fresh.id } })).resolves.toMatchObject({
      status: "applying", failureCode: null, failedAt: null
    });
    await transactionClient.$disconnect();
  }, 15_000);

  it("recovers expired leases and retires an expired third attempt without a fourth claim", async () => {
    const source = await sourceAsset();
    const job = await prisma.floorImportJob.create({ data: { floorId, sourceAssetId: source.id, sourceFormat: "dxf" } });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const currentWorker = worker();
      await expect(currentWorker.claimNext()).resolves.toMatchObject({ id: job.id, attemptCount: attempt, status: "processing" });
      await prisma.floorImportJob.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(0) } });
      await currentWorker.onModuleDestroy();
    }
    const finalWorker = worker();
    await expect(finalWorker.claimNext()).resolves.toBeNull();
    await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toMatchObject({
      status: "failed", attemptCount: 3, leaseOwner: null, leaseExpiresAt: null,
      failureCode: "CAD_IMPORT_ATTEMPTS_EXHAUSTED", failedAt: expect.any(Date)
    });
    await finalWorker.onModuleDestroy();
  });

  it("keeps an attempt object when pending asset cleanup races the worker ready promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-cleanup-race-"));
    const source = await sourceAsset();
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, sourceFormat: "dxf"
    } });
    const dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n1\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n";
    const objects = new Set<string>();
    let uploadedKey = "";
    let signalPut!: () => void; let releasePut!: () => void;
    let signalDelete!: () => void; let releaseDelete!: () => void;
    const putStarted = new Promise<void>(resolve => { signalPut = resolve; });
    const putGate = new Promise<void>(resolve => { releasePut = resolve; });
    const deleteStarted = new Promise<void>(resolve => { signalDelete = resolve; });
    const deleteGate = new Promise<void>(resolve => { releaseDelete = resolve; });
    const raceStorage = {
      downloadFloorAssetToFile: jest.fn(async (_key: string, path: string) => writeFile(path, dxf)),
      putFloorRenderedObjectFile: jest.fn(async (key: string) => {
        uploadedKey = key; objects.add(key); signalPut(); await putGate;
      }),
      verifyFloorRenderedObject: jest.fn(async (key: string) => {
        if (!objects.has(key)) throw new Error("attempt object disappeared before verification");
      }),
      putCadSceneObjectFile: jest.fn(async (key: string) => { objects.add(key); }),
      verifyCadSceneObject: jest.fn(async (key: string) => {
        if (!objects.has(key)) throw new Error("CAD scene object disappeared before verification");
      }),
      deleteObject: jest.fn(async (key: string) => {
        signalDelete(); await deleteGate; objects.delete(key);
      })
    };
    const converter = { convert: jest.fn(async ({ inputPath, outputPath }: { inputPath: string; outputPath: string }) => {
      await writeFile(outputPath, await readFile(inputPath));
      return { outputPath, outputBytes: Buffer.byteLength(dxf) };
    }) };
    const detector = { profileId: "generic-lighting-v1", profileVersion: "test/1", profileDigest: "b".repeat(64) };
    const registry = {
      resolve: jest.fn().mockReturnValue("generic-lighting-v1"), assertBinding: jest.fn(), get: jest.fn().mockReturnValue(detector)
    };
    const raceRegion = {
      regionId: "region-555555555555555555555555",
      bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      primitiveCount: 1, textCount: 0, lightCandidateCount: 0, area: 100
    };
    const core = { execute: jest.fn(async ({ renderedPath, artifactDirectory }: {
      renderedPath: string; artifactDirectory: string;
    }) => {
      await writeFile(renderedPath, "gzip-svg");
      const artifacts = await writeNativeCoreArtifacts(job.id, artifactDirectory, raceRegion);
      return {
        profileId: "generic-lighting-v1", profileVersion: "test/1", profileDigest: "b".repeat(64),
        modelEntityCount: 1, blockCount: 0, candidates: [],
        selectedCandidates: [], candidateRegionAssignments: [],
        excludedRegionPrimitiveCount: 0, regions: [raceRegion], ...artifacts,
        candidateTransformMatch: { candidateCount: 0, matchedCount: 0, matchRate: null, tolerancePx: 0.01, maxDeltaPx: 0 },
        rendered: { sizeBytes: 8, rawSizeBytes: 64, sha256: "b".repeat(64), viewport: { width: 12, height: 12 },
          renderedOccurrences: 1, contentEncoding: "gzip" }
      };
    }) };
    const attemptCleanup = new FloorImportAttemptCleanupService(prisma as never, raceStorage as never, {
      tempRoot: root, pollIntervalMs: 1000, enabled: false
    });
    const importWorker = new FloorImportWorkerService(
      prisma as never, raceStorage as never, converter as never, registry as never, core as never,
      { tempRoot: root, pollIntervalMs: 1000, enabled: false }, attemptCleanup
    );
    const genericCleanup = new FloorAssetCleanupService(prisma as never, raceStorage as never);
    const workerRun = importWorker.runOnce();
    let cleanupRun: Promise<{ processed: number; deleted: number }> | undefined;
    try {
      await putStarted;
      cleanupRun = genericCleanup.processPending(new Date(Date.now() + 10 * 60_000));
      await Promise.race([
        cleanupRun.then(() => undefined),
        deleteStarted
      ]);
      releasePut();
      await workerRun;
      await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({ status: "review_required" });
      releaseDelete();
      await cleanupRun;

      expect(objects.has(uploadedKey)).toBe(true);
      await expect(prisma.floorAsset.findUniqueOrThrow({ where: { objectKey: uploadedKey } }))
        .resolves.toMatchObject({ status: "ready", cleanupStartedAt: null });
    } finally {
      releasePut(); releaseDelete();
      await Promise.allSettled([workerRun, cleanupRun ?? Promise.resolve()]);
      await importWorker.onModuleDestroy();
      await attemptCleanup.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("auto-selects one region and persists verified private preview, manifest, and tile assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-native-worker-"));
    const source = await sourceAsset();
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, sourceFormat: "dxf", detectorProfileId: "generic-lighting-v1"
    } });
    const dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n1\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n";
    const region = {
      regionId: "region-444444444444444444444444",
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      primitiveCount: 1, textCount: 0, lightCandidateCount: 0, area: 10_000
    };
    const identity = cadScenePersistenceIdentity(job.id, region.regionId);
    const previewIdentity = cadRegionPreviewPersistenceIdentity(job.id, region.regionId);
    const built = buildCadScene({
      version: 1, bounds: region.bounds, blocks: [],
      entities: [{
        type: "line", sourceEntityId: "worker-line", layer: "WALL",
        start: { x: 10, y: 10, z: 0 }, end: { x: 90, y: 90, z: 0 }
      }]
    }, region, {
      sceneId: identity.sceneId,
      manifestAssetId: identity.manifestAssetId,
      tileAssetId: identity.tileAssetId
    });
    const objects = new Set<string>();
    const workerStorage = {
      downloadFloorAssetToFile: jest.fn(async (_key: string, path: string) => writeFile(path, dxf)),
      putFloorRenderedObjectFile: jest.fn(async (key: string) => { objects.add(key); }),
      verifyFloorRenderedObject: jest.fn(async (key: string) => {
        if (!objects.has(key)) throw new Error("missing rendered object");
      }),
      putCadSceneObjectFile: jest.fn(async (key: string) => { objects.add(key); }),
      verifyCadSceneObject: jest.fn(async (key: string) => {
        if (!objects.has(key)) throw new Error("missing CAD scene object");
      }),
      readCadSceneManifest: jest.fn().mockResolvedValue(built.manifest),
      readFloorRenderedMetadata: jest.fn().mockResolvedValue({ width: 1_200, height: 1_200 }),
      createFloorAssetDownloadUrl: jest.fn(async (key: string) => `https://private.invalid/${key}`),
      deleteObject: jest.fn(async (key: string) => { objects.delete(key); })
    };
    const converter = { convert: jest.fn(async ({ inputPath, outputPath }: { inputPath: string; outputPath: string }) => {
      await writeFile(outputPath, await readFile(inputPath));
      return { outputPath, outputBytes: Buffer.byteLength(dxf) };
    }) };
    const registry = new FixedLightingDetectorRegistry();
    const profile = registry.get("generic-lighting-v1");
    const core = { execute: jest.fn(async ({ renderedPath, artifactDirectory }: {
      renderedPath: string; artifactDirectory: string;
    }) => {
      await writeFile(renderedPath, "gzip-svg");
      const previewFilename = `${previewIdentity.assetId}.svg`;
      await writeFile(join(artifactDirectory, previewFilename), "preview");
      const manifestFilename = `${identity.manifestAssetId}.json`;
      await writeFile(join(artifactDirectory, manifestFilename), built.manifestPayload);
      for (const tile of built.tiles) {
        await writeFile(join(artifactDirectory, `${tile.descriptor.assetId}.bin`), tile.payload);
      }
      return {
        profileId: "generic-lighting-v1" as const,
        profileVersion: profile.profileVersion!, profileDigest: profile.profileDigest!,
        modelEntityCount: 1, blockCount: 0, candidates: [], selectedCandidates: [],
        candidateRegionAssignments: [],
        excludedRegionPrimitiveCount: 0, regions: [region],
        regionPreviews: [{
          regionId: region.regionId, assetId: previewIdentity.assetId, filename: previewFilename,
          sizeBytes: 7, sha256: createHash("sha256").update("preview").digest("hex"),
          viewport: { width: 1_200, height: 1_200 }
        }],
        scene: {
          sceneId: identity.sceneId,
          manifestAssetId: identity.manifestAssetId,
          manifestFilename,
          manifestByteSize: built.manifest.byteSize,
          manifestSha256: built.manifest.sha256,
          width: built.manifest.width,
          height: built.manifest.height,
          sourceBounds: { ...built.manifest.sourceBounds },
          transform: { ...built.manifest.transform }
        },
        candidateTransformMatch: {
          candidateCount: 0, matchedCount: 0, matchRate: null, tolerancePx: 0.01, maxDeltaPx: 0
        },
        rendered: {
          sizeBytes: 8, rawSizeBytes: 64, sha256: "f".repeat(64),
          viewport: { width: 1_200, height: 1_200 }, renderedOccurrences: 1, contentEncoding: "gzip" as const
        }
      };
    }) };
    const cleanup = new FloorImportAttemptCleanupService(prisma as never, workerStorage as never, {
      tempRoot: root, pollIntervalMs: 1000, enabled: false
    });
    const importWorker = new FloorImportWorkerService(
      prisma as never, workerStorage as never, converter as never, registry, core as never,
      { tempRoot: root, pollIntervalMs: 1000, enabled: false }, cleanup
    );
    try {
      await expect(importWorker.runOnce()).resolves.toBe(true);
      await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({ status: "review_required", renderedAssetId: expect.any(String) });
      await expect(prisma.floorImportRegion.findMany({ where: { jobId: job.id } })).resolves.toEqual([
        expect.objectContaining({
          regionId: region.regionId,
          candidateIdentityDigest: createHash("sha256").update(JSON.stringify([]), "utf8").digest("hex"),
          previewAssetId: previewIdentity.assetId,
          selectedAt: expect.any(Date)
        })
      ]);
      await expect(prisma.floorAsset.findMany({
        where: { id: { in: [identity.manifestAssetId, ...built.manifest.tiles.map(tile => tile.assetId)] } }
      })).resolves.toHaveLength(1 + built.manifest.tiles.length);
      expect(workerStorage.putCadSceneObjectFile).toHaveBeenCalledTimes(2 + built.tiles.length);
      expect(workerStorage.verifyCadSceneObject).toHaveBeenCalledTimes(2 + built.tiles.length);
      expect(objects.has(identity.manifestObjectKey(floorId))).toBe(true);
      expect(objects.has(previewIdentity.objectKey(floorId))).toBe(true);

      const draftAssetIds = [
        previewIdentity.assetId,
        identity.manifestAssetId,
        ...built.manifest.tiles.map(tile => tile.assetId)
      ];
      await prisma.floorAsset.updateMany({
        where: { id: { in: draftAssetIds } },
        data: { readyAt: new Date(Date.now() - 25 * 60 * 60_000) }
      });
      const assetCleanup = new FloorAssetCleanupService(prisma as never, workerStorage as never);
      await expect(assetCleanup.processPending(new Date())).resolves.toEqual({ processed: 0, deleted: 0 });
      await expect(prisma.floorAsset.count({ where: { id: { in: draftAssetIds } } }))
        .resolves.toBe(draftAssetIds.length);

      const imports = new FloorImportService(
        prisma as never, access as never, new AuditService(prisma as never), workerStorage as never
      );
      await expect(imports.getSceneManifestContent(user, floorId, job.id)).resolves.toEqual({
        url: `https://private.invalid/${identity.manifestObjectKey(floorId)}`
      });
      const tile = built.manifest.tiles[0];
      await expect(imports.getSceneTileContent(user, floorId, job.id, {
        tileX: tile.tileX, tileY: tile.tileY, lod: tile.lod, part: tile.part
      })).resolves.toEqual({
        url: `https://private.invalid/${identity.tileObjectKey(floorId, tile)}`
      });
      await prisma.floor.update({ where: { id: floorId }, data: {
        editorLeaseFence: 3,
        editorLeaseTokenHash: hashEditorLeaseToken("delayed-draft-lease"),
        editorLeaseHolderId: userId,
        editorLeaseHolderName: user.name,
        editorLeaseAcquiredAt: new Date(),
        editorLeaseExpiresAt: new Date(Date.now() + 60_000)
      } });
      await expect(imports.apply(user, floorId, job.id, {
        expectedRevision: 0,
        leaseToken: "delayed-draft-lease",
        leaseFence: 3,
        candidateIds: [],
        confirmMapReset: true
      })).resolves.toMatchObject({ status: "completed", floorPlan: { sourceType: "cad" } });
      assetCleanup.onModuleDestroy();
    } finally {
      await importWorker.onModuleDestroy();
      await cleanup.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("cleans pending CAD tombstones when storage succeeds before DB asset promotion fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-cad-tombstone-"));
    const source = await sourceAsset();
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, sourceFormat: "dxf", detectorProfileId: "generic-lighting-v1"
    } });
    const dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n1\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n";
    const region = {
      regionId: "region-666666666666666666666666",
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      primitiveCount: 1, textCount: 0, lightCandidateCount: 0, area: 10_000
    };
    const identity = cadScenePersistenceIdentity(job.id, region.regionId);
    const previewIdentity = cadRegionPreviewPersistenceIdentity(job.id, region.regionId);
    const objects = new Set<string>();
    const workerStorage = {
      downloadFloorAssetToFile: jest.fn(async (_key: string, path: string) => writeFile(path, dxf)),
      putFloorRenderedObjectFile: jest.fn(async (key: string) => { objects.add(key); }),
      verifyFloorRenderedObject: jest.fn(async (key: string) => {
        if (!objects.has(key)) throw new Error("missing rendered object");
      }),
      putCadSceneObjectFile: jest.fn(async (key: string) => { objects.add(key); }),
      verifyCadSceneObject: jest.fn(async (key: string) => {
        if (!objects.has(key)) throw new Error("missing CAD object");
      }),
      deleteObject: jest.fn(async (key: string) => { objects.delete(key); })
    };
    const converter = { convert: jest.fn(async ({ inputPath, outputPath }: { inputPath: string; outputPath: string }) => {
      await writeFile(outputPath, await readFile(inputPath));
      return { outputPath, outputBytes: Buffer.byteLength(dxf) };
    }) };
    const registry = new FixedLightingDetectorRegistry();
    const profile = registry.get("generic-lighting-v1");
    const core = { execute: jest.fn(async ({ renderedPath, artifactDirectory }: {
      renderedPath: string; artifactDirectory: string;
    }) => {
      await writeFile(renderedPath, "gzip-svg");
      const artifacts = await writeNativeCoreArtifacts(job.id, artifactDirectory, region);
      return {
        profileId: "generic-lighting-v1" as const,
        profileVersion: profile.profileVersion!, profileDigest: profile.profileDigest!,
        modelEntityCount: 1, blockCount: 0, candidates: [], selectedCandidates: [],
        candidateRegionAssignments: [],
        excludedRegionPrimitiveCount: 0, regions: [region], ...artifacts,
        candidateTransformMatch: {
          candidateCount: 0, matchedCount: 0, matchRate: null, tolerancePx: 0.01, maxDeltaPx: 0
        },
        rendered: {
          sizeBytes: 8, rawSizeBytes: 64, sha256: "9".repeat(64),
          viewport: { width: 1_200, height: 1_200 }, renderedOccurrences: 1, contentEncoding: "gzip" as const
        }
      };
    }) };
    const attemptCleanup = new FloorImportAttemptCleanupService(prisma as never, workerStorage as never, {
      tempRoot: root, pollIntervalMs: 1000, enabled: false
    });
    const importWorker = new FloorImportWorkerService(
      prisma as never, workerStorage as never, converter as never, registry, core as never,
      { tempRoot: root, pollIntervalMs: 1000, enabled: false }, attemptCleanup
    );
    const assetCleanup = new FloorAssetCleanupService(prisma as never, workerStorage as never);

    try {
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION task5_fail_cad_asset_promotion() RETURNS trigger AS $$
        BEGIN
          IF OLD."status" = 'pending' AND NEW."status" = 'ready'
             AND OLD."kind" IN ('cad_region_preview', 'cad_manifest', 'cad_tile') THEN
            RAISE EXCEPTION 'forced CAD asset promotion failure';
          END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER task5_fail_cad_asset_promotion
        BEFORE UPDATE ON "FloorAsset"
        FOR EACH ROW EXECUTE FUNCTION task5_fail_cad_asset_promotion()
      `);

      await expect(importWorker.runOnce()).resolves.toBe(true);
      await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({ status: "queued", stage: "queued", progressPercent: 90, attemptCount: 1 });
      const tombstones = await prisma.floorAsset.findMany({
        where: {
          floorId,
          kind: { in: ["cad_region_preview", "cad_manifest", "cad_tile"] },
          status: "pending"
        },
        orderBy: { id: "asc" }
      });
      expect(tombstones).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: previewIdentity.assetId, status: "pending", uploadExpiresAt: expect.any(Date) }),
        expect.objectContaining({ id: identity.manifestAssetId, status: "pending", uploadExpiresAt: expect.any(Date) })
      ]));
      expect(tombstones.some(asset => asset.kind === "cad_tile")).toBe(true);
      expect(tombstones.every(asset => objects.has(asset.objectKey))).toBe(true);

      await prisma.$executeRawUnsafe(`DROP TRIGGER task5_fail_cad_asset_promotion ON "FloorAsset"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION task5_fail_cad_asset_promotion()`);
      const cleanupAt = new Date(Date.now() + 20 * 60_000);
      let processed = 0;
      let deleted = 0;
      for (;;) {
        const batch = await assetCleanup.processPending(cleanupAt);
        processed += batch.processed;
        deleted += batch.deleted;
        if (batch.processed === 0) break;
      }
      expect({ processed, deleted }).toEqual({ processed: tombstones.length, deleted: tombstones.length });
      await expect(prisma.floorAsset.count({
        where: { id: { in: tombstones.map(asset => asset.id) } }
      })).resolves.toBe(0);
      expect(tombstones.every(asset => !objects.has(asset.objectKey))).toBe(true);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS task5_fail_cad_asset_promotion ON "FloorAsset"`).catch(() => undefined);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS task5_fail_cad_asset_promotion()`).catch(() => undefined);
      await importWorker.onModuleDestroy();
      await attemptCleanup.onModuleDestroy();
      assetCleanup.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rolls back a failed middle candidate chunk, retries, persists 2,000 rows and cleans the failed attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-worker-pg-"));
    const source = await sourceAsset();
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, sourceFormat: "dxf", detectorProfileId: "generic-lighting-v1"
    } });
    const dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n1\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n";
    const objects = new Set<string>();
    const storageForWorker = {
      downloadFloorAssetToFile: jest.fn(async (_key: string, path: string) => writeFile(path, dxf)),
      putFloorRenderedObjectFile: jest.fn(async (key: string) => { objects.add(key); }),
      verifyFloorRenderedObject: jest.fn(async (key: string) => {
        if (!objects.has(key)) throw new Error("missing worker object");
      }),
      putCadSceneObjectFile: jest.fn(async (key: string) => { objects.add(key); }),
      verifyCadSceneObject: jest.fn(async (key: string) => {
        if (!objects.has(key)) throw new Error("missing CAD scene worker object");
      }),
      deleteObject: jest.fn(async (key: string) => { objects.delete(key); })
    };
    const converter = { convert: jest.fn(async ({ inputPath, outputPath }: { inputPath: string; outputPath: string }) => {
      await writeFile(outputPath, await readFile(inputPath));
      return { outputPath, outputBytes: Buffer.byteLength(dxf) };
    }) };
    const registry = new FixedLightingDetectorRegistry();
    const profile = registry.get("generic-lighting-v1");
    const candidates = Array.from({ length: 2_000 }, (_, index) => ({
      sourceEntityId: `insert-${index}`, layerName: "LIGHT", blockName: "LED",
      x: index, y: 0, rotation: 0, confidence: 0.9, method: "rule" as const
    }));
    const chunkRegion = {
      regionId: "region-0123456789abcdef01234567",
      bounds: { minX: 0, minY: 0, maxX: 2_002, maxY: 2_002 },
      primitiveCount: 2_000, textCount: 0, lightCandidateCount: 2_000, area: 4_008_004
    };
    const core = { execute: jest.fn(async ({ renderedPath, artifactDirectory }: {
      renderedPath: string; artifactDirectory: string;
    }) => {
      await writeFile(renderedPath, "gzip-svg");
      const artifacts = await writeNativeCoreArtifacts(job.id, artifactDirectory, chunkRegion);
      return {
        profileId: "generic-lighting-v1" as const,
        profileVersion: profile.profileVersion!, profileDigest: profile.profileDigest!,
        modelEntityCount: 1, blockCount: 0, candidates,
        excludedRegionPrimitiveCount: 0,
        selectedCandidates: candidates,
        candidateRegionAssignments: candidates.map(candidate => ({
          sourceEntityId: candidate.sourceEntityId,
          regionId: chunkRegion.regionId
        })),
        regions: [chunkRegion],
        ...artifacts,
        candidateTransformMatch: { candidateCount: 2_000, matchedCount: 2_000, matchRate: 1, tolerancePx: 0.01, maxDeltaPx: 0 },
        rendered: { sizeBytes: 8, rawSizeBytes: 64, sha256: "d".repeat(64), viewport: { width: 2_002, height: 1_600 },
          renderedOccurrences: 2_000, contentEncoding: "gzip" as const }
      };
    }) };
    const cleanup = new FloorImportAttemptCleanupService(prisma as never, storageForWorker as never, {
      tempRoot: root, pollIntervalMs: 1000, enabled: false
    });
    const makeWorker = () => new FloorImportWorkerService(
      prisma as never, storageForWorker as never, converter as never, registry, core as never,
      { tempRoot: root, pollIntervalMs: 1000, enabled: false }, cleanup
    );

    try {
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION fail_cad_candidate_chunk() RETURNS trigger AS $$
        BEGIN
          IF NEW."sourceEntityId" = 'insert-750' THEN RAISE EXCEPTION 'forced middle chunk failure'; END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql
      `);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_cad_candidate_chunk BEFORE INSERT ON "FloorImportCandidate"
        FOR EACH ROW EXECUTE FUNCTION fail_cad_candidate_chunk()`);
      const first = makeWorker();
      await expect(first.runOnce()).resolves.toBe(true);
      await first.onModuleDestroy();
      await expect(prisma.floorImportCandidate.count({ where: { jobId: job.id } })).resolves.toBe(0);
      await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({
          status: "queued", stage: "queued", progressPercent: 90, attemptCount: 1,
          leaseOwner: null, leaseExpiresAt: null, startedAt: null,
          failureCode: null, failureMessage: null
        });

      await prisma.$executeRawUnsafe(`DROP TRIGGER fail_cad_candidate_chunk ON "FloorImportCandidate"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION fail_cad_candidate_chunk()`);
      const retry = makeWorker();
      await expect(retry.runOnce()).resolves.toBe(true);
      await retry.onModuleDestroy();
      await expect(prisma.floorImportCandidate.count({ where: { jobId: job.id } })).resolves.toBe(2_000);
      await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({ status: "review_required", progressPercent: 100, attemptCount: 2 });

      await cleanup.sweepAttempts(new Date(Date.now() + 10 * 60_000));
      expect(storageForWorker.deleteObject).toHaveBeenCalledWith(`floors/${floorId}/${job.id}-attempt-1.svg`);
      await expect(prisma.floorAsset.findFirst({ where: { objectKey: `floors/${floorId}/${job.id}-attempt-1.svg` } }))
        .resolves.toBeNull();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fail_cad_candidate_chunk ON "FloorImportCandidate"`).catch(() => undefined);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS fail_cad_candidate_chunk()`).catch(() => undefined);
      await cleanup.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("enforces queued retry lifecycle by rejecting retained progress without an attempt", async () => {
    const source = await sourceAsset();
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, sourceFormat: "dxf"
    } });

    expect(() => cluster.sql(databaseUrl, `
      UPDATE "FloorImportJob"
      SET "progressPercent" = 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = '${job.id}';
    `)).toThrow(/FloorImportJob_lifecycle_check/);
  });

  it("enforces queued retry lifecycle by preserving 99 percent through failure and reclaim", async () => {
    const source = await sourceAsset();
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, sourceFormat: "dxf", detectorProfileId: "generic-lighting-v1"
    } });
    const storageAtNinetyNine = {
      downloadFloorAssetToFile: jest.fn(async () => {
        await prisma.floorImportJob.update({
          where: { id: job.id },
          data: { progressPercent: 99 }
        });
        throw new Error("forced retry at 99 percent");
      })
    };
    const firstAttempt = new FloorImportWorkerService(
      prisma as never,
      storageAtNinetyNine as never,
      {} as never,
      new FixedLightingDetectorRegistry(),
      {} as never,
      { tempRoot: "/tmp", pollIntervalMs: 1000, enabled: false }
    );

    try {
      await expect(firstAttempt.runOnce()).resolves.toBe(true);
      await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({
          status: "queued", stage: "queued", progressPercent: 99, attemptCount: 1,
          leaseOwner: null, leaseExpiresAt: null, startedAt: null,
          failureCode: null, failureMessage: null
        });
    } finally {
      await firstAttempt.onModuleDestroy();
    }

    const retry = worker();
    try {
      await expect(retry.claimNext()).resolves.toMatchObject({
        id: job.id, status: "processing", progressPercent: 99, attemptCount: 2,
        leaseOwner: expect.any(String), leaseExpiresAt: expect.any(Date)
      });
    } finally {
      await retry.onModuleDestroy();
    }
  });

  it("reaps a late PUT during a bounded quiet period and then terminally retires the orphan tombstone", async () => {
    const killedFloor = await prisma.floor.create({ data: { siteId, name: "Killed import floor", level: 99 } });
    const sourceId = randomUUID();
    const source = await prisma.floorAsset.create({ data: {
      id: sourceId, floorId: killedFloor.id, kind: "original", status: "ready",
      objectKey: `floors/${killedFloor.id}/${sourceId}.dxf`, mimeType: "application/dxf",
      sizeBytes: 128n, sha256: "a".repeat(64), readyAt: new Date()
    } });
    const job = await prisma.floorImportJob.create({ data: {
      floorId: killedFloor.id, sourceAssetId: source.id, sourceFormat: "dxf"
    } });
    const claimed = await worker().claimNext();
    expect(claimed).toMatchObject({ id: job.id, attemptCount: 1, status: "processing" });
    const objects = new Set<string>();
    const attemptStorage = {
      deleteObject: jest.fn(async (key: string) => { objects.delete(key); })
    };
    const beforeKill = new FloorImportAttemptCleanupService(prisma as never, attemptStorage as never, {
      tempRoot: "/tmp", pollIntervalMs: 1000, enabled: false
    });
    const attempt = await beforeKill.armAttempt(
      { jobId: job.id, floorId: killedFloor.id, attemptCount: 1 },
      { sizeBytes: 256, sha256: "b".repeat(64) },
      new Date("2026-09-17T00:00:00.000Z")
    );
    objects.add(attempt.objectKey); // Process dies after PUT and before the ready/link transaction.
    await prisma.floor.delete({ where: { id: killedFloor.id } });
    expect(await prisma.floorImportJob.findUnique({ where: { id: job.id } })).toBeNull();
    expect(await prisma.floorAsset.findUnique({ where: { id: attempt.assetId } })).toBeNull();
    await prisma.floorImportAttemptCleanup.update({
      where: { jobId_attemptCount: { jobId: job.id, attemptCount: 1 } },
      data: { nextAttemptAt: new Date(0) }
    });

    const restarted = new FloorImportAttemptCleanupService(prisma as never, attemptStorage as never, {
      tempRoot: "/tmp", pollIntervalMs: 1000, enabled: false
    });
    const firstSweepAt = new Date("2026-09-17T01:00:00.000Z");
    await restarted.sweepAttempts(firstSweepAt);
    expect(objects).not.toContain(attempt.objectKey);
    expect(await prisma.floorAsset.findUnique({ where: { id: attempt.assetId } })).toBeNull();
    await expect(prisma.floorImportAttemptCleanup.findUniqueOrThrow({
      where: { jobId_attemptCount: { jobId: job.id, attemptCount: 1 } }
    })).resolves.toMatchObject({ committedAt: null, lastCleanedAt: firstSweepAt, lastError: null });

    objects.add(attempt.objectKey); // A paused transport completes after the first cleanup pass.
    await restarted.sweepAttempts(new Date(firstSweepAt.getTime() + 60_000));
    expect(objects).toContain(attempt.objectKey);
    expect(attemptStorage.deleteObject).toHaveBeenCalledTimes(1);

    const terminalSweepAt = new Date(firstSweepAt.getTime() + 15 * 60_000);
    await restarted.sweepAttempts(terminalSweepAt);
    expect(objects).not.toContain(attempt.objectKey);
    expect(attemptStorage.deleteObject).toHaveBeenCalledTimes(2);
    const terminal = await prisma.floorImportAttemptCleanup.findUniqueOrThrow({
      where: { jobId_attemptCount: { jobId: job.id, attemptCount: 1 } }
    });
    expect(terminal).toMatchObject({ committedAt: null, lastCleanedAt: terminalSweepAt, lastError: null });
    expect((terminal as typeof terminal & { cleanedAt: Date | null }).cleanedAt).toEqual(terminalSweepAt);

    await restarted.sweepAttempts(new Date(terminalSweepAt.getTime() + 60_000));
    expect(attemptStorage.deleteObject).toHaveBeenCalledTimes(2);
    await restarted.onModuleDestroy();
  });

  it("atomically replaces map objects and slots while preserving registered fixture relationships", async () => {
    const source = await sourceAsset(); const renderedId = randomUUID(); const jobId = randomUUID();
    await prisma.floorAsset.create({ data: {
      id: renderedId, floorId, kind: "rendered", status: "ready", objectKey: `floors/${floorId}/${renderedId}.svg`,
      mimeType: "image/svg+xml", contentEncoding: null, sizeBytes: 256n, sha256: "b".repeat(64), readyAt: new Date()
    } });
    await prisma.floorImportJob.create({ data: {
      id: jobId, floorId, sourceAssetId: source.id, renderedAssetId: renderedId, sourceFormat: "dxf",
      status: "review_required", stage: "review_required", progressPercent: 100, attemptCount: 1,
      startedAt: new Date(), reviewRequiredAt: new Date(), parserVersion: "ascii-dxf-v1", detectorVersion: "rule-v1",
      excludedRegionPrimitiveCount: 0, ...terminalProfile
    } });
    const candidateIds = Array.from({ length: 2_000 }, () => randomUUID());
    const acceptedIds = candidateIds;
    const acceptedId = acceptedIds[0]; const previousSlotCandidateId = candidateIds.at(-1)!;
    await prisma.floorImportCandidate.createMany({ data: candidateIds.map((id, index) => ({
      id, jobId, sourceEntityId: `insert-${index}`, layerName: "LIGHT", blockName: "LED",
      x: 10 + index, y: 20 + index, rotation: 0, confidence: 0.95, detectionMethod: "rule_based" as const,
      profileVersion: "test/1", profileDigest: "b".repeat(64)
    })) });
    await expect(service().listCandidates(user, floorId, jobId)).resolves.toMatchObject({ candidates: expect.any(Array) });
    expect((await service().listCandidates(user, floorId, jobId)).candidates).toHaveLength(2_000);
    const gateway = await prisma.gateway.create({ data: {
      siteId, name: "CAD reset preservation", serialNumber: randomUUID(), firmwareVersion: "test"
    } });
    const node = await prisma.meshNode.create({ data: {
      gatewayId: gateway.id, meshAddress: "0x0210", serialNumber: "cad-reset-node", firmwareVersion: "test"
    } });
    const fixtureIds = Array.from({ length: 4 }, () => randomUUID());
    await prisma.fixture.createMany({ data: fixtureIds.map((id, index) => ({
      id, floorId, siteId, name: `Existing fixture ${index + 1}`, ratedWatt: 40,
      x: 11 + index, y: 22 + index, placementStatus: "placed" as const,
      positionVerifiedAt: new Date("2026-09-17T00:00:00.000Z"),
      ...(index === 0 ? { meshNodeId: node.id, gatewayId: gateway.id } : {})
    })) });
    const group = await prisma.fixtureGroup.create({ data: {
      siteId, floorId, gatewayId: gateway.id, name: "CAD reset group",
      groupFixtures: { create: { fixtureId: fixtureIds[0] } }
    } });
    const schedule = await prisma.lightingSchedule.create({ data: {
      siteId, gatewayId: gateway.id, name: "CAD reset schedule",
      activeFrom: new Date("2026-09-01T00:00:00.000Z"), activeUntil: new Date("2026-10-01T00:00:00.000Z"),
      localStartTime: "08:00", localEndTime: "20:00", recurrenceKind: "daily",
      dimmingEnabled: true, brightnessPercent: 50, createdById: userId, updatedById: userId,
      fixtures: { create: { fixtureId: fixtureIds[0] } }
    } });
    const energyUsage = await prisma.energyUsage.create({ data: {
      fixtureId: fixtureIds[0], source: "cad-reset-test", period: "2026-09", kwh: "1.2500", cost: "125.00"
    } });
    const relationshipEvidence = {
      node: await prisma.meshNode.findUniqueOrThrow({ where: { id: node.id } }),
      membership: await prisma.groupFixture.findMany({ where: { groupId: group.id } }),
      schedule: await prisma.lightingScheduleFixture.findMany({ where: { scheduleId: schedule.id } }),
      energyUsage: await prisma.energyUsage.findUniqueOrThrow({ where: { id: energyUsage.id } })
    };
    const objectIds = [randomUUID(), randomUUID()];
    await prisma.floorMapObject.createMany({ data: objectIds.map((id, index) => ({
      id, floorId, type: "rectangle", x: index + 1, y: index + 2, width: 3, height: 4
    })) });
    await prisma.floorLightSlot.create({ data: {
      floorId, sourceImportJobId: jobId, sourceCandidateId: previousSlotCandidateId,
      assignedFixtureId: fixtureIds[0], x: 99, y: 88, rotation: 45
    } });
    await prisma.floor.update({ where: { id: floorId }, data: {
      mapRevision: 4, editorLeaseFence: 8, editorLeaseTokenHash: hashEditorLeaseToken("lease-token"),
      editorLeaseHolderId: userId, editorLeaseHolderName: user.name,
      editorLeaseAcquiredAt: new Date(), editorLeaseExpiresAt: new Date(Date.now() + 60_000)
    } });

    const applied = await service().apply(user, floorId, jobId, {
      expectedRevision: 4, leaseToken: "lease-token", leaseFence: 8,
      candidateIds: acceptedIds, confirmMapReset: true
    });
    expect(applied).toMatchObject({
      status: "completed", revision: 5,
      deletedObjectCount: 2, unplacedFixtureCount: 4, deletedSlotCount: 1, createdSlotCount: 2_000
    });
    expect(storage.readFloorRenderedMetadata).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ contentEncoding: null }));
    expect(applied.acceptedCandidateIds).toHaveLength(2_000);
    expect(new Set(applied.acceptedCandidateIds)).toEqual(new Set(acceptedIds));

    await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: jobId } })).resolves.toMatchObject({
      status: "completed", appliedAt: expect.any(Date), completedAt: expect.any(Date)
    });
    const reviewedCandidates = await prisma.floorImportCandidate.findMany({
      where: { jobId }, orderBy: { id: "asc" }, select: { id: true, reviewStatus: true, reviewedAt: true }
    });
    expect(reviewedCandidates).toHaveLength(2_000);
    expect(reviewedCandidates.every(candidate => candidate.reviewStatus === "accepted" && candidate.reviewedAt instanceof Date)).toBe(true);
    expect(await prisma.fixture.findMany({ where: { floorId }, orderBy: { id: "asc" } })).toEqual(
      expect.arrayContaining(fixtureIds.map(id => expect.objectContaining({
        id, placementStatus: "unplaced", positionVerifiedAt: null, x: 0, y: 0
      })))
    );
    expect(await prisma.floorMapObject.count({ where: { floorId } })).toBe(0);
    const slots = await prisma.floorLightSlot.findMany({ where: { floorId }, orderBy: { sourceCandidateId: "asc" } });
    expect(slots).toHaveLength(2_000);
    expect(slots.map(slot => slot.sourceCandidateId).sort()).toEqual([...acceptedIds].sort());
    expect(slots.every(slot => slot.assignedFixtureId === null)).toBe(true);
    expect(await prisma.meshNode.findUniqueOrThrow({ where: { id: node.id } })).toEqual(relationshipEvidence.node);
    expect(await prisma.groupFixture.findMany({ where: { groupId: group.id } })).toEqual(relationshipEvidence.membership);
    expect(await prisma.lightingScheduleFixture.findMany({ where: { scheduleId: schedule.id } })).toEqual(relationshipEvidence.schedule);
    expect(await prisma.energyUsage.findUniqueOrThrow({ where: { id: energyUsage.id } })).toEqual(relationshipEvidence.energyUsage);
    await expect(prisma.floor.findUniqueOrThrow({ where: { id: floorId } })).resolves.toMatchObject({ mapRevision: 5 });
    await expect(prisma.floorPlan.findUniqueOrThrow({ where: { floorId } })).resolves.toMatchObject({
      width: 640, height: 480, imageUrl: `/api/floors/${floorId}/assets/${renderedId}/content`
    });
    const expectedChangeSummary = {
      floorImportJobId: jobId,
      floorPlanChanged: true,
      acceptedCandidates: 2_000,
      rejectedCandidates: 0,
      deletedObjectCount: 2,
      unplacedFixtureCount: 4,
      deletedSlotCount: 1,
      createdSlotCount: 2_000,
      fixtureUpdates: 4,
      objectCreates: 0,
      objectUpdates: 0,
      objectDeletes: 2
    };
    const revision = await prisma.floorMapRevision.findUniqueOrThrow({ where: { floorId_revision: { floorId, revision: 5 } } });
    expect(revision).toMatchObject({
        changedBy: userId,
        changeSummary: expectedChangeSummary,
        snapshot: expect.objectContaining({ lightSlots: expect.arrayContaining([
          expect.objectContaining({ x: 10, y: 20, assignedFixtureId: null })
        ]) })
      });
    await expect(prisma.auditLog.findFirstOrThrow({ where: { targetId: jobId, action: "floor_import.applied" } }))
      .resolves.toMatchObject({
        actorId: userId,
        outcome: "success",
        metadata: {
          floorId,
          revision: 5,
          acceptedCandidateIds: [...acceptedIds].sort(),
          snapshotSha256: revision.snapshotSha256,
          changeSummary: expectedChangeSummary
        }
      });

    const overlay = await service().getAppliedOverlay(user, floorId);
    expect(overlay).toMatchObject({
      overlay: {
        floorId,
        jobId,
        revision: 5,
        renderedAssetId: renderedId,
        renderedViewport: { width: 640, height: 480 },
        candidates: expect.any(Array)
      }
    });
    expect(overlay.overlay?.candidates).toHaveLength(2_000);
    expect(overlay.overlay?.candidates.every(candidate => candidate.reviewStatus === "accepted")).toBe(true);
    expect(overlay.overlay?.candidates[0]).not.toHaveProperty("fixtureId");
    expect(overlay.overlay?.candidates[0]).not.toHaveProperty("meshNodeId");

    const replacementSource = await sourceAsset();
    const replacementRendered = await renderedAsset();
    await prisma.floorImportJob.create({ data: {
      floorId,
      sourceAssetId: replacementSource.id,
      renderedAssetId: replacementRendered.id,
      sourceFormat: "dxf",
      status: "review_required",
      stage: "review_required",
      progressPercent: 100,
      attemptCount: 1,
      startedAt: new Date(),
      reviewRequiredAt: new Date(),
      ...terminalProfile
    } });
    await expect(service().getAppliedOverlay(user, floorId)).resolves.toMatchObject({
      overlay: { jobId, renderedAssetId: renderedId, revision: 5 }
    });
    await prisma.lightingSchedule.delete({ where: { id: schedule.id } });
    await prisma.fixtureGroup.delete({ where: { id: group.id } });
    await prisma.fixture.update({ where: { id: fixtureIds[0] }, data: { meshNodeId: null } });
    await prisma.gateway.delete({ where: { id: gateway.id } });
  });

  it("applies a zero-candidate replacement and records exact reset counts", async () => {
    const previousSource = await sourceAsset();
    const previousRendered = await renderedAsset();
    const previousJob = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: previousSource.id, renderedAssetId: previousRendered.id, sourceFormat: "dxf",
      status: "completed", stage: "completed", progressPercent: 100, attemptCount: 1,
      startedAt: new Date(), reviewRequiredAt: new Date(), completedAt: new Date(), appliedAt: new Date(), ...terminalProfile
    } });
    const previousManifestId = randomUUID();
    const previousTileId = randomUUID();
    await prisma.floorAsset.createMany({ data: [
      {
        id: previousManifestId, floorId, kind: "cad_manifest", status: "ready",
        objectKey: `floors/${floorId}/${previousJob.id}-${previousManifestId}.cad-manifest.json`,
        mimeType: "application/json", sizeBytes: 256n, sha256: "8".repeat(64), readyAt: new Date()
      },
      {
        id: previousTileId, floorId, kind: "cad_tile", status: "ready",
        objectKey: `floors/${floorId}/${previousJob.id}-${previousTileId}.cad-tile.bin`,
        mimeType: "application/vnd.led-control.cad-tile", sizeBytes: 128n,
        sha256: "9".repeat(64), readyAt: new Date()
      }
    ] });
    const previousRegion = await prisma.floorImportRegion.create({ data: {
      jobId: previousJob.id, regionId: "region-aaaaaaaaaaaaaaaaaaaaaaaa",
      minX: 0, minY: 0, maxX: 100, maxY: 100, primitiveCount: 1, selectedAt: new Date()
    } });
    const previousSceneId = randomUUID();
    await prisma.floorCadScene.create({ data: {
      id: previousSceneId, floorId, sourceImportJobId: previousJob.id, sourceRegionId: previousRegion.id,
      version: 1, width: 512, height: 512, tileSize: 512, primitiveCount: 1, tileCount: 1,
      manifestAssetId: previousManifestId, sourceMinX: 0, sourceMinY: 0, sourceMaxX: 100, sourceMaxY: 100,
      transformScaleX: 1, transformScaleY: -1, transformTranslateX: 0, transformTranslateY: 100,
      tiles: { create: {
        tileX: 0, tileY: 0, lod: 0, part: 0, assetId: previousTileId, primitiveCount: 1,
        byteSize: 128n, minX: 0, minY: 0, maxX: 512, maxY: 512
      } },
      elementOverrides: { create: { elementId: "line:previous", hidden: true } },
      layerStates: { create: { layerName: "WALL", visible: false, locked: true } }
    } });
    const previousCandidate = await prisma.floorImportCandidate.create({ data: {
      jobId: previousJob.id, sourceEntityId: "previous-slot", layerName: "LIGHT", blockName: "LED",
      x: 30, y: 40, rotation: 0, confidence: 0.95, detectionMethod: "rule_based",
      reviewStatus: "accepted", reviewedAt: new Date(), profileVersion: "test/1", profileDigest: "b".repeat(64)
    } });
    const fixture = await prisma.fixture.create({ data: {
      floorId, siteId, name: "Placed before empty CAD", ratedWatt: 40,
      x: 30, y: 40, placementStatus: "placed", positionVerifiedAt: new Date()
    } });
    await prisma.floorLightSlot.create({ data: {
      floorId, sourceImportJobId: previousJob.id, sourceCandidateId: previousCandidate.id,
      assignedFixtureId: fixture.id, x: 30, y: 40, rotation: 0
    } });
    await prisma.floorMapObject.createMany({ data: [
      { floorId, type: "rectangle", x: 1, y: 2, width: 3, height: 4 },
      { floorId, type: "line", x: 5, y: 6, width: 7, height: 8 }
    ] });

    const source = await sourceAsset();
    const rendered = await renderedAsset();
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, renderedAssetId: rendered.id, sourceFormat: "dxf",
      status: "review_required", stage: "review_required", progressPercent: 100, attemptCount: 1,
      startedAt: new Date(), reviewRequiredAt: new Date(), excludedRegionPrimitiveCount: 0, ...terminalProfile
    } });
    await prisma.floor.update({ where: { id: floorId }, data: {
      mapRevision: 4, editorLeaseFence: 8, editorLeaseTokenHash: hashEditorLeaseToken("lease-token"),
      editorLeaseHolderId: userId, editorLeaseHolderName: user.name,
      editorLeaseAcquiredAt: new Date(), editorLeaseExpiresAt: new Date(Date.now() + 60_000)
    } });

    const applied = await service().apply(user, floorId, job.id, {
      expectedRevision: 4, leaseToken: "lease-token", leaseFence: 8,
      candidateIds: [], confirmMapReset: true
    });
    const expectedChangeSummary = {
      floorImportJobId: job.id,
      floorPlanChanged: true,
      acceptedCandidates: 0,
      rejectedCandidates: 0,
      deletedObjectCount: 2,
      unplacedFixtureCount: 1,
      deletedSlotCount: 1,
      createdSlotCount: 0,
      fixtureUpdates: 1,
      objectCreates: 0,
      objectUpdates: 0,
      objectDeletes: 2
    };

    expect(applied).toMatchObject({
      status: "completed", revision: 5, acceptedCandidateIds: [],
      deletedObjectCount: 2, unplacedFixtureCount: 1, deletedSlotCount: 1, createdSlotCount: 0
    });
    expect(await prisma.floorLightSlot.count({ where: { floorId } })).toBe(0);
    expect(await prisma.floorMapObject.count({ where: { floorId } })).toBe(0);
    expect(await prisma.floorCadScene.count({ where: { floorId } })).toBe(0);
    expect(await prisma.floorCadTile.count({ where: { sceneId: previousSceneId } })).toBe(0);
    expect(await prisma.floorCadElementOverride.count({ where: { sceneId: previousSceneId } })).toBe(0);
    expect(await prisma.floorCadLayerState.count({ where: { sceneId: previousSceneId } })).toBe(0);
    await expect(prisma.fixture.findUniqueOrThrow({ where: { id: fixture.id } })).resolves.toMatchObject({
      placementStatus: "unplaced", positionVerifiedAt: null, x: 0, y: 0
    });
    const revision = await prisma.floorMapRevision.findUniqueOrThrow({
      where: { floorId_revision: { floorId, revision: 5 } }
    });
    expect(revision.changeSummary).toEqual(expectedChangeSummary);
    await expect(prisma.auditLog.findFirstOrThrow({
      where: { targetId: job.id, action: "floor_import.applied" }
    })).resolves.toMatchObject({
      metadata: {
        floorId,
        revision: 5,
        acceptedCandidateIds: [],
        snapshotSha256: revision.snapshotSha256,
        changeSummary: expectedChangeSummary
      }
    });
  });

  it("rolls back the plan, objects, fixtures, slots, revision, audit and job when slot creation trigger fails", async () => {
    const source = await sourceAsset(); const rendered = await renderedAsset(); const jobId = randomUUID();
    await prisma.floorImportJob.create({ data: {
      id: jobId, floorId, sourceAssetId: source.id, renderedAssetId: rendered.id, sourceFormat: "dxf",
      status: "review_required", stage: "review_required", progressPercent: 100, attemptCount: 1,
      startedAt: new Date(), reviewRequiredAt: new Date(), ...terminalProfile
    } });
    const candidateIds = [randomUUID(), randomUUID()];
    await prisma.floorImportCandidate.createMany({ data: candidateIds.map((id, index) => ({
      id, jobId, sourceEntityId: `rollback-${index}`, layerName: "LIGHT", blockName: "LED",
      x: 100 + index, y: 200 + index, rotation: index * 15, confidence: 0.9,
      detectionMethod: "rule_based" as const, profileVersion: "test/1", profileDigest: "c".repeat(64)
    })) });
    const fixtureIds = [randomUUID(), randomUUID()];
    await prisma.fixture.createMany({ data: fixtureIds.map((id, index) => ({
      id, floorId, siteId, name: `Rollback fixture ${index + 1}`, ratedWatt: 40,
      x: 31 + index, y: 41 + index, placementStatus: "placed" as const,
      positionVerifiedAt: new Date("2026-09-17T01:00:00.000Z")
    })) });
    await prisma.floorMapObject.create({ data: {
      id: randomUUID(), floorId, type: "rectangle", x: 1, y: 2, width: 30, height: 40
    } });
    await prisma.floorPlan.create({ data: {
      floorId, imageUrl: `/api/floors/${floorId}/assets/${source.id}/content`, sourceType: "image",
      originalFileUrl: `/api/floors/${floorId}/assets/${source.id}/content`, renderedImageUrl: null,
      width: 320, height: 240, gridSize: 20
    } });
    await prisma.floorLightSlot.create({ data: {
      floorId, sourceImportJobId: jobId, sourceCandidateId: candidateIds[1],
      assignedFixtureId: fixtureIds[0], x: 33, y: 44, rotation: 25
    } });
    await prisma.floor.update({ where: { id: floorId }, data: {
      mapRevision: 4, editorLeaseFence: 8, editorLeaseTokenHash: hashEditorLeaseToken("lease-token"),
      editorLeaseHolderId: userId, editorLeaseHolderName: user.name,
      editorLeaseAcquiredAt: new Date(), editorLeaseExpiresAt: new Date(Date.now() + 60_000)
    } });

    const readState = async () => ({
      plan: await prisma.floorPlan.findUnique({ where: { floorId } }),
      objects: await prisma.floorMapObject.findMany({ where: { floorId }, orderBy: { id: "asc" } }),
      fixtures: await prisma.fixture.findMany({ where: { floorId }, orderBy: { id: "asc" } }),
      slots: await prisma.floorLightSlot.findMany({ where: { floorId }, orderBy: { id: "asc" } }),
      revisions: await prisma.floorMapRevision.findMany({ where: { floorId }, orderBy: { revision: "asc" } }),
      audits: await prisma.auditLog.findMany({ where: { siteId }, orderBy: { id: "asc" } }),
      job: await prisma.floorImportJob.findUniqueOrThrow({ where: { id: jobId } }),
      candidates: await prisma.floorImportCandidate.findMany({ where: { jobId }, orderBy: { id: "asc" } }),
      floor: await prisma.floor.findUniqueOrThrow({ where: { id: floorId } })
    });
    const before = await readState();
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "task5_force_floor_light_slot_failure"() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      BEGIN
        RAISE EXCEPTION 'task5 forced slot trigger failure' USING ERRCODE = '23514';
      END;
      $function$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "task5_force_floor_light_slot_failure"
      BEFORE INSERT ON "FloorLightSlot"
      FOR EACH ROW EXECUTE FUNCTION "task5_force_floor_light_slot_failure"()
    `);
    try {
      await expect(service().apply(user, floorId, jobId, {
        expectedRevision: 4, leaseToken: "lease-token", leaseFence: 8,
        candidateIds: [candidateIds[0]], confirmMapReset: true
      })).rejects.toBeDefined();
      expect(await readState()).toEqual(before);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "task5_force_floor_light_slot_failure" ON "FloorLightSlot"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "task5_force_floor_light_slot_failure"()`);
    }
  });

  it("allows an existing rendered SVG to retain an identity ledger", async () => {
    const source = await sourceAsset(); const rendered = await renderedAsset();
    await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId: source.id, renderedAssetId: rendered.id, sourceFormat: "dxf",
      status: "review_required", stage: "review_required", progressPercent: 100, attemptCount: 1,
      startedAt: new Date(), reviewRequiredAt: new Date(), ...terminalProfile
    } });
    await expect(prisma.floorAsset.update({
      where: { id: rendered.id }, data: { contentEncoding: null }
    })).resolves.toMatchObject({ contentEncoding: null });
  });

  it("enforces admin, viewer, tenant, session, and transaction-time permission boundaries over real HTTP", async () => {
    const viewer = await prisma.user.create({ data: {
      organizationId, loginId: `cad_viewer_${randomUUID()}`, name: "CAD Viewer", passwordHash: "unused", role: "viewer"
    } });
    await prisma.siteMembership.create({ data: { siteId, userId: viewer.id, accessLevel: "read" } });
    const otherOrganization = await prisma.organization.create({ data: { name: "Other CAD tenant", type: "customer" } });
    const otherAdmin = await prisma.user.create({ data: {
      organizationId: otherOrganization.id, loginId: `other_cad_${randomUUID()}`, name: "Other Admin", passwordHash: "unused", role: "admin"
    } });
    await prisma.site.create({ data: { organizationId: otherOrganization.id, adminUserId: otherAdmin.id, name: "Other CAD site" } });
    const replacement = await prisma.user.create({ data: {
      organizationId, loginId: `replacement_${randomUUID()}`, name: "Replacement Admin", passwordHash: "unused", role: "admin"
    } });
    const source = await sourceAsset("application/dwg", PROVIDED_SAMPLE_DWG_SHA256);
    const module = await Test.createTestingModule({ imports: [FloorImportModule, FloorEditorModule] })
      .overrideProvider(PrismaService).useValue(prisma)
      .overrideProvider(RedisProvider).useValue({ onModuleInit: () => undefined, onModuleDestroy: () => undefined })
      .overrideProvider(ObjectStorageService).useValue(storage)
      .overrideProvider(CAD_IMPORT_WORKER_OPTIONS).useValue({ tempRoot: "/tmp", pollIntervalMs: 1000, enabled: true })
      .compile();
    const app: INestApplication = module.createNestApplication({ logger: false });
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const cookie = async (id: string) => {
      const token = randomUUID();
      await prisma.session.create({ data: {
        userId: id, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000)
      } });
      return `${AuthService.sessionCookieName}=${token}`;
    };
    const send = (method: string, path: string, session?: string, body?: unknown) => fetch(`${base}${path}`, {
      method, redirect: "manual",
      headers: { "content-type": "application/json", ...(session ? { cookie: session } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const adminCookie = await cookie(userId); const viewerCookie = await cookie(viewer.id); const otherCookie = await cookie(otherAdmin.id);
    try {
      const collection = `/floors/${floorId}/import-jobs`;
      expect((await send("POST", collection, undefined, { sourceAssetId: source.id, sourceFormat: "dwg" })).status).toBe(401);
      const createdResponse = await send("POST", collection, adminCookie, { sourceAssetId: source.id, sourceFormat: "dwg" });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { jobId: string; detectorProfileId: string };
      expect(created.detectorProfileId).toBe("site-drawing-20260803-v1");

      const selectionFloor = await prisma.floor.create({ data: { siteId, name: "CAD HTTP selection", level: 20 } });
      const selectionSourceId = randomUUID();
      await prisma.floorAsset.create({ data: {
        id: selectionSourceId, floorId: selectionFloor.id, kind: "original", status: "ready",
        objectKey: `floors/${selectionFloor.id}/${selectionSourceId}.dxf`, mimeType: "application/dxf",
        sizeBytes: 128n, sha256: "4".repeat(64), readyAt: new Date()
      } });
      const selectionJob = await prisma.floorImportJob.create({ data: {
        floorId: selectionFloor.id, sourceAssetId: selectionSourceId, sourceFormat: "dxf",
        status: "region_selection_required", stage: "region_selection_required", progressPercent: 70,
        attemptCount: 1, startedAt: new Date(), reviewRequiredAt: new Date(),
        excludedRegionPrimitiveCount: 0, ...terminalProfile
      } });
      const selectionPreviewIds = [randomUUID(), randomUUID()];
      await prisma.floorAsset.createMany({ data: selectionPreviewIds.map((id, index) => ({
        id, floorId: selectionFloor.id, kind: "cad_region_preview" as const, status: "ready" as const,
        objectKey: `floors/${selectionFloor.id}/${id}.svg`, mimeType: "image/svg+xml",
        contentEncoding: "gzip", sizeBytes: 64n, sha256: String(index + 5).repeat(64), readyAt: new Date()
      })) });
      const selectionRegionIds = ["region-777777777777777777777777", "region-888888888888888888888888"];
      await prisma.floorImportRegion.createMany({ data: selectionRegionIds.map((regionId, index) => ({
        jobId: selectionJob.id, regionId,
        minX: index * 200, minY: index * 200, maxX: index * 200 + 100, maxY: index * 200 + 100,
        primitiveCount: 1,
        textCount: 0, lightCandidateCount: 0, previewWidth: 1_200, previewHeight: 1_200,
        candidateIdentityDigest: EMPTY_CANDIDATE_IDENTITY_DIGEST,
        previewAssetId: selectionPreviewIds[index]
      })) });

      const sceneFloor = await prisma.floor.create({ data: { siteId, name: "CAD HTTP scene", level: 21 } });
      const sceneSourceId = randomUUID();
      const sceneRenderedId = randomUUID();
      const scenePreviewId = randomUUID();
      await prisma.floorAsset.createMany({ data: [
        {
          id: sceneSourceId, floorId: sceneFloor.id, kind: "original", status: "ready",
          objectKey: `floors/${sceneFloor.id}/${sceneSourceId}.dxf`, mimeType: "application/dxf",
          sizeBytes: 128n, sha256: "7".repeat(64), readyAt: new Date()
        },
        {
          id: sceneRenderedId, floorId: sceneFloor.id, kind: "rendered", status: "ready",
          objectKey: `floors/${sceneFloor.id}/${sceneRenderedId}.svg`, mimeType: "image/svg+xml",
          contentEncoding: "gzip", sizeBytes: 64n, sha256: "8".repeat(64), readyAt: new Date()
        },
        {
          id: scenePreviewId, floorId: sceneFloor.id, kind: "cad_region_preview", status: "ready",
          objectKey: `floors/${sceneFloor.id}/${scenePreviewId}.svg`, mimeType: "image/svg+xml",
          contentEncoding: "gzip", sizeBytes: 64n, sha256: "9".repeat(64), readyAt: new Date()
        }
      ] });
      const sceneJob = await prisma.floorImportJob.create({ data: {
        floorId: sceneFloor.id, sourceAssetId: sceneSourceId, renderedAssetId: sceneRenderedId,
        sourceFormat: "dxf", status: "review_required", stage: "review_required", progressPercent: 100,
        attemptCount: 1, startedAt: new Date(), reviewRequiredAt: new Date(), ...terminalProfile
      } });
      const sceneRegion = {
        regionId: "region-999999999999999999999999",
        bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
        primitiveCount: 1, textCount: 0, lightCandidateCount: 0, area: 10_000
      };
      await prisma.floorImportRegion.create({ data: {
        jobId: sceneJob.id, regionId: sceneRegion.regionId,
        minX: 0, minY: 0, maxX: 100, maxY: 100, primitiveCount: 1,
        previewAssetId: scenePreviewId, selectedAt: new Date()
      } });
      const sceneCandidate = await prisma.floorImportCandidate.create({ data: {
        jobId: sceneJob.id, sourceEntityId: "http-legacy-light", layerName: "LIGHT", blockName: "LED",
        x: 40, y: 50, rotation: 0, confidence: 0.95, detectionMethod: "rule_based",
        profileVersion: "test/1", profileDigest: "a".repeat(64)
      } });
      const sceneFixture = await prisma.fixture.create({ data: {
        floorId: sceneFloor.id, siteId, name: "HTTP legacy fixture", ratedWatt: 40,
        x: 40, y: 50, placementStatus: "placed", positionVerifiedAt: new Date()
      } });
      const sceneMapObject = await prisma.floorMapObject.create({ data: {
        floorId: sceneFloor.id, type: "rectangle", x: 10, y: 20, width: 30, height: 40
      } });
      const sceneSlot = await prisma.floorLightSlot.create({ data: {
        floorId: sceneFloor.id, sourceImportJobId: sceneJob.id, sourceCandidateId: sceneCandidate.id,
        assignedFixtureId: sceneFixture.id, x: 40, y: 50, rotation: 0
      } });
      const sceneIdentity = cadScenePersistenceIdentity(sceneJob.id, sceneRegion.regionId);
      const builtScene = buildCadScene({
        version: 1, bounds: sceneRegion.bounds, blocks: [],
        entities: [{
          type: "line", sourceEntityId: "http-line", layer: "WALL",
          start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 100, z: 0 }
        }]
      }, sceneRegion, {
        sceneId: sceneIdentity.sceneId,
        manifestAssetId: sceneIdentity.manifestAssetId,
        tileAssetId: sceneIdentity.tileAssetId
      });
      await prisma.floorAsset.createMany({ data: [
        {
          id: builtScene.manifest.manifestAssetId, floorId: sceneFloor.id, kind: "cad_manifest",
          status: "ready", objectKey: sceneIdentity.manifestObjectKey(sceneFloor.id), mimeType: "application/json",
          sizeBytes: BigInt(builtScene.manifest.byteSize), sha256: builtScene.manifest.sha256, readyAt: new Date()
        },
        ...builtScene.tiles.map(tile => ({
          id: tile.descriptor.assetId, floorId: sceneFloor.id, kind: "cad_tile" as const,
          status: "ready" as const, objectKey: sceneIdentity.tileObjectKey(sceneFloor.id, tile.descriptor),
          mimeType: "application/vnd.led-control.cad-tile", sizeBytes: BigInt(tile.descriptor.byteSize),
          sha256: tile.descriptor.sha256, readyAt: new Date()
        }))
      ] });
      storage.readCadRegionPreviewMetadata = jest.fn().mockImplementation((_key: string, expected: any) => ({
        width: 1_200, height: 1_200, textCount: 0, lightCandidateCount: 0,
        area: (expected.bounds.maxX - expected.bounds.minX) * (expected.bounds.maxY - expected.bounds.minY)
      }));
      storage.readCadSceneManifest = jest.fn().mockResolvedValue(builtScene.manifest);
      storage.verifyCadSceneObject = jest.fn().mockResolvedValue(undefined);
      storage.createFloorAssetDownloadUrl = jest.fn(async (objectKey: string) => `https://private.invalid/${objectKey}`);
      await prisma.floor.update({ where: { id: sceneFloor.id }, data: {
        mapRevision: 6, editorLeaseFence: 12,
        editorLeaseTokenHash: hashEditorLeaseToken("http-legacy-lease"),
        editorLeaseHolderId: userId, editorLeaseHolderName: user.name,
        editorLeaseAcquiredAt: new Date(), editorLeaseExpiresAt: new Date(Date.now() + 60_000)
      } });

      expect((await send("GET", `${collection}/applied-overlay`)).status).toBe(401);
      const viewerOverlay = await send("GET", `${collection}/applied-overlay`, viewerCookie);
      expect(viewerOverlay.status).toBe(200);
      expect(await viewerOverlay.json()).toEqual({ overlay: null });
      expect((await send("GET", `${collection}/applied-overlay`, otherCookie)).status).toBe(404);
      expect((await send("GET", `${collection}/${created.jobId}`, viewerCookie)).status).toBe(200);
      expect((await send("GET", `${collection}/${created.jobId}/candidates`, viewerCookie)).status).toBe(200);
      const viewerSource = await sourceAsset();
      expect((await send("POST", collection, viewerCookie, { sourceAssetId: viewerSource.id, sourceFormat: "dxf" })).status).toBe(403);
      expect((await send("POST", `${collection}/${created.jobId}/cancel`, viewerCookie)).status).toBe(403);
      expect((await send("GET", `${collection}/${created.jobId}`, otherCookie)).status).toBe(404);

      const selectionCollection = `/floors/${selectionFloor.id}/import-jobs`;
      const selectionRegions = `${selectionCollection}/${selectionJob.id}/regions`;
      expect((await send("GET", selectionRegions)).status).toBe(401);
      expect((await send("GET", selectionRegions, viewerCookie)).status).toBe(200);
      expect((await send("GET", selectionRegions, otherCookie)).status).toBe(404);
      expect((await send("POST", `${selectionRegions}/select`, viewerCookie, {
        regionId: selectionRegionIds[0]
      })).status).toBe(403);
      expect((await send("POST", `${selectionRegions}/select`, otherCookie, {
        regionId: selectionRegionIds[0]
      })).status).toBe(404);
      expect((await send("POST", `${selectionRegions}/select`, adminCookie, {
        regionId: selectionRegionIds[0]
      })).status).toBe(200);

      const sceneCollection = `/floors/${sceneFloor.id}/import-jobs/${sceneJob.id}/scene`;
      const manifestContent = `${sceneCollection}/manifest/content`;
      const tile = builtScene.manifest.tiles[0];
      const tileContent = `${sceneCollection}/tiles/${tile.lod}/${tile.tileX}/${tile.tileY}/${tile.part}/content`;
      for (const contentPath of [manifestContent, tileContent]) {
        expect((await send("GET", contentPath)).status).toBe(401);
        const viewerResponse = await send("GET", contentPath, viewerCookie);
        expect(viewerResponse.status).toBe(302);
        expect(viewerResponse.headers.get("cache-control")).toContain("private");
        expect((await send("GET", contentPath, adminCookie)).status).toBe(302);
        expect((await send("GET", contentPath, otherCookie)).status).toBe(404);
      }

      const genericAssets = `/floors/${sceneFloor.id}/assets`;
      expect((await send("GET", genericAssets)).status).toBe(401);
      for (const session of [viewerCookie, adminCookie]) {
        const response = await send("GET", genericAssets, session);
        expect(response.status).toBe(200);
        const assets = await response.json() as Array<{ id: string; kind: string }>;
        expect(assets).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ id: builtScene.manifest.manifestAssetId }),
          expect.objectContaining({ id: tile.assetId })
        ]));
        expect(assets.some(asset => asset.kind === "cad_manifest" || asset.kind === "cad_tile")).toBe(false);
      }
      for (const assetId of [builtScene.manifest.manifestAssetId, tile.assetId]) {
        const genericContent = `${genericAssets}/${assetId}/content`;
        expect((await send("GET", genericContent)).status).toBe(401);
        expect((await send("GET", genericContent, viewerCookie)).status).toBe(404);
        expect((await send("GET", genericContent, adminCookie)).status).toBe(404);
        expect((await send("GET", genericContent, otherCookie)).status).toBe(404);
      }

      const legacyRegions = await send(
        "GET",
        `/floors/${sceneFloor.id}/import-jobs/${sceneJob.id}/regions`,
        adminCookie
      );
      expect(legacyRegions.status).toBe(409);

      const legacyApply = await send(
        "POST",
        `/floors/${sceneFloor.id}/import-jobs/${sceneJob.id}/apply`,
        adminCookie,
        {
          expectedRevision: 6,
          leaseToken: "http-legacy-lease",
          leaseFence: 12,
          candidateIds: [],
          confirmMapReset: true
        }
      );
      expect(legacyApply.status).toBe(409);
      expect(JSON.stringify(await legacyApply.json())).toMatch(/re-import required/i);
      await expect(prisma.floor.findUniqueOrThrow({ where: { id: sceneFloor.id } }))
        .resolves.toMatchObject({ mapRevision: 6 });
      await expect(prisma.floorMapObject.findUnique({ where: { id: sceneMapObject.id } }))
        .resolves.toMatchObject({ id: sceneMapObject.id });
      await expect(prisma.fixture.findUnique({ where: { id: sceneFixture.id } }))
        .resolves.toMatchObject({ id: sceneFixture.id, placementStatus: "placed", x: 40, y: 50 });
      await expect(prisma.floorLightSlot.findUnique({ where: { id: sceneSlot.id } }))
        .resolves.toMatchObject({ id: sceneSlot.id, assignedFixtureId: sceneFixture.id });
      await expect(prisma.floorImportCandidate.findUnique({ where: { id: sceneCandidate.id } }))
        .resolves.toMatchObject({ id: sceneCandidate.id, reviewStatus: "pending", reviewedAt: null });
      await expect(prisma.floorImportJob.findUniqueOrThrow({ where: { id: sceneJob.id } }))
        .resolves.toMatchObject({ status: "review_required", excludedRegionPrimitiveCount: null });
      await expect(prisma.floorMapRevision.count({ where: { floorId: sceneFloor.id } })).resolves.toBe(0);

      storage.verifyCadSceneObject.mockRejectedValueOnce(new Error("corrupt tile"));
      expect((await send("GET", tileContent, viewerCookie)).status).toBe(503);
      expect((await send("GET", `${genericAssets}/${tile.assetId}/content`, viewerCookie)).status).toBe(404);

      const raceFloor = await prisma.floor.create({ data: { siteId, name: "CAD race floor", level: 2 } });
      const raceSourceId = randomUUID();
      await prisma.floorAsset.create({ data: {
        id: raceSourceId, floorId: raceFloor.id, kind: "original", status: "ready",
        objectKey: `floors/${raceFloor.id}/${raceSourceId}.dxf`, mimeType: "application/dxf",
        sizeBytes: 128n, sha256: "c".repeat(64), readyAt: new Date()
      } });
      const revoker = new PrismaClient({ datasourceUrl: databaseUrl });
      let release!: () => void; let locked!: () => void;
      const releaseGate = new Promise<void>(resolve => { release = resolve; });
      const siteLocked = new Promise<void>(resolve => { locked = resolve; });
      const revoke = revoker.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`;
        locked();
        await releaseGate;
        await tx.site.update({ where: { id: siteId }, data: { adminUserId: replacement.id } });
      }, { timeout: 10_000 });
      await siteLocked;
      const raced = send("POST", `/floors/${raceFloor.id}/import-jobs`, adminCookie, {
        sourceAssetId: raceSourceId, sourceFormat: "dxf"
      });
      try {
        await waitForSiteLockWait(prisma, 3000);
      } finally { release(); }
      await revoke;
      expect((await raced).status).toBe(404);
      expect(await prisma.floorImportJob.count({ where: { floorId: raceFloor.id } })).toBe(0);
      await revoker.$disconnect();
    } finally { await app.close(); }
  }, 30_000);
});

async function waitForSiteLockWait(prisma: PrismaClient, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::integer AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%FROM "Site"%' AND query LIKE '%FOR UPDATE%'
    `;
    if (rows[0]?.waiting > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("floor import request did not reach the Site authorization lock");
}

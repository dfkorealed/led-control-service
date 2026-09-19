import { PrismaClient } from "@prisma/client";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MapDocumentStore } from "../floor-editor/map-document-store";
import { ObjectStorageService } from "../storage/object-storage.service";
import { buildCanonicalCadScene, readCanonicalElements } from "./cad-canonical-spool";
import { decodeCadSceneTile } from "./cad-scene-codec";
import { CadMapPreparationService } from "./cad-map-preparation.service";
import { FloorImportWorkerService } from "./floor-import-worker.service";
import { FloorImportAttemptCleanupService } from "./floor-import-attempt-cleanup.service";
import { ChildProcessCadCoreExecutor } from "./cad-core-executor";
import { FixedLightingDetectorRegistry } from "./lighting-detector-registry";
import { FloorAssetCleanupService } from "../floor-editor/floor-asset-cleanup.service";
import { MapDocumentAssetReferences } from "../floor-editor/map-document-asset-references";

const url = process.env.U4B_TEST_DATABASE_URL;
(url ? describe : describe.skip)("CAD canonical preparation with isolated PostgreSQL and MinIO", () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
  const s3 = new S3Client({ endpoint: process.env.U4B_MINIO_ENDPOINT, region: "us-east-1", forcePathStyle: true,
    credentials: { accessKeyId: process.env.U4B_MINIO_USER ?? "unused", secretAccessKey: process.env.U4B_MINIO_PASSWORD ?? "unused" } });
  const bucket = `u4b-${randomUUID()}`;
  const storage = new ObjectStorageService(s3, { bucket, publicBaseUrl: "" });
  const store = new MapDocumentStore(prisma as never, storage);
  const service = new CadMapPreparationService(prisma as never, storage, store);
  let floorId: string, siteId: string, directory: string;
  beforeAll(async () => {
    const target = new URL(url!);
    if (!/^\/led_u4b_test_[a-z0-9_]+$/.test(target.pathname) || target.hostname !== "127.0.0.1" || target.port === "5432") throw new Error("isolated DB required");
    const [identity] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    expect(`/${identity.name}`).toBe(target.pathname);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });
  beforeEach(async () => {
    const org = await prisma.organization.create({ data: { name: "u4b" } });
    const site = await prisma.site.create({ data: { name: "u4b", organizationId: org.id } }); siteId = site.id;
    floorId = (await prisma.floor.create({ data: { name: "u4b", level: 1, siteId } })).id;
    directory = await mkdtemp(join(tmpdir(), "u4b-persistence-"));
  });
  afterEach(async () => {
    // Legacy region-preview FK is immediate; delete children before their assets.
    await prisma.floorImportRegion.deleteMany({ where: { job: { floor: { siteId } } } });
    await prisma.site.delete({ where: { id: siteId } }); await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => { await prisma.$disconnect(); s3.destroy(); });
  async function fixture() {
    const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
    const jobId = randomUUID();
    const result = await buildCanonicalCadScene({ version: 1, bounds, blocks: [], entities: ["A", "B"].map(sourceEntityId => ({
      type: "line", layer: "WALL", sourceEntityId, start: { x: 0, y: 0, z: 0 }, end: { x: 1000, y: 1000, z: 0 }
    })) }, { regionId: "region-0123456789abcdef01234567", bounds, primitiveCount: 2, textCount: 0, lightCandidateCount: 0, area: 1e6 }, jobId, directory);
    for (const tile of result.built.tiles) await writeFile(join(directory, `${tile.descriptor.assetId}.bin`), tile.payload);
    const ref = await service.prepare(floorId, directory, result.canonical, result.built.manifest);
    return { ...result, ref, jobId };
  }
  async function job(jobId: string, generationId: string) {
    const source = await prisma.floorAsset.create({ data: { floorId, kind: "original", status: "ready", mimeType: "application/dxf",
      objectKey: `floors/${floorId}/${randomUUID()}.dxf`, sizeBytes: 1, sha256: "a".repeat(64), readyAt: new Date() } });
    return prisma.floorImportJob.create({ data: { id: jobId, floorId, sourceAssetId: source.id, sourceFormat: "dxf",
      preparedMapGenerationId: generationId } });
  }

  it("roundtrips every actual binary pick ID to stored full geometry and bounded display layer bindings", async () => {
    const { ref, built, canonical, jobId } = await fixture();
    const canonicalById = new Map();
    for await (const element of readCanonicalElements(directory, canonical)) canonicalById.set(element.id, element);
    const display = await store.readDisplayAssets(floorId, ref);
    expect(display!.manifest.assetId).not.toBe(ref.manifest.assetId);
    const envelope = await service.readDisplayManifest(floorId, ref);
    expect(envelope.scene.sha256).toBe(display!.manifest.sha256);
    expect(envelope.scene.byteSize).toBe(display!.manifest.byteSize);
    expect(envelope.displayLayerBindings).toEqual([{ layerName: "WALL", layerId: [...canonicalById.values()][0].layerId }]);
    for (const tile of built.tiles) for (const pick of decodeCadSceneTile(tile.payload, tile.descriptor)) {
      expect(await store.getElement(floorId, ref, pick.elementId)).toEqual(canonicalById.get(pick.elementId));
    }
    expect(new Set((await prisma.floorAsset.findMany({ where: { floorId, kind: { in: ["map_display_manifest", "map_display_tile"] } } })).map(a => a.kind)))
      .toEqual(new Set(["map_display_manifest", "map_display_tile"]));
    await job(jobId, ref.generationId);
    expect(await service.readPrepared(floorId, jobId)).toEqual(ref);
    expect((await prisma.floor.findUniqueOrThrow({ where: { id: floorId } })).mapRevision).toBe(0);
    expect(await prisma.floorMapDocument.count({ where: { floorId } })).toBe(0);
  });

  it("protects job-pinned generations past expiry and explicit discard, then reaps after cancellation", async () => {
    const { ref, jobId } = await fixture();
    await job(jobId, ref.generationId);
    const rendered = await prisma.floorAsset.create({ data: { floorId, kind: "rendered", status: "ready", mimeType: "image/svg+xml",
      objectKey: `floors/${floorId}/${randomUUID()}.svg`, sizeBytes: 1, sha256: "b".repeat(64), readyAt: new Date() } });
    await prisma.floorImportJob.update({ where: { id: jobId }, data: { status: "review_required", stage: "review_required", progressPercent: 100,
      startedAt: new Date(), reviewRequiredAt: new Date(), renderedAssetId: rendered.id, detectorProfileId: "generic-lighting-v1",
      detectorProfileVersion: "legacy-unknown", detectorProfileDigest: "0".repeat(64) } });
    await prisma.floorMapGeneration.update({ where: { id: ref.generationId }, data: { expiresAt: new Date(0) } });
    expect(await store.reapExpiredPreparations()).toBe(0);
    await expect(store.discardPreparedGeneration(floorId, ref.generationId)).rejects.toThrow(/referenced/);
    const cleanup = new FloorAssetCleanupService(prisma as never, storage, new MapDocumentAssetReferences(prisma as never));
    await cleanup.processPending(new Date(Date.now() + 2 * 24 * 60 * 60_000));
    expect(await service.readDisplayManifest(floorId, ref)).toMatchObject({ displayLayerBindings: expect.any(Array) });
    await prisma.floorImportJob.update({ where: { id: jobId }, data: { status: "cancelled", stage: "cancelled", cancelledAt: new Date() } });
    expect((await prisma.floorImportJob.findUniqueOrThrow({ where: { id: jobId } })).preparedMapGenerationId).toBeNull();
    expect(await store.reapExpiredPreparations()).toBe(1);
    expect(await prisma.floorMapDisplayAsset.count({ where: { generationId: ref.generationId } })).toBe(0);
  });

  it.each(["success", "cancelled", "lease replaced", "failed"])("runs real zero-candidate child/worker/MinIO with %s fencing", async mode => {
    const payload = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nLINE\n5\nA\n8\nWALL\n10\n0\n20\n0\n11\n1000\n21\n1000\n0\nENDSEC\n0\nEOF\n");
    const sourceId = randomUUID(), sourcePath = join(directory, "source.dxf"), key = `floors/${floorId}/${sourceId}.dxf`;
    const hash = createHash("sha256").update(payload).digest("hex");
    await writeFile(sourcePath, payload);
    await storage.putCadSceneObjectFile(key, sourcePath, { sizeBytes: payload.length, sha256: hash, contentType: "application/dxf" });
    await prisma.floorAsset.create({ data: { id: sourceId, floorId, kind: "original", status: "ready", objectKey: key,
      mimeType: "application/dxf", sizeBytes: payload.length, sha256: hash, readyAt: new Date() } });
    const record = await prisma.floorImportJob.create({ data: { floorId, sourceAssetId: sourceId, sourceFormat: "dxf" } });
    const options = { tempRoot: directory, pollIntervalMs: 1000, enabled: false };
    let lateGenerationId: string | undefined;
    const originalPrepare = service.prepare.bind(service);
    const prepareSpy = jest.spyOn(service, "prepare").mockImplementation(async (...args) => {
      const ref = await originalPrepare(...args); lateGenerationId = ref.generationId;
      if (mode === "cancelled") await prisma.floorImportJob.update({ where: { id: record.id },
        data: { status: "cancelled", stage: "cancelled", leaseOwner: null, leaseExpiresAt: null, cancelledAt: new Date() } });
      if (mode === "failed") await prisma.floorImportJob.update({ where: { id: record.id },
        data: { status: "failed", stage: "failed", leaseOwner: null, leaseExpiresAt: null, failedAt: new Date(), failureCode: "TEST_FAILURE", failureMessage: "test" } });
      if (mode === "lease replaced") await prisma.floorImportJob.update({ where: { id: record.id },
        data: { leaseOwner: "successor", attemptCount: 2 } });
      return ref;
    });
    const worker = new FloorImportWorkerService(prisma as never, storage, { convert: async () => { throw new Error("DXF must bypass converter"); } },
      new FixedLightingDetectorRegistry(), new ChildProcessCadCoreExecutor({ entryPath: resolve(process.cwd(),
        "../../.superpowers/sdd/2026-09-18-cad-native-map-rendering/u4b-child-runtime/floor-import/cad-core-child.js") }), options,
      new FloorImportAttemptCleanupService(prisma as never, storage, options), service);
    try {
      expect(await worker.runOnce()).toBe(true);
      const result = await prisma.floorImportJob.findUniqueOrThrow({ where: { id: record.id } });
      if (mode !== "success") {
        expect(result.preparedMapGenerationId).toBeNull();
        expect(result.status).toBe(mode === "lease replaced" ? "processing" : mode);
        if (mode === "lease replaced") expect(result).toMatchObject({ leaseOwner: "successor", attemptCount: 2 });
        expect((await prisma.floorMapGeneration.findUniqueOrThrow({ where: { id: lateGenerationId } })).status).toBe("failed");
        expect(await prisma.floorMapDisplayAsset.count({ where: { generationId: lateGenerationId } })).toBe(0);
        expect(await prisma.floorMapDocument.count({ where: { floorId } })).toBe(0);
        return;
      }
      expect(result).toMatchObject({ status: "review_required", preparedMapGenerationId: expect.any(String), attemptCount: 1 });
      expect(await prisma.floorImportCandidate.count({ where: { jobId: record.id } })).toBe(0);
      const ref = await service.readPrepared(floorId, record.id);
      const display = await service.readDisplayManifest(floorId, ref);
      expect(ref.elementCount).toBe(1);
      for (const tile of display.scene.tiles) {
        const asset = await prisma.floorAsset.findUniqueOrThrow({ where: { id: tile.assetId } });
        const path = join(directory, `${tile.assetId}.bin`);
        await storage.downloadFloorAssetToFile(asset.objectKey, path, { maxBytes: 16 * 1024 * 1024,
          expectedBytes: tile.byteSize, expectedSha256: tile.sha256, expectedMimeType: "application/octet-stream" });
        const { readFile } = await import("node:fs/promises");
        for (const pick of decodeCadSceneTile(await readFile(path), tile)) expect(await store.getElement(floorId, ref, pick.elementId)).not.toBeNull();
      }
    } finally { prepareSpy.mockRestore(); await worker.onModuleDestroy(); }
  });

  it("rejects cross-floor pointers, corrupt spool, aborted preparation and a stale attempt pin", async () => {
    const { ref, jobId, canonical, built } = await fixture();
    const other = await prisma.floor.create({ data: { siteId, name: "other", level: 2 } });
    const originalFloor = floorId; floorId = other.id;
    await expect(job(jobId, ref.generationId)).rejects.toThrow(); floorId = originalFloor;
    await expect(service.prepare(floorId, directory, { ...canonical, elements: { ...canonical.elements, sha256: "0".repeat(64) } }, built.manifest)).rejects.toThrow(/integrity/);
    await expect(service.prepare(floorId, directory, canonical, built.manifest, AbortSignal.abort())).rejects.toThrow(/abort/i);
    await job(jobId, ref.generationId);
    await expect(prisma.$transaction(tx => service.pinPrepared(tx, { id: jobId, floorId, attemptCount: 99, leaseOwner: "late" }, ref)))
      .rejects.toThrow(/LEASE_LOST/);
    expect(await prisma.floorMapGeneration.count({ where: { floorId, status: "failed" } })).toBeGreaterThan(0);
  });

  it("rechecks a job pin created after reaper candidate selection under the Floor lock", async () => {
    const { ref, jobId } = await fixture();
    await prisma.floorMapGeneration.update({ where: { id: ref.generationId }, data: { expiresAt: new Date(0) } });
    const select = prisma.floorMapGeneration.findMany.bind(prisma.floorMapGeneration);
    const delegate = prisma.floorMapGeneration as unknown as {
      findMany: (...args: Parameters<typeof prisma.floorMapGeneration.findMany>) => Promise<unknown[]>
    };
    const raced = jest.spyOn(delegate, "findMany").mockImplementationOnce(async args => {
      const candidates = await select(args);
      await job(jobId, ref.generationId);
      return candidates;
    });
    try {
      expect(await store.reapExpiredPreparations()).toBe(0);
      expect((await prisma.floorMapGeneration.findUniqueOrThrow({ where: { id: ref.generationId } })).status).toBe("prepared");
    } finally { raced.mockRestore(); }
  });
});

import {
  CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command,
  PutObjectCommand, S3Client
} from "@aws-sdk/client-s3";
import { mapDisplayManifestSchema, type MapElement } from "@led-control/shared";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { AuditService } from "../audit/audit.service";
import { SiteAccessService } from "../access/site-access.service";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { hashEditorLeaseToken } from "../floor-editor/editor-lease-token";
import { FloorEditorService } from "../floor-editor/floor-editor.service";
import { hashFloorEditorSnapshot, parseMapDocumentSnapshot } from "../floor-editor/floor-editor-snapshot";
import { MapDocumentReader } from "../floor-editor/map-document-reader";
import { MapDocumentRevisionData } from "../floor-editor/map-document-revision-data";
import { MapDocumentStore } from "../floor-editor/map-document-store";
import { FloorMapService } from "../floor-map/floor-map.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { ArgvCadConverter, type CadConverter } from "./cad-converter";
import { ChildProcessCadCoreExecutor, type CadCoreExecutor, type CadCoreResult } from "./cad-core-executor";
import { readCanonicalElements, readCanonicalMetadata } from "./cad-canonical-spool";
import { CadMapPreparationService } from "./cad-map-preparation.service";
import { decodeMapDisplayTile } from "./cad-scene-codec";
import { FloorImportAttemptCleanupService } from "./floor-import-attempt-cleanup.service";
import { FloorImportWorkerService } from "./floor-import-worker.service";
import { FloorImportService } from "./floor-import.service";
import { FixedLightingDetectorRegistry } from "./lighting-detector-registry";

const singleSample = process.env.CAD_SAMPLE_DWG_PATH;
const sampleList = process.env.CAD_SAMPLE_DWG_PATHS_JSON;
const converterPath = process.env.CAD_SAMPLE_CONVERTER_PATH;
const converterArgvJson = process.env.CAD_SAMPLE_CONVERTER_ARGV_JSON;
const enabled = [singleSample, sampleList, converterPath, converterArgvJson].some(value => value !== undefined);
if (enabled && (Boolean(singleSample) === Boolean(sampleList) || !converterPath || !converterArgvJson ||
    process.env.RUN_OBJECT_STORAGE_INTEGRATION !== "true")) {
  throw new Error("CAD sample integration requires exactly one sample path/list, converter path/argv and RUN_OBJECT_STORAGE_INTEGRATION=true");
}
const samples: unknown = sampleList ? JSON.parse(sampleList) : singleSample ? [singleSample] : [];
if (!Array.isArray(samples) || samples.some(value => typeof value !== "string" || !value.trim()) || enabled && samples.length === 0) {
  throw new Error("CAD_SAMPLE_DWG_PATHS_JSON must be a non-empty JSON string array");
}

(enabled ? describe : describe.skip)("provided CAD samples native worker/storage/DB/API pipeline", () => {
  jest.setTimeout(360_000);

  // Register a skipped test without contacting external services when opt-in inputs are absent.
  it.each((samples.length ? samples : [""]) as string[])("imports a common map from %s", async sample => {
    const cluster = await disposablePostgres();
    let prisma: PrismaClient | undefined;
    let worker: FloorImportWorkerService | undefined;
    let cleanup: FloorImportAttemptCleanupService | undefined;
    const endpoint = process.env.OBJECT_STORAGE_ENDPOINT ?? "http://localhost:9000";
    // This bucket is test-owned, including partial uploads left by a failed worker attempt.
    const bucket = `cad-native-test-${randomUUID()}`;
    const client = new S3Client({
      region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1", endpoint, forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY ?? "led-floor-assets",
        secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY ?? "change-this-local-secret"
      }
    });
    let bucketCreated = false;
    const metrics: Record<string, unknown> = { sample: basename(sample).normalize("NFC"), passed: false };
    const conversions: Array<{ elapsedMs: number; outputBytes: number }> = [];
    const coreRuns: Array<{ elapsedMs: number; error?: string; observedMaxRssBytes?: number }> = [];
    const started = performance.now();
    try {
      const databaseUrl = cluster.database();
      const deployed = cluster.deploy(databaseUrl);
      if (deployed.status !== 0) throw new Error("CAD sample disposable PostgreSQL migration failed");
      prisma = new PrismaClient({ datasourceUrl: databaseUrl });
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      bucketCreated = true;
      const storage = new ObjectStorageService(client, { bucket, publicBaseUrl: `${endpoint}/${bucket}` });
      const organizationId = randomUUID(); const userId = randomUUID(); const siteId = randomUUID(); const floorId = randomUUID();
      const sourceAssetId = randomUUID(); const sourceKey = `floors/${floorId}/sample.dwg`;
      const sourceStat = await stat(sample);
      const sourceSha256 = await hashFile(sample);
      const registry = new FixedLightingDetectorRegistry();
      const profileId = registry.resolve({ sourceSha256, siteId });
      Object.assign(metrics, { sourceSha256, sourceBytes: sourceStat.size, profileId });
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: sourceKey, Body: createReadStream(sample), ContentType: "application/dwg",
        ContentLength: sourceStat.size, ChecksumSHA256: Buffer.from(sourceSha256, "hex").toString("base64")
      }));
      await prisma.organization.create({ data: { id: organizationId, name: "CAD sample", type: "customer" } });
      await prisma.user.create({ data: {
        id: userId, organizationId, loginId: `sample-${userId}`, name: "CAD Sample", passwordHash: "unused", role: "admin"
      } });
      await prisma.site.create({ data: { id: siteId, organizationId, adminUserId: userId, name: "CAD sample", timeZone: "UTC" } });
      await prisma.floor.create({ data: { id: floorId, siteId, name: "CAD sample", level: 1 } });
      await prisma.floorAsset.create({ data: {
        id: sourceAssetId, floorId, kind: "original", status: "ready", objectKey: sourceKey,
        mimeType: "application/dwg", sizeBytes: BigInt(sourceStat.size), sha256: sourceSha256, readyAt: new Date()
      } });
      const user = {
        id: userId, organizationId, organizationType: "customer" as const, loginId: "sample", name: "CAD Sample",
        role: "admin" as const, status: "active" as const, mustChangePassword: false
      };
      const access = new SiteAccessService(prisma as never);
      const store = new MapDocumentStore(prisma as never, storage);
      const preparation = new CadMapPreparationService(prisma as never, storage, store);
      // Current imports publish common-map assets, not the retired CAD-only ledger.
      const options = { tempRoot: "/tmp", pollIntervalMs: 1000, enabled: false, legacyDisplayCompatibility: false };
      const imports = new FloorImportService(prisma as never, access, new AuditService(prisma as never),
        // Imports require an available worker; the worker below is advanced by runOnce,
        // without starting its polling timer or changing the production admission gate.
        storage, undefined, { ...options, enabled: true }, preparation, store);
      const reader = new MapDocumentReader(prisma as never, access, storage, store);
      const hardwareBefore = {
        fixtures: await prisma.fixture.count(), meshNodes: await prisma.meshNode.count()
      };
      const created = await imports.create(user, floorId, { sourceAssetId, sourceFormat: "dwg" });
      expect(created.detectorProfileId).toBe(profileId);
      const converterArgv: unknown = JSON.parse(converterArgvJson!);
      if (!Array.isArray(converterArgv) || converterArgv.some(argument => typeof argument !== "string")) {
        throw new Error("CAD_SAMPLE_CONVERTER_ARGV_JSON must be a JSON string array");
      }
      const argvConverter = new ArgvCadConverter({
        executable: converterPath!, argv: converterArgv as string[], timeoutMs: 60_000,
        maxOutputBytes: 256 * 1024 * 1024,
        execution: process.platform === "linux" ? { mode: "linux-resource-limited" }
          : { mode: "macos-development-polling", acknowledgeNonProductionRisk: true }
      });
      const converter: CadConverter = { convert: async request => {
        const start = performance.now();
        const result = await argvConverter.convert(request);
        conversions.push({ elapsedMs: performance.now() - start, outputBytes: result.outputBytes });
        return result;
      } };
      const childCore = new ChildProcessCadCoreExecutor({
        entryPath: resolve(process.cwd(), "dist/src/floor-import/cad-core-child.js"), timeoutMs: 60_000
      });
      let coreResult: CadCoreResult | undefined;
      let expectedElements: MapElement[] = [];
      let expectedMetadata: Awaited<ReturnType<typeof readCanonicalMetadata>> | undefined;
      const core: CadCoreExecutor = { execute: async request => {
        const start = performance.now();
        try {
          coreResult = await childCore.execute(request);
          coreRuns.push({ elapsedMs: performance.now() - start, observedMaxRssBytes: coreResult.observedMaxRssBytes });
          if (coreResult.canonical) {
            // Capture actual child output before the worker removes its attempt spool.
            // These reads validate its hashes; they do not replace preparation/storage.
            expectedElements = [];
            expectedMetadata = await readCanonicalMetadata(request.artifactDirectory!, coreResult.canonical);
            for await (const element of readCanonicalElements(request.artifactDirectory!, coreResult.canonical)) {
              expectedElements.push(element);
            }
            expect(expectedElements).toHaveLength(coreResult.canonical.elementCount);
          }
          return coreResult;
        } catch (error) {
          coreRuns.push({ elapsedMs: performance.now() - start, error: (error as Error).message });
          throw error;
        }
      } };
      cleanup = new FloorImportAttemptCleanupService(prisma as never, storage, options);
      worker = new FloorImportWorkerService(prisma as never, storage, converter, registry, core,
        options, cleanup, preparation);
      const runWorker = async () => {
        expect(await worker!.runOnce()).toBe(true);
        const job = await imports.get(user, floorId, created.jobId);
        metrics.jobStatus = job.status;
        metrics.jobStage = job.stage;
        process.stdout.write(`CAD_NATIVE_PROGRESS ${JSON.stringify({ sample: metrics.sample,
          stage: job.stage, elapsedMs: performance.now() - started })}\n`);
        // Any retryable failure requeues the job. Stop here so region API errors
        // cannot obscure a failed storage/core attempt in the sample report.
        const coreError = coreRuns.at(-1)?.error;
        if (coreError || !["region_selection_required", "review_required"].includes(job.status)) {
          throw new Error(`CAD sample worker failed: ${coreError ?? `${job.status}/${job.stage}`}`);
        }
        return job;
      };
      let job = await runWorker();
      expect(coreResult).toBeDefined();
      const detected = coreResult!;
      Object.assign(metrics, {
        modelEntityCount: detected.modelEntityCount, blockCount: detected.blockCount,
        regions: detected.regions, candidateCount: detected.candidates.length,
        excludedRegionPrimitiveCount: detected.excludedRegionPrimitiveCount,
        excludedEntityCount: detected.rendered.excludedEntityCount ?? 0,
        unsupportedEntityCounts: detected.rendered.unsupportedEntityCounts ?? {}
      });
      const previewHead = jest.spyOn(storage, "readCadRegionPreviewMetadata");
      const listStarted = performance.now();
      const regions = await imports.listRegions(user, floorId, created.jobId);
      Object.assign(metrics, { regionListElapsedMs: performance.now() - listStarted,
        regionListBytes: Buffer.byteLength(JSON.stringify(regions)), regionListStorageHeads: previewHead.mock.calls.length });
      expect(previewHead).not.toHaveBeenCalled();
      expect(regions.regions).toHaveLength(detected.regions.length);
      expect(regions.excludedRegionPrimitiveCount).toBe(detected.excludedRegionPrimitiveCount);
      const regionsById = new Map(regions.regions.map(region => [region.regionId, region]));
      for (const region of detected.regions) expect(regionsById.get(region.regionId)).toMatchObject(region);
      previewHead.mockRestore();
      const previews = [];
      for (const preview of detected.regionPreviews ?? []) {
        expect(regionsById.get(preview.regionId)?.preview).toEqual({ assetId: preview.assetId,
          width: preview.viewport.width, height: preview.viewport.height, byteSize: preview.sizeBytes, sha256: preview.sha256 });
        const asset = await prisma.floorAsset.findUniqueOrThrow({ where: { id: preview.assetId } });
        expect(asset).toMatchObject({ floorId, kind: "cad_region_preview", status: "ready",
          contentEncoding: "gzip", sizeBytes: BigInt(preview.sizeBytes), sha256: preview.sha256 });
        const region = regionsById.get(preview.regionId)!;
        expect(await storage.readCadRegionPreviewMetadata(asset.objectKey, { sizeBytes: preview.sizeBytes,
          sha256: preview.sha256, regionId: preview.regionId, bounds: region.bounds })).toEqual({
          ...preview.viewport, textCount: region.textCount, lightCandidateCount: region.lightCandidateCount, area: region.area
        });
        // fetch() decodes Content-Encoding gzip; hash the stored object bytes instead.
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: asset.objectKey }));
        expect(object.Body).toBeDefined();
        const bytes = await object.Body!.transformToByteArray();
        expect(bytes.length).toBe(preview.sizeBytes);
        expect(sha256(bytes)).toBe(preview.sha256);
        previews.push({ regionId: preview.regionId, byteSize: bytes.length, sha256: sha256(bytes), viewport: preview.viewport });
      }
      expect(previews).toHaveLength(detected.regions.length);
      metrics.previews = previews;
      if (regions.selectionStatus === "selection_required") {
        expect(job.status).toBe("region_selection_required");
        // Prefer the most populated lighting region with deterministic, filename-independent ties.
        const selected = [...regions.regions].sort((a, b) => b.lightCandidateCount - a.lightCandidateCount ||
          b.primitiveCount - a.primitiveCount || a.regionId.localeCompare(b.regionId))[0];
        metrics.selectedRegionId = selected.regionId;
        await imports.selectRegion(user, floorId, created.jobId, { regionId: selected.regionId });
        job = await runWorker();
      }
      expect(job.status).toBe("review_required");
      const finalCore = coreResult!;
      expect(finalCore.canonical).toBeDefined();
      expect(expectedMetadata).toBeDefined();
      const candidates = await imports.listCandidates(user, floorId, created.jobId);
      expect(candidates.candidates).toHaveLength(finalCore.selectedCandidates!.length);
      const acceptedCandidateIds = candidates.candidates.map(candidate => candidate.id);
      const candidatesById = new Map(candidates.candidates.map(candidate => [candidate.id, candidate]));
      expect(finalCore.candidateTransformMatch.matchedCount).toBe(finalCore.candidates.length);
      expect(finalCore.candidateTransformMatch.maxDeltaPx).toBeLessThanOrEqual(0.01);
      const prepared = await preparation.readPrepared(floorId, created.jobId);
      expect(await reader.getDocument(user, floorId, created.jobId)).toEqual(prepared);
      expect(prepared.elementCount).toBe(expectedElements.length);
      const canonicalManifest = await store.readManifest(floorId, prepared);
      expect(canonicalManifest).toMatchObject({ elementCount: expectedElements.length,
        groups: expectedMetadata!.groups, layers: expectedMetadata!.layers,
        width: expectedMetadata!.width, height: expectedMetadata!.height, gridSize: expectedMetadata!.gridSize });
      const persistedElements: MapElement[] = [];
      for await (const element of store.iterateGeneration(floorId, prepared)) persistedElements.push(element);
      expect(persistedElements).toEqual(expectedElements);
      expect(new Set(persistedElements.map(element => element.id)).size).toBe(prepared.elementCount);
      const primitiveTypes: Record<string, number> = {};
      for (const element of persistedElements) primitiveTypes[element.type] = (primitiveTypes[element.type] ?? 0) + 1;
      const texts = persistedElements.filter(element => element.type === "text");
      expect(texts).toEqual(expectedElements.filter(element => element.type === "text"));
      const queryManifest = await reader.getManifest(user, floorId, prepared, created.jobId);
      const manifest = mapDisplayManifestSchema.parse(queryManifest.display);
      expect(queryManifest.canonical).toEqual(prepared.manifest);
      expect(queryManifest.displayLayerBindings).toEqual(expectedMetadata!.displayLayerBindings);
      expect(queryManifest.layers).toEqual(canonicalManifest.layers);
      expect(queryManifest.groups).toEqual(canonicalManifest.groups);
      const displayEnvelope = await preparation.readDisplayManifest(floorId, prepared);
      expect(displayEnvelope.scene).toEqual(manifest);
      expect(displayEnvelope.unsupportedEntityCounts).toEqual(expectedMetadata!.unsupportedEntityCounts);
      expect(displayEnvelope.unconvertedEntityCounts).toEqual(expectedMetadata!.unconvertedEntityCounts);
      const manifestAsset = await prisma.floorAsset.findUniqueOrThrow({ where: { id: manifest.manifestAssetId } });
      expect(manifestAsset).toMatchObject({ floorId, kind: "map_display_manifest", status: "ready" });
      const rawManifest = await download(await storage.createFloorAssetDownloadUrl(manifestAsset.objectKey));
      expect(manifest.byteSize).toBe(rawManifest.length);
      expect(manifest.sha256).toBe(sha256(rawManifest));
      const uniqueElements = new Set<string>();
      const canonicalIds = new Set(persistedElements.map(element => element.id));
      let tileBytes = 0;
      let tileFragments = 0;
      for (const tile of manifest.tiles) {
        const payload = await reader.getTile(user, floorId, prepared, tile.assetId, created.jobId);
        const primitives = decodeMapDisplayTile(payload, tile);
        expect(primitives).toHaveLength(tile.primitiveCount);
        tileBytes += payload.length;
        tileFragments += primitives.length;
        for (const primitive of primitives) {
          expect(canonicalIds.has(primitive.elementId)).toBe(true);
          uniqueElements.add(primitive.elementId);
        }
      }
      expect(manifest.tileCount).toBe(manifest.tiles.length);
      expect(uniqueElements).toEqual(canonicalIds);
      Object.assign(metrics, {
        commonElementCount: persistedElements.length, textCount: texts.length,
        texts: texts.map(element => ({ id: element.id, text: element.geometry.text })),
        unconvertedEntityCounts: expectedMetadata!.unconvertedEntityCounts,
        nativePrimitiveCount: manifest.primitiveCount, uniqueTileElementCount: uniqueElements.size,
        primitiveTypes, tileFragments, tileBytes, tileCount: manifest.tileCount,
        manifestBytes: rawManifest.length, mapSize: { width: manifest.width, height: manifest.height }
      });
      const leaseToken = randomUUID();
      await prisma.floor.update({ where: { id: floorId }, data: {
        editorLeaseFence: 1, editorLeaseTokenHash: hashEditorLeaseToken(leaseToken),
        editorLeaseHolderId: userId, editorLeaseHolderName: user.name,
        editorLeaseAcquiredAt: new Date(), editorLeaseExpiresAt: new Date(Date.now() + 60_000)
      } });
      const applied = await imports.apply(user, floorId, created.jobId, {
        expectedRevision: 0, leaseToken, leaseFence: 1, candidateIds: acceptedCandidateIds, confirmMapReset: true
      });
      expect(applied).toMatchObject({ status: "completed", revision: 1 });
      expect(await prisma.floorMapDocument.findUniqueOrThrow({ where: { floorId } })).toMatchObject({
        activeGenerationId: prepared.generationId, revision: prepared.revision
      });
      expect(await prisma.floorMapGeneration.findUniqueOrThrow({ where: { id: prepared.generationId } })).toMatchObject({
        status: "active", elementCount: persistedElements.length, manifestAssetId: prepared.manifest.assetId
      });
      expect(await prisma.floorCadScene.count({ where: { floorId } })).toBe(0);
      expect(await prisma.floorPlan.findUniqueOrThrow({ where: { floorId } })).toMatchObject({
        sourceType: "none", imageUrl: "", renderedImageUrl: null, width: prepared.width, height: prepared.height,
        gridSize: prepared.gridSize
      });
      // New instances force post-apply reads through the DB and object storage,
      // not the prepared reader's immutable cache or the child's temporary files.
      const reloadedStore = new MapDocumentStore(prisma as never, storage);
      const mapData = new MapDocumentRevisionData(prisma as never, storage, reloadedStore);
      const reloadedReader = new MapDocumentReader(prisma as never, access, storage, reloadedStore, mapData);
      const editor = new FloorEditorService(prisma as never, access, new AuditService(prisma as never),
        undefined, undefined, undefined, mapData);
      const maps = new FloorMapService(prisma as never, access, undefined, undefined, mapData);
      const editorState = await editor.getEditorState(floorId, user);
      const snapshot = await maps.getSnapshot(user, siteId, floorId);
      expect(editorState.floor.mapDocument).toEqual(prepared);
      expect(snapshot.mapDocument).toEqual(prepared);
      expect(editorState.floor.cadScene).toBeNull();
      expect(snapshot.cadScene).toBeNull();
      expect(snapshot.revision).toBe(1);
      const slots = await prisma.floorLightSlot.findMany({ where: { floorId }, orderBy: { id: "asc" } });
      expect(slots).toHaveLength(acceptedCandidateIds.length);
      expect(slots.map(slot => slot.sourceCandidateId).sort()).toEqual([...acceptedCandidateIds].sort());
      for (const slot of slots) {
        const candidate = candidatesById.get(slot.sourceCandidateId)!;
        expect(slot).toMatchObject({ sourceImportJobId: created.jobId, assignedFixtureId: null,
          x: candidate.x, y: candidate.y, rotation: candidate.rotation });
      }
      const publicSlots = slots.map(({ id, x, y, rotation, assignedFixtureId }) =>
        ({ id, x, y, rotation, assignedFixtureId }));
      expect(editorState.lightSlots).toEqual(publicSlots);
      const revision = await prisma.floorMapRevision.findUniqueOrThrow({
        where: { floorId_revision: { floorId, revision: 1 } }
      });
      const revisionSnapshot = parseMapDocumentSnapshot(revision.snapshot);
      expect(revisionSnapshot.document).toEqual(prepared);
      expect(revision.snapshotSha256).toBe(hashFloorEditorSnapshot(revisionSnapshot));
      expect(revisionSnapshot.lightSlots).toEqual(slots.map(slot => ({
        id: slot.id, x: slot.x, y: slot.y, rotation: slot.rotation, assignedFixtureId: null,
        sourceImportJobId: created.jobId, sourceCandidateId: slot.sourceCandidateId
      })));
      const hardwareAfter = {
        fixtures: await prisma.fixture.count(), meshNodes: await prisma.meshNode.count()
      };
      expect(hardwareAfter).toEqual(hardwareBefore);
      expect(editorState.fixtures).toHaveLength(0);
      // Read-only maps expose placed hardware, never unassigned CAD slots.
      expect(snapshot.fixtures).toEqual([]);
      const reviewed = await imports.listCandidates(user, floorId, created.jobId);
      expect(reviewed.candidates.every(candidate => candidate.reviewStatus === "accepted")).toBe(true);
      Object.assign(metrics, { acceptedCandidateCount: acceptedCandidateIds.length, lightSlotCount: slots.length,
        editorSlotPositionsVerified: true, revisionSlotPositionsVerified: true,
        hardwareBefore, hardwareAfter, readonlyMapFixtureCount: snapshot.fixtures!.length });
      expect(await reloadedReader.getDocument(user, floorId)).toEqual(prepared);
      const appliedManifest = await reloadedReader.getManifest(user, floorId, prepared);
      expect(appliedManifest).toEqual(queryManifest);
      const reloadedElements: MapElement[] = [];
      for await (const element of reloadedStore.iterateGeneration(floorId, prepared)) reloadedElements.push(element);
      expect(reloadedElements).toEqual(persistedElements);
      // Public selection reads use the production 128-ID bound and return full
      // canonical geometry/text, never decoded display-tile approximations.
      for (let offset = 0; offset < persistedElements.length; offset += 128) {
        const batch = persistedElements.slice(offset, offset + 128);
        expect(await reloadedReader.getElements(user, floorId, prepared, { ids: batch.map(element => element.id) })).toEqual(batch);
      }
      expect(await imports.get(user, floorId, created.jobId)).toMatchObject({ status: "completed", stage: "completed" });
      metrics.postApplyEditorMapManifestVerified = true;
      metrics.postApplyCanonicalElementsVerified = true;
      const unsupportedEntityCounts = detected.rendered.unsupportedEntityCounts ?? {};
      const unsupportedTotal = Object.values(unsupportedEntityCounts).reduce((sum, count) => sum + count, 0);
      Object.assign(metrics, {
        passed: true, appliedStatus: applied.status, modelEntityCount: detected.modelEntityCount,
        blockCount: detected.blockCount, regions: detected.regions,
        candidateCount: detected.candidates.length, selectedCandidateCount: finalCore.selectedCandidates!.length,
        excludedRegionPrimitiveCount: detected.excludedRegionPrimitiveCount,
        excludedEntityCount: detected.rendered.excludedEntityCount ?? 0, unsupportedEntityCounts, unsupportedTotal,
        unsupportedOccurrenceRatio: unsupportedTotal / Math.max(1, unsupportedTotal + detected.rendered.renderedOccurrences),
        nativePrimitiveCount: manifest.primitiveCount, uniqueTileElementCount: uniqueElements.size,
        primitiveTypes, tileFragments, tileBytes, tileCount: manifest.tileCount,
        manifestBytes: rawManifest.length, mapSize: { width: manifest.width, height: manifest.height },
        candidateTransformMatch: detected.candidateTransformMatch
      });
    } catch (error) {
      metrics.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      Object.assign(metrics, { conversions, coreRuns, elapsedMs: performance.now() - started });
      process.stdout.write(`CAD_NATIVE_SAMPLE ${JSON.stringify(metrics)}\n`);
      try {
        await worker?.onModuleDestroy();
        await cleanup?.onModuleDestroy();
        if (bucketCreated) {
          // Delete only this newly created bucket, including uncommitted CAD asset objects.
          for (;;) {
            const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
            if (!objects.Contents?.length) break;
            const deleted = await client.send(new DeleteObjectsCommand({ Bucket: bucket,
              Delete: { Objects: objects.Contents.map(object => ({ Key: object.Key! })) } }));
            if (deleted.Errors?.length) throw new Error("CAD sample bucket cleanup failed");
          }
          await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        }
      } finally {
        client.destroy();
        try { await prisma?.$disconnect(); } finally { cluster.stop(); }
      }
    }
  });
});

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

async function download(url: string) {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

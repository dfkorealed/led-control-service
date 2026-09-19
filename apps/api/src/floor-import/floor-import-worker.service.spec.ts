import { createHash, randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCanonicalCadScene, readCanonicalElements } from "./cad-canonical-spool";
import { cadRegionPreviewPersistenceIdentity, cadScenePersistenceIdentity } from "./cad-scene-persistence";
import { FloorImportWorkerService } from "./floor-import-worker.service";

jest.mock("node:fs/promises", () => ({
  ...jest.requireActual("node:fs/promises"),
  statfs: jest.fn(jest.requireActual("node:fs/promises").statfs)
}));

function claimedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(), floorId: randomUUID(), sourceAssetId: randomUUID(), renderedAssetId: null,
    sourceFormat: "dxf", status: "processing", stage: "downloading", progressPercent: 1,
    attemptCount: 1, parserVersion: null, detectorVersion: null, leaseOwner: "owner",
    detectorProfileId: "generic-lighting-v1", detectorProfileVersion: null, detectorProfileDigest: null,
    leaseExpiresAt: new Date(Date.now() + 30_000), failureCode: null, failureMessage: null,
    startedAt: new Date(), reviewRequiredAt: null, appliedAt: null, completedAt: null,
    failedAt: null, cancelledAt: null, createdAt: new Date(), updatedAt: new Date(), ...overrides
  } as any;
}

function genericRegistry() {
  return {
    resolve: jest.fn().mockReturnValue("generic-lighting-v1"),
    assertBinding: jest.fn(),
    get: jest.fn().mockReturnValue({
      profileId: "generic-lighting-v1", profileVersion: "test/1", profileDigest: "b".repeat(64)
    })
  } as any;
}

async function writeNativeArtifacts(
  jobId: string,
  artifactDirectory: string,
  lightCandidateCount: number
) {
  const region = {
    regionId: "region-0123456789abcdef01234567",
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    primitiveCount: Math.max(1, lightCandidateCount),
    textCount: 0,
    lightCandidateCount,
    area: 100
  };
  const identity = cadScenePersistenceIdentity(jobId, region.regionId);
  const previewIdentity = cadRegionPreviewPersistenceIdentity(jobId, region.regionId);
  const { built, canonical } = await buildCanonicalCadScene({
    version: 1,
    bounds: region.bounds,
    blocks: [],
    entities: [{
      type: "line",
      sourceEntityId: "unit-line",
      layer: "WALL",
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 10, z: 0 }
    }]
  }, region, jobId, artifactDirectory);
  const preview = Buffer.from("preview");
  const previewFilename = `${previewIdentity.assetId}.svg`;
  const manifestFilename = `${identity.manifestAssetId}.json`;
  await writeFile(join(artifactDirectory, previewFilename), preview);
  await writeFile(join(artifactDirectory, manifestFilename), built.manifestPayload);
  for (const tile of built.tiles) {
    await writeFile(join(artifactDirectory, `${tile.descriptor.assetId}.bin`), tile.payload);
  }
  return {
    canonical,
    region,
    regionPreviews: [{
      regionId: region.regionId,
      assetId: previewIdentity.assetId,
      filename: previewFilename,
      sizeBytes: preview.byteLength,
      sha256: createHash("sha256").update(preview).digest("hex"),
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

describe("FloorImportWorkerService", () => {
  it("claims queued and expired processing work with SKIP LOCKED while retiring expired third attempts", async () => {
    const row = claimedJob();
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: row.id }])
        .mockResolvedValueOnce([row])
    };
    const worker = new FloorImportWorkerService(prisma, {} as any, {} as any, {} as any, {} as any, {
      tempRoot: tmpdir(), pollIntervalMs: 1000
    });
    await expect(worker.claimNext()).resolves.toMatchObject({ id: row.id, attemptCount: 1 });
    expect(prisma.$executeRaw.mock.calls[0][0].strings.join(" ")).toContain("attemptCount");
    expect(prisma.$queryRaw.mock.calls[1][0].strings.join(" ")).toContain("FOR UPDATE SKIP LOCKED");
    expect(prisma.$queryRaw.mock.calls[1][0].strings.join(" "))
      .toContain('"progressPercent" = GREATEST("progressPercent", 1)');
    await worker.onModuleDestroy();
  });

  it.each(["success", "dwg", "verification failure", "invalid metadata", "core timeout", "pin failure", "canonical only"])("runs the verified native persistence path: %s", async mode => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-test-"));
    const row = claimedJob({ detectorProfileId: null, sourceFormat: mode === "dwg" ? "dwg" : "dxf" });
    const source = { objectKey: `floors/${row.floorId}/source.dxf`, sizeBytes: BigInt(1024), sha256: "a".repeat(64),
      mimeType: "application/dxf", floor: { siteId: randomUUID() } };
    const candidates = Array.from({ length: 2_000 }, (_, index) => ({
      sourceEntityId: `insert-${index}`, layerName: "LIGHT", blockName: "LED", x: 3, y: 8,
      rotation: -30, confidence: 0.95, method: "rule"
    }));
    const dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n1\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n";
    const attempt = { jobId: row.id, floorId: row.floorId, attemptCount: row.attemptCount,
      assetId: randomUUID(), objectKey: `floors/${row.floorId}/${row.id}-attempt-${row.attemptCount}.svg` };
    const storageOrder: string[] = [];
    const finalTransactions: any[] = [];
    let stagedAssets: any[] = [];
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: row.id }])
        .mockResolvedValueOnce([row]),
      floorImportRegion: { findMany: jest.fn().mockResolvedValue([]) },
      floorAsset: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(source),
        findUnique: jest.fn().mockResolvedValue(null),
        createMany: jest.fn(async ({ data }: any) => { stagedAssets = data; return { count: data.length }; }),
        findMany: jest.fn(async () => stagedAssets.map(asset => ({
          ...asset,
          contentEncoding: asset.contentEncoding ?? null,
          cleanupStartedAt: null
        })))
      },
      $transaction: jest.fn(async (run: (tx: any) => unknown) => {
        const tx: any = {
          $queryRaw: jest.fn().mockResolvedValue([{ assetId: attempt.assetId }]),
          floorAsset: { updateMany: jest.fn(async ({ where }: any) => ({ count: where.id?.in?.length ?? 1 })) },
          floorImportAttemptCleanup: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          floorImportRegion: {
            findMany: jest.fn().mockResolvedValue([]),
            createMany: jest.fn().mockResolvedValue({ count: 1 })
          },
          floorImportCandidate: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), createMany: jest.fn().mockResolvedValue({ count: 1 }) },
          $executeRaw: jest.fn().mockResolvedValue(1)
        };
        const result = await run(tx); finalTransactions.push(tx); return result;
      })
    };
    const storage: any = {
      downloadFloorAssetToFile: jest.fn(async (_key: string, path: string) => writeFile(path, dxf)),
      putFloorRenderedObjectFile: jest.fn().mockImplementation(async () => { storageOrder.push("put"); }),
      verifyFloorRenderedObject: jest.fn().mockResolvedValue(undefined),
      putCadSceneObjectFile: jest.fn().mockResolvedValue(undefined),
      verifyCadSceneObject: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined)
    };
    if (mode === "verification failure") storage.verifyCadSceneObject.mockRejectedValue(new Error("checksum mismatch"));
    const converter: any = { convert: jest.fn(async ({ inputPath, outputPath }: any) => {
      await writeFile(outputPath, await readFile(inputPath));
      return { outputPath, outputBytes: Buffer.byteLength(dxf) };
    }) };
    const rules: any = { profileId: "generic-lighting-v1", profileVersion: "test/1", profileDigest: "b".repeat(64) };
    const registry: any = {
      get: jest.fn().mockReturnValue(rules), resolve: jest.fn().mockReturnValue("generic-lighting-v1"), assertBinding: jest.fn()
    };
    const core: any = { execute: jest.fn(async ({ renderedPath, artifactDirectory }: any) => {
      await writeFile(renderedPath, "gzip-svg");
      const artifacts = await writeNativeArtifacts(row.id, artifactDirectory, candidates.length);
      if (mode === "invalid metadata") artifacts.region.textCount = artifacts.region.primitiveCount + 1;
      return {
        profileId: "generic-lighting-v1", profileVersion: "test/1", profileDigest: "b".repeat(64),
        modelEntityCount: 1, blockCount: 0, candidates, selectedCandidates: candidates,
        candidateRegionAssignments: candidates.map(candidate => ({
          sourceEntityId: candidate.sourceEntityId,
          regionId: artifacts.region.regionId
        })),
        excludedRegionPrimitiveCount: 17, regions: [artifacts.region],
        regionPreviews: artifacts.regionPreviews, scene: artifacts.scene, canonical: artifacts.canonical,
        candidateTransformMatch: {
          candidateCount: candidates.length, matchedCount: candidates.length,
          matchRate: 1, tolerancePx: 0.01, maxDeltaPx: 0
        },
        rendered: { sizeBytes: 8, rawSizeBytes: 64, sha256: "c".repeat(64), viewport: { width: 12, height: 12 },
          renderedOccurrences: 1, contentEncoding: "gzip" }
      };
    }) };
    const cleanup: any = {
      armAttempt: jest.fn().mockImplementation(async () => { storageOrder.push("ledger"); return attempt; }),
      requestCleanup: jest.fn()
    };
    const preparedId = randomUUID();
    const persisted: string[] = [];
    let pinned: string | null = null;
    let discarded: string | null = null;
    const preparation: any = {
      reap: async () => 0,
      prepare: async (_floor: string, directory: string, canonical: any) => {
        for await (const element of readCanonicalElements(directory, canonical)) persisted.push(element.id);
        return { generationId: preparedId };
      },
      pinPrepared: async () => { if (mode === "pin failure") throw new Error("CAD_IMPORT_LEASE_LOST"); pinned = preparedId; },
      discard: async (_floor: string, id: string) => { discarded = id; }
    };
    const worker = new FloorImportWorkerService(prisma, storage, converter, registry, core,
      { tempRoot: root, pollIntervalMs: 1000, legacyDisplayCompatibility: mode !== "canonical only" }, cleanup, preparation);
    const logError = jest.spyOn((worker as any).logger, "error").mockImplementation(() => undefined);
    if (mode === "core timeout") core.execute.mockRejectedValue(new Error("CAD core child process wall time limit exceeded"));
    try {
      await expect(worker.runOnce()).resolves.toBe(true);
      if (mode === "canonical only") {
        expect(persisted).toHaveLength(1);
        expect(pinned).toBe(preparedId);
        expect(stagedAssets.map(asset => asset.kind)).toEqual(["cad_region_preview"]);
        return;
      }
      if (mode === "pin failure") {
        expect(persisted).toHaveLength(1);
        expect(pinned).toBeNull();
        expect(discarded).toBe(preparedId);
        expect(finalTransactions).toHaveLength(0);
        return;
      }
      if (mode !== "success" && mode !== "dwg") {
        expect(prisma.$transaction).not.toHaveBeenCalled();
        if (mode === "verification failure") expect(storage.verifyCadSceneObject).toHaveBeenCalledTimes(1);
        else expect(storage.putCadSceneObjectFile).not.toHaveBeenCalled();
        expect(logError).toHaveBeenCalledWith(expect.objectContaining({
          operation: "background_job", jobId: row.id, attemptCount: 1,
          diagnosticCode: mode === "core timeout" ? "CAD_CORE_TIMEOUT" : expect.any(String)
        }));
        expect(await readdir(root)).toEqual([]);
        return;
      }
      expect(storage.downloadFloorAssetToFile).toHaveBeenCalledWith(source.objectKey, expect.any(String), expect.objectContaining({
        expectedSha256: source.sha256, maxBytes: 50 * 1024 * 1024
      }));
      if (mode === "dwg") expect(converter.convert).toHaveBeenCalledTimes(1);
      else expect(converter.convert).not.toHaveBeenCalled();
      expect(core.execute).toHaveBeenCalledWith(expect.objectContaining({
        profileId: "generic-lighting-v1", dxfPath: expect.stringMatching(mode === "dwg" ? /converted\.dxf$/ : /source\.dxf$/)
      }));
      expect(prisma.$executeRaw.mock.calls.some(([query]: any[]) =>
        query.strings?.join(" ").includes('"detectorProfileId" IS NULL'))).toBe(true);
      expect(storageOrder).toEqual(["ledger", "put"]);
      expect(persisted).toHaveLength(1);
      expect(pinned).toBe(preparedId);
      expect(discarded).toBeNull();
      expect(storage.putFloorRenderedObjectFile).toHaveBeenCalledWith(
        attempt.objectKey, expect.stringMatching(/rendered\.svg$/), expect.objectContaining({ sizeBytes: 8, sha256: "c".repeat(64) }),
        { width: 12, height: 12 }, expect.any(AbortSignal)
      );
      const finalTx = finalTransactions.at(-1);
      expect(finalTx.$queryRaw.mock.calls[0][0].strings.join(" ")).toContain("FOR UPDATE OF floor, asset, cleanup");
      expect(finalTx.floorImportCandidate.createMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.arrayContaining([expect.objectContaining({
          detectionMethod: "rule_based", provider: null, model: null, inputDigest: null,
          x: 3, y: 8, rotation: -30, profileVersion: "test/1", profileDigest: "b".repeat(64)
        })])
      }));
      expect(finalTx.floorImportCandidate.createMany).toHaveBeenCalledTimes(8);
      expect(finalTx.floorImportCandidate.createMany.mock.calls.every(([input]: any[]) => input.data.length <= 250)).toBe(true);
      expect(finalTx).not.toHaveProperty("fixture");
      expect(finalTx).not.toHaveProperty("meshNode");
      const regionInsert = finalTx.$executeRaw.mock.calls.find(([query]: any[]) =>
        query.strings.join(" ").includes('INSERT INTO "FloorImportRegion"'))[0];
      expect(regionInsert.values.slice(3, 12)).toEqual(["0", "0", "10", "10", 2_000, 0, 2_000, 1_200, 1_200]);
      expect(regionInsert.values[12]).toMatch(/^[a-f0-9]{64}$/);
      const completionSql = finalTx.$executeRaw.mock.calls.at(-1)[0];
      expect(completionSql.strings.join(" ")).toContain("review_required");
      expect(completionSql.strings.join(" ")).toContain('"progressPercent" = 100');
      expect(completionSql.strings.join(" ")).toContain('"excludedRegionPrimitiveCount" =');
      expect(completionSql.values).toContain(17);
      const progressUpdates: Array<{ progressPercent: number }> = prisma.$executeRaw.mock.calls
        .map(([query]: any[]) => query)
        .filter((query: any) => query.strings?.join(" ").includes('"progressPercent" = GREATEST'))
        .map((query: any) => ({ progressPercent: query.values[0] }));
      progressUpdates.push({ progressPercent: 100 });
      expect(progressUpdates.map(({ progressPercent }) => progressPercent)).toEqual([15, 35, 70, 90, 100]);
      expect(finalTx.floorAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          id: attempt.assetId, objectKey: attempt.objectKey, status: "pending", cleanupStartedAt: null
        },
        data: expect.objectContaining({ status: "ready" })
      }));
      expect(finalTx.floorImportAttemptCleanup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ jobId: row.id, attemptCount: row.attemptCount, committedAt: null }),
        data: expect.objectContaining({ committedAt: expect.any(Date) })
      }));
      expect(completionSql.values).toContain(attempt.assetId);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await worker.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects insufficient temporary space before starting the isolated CAD core", async () => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-budget-test-"));
    const row = claimedJob({ attemptCount: 3 });
    const source = {
      objectKey: `floors/${row.floorId}/source.dxf`, sizeBytes: 1n, sha256: "a".repeat(64),
      mimeType: "application/dxf", floor: { siteId: randomUUID() }
    };
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValueOnce([{ id: row.id }]).mockResolvedValueOnce([row]),
      floorAsset: { findUniqueOrThrow: jest.fn().mockResolvedValue(source) }
    };
    const storage: any = {
      downloadFloorAssetToFile: jest.fn(async (_key: string, path: string) => writeFile(path, "s"))
    };
    const converter: any = {
      convert: jest.fn(async ({ outputPath }: any) => {
        await writeFile(outputPath, "d");
        return { outputPath, outputBytes: 1 };
      })
    };
    const core: any = { execute: jest.fn().mockRejectedValue(new Error("core must not start")) };
    const statfs = jest.mocked(fsPromises.statfs);
    statfs.mockResolvedValue({
      bsize: 1n, blocks: 536_870_912n, bavail: 209_715_199n
    } as any);
    const worker = new FloorImportWorkerService(
      prisma, storage, converter, genericRegistry(), core,
      { tempRoot: root, pollIntervalMs: 1000 }
    );

    try {
      await expect(worker.runOnce()).resolves.toBe(true);
      expect(core.execute).not.toHaveBeenCalled();
      expect(prisma.$executeRaw.mock.calls.at(-1)[0].values).toContain("CAD_IMPORT_RENDER_FAILED");
    } finally {
      statfs.mockReset();
      statfs.mockImplementation(jest.requireActual("node:fs/promises").statfs);
      await worker.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("contains a failed attempt, retries at most three times, and removes terminal partial objects", async () => {
    const row = claimedJob({ attemptCount: 3 });
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValueOnce([{ id: row.id }]).mockResolvedValueOnce([row]),
      floorAsset: { findUniqueOrThrow: jest.fn().mockResolvedValue({ objectKey: "floors/f/source.dxf", sizeBytes: 10n,
        sha256: "a".repeat(64), mimeType: "application/dxf", floor: { siteId: randomUUID() } }) }
    };
    const storage: any = { downloadFloorAssetToFile: jest.fn().mockRejectedValue(new Error("private path")), deleteObject: jest.fn() };
    const worker = new FloorImportWorkerService(prisma, storage, {} as any, genericRegistry(), {} as any,
      { tempRoot: tmpdir(), pollIntervalMs: 1000 });
    await worker.runOnce();
    const failureSql = prisma.$executeRaw.mock.calls.at(-1)[0];
    expect(failureSql.strings.join(" ")).toContain("'failed'");
    expect(failureSql.strings.join(" ")).not.toContain('"progressPercent"');
    expect(failureSql.values).not.toContain("private path");
    await worker.onModuleDestroy();
  });

  it("drains an active attempt on shutdown, aborts external work, and leaves the lease recoverable", async () => {
    const row = claimedJob(); let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValueOnce([{ id: row.id }]).mockResolvedValueOnce([row]),
      floorAsset: { findUniqueOrThrow: jest.fn().mockResolvedValue({ objectKey: "floors/f/source.dxf", sizeBytes: 10n,
        sha256: "a".repeat(64), mimeType: "application/dxf", floor: { siteId: randomUUID() } }) }
    };
    const storage: any = { downloadFloorAssetToFile: jest.fn(async (_key: string, _path: string, options: any) => {
      entered();
      await Promise.race([gate, new Promise<void>((_, reject) => options.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
    }) };
    const worker = new FloorImportWorkerService(prisma, storage, {} as any, genericRegistry(), {} as any,
      { tempRoot: tmpdir(), pollIntervalMs: 1000 });
    const running = worker.runOnce(); await started;
    await worker.onModuleDestroy(); release();
    await expect(running).resolves.toBe(true);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1); // Exhausted sweep only; no retry/failure write after shutdown.
  });

  it("defers an uploaded object interrupted by shutdown to its durable attempt ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "floor-import-shutdown-test-"));
    const row = claimedJob();
    const dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n1\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n";
    let uploadEntered!: () => void;
    const uploading = new Promise<void>(resolve => { uploadEntered = resolve; });
    const prisma: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValueOnce([{ id: row.id }]).mockResolvedValueOnce([row]),
      floorImportRegion: { findMany: jest.fn().mockResolvedValue([]) },
      floorAsset: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          objectKey: `floors/${row.floorId}/source.dxf`, sizeBytes: BigInt(Buffer.byteLength(dxf)),
          sha256: "a".repeat(64), mimeType: "application/dxf", floor: { siteId: randomUUID() }
        }),
        findUnique: jest.fn().mockResolvedValue(null),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([])
      }
    };
    const storage: any = {
      downloadFloorAssetToFile: jest.fn(async (_key: string, path: string) => writeFile(path, dxf)),
      putFloorRenderedObjectFile: jest.fn(async (_key: string, _path: string, _rendered: unknown, _viewport: unknown, signal: AbortSignal) => {
        uploadEntered();
        await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }),
      putCadSceneObjectFile: jest.fn(),
      verifyCadSceneObject: jest.fn(),
      deleteObject: jest.fn().mockResolvedValue(undefined)
    };
    const converter: any = { convert: jest.fn(async ({ inputPath, outputPath }: any) => {
      await writeFile(outputPath, await readFile(inputPath));
      return { outputPath, outputBytes: Buffer.byteLength(dxf) };
    }) };
    const detector: any = { profileId: "generic-lighting-v1", profileVersion: "test/1", profileDigest: "b".repeat(64) };
    const registry: any = {
      get: jest.fn().mockReturnValue(detector), resolve: jest.fn().mockReturnValue("generic-lighting-v1"), assertBinding: jest.fn()
    };
    let stagedAssets: any[] = [];
    prisma.floorAsset.createMany.mockImplementation(async ({ data }: any) => {
      stagedAssets = data;
      return { count: data.length };
    });
    prisma.floorAsset.findMany.mockImplementation(async () => stagedAssets.map(asset => ({
      ...asset,
      contentEncoding: asset.contentEncoding ?? null,
      cleanupStartedAt: null
    })));
    const core: any = { execute: jest.fn(async ({ renderedPath, artifactDirectory }: any) => {
      await writeFile(renderedPath, "gzip-svg");
      const artifacts = await writeNativeArtifacts(row.id, artifactDirectory, 0);
      return {
        profileId: "generic-lighting-v1", profileVersion: "test/1", profileDigest: "b".repeat(64),
        modelEntityCount: 1, blockCount: 0, candidates: [], selectedCandidates: [],
        candidateRegionAssignments: [],
        excludedRegionPrimitiveCount: 0, regions: [artifacts.region],
        regionPreviews: artifacts.regionPreviews, scene: artifacts.scene,
        candidateTransformMatch: {
          candidateCount: 0, matchedCount: 0, matchRate: null, tolerancePx: 0.01, maxDeltaPx: 0
        },
        rendered: { sizeBytes: 8, rawSizeBytes: 64, sha256: "c".repeat(64), viewport: { width: 12, height: 12 },
          renderedOccurrences: 1, contentEncoding: "gzip" }
      };
    }) };
    const cleanup: any = {
      armAttempt: jest.fn().mockResolvedValue({ jobId: row.id, floorId: row.floorId, attemptCount: row.attemptCount,
        assetId: randomUUID(), objectKey: `floors/${row.floorId}/${row.id}-attempt-${row.attemptCount}.svg` }),
      requestCleanup: jest.fn().mockResolvedValue("deferred")
    };
    const worker = new FloorImportWorkerService(prisma, storage, converter, registry, core, {
      tempRoot: root, pollIntervalMs: 1000
    }, cleanup);
    try {
      const running = worker.runOnce();
      await uploading;
      const writesBeforeShutdown = prisma.$executeRaw.mock.calls.length;
      await worker.onModuleDestroy();
      await expect(running).resolves.toBe(true);
      expect(cleanup.requestCleanup).toHaveBeenCalledWith(expect.objectContaining({ jobId: row.id, attemptCount: row.attemptCount }));
      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(writesBeforeShutdown); // Leave the in-flight lease for expiry recovery.
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

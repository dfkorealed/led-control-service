import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { AuditService } from "../audit/audit.service";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { ObjectStorageService } from "../storage/object-storage.service";
import { ArgvCadConverter } from "./cad-converter";
import { ChildProcessCadCoreExecutor, type CadCoreExecutor, type CadCoreResult } from "./cad-core-executor";
import { FloorImportAttemptCleanupService } from "./floor-import-attempt-cleanup.service";
import { FloorImportWorkerService } from "./floor-import-worker.service";
import { FloorImportService } from "./floor-import.service";
import { FixedLightingDetectorRegistry, PROVIDED_SAMPLE_DWG_SHA256 } from "./lighting-detector-registry";

const sample = process.env.CAD_SAMPLE_DWG_PATH;
const converterPath = process.env.CAD_SAMPLE_CONVERTER_PATH;
const converterArgvJson = process.env.CAD_SAMPLE_CONVERTER_ARGV_JSON;
const sampleEnvironmentCount = [sample, converterPath, converterArgvJson].filter(value => value !== undefined).length;
if (sampleEnvironmentCount > 0 &&
    (sampleEnvironmentCount !== 3 || process.env.RUN_OBJECT_STORAGE_INTEGRATION !== "true")) {
  throw new Error(
    "CAD sample integration requires CAD_SAMPLE_DWG_PATH, CAD_SAMPLE_CONVERTER_PATH, " +
    "CAD_SAMPLE_CONVERTER_ARGV_JSON and RUN_OBJECT_STORAGE_INTEGRATION=true together"
  );
}
const enabled = sampleEnvironmentCount === 3;

(enabled ? describe : describe.skip)("provided CAD sample worker/storage/DB/API pipeline", () => {
  jest.setTimeout(240_000);

  it("auto-resolves the approved profile and preserves all candidates through the real product boundary", async () => {
    const cluster = await disposablePostgres();
    const databaseUrl = cluster.database();
    const deployed = cluster.deploy(databaseUrl);
    if (deployed.status !== 0) throw new Error(deployed.stderr || deployed.stdout);
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    const endpoint = process.env.OBJECT_STORAGE_ENDPOINT ?? "http://localhost:9000";
    const bucket = process.env.OBJECT_STORAGE_BUCKET ?? "floor-assets";
    const client = new S3Client({
      region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1", endpoint, forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY ?? "led-floor-assets",
        secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY ?? "change-this-local-secret"
      }
    });
    const storage = new ObjectStorageService(client, { bucket, publicBaseUrl: `${endpoint}/${bucket}` });
    const organizationId = randomUUID(); const userId = randomUUID(); const siteId = randomUUID(); const floorId = randomUUID();
    const sourceAssetId = randomUUID(); const sourceKey = `floors/${floorId}/sample.dwg`;
    let renderedKey: string | undefined;
    try {
      const sourceStat = await stat(sample!);
      const sourceSha256 = await hashFile(sample!);
      expect(sourceSha256).toBe(PROVIDED_SAMPLE_DWG_SHA256);
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: sourceKey, Body: createReadStream(sample!), ContentType: "application/dwg",
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
      const access = {
        assert: jest.fn().mockResolvedValue({ id: siteId, organizationId }),
        assertManageInTransaction: jest.fn().mockResolvedValue({ id: siteId, organizationId })
      };
      const imports = new FloorImportService(prisma as never, access as never, new AuditService(prisma as never), storage);
      const created = await imports.create(user, floorId, { sourceAssetId, sourceFormat: "dwg" });
      expect(created.detectorProfileId).toBe("site-drawing-20260803-v1");

      const converterArgv = JSON.parse(converterArgvJson!) as unknown;
      if (!Array.isArray(converterArgv) || converterArgv.some(argument => typeof argument !== "string")) {
        throw new Error("CAD_SAMPLE_CONVERTER_ARGV_JSON must be a JSON string array");
      }
      const execution = process.platform === "linux"
        ? { mode: "linux-resource-limited" as const }
        : { mode: "macos-development-polling" as const, acknowledgeNonProductionRisk: true as const };
      const converter = new ArgvCadConverter({
        executable: converterPath!, argv: converterArgv as string[], timeoutMs: 60_000,
        maxOutputBytes: 256 * 1024 * 1024,
        execution
      });
      const registry = new FixedLightingDetectorRegistry();
      const childCore = new ChildProcessCadCoreExecutor({
        entryPath: resolve(process.cwd(), "dist/src/floor-import/cad-core-child.js"), timeoutMs: 60_000
      });
      let coreResult: CadCoreResult | undefined;
      const core: CadCoreExecutor = {
        execute: async request => {
          coreResult = await childCore.execute(request);
          return coreResult;
        }
      };
      const cleanup = new FloorImportAttemptCleanupService(prisma as never, storage, {
        tempRoot: "/tmp", pollIntervalMs: 1000, enabled: false
      });
      const worker = new FloorImportWorkerService(
        prisma as never, storage, converter, registry, core,
        { tempRoot: "/tmp", pollIntervalMs: 1000, enabled: false }, cleanup
      );
      await expect(worker.runOnce()).resolves.toBe(true);
      await worker.onModuleDestroy();
      await cleanup.onModuleDestroy();

      const persisted = await prisma.floorImportJob.findUniqueOrThrow({
        where: { id: created.jobId }, include: { renderedAsset: true, _count: { select: { candidates: true } } }
      });
      expect(persisted).toMatchObject({
        status: "review_required", stage: "review_required", progressPercent: 100,
        detectorProfileId: "site-drawing-20260803-v1",
        detectorProfileVersion: registry.get("site-drawing-20260803-v1").profileVersion,
        detectorProfileDigest: registry.get("site-drawing-20260803-v1").profileDigest,
        _count: { candidates: 1_308 }, renderedAsset: { contentEncoding: "gzip" }
      });
      expect(coreResult).toBeDefined();
      expect(coreResult!.candidateTransformMatch).toMatchObject({
        candidateCount: 1_308,
        matchedCount: 1_308,
        matchRate: 1,
        tolerancePx: 0.01
      });
      expect(coreResult!.candidateTransformMatch.maxDeltaPx).toBeLessThanOrEqual(0.01);
      renderedKey = persisted.renderedAsset!.objectKey;
      const apiJob = await imports.get(user, floorId, created.jobId);
      expect(apiJob).toMatchObject({
        status: "review_required", stage: "review_required", progressPercent: 100,
        renderedViewport: coreResult!.rendered.viewport
      });
      await expect(imports.listCandidates(user, floorId, created.jobId))
        .resolves.toMatchObject({ candidates: expect.arrayContaining([expect.objectContaining({ blockName: "몰드바등" })]) });
      const signed = await storage.createFloorAssetDownloadUrl(renderedKey);
      const response = await fetch(signed);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBe("gzip");
      const svg = Buffer.from(await response.arrayBuffer());
      expect(svg.subarray(0, 4).toString()).toBe("<svg");
      const decoded = await sharp(svg).metadata();
      expect(decoded).toMatchObject({
        format: "svg",
        width: coreResult!.rendered.viewport.width,
        height: coreResult!.rendered.viewport.height
      });
      const unsupportedEntityTotal = Object.values(coreResult!.rendered.unsupportedEntityCounts ?? {})
        .reduce((sum, count) => sum + count, 0);
      process.stdout.write(`${JSON.stringify({
        jobStatus: apiJob.status, jobStage: apiJob.stage, jobProgressPercent: apiJob.progressPercent,
        sourceSha256, sourceBytes: sourceStat.size,
        modelEntityCount: coreResult!.modelEntityCount, blockCount: coreResult!.blockCount,
        candidateCount: persisted._count.candidates,
        candidateTransformMatch: coreResult!.candidateTransformMatch,
        viewport: coreResult!.rendered.viewport,
        excludedEntityCount: coreResult!.rendered.excludedEntityCount ?? 0,
        unsupportedEntityCounts: coreResult!.rendered.unsupportedEntityCounts ?? {},
        unsupportedEntityTotal,
        renderedOccurrences: coreResult!.rendered.renderedOccurrences,
        rawSvgBytes: coreResult!.rendered.rawSizeBytes,
        storedSvgBytes: Number(persisted.renderedAsset!.sizeBytes),
        storedSvgSha256: coreResult!.rendered.sha256,
        svgDecode: { format: decoded.format, width: decoded.width, height: decoded.height },
        profileVersion: persisted.detectorProfileVersion, profileDigest: persisted.detectorProfileDigest
      })}\n`);
    } finally {
      if (renderedKey) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: renderedKey })).catch(() => undefined);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey })).catch(() => undefined);
      client.destroy();
      await prisma.$disconnect();
      cluster.stop();
    }
  });
});

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

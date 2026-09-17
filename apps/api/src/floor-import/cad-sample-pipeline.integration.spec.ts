import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { AuditService } from "../audit/audit.service";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { ObjectStorageService } from "../storage/object-storage.service";
import { ArgvCadConverter } from "./cad-converter";
import { ChildProcessCadCoreExecutor } from "./cad-core-executor";
import { FloorImportAttemptCleanupService } from "./floor-import-attempt-cleanup.service";
import { FloorImportWorkerService } from "./floor-import-worker.service";
import { FloorImportService } from "./floor-import.service";
import { FixedLightingDetectorRegistry, PROVIDED_SAMPLE_DWG_SHA256 } from "./lighting-detector-registry";

const sample = process.env.CAD_SAMPLE_DWG_PATH;
const converterPath = process.env.CAD_SAMPLE_CONVERTER_PATH;
const enabled = Boolean(sample && converterPath && process.env.RUN_OBJECT_STORAGE_INTEGRATION === "true");

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

      const converter = new ArgvCadConverter({
        executable: converterPath!, argv: ["-O", "DXF", "-o", "{output}", "{input}"], timeoutMs: 60_000,
        maxOutputBytes: 256 * 1024 * 1024,
        execution: { mode: "macos-development-polling", acknowledgeNonProductionRisk: true }
      });
      const registry = new FixedLightingDetectorRegistry();
      const core = new ChildProcessCadCoreExecutor({
        entryPath: resolve(process.cwd(), "dist/src/floor-import/cad-core-child.js"), timeoutMs: 60_000
      });
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
        status: "review_required", detectorProfileId: "site-drawing-20260803-v1",
        detectorProfileVersion: registry.get("site-drawing-20260803-v1").profileVersion,
        detectorProfileDigest: registry.get("site-drawing-20260803-v1").profileDigest,
        _count: { candidates: 1_308 }, renderedAsset: { contentEncoding: "gzip" }
      });
      renderedKey = persisted.renderedAsset!.objectKey;
      const apiJob = await imports.get(user, floorId, created.jobId);
      expect(apiJob).toMatchObject({ status: "review_required", renderedViewport: expect.any(Object) });
      await expect(imports.listCandidates(user, floorId, created.jobId))
        .resolves.toMatchObject({ candidates: expect.arrayContaining([expect.objectContaining({ blockName: "몰드바등" })]) });
      const signed = await storage.createFloorAssetDownloadUrl(renderedKey);
      const response = await fetch(signed);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBe("gzip");
      expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString()).toBe("<svg");
      process.stdout.write(`${JSON.stringify({
        sourceSha256, sourceBytes: sourceStat.size, candidates: persisted._count.candidates,
        storedSvgBytes: Number(persisted.renderedAsset!.sizeBytes), profileVersion: persisted.detectorProfileVersion,
        profileDigest: persisted.detectorProfileDigest
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

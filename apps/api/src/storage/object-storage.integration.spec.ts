import { createHash, randomUUID } from "node:crypto";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ObjectStorageService } from "./object-storage.service";

const runIntegration = process.env.RUN_OBJECT_STORAGE_INTEGRATION === "true" ? describe : describe.skip;

runIntegration("ObjectStorageService integration", () => {
  it("uploads a checksum-signed object and permits only a short signed download", async () => {
    const endpoint = process.env.OBJECT_STORAGE_ENDPOINT ?? "http://localhost:9000";
    const bucket = process.env.OBJECT_STORAGE_BUCKET ?? "floor-assets";
    const client = new S3Client({
      region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1",
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY ?? "led-floor-assets",
        secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY ?? "change-this-local-secret"
      }
    });
    const service = new ObjectStorageService(client, { bucket, publicBaseUrl: `${endpoint}/${bucket}` });
    const body = Buffer.from("production-object-storage-check");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const descriptor = await service.createUploadDescriptor({
      floorId: "integration-floor",
      mimeType: "image/png",
      sizeBytes: body.length,
      sha256
    });

    try {
      const response = await fetch(descriptor.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "image/png", "x-amz-checksum-sha256": descriptor.checksumBase64 },
        body
      });
      expect(response.status).toBe(200);
      await expect(service.headObject(descriptor.objectKey)).resolves.toMatchObject({
        ContentType: "image/png",
        ContentLength: body.length,
        ChecksumSHA256: descriptor.checksumBase64
      });
      const anonymous = await fetch(`${endpoint}/${bucket}/${descriptor.objectKey}`);
      expect(anonymous.status).toBe(403);
      const signedUrl = await service.createFloorAssetDownloadUrl(descriptor.objectKey);
      expect(new URL(signedUrl).searchParams.get("X-Amz-Expires")).toBe("300");
      const signedDownload = await fetch(signedUrl);
      expect(signedDownload.status).toBe(200);
      expect(Buffer.from(await signedDownload.arrayBuffer())).toEqual(body);
    } finally {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: descriptor.objectKey }));
    }
  });

  it("preserves mandatory gzip metadata through rendered PUT, HEAD and signed GET", async () => {
    const endpoint = process.env.OBJECT_STORAGE_ENDPOINT ?? "http://localhost:9000";
    const bucket = process.env.OBJECT_STORAGE_BUCKET ?? "floor-assets";
    const client = new S3Client({
      region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1", endpoint, forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY ?? "led-floor-assets",
        secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY ?? "change-this-local-secret"
      }
    });
    const service = new ObjectStorageService(client, { bucket, publicBaseUrl: `${endpoint}/${bucket}` });
    const root = await mkdtemp(join(tmpdir(), "cad-gzip-minio-"));
    const path = join(root, "rendered.svg");
    const key = `floors/${randomUUID()}/rendered.svg`;
    const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="37" height="23"><text y="16">한글</text></svg>');
    const bytes = gzipSync(source, { level: 9 });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      await writeFile(path, bytes);
      await service.putFloorRenderedObjectFile(key, path, { sizeBytes: bytes.length, sha256 }, { width: 37, height: 23 });
      await expect(service.readFloorRenderedMetadata(key, {
        sizeBytes: bytes.length, sha256, mimeType: "image/svg+xml", contentEncoding: "gzip"
      })).resolves.toEqual({ width: 37, height: 23 });
      const signed = await service.createFloorAssetDownloadUrl(key);
      const response = await fetch(signed);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBe("gzip");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(source);
    } finally {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
      client.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a legacy identity SVG through HEAD and signed GET without a gzip header", async () => {
    const endpoint = process.env.OBJECT_STORAGE_ENDPOINT ?? "http://localhost:9000";
    const bucket = process.env.OBJECT_STORAGE_BUCKET ?? "floor-assets";
    const client = new S3Client({
      region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1", endpoint, forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY ?? "led-floor-assets",
        secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY ?? "change-this-local-secret"
      }
    });
    const service = new ObjectStorageService(client, { bucket, publicBaseUrl: `${endpoint}/${bucket}` });
    const key = `floors/${randomUUID()}/legacy.svg`;
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="41" height="29"><text y="18">legacy</text></svg>');
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: bytes, ContentType: "image/svg+xml", ContentLength: bytes.length,
        ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
        CacheControl: "private, no-store", Metadata: { "cad-width": "41", "cad-height": "29" }
      }));
      await expect(service.readFloorRenderedMetadata(key, {
        sizeBytes: bytes.length, sha256, mimeType: "image/svg+xml", contentEncoding: null
      })).resolves.toEqual({ width: 41, height: 29 });
      const response = await fetch(await service.createFloorAssetDownloadUrl(key));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
      client.destroy();
    }
  });
});

const runReportIntegration = process.env.RUN_REPORT_STORAGE_INTEGRATION === "true" ? describe : describe.skip;
runReportIntegration("private report S3 integration", () => {
  it("denies anonymous GET, permits a 300-second signed download, verifies HEAD and deletes", async () => {
    const endpoint = process.env.OBJECT_STORAGE_ENDPOINT!;
    const reportBucket = process.env.OBJECT_STORAGE_REPORT_BUCKET!;
    const client = new S3Client({ region: "us-east-1", endpoint, forcePathStyle: true, credentials: {
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY!, secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY!
    } });
    const service = new ObjectStorageService(client, { bucket: process.env.OBJECT_STORAGE_BUCKET!, reportBucket, publicBaseUrl: endpoint });
    const key = `reports/${randomUUID()}/${randomUUID()}/attempt-1.pdf`;
    const bytes = Buffer.from("private report transport integration");
    try {
      await service.putReportObject(key, bytes, "application/pdf");
      await expect(service.headReportObject(key)).resolves.toMatchObject({ ContentLength: bytes.length,
        ContentType: "application/pdf", ChecksumSHA256: createHash("sha256").update(bytes).digest("base64") });
      await expect(service.inspectReportObject(key)).resolves.toEqual({ exists: true, sizeBytes: bytes.length });
      const anonymous = await fetch(`${endpoint}/${reportBucket}/${key}`);
      expect(anonymous.status).toBe(403);
      const signedUrl = await service.createReportDownloadUrl(key, "energy-report.pdf");
      expect(new URL(signedUrl).searchParams.get("X-Amz-Expires")).toBe("300");
      const download = await fetch(signedUrl);
      expect(download.status).toBe(200);
      expect(download.headers.get("content-disposition")).toBe('attachment; filename="energy-report.pdf"');
      expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
      await service.deleteReportObject(key);
      await expect(service.headReportObject(key)).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
      await expect(service.inspectReportObject(key)).resolves.toEqual({ exists: false });
    } finally { await service.deleteReportObject(key); client.destroy(); }
  });
});

import { createHash } from "node:crypto";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ObjectStorageService } from "./object-storage.service";

const runIntegration = process.env.RUN_OBJECT_STORAGE_INTEGRATION === "true" ? describe : describe.skip;

runIntegration("ObjectStorageService integration", () => {
  it("uploads a checksum-signed object and reads matching HEAD metadata", async () => {
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
    } finally {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: descriptor.objectKey }));
    }
  });
});

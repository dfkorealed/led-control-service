import { BadRequestException } from "@nestjs/common";
import { OBJECT_STORAGE_CLIENT, ObjectStorageService } from "./object-storage.service";
import { StorageModule } from "./storage.module";
import { Test } from "@nestjs/testing";
import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

describe("ObjectStorageService", () => {
  const service = new ObjectStorageService({} as never, {
    bucket: "floor-assets",
    publicBaseUrl: "http://localhost:9000/floor-assets",
    presign: jest.fn().mockResolvedValue("https://upload.example/signed")
  });

  it.each(["image/jpeg", "image/png", "application/pdf"])("accepts supported MIME %s", async (mimeType) => {
    await expect(
      service.createUploadDescriptor({ floorId: "floor-1", mimeType, sizeBytes: 1024, sha256: "a".repeat(64) })
    ).resolves.toMatchObject({ uploadUrl: "https://upload.example/signed", objectKey: expect.stringContaining("floors/floor-1/") });
    await expect(service.createUploadDescriptor({ floorId: "floor-1", mimeType, sizeBytes: 1024, sha256: "a".repeat(64) }))
      .resolves.not.toHaveProperty("publicUrl");
  });

  it("rejects unsupported MIME, oversized files, and invalid checksums", async () => {
    await expect(
      service.createUploadDescriptor({ floorId: "floor-1", mimeType: "image/svg+xml", sizeBytes: 10, sha256: "a".repeat(64) })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createUploadDescriptor({ floorId: "floor-1", mimeType: "image/png", sizeBytes: 50 * 1024 * 1024 + 1, sha256: "a".repeat(64) })
    ).rejects.toThrow("50 MB");
    await expect(
      service.createUploadDescriptor({ floorId: "floor-1", mimeType: "image/png", sizeBytes: 10, sha256: "invalid" })
    ).rejects.toThrow("sha256");
  });

  it("deletes an uploaded object from the configured bucket", async () => {
    const send = jest.fn().mockResolvedValue({});
    const deletingService = new ObjectStorageService({ send } as never, {
      bucket: "floor-assets",
      publicBaseUrl: "http://localhost:9000/floor-assets"
    });

    await deletingService.deleteObject("floors/floor-1/file.png");

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      input: { Bucket: "floor-assets", Key: "floors/floor-1/file.png" }
    }));
  });

  it("creates a 300-second signed GET for a private floor asset", async () => {
    const presignGet = jest.fn().mockResolvedValue("https://download.example/signed");
    const privateService = new ObjectStorageService({ send: jest.fn() } as never, {
      bucket: "floor-assets",
      publicBaseUrl: "",
      presignGet
    });

    await expect(privateService.createFloorAssetDownloadUrl("floors/floor-1/file.png"))
      .resolves.toBe("https://download.example/signed");
    expect(presignGet).toHaveBeenCalledWith(expect.anything(), expect.any(GetObjectCommand), 300);
    expect((presignGet.mock.calls[0][1] as GetObjectCommand).input).toEqual({
      Bucket: "floor-assets",
      Key: "floors/floor-1/file.png",
      ResponseCacheControl: "private, no-store"
    });
  });
});

describe("private report storage", () => {
  const key = "reports/20000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/attempt-1.xlsx";
  const bytes = Buffer.from("report bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  function setup() {
    const send = jest.fn().mockResolvedValue({});
    return { send, service: new ObjectStorageService({ send } as never, {
      bucket: "public-floors", publicBaseUrl: "https://public.example", reportBucket: "private-reports"
    }) };
  }
  it.each(["put", "head", "delete"])("bounds a stalled private report %s transport and aborts it", async operation => {
    jest.useFakeTimers();
    const timeout = jest.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    let outcome = "pending";
    const service = new ObjectStorageService({ send: (_command: unknown, options?: { abortSignal?: AbortSignal }) =>
      new Promise((_resolve, reject) => options?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
    } as never, { bucket: "public-floors", reportBucket: "private-reports", publicBaseUrl: "https://public.example" });
    try {
      const pending = operation === "put" ? service.putReportObject(key, bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        : operation === "head" ? service.headReportObject(key) : service.deleteReportObject(key);
      void pending.then(() => { outcome = "resolved"; }, () => { outcome = "aborted"; });
      await jest.advanceTimersByTimeAsync(3999);
      expect(outcome).toBe("pending");
      await jest.advanceTimersByTimeAsync(6001);
      expect(outcome).toBe("aborted");
    } finally { timeout.mockRestore(); jest.useRealTimers(); }
  });
  it("puts only to the private bucket with checksum/length, then HEADs with checksum mode and deletes", async () => {
    const { send, service } = setup();
    await service.putReportObject(key, bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[0][0].input).toMatchObject({ Bucket: "private-reports", Key: key, Body: bytes, ContentLength: bytes.length,
      ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"), CacheControl: "private, no-store" });
    expect(send.mock.calls[0][0].input.ACL).toBeUndefined();
    await service.headReportObject(key);
    expect(send.mock.calls[1][0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[1][0].input).toEqual({ Bucket: "private-reports", Key: key, ChecksumMode: "ENABLED" });
    await service.deleteReportObject(key);
    expect(send.mock.calls[2][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[2][0].input).toEqual({ Bucket: "private-reports", Key: key });
  });
  it.each(["floors/a/file.pdf", "reports/../../secret", key.replace("attempt-1", "attempt-0"), key.replace("attempt-1", "attempt-4"), key + "/extra"])("rejects key outside the report allowlist: %s", async invalid => {
    const { service, send } = setup();
    await expect(service.putReportObject(invalid, bytes, "application/pdf")).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.headReportObject(invalid)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.deleteReportObject(invalid)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createReportDownloadUrl(invalid, "report.pdf")).rejects.toBeInstanceOf(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects 0 and >25 MB uploads and mismatched MIME before sending", async () => {
    const { service, send } = setup();
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(25 * 1024 * 1024 + 1)]) {
      await expect(service.putReportObject(key, bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(service.putReportObject(key, bytes, "application/pdf")).rejects.toBeInstanceOf(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });
  it("creates a real 300-second signed GetObject URL with safe attachment filename and no-store", async () => {
    const client = new S3Client({ region: "us-east-1", endpoint: "https://objects.example", forcePathStyle: true,
      credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" } });
    const service = new ObjectStorageService(client, { bucket: "public-floors", publicBaseUrl: "https://public.example", reportBucket: "private-reports" });
    const url = new URL(await service.createReportDownloadUrl(key, "energy-report_2026-09-01.xlsx"));
    expect(url.pathname).toBe(`/private-reports/${key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("response-content-disposition")).toBe('attachment; filename="energy-report_2026-09-01.xlsx"');
    expect(url.searchParams.get("response-cache-control")).toBe("private, no-store");
    await expect(service.createReportDownloadUrl(key, 'bad"\r\nheader.xlsx')).rejects.toBeInstanceOf(BadRequestException);
    client.destroy();
  });
  it("refuses a report bucket configured as the public floor bucket", async () => {
    const service = new ObjectStorageService({} as never, { bucket: "same", reportBucket: "same", publicBaseUrl: "https://public.example" });
    await expect(service.headReportObject(key)).rejects.toThrow("private report bucket");
  });
  it("uses the configured report bucket through the Nest storage module", async () => {
    const previous = process.env.OBJECT_STORAGE_REPORT_BUCKET;
    process.env.OBJECT_STORAGE_REPORT_BUCKET = "configured-private-reports";
    const send = jest.fn().mockResolvedValue({});
    const module = await Test.createTestingModule({ imports: [StorageModule] })
      .overrideProvider(OBJECT_STORAGE_CLIENT).useValue({ send }).compile();
    try {
      await module.get(ObjectStorageService).headReportObject(key);
      expect(send.mock.calls[0][0].input.Bucket).toBe("configured-private-reports");
    } finally {
      await module.close();
      if (previous === undefined) delete process.env.OBJECT_STORAGE_REPORT_BUCKET; else process.env.OBJECT_STORAGE_REPORT_BUCKET = previous;
    }
  });
});

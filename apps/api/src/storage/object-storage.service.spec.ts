import { BadRequestException } from "@nestjs/common";
import { OBJECT_STORAGE_CLIENT, ObjectStorageService } from "./object-storage.service";
import { StorageModule } from "./storage.module";
import { Test } from "@nestjs/testing";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

describe("ObjectStorageService", () => {
  it("streams a rendered SVG below 8 MiB and verifies PUT/HEAD metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "rendered-storage-"));
    const path = join(root, "floor.svg");
    const bytes = gzipSync(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>한글</text></svg>"));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let put: PutObjectCommand | undefined;
    const client = { send: jest.fn(async (command: PutObjectCommand | HeadObjectCommand) => {
      if (command instanceof PutObjectCommand) { put = command; for await (const _ of command.input.Body as AsyncIterable<Uint8Array>) { /* consume */ } return {}; }
      return { ContentLength: put?.input.ContentLength, ContentType: put?.input.ContentType, ContentEncoding: put?.input.ContentEncoding,
        ChecksumSHA256: put?.input.ChecksumSHA256, Metadata: put?.input.Metadata };
    }) };
    const storage = new ObjectStorageService(client as never, { bucket: "floor-assets", publicBaseUrl: "" });
    try {
      await writeFile(path, bytes);
      await storage.putFloorRenderedObjectFile("floors/floor-1/rendered.svg", path, { sizeBytes: bytes.length, sha256 }, { width: 10, height: 20 });
      await expect(storage.verifyFloorRenderedObject("floors/floor-1/rendered.svg", {
        sizeBytes: bytes.length, sha256, mimeType: "image/svg+xml", contentEncoding: "gzip", width: 10, height: 20
      })).resolves.toBeUndefined();
      expect(put?.input.Body).not.toBeInstanceOf(Buffer);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("accepts a legacy identity SVG only when object HEAD has no content encoding", async () => {
    const send = jest.fn().mockResolvedValue({
      ContentLength: 123,
      ContentType: "image/svg+xml",
      ContentEncoding: undefined,
      ChecksumSHA256: Buffer.from("a".repeat(64), "hex").toString("base64"),
      Metadata: { "cad-width": "37", "cad-height": "23" }
    });
    const storage = new ObjectStorageService({ send } as never, { bucket: "floor-assets", publicBaseUrl: "" });

    await expect(storage.readFloorRenderedMetadata("floors/floor-1/legacy.svg", {
      sizeBytes: 123, sha256: "a".repeat(64), mimeType: "image/svg+xml", contentEncoding: null
    })).resolves.toEqual({ width: 37, height: 23 });

    send.mockResolvedValueOnce({
      ContentLength: 123,
      ContentType: "image/svg+xml",
      ContentEncoding: "gzip",
      ChecksumSHA256: Buffer.from("a".repeat(64), "hex").toString("base64"),
      Metadata: { "cad-width": "37", "cad-height": "23" }
    });
    await expect(storage.readFloorRenderedMetadata("floors/floor-1/legacy.svg", {
      sizeBytes: 123, sha256: "a".repeat(64), mimeType: "image/svg+xml", contentEncoding: null
    })).rejects.toThrow(/HEAD.*ledger/i);
  });
  const recorded = "reports/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/attempt-1.pdf";
  it("deletes only distinct recorded report keys and validates the entire batch before I/O", async () => {
    const send = jest.fn().mockResolvedValue({});
    const storage = new ObjectStorageService({ send } as never, { bucket: "floor-assets", publicBaseUrl: "" });
    await (storage as any).deleteRecordedReportObjects([recorded, recorded]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: "energy-reports", Key: recorded });
    send.mockClear();
    await expect((storage as any).deleteRecordedReportObjects([recorded, "floors/secret.png"])).rejects.toBeInstanceOf(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });
  it("redacts provider failures from recorded report deletion", async () => {
    const send = jest.fn().mockRejectedValue(new Error("SECRET-PROVIDER-ENDPOINT"));
    const storage = new ObjectStorageService({ send } as never, { bucket: "floor-assets", publicBaseUrl: "" });
    await expect((storage as any).deleteRecordedReportObjects([recorded])).rejects.toThrow("report object cleanup unavailable");
  });
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
    }), { abortSignal: expect.any(AbortSignal) });
  });

  it("bounds a stalled floor asset delete transport", async () => {
    jest.useFakeTimers();
    const timeout = jest.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    let outcome = "pending";
    const deletingService = new ObjectStorageService({
      send: (_command: unknown, options?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => options?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
    } as never, { bucket: "floor-assets", publicBaseUrl: "" });
    try {
      const pending = deletingService.deleteObject("floors/floor-1/file.png");
      void pending.then(() => { outcome = "resolved"; }, () => { outcome = "aborted"; });
      await jest.advanceTimersByTimeAsync(3_999);
      expect(outcome).toBe("pending");
      await jest.advanceTimersByTimeAsync(1);
      expect(outcome).toBe("aborted");
    } finally {
      timeout.mockRestore();
      jest.useRealTimers();
    }
  });

  it("bounds a stalled floor asset HEAD transport", async () => {
    jest.useFakeTimers();
    const timeout = jest.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    let outcome = "pending";
    const headingService = new ObjectStorageService({
      send: (_command: unknown, options?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => options?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
    } as never, { bucket: "floor-assets", publicBaseUrl: "" });
    try {
      const pending = headingService.headObject("floors/floor-1/file.png");
      void pending.then(() => { outcome = "resolved"; }, () => { outcome = "aborted"; });
      await jest.advanceTimersByTimeAsync(3_999);
      expect(outcome).toBe("pending");
      await jest.advanceTimersByTimeAsync(1);
      expect(outcome).toBe("aborted");
    } finally {
      timeout.mockRestore();
      jest.useRealTimers();
    }
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

  it("signs browser PUT and GET URLs with the client-facing bucket base", async () => {
    const previous = {
      endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
      publicUrl: process.env.OBJECT_STORAGE_PUBLIC_URL,
      bucket: process.env.OBJECT_STORAGE_BUCKET,
      reportBucket: process.env.OBJECT_STORAGE_REPORT_BUCKET,
      region: process.env.OBJECT_STORAGE_REGION,
      accessKey: process.env.OBJECT_STORAGE_ACCESS_KEY,
      secretKey: process.env.OBJECT_STORAGE_SECRET_KEY
    };
    Object.assign(process.env, {
      OBJECT_STORAGE_ENDPOINT: "http://object-storage:9000",
      OBJECT_STORAGE_PUBLIC_URL: "https://browser.example/s3/floor-assets",
      OBJECT_STORAGE_BUCKET: "floor-assets",
      OBJECT_STORAGE_REPORT_BUCKET: "private-reports",
      OBJECT_STORAGE_REGION: "ap-northeast-2",
      OBJECT_STORAGE_ACCESS_KEY: "browser-test-access",
      OBJECT_STORAGE_SECRET_KEY: "browser-test-secret"
    });
    const module = await Test.createTestingModule({ imports: [StorageModule] }).compile();
    try {
      const moduleService = module.get(ObjectStorageService);
      const upload = new URL(await moduleService.createFloorAssetUploadUrl({
        objectKey: "floors/floor-1/file.png",
        mimeType: "image/png",
        sizeBytes: 1024,
        sha256: "a".repeat(64)
      }));
      const floorDownload = new URL(await moduleService.createFloorAssetDownloadUrl("floors/floor-1/file.png"));
      const reportDownload = new URL(await moduleService.createReportDownloadUrl(
        "reports/20000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/attempt-1.xlsx",
        "energy-report.xlsx"
      ));

      for (const signedUrl of [upload, floorDownload, reportDownload]) {
        expect(signedUrl.origin).toBe("https://browser.example");
        expect(signedUrl.searchParams.get("X-Amz-Credential")).toContain(
          "browser-test-access/"
        );
        expect(signedUrl.searchParams.get("X-Amz-Credential")).toContain(
          "/ap-northeast-2/s3/aws4_request"
        );
      }
      expect(upload.pathname).toBe("/s3/floor-assets/floors/floor-1/file.png");
      expect(floorDownload.pathname).toBe("/s3/floor-assets/floors/floor-1/file.png");
      expect(reportDownload.pathname).toBe(
        "/s3/private-reports/reports/20000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/attempt-1.xlsx"
      );
    } finally {
      await module.close();
      restoreEnvironment(previous);
    }
  });

  it("fails closed when the client-facing bucket URL is omitted in production", async () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      publicUrl: process.env.OBJECT_STORAGE_PUBLIC_URL
    };
    process.env.NODE_ENV = "production";
    delete process.env.OBJECT_STORAGE_PUBLIC_URL;
    try {
      await expect(Test.createTestingModule({ imports: [StorageModule] }).compile())
        .rejects.toThrow("OBJECT_STORAGE_PUBLIC_URL is required in production");
    } finally {
      restoreEnvironment(previous);
    }
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
  it("distinguishes missing report objects from measured zero-byte objects", async () => {
    const { send, service } = setup();
    send.mockResolvedValueOnce({ ContentLength: 0 }).mockResolvedValueOnce({ ContentLength: 123 });
    await expect(service.inspectReportObject(key)).resolves.toEqual({ exists: true, sizeBytes: 0 });
    await expect(service.inspectReportObject(key)).resolves.toEqual({ exists: true, sizeBytes: 123 });
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 }, message: "private bucket" });
    await expect(service.inspectReportObject(key)).resolves.toEqual({ exists: false });
  });
  it.each([undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("refuses an unmeasured HEAD size %s", async ContentLength => {
    const { send, service } = setup();
    send.mockResolvedValue({ ContentLength });
    await expect(service.inspectReportObject(key)).rejects.toThrow("invalid report object size");
  });
  it.each([403, 500])("does not treat a HEAD %s as object absence", async httpStatusCode => {
    const { send, service } = setup();
    send.mockRejectedValue({ $metadata: { httpStatusCode }, message: "private error" });
    await expect(service.inspectReportObject(key)).rejects.toMatchObject({ $metadata: { httpStatusCode } });
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

function restoreEnvironment(previous: Record<string, string | undefined>) {
  const keys: Record<string, string> = {
    endpoint: "OBJECT_STORAGE_ENDPOINT",
    publicUrl: "OBJECT_STORAGE_PUBLIC_URL",
    bucket: "OBJECT_STORAGE_BUCKET",
    reportBucket: "OBJECT_STORAGE_REPORT_BUCKET",
    region: "OBJECT_STORAGE_REGION",
    accessKey: "OBJECT_STORAGE_ACCESS_KEY",
    secretKey: "OBJECT_STORAGE_SECRET_KEY",
    nodeEnv: "NODE_ENV"
  };
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[keys[key]];
    else process.env[keys[key]] = value;
  }
}

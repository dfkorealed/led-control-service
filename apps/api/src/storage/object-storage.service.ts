import { BadRequestException, Inject, Injectable, Optional, ServiceUnavailableException } from "@nestjs/common";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import {
  CAD_SCENE_MAX_MANIFEST_BYTES,
  cadSceneManifestSchema,
  type CadBounds,
  type CadSceneManifest
} from "@led-control/shared";

export const OBJECT_STORAGE_CLIENT = Symbol("OBJECT_STORAGE_CLIENT");
export const OBJECT_STORAGE_PRESIGN_CLIENT = Symbol("OBJECT_STORAGE_PRESIGN_CLIENT");
export const OBJECT_STORAGE_OPTIONS = Symbol("OBJECT_STORAGE_OPTIONS");

export interface ObjectStorageOptions {
  bucket: string;
  publicBaseUrl: string;
  reportBucket?: string;
  presign?: (client: S3Client, command: PutObjectCommand) => Promise<string>;
  presignGet?: (client: S3Client, command: GetObjectCommand, expiresInSeconds: number) => Promise<string>;
}

@Injectable()
export class ObjectStorageService {
  constructor(
    @Inject(OBJECT_STORAGE_CLIENT) private readonly client: S3Client,
    @Inject(OBJECT_STORAGE_OPTIONS) private readonly options: ObjectStorageOptions,
    @Optional() @Inject(OBJECT_STORAGE_PRESIGN_CLIENT) private readonly presignClient?: S3Client
  ) {}

  async probeReadiness(abortSignal: AbortSignal) {
    await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }), { abortSignal });
  }

  async putReportObject(key: string, bytes: Buffer, contentType: string) {
    const Bucket = this.reportBucket(key);
    // Historical XLSX object keys are valid only for cleanup reads/deletes.
    if (!key.endsWith(".pdf")) throw new BadRequestException("invalid report upload key");
    if (bytes.length < 1 || bytes.length > 25 * 1024 * 1024) throw new BadRequestException("report size must be between 1 byte and 25 MB");
    if (contentType !== "application/pdf") {
      throw new BadRequestException("invalid report MIME type");
    }
    return this.client.send(new PutObjectCommand({ Bucket, Key: key, Body: bytes, ContentType: contentType,
      ContentLength: bytes.length, ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"), CacheControl: "private, no-store" }),
    // Bound transport work. Only the persistent cleanup ledger, not this timeout,
    // handles a paused worker resuming later or a successful PUT with a lost response.
    { abortSignal: AbortSignal.timeout(10_000) });
  }

  async headReportObject(key: string) {
    return this.client.send(new HeadObjectCommand({ Bucket: this.reportBucket(key), Key: key, ChecksumMode: "ENABLED" }),
      { abortSignal: AbortSignal.timeout(4_000) });
  }

  async inspectReportObject(key: string): Promise<{ exists: false } | { exists: true; sizeBytes: number }> {
    let head;
    try { head = await this.headReportObject(key); }
    catch (error) {
      // HEAD 404 is the expected state for unused/deleted attempt keys. Permission,
      // transport and server failures must not masquerade as successful cleanup.
      if (error && typeof error === "object" && "$metadata" in error
        && (error.$metadata as { httpStatusCode?: number } | undefined)?.httpStatusCode === 404) return { exists: false };
      throw error;
    }
    if (head.ContentLength === undefined || !Number.isSafeInteger(head.ContentLength) || head.ContentLength < 0) {
      throw new Error("invalid report object size");
    }
    return { exists: true, sizeBytes: head.ContentLength };
  }

  async deleteReportObject(key: string) {
    return this.client.send(new DeleteObjectCommand({ Bucket: this.reportBucket(key), Key: key }),
      { abortSignal: AbortSignal.timeout(4_000) });
  }

  async deleteRecordedReportObjects(value: unknown): Promise<void> {
    if (!Array.isArray(value) || value.some(key => typeof key !== "string")) {
      throw new BadRequestException("invalid recorded report object keys");
    }
    const keys = [...new Set(value as string[])];
    // 전체 목록을 먼저 검증하여 뒤쪽의 잘못된 키 때문에 부분 삭제가 발생하지 않게 한다.
    keys.forEach(key => this.reportBucket(key));
    try {
      for (const key of keys) await this.deleteReportObject(key);
    } catch {
      throw new ServiceUnavailableException("report object cleanup unavailable");
    }
  }

  async createReportDownloadUrl(key: string, filename: string): Promise<string> {
    const Bucket = this.reportBucket(key);
    // Historical XLSX keys remain valid for HEAD/DELETE cleanup, never for new downloads.
    if (!key.endsWith(".pdf") || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,180}\.pdf$/.test(filename)) {
      throw new BadRequestException("invalid report filename");
    }
    return getSignedUrl(this.signingClient, new GetObjectCommand({ Bucket, Key: key,
      ResponseContentDisposition: `attachment; filename="${filename}"`, ResponseCacheControl: "private, no-store" }), { expiresIn: 300 });
  }

  async createFloorAssetDownloadUrl(objectKey: string): Promise<string> {
    this.assertFloorObjectKey(objectKey);
    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: objectKey,
      ResponseCacheControl: "private, no-store"
    });
    const expiresInSeconds = 300;
    const presign = this.options.presignGet
      ?? ((client: S3Client, request: GetObjectCommand, expires: number) => getSignedUrl(client, request, { expiresIn: expires }));
    return presign(this.signingClient, command, expiresInSeconds);
  }

  private reportBucket(key: string) {
    const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
    if (!new RegExp(`^reports/${uuid}/${uuid}/attempt-[1-3]\\.(xlsx|pdf)$`, "i").test(key)) throw new BadRequestException("invalid report object key");
    // Reports use a separate bucket so their lifecycle and key allowlist remain independent.
    const bucket = this.options.reportBucket ?? "energy-reports";
    if (!bucket || bucket === this.options.bucket) throw new Error("a separate private report bucket is required");
    return bucket;
  }

  async createUploadDescriptor(input: { floorId: string; mimeType: string; sizeBytes: number; sha256: string }) {
    const prepared = this.prepareFloorAssetUpload(input);
    const uploadUrl = await this.createFloorAssetUploadUrl({ ...input, ...prepared });
    return { ...prepared, uploadUrl };
  }

  prepareFloorAssetUpload(input: { floorId: string; mimeType: string; sizeBytes: number; sha256: string }) {
    this.validateUpload(input);
    const extension = extensionForMime(input.mimeType);
    const objectKey = `floors/${input.floorId}/${randomUUID()}.${extension}`;
    const checksumBase64 = Buffer.from(input.sha256, "hex").toString("base64");
    return { objectKey, checksumBase64, expiresInSeconds: 300 };
  }

  async createFloorAssetUploadUrl(input: {
    objectKey: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  }) {
    this.validateUpload(input);
    if (!/^floors\/[^/]+\/[A-Za-z0-9._-]+$/.test(input.objectKey)) {
      throw new BadRequestException("invalid floor asset object key");
    }
    const checksumBase64 = Buffer.from(input.sha256, "hex").toString("base64");
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: input.objectKey,
      ContentType: input.mimeType,
      ContentLength: input.sizeBytes,
      ChecksumSHA256: checksumBase64
    });
    const presign = this.options.presign ?? ((client, request) => getSignedUrl(client, request, { expiresIn: 300 }));
    return presign(this.signingClient, command);
  }

  async headObject(objectKey: string) {
    return this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey, ChecksumMode: "ENABLED" }),
      { abortSignal: AbortSignal.timeout(4_000) });
  }

  async deleteObject(objectKey: string) {
    return this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: objectKey }),
      { abortSignal: AbortSignal.timeout(4_000) });
  }

  async downloadFloorAssetToFile(
    objectKey: string,
    outputPath: string,
    options: {
      maxBytes: number;
      expectedBytes: number;
      expectedMimeType: string;
      expectedSha256: string;
      abortSignal?: AbortSignal;
    }
  ) {
    this.assertFloorObjectKey(objectKey);
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 ||
        !Number.isSafeInteger(options.expectedBytes) || options.expectedBytes < 1 ||
        options.expectedBytes > options.maxBytes || !/^[a-f0-9]{64}$/.test(options.expectedSha256)) {
      throw new BadRequestException("invalid floor asset download byte limit");
    }
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: objectKey, ChecksumMode: "ENABLED" }),
      { abortSignal: boundedAbortSignal(options.abortSignal, 15_000) }
    );
    if (!result.Body || result.ContentLength !== options.expectedBytes || result.ContentLength > options.maxBytes ||
        result.ContentType !== options.expectedMimeType) {
      throw new BadRequestException("floor asset object metadata does not match its ledger");
    }
    const expectedBase64 = Buffer.from(options.expectedSha256, "hex").toString("base64");
    if (result.ChecksumSHA256 && result.ChecksumSHA256 !== expectedBase64) {
      throw new BadRequestException("floor asset object checksum does not match its ledger");
    }

    const file = await open(outputPath, "wx", 0o600);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const value of result.Body as AsyncIterable<Uint8Array | string>) {
        if (options.abortSignal?.aborted) throw new Error("floor asset download aborted");
        const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
        sizeBytes += chunk.length;
        if (sizeBytes > options.maxBytes || sizeBytes > options.expectedBytes) {
          throw new BadRequestException("floor asset download byte limit exceeded");
        }
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      const sha256 = hash.digest("hex");
      if (sizeBytes !== options.expectedBytes || sha256 !== options.expectedSha256) {
        throw new BadRequestException("floor asset downloaded bytes do not match its ledger");
      }
      return { sizeBytes, sha256 };
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(outputPath).catch(() => undefined);
      throw error;
    } finally {
      await file.close().catch(() => undefined);
    }
  }

  async putFloorRenderedObject(
    objectKey: string,
    bytes: Buffer,
    viewport: { width: number; height: number },
    abortSignal?: AbortSignal
  ) {
    this.assertFloorObjectKey(objectKey);
    if (!objectKey.endsWith(".svg") || bytes.length < 1 || bytes.length > 8 * 1024 * 1024 ||
        !validViewportDimension(viewport.width) || !validViewportDimension(viewport.height)) {
      throw new BadRequestException("invalid rendered floor SVG");
    }
    return this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: objectKey,
      Body: bytes,
      ContentType: "image/svg+xml",
      ContentLength: bytes.length,
      ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
      CacheControl: "private, no-store",
      Metadata: { "cad-width": String(viewport.width), "cad-height": String(viewport.height) }
    }), { abortSignal: boundedAbortSignal(abortSignal, 10_000) });
  }

  async putFloorRenderedObjectFile(
    objectKey: string,
    inputPath: string,
    expected: { sizeBytes: number; sha256: string },
    viewport: { width: number; height: number },
    abortSignal?: AbortSignal
  ) {
    this.assertFloorObjectKey(objectKey);
    const file = await stat(inputPath);
    if (!objectKey.endsWith(".svg") || !file.isFile() || file.size !== expected.sizeBytes ||
        file.size < 1 || file.size > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(expected.sha256) ||
        !validViewportDimension(viewport.width) || !validViewportDimension(viewport.height)) {
      throw new BadRequestException("invalid rendered floor SVG");
    }
    return this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: objectKey,
      Body: createReadStream(inputPath),
      ContentType: "image/svg+xml",
      ContentEncoding: "gzip",
      ContentLength: file.size,
      ChecksumSHA256: Buffer.from(expected.sha256, "hex").toString("base64"),
      CacheControl: "private, no-store",
      Metadata: { "cad-width": String(viewport.width), "cad-height": String(viewport.height) }
    }), { abortSignal: boundedAbortSignal(abortSignal, 10_000) });
  }

  async verifyFloorRenderedObject(
    objectKey: string,
    expected: { sizeBytes: number; sha256: string; mimeType: "image/svg+xml"; width: number; height: number; contentEncoding?: "gzip" },
    abortSignal?: AbortSignal
  ) {
    this.assertFloorObjectKey(objectKey);
    const head = await this.client.send(
      new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey, ChecksumMode: "ENABLED" }),
      { abortSignal: boundedAbortSignal(abortSignal, 4_000) }
    );
    if (head.ContentLength !== expected.sizeBytes || head.ContentType !== expected.mimeType ||
        (expected.contentEncoding !== undefined && head.ContentEncoding !== expected.contentEncoding) ||
        head.ChecksumSHA256 !== Buffer.from(expected.sha256, "hex").toString("base64") ||
        head.Metadata?.["cad-width"] !== String(expected.width) || head.Metadata?.["cad-height"] !== String(expected.height)) {
      throw new Error("rendered floor asset storage verification failed");
    }
  }

  async readFloorRenderedMetadata(
    objectKey: string,
    expected: { sizeBytes: number; sha256: string; mimeType: "image/svg+xml"; contentEncoding: "gzip" | null },
    abortSignal?: AbortSignal
  ) {
    const inspected = await this.inspectFloorRenderedMetadata(objectKey, expected, abortSignal);
    if (inspected.contentEncoding !== expected.contentEncoding) {
      throw new Error("rendered floor asset HEAD does not match its ledger");
    }
    return { width: inspected.width, height: inspected.height };
  }

  async inspectFloorRenderedMetadata(
    objectKey: string,
    expected: { sizeBytes: number; sha256: string; mimeType: "image/svg+xml" },
    abortSignal?: AbortSignal
  ) {
    this.assertFloorObjectKey(objectKey);
    if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 1 ||
        !/^[a-f0-9]{64}$/.test(expected.sha256)) {
      throw new Error("rendered floor asset ledger metadata is invalid");
    }
    const head = await this.client.send(
      new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey, ChecksumMode: "ENABLED" }),
      { abortSignal: boundedAbortSignal(abortSignal, 4_000) }
    );
    const width = Number(head.Metadata?.["cad-width"]);
    const height = Number(head.Metadata?.["cad-height"]);
    const contentEncoding = head.ContentEncoding ?? null;
    if (head.ContentLength !== expected.sizeBytes || head.ContentType !== expected.mimeType ||
        (contentEncoding !== null && contentEncoding !== "gzip") ||
        head.ChecksumSHA256 !== Buffer.from(expected.sha256, "hex").toString("base64") ||
        !validViewportDimension(width) || !validViewportDimension(height)) {
      throw new Error("rendered floor asset HEAD does not match its ledger");
    }
    return { width, height, contentEncoding } as { width: number; height: number; contentEncoding: "gzip" | null };
  }

  async readCadRegionPreviewMetadata(
    objectKey: string,
    expected: {
      sizeBytes: number;
      sha256: string;
      regionId: string;
      bounds: { minX: number; minY: number; maxX: number; maxY: number };
    },
    abortSignal?: AbortSignal
  ) {
    this.assertFloorObjectKey(objectKey);
    if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 1 ||
        !/^[a-f0-9]{64}$/.test(expected.sha256)) {
      throw new Error("CAD region preview ledger metadata is invalid");
    }
    const head = await this.client.send(
      new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey, ChecksumMode: "ENABLED" }),
      { abortSignal: boundedAbortSignal(abortSignal, 4_000) }
    );
    const metadata = head.Metadata ?? {};
    const width = Number(metadata["cad-width"]);
    const height = Number(metadata["cad-height"]);
    const textCount = Number(metadata["cad-text-count"]);
    const lightCandidateCount = Number(metadata["cad-light-count"]);
    const area = Number(metadata["cad-area"]);
    const bounds = expected.bounds;
    if (head.ContentLength !== expected.sizeBytes || head.ContentType !== "image/svg+xml" ||
        head.ContentEncoding !== "gzip" ||
        head.ChecksumSHA256 !== Buffer.from(expected.sha256, "hex").toString("base64") ||
        metadata["cad-region-id"] !== expected.regionId ||
        metadata["cad-min-x"] !== String(bounds.minX) || metadata["cad-min-y"] !== String(bounds.minY) ||
        metadata["cad-max-x"] !== String(bounds.maxX) || metadata["cad-max-y"] !== String(bounds.maxY) ||
        !validViewportDimension(width) || !validViewportDimension(height) ||
        !Number.isSafeInteger(textCount) || textCount < 0 ||
        !Number.isSafeInteger(lightCandidateCount) || lightCandidateCount < 0 ||
        !Number.isFinite(area) || area <= 0 || area !== (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY)) {
      throw new Error("CAD region preview HEAD does not match its ledger");
    }
    return { width, height, textCount, lightCandidateCount, area };
  }

  async readCadSceneManifest(
    objectKey: string,
    expected: { sizeBytes: number; sha256: string },
    abortSignal?: AbortSignal
  ): Promise<CadSceneManifest> {
    this.assertFloorObjectKey(objectKey);
    if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 1 ||
        expected.sizeBytes > CAD_SCENE_MAX_MANIFEST_BYTES || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
      throw new Error("CAD scene manifest ledger metadata is invalid");
    }
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: objectKey, ChecksumMode: "ENABLED" }),
      { abortSignal: boundedAbortSignal(abortSignal, 10_000) }
    );
    if (!result.Body || result.ContentLength !== expected.sizeBytes || result.ContentType !== "application/json" ||
        result.ContentEncoding !== undefined ||
        result.ChecksumSHA256 !== Buffer.from(expected.sha256, "hex").toString("base64")) {
      throw new Error("CAD scene manifest object does not match its ledger");
    }
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const value of result.Body as AsyncIterable<Uint8Array | string>) {
      const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
      sizeBytes += chunk.length;
      if (sizeBytes > expected.sizeBytes || sizeBytes > CAD_SCENE_MAX_MANIFEST_BYTES) {
        throw new Error("CAD scene manifest byte limit exceeded");
      }
      hash.update(chunk);
      chunks.push(chunk);
    }
    if (sizeBytes !== expected.sizeBytes || hash.digest("hex") !== expected.sha256) {
      throw new Error("CAD scene manifest bytes do not match its ledger");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks, sizeBytes).toString("utf8")); }
    catch { throw new Error("CAD scene manifest JSON is invalid"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("CAD scene manifest JSON is invalid");
    }
    return cadSceneManifestSchema.parse({ ...parsed, byteSize: expected.sizeBytes, sha256: expected.sha256 });
  }

  async putCadSceneObjectFile(
    objectKey: string,
    inputPath: string,
    expected: {
      sizeBytes: number;
      sha256: string;
      contentType: string;
      contentEncoding?: "gzip";
      metadata?: Record<string, string>;
    },
    abortSignal?: AbortSignal
  ): Promise<void> {
    this.assertFloorObjectKey(objectKey);
    const file = await stat(inputPath);
    if (!file.isFile() || file.size !== expected.sizeBytes || file.size < 1 ||
        !/^[a-f0-9]{64}$/.test(expected.sha256)) {
      throw new Error("CAD scene file does not match its ledger");
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(inputPath)) hash.update(chunk);
    if (hash.digest("hex") !== expected.sha256) throw new Error("CAD scene file checksum does not match its ledger");
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: objectKey,
      Body: createReadStream(inputPath),
      ContentType: expected.contentType,
      ...(expected.contentEncoding ? { ContentEncoding: expected.contentEncoding } : {}),
      ContentLength: expected.sizeBytes,
      ChecksumSHA256: Buffer.from(expected.sha256, "hex").toString("base64"),
      CacheControl: "private, no-store",
      ...(expected.metadata ? { Metadata: expected.metadata } : {})
    }), { abortSignal: boundedAbortSignal(abortSignal, 10_000) });
  }

  async verifyCadSceneObject(
    objectKey: string,
    expected: {
      sizeBytes: number;
      sha256: string;
      contentType: string;
      contentEncoding?: "gzip";
      bounds?: CadBounds;
      metadata?: Record<string, string>;
    },
    abortSignal?: AbortSignal
  ): Promise<void> {
    this.assertFloorObjectKey(objectKey);
    if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 1 ||
        !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error("CAD scene object ledger metadata is invalid");
    const head = await this.client.send(
      new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey, ChecksumMode: "ENABLED" }),
      { abortSignal: boundedAbortSignal(abortSignal, 4_000) }
    );
    const metadata = head.Metadata ?? {};
    if (head.ContentLength !== expected.sizeBytes || head.ContentType !== expected.contentType ||
        head.ContentEncoding !== expected.contentEncoding ||
        head.ChecksumSHA256 !== Buffer.from(expected.sha256, "hex").toString("base64")) {
      throw new Error("CAD scene object HEAD does not match its ledger");
    }
    if (expected.bounds && (
      metadata["cad-min-x"] !== String(expected.bounds.minX) ||
      metadata["cad-min-y"] !== String(expected.bounds.minY) ||
      metadata["cad-max-x"] !== String(expected.bounds.maxX) ||
      metadata["cad-max-y"] !== String(expected.bounds.maxY)
    )) throw new Error("CAD scene tile bounds do not match its ledger");
    if (expected.metadata && Object.entries(expected.metadata).some(([key, value]) => metadata[key] !== value)) {
      throw new Error("CAD scene object metadata does not match its ledger");
    }
  }

  private validateUpload(input: { mimeType: string; sizeBytes: number; sha256: string }) {
    if (!Object.hasOwn(extensions, input.mimeType)) throw new BadRequestException("unsupported floor asset MIME type");
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 50 * 1024 * 1024) {
      throw new BadRequestException("floor asset size must be between 1 byte and 50 MB");
    }
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new BadRequestException("sha256 must be a 64-character hex digest");
  }

  private assertFloorObjectKey(objectKey: string) {
    if (!/^floors\/[^/]+\/[A-Za-z0-9._-]+$/.test(objectKey)) {
      throw new BadRequestException("invalid floor asset object key");
    }
  }

  private get signingClient() {
    return this.presignClient ?? this.client;
  }
}

const extensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/acad": "dwg",
  "application/x-acad": "dwg",
  "application/autocad": "dwg",
  "application/dwg": "dwg",
  "application/x-dwg": "dwg",
  "application/vnd.autodesk.autocad.dwg": "dwg",
  "image/vnd.dwg": "dwg",
  "image/x-dwg": "dwg",
  "application/dxf": "dxf",
  "application/x-dxf": "dxf",
  "application/vnd.autodesk.autocad.dxf": "dxf",
  "image/vnd.dxf": "dxf",
  "image/x-dxf": "dxf"
};

function extensionForMime(mimeType: string) {
  return extensions[mimeType];
}

function validViewportDimension(value: number) {
  return Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
}

function boundedAbortSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

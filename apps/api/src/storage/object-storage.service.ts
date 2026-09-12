import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, randomUUID } from "node:crypto";

export const OBJECT_STORAGE_CLIENT = Symbol("OBJECT_STORAGE_CLIENT");
export const OBJECT_STORAGE_OPTIONS = Symbol("OBJECT_STORAGE_OPTIONS");

export interface ObjectStorageOptions {
  bucket: string;
  publicBaseUrl: string;
  reportBucket?: string;
  presign?: (client: S3Client, command: PutObjectCommand) => Promise<string>;
}

@Injectable()
export class ObjectStorageService {
  constructor(
    @Inject(OBJECT_STORAGE_CLIENT) private readonly client: S3Client,
    @Inject(OBJECT_STORAGE_OPTIONS) private readonly options: ObjectStorageOptions
  ) {}

  async putReportObject(key: string, bytes: Buffer, contentType: string) {
    const Bucket = this.reportBucket(key);
    if (bytes.length < 1 || bytes.length > 25 * 1024 * 1024) throw new BadRequestException("report size must be between 1 byte and 25 MB");
    if (contentType !== (key.endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")) {
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

  async createReportDownloadUrl(key: string, filename: string): Promise<string> {
    const Bucket = this.reportBucket(key);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,180}\.(xlsx|pdf)$/.test(filename) || !filename.endsWith(key.slice(key.lastIndexOf(".")))) {
      throw new BadRequestException("invalid report filename");
    }
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket, Key: key,
      ResponseContentDisposition: `attachment; filename="${filename}"`, ResponseCacheControl: "private, no-store" }), { expiresIn: 300 });
  }

  private reportBucket(key: string) {
    const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
    if (!new RegExp(`^reports/${uuid}/${uuid}/attempt-[1-3]\\.(xlsx|pdf)$`, "i").test(key)) throw new BadRequestException("invalid report object key");
    // Floor assets have an anonymous read policy. Reports must never share that bucket.
    const bucket = this.options.reportBucket ?? "energy-reports";
    if (!bucket || bucket === this.options.bucket) throw new Error("a separate private report bucket is required");
    return bucket;
  }

  async createUploadDescriptor(input: { floorId: string; mimeType: string; sizeBytes: number; sha256: string }) {
    this.validateUpload(input);
    const extension = extensionForMime(input.mimeType);
    const objectKey = `floors/${input.floorId}/${randomUUID()}.${extension}`;
    const checksumBase64 = Buffer.from(input.sha256, "hex").toString("base64");
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: objectKey,
      ContentType: input.mimeType,
      ContentLength: input.sizeBytes,
      ChecksumSHA256: checksumBase64
    });
    const presign = this.options.presign ?? ((client, request) => getSignedUrl(client, request, { expiresIn: 300 }));
    const uploadUrl = await presign(this.client, command);
    return {
      objectKey,
      uploadUrl,
      publicUrl: `${this.options.publicBaseUrl.replace(/\/$/, "")}/${objectKey}`,
      checksumBase64,
      expiresInSeconds: 300
    };
  }

  async headObject(objectKey: string) {
    return this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey, ChecksumMode: "ENABLED" }));
  }

  async deleteObject(objectKey: string) {
    return this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: objectKey }));
  }

  private validateUpload(input: { mimeType: string; sizeBytes: number; sha256: string }) {
    if (!Object.hasOwn(extensions, input.mimeType)) throw new BadRequestException("unsupported floor asset MIME type");
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 50 * 1024 * 1024) {
      throw new BadRequestException("floor asset size must be between 1 byte and 50 MB");
    }
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new BadRequestException("sha256 must be a 64-character hex digest");
  }
}

const extensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf"
};

function extensionForMime(mimeType: string) {
  return extensions[mimeType];
}

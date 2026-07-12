import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

export const OBJECT_STORAGE_CLIENT = Symbol("OBJECT_STORAGE_CLIENT");
export const OBJECT_STORAGE_OPTIONS = Symbol("OBJECT_STORAGE_OPTIONS");

export interface ObjectStorageOptions {
  bucket: string;
  publicBaseUrl: string;
  presign?: (client: S3Client, command: PutObjectCommand) => Promise<string>;
}

@Injectable()
export class ObjectStorageService {
  constructor(
    @Inject(OBJECT_STORAGE_CLIENT) private readonly client: S3Client,
    @Inject(OBJECT_STORAGE_OPTIONS) private readonly options: ObjectStorageOptions
  ) {}

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
    return this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey }));
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

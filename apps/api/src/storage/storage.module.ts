import { Module } from "@nestjs/common";
import { S3Client } from "@aws-sdk/client-s3";
import {
  OBJECT_STORAGE_CLIENT,
  OBJECT_STORAGE_OPTIONS,
  OBJECT_STORAGE_PRESIGN_CLIENT,
  ObjectStorageService,
  type ObjectStorageOptions
} from "./object-storage.service";
import { PrismaModule } from "../prisma/prisma.module";
import { FloorRenderedAssetReconciler } from "./floor-rendered-asset-reconciler";

const OBJECT_STORAGE_CONNECTION_OPTIONS = Symbol("OBJECT_STORAGE_CONNECTION_OPTIONS");

interface ObjectStorageConnectionOptions {
  endpoint: string;
  region: string;
  forcePathStyle: true;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: OBJECT_STORAGE_OPTIONS,
      useFactory: (): ObjectStorageOptions => createObjectStorageOptions(process.env)
    },
    {
      provide: OBJECT_STORAGE_CONNECTION_OPTIONS,
      useFactory: (): ObjectStorageConnectionOptions => ({
        endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? "http://localhost:9000",
        region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1",
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY ?? "led-floor-assets",
          secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY ?? "change-this-local-secret"
        }
      })
    },
    {
      provide: OBJECT_STORAGE_CLIENT,
      inject: [OBJECT_STORAGE_CONNECTION_OPTIONS],
      useFactory: (connection: ObjectStorageConnectionOptions) => new S3Client(connection)
    },
    {
      provide: OBJECT_STORAGE_PRESIGN_CLIENT,
      inject: [OBJECT_STORAGE_CONNECTION_OPTIONS, OBJECT_STORAGE_OPTIONS],
      useFactory: (connection: ObjectStorageConnectionOptions, options: ObjectStorageOptions) =>
        new S3Client({
          ...connection,
          endpoint: clientFacingObjectStorageEndpoint(options.publicBaseUrl, options.bucket)
        })
    },
    ObjectStorageService,
    FloorRenderedAssetReconciler
  ],
  exports: [
    ObjectStorageService,
    FloorRenderedAssetReconciler,
    OBJECT_STORAGE_CLIENT,
    OBJECT_STORAGE_OPTIONS
  ]
})
export class StorageModule {}

function createObjectStorageOptions(env: NodeJS.ProcessEnv): ObjectStorageOptions {
  const bucket = env.OBJECT_STORAGE_BUCKET ?? "floor-assets";
  const internalEndpoint = env.OBJECT_STORAGE_ENDPOINT ?? "http://localhost:9000";
  const publicBaseUrl = env.OBJECT_STORAGE_PUBLIC_URL
    ?? (env.NODE_ENV === "production" ? requiredPublicUrl() : bucketBaseUrl(internalEndpoint, bucket));
  return {
    bucket,
    reportBucket: env.OBJECT_STORAGE_REPORT_BUCKET ?? "energy-reports",
    publicBaseUrl
  };
}

function requiredPublicUrl(): never {
  throw new Error("OBJECT_STORAGE_PUBLIC_URL is required in production");
}

function bucketBaseUrl(endpoint: string, bucket: string): string {
  const url = parseHttpUrl(endpoint, "OBJECT_STORAGE_ENDPOINT");
  const prefix = url.pathname.replace(/\/$/, "");
  url.pathname = `${prefix}/${encodeURIComponent(bucket)}`;
  return url.toString();
}

export function clientFacingObjectStorageEndpoint(publicBaseUrl: string, bucket: string): string {
  const url = parseHttpUrl(publicBaseUrl, "OBJECT_STORAGE_PUBLIC_URL");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("OBJECT_STORAGE_PUBLIC_URL must not include credentials, query parameters, or a fragment");
  }
  const bucketPath = url.pathname.replace(/\/$/, "");
  const separator = bucketPath.lastIndexOf("/");
  let configuredBucket: string;
  try {
    configuredBucket = decodeURIComponent(bucketPath.slice(separator + 1));
  } catch {
    throw new Error("OBJECT_STORAGE_PUBLIC_URL must end with the configured bucket");
  }
  if (configuredBucket !== bucket) {
    throw new Error("OBJECT_STORAGE_PUBLIC_URL must end with the configured bucket");
  }
  url.pathname = bucketPath.slice(0, separator) || "/";
  return url.toString();
}

function parseHttpUrl(value: string, key: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${key} must be an absolute HTTP(S) URL`);
  }
  return url;
}

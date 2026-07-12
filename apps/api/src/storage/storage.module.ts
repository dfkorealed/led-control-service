import { Module } from "@nestjs/common";
import { S3Client } from "@aws-sdk/client-s3";
import {
  OBJECT_STORAGE_CLIENT,
  OBJECT_STORAGE_OPTIONS,
  ObjectStorageService,
  type ObjectStorageOptions
} from "./object-storage.service";

@Module({
  providers: [
    {
      provide: OBJECT_STORAGE_OPTIONS,
      useFactory: (): ObjectStorageOptions => ({
        bucket: process.env.OBJECT_STORAGE_BUCKET ?? "floor-assets",
        publicBaseUrl: process.env.OBJECT_STORAGE_PUBLIC_URL ?? "http://localhost:9000/floor-assets"
      })
    },
    {
      provide: OBJECT_STORAGE_CLIENT,
      useFactory: () =>
        new S3Client({
          region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1",
          endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? "http://localhost:9000",
          forcePathStyle: true,
          credentials: {
            accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY ?? "led-floor-assets",
            secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY ?? "change-this-local-secret"
          }
        })
    },
    ObjectStorageService
  ],
  exports: [ObjectStorageService]
})
export class StorageModule {}

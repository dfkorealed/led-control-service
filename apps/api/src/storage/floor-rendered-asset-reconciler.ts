import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "./object-storage.service";

export interface RenderedFloorAssetLedger {
  id: string;
  objectKey: string;
  mimeType: string;
  contentEncoding: string | null;
  sizeBytes: bigint;
  sha256: string;
}

export interface ReconciledRenderedMetadata {
  width: number;
  height: number;
  contentEncoding: "gzip" | null;
}

@Injectable()
export class FloorRenderedAssetReconciler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService
  ) {}

  async reconcile(asset: RenderedFloorAssetLedger): Promise<ReconciledRenderedMetadata> {
    const sizeBytes = Number(asset.sizeBytes);
    if (asset.mimeType !== "image/svg+xml" || !Number.isSafeInteger(sizeBytes)) {
      throw new Error("rendered floor asset ledger metadata is invalid");
    }
    const expected = { sizeBytes, sha256: asset.sha256, mimeType: "image/svg+xml" as const };
    if (asset.contentEncoding === null || asset.contentEncoding === "gzip") {
      const viewport = await this.storage.readFloorRenderedMetadata(asset.objectKey, {
        ...expected, contentEncoding: asset.contentEncoding
      });
      return { ...viewport, contentEncoding: asset.contentEncoding };
    }
    if (asset.contentEncoding !== "unknown") {
      throw new Error("rendered floor asset encoding ledger is invalid");
    }

    const inspected = await this.storage.inspectFloorRenderedMetadata(asset.objectKey, expected);
    const updated = await this.prisma.$queryRaw<Array<{ contentEncoding: string | null }>>(Prisma.sql`
      UPDATE "FloorAsset"
      SET "contentEncoding" = ${inspected.contentEncoding},
          "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "id" = ${asset.id}
        AND "objectKey" = ${asset.objectKey}
        AND "mimeType" = ${asset.mimeType}
        AND "sizeBytes" = ${asset.sizeBytes}
        AND "sha256" = ${asset.sha256}
        AND "contentEncoding" = 'unknown'
      RETURNING "contentEncoding"
    `);
    if (updated[0]?.contentEncoding === inspected.contentEncoding) return inspected;

    const current = await this.prisma.floorAsset.findUnique({
      where: { id: asset.id },
      select: { objectKey: true, mimeType: true, contentEncoding: true, sizeBytes: true, sha256: true }
    });
    if (!current || current.objectKey !== asset.objectKey || current.mimeType !== asset.mimeType ||
        current.sizeBytes !== asset.sizeBytes || current.sha256 !== asset.sha256 ||
        current.contentEncoding !== inspected.contentEncoding) {
      throw new Error("rendered floor asset changed concurrently during encoding reconciliation");
    }
    return inspected;
  }
}

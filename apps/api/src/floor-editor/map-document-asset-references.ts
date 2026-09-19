import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/** Optional rollout dependency: never resolves a new table before the additive
 * migration exists. Do not cache a negative result across a migration rollout.
 */
@Injectable()
export class MapDocumentAssetReferences {
  constructor(private readonly prisma: PrismaService) {}
  async available(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ available: boolean }>>`SELECT
      to_regclass('"FloorMapGeneration"') IS NOT NULL AND
      to_regclass('"FloorMapChunk"') IS NOT NULL AND
      to_regclass('"FloorMapIndexShard"') IS NOT NULL AND
      to_regclass('"FloorMapChangeSet"') IS NOT NULL AND
      to_regclass('"FloorMapRevisionAsset"') IS NOT NULL AND
      to_regclass('"FloorMapDisplayAsset"') IS NOT NULL AND
      to_regclass('"FloorMapStagePart"') IS NOT NULL AS available`;
    return rows[0]?.available === true;
  }
}

export function mapAssetReferenced(id: Prisma.Sql, enabled: boolean): Prisma.Sql {
  if (!enabled) return Prisma.sql`FALSE`;
  // The same expression is used before LIMIT and after the Floor/asset locks.
  // Preparing, retired/history and stage assets are all references: expiration
  // only makes a workflow eligible for explicit retirement, never for S3 deletion.
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "FloorMapGeneration" WHERE "manifestAssetId" = ${id}
    UNION ALL SELECT 1 FROM "FloorMapChunk" WHERE "assetId" = ${id}
    UNION ALL SELECT 1 FROM "FloorMapIndexShard" WHERE "assetId" = ${id}
    UNION ALL SELECT 1 FROM "FloorMapChangeSet" WHERE "payloadAssetId" = ${id} OR "inverseAssetId" = ${id}
    UNION ALL SELECT 1 FROM "FloorMapRevisionAsset" WHERE "assetId" = ${id}
    UNION ALL SELECT 1 FROM "FloorMapDisplayAsset" WHERE "assetId" = ${id}
    UNION ALL SELECT 1 FROM "FloorMapStagePart" WHERE "assetId" = ${id}
  )`;
}

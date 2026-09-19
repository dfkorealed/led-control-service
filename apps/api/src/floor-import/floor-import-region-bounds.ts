import { CAD_IMPORT_MAX_REGIONS, type CadBounds } from "@led-control/shared";
import { Prisma } from "@prisma/client";

// Prisma's normal Float JSON read/write path can lose one ULP. Keep the exact
// float8 identity used by verified object metadata, including on selected retries.
export async function readExactRegionBounds(
  prisma: Pick<Prisma.TransactionClient, "$queryRaw">,
  scope: { jobId: string; regionId?: string } | { previewAssetId: string }
): Promise<Map<string, CadBounds>> {
  const where = "previewAssetId" in scope
    ? Prisma.sql`"previewAssetId" = ${scope.previewAssetId}`
    : Prisma.sql`"jobId" = ${scope.jobId}${scope.regionId === undefined
      ? Prisma.empty : Prisma.sql` AND "regionId" = ${scope.regionId}`}`;
  const rows = await prisma.$queryRaw<Array<{
    regionId: string; minX: string; minY: string; maxX: string; maxY: string;
  }>>(Prisma.sql`
    SELECT "regionId", "minX"::text AS "minX", "minY"::text AS "minY",
      "maxX"::text AS "maxX", "maxY"::text AS "maxY"
    FROM "FloorImportRegion" WHERE ${where}
    ORDER BY "regionId" LIMIT ${CAD_IMPORT_MAX_REGIONS + 1}
  `);
  if (rows.length > CAD_IMPORT_MAX_REGIONS) throw new Error("CAD region bounds count exceeds the limit");
  return new Map(rows.map(row => [row.regionId, {
    minX: Number(row.minX), minY: Number(row.minY), maxX: Number(row.maxX), maxY: Number(row.maxY)
  }]));
}

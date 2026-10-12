import { Prisma } from "@prisma/client";

export const FLOOR_MAP_REVISION_LIMIT = 30;

/** Caller must hold this Floor's row lock and publish the new head/pins first.
 * Only history rows (and their cascading revision pins) are removed. Generation,
 * delta, import and stage references still own assets needed to compose the map.
 */
export function pruneLockedFloorMapRevisions(tx: Prisma.TransactionClient, floorId: string,
  options: { limit?: number; skipLocked?: boolean } = {}): Promise<number> {
  return tx.$executeRaw(Prisma.sql`
    WITH candidates AS (
      SELECT history."id" FROM "FloorMapRevision" history
      JOIN "Floor" floor ON floor."id" = history."floorId"
      WHERE history."floorId" = ${floorId} AND history."revision" < (
        SELECT latest."revision" FROM "FloorMapRevision" latest WHERE latest."floorId" = ${floorId}
        ORDER BY latest."revision" DESC OFFSET ${FLOOR_MAP_REVISION_LIMIT - 1} LIMIT 1
      )
      -- Protect live snapshots even if an inconsistent head predates the newest
      -- 30. Fail closed rather than making currentRef unreadable in that case.
      AND history."revision" <> floor."mapRevision"
      AND NOT EXISTS (SELECT 1 FROM "FloorMapDocument" document
        WHERE document."floorId" = history."floorId" AND document."revision" = history."revision")
      ORDER BY history."revision"
      ${options.limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${options.limit}`}
      FOR UPDATE OF history ${options.skipLocked ? Prisma.sql`SKIP LOCKED` : Prisma.empty}
    )
    DELETE FROM "FloorMapRevision" history USING candidates WHERE history."id" = candidates."id"
  `);
}

import { Prisma } from "@prisma/client";

export type EditorPatch = { id: string; data: Record<string, unknown> };

const fixtureColumns = {
  name: "text", ratedWatt: "numeric", x: "double precision", y: "double precision",
  size: "double precision", placementStatus: '"FixturePlacementStatus"', positionVerifiedAt: "timestamp(3)"
};
const objectColumns = {
  type: "text", x: "double precision", y: "double precision", width: "double precision",
  height: "double precision", rotation: "double precision", points: "jsonb", text: "text",
  strokeColor: "text", fillColor: "text", strokeWidth: "double precision", fontSize: "double precision",
  zIndex: "integer", locked: "boolean", visible: "boolean"
};

export async function persistEditorPatches(
  tx: Prisma.TransactionClient, floorId: string, table: "Fixture" | "FloorMapObject", patches: EditorPatch[], changedAt: Date
) {
  const columns = table === "Fixture" ? fixtureColumns : objectColumns;
  // Identifiers/casts come exclusively from this allowlist. Patch data is a bound JSON parameter;
  // missing keys preserve live columns (notably telemetry), while explicit null clears nullable fields.
  const assignments = Object.entries(columns).map(([key, cast]) => Prisma.sql`
    ${Prisma.raw(`"${key}"`)} = CASE WHEN p.data ? ${key}
      THEN ${cast === "jsonb" ? Prisma.sql`NULLIF(p.data -> ${key}, 'null'::jsonb)` : Prisma.sql`(p.data ->> ${key})::${Prisma.raw(cast)}`}
      ELSE f.${Prisma.raw(`"${key}"`)} END
  `);
  // Bound restore payloads too, including historical snapshots exceeding today's mutation count cap.
  for (let offset = 0; offset < patches.length; offset += 1000) {
    const batch = patches.slice(offset, offset + 1000);
    await tx.$executeRaw(Prisma.sql`
      UPDATE ${Prisma.raw(`"${table}"`)} AS f
      SET ${Prisma.join(assignments)}, "updatedAt" = ${changedAt}
      FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS p(id text, data jsonb)
      WHERE f."id" = p.id AND f."floorId" = ${floorId}
    `);
  }
}

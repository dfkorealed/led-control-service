import { Prisma } from "@prisma/client";

/** Correlated operational predicate only. Historical queries must not use it.
 * Aliases are compile-time internal identifiers, never supplied by HTTP/MQTT. */
export function activeFixtureRegistrationSql(alias: "f" | "fixture" = "f") {
  const f = Prisma.raw(`"${alias}"`);
  return Prisma.sql`${f}."retiredAt" IS NULL
    AND NOT EXISTS(SELECT 1 FROM "MeshNode" registration_node
      WHERE registration_node.id=${f}."meshNodeId" AND registration_node."retiredAt" IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM "FixtureRegistrationRemovalOperation" removal
      WHERE removal."fixtureId"=${f}.id AND removal.status NOT IN ('completed','rejected'))`;
}

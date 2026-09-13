import { Prisma } from "@prisma/client";

export type RegistrationDomainLockScope = {
  floorId: string;
  gatewayId: string;
  sessionId: string;
  nodeIds?: string[];
  allSessionNodes?: boolean;
  outboxIds?: string[];
};

/**
 * Canonical registration-domain row-lock order:
 * Floor -> Gateway -> ProvisioningSession -> DiscoveredMeshNode -> ProvisioningDeviceOutbox.
 *
 * Request paths may lock Site first to re-authorize the actor. Publisher lease
 * claims are deliberately committed in a separate short SKIP LOCKED
 * transaction before calling this helper. Consequently no path holds an
 * Outbox lock while waiting for a domain row, which removes the former
 * request/publisher/terminal lock inversion.
 */
export async function lockRegistrationDomain(
  tx: Prisma.TransactionClient,
  scope: RegistrationDomainLockScope
) {
  if (scope.allSessionNodes && scope.nodeIds) {
    throw new Error("registration lock scope cannot combine allSessionNodes and nodeIds");
  }
  await tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id" = ${scope.floorId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Gateway" WHERE "id" = ${scope.gatewayId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "ProvisioningSession" WHERE "id" = ${scope.sessionId} FOR UPDATE`;

  if (scope.allSessionNodes) {
    await tx.$queryRaw`
      SELECT "id" FROM "DiscoveredMeshNode"
      WHERE "sessionId" = ${scope.sessionId}
      ORDER BY "id" FOR UPDATE
    `;
  } else if (scope.nodeIds?.length) {
    const nodeIds = [...new Set(scope.nodeIds)].sort();
    await tx.$queryRaw`
      SELECT "id" FROM "DiscoveredMeshNode"
      WHERE "sessionId" = ${scope.sessionId} AND "id" IN (${Prisma.join(nodeIds)})
      ORDER BY "id" FOR UPDATE
    `;
  }

  if (scope.outboxIds?.length) {
    const outboxIds = [...new Set(scope.outboxIds)].sort();
    await tx.$queryRaw`
      SELECT "id" FROM "ProvisioningDeviceOutbox"
      WHERE "id" IN (${Prisma.join(outboxIds)})
      ORDER BY "id" FOR UPDATE
    `;
  }
}

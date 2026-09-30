import { BadRequestException } from "@nestjs/common";
import { automationCurrentConfigRequestV2Schema, type AutomationCurrentConfigRequestV2 } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { canonicalPayloadHash } from "./automation-payload-hash";

type Scope = { siteId: string; gatewayId: string };

/** Broker mTLS/topic ACL authenticates the scope; SQL verifies its current claim.
 * The consumer has no peer certificate, so this is not per-message certificate binding.
 * Caller holds the automation membership lock before taking these row locks. */
export async function lockAutomationProtocolIdentity(tx: Prisma.TransactionClient, scope: Scope) {
  const rows = await tx.$queryRaw<Array<{ assignmentVersion: number }>>(Prisma.sql`
    SELECT gateway."assignmentVersion" FROM "Gateway" AS gateway
    INNER JOIN "GatewayInventory" AS inventory ON inventory."claimedGatewayId" = gateway."id"
      AND inventory."claimedAt" IS NOT NULL AND inventory."disabledAt" IS NULL
    WHERE gateway."id" = ${scope.gatewayId} AND gateway."siteId" = ${scope.siteId}
      AND EXISTS (SELECT 1 FROM "GatewayCertificate" AS certificate
        WHERE certificate."inventoryId" = inventory."id" AND certificate."gatewayId" = gateway."id"
          AND certificate."purpose" = 'mqtt' AND certificate."status" = 'active' AND certificate."revokedAt" IS NULL)
    FOR UPDATE OF gateway, inventory
  `);
  return rows.length === 1 ? rows[0] : null;
}

export async function loadAutomationProtocolSupport(tx: Prisma.TransactionClient, scope: Scope): Promise<1 | 2> {
  const identity = await lockAutomationProtocolIdentity(tx, scope);
  if (!identity) return 1;
  const declaration = await tx.gatewayAutomationProtocolSupport.findFirst({
    where: { ...scope, assignmentVersion: identity.assignmentVersion },
    orderBy: { declarationRevision: "desc" }
  });
  return declaration?.maxSnapshotVersion === 2 ? 2 : 1;
}

export async function recordAutomationProtocolSupport(
  tx: Prisma.TransactionClient, value: AutomationCurrentConfigRequestV2
): Promise<"accepted" | "duplicate" | "stale" | "unverified"> {
  const request = automationCurrentConfigRequestV2Schema.parse(value);
  const scope = { siteId: request.siteId, gatewayId: request.gatewayId };
  const identity = await lockAutomationProtocolIdentity(tx, scope);
  if (!identity || identity.assignmentVersion !== request.assignmentVersion) return "unverified";
  const payloadHash = canonicalPayloadHash(request);
  const previousId = await tx.gatewayAutomationProtocolSupport.findUnique({ where: { declarationId: request.requestId } });
  if (previousId) {
    if (previousId.payloadHash !== payloadHash) throw new BadRequestException("protocol declaration identity conflict");
    return "duplicate";
  }
  const latest = await tx.gatewayAutomationProtocolSupport.findFirst({
    where: { ...scope, assignmentVersion: identity.assignmentVersion }, orderBy: { declarationRevision: "desc" }
  });
  if (latest && latest.declarationRevision >= BigInt(request.declarationRevision)) return "stale";
  await tx.gatewayAutomationProtocolSupport.create({ data: {
    ...scope, assignmentVersion: request.assignmentVersion, declarationRevision: BigInt(request.declarationRevision),
    declarationId: request.requestId, maxSnapshotVersion: request.maxSnapshotVersion,
    payloadHash, declaredAt: new Date(request.requestedAt)
  } });
  return "accepted";
}

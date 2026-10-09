import { Prisma } from "@prisma/client";

export type BioSensorBlockedReason = "profile_unverified" | "fingerprint_unverified" | "mode_unverified" |
  "link_unverified" | "catalog_pending" | "operating_policy_required" | "gateway_protocol_unverified" | "binding_changed" | "unsupported";
export interface BioSensorPreparationView {
  preparationCandidate: boolean;
  status: string; commandId: string | null; profileKey: string | null; observedAt: string | null;
  blockedReasons: BioSensorBlockedReason[];
}
type Query = Pick<Prisma.TransactionClient, "$queryRaw">;
export async function hasPendingBioSensorConvergence(tx: Query, gatewayId: string) {
  const rows = await tx.$queryRaw<Array<{ pending: boolean }>>(Prisma.sql`SELECT EXISTS(
    SELECT 1 FROM "BioSensorConvergenceWork" work JOIN "Gateway" g ON g."id"=work."gatewayId"
      AND g."siteId"=work."siteId" AND g."assignmentVersion"=work."assignmentVersion"
    WHERE work."gatewayId"=${gatewayId} AND work."completedAt" IS NULL AND work."retiredAt" IS NULL) AS pending`);
  return rows[0]?.pending === true;
}
type Row = { fixtureId: string; status: string | null; commandId: string | null; profileKey: string | null;
  observedAt: string | null; blockedReasons: BioSensorBlockedReason[]; preparationCandidate: boolean };

/** SQL is the single qualification authority, including direct DB admission.
 * One set query serves a complete dashboard; raw evidence never leaves SQL. */
export async function loadBioSensorEligibility(tx: Query, fixtureIds: string[], now = new Date(),
  proposed?: { readiness: string; verifiedFingerprintId: string | null; verifiedAt: string; capabilityRevision: number; sensorModeVerifiedAt: string | null }) {
  if (fixtureIds.length === 0) return new Map<string, BioSensorPreparationView>();
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT fixture."id" AS "fixtureId", CASE WHEN preparation."status"='pending'
      AND preparation."expiresAt"<=(${now}::timestamptz AT TIME ZONE 'UTC') THEN 'timed_out' ELSE preparation."status" END AS "status", preparation."commandId",
      COALESCE(node."deviceUuid" ~ '^bio:[0-9a-f]{12}$' AND node."meshAddress" ~ '^0x[0-7][0-9a-f]{3}$'
        AND node."meshAddress"<>'0x0000' AND node."gatewayId"=fixture."gatewayId" AND (
        node."vehicleSensorProtocol"='bio_usb_pulse' OR EXISTS(SELECT 1 FROM "DiscoveredMeshNode" discovered
          JOIN "ProvisioningSession" session ON session."id"=discovered."sessionId"
          JOIN "ProvisioningDeviceOutbox" command ON command."nodeId"=discovered."id" AND command."sessionId"=session."id"
          WHERE discovered."id"=fixture."id" AND discovered."status"='provisioned' AND discovered."identifyState"='confirmed'
            AND discovered."deviceUuid"=node."deviceUuid" AND discovered."meshAddress"=node."meshAddress"
            AND session."siteId"=fixture."siteId" AND session."gatewayId"=fixture."gatewayId" AND session."floorId"=fixture."floorId"
            AND command."payload"->>'commandId'=command."id" AND command."payload"->>'sessionId'=session."id"
            AND command."payload"->>'nodeId'=fixture."id" AND command."payload"->>'deviceUuid'=node."deviceUuid"
            AND command."payload"->>'meshAddress'=node."meshAddress" AND COALESCE(command."payload"->>'operation','provision')='provision'
            AND command."payload"->>'siteId'=fixture."siteId" AND command."payload"->>'gatewayId'=fixture."gatewayId"
            AND command."topic"='sites/'||fixture."siteId"||'/gateways/'||fixture."gatewayId"||'/commands/provisioning/provision-device')),
        false) AS "preparationCandidate",
      preparation."result"->>'profileKey' AS "profileKey", preparation."result"->>'observedAt' AS "observedAt",
      bio_sensor_blocked_reasons(fixture."id", (${now}::timestamptz AT TIME ZONE 'UTC'),
        ${proposed?.readiness ?? null}::text, ${proposed?.verifiedFingerprintId ?? null}::text,
        (${proposed ? new Date(proposed.verifiedAt) : null}::timestamptz AT TIME ZONE 'UTC'),
        ${proposed ? BigInt(proposed.capabilityRevision) : null}::bigint,
        (${proposed?.sensorModeVerifiedAt ? new Date(proposed.sensorModeVerifiedAt) : null}::timestamptz AT TIME ZONE 'UTC')) AS "blockedReasons"
    FROM "Fixture" fixture LEFT JOIN "MeshNode" node ON node."id"=fixture."meshNodeId" LEFT JOIN LATERAL (
      SELECT * FROM "BioSensorPreparationOperation" operation WHERE operation."fixtureId"=fixture."id"
      ORDER BY operation."requestedAt" DESC, operation."commandId" DESC LIMIT 1
    ) preparation ON true WHERE fixture."id" IN (${Prisma.join(fixtureIds)})
  `);
  return new Map(rows.map(row => [row.fixtureId, { status: row.blockedReasons.length === 0 ? "ready"
    : row.status === "ready" ? "unverified" : row.status ?? "unverified", commandId: row.commandId,
    profileKey: row.profileKey, observedAt: row.observedAt, blockedReasons: row.blockedReasons,
    preparationCandidate: row.preparationCandidate }]));
}

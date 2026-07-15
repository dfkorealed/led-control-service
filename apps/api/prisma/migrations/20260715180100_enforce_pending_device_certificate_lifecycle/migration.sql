-- Preserve the newest device certificate if legacy data violated the active-pointer invariant.
WITH "rankedActiveDeviceCertificates" AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "inventoryId"
            ORDER BY "createdAt" DESC, "id" DESC
        ) AS "activeRank"
    FROM "GatewayCertificate"
    WHERE "purpose" = 'device' AND "status" = 'active'
)
UPDATE "GatewayCertificate" AS "certificate"
SET "status" = 'replaced'
FROM "rankedActiveDeviceCertificates" AS "ranked"
WHERE "certificate"."id" = "ranked"."id"
  AND "ranked"."activeRank" > 1;

CREATE UNIQUE INDEX "GatewayCertificate_single_active_device_inventory_key"
ON "GatewayCertificate"("inventoryId")
WHERE "purpose" = 'device' AND "status" = 'active';

-- A renewal may leave one activation candidate, never a competing set of device identities.
WITH "rankedPendingDeviceCertificates" AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "inventoryId"
            ORDER BY "createdAt" DESC, "id" DESC
        ) AS "pendingRank"
    FROM "GatewayCertificate"
    WHERE "purpose" = 'device' AND "status" = 'pending'
)
UPDATE "GatewayCertificate" AS "certificate"
SET "status" = 'revoked', "revokedAt" = COALESCE("certificate"."revokedAt", NOW())
FROM "rankedPendingDeviceCertificates" AS "ranked"
WHERE "certificate"."id" = "ranked"."id"
  AND "ranked"."pendingRank" > 1;

CREATE UNIQUE INDEX "GatewayCertificate_single_pending_device_inventory_key"
ON "GatewayCertificate"("inventoryId")
WHERE "purpose" = 'device' AND "status" = 'pending';

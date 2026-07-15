-- Repair any historical race before adding the invariant. The newest certificate remains active;
-- older duplicate rows become replaced without inventing ambiguous replacement links.
WITH "rankedActiveMqttCertificates" AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "inventoryId"
            ORDER BY "createdAt" DESC, "id" DESC
        ) AS "activeRank"
    FROM "GatewayCertificate"
    WHERE "purpose" = 'mqtt' AND "status" = 'active'
)
UPDATE "GatewayCertificate" AS "certificate"
SET "status" = 'replaced'
FROM "rankedActiveMqttCertificates" AS "ranked"
WHERE "certificate"."id" = "ranked"."id"
  AND "ranked"."activeRank" > 1;

CREATE UNIQUE INDEX "GatewayCertificate_single_active_mqtt_inventory_key"
ON "GatewayCertificate"("inventoryId")
WHERE "purpose" = 'mqtt' AND "status" = 'active';

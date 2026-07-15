WITH "rankedActiveEnrollments" AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "serialNumber"
            ORDER BY "createdAt" DESC, "id" DESC
        ) AS "activeRank"
    FROM "GatewayEnrollment"
    WHERE "usedAt" IS NULL
)
UPDATE "GatewayEnrollment" AS "enrollment"
SET
    "usedAt" = CURRENT_TIMESTAMP,
    "outcome" = 'superseded',
    "failureReason" = NULL
FROM "rankedActiveEnrollments" AS "ranked"
WHERE "enrollment"."id" = "ranked"."id"
  AND "ranked"."activeRank" > 1;

CREATE UNIQUE INDEX "GatewayEnrollment_single_active_serial_key" ON "GatewayEnrollment"("serialNumber") WHERE "usedAt" IS NULL;

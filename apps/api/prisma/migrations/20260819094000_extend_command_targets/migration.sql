ALTER TABLE "Command"
  ALTER COLUMN "targetId" DROP NOT NULL,
  ADD COLUMN "targetFixtureIds" JSONB;

UPDATE "Command"
AS command
SET "targetFixtureIds" = COALESCE((
  SELECT jsonb_agg(DISTINCT result."fixtureId" ORDER BY result."fixtureId")
  FROM "CommandDispatch" AS dispatch
  JOIN "CommandFixtureResult" AS result ON result."dispatchId" = dispatch."id"
  WHERE dispatch."commandId" = command."id"
), '[]'::jsonb);

ALTER TABLE "Command"
  ALTER COLUMN "targetFixtureIds" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "targetFixtureIds" SET NOT NULL;

ALTER TABLE "CommandDispatch"
  ADD COLUMN "deliveryMode" TEXT,
  ADD COLUMN "destinationAddress" TEXT,
  ADD COLUMN "meshControlGroupId" TEXT,
  ADD COLUMN "meshControlGroupVersion" INTEGER;

UPDATE "CommandDispatch"
AS dispatch
SET "deliveryMode" = CASE
  WHEN (
    SELECT COUNT(result."fixtureId")
    FROM "CommandFixtureResult" AS result
    WHERE result."dispatchId" = dispatch."id"
  ) <= 1 THEN 'unicast'
  ELSE 'parallel_unicast'
END;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "MqttOutbox" AS outbox
    WHERE NOT EXISTS (
      SELECT 1
      FROM "CommandFixtureResult" AS result
      WHERE result."dispatchId" = outbox."dispatchId"
    )
  ) THEN
    RAISE EXCEPTION 'cannot migrate MqttOutbox without CommandFixtureResult targets';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "MqttOutbox" AS outbox
    JOIN "CommandFixtureResult" AS result ON result."dispatchId" = outbox."dispatchId"
    GROUP BY outbox."id"
    HAVING COUNT(result."fixtureId") > 1000
  ) THEN
    RAISE EXCEPTION 'cannot migrate MqttOutbox with more than 1000 fixture targets';
  END IF;
END $$;

WITH dispatch_targets AS (
  SELECT
    dispatch."id" AS "dispatchId",
    jsonb_agg(result."fixtureId" ORDER BY result."fixtureId") AS "fixtureIds",
    COUNT(result."fixtureId") AS "fixtureCount",
    CASE
      WHEN COUNT(result."fixtureId") <= 1 THEN 'unicast'
      ELSE 'parallel_unicast'
    END AS "deliveryMode"
  FROM "CommandDispatch" AS dispatch
  JOIN "CommandFixtureResult" AS result ON result."dispatchId" = dispatch."id"
  GROUP BY dispatch."id"
)
UPDATE "MqttOutbox" AS outbox
SET "payload" = (
  outbox."payload" - 'destinationAddress' - 'meshControlGroupId' - 'meshControlGroupVersion'
) || jsonb_build_object(
  'targetType', CASE
    WHEN outbox."payload"->>'targetType' = 'fixture'
      AND dispatch_targets."fixtureCount" = 1 THEN 'fixture'
    ELSE 'fixtures'
  END,
  'targetId', CASE
    WHEN outbox."payload"->>'targetType' = 'fixture'
      AND dispatch_targets."fixtureCount" = 1
      THEN to_jsonb(dispatch_targets."fixtureIds"->>0)
    ELSE 'null'::jsonb
  END,
  'targetFixtureIds', dispatch_targets."fixtureIds",
  'deliveryMode', dispatch_targets."deliveryMode"
)
FROM dispatch_targets
WHERE outbox."dispatchId" = dispatch_targets."dispatchId";

ALTER TABLE "CommandDispatch"
  ALTER COLUMN "deliveryMode" SET DEFAULT 'unicast',
  ALTER COLUMN "deliveryMode" SET NOT NULL;

CREATE INDEX "CommandDispatch_meshControlGroupId_status_idx"
  ON "CommandDispatch"("meshControlGroupId", "status");

ALTER TABLE "CommandDispatch"
  ADD CONSTRAINT "CommandDispatch_meshControlGroupId_gatewayId_fkey"
  FOREIGN KEY ("meshControlGroupId", "gatewayId") REFERENCES "MeshControlGroup"("id", "gatewayId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

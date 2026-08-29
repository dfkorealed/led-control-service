BEGIN;

CREATE TYPE "AutomationSyncStatus" AS ENUM ('PENDING', 'APPLIED', 'REJECTED');
CREATE TYPE "AutomationRuleStatus" AS ENUM ('enabled', 'disabled');
CREATE TYPE "ScheduleRecurrenceKind" AS ENUM ('once', 'daily', 'weekly', 'monthly', 'yearly');
CREATE TYPE "AutomationExecutionKind" AS ENUM (
  'schedule_started',
  'schedule_ended',
  'vehicle_detected',
  'event_started',
  'event_extended',
  'event_ended',
  'action_result',
  'telemetry_gap'
);

CREATE FUNCTION "automation_weekly_days_are_unique"(days INTEGER[])
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT cardinality(days) = (SELECT COUNT(DISTINCT day) FROM unnest(days) AS day);
$$;

CREATE UNIQUE INDEX "Gateway_id_siteId_key" ON "Gateway"("id", "siteId");
CREATE UNIQUE INDEX "Command_id_siteId_requestedBy_key" ON "Command"("id", "siteId", "requestedBy");
CREATE UNIQUE INDEX "Floor_id_siteId_key" ON "Floor"("id", "siteId");

ALTER TABLE "Fixture"
  ADD COLUMN "siteId" TEXT,
  ADD COLUMN "gatewayId" TEXT;

UPDATE "Fixture" AS fixture
SET
  "siteId" = floor."siteId",
  "gatewayId" = (
    SELECT mesh_node."gatewayId"
    FROM "MeshNode" AS mesh_node
    WHERE mesh_node."id" = fixture."meshNodeId"
  )
FROM "Floor" AS floor
WHERE floor."id" = fixture."floorId";

ALTER TABLE "Fixture"
  DROP CONSTRAINT "Fixture_floorId_fkey",
  DROP CONSTRAINT "Fixture_meshNodeId_fkey",
  ALTER COLUMN "siteId" SET NOT NULL,
  ADD CONSTRAINT "Fixture_mesh_owner_shape_check"
    CHECK (
      ("meshNodeId" IS NULL AND "gatewayId" IS NULL)
      OR ("meshNodeId" IS NOT NULL AND "gatewayId" IS NOT NULL)
    );

CREATE UNIQUE INDEX "Fixture_id_siteId_gatewayId_key"
  ON "Fixture"("id", "siteId", "gatewayId");
CREATE UNIQUE INDEX "Fixture_meshNodeId_gatewayId_key"
  ON "Fixture"("meshNodeId", "gatewayId");
CREATE INDEX "Fixture_floorId_siteId_idx" ON "Fixture"("floorId", "siteId");

ALTER TABLE "Fixture"
  ADD CONSTRAINT "Fixture_floorId_siteId_fkey"
  FOREIGN KEY ("floorId", "siteId")
  REFERENCES "Floor"("id", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Fixture_meshNodeId_gatewayId_fkey"
  FOREIGN KEY ("meshNodeId", "gatewayId")
  REFERENCES "MeshNode"("id", "gatewayId") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION "project_fixture_owner"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  derived_site_id TEXT;
  derived_gateway_id TEXT;
BEGIN
  SELECT "siteId" INTO derived_site_id
  FROM "Floor"
  WHERE "id" = NEW."floorId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fixture Floor does not exist' USING ERRCODE = '23503';
  END IF;

  IF NEW."siteId" IS NOT NULL AND NEW."siteId" IS DISTINCT FROM derived_site_id THEN
    IF TG_OP = 'INSERT'
      OR NEW."floorId" IS NOT DISTINCT FROM OLD."floorId"
      OR NEW."siteId" IS DISTINCT FROM OLD."siteId"
    THEN
      RAISE EXCEPTION 'Fixture Site does not match Floor owner' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW."siteId" := derived_site_id;

  IF NEW."meshNodeId" IS NULL THEN
    IF NEW."gatewayId" IS NOT NULL THEN
      IF TG_OP = 'INSERT'
        OR NEW."meshNodeId" IS NOT DISTINCT FROM OLD."meshNodeId"
        OR NEW."gatewayId" IS DISTINCT FROM OLD."gatewayId"
      THEN
        RAISE EXCEPTION 'Fixture Gateway must be null without MeshNode' USING ERRCODE = '23514';
      END IF;
    END IF;
    NEW."gatewayId" := NULL;
    RETURN NEW;
  END IF;

  SELECT "gatewayId" INTO derived_gateway_id
  FROM "MeshNode"
  WHERE "id" = NEW."meshNodeId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fixture MeshNode does not exist' USING ERRCODE = '23503';
  END IF;

  IF NEW."gatewayId" IS NOT NULL AND NEW."gatewayId" IS DISTINCT FROM derived_gateway_id THEN
    IF TG_OP = 'INSERT'
      OR NEW."meshNodeId" IS NOT DISTINCT FROM OLD."meshNodeId"
      OR NEW."gatewayId" IS DISTINCT FROM OLD."gatewayId"
    THEN
      RAISE EXCEPTION 'Fixture Gateway does not match MeshNode owner' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW."gatewayId" := derived_gateway_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Fixture_owner_projection"
BEFORE INSERT OR UPDATE OF "floorId", "meshNodeId", "siteId", "gatewayId" ON "Fixture"
FOR EACH ROW EXECUTE FUNCTION "project_fixture_owner"();

ALTER TABLE "MqttOutbox"
  ALTER COLUMN "dispatchId" DROP NOT NULL,
  ADD COLUMN "gatewayId" TEXT,
  ADD COLUMN "revision" INTEGER,
  ADD COLUMN "payloadHash" TEXT,
  ADD CONSTRAINT "MqttOutbox_revision_check"
    CHECK ("revision" IS NULL OR "revision" >= 0),
  ADD CONSTRAINT "MqttOutbox_payload_hash_check"
    CHECK ("payloadHash" IS NULL OR "payloadHash" ~ '^sha256:[a-f0-9]{64}$'),
  ADD CONSTRAINT "MqttOutbox_automation_identity_check"
    CHECK (
      ("dispatchId" IS NOT NULL AND "gatewayId" IS NULL AND "revision" IS NULL AND "payloadHash" IS NULL)
      OR
      ("dispatchId" IS NULL AND "gatewayId" IS NOT NULL AND "revision" IS NOT NULL AND "payloadHash" IS NOT NULL)
    );

CREATE TABLE "GatewayAutomationConfiguration" (
  "gatewayId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "desiredRevision" INTEGER NOT NULL DEFAULT 0,
  "appliedRevision" INTEGER NOT NULL DEFAULT 0,
  "syncStatus" "AutomationSyncStatus" NOT NULL DEFAULT 'PENDING',
  "payloadHash" TEXT,
  "lastErrorCode" TEXT,
  "lastAppliedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GatewayAutomationConfiguration_pkey" PRIMARY KEY ("gatewayId"),
  CONSTRAINT "GatewayAutomationConfiguration_revision_check"
    CHECK (
      "desiredRevision" >= 0
      AND "appliedRevision" >= 0
      AND "appliedRevision" <= "desiredRevision"
    ),
  CONSTRAINT "GatewayAutomationConfiguration_payload_hash_check"
    CHECK ("payloadHash" IS NULL OR "payloadHash" ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT "GatewayAutomationConfiguration_state_check"
    CHECK (
      (
        "syncStatus" = 'PENDING'
        AND (
          (
            "desiredRevision" = 0
            AND "appliedRevision" = 0
            AND "payloadHash" IS NULL
            AND "lastErrorCode" IS NULL
            AND "lastAppliedAt" IS NULL
          )
          OR
          (
            "desiredRevision" > "appliedRevision"
            AND "payloadHash" IS NOT NULL
            AND "lastErrorCode" IS NULL
          )
        )
      )
      OR
      (
        "syncStatus" = 'APPLIED'
        AND "desiredRevision" = "appliedRevision"
        AND "payloadHash" IS NOT NULL
        AND "lastAppliedAt" IS NOT NULL
        AND "lastErrorCode" IS NULL
      )
      OR
      (
        "syncStatus" = 'REJECTED'
        AND "appliedRevision" <= "desiredRevision"
        AND "payloadHash" IS NOT NULL
        AND "lastErrorCode" IS NOT NULL
        AND btrim("lastErrorCode") <> ''
      )
    )
);

CREATE TABLE "LightingSchedule" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "AutomationRuleStatus" NOT NULL DEFAULT 'enabled',
  "activeFrom" TIMESTAMP(3) NOT NULL,
  "activeUntil" TIMESTAMP(3) NOT NULL,
  "localStartTime" TEXT NOT NULL,
  "localEndTime" TEXT NOT NULL,
  "recurrenceKind" "ScheduleRecurrenceKind" NOT NULL,
  "weeklyDays" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "monthlyDay" INTEGER,
  "yearlyMonth" INTEGER,
  "yearlyDay" INTEGER,
  "dimmingEnabled" BOOLEAN NOT NULL,
  "brightnessPercent" INTEGER NOT NULL,
  "desiredRevision" INTEGER NOT NULL DEFAULT 0,
  "appliedRevision" INTEGER NOT NULL DEFAULT 0,
  "targetCount" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LightingSchedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LightingSchedule_name_check" CHECK (btrim("name") <> ''),
  CONSTRAINT "LightingSchedule_revision_check"
    CHECK (
      "desiredRevision" >= 0
      AND "appliedRevision" >= 0
      AND "appliedRevision" <= "desiredRevision"
    ),
  CONSTRAINT "LightingSchedule_brightness_check" CHECK ("brightnessPercent" BETWEEN 0 AND 100),
  CONSTRAINT "LightingSchedule_target_count_check" CHECK ("targetCount" >= 0),
  CONSTRAINT "LightingSchedule_active_range_check" CHECK ("activeFrom" <= "activeUntil"),
  CONSTRAINT "LightingSchedule_local_time_check"
    CHECK (
      "localStartTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND "localEndTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    ),
  CONSTRAINT "LightingSchedule_recurrence_check"
    CHECK (
      (
        "recurrenceKind" = 'weekly'
        AND cardinality("weeklyDays") > 0
        AND "weeklyDays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
        AND "automation_weekly_days_are_unique"("weeklyDays")
        AND "monthlyDay" IS NULL
        AND "yearlyMonth" IS NULL
        AND "yearlyDay" IS NULL
      )
      OR
      (
        "recurrenceKind" = 'monthly'
        AND cardinality("weeklyDays") = 0
        AND "monthlyDay" IS NOT NULL
        AND "monthlyDay" BETWEEN 1 AND 31
        AND "yearlyMonth" IS NULL
        AND "yearlyDay" IS NULL
      )
      OR
      (
        "recurrenceKind" = 'yearly'
        AND cardinality("weeklyDays") = 0
        AND "monthlyDay" IS NULL
        AND "yearlyMonth" IS NOT NULL
        AND "yearlyMonth" BETWEEN 1 AND 12
        AND "yearlyDay" IS NOT NULL
        AND "yearlyDay" BETWEEN 1 AND 31
      )
      OR
      (
        "recurrenceKind" IN ('once', 'daily')
        AND cardinality("weeklyDays") = 0
        AND "monthlyDay" IS NULL
        AND "yearlyMonth" IS NULL
        AND "yearlyDay" IS NULL
      )
    )
);

CREATE TABLE "LightingScheduleFixture" (
  "scheduleId" TEXT NOT NULL,
  "fixtureId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LightingScheduleFixture_pkey" PRIMARY KEY ("scheduleId","fixtureId")
);

CREATE TABLE "VehicleEventRule" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "AutomationRuleStatus" NOT NULL DEFAULT 'enabled',
  "dimmingEnabled" BOOLEAN NOT NULL,
  "brightnessPercent" INTEGER NOT NULL,
  "holdSeconds" INTEGER NOT NULL DEFAULT 60,
  "desiredRevision" INTEGER NOT NULL DEFAULT 0,
  "appliedRevision" INTEGER NOT NULL DEFAULT 0,
  "sourceCount" INTEGER NOT NULL DEFAULT 0,
  "targetCount" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "VehicleEventRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VehicleEventRule_name_check" CHECK (btrim("name") <> ''),
  CONSTRAINT "VehicleEventRule_revision_check"
    CHECK (
      "desiredRevision" >= 0
      AND "appliedRevision" >= 0
      AND "appliedRevision" <= "desiredRevision"
    ),
  CONSTRAINT "VehicleEventRule_brightness_check" CHECK ("brightnessPercent" BETWEEN 0 AND 100),
  CONSTRAINT "VehicleEventRule_hold_check" CHECK ("holdSeconds" BETWEEN 5 AND 1800),
  CONSTRAINT "VehicleEventRule_source_count_check" CHECK ("sourceCount" >= 0),
  CONSTRAINT "VehicleEventRule_target_count_check" CHECK ("targetCount" >= 0)
);

CREATE TABLE "VehicleEventSource" (
  "ruleId" TEXT NOT NULL,
  "fixtureId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VehicleEventSource_pkey" PRIMARY KEY ("ruleId","fixtureId")
);

CREATE TABLE "VehicleEventTarget" (
  "ruleId" TEXT NOT NULL,
  "fixtureId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VehicleEventTarget_pkey" PRIMARY KEY ("ruleId","fixtureId")
);

CREATE TABLE "ManualOverride" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "commandId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "brightnessPercent" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "overrideUntil" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  "targetCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ManualOverride_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManualOverride_brightness_check" CHECK ("brightnessPercent" BETWEEN 0 AND 100),
  CONSTRAINT "ManualOverride_target_count_check" CHECK ("targetCount" >= 0),
  CONSTRAINT "ManualOverride_time_range_check"
    CHECK (
      "overrideUntil" > "startedAt"
      AND ("endedAt" IS NULL OR ("endedAt" >= "startedAt" AND "endedAt" <= "overrideUntil"))
    )
);

CREATE TABLE "ManualOverrideFixture" (
  "manualOverrideId" TEXT NOT NULL,
  "fixtureId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ManualOverrideFixture_pkey" PRIMARY KEY ("manualOverrideId","fixtureId")
);

CREATE TABLE "AutomationExecution" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "sequence" BIGINT NOT NULL,
  "revision" INTEGER NOT NULL,
  "ruleId" TEXT,
  "lightingScheduleId" TEXT,
  "vehicleEventRuleId" TEXT,
  "manualOverrideId" TEXT,
  "occurrenceKey" TEXT,
  "kind" "AutomationExecutionKind" NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AutomationExecution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AutomationExecution_revision_sequence_check" CHECK ("revision" >= 0 AND "sequence" >= 0),
  CONSTRAINT "AutomationExecution_rule_reference_check"
    CHECK (num_nonnulls("lightingScheduleId", "vehicleEventRuleId", "manualOverrideId") <= 1)
);

CREATE TABLE "AutomationExecutionFixtureResult" (
  "executionId" TEXT NOT NULL,
  "fixtureSnapshotId" TEXT NOT NULL,
  "fixtureId" TEXT,
  "status" "CommandFixtureResultStatus" NOT NULL,
  "brightnessPercent" INTEGER,
  "faultCode" TEXT,
  "errorCode" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AutomationExecutionFixtureResult_pkey" PRIMARY KEY ("executionId","fixtureSnapshotId"),
  CONSTRAINT "AutomationExecutionFixtureResult_brightness_check"
    CHECK ("brightnessPercent" IS NULL OR "brightnessPercent" BETWEEN 0 AND 100),
  CONSTRAINT "AutomationExecutionFixtureResult_fixture_identity_check"
    CHECK ("fixtureId" IS NULL OR "fixtureId" = "fixtureSnapshotId"),
  CONSTRAINT "AutomationExecutionFixtureResult_terminal_status_check"
    CHECK ("status" IN ('succeeded', 'failed', 'timed_out'))
);

CREATE UNIQUE INDEX "MqttOutbox_gatewayId_revision_payloadHash_key"
  ON "MqttOutbox"("gatewayId", "revision", "payloadHash");
CREATE INDEX "MqttOutbox_gatewayId_publishedAt_deadLetteredAt_nextAttempt_idx"
  ON "MqttOutbox"("gatewayId", "publishedAt", "deadLetteredAt", "nextAttemptAt");

CREATE UNIQUE INDEX "GatewayAutomationConfiguration_gatewayId_siteId_key"
  ON "GatewayAutomationConfiguration"("gatewayId", "siteId");
CREATE INDEX "GatewayAutomationConfiguration_siteId_syncStatus_idx"
  ON "GatewayAutomationConfiguration"("siteId", "syncStatus");

CREATE INDEX "LightingSchedule_siteId_status_createdAt_idx"
  ON "LightingSchedule"("siteId", "status", "createdAt");
CREATE INDEX "LightingSchedule_gatewayId_status_idx"
  ON "LightingSchedule"("gatewayId", "status");
CREATE UNIQUE INDEX "LightingSchedule_id_siteId_gatewayId_key"
  ON "LightingSchedule"("id", "siteId", "gatewayId");
CREATE INDEX "LightingScheduleFixture_fixtureId_idx"
  ON "LightingScheduleFixture"("fixtureId");
CREATE INDEX "LightingScheduleFixture_siteId_gatewayId_idx"
  ON "LightingScheduleFixture"("siteId", "gatewayId");

CREATE INDEX "VehicleEventRule_siteId_status_createdAt_idx"
  ON "VehicleEventRule"("siteId", "status", "createdAt");
CREATE INDEX "VehicleEventRule_gatewayId_status_idx"
  ON "VehicleEventRule"("gatewayId", "status");
CREATE UNIQUE INDEX "VehicleEventRule_id_siteId_gatewayId_key"
  ON "VehicleEventRule"("id", "siteId", "gatewayId");
CREATE INDEX "VehicleEventSource_fixtureId_idx" ON "VehicleEventSource"("fixtureId");
CREATE INDEX "VehicleEventSource_siteId_gatewayId_idx" ON "VehicleEventSource"("siteId", "gatewayId");
CREATE INDEX "VehicleEventTarget_fixtureId_idx" ON "VehicleEventTarget"("fixtureId");
CREATE INDEX "VehicleEventTarget_siteId_gatewayId_idx" ON "VehicleEventTarget"("siteId", "gatewayId");

CREATE UNIQUE INDEX "ManualOverride_commandId_key" ON "ManualOverride"("commandId");
CREATE UNIQUE INDEX "ManualOverride_commandId_siteId_requestedById_key"
  ON "ManualOverride"("commandId", "siteId", "requestedById");
CREATE UNIQUE INDEX "ManualOverride_id_siteId_gatewayId_key"
  ON "ManualOverride"("id", "siteId", "gatewayId");
CREATE INDEX "ManualOverride_siteId_overrideUntil_idx" ON "ManualOverride"("siteId", "overrideUntil");
CREATE INDEX "ManualOverride_gatewayId_overrideUntil_idx" ON "ManualOverride"("gatewayId", "overrideUntil");
CREATE INDEX "ManualOverride_requestedById_createdAt_idx" ON "ManualOverride"("requestedById", "createdAt");
CREATE INDEX "ManualOverrideFixture_fixtureId_idx" ON "ManualOverrideFixture"("fixtureId");
CREATE INDEX "ManualOverrideFixture_siteId_gatewayId_idx" ON "ManualOverrideFixture"("siteId", "gatewayId");

CREATE UNIQUE INDEX "AutomationExecution_gatewayId_eventId_sequence_key"
  ON "AutomationExecution"("gatewayId", "eventId", "sequence");
CREATE INDEX "AutomationExecution_siteId_occurredAt_idx" ON "AutomationExecution"("siteId", "occurredAt");
CREATE INDEX "AutomationExecution_gatewayId_sequence_idx" ON "AutomationExecution"("gatewayId", "sequence");
CREATE INDEX "AutomationExecution_ruleId_occurredAt_idx" ON "AutomationExecution"("ruleId", "occurredAt");
CREATE INDEX "AutomationExecution_lightingScheduleId_idx" ON "AutomationExecution"("lightingScheduleId");
CREATE INDEX "AutomationExecution_vehicleEventRuleId_idx" ON "AutomationExecution"("vehicleEventRuleId");
CREATE INDEX "AutomationExecution_manualOverrideId_idx" ON "AutomationExecution"("manualOverrideId");
CREATE INDEX "AutomationExecutionFixtureResult_fixtureId_status_idx"
  ON "AutomationExecutionFixtureResult"("fixtureId", "status");

ALTER TABLE "MqttOutbox"
  ADD CONSTRAINT "MqttOutbox_gatewayId_fkey"
  FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GatewayAutomationConfiguration"
  ADD CONSTRAINT "GatewayAutomationConfiguration_gatewayId_siteId_fkey"
  FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "GatewayAutomationConfiguration_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "LightingSchedule"
  ADD CONSTRAINT "LightingSchedule_gatewayId_siteId_fkey"
  FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "LightingSchedule_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "LightingSchedule_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "LightingSchedule_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "LightingScheduleFixture"
  ADD CONSTRAINT "LightingScheduleFixture_scheduleId_siteId_gatewayId_fkey"
  FOREIGN KEY ("scheduleId", "siteId", "gatewayId")
  REFERENCES "LightingSchedule"("id", "siteId", "gatewayId") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "LightingScheduleFixture_fixtureId_siteId_gatewayId_fkey"
  FOREIGN KEY ("fixtureId", "siteId", "gatewayId")
  REFERENCES "Fixture"("id", "siteId", "gatewayId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "VehicleEventRule"
  ADD CONSTRAINT "VehicleEventRule_gatewayId_siteId_fkey"
  FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "VehicleEventRule_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "VehicleEventRule_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "VehicleEventRule_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "VehicleEventSource"
  ADD CONSTRAINT "VehicleEventSource_ruleId_siteId_gatewayId_fkey"
  FOREIGN KEY ("ruleId", "siteId", "gatewayId")
  REFERENCES "VehicleEventRule"("id", "siteId", "gatewayId") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "VehicleEventSource_fixtureId_siteId_gatewayId_fkey"
  FOREIGN KEY ("fixtureId", "siteId", "gatewayId")
  REFERENCES "Fixture"("id", "siteId", "gatewayId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "VehicleEventTarget"
  ADD CONSTRAINT "VehicleEventTarget_ruleId_siteId_gatewayId_fkey"
  FOREIGN KEY ("ruleId", "siteId", "gatewayId")
  REFERENCES "VehicleEventRule"("id", "siteId", "gatewayId") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "VehicleEventTarget_fixtureId_siteId_gatewayId_fkey"
  FOREIGN KEY ("fixtureId", "siteId", "gatewayId")
  REFERENCES "Fixture"("id", "siteId", "gatewayId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ManualOverride"
  ADD CONSTRAINT "ManualOverride_gatewayId_siteId_fkey"
  FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ManualOverride_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ManualOverride_commandId_siteId_requestedById_fkey"
  FOREIGN KEY ("commandId", "siteId", "requestedById")
  REFERENCES "Command"("id", "siteId", "requestedBy") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ManualOverride_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ManualOverrideFixture"
  ADD CONSTRAINT "ManualOverrideFixture_manualOverrideId_siteId_gatewayId_fkey"
  FOREIGN KEY ("manualOverrideId", "siteId", "gatewayId")
  REFERENCES "ManualOverride"("id", "siteId", "gatewayId") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "ManualOverrideFixture_fixtureId_siteId_gatewayId_fkey"
  FOREIGN KEY ("fixtureId", "siteId", "gatewayId")
  REFERENCES "Fixture"("id", "siteId", "gatewayId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AutomationExecution"
  ADD CONSTRAINT "AutomationExecution_gatewayId_siteId_fkey"
  FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AutomationExecution_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AutomationExecution_lightingScheduleId_fkey"
  FOREIGN KEY ("lightingScheduleId") REFERENCES "LightingSchedule"("id") ON DELETE SET NULL ON UPDATE RESTRICT,
  ADD CONSTRAINT "AutomationExecution_vehicleEventRuleId_fkey"
  FOREIGN KEY ("vehicleEventRuleId") REFERENCES "VehicleEventRule"("id") ON DELETE SET NULL ON UPDATE RESTRICT,
  ADD CONSTRAINT "AutomationExecution_manualOverrideId_fkey"
  FOREIGN KEY ("manualOverrideId") REFERENCES "ManualOverride"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

ALTER TABLE "AutomationExecutionFixtureResult"
  ADD CONSTRAINT "AutomationExecutionFixtureResult_executionId_fkey"
  FOREIGN KEY ("executionId") REFERENCES "AutomationExecution"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "AutomationExecutionFixtureResult_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

CREATE FUNCTION "validate_automation_execution_source"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_site_id TEXT;
  source_gateway_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."lightingScheduleId" IS NOT NULL
      AND NEW."lightingScheduleId" IS NULL
      AND NEW."vehicleEventRuleId" IS NOT DISTINCT FROM OLD."vehicleEventRuleId"
      AND NEW."manualOverrideId" IS NOT DISTINCT FROM OLD."manualOverrideId"
      AND NOT EXISTS (SELECT 1 FROM "LightingSchedule" WHERE "id" = OLD."lightingScheduleId")
    THEN
      RETURN NEW;
    END IF;
    IF OLD."vehicleEventRuleId" IS NOT NULL
      AND NEW."vehicleEventRuleId" IS NULL
      AND NEW."lightingScheduleId" IS NOT DISTINCT FROM OLD."lightingScheduleId"
      AND NEW."manualOverrideId" IS NOT DISTINCT FROM OLD."manualOverrideId"
      AND NOT EXISTS (SELECT 1 FROM "VehicleEventRule" WHERE "id" = OLD."vehicleEventRuleId")
    THEN
      RETURN NEW;
    END IF;
    IF OLD."manualOverrideId" IS NOT NULL
      AND NEW."manualOverrideId" IS NULL
      AND NEW."lightingScheduleId" IS NOT DISTINCT FROM OLD."lightingScheduleId"
      AND NEW."vehicleEventRuleId" IS NOT DISTINCT FROM OLD."vehicleEventRuleId"
      AND NOT EXISTS (SELECT 1 FROM "ManualOverride" WHERE "id" = OLD."manualOverrideId")
    THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW."kind" IN ('schedule_started', 'schedule_ended') THEN
    IF NEW."lightingScheduleId" IS NULL
      OR NEW."vehicleEventRuleId" IS NOT NULL
      OR NEW."manualOverrideId" IS NOT NULL
    THEN
      RAISE EXCEPTION 'execution kind does not match source' USING ERRCODE = '23514';
    END IF;
    IF NEW."ruleId" IS DISTINCT FROM NEW."lightingScheduleId" THEN
      RAISE EXCEPTION 'execution ruleId does not match source' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."kind" IN ('vehicle_detected', 'event_started', 'event_extended', 'event_ended') THEN
    IF NEW."vehicleEventRuleId" IS NULL
      OR NEW."lightingScheduleId" IS NOT NULL
      OR NEW."manualOverrideId" IS NOT NULL
    THEN
      RAISE EXCEPTION 'execution kind does not match source' USING ERRCODE = '23514';
    END IF;
    IF NEW."ruleId" IS DISTINCT FROM NEW."vehicleEventRuleId" THEN
      RAISE EXCEPTION 'execution ruleId does not match source' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."kind" = 'action_result' THEN
    IF num_nonnulls(NEW."lightingScheduleId", NEW."vehicleEventRuleId", NEW."manualOverrideId") <> 1 THEN
      RAISE EXCEPTION 'execution kind does not match source' USING ERRCODE = '23514';
    END IF;
    IF NEW."manualOverrideId" IS NOT NULL AND NEW."ruleId" IS NOT NULL THEN
      RAISE EXCEPTION 'manual execution cannot contain ruleId' USING ERRCODE = '23514';
    END IF;
    IF NEW."lightingScheduleId" IS NOT NULL
      AND NEW."ruleId" IS DISTINCT FROM NEW."lightingScheduleId"
    THEN
      RAISE EXCEPTION 'execution ruleId does not match source' USING ERRCODE = '23514';
    END IF;
    IF NEW."vehicleEventRuleId" IS NOT NULL
      AND NEW."ruleId" IS DISTINCT FROM NEW."vehicleEventRuleId"
    THEN
      RAISE EXCEPTION 'execution ruleId does not match source' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."kind" = 'telemetry_gap' THEN
    IF NEW."ruleId" IS NOT NULL
      OR num_nonnulls(NEW."lightingScheduleId", NEW."vehicleEventRuleId", NEW."manualOverrideId") <> 0
    THEN
      RAISE EXCEPTION 'execution kind does not match source' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."lightingScheduleId" IS NOT NULL THEN
    SELECT "siteId", "gatewayId"
    INTO source_site_id, source_gateway_id
    FROM "LightingSchedule"
    WHERE "id" = NEW."lightingScheduleId";
  ELSIF NEW."vehicleEventRuleId" IS NOT NULL THEN
    SELECT "siteId", "gatewayId"
    INTO source_site_id, source_gateway_id
    FROM "VehicleEventRule"
    WHERE "id" = NEW."vehicleEventRuleId";
  ELSIF NEW."manualOverrideId" IS NOT NULL THEN
    SELECT "siteId", "gatewayId"
    INTO source_site_id, source_gateway_id
    FROM "ManualOverride"
    WHERE "id" = NEW."manualOverrideId";
  ELSE
    RETURN NEW;
  END IF;

  IF source_site_id IS DISTINCT FROM NEW."siteId"
    OR source_gateway_id IS DISTINCT FROM NEW."gatewayId"
  THEN
    RAISE EXCEPTION 'execution source owner does not match execution owner' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "AutomationExecution_source_check"
BEFORE INSERT OR UPDATE OF
  "siteId", "gatewayId", "ruleId", "lightingScheduleId", "vehicleEventRuleId", "manualOverrideId", "kind"
ON "AutomationExecution"
FOR EACH ROW EXECUTE FUNCTION "validate_automation_execution_source"();

CREATE FUNCTION "maintain_lighting_schedule_target_count"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_parent_id TEXT;
  new_parent_id TEXT;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    old_parent_id := OLD."scheduleId";
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    new_parent_id := NEW."scheduleId";
  END IF;

  IF old_parent_id IS NOT NULL
    AND new_parent_id IS NOT NULL
    AND old_parent_id IS DISTINCT FROM new_parent_id
  THEN
    PERFORM 1
    FROM "LightingSchedule"
    WHERE "id" IN (old_parent_id, new_parent_id)
    ORDER BY "id"
    FOR UPDATE;
  END IF;

  IF old_parent_id IS NOT NULL AND old_parent_id IS DISTINCT FROM new_parent_id THEN
    UPDATE "LightingSchedule"
    SET "targetCount" = "targetCount" - 1
    WHERE "id" = old_parent_id AND "targetCount" > 0;

    IF NOT FOUND AND EXISTS (SELECT 1 FROM "LightingSchedule" WHERE "id" = old_parent_id) THEN
      RAISE EXCEPTION 'lighting schedule target counter cannot underflow' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF new_parent_id IS NOT NULL AND new_parent_id IS DISTINCT FROM old_parent_id THEN
    UPDATE "LightingSchedule"
    SET "targetCount" = "targetCount" + 1
    WHERE "id" = new_parent_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "LightingScheduleFixture_target_count_maintenance"
BEFORE INSERT OR UPDATE OR DELETE ON "LightingScheduleFixture"
FOR EACH ROW EXECUTE FUNCTION "maintain_lighting_schedule_target_count"();

CREATE FUNCTION "assert_lighting_schedule_has_target"(schedule_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  stored_count INTEGER;
  actual_count INTEGER;
BEGIN
  SELECT "targetCount" INTO stored_count
  FROM "LightingSchedule"
  WHERE "id" = schedule_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::INTEGER INTO actual_count
  FROM "LightingScheduleFixture"
  WHERE "scheduleId" = schedule_id;

  IF stored_count IS DISTINCT FROM actual_count THEN
    RAISE EXCEPTION 'lighting schedule target counter does not match fixture rows' USING ERRCODE = '23514';
  END IF;
  IF stored_count < 1 THEN
    RAISE EXCEPTION 'lighting schedule requires at least one target fixture' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "enforce_lighting_schedule_target_cardinality"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'LightingSchedule' THEN
    PERFORM "assert_lighting_schedule_has_target"(NEW."id");
  ELSE
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      PERFORM "assert_lighting_schedule_has_target"(OLD."scheduleId");
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      PERFORM "assert_lighting_schedule_has_target"(NEW."scheduleId");
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "LightingSchedule_target_cardinality"
AFTER INSERT OR UPDATE ON "LightingSchedule"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_lighting_schedule_target_cardinality"();

CREATE CONSTRAINT TRIGGER "LightingScheduleFixture_target_cardinality"
AFTER INSERT OR UPDATE OR DELETE ON "LightingScheduleFixture"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_lighting_schedule_target_cardinality"();

CREATE FUNCTION "maintain_vehicle_event_fixture_counts"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_parent_id TEXT;
  new_parent_id TEXT;
  counter_column TEXT;
  affected_rows INTEGER;
BEGIN
  counter_column := CASE TG_TABLE_NAME
    WHEN 'VehicleEventSource' THEN 'sourceCount'
    WHEN 'VehicleEventTarget' THEN 'targetCount'
  END;

  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    old_parent_id := OLD."ruleId";
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    new_parent_id := NEW."ruleId";
  END IF;

  IF old_parent_id IS NOT NULL
    AND new_parent_id IS NOT NULL
    AND old_parent_id IS DISTINCT FROM new_parent_id
  THEN
    PERFORM 1
    FROM "VehicleEventRule"
    WHERE "id" IN (old_parent_id, new_parent_id)
    ORDER BY "id"
    FOR UPDATE;
  END IF;

  IF old_parent_id IS NOT NULL AND old_parent_id IS DISTINCT FROM new_parent_id THEN
    EXECUTE format(
      'UPDATE "VehicleEventRule" SET %1$I = %1$I - 1 WHERE "id" = $1 AND %1$I > 0',
      counter_column
    ) USING old_parent_id;
    GET DIAGNOSTICS affected_rows = ROW_COUNT;

    IF affected_rows = 0 AND EXISTS (SELECT 1 FROM "VehicleEventRule" WHERE "id" = old_parent_id) THEN
      RAISE EXCEPTION 'vehicle event % counter cannot underflow', counter_column USING ERRCODE = '23514';
    END IF;
  END IF;

  IF new_parent_id IS NOT NULL AND new_parent_id IS DISTINCT FROM old_parent_id THEN
    EXECUTE format(
      'UPDATE "VehicleEventRule" SET %1$I = %1$I + 1 WHERE "id" = $1',
      counter_column
    ) USING new_parent_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "VehicleEventSource_count_maintenance"
BEFORE INSERT OR UPDATE OR DELETE ON "VehicleEventSource"
FOR EACH ROW EXECUTE FUNCTION "maintain_vehicle_event_fixture_counts"();

CREATE TRIGGER "VehicleEventTarget_count_maintenance"
BEFORE INSERT OR UPDATE OR DELETE ON "VehicleEventTarget"
FOR EACH ROW EXECUTE FUNCTION "maintain_vehicle_event_fixture_counts"();

CREATE FUNCTION "assert_vehicle_event_rule_has_source_and_target"(rule_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  stored_source_count INTEGER;
  stored_target_count INTEGER;
  actual_source_count INTEGER;
  actual_target_count INTEGER;
BEGIN
  SELECT "sourceCount", "targetCount"
  INTO stored_source_count, stored_target_count
  FROM "VehicleEventRule"
  WHERE "id" = rule_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::INTEGER INTO actual_source_count
  FROM "VehicleEventSource"
  WHERE "ruleId" = rule_id;
  SELECT COUNT(*)::INTEGER INTO actual_target_count
  FROM "VehicleEventTarget"
  WHERE "ruleId" = rule_id;

  IF stored_source_count IS DISTINCT FROM actual_source_count
    OR stored_target_count IS DISTINCT FROM actual_target_count
  THEN
    RAISE EXCEPTION 'vehicle event counters do not match fixture rows' USING ERRCODE = '23514';
  END IF;
  IF stored_source_count < 1 OR stored_target_count < 1 THEN
    RAISE EXCEPTION 'vehicle event rule requires at least one source and target fixture' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "enforce_vehicle_event_rule_cardinality"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'VehicleEventRule' THEN
    PERFORM "assert_vehicle_event_rule_has_source_and_target"(NEW."id");
  ELSE
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      PERFORM "assert_vehicle_event_rule_has_source_and_target"(OLD."ruleId");
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      PERFORM "assert_vehicle_event_rule_has_source_and_target"(NEW."ruleId");
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "VehicleEventRule_cardinality"
AFTER INSERT OR UPDATE ON "VehicleEventRule"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_vehicle_event_rule_cardinality"();

CREATE CONSTRAINT TRIGGER "VehicleEventSource_cardinality"
AFTER INSERT OR UPDATE OR DELETE ON "VehicleEventSource"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_vehicle_event_rule_cardinality"();

CREATE CONSTRAINT TRIGGER "VehicleEventTarget_cardinality"
AFTER INSERT OR UPDATE OR DELETE ON "VehicleEventTarget"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_vehicle_event_rule_cardinality"();

CREATE FUNCTION "maintain_manual_override_target_count"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_parent_id TEXT;
  new_parent_id TEXT;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    old_parent_id := OLD."manualOverrideId";
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    new_parent_id := NEW."manualOverrideId";
  END IF;

  IF old_parent_id IS NOT NULL
    AND new_parent_id IS NOT NULL
    AND old_parent_id IS DISTINCT FROM new_parent_id
  THEN
    PERFORM 1
    FROM "ManualOverride"
    WHERE "id" IN (old_parent_id, new_parent_id)
    ORDER BY "id"
    FOR UPDATE;
  END IF;

  IF old_parent_id IS NOT NULL AND old_parent_id IS DISTINCT FROM new_parent_id THEN
    UPDATE "ManualOverride"
    SET "targetCount" = "targetCount" - 1
    WHERE "id" = old_parent_id AND "targetCount" > 0;

    IF NOT FOUND AND EXISTS (SELECT 1 FROM "ManualOverride" WHERE "id" = old_parent_id) THEN
      RAISE EXCEPTION 'manual override target counter cannot underflow' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF new_parent_id IS NOT NULL AND new_parent_id IS DISTINCT FROM old_parent_id THEN
    UPDATE "ManualOverride"
    SET "targetCount" = "targetCount" + 1
    WHERE "id" = new_parent_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ManualOverrideFixture_target_count_maintenance"
BEFORE INSERT OR UPDATE OR DELETE ON "ManualOverrideFixture"
FOR EACH ROW EXECUTE FUNCTION "maintain_manual_override_target_count"();

CREATE FUNCTION "assert_manual_override_has_target"(manual_override_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  stored_count INTEGER;
  actual_count INTEGER;
BEGIN
  SELECT "targetCount" INTO stored_count
  FROM "ManualOverride"
  WHERE "id" = manual_override_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::INTEGER INTO actual_count
  FROM "ManualOverrideFixture"
  WHERE "manualOverrideId" = manual_override_id;

  IF stored_count IS DISTINCT FROM actual_count THEN
    RAISE EXCEPTION 'manual override target counter does not match fixture rows' USING ERRCODE = '23514';
  END IF;
  IF stored_count < 1 THEN
    RAISE EXCEPTION 'manual override requires at least one target fixture' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "enforce_manual_override_target_cardinality"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'ManualOverride' THEN
    PERFORM "assert_manual_override_has_target"(NEW."id");
  ELSE
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      PERFORM "assert_manual_override_has_target"(OLD."manualOverrideId");
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      PERFORM "assert_manual_override_has_target"(NEW."manualOverrideId");
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ManualOverride_target_cardinality"
AFTER INSERT OR UPDATE ON "ManualOverride"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_manual_override_target_cardinality"();

CREATE CONSTRAINT TRIGGER "ManualOverrideFixture_target_cardinality"
AFTER INSERT OR UPDATE OR DELETE ON "ManualOverrideFixture"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_manual_override_target_cardinality"();

CREATE FUNCTION "prevent_gateway_automation_site_reassignment"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."siteId" IS NULL OR NEW."siteId" IS NOT DISTINCT FROM OLD."siteId" THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM "GatewayAutomationConfiguration" WHERE "gatewayId" = OLD."id")
    OR EXISTS (SELECT 1 FROM "LightingSchedule" WHERE "gatewayId" = OLD."id")
    OR EXISTS (SELECT 1 FROM "VehicleEventRule" WHERE "gatewayId" = OLD."id")
    OR EXISTS (SELECT 1 FROM "ManualOverride" WHERE "gatewayId" = OLD."id")
    OR EXISTS (SELECT 1 FROM "AutomationExecution" WHERE "gatewayId" = OLD."id")
    OR EXISTS (
      SELECT 1
      FROM "MqttOutbox"
      WHERE "gatewayId" = OLD."id" AND "publishedAt" IS NULL
    )
  THEN
    RAISE EXCEPTION 'cannot reassign Gateway Site while automation dependencies exist' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Gateway_automation_site_reassignment_guard"
BEFORE UPDATE OF "siteId" ON "Gateway"
FOR EACH ROW EXECUTE FUNCTION "prevent_gateway_automation_site_reassignment"();

COMMIT;

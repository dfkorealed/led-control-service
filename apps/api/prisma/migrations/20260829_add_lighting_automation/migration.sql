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
  CONSTRAINT "VehicleEventRule_hold_check" CHECK ("holdSeconds" BETWEEN 5 AND 1800)
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
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ManualOverride_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManualOverride_brightness_check" CHECK ("brightnessPercent" BETWEEN 0 AND 100),
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
  ADD CONSTRAINT "LightingScheduleFixture_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

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
  ADD CONSTRAINT "VehicleEventSource_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "VehicleEventTarget"
  ADD CONSTRAINT "VehicleEventTarget_ruleId_siteId_gatewayId_fkey"
  FOREIGN KEY ("ruleId", "siteId", "gatewayId")
  REFERENCES "VehicleEventRule"("id", "siteId", "gatewayId") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "VehicleEventTarget_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

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
  ADD CONSTRAINT "ManualOverrideFixture_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

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

CREATE FUNCTION "validate_automation_fixture_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  fixture_site_id TEXT;
  fixture_mesh_node_id TEXT;
  fixture_gateway_id TEXT;
BEGIN
  SELECT floor."siteId", fixture."meshNodeId"
  INTO fixture_site_id, fixture_mesh_node_id
  FROM "Fixture" AS fixture
  JOIN "Floor" AS floor ON floor."id" = fixture."floorId"
  WHERE fixture."id" = NEW."fixtureId"
  FOR SHARE OF fixture, floor;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'automation fixture does not exist' USING ERRCODE = '23514';
  END IF;
  IF fixture_mesh_node_id IS NULL THEN
    RAISE EXCEPTION 'fixture must be assigned to a MeshNode' USING ERRCODE = '23514';
  END IF;

  SELECT "gatewayId"
  INTO fixture_gateway_id
  FROM "MeshNode"
  WHERE "id" = fixture_mesh_node_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'fixture must be assigned to a MeshNode' USING ERRCODE = '23514';
  END IF;
  IF fixture_site_id IS DISTINCT FROM NEW."siteId" THEN
    RAISE EXCEPTION 'fixture Site does not match automation owner' USING ERRCODE = '23514';
  END IF;
  IF fixture_gateway_id IS DISTINCT FROM NEW."gatewayId" THEN
    RAISE EXCEPTION 'fixture Gateway does not match automation owner' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "LightingScheduleFixture_scope_check"
BEFORE INSERT OR UPDATE OF "fixtureId", "siteId", "gatewayId" ON "LightingScheduleFixture"
FOR EACH ROW EXECUTE FUNCTION "validate_automation_fixture_scope"();

CREATE TRIGGER "VehicleEventSource_scope_check"
BEFORE INSERT OR UPDATE OF "fixtureId", "siteId", "gatewayId" ON "VehicleEventSource"
FOR EACH ROW EXECUTE FUNCTION "validate_automation_fixture_scope"();

CREATE TRIGGER "VehicleEventTarget_scope_check"
BEFORE INSERT OR UPDATE OF "fixtureId", "siteId", "gatewayId" ON "VehicleEventTarget"
FOR EACH ROW EXECUTE FUNCTION "validate_automation_fixture_scope"();

CREATE TRIGGER "ManualOverrideFixture_scope_check"
BEFORE INSERT OR UPDATE OF "fixtureId", "siteId", "gatewayId" ON "ManualOverrideFixture"
FOR EACH ROW EXECUTE FUNCTION "validate_automation_fixture_scope"();

CREATE FUNCTION "prevent_fixture_automation_scope_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  fixture_site_id TEXT;
  fixture_gateway_id TEXT;
BEGIN
  SELECT "siteId" INTO fixture_site_id FROM "Floor" WHERE "id" = NEW."floorId" FOR SHARE;
  SELECT "gatewayId" INTO fixture_gateway_id FROM "MeshNode" WHERE "id" = NEW."meshNodeId" FOR SHARE;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT "siteId", "gatewayId" FROM "LightingScheduleFixture" WHERE "fixtureId" = OLD."id"
      UNION ALL
      SELECT "siteId", "gatewayId" FROM "VehicleEventSource" WHERE "fixtureId" = OLD."id"
      UNION ALL
      SELECT "siteId", "gatewayId" FROM "VehicleEventTarget" WHERE "fixtureId" = OLD."id"
      UNION ALL
      SELECT "siteId", "gatewayId" FROM "ManualOverrideFixture" WHERE "fixtureId" = OLD."id"
    ) AS automation_reference
    WHERE automation_reference."siteId" IS DISTINCT FROM fixture_site_id
  ) THEN
    RAISE EXCEPTION 'fixture Site change would invalidate automation references' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT "siteId", "gatewayId" FROM "LightingScheduleFixture" WHERE "fixtureId" = OLD."id"
      UNION ALL
      SELECT "siteId", "gatewayId" FROM "VehicleEventSource" WHERE "fixtureId" = OLD."id"
      UNION ALL
      SELECT "siteId", "gatewayId" FROM "VehicleEventTarget" WHERE "fixtureId" = OLD."id"
      UNION ALL
      SELECT "siteId", "gatewayId" FROM "ManualOverrideFixture" WHERE "fixtureId" = OLD."id"
    ) AS automation_reference
    WHERE automation_reference."gatewayId" IS DISTINCT FROM fixture_gateway_id
  ) THEN
    RAISE EXCEPTION 'fixture Gateway change would invalidate automation references' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Fixture_automation_scope_change_guard"
BEFORE UPDATE OF "floorId", "meshNodeId" ON "Fixture"
FOR EACH ROW
WHEN (OLD."floorId" IS DISTINCT FROM NEW."floorId" OR OLD."meshNodeId" IS DISTINCT FROM NEW."meshNodeId")
EXECUTE FUNCTION "prevent_fixture_automation_scope_change"();

CREATE FUNCTION "prevent_floor_automation_scope_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Fixture" AS fixture
    JOIN (
      SELECT "fixtureId", "siteId" FROM "LightingScheduleFixture"
      UNION ALL
      SELECT "fixtureId", "siteId" FROM "VehicleEventSource"
      UNION ALL
      SELECT "fixtureId", "siteId" FROM "VehicleEventTarget"
      UNION ALL
      SELECT "fixtureId", "siteId" FROM "ManualOverrideFixture"
    ) AS automation_reference ON automation_reference."fixtureId" = fixture."id"
    WHERE fixture."floorId" = OLD."id"
      AND automation_reference."siteId" IS DISTINCT FROM NEW."siteId"
  ) THEN
    RAISE EXCEPTION 'Floor Site change would invalidate automation references' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Floor_automation_scope_change_guard"
BEFORE UPDATE OF "siteId" ON "Floor"
FOR EACH ROW
WHEN (OLD."siteId" IS DISTINCT FROM NEW."siteId")
EXECUTE FUNCTION "prevent_floor_automation_scope_change"();

CREATE FUNCTION "prevent_mesh_node_automation_scope_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Fixture" AS fixture
    JOIN (
      SELECT "fixtureId", "gatewayId" FROM "LightingScheduleFixture"
      UNION ALL
      SELECT "fixtureId", "gatewayId" FROM "VehicleEventSource"
      UNION ALL
      SELECT "fixtureId", "gatewayId" FROM "VehicleEventTarget"
      UNION ALL
      SELECT "fixtureId", "gatewayId" FROM "ManualOverrideFixture"
    ) AS automation_reference ON automation_reference."fixtureId" = fixture."id"
    WHERE fixture."meshNodeId" = OLD."id"
      AND automation_reference."gatewayId" IS DISTINCT FROM NEW."gatewayId"
  ) THEN
    RAISE EXCEPTION 'MeshNode Gateway change would invalidate automation references' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "MeshNode_automation_scope_change_guard"
BEFORE UPDATE OF "gatewayId" ON "MeshNode"
FOR EACH ROW
WHEN (OLD."gatewayId" IS DISTINCT FROM NEW."gatewayId")
EXECUTE FUNCTION "prevent_mesh_node_automation_scope_change"();

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

CREATE FUNCTION "assert_lighting_schedule_has_target"(schedule_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM "LightingSchedule" WHERE "id" = schedule_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "LightingScheduleFixture" WHERE "scheduleId" = schedule_id) THEN
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

CREATE FUNCTION "assert_vehicle_event_rule_has_source_and_target"(rule_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM "VehicleEventRule" WHERE "id" = rule_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "VehicleEventSource" WHERE "ruleId" = rule_id)
    OR NOT EXISTS (SELECT 1 FROM "VehicleEventTarget" WHERE "ruleId" = rule_id)
  THEN
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

CREATE FUNCTION "assert_manual_override_has_target"(manual_override_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM "ManualOverride" WHERE "id" = manual_override_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "ManualOverrideFixture" WHERE "manualOverrideId" = manual_override_id) THEN
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

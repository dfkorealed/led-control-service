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

CREATE UNIQUE INDEX "Gateway_id_siteId_key" ON "Gateway"("id", "siteId");

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
    CHECK ("payloadHash" IS NULL OR "payloadHash" ~ '^sha256:[a-f0-9]{64}$')
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
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VehicleEventSource_pkey" PRIMARY KEY ("ruleId","fixtureId")
);

CREATE TABLE "VehicleEventTarget" (
  "ruleId" TEXT NOT NULL,
  "fixtureId" TEXT NOT NULL,
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
    CHECK ("brightnessPercent" IS NULL OR "brightnessPercent" BETWEEN 0 AND 100)
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
CREATE INDEX "LightingScheduleFixture_fixtureId_idx"
  ON "LightingScheduleFixture"("fixtureId");

CREATE INDEX "VehicleEventRule_siteId_status_createdAt_idx"
  ON "VehicleEventRule"("siteId", "status", "createdAt");
CREATE INDEX "VehicleEventRule_gatewayId_status_idx"
  ON "VehicleEventRule"("gatewayId", "status");
CREATE INDEX "VehicleEventSource_fixtureId_idx" ON "VehicleEventSource"("fixtureId");
CREATE INDEX "VehicleEventTarget_fixtureId_idx" ON "VehicleEventTarget"("fixtureId");

CREATE UNIQUE INDEX "ManualOverride_commandId_key" ON "ManualOverride"("commandId");
CREATE INDEX "ManualOverride_siteId_overrideUntil_idx" ON "ManualOverride"("siteId", "overrideUntil");
CREATE INDEX "ManualOverride_gatewayId_overrideUntil_idx" ON "ManualOverride"("gatewayId", "overrideUntil");
CREATE INDEX "ManualOverride_requestedById_createdAt_idx" ON "ManualOverride"("requestedById", "createdAt");
CREATE INDEX "ManualOverrideFixture_fixtureId_idx" ON "ManualOverrideFixture"("fixtureId");

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
  FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "GatewayAutomationConfiguration_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LightingSchedule"
  ADD CONSTRAINT "LightingSchedule_gatewayId_siteId_fkey"
  FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LightingSchedule_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LightingSchedule_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LightingSchedule_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LightingScheduleFixture"
  ADD CONSTRAINT "LightingScheduleFixture_scheduleId_fkey"
  FOREIGN KEY ("scheduleId") REFERENCES "LightingSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "LightingScheduleFixture_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VehicleEventRule"
  ADD CONSTRAINT "VehicleEventRule_gatewayId_siteId_fkey"
  FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "VehicleEventRule_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "VehicleEventRule_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "VehicleEventRule_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VehicleEventSource"
  ADD CONSTRAINT "VehicleEventSource_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "VehicleEventRule"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "VehicleEventSource_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VehicleEventTarget"
  ADD CONSTRAINT "VehicleEventTarget_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "VehicleEventRule"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "VehicleEventTarget_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ManualOverride"
  ADD CONSTRAINT "ManualOverride_gatewayId_siteId_fkey"
  FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ManualOverride_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ManualOverride_commandId_fkey"
  FOREIGN KEY ("commandId") REFERENCES "Command"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ManualOverride_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ManualOverrideFixture"
  ADD CONSTRAINT "ManualOverrideFixture_manualOverrideId_fkey"
  FOREIGN KEY ("manualOverrideId") REFERENCES "ManualOverride"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ManualOverrideFixture_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AutomationExecution"
  ADD CONSTRAINT "AutomationExecution_gatewayId_siteId_fkey"
  FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AutomationExecution_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AutomationExecution_lightingScheduleId_fkey"
  FOREIGN KEY ("lightingScheduleId") REFERENCES "LightingSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "AutomationExecution_vehicleEventRuleId_fkey"
  FOREIGN KEY ("vehicleEventRuleId") REFERENCES "VehicleEventRule"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "AutomationExecution_manualOverrideId_fkey"
  FOREIGN KEY ("manualOverrideId") REFERENCES "ManualOverride"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AutomationExecutionFixtureResult"
  ADD CONSTRAINT "AutomationExecutionFixtureResult_executionId_fkey"
  FOREIGN KEY ("executionId") REFERENCES "AutomationExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AutomationExecutionFixtureResult_fixtureId_fkey"
  FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;

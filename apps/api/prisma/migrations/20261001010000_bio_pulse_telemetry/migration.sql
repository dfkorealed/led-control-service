ALTER TABLE "MqttOutbox" ADD COLUMN "automationAssignmentVersion" INTEGER;
ALTER TABLE "MqttOutbox" ADD CONSTRAINT "MqttOutbox_automation_assignment_check"
  CHECK ("automationAssignmentVersion" IS NULL OR "automationAssignmentVersion" > 0);

CREATE TABLE "BioPulseTelemetryEvent" (
  "id" TEXT PRIMARY KEY, "siteId" TEXT NOT NULL, "gatewayId" TEXT NOT NULL,
  "assignmentVersion" INTEGER NOT NULL CHECK ("assignmentVersion" > 0),
  "eventId" TEXT NOT NULL, "sequence" BIGINT NOT NULL CHECK ("sequence" >= 0),
  "revision" INTEGER NOT NULL CHECK ("revision" >= 0), "ruleId" TEXT NOT NULL,
  "occurrenceKey" TEXT NOT NULL, "sourceFixtureId" TEXT NOT NULL, "targetFixtureIds" TEXT[] NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('vehicle_detected','event_started','event_extended','event_ended','action_result')),
  "occurredAt" TIMESTAMP(3) NOT NULL, "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL CHECK ("payloadHash" ~ '^sha256:[a-f0-9]{64}$'),
  "disposition" TEXT NOT NULL CHECK ("disposition" IN ('accepted','stale_configuration','stale_sequence','untrusted_time')),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE,
  FOREIGN KEY ("gatewayId","siteId") REFERENCES "Gateway"("id","siteId") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "BioPulseTelemetryEvent_gatewayId_eventId_key" ON "BioPulseTelemetryEvent"("gatewayId","eventId");
CREATE UNIQUE INDEX "BioPulseTelemetryEvent_gatewayId_assignmentVersion_sequence_key" ON "BioPulseTelemetryEvent"("gatewayId","assignmentVersion","sequence");
CREATE INDEX "BioPulseTelemetryEvent_siteId_sourceFixtureId_receivedAt_idx" ON "BioPulseTelemetryEvent"("siteId","sourceFixtureId","receivedAt");

CREATE TABLE "BioPulseTelemetryProjection" (
  "gatewayId" TEXT NOT NULL, "siteId" TEXT NOT NULL, "assignmentVersion" INTEGER NOT NULL CHECK ("assignmentVersion" > 0),
  "ruleId" TEXT NOT NULL, "occurrenceKey" TEXT NOT NULL, "revision" INTEGER NOT NULL,
  "sourceFixtureId" TEXT NOT NULL, "sourceMeshNodeId" TEXT NOT NULL, "targetFixtureIds" TEXT[] NOT NULL, "sequence" BIGINT NOT NULL,
  "lastPulseAt" TIMESTAMP(3), "lastPulseSequence" BIGINT, "health" TEXT NOT NULL DEFAULT 'unverified' CHECK ("health" IN ('unverified','healthy','degraded')),
  "healthReason" TEXT, "degradedSince" TIMESTAMP(3), "restorationPending" BOOLEAN,
  "restorationReason" TEXT, "configurationReadback" JSONB, "lastEventAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("gatewayId","assignmentVersion","ruleId","occurrenceKey"),
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE,
  FOREIGN KEY ("gatewayId","siteId") REFERENCES "Gateway"("id","siteId") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX "BioPulseTelemetryProjection_siteId_sourceFixtureId_sequence_idx" ON "BioPulseTelemetryProjection"("siteId","sourceFixtureId","sequence" DESC);

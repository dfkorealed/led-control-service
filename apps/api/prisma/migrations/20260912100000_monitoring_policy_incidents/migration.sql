BEGIN;

ALTER TABLE "Site"
  ADD COLUMN "gatewayOfflineAfterSeconds" INTEGER NOT NULL DEFAULT 90,
  ADD COLUMN "fixtureStaleAfterSeconds" INTEGER NOT NULL DEFAULT 180,
  ADD CONSTRAINT "Site_gatewayOfflineAfterSeconds_check" CHECK ("gatewayOfflineAfterSeconds" BETWEEN 30 AND 900),
  ADD CONSTRAINT "Site_fixtureStaleAfterSeconds_check" CHECK ("fixtureStaleAfterSeconds" BETWEEN 60 AND 3600);

CREATE TYPE "MonitoringIncidentType" AS ENUM ('gateway_offline', 'fixture_stale', 'fixture_fault', 'command_failed');
CREATE TYPE "MonitoringIncidentStatus" AS ENUM ('open', 'acknowledged', 'resolved');
CREATE TYPE "MonitoringIncidentResolutionKind" AS ENUM ('automatic_recovery', 'operator_confirmed');
CREATE UNIQUE INDEX "Fixture_id_siteId_key" ON "Fixture"("id", "siteId");

CREATE TABLE "MonitoringIncident" (
  "id" TEXT PRIMARY KEY,
  "siteId" TEXT NOT NULL,
  "type" "MonitoringIncidentType" NOT NULL,
  "status" "MonitoringIncidentStatus" NOT NULL DEFAULT 'open',
  "targetKey" TEXT NOT NULL,
  "fixtureId" TEXT,
  "gatewayId" TEXT,
  "activeKey" TEXT,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedByUserId" TEXT,
  "assignedToUserId" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolvedByUserId" TEXT,
  "resolutionKind" "MonitoringIncidentResolutionKind",
  "resolutionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MonitoringIncident_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringIncident_fixtureId_siteId_fkey" FOREIGN KEY ("fixtureId", "siteId") REFERENCES "Fixture"("id", "siteId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringIncident_gatewayId_siteId_fkey" FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringIncident_acknowledgedByUserId_fkey" FOREIGN KEY ("acknowledgedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "MonitoringIncident_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "MonitoringIncident_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "MonitoringIncident_target_check" CHECK (
    ("type" = 'gateway_offline' AND "gatewayId" IS NOT NULL AND "fixtureId" IS NULL AND "targetKey" = 'gateway:' || "gatewayId") OR
    ("type" <> 'gateway_offline' AND "fixtureId" IS NOT NULL AND "gatewayId" IS NULL AND "targetKey" = 'fixture:' || "fixtureId")
  ),
  CONSTRAINT "MonitoringIncident_lifecycle_check" CHECK (
    ("status" IN ('open', 'acknowledged') AND "activeKey" IS NOT NULL AND
      "activeKey" = "siteId" || ':' || "type"::text || ':' || "targetKey" AND
      "resolvedAt" IS NULL AND "resolvedByUserId" IS NULL AND "resolutionKind" IS NULL AND "resolutionNote" IS NULL) OR
    ("status" = 'resolved' AND "activeKey" IS NULL AND "resolvedAt" IS NOT NULL AND "resolutionKind" IS NOT NULL)
  ),
  CONSTRAINT "MonitoringIncident_acknowledgement_check" CHECK (
    ("status" <> 'open' OR ("acknowledgedAt" IS NULL AND "acknowledgedByUserId" IS NULL)) AND
    ("status" <> 'acknowledged' OR "acknowledgedAt" IS NOT NULL) AND
    ("acknowledgedByUserId" IS NULL OR "acknowledgedAt" IS NOT NULL)
  ),
  CONSTRAINT "MonitoringIncident_time_check" CHECK (
    "lastObservedAt" >= "openedAt" AND
    ("acknowledgedAt" IS NULL OR "acknowledgedAt" >= "openedAt") AND
    ("resolvedAt" IS NULL OR ("resolvedAt" >= "lastObservedAt" AND ("acknowledgedAt" IS NULL OR "resolvedAt" >= "acknowledgedAt")))
  )
);

CREATE UNIQUE INDEX "MonitoringIncident_activeKey_key" ON "MonitoringIncident"("activeKey");
CREATE INDEX "MonitoringIncident_siteId_status_openedAt_id_idx" ON "MonitoringIncident"("siteId", "status", "openedAt", "id");
CREATE INDEX "MonitoringIncident_siteId_type_openedAt_id_idx" ON "MonitoringIncident"("siteId", "type", "openedAt", "id");
CREATE INDEX "MonitoringIncident_fixtureId_siteId_idx" ON "MonitoringIncident"("fixtureId", "siteId");
CREATE INDEX "MonitoringIncident_gatewayId_siteId_idx" ON "MonitoringIncident"("gatewayId", "siteId");
CREATE INDEX "MonitoringIncident_active_first_idx" ON "MonitoringIncident"("siteId", ("resolvedAt" IS NULL) DESC, "openedAt" DESC, "id" DESC);

COMMIT;

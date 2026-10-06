BEGIN;

-- Personal hiding neither reads nor resolves an operational occurrence.
CREATE TABLE "MonitoringIncidentDismissal" (
  "incidentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "MonitoringIncidentDismissal_pkey" PRIMARY KEY ("incidentId", "userId"),
  CONSTRAINT "MonitoringIncidentDismissal_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "MonitoringIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringIncidentDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MonitoringIncidentDismissal_userId_idx" ON "MonitoringIncidentDismissal"("userId");

-- First durable reservation is acceptance. Keep its exact IDs and response for
-- the parents' lifetime: no TTL can safely turn an old retry into a new request.
CREATE TABLE "MonitoringIncidentDismissalRequest" (
  "siteId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clientRequestId" UUID NOT NULL,
  "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "targetIncidentIds" TEXT[] NOT NULL,
  "dismissedCount" INTEGER,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "MonitoringIncidentDismissalRequest_pkey" PRIMARY KEY ("siteId", "userId", "clientRequestId"),
  CONSTRAINT "MonitoringIncidentDismissalRequest_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringIncidentDismissalRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringIncidentDismissalRequest_completion_check" CHECK (
    ("completedAt" IS NULL AND "dismissedCount" IS NULL) OR
    ("completedAt" IS NOT NULL AND "dismissedCount" IS NOT NULL AND "dismissedCount" >= 0)
  )
);
CREATE INDEX "MonitoringIncidentDismissalRequest_userId_idx" ON "MonitoringIncidentDismissalRequest"("userId");

COMMIT;

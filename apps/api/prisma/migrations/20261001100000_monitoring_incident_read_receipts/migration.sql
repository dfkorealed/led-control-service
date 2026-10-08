BEGIN;

-- Personal viewing is separate from operational acknowledgement/revision.
-- No independent TTL: receipts live only as long as their incident and user.
CREATE TABLE "MonitoringIncidentReadReceipt" (
  "incidentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "MonitoringIncidentReadReceipt_pkey" PRIMARY KEY ("incidentId", "userId"),
  CONSTRAINT "MonitoringIncidentReadReceipt_incidentId_fkey"
    FOREIGN KEY ("incidentId") REFERENCES "MonitoringIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MonitoringIncidentReadReceipt_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MonitoringIncidentReadReceipt_userId_idx" ON "MonitoringIncidentReadReceipt"("userId");

COMMIT;

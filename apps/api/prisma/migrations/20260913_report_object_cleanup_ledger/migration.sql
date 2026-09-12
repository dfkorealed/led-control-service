-- No Site/Report FK: this small key-only tombstone must survive every cascade and
-- metadata retention boundary. A finite timeout cannot bound a paused worker.
CREATE TABLE "EnergyReportObjectCleanup" (
  "reportId" TEXT NOT NULL PRIMARY KEY,
  "siteId" TEXT NOT NULL,
  "objectKeys" JSONB NOT NULL,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastCleanedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EnergyReportObjectCleanup_lease_pair" CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL)),
  CONSTRAINT "EnergyReportObjectCleanup_keys" CHECK (jsonb_typeof("objectKeys") = 'array' AND jsonb_array_length("objectKeys") BETWEEN 1 AND 3)
);
CREATE INDEX "EnergyReportObjectCleanup_nextAttemptAt_leaseExpiresAt_idx" ON "EnergyReportObjectCleanup" ("nextAttemptAt", "leaseExpiresAt");
CREATE INDEX "EnergyReportObjectCleanup_siteId_idx" ON "EnergyReportObjectCleanup" ("siteId");

-- Existing site-cleanup payloads (including completed ones) already hold the
-- authority to delete these private objects. Preserve it in the permanent reaper.
INSERT INTO "EnergyReportObjectCleanup" ("reportId", "siteId", "objectKeys", "updatedAt")
SELECT split_part(key, '/', 3), split_part(key, '/', 2),
  jsonb_agg(DISTINCT format('reports/%s/%s/attempt-%s.%s', split_part(key, '/', 2), split_part(key, '/', 3), attempt, split_part(key, '.', 2))),
  CURRENT_TIMESTAMP
FROM "SiteDeletionCleanup", jsonb_array_elements_text("objectKeys") AS keys(key), generate_series(1, 3) AS attempt
WHERE key ~ '^reports/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/attempt-[1-3]\.(xlsx|pdf)$'
GROUP BY split_part(key, '/', 3), split_part(key, '/', 2);

CREATE TABLE "SensorModeOperation" (
  "commandId" TEXT PRIMARY KEY, "siteId" TEXT NOT NULL, "gatewayId" TEXT NOT NULL,
  "fixtureId" TEXT NOT NULL, "nodeId" TEXT NOT NULL, "meshAddress" TEXT NOT NULL,
  "assignmentVersion" INTEGER NOT NULL, "requestedById" TEXT NOT NULL, "clientRequestId" TEXT NOT NULL,
  "operation" TEXT NOT NULL, "requeryOfCommandId" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "supersededAt" TIMESTAMP(3),
  "result" JSONB, "resultHash" TEXT, "resultEventId" TEXT, "payload" JSONB NOT NULL,
  "publishedAt" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedBy" TEXT, "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SensorModeOperation_fixtureId_siteId_fkey" FOREIGN KEY ("fixtureId", "siteId")
    REFERENCES "Fixture"("id", "siteId") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "SensorModeOperation_requeryOfCommandId_fkey" FOREIGN KEY ("requeryOfCommandId") REFERENCES "SensorModeOperation"("commandId") ON DELETE RESTRICT,
  CONSTRAINT "SensorModeOperation_contract_check" CHECK (
    "assignmentVersion" > 0 AND "operation" IN ('ensure_sensor', 'query') AND
    "status" IN ('pending', 'verified', 'mismatch', 'unknown', 'timed_out') AND
    "expiresAt" > "requestedAt" AND "expiresAt" <= "requestedAt" + INTERVAL '30 seconds' AND
    ("requeryOfCommandId" IS NULL OR ("operation" = 'query' AND "requeryOfCommandId" <> "commandId")) AND
    ("status" <> 'verified' OR COALESCE(("result" IS NOT NULL AND "result"->>'modeVerified' = 'true'
      AND "result"->>'observedMode' = 'sensor' AND "result"->>'evidence' = 'mode_get'), FALSE))
  )
);
CREATE UNIQUE INDEX "SensorModeOperation_siteId_requestedById_clientRequestId_key" ON "SensorModeOperation"("siteId", "requestedById", "clientRequestId");
CREATE UNIQUE INDEX "SensorModeOperation_resultEventId_key" ON "SensorModeOperation"("resultEventId");
CREATE INDEX "SensorModeOperation_status_nextAttemptAt_leaseExpiresAt_idx" ON "SensorModeOperation"("status", "nextAttemptAt", "leaseExpiresAt");
CREATE INDEX "SensorModeOperation_fixtureId_supersededAt_idx" ON "SensorModeOperation"("fixtureId", "supersededAt");

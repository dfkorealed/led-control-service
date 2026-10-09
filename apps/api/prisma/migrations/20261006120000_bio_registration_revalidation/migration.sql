BEGIN;
CREATE TABLE "BioRegistrationRevalidationOperation" (
  "commandId" TEXT PRIMARY KEY, "siteId" TEXT NOT NULL, "gatewayId" TEXT NOT NULL,
  "floorId" TEXT NOT NULL, "fixtureId" TEXT NOT NULL, "nodeId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL, "discoveredNodeId" TEXT NOT NULL, "originalProvisionCommandId" TEXT NOT NULL,
  "originalProvisionPayloadHash" TEXT NOT NULL, "requestedById" TEXT NOT NULL, "clientRequestId" TEXT NOT NULL,
  "assignmentVersion" INTEGER NOT NULL, "deviceIdentityHash" TEXT NOT NULL, "meshAddress" TEXT NOT NULL,
  "bindingSnapshot" JSONB NOT NULL, "bindingHash" TEXT NOT NULL, "payload" JSONB NOT NULL, "payloadHash" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "applyDeadlineAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "result" JSONB, "resultHash" TEXT, "resultEventId" TEXT,
  "proofAcceptedAt" TIMESTAMP(3), "supersededAt" TIMESTAMP(3), "appliedAt" TIMESTAMP(3), "auditId" TEXT,
  "publishedAt" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "lockedBy" TEXT, "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BioRegistrationRevalidationOperation_fixtureId_siteId_fkey" FOREIGN KEY ("fixtureId", "siteId")
    REFERENCES "Fixture"("id", "siteId") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "BioRegistrationRevalidationOperation_auditId_fkey" FOREIGN KEY ("auditId")
    REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BioRegistrationRevalidationOperation_contract_check" CHECK (
    "status" IN ('pending','observed','unknown','timed_out') AND "assignmentVersion" > 0 AND "attempts" >= 0 AND
    "deviceIdentityHash" ~ '^[0-9a-f]{64}$' AND "meshAddress" ~ '^0x[0-7][0-9a-f]{3}$' AND "meshAddress" <> '0x0000' AND
    "bindingHash" ~ '^sha256:[0-9a-f]{64}$' AND "payloadHash" ~ '^sha256:[0-9a-f]{64}$' AND
    "originalProvisionPayloadHash" ~ '^sha256:[0-9a-f]{64}$' AND
    "expiresAt" = "requestedAt" + INTERVAL '30 seconds' AND "applyDeadlineAt" = "requestedAt" + INTERVAL '120 seconds' AND
    (("result" IS NULL AND "resultHash" IS NULL AND "resultEventId" IS NULL) OR
     ("result" IS NOT NULL AND "resultHash" IS NOT NULL AND "resultEventId" IS NOT NULL AND "resultHash" ~ '^sha256:[0-9a-f]{64}$')) AND
    (("appliedAt" IS NULL AND "auditId" IS NULL) OR
     ("appliedAt" IS NOT NULL AND "auditId" IS NOT NULL AND "status"='observed' AND "supersededAt" IS NULL AND
      "appliedAt">="proofAcceptedAt" AND "appliedAt"<"applyDeadlineAt")) AND
    (("proofAcceptedAt" IS NULL AND "status"<>'observed') OR COALESCE(
      "status"='observed' AND "proofAcceptedAt">="requestedAt" AND "proofAcceptedAt"<"expiresAt" AND
      "result"->>'status'='observed' AND "result"->>'evidence'='mode_get' AND
      "result"->>'observedMode' IN ('sensor','force-on','force-off') AND
      ("result"->>'occurredAt')::timestamptz AT TIME ZONE 'UTC'>="requestedAt" AND
      ("result"->>'occurredAt')::timestamptz AT TIME ZONE 'UTC'<= "expiresAt" AND
      ("result"->>'occurredAt')::timestamptz AT TIME ZONE 'UTC'<= "proofAcceptedAt" + INTERVAL '1 second', FALSE))
  ),
  CONSTRAINT "BioRegistrationRevalidationOperation_envelope_check" CHECK (COALESCE(
    jsonb_typeof("bindingSnapshot")='object' AND jsonb_typeof("payload")='object' AND
    "payload"->>'version'='2' AND "payload"->>'purpose'='bio_registration_revalidation' AND "payload"->>'operation'='query' AND
    "payload"->>'commandId'="commandId" AND "payload"->>'siteId'="siteId" AND "payload"->>'gatewayId'="gatewayId" AND
    "payload"->>'fixtureId'="fixtureId" AND "payload"->>'nodeId'="nodeId" AND "payload"->>'meshAddress'="meshAddress" AND
    "payload"->>'deviceIdentityHash'="deviceIdentityHash" AND ("payload"->>'assignmentVersion')::numeric="assignmentVersion" AND
    ("payload"->>'requestedAt')::timestamptz AT TIME ZONE 'UTC'="requestedAt" AND
    ("payload"->>'expiresAt')::timestamptz AT TIME ZONE 'UTC'="expiresAt", FALSE)),
  CONSTRAINT "BioRegistrationRevalidationOperation_result_identity_check" CHECK ("result" IS NULL OR COALESCE(
    "result"->>'version'='2' AND "result"->>'purpose'='bio_registration_revalidation' AND "result"->>'operation'='query' AND
    "result"->>'commandId'="commandId" AND "result"->>'eventId'="resultEventId" AND
    "result"->>'siteId'="siteId" AND "result"->>'gatewayId'="gatewayId" AND "result"->>'fixtureId'="fixtureId" AND
    "result"->>'nodeId'="nodeId" AND "result"->>'deviceIdentityHash'="deviceIdentityHash" AND
    "result"->>'meshAddress'="meshAddress" AND ("result"->>'assignmentVersion')::numeric="assignmentVersion", FALSE))
);
CREATE UNIQUE INDEX "BioRegistrationRevalidationOperation_siteId_requestedById_clientRequestId_key"
  ON "BioRegistrationRevalidationOperation"("siteId","requestedById","clientRequestId");
CREATE UNIQUE INDEX "BioRegistrationRevalidationOperation_resultEventId_key" ON "BioRegistrationRevalidationOperation"("resultEventId");
CREATE UNIQUE INDEX "BioRegistrationRevalidationOperation_auditId_key" ON "BioRegistrationRevalidationOperation"("auditId");
CREATE INDEX "BioRegistrationRevalidationOperation_status_nextAttemptAt_leaseExpiresAt_idx"
  ON "BioRegistrationRevalidationOperation"("status","nextAttemptAt","leaseExpiresAt");
CREATE INDEX "BioRegistrationRevalidationOperation_fixtureId_supersededAt_idx"
  ON "BioRegistrationRevalidationOperation"("fixtureId","supersededAt");

-- Publisher lifecycle is mutable; command, accepted result and audit identity are write-once.
CREATE FUNCTION "guard_bio_registration_revalidation_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','result','resultHash','resultEventId','proofAcceptedAt','supersededAt','appliedAt','auditId',
      'publishedAt','attempts','nextAttemptAt','lockedBy','leaseExpiresAt','updatedAt']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','result','resultHash','resultEventId','proofAcceptedAt','supersededAt','appliedAt','auditId',
      'publishedAt','attempts','nextAttemptAt','lockedBy','leaseExpiresAt','updatedAt']) OR
     (OLD."result" IS NOT NULL AND ROW(NEW."result",NEW."resultHash",NEW."resultEventId",NEW."proofAcceptedAt") IS DISTINCT FROM
       ROW(OLD."result",OLD."resultHash",OLD."resultEventId",OLD."proofAcceptedAt")) OR
     (OLD."appliedAt" IS NOT NULL AND ROW(NEW."appliedAt",NEW."auditId") IS DISTINCT FROM ROW(OLD."appliedAt",OLD."auditId")) OR
     (OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt") THEN
    RAISE EXCEPTION 'BIO registration revalidation immutable identity changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BioRegistrationRevalidationOperation_immutable" BEFORE UPDATE ON "BioRegistrationRevalidationOperation"
  FOR EACH ROW EXECUTE FUNCTION "guard_bio_registration_revalidation_immutable"();
COMMIT;

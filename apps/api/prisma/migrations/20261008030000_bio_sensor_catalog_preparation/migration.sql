BEGIN;
CREATE TABLE "BioSensorProfileRevision" (
 "profileId" TEXT NOT NULL, "revision" BIGINT NOT NULL CHECK ("revision" BETWEEN 1 AND 9007199254740991),
 "status" TEXT NOT NULL CHECK ("status" IN ('approved','revoked')), "fingerprint" JSONB NOT NULL,
 "bodyHexes" JSONB NOT NULL, "linkPolicy" JSONB NOT NULL, "evidenceDigest" TEXT NOT NULL, "reuseScope" TEXT NOT NULL,
 "actorId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("profileId","revision")
);
CREATE INDEX "BioSensorProfileRevision_status_idx" ON "BioSensorProfileRevision"("status");
CREATE TABLE "BioSensorCatalogState" (
 "id" INTEGER NOT NULL DEFAULT 1 PRIMARY KEY CHECK ("id"=1),
 "revision" BIGINT NOT NULL DEFAULT 1 CHECK ("revision" BETWEEN 1 AND 9007199254740991)
);
-- Only an empty OFF catalog is seeded. Hardware approval requires explicit evidence.
INSERT INTO "BioSensorCatalogState" ("id","revision") VALUES (1,1);
CREATE TABLE "BioSensorSitePolicy" (
 "siteId" TEXT PRIMARY KEY, "enabled" BOOLEAN NOT NULL DEFAULT false, "ownerUserId" TEXT,
 "maximumResponseSeconds" INTEGER, "escalationAction" TEXT, "revision" BIGINT NOT NULL CHECK ("revision">0),
 CHECK (NOT "enabled" OR ("ownerUserId" IS NOT NULL AND "maximumResponseSeconds" IS NOT NULL AND "maximumResponseSeconds">0
   AND "escalationAction" IS NOT NULL AND length(trim("escalationAction"))>0)),
 FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "BioSensorCatalogDelivery" (
 "deliveryId" TEXT PRIMARY KEY, "siteId" TEXT NOT NULL, "gatewayId" TEXT NOT NULL,
 "assignmentVersion" INTEGER NOT NULL CHECK ("assignmentVersion">0), "catalogRevision" BIGINT NOT NULL CHECK ("catalogRevision">0),
 "payload" JSONB NOT NULL, "payloadHash" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
 "publishedAt" TIMESTAMP(3), "appliedAt" TIMESTAMP(3), "ackPayload" JSONB, "ackHash" TEXT,
 "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lockedBy" TEXT, "leaseExpiresAt" TIMESTAMP(3), "supersededAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ("status" IN ('pending','applied','duplicate','stale','rejected')),
 CHECK (("ackPayload" IS NULL) = ("ackHash" IS NULL)), CHECK ("attempts">=0)
);
CREATE UNIQUE INDEX "BioSensorCatalogDelivery_siteId_gatewayId_assignmentVersion_catalogRevision_key"
 ON "BioSensorCatalogDelivery"("siteId","gatewayId","assignmentVersion","catalogRevision");
CREATE INDEX "BioSensorCatalogDelivery_status_nextAttemptAt_leaseExpiresAt_idx" ON "BioSensorCatalogDelivery"("status","nextAttemptAt","leaseExpiresAt");
CREATE TABLE "BioSensorPreparationOperation" (
 "commandId" TEXT PRIMARY KEY, "siteId" TEXT NOT NULL, "gatewayId" TEXT NOT NULL, "fixtureId" TEXT NOT NULL, "nodeId" TEXT NOT NULL,
 "assignmentVersion" INTEGER NOT NULL CHECK ("assignmentVersion">0), "deviceIdentityHash" TEXT NOT NULL, "meshAddress" TEXT NOT NULL,
 "bindingHash" TEXT NOT NULL, "clientRequestId" TEXT NOT NULL, "actorId" TEXT NOT NULL,
 "operation" TEXT NOT NULL CHECK ("operation" IN ('query','ensure_sensor')), "catalogRevision" BIGINT NOT NULL CHECK ("catalogRevision">0),
 "payload" JSONB NOT NULL, "payloadHash" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
 "requestedAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "supersededAt" TIMESTAMP(3),
 "result" JSONB, "resultHash" TEXT, "resultEventId" TEXT, "ackPayload" JSONB, "ackHash" TEXT,
 "ackPublishedAt" TIMESTAMP(3), "ackNextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "ackAttempts" INTEGER NOT NULL DEFAULT 0, "ackLockedBy" TEXT, "ackLeaseExpiresAt" TIMESTAMP(3),
 "publishedAt" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lockedBy" TEXT, "leaseExpiresAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "BioSensorPreparationOperation_fixtureId_siteId_fkey" FOREIGN KEY ("fixtureId","siteId") REFERENCES "Fixture"("id","siteId") ON DELETE CASCADE ON UPDATE RESTRICT,
 CHECK ("status" IN ('pending','ready','needs_setup','unverified','degraded','unsupported','failed','timed_out')),
 CHECK (("result" IS NULL) = ("resultHash" IS NULL) AND ("resultHash" IS NULL) = ("resultEventId" IS NULL)
   AND ("resultHash" IS NULL) = ("ackPayload" IS NULL) AND ("ackPayload" IS NULL) = ("ackHash" IS NULL)),
 CHECK ("attempts">=0 AND "ackAttempts">=0)
);
CREATE UNIQUE INDEX "BioSensorPreparationOperation_resultEventId_key" ON "BioSensorPreparationOperation"("resultEventId");
CREATE UNIQUE INDEX "BioSensorPreparationOperation_siteId_actorId_clientRequestId_key" ON "BioSensorPreparationOperation"("siteId","actorId","clientRequestId");
CREATE INDEX "BioSensorPreparationOperation_fixtureId_supersededAt_idx" ON "BioSensorPreparationOperation"("fixtureId","supersededAt");
CREATE INDEX "BioSensorPreparationOperation_status_nextAttemptAt_leaseExpiresAt_idx" ON "BioSensorPreparationOperation"("status","nextAttemptAt","leaseExpiresAt");
CREATE INDEX "BioSensorPreparationOperation_ackNextAttemptAt_ackLeaseExpiresAt_idx" ON "BioSensorPreparationOperation"("ackNextAttemptAt","ackLeaseExpiresAt");
CREATE FUNCTION "guard_bio_profile_revision_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'BIO profile revisions are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER "BioSensorProfileRevision_immutable" BEFORE UPDATE OR DELETE ON "BioSensorProfileRevision"
 FOR EACH ROW EXECUTE FUNCTION "guard_bio_profile_revision_immutable"();
CREATE FUNCTION "guard_bio_preparation_result_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."resultHash" IS NOT NULL AND (OLD."result",OLD."resultHash",OLD."resultEventId",OLD."ackPayload",OLD."ackHash")
   IS DISTINCT FROM (NEW."result",NEW."resultHash",NEW."resultEventId",NEW."ackPayload",NEW."ackHash") THEN
   RAISE EXCEPTION 'BIO preparation result and ACK are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "BioSensorPreparationOperation_result_immutable" BEFORE UPDATE ON "BioSensorPreparationOperation"
 FOR EACH ROW EXECUTE FUNCTION "guard_bio_preparation_result_immutable"();
COMMIT;

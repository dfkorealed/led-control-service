BEGIN;
SELECT "lock_automation_membership_mutation"();

ALTER TABLE "LightingSchedule" ADD COLUMN "excludeWeekends" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "excludeHolidays" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GatewayAutomationProtocolSupport"
  ADD COLUMN "temporaryControlVersion" INTEGER,
  ADD COLUMN "bioConfigurationReadback" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "durableFixtureLease" BOOLEAN NOT NULL DEFAULT false,
  DROP CONSTRAINT "GatewayAutomationProtocolSupport_values_check",
  ADD CONSTRAINT "GatewayAutomationProtocolSupport_values_check" CHECK (
    "assignmentVersion">=0 AND "declarationRevision" BETWEEN 1 AND 9007199254740991
    AND "maxSnapshotVersion" IN (1,2,3) AND "payloadHash" ~ '^sha256:[a-f0-9]{64}$'
    AND ("temporaryControlVersion" IS NULL OR "temporaryControlVersion"=1));

CREATE TABLE "TemporaryControlSession" (
  "id" TEXT PRIMARY KEY, "siteId" TEXT NOT NULL, "gatewayId" TEXT NOT NULL, "actorId" TEXT NOT NULL,
  "assignmentVersion" INTEGER NOT NULL CHECK ("assignmentVersion">0),
  "admissionRevision" INTEGER NOT NULL CHECK ("admissionRevision">=0),
  "originSequence" BIGINT NOT NULL CHECK ("originSequence" BETWEEN 0 AND 9007199254740991),
  "originCommandHash" TEXT NOT NULL CHECK ("originCommandHash" ~ '^sha256:[a-f0-9]{64}$'),
  "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending','applying','holding','partial','unknown','releasing','restored','recovery_pending','rejected','cancelled')),
  "sessionRevision" INTEGER NOT NULL DEFAULT 1 CHECK ("sessionRevision" IN (1,2)),
  "startedAt" TIMESTAMP(3) NOT NULL, "endsAt" TIMESTAMP(3) NOT NULL,
  "durationMinutes" INTEGER NOT NULL CHECK ("durationMinutes" BETWEEN 1 AND 1440),
  "brightness" INTEGER CHECK ("brightness" BETWEEN 0 AND 100), "reason" TEXT,
  "releaseIntentAt" TIMESTAMP(3), "terminalAt" TIMESTAMP(3), "detailsRedacted" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  UNIQUE ("id","siteId","gatewayId"), UNIQUE ("id","siteId"),
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("gatewayId","siteId") REFERENCES "Gateway"("id","siteId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ("endsAt"="startedAt"+"durationMinutes"*interval '1 minute'),
  CHECK (("sessionRevision"=1 AND "releaseIntentAt" IS NULL) OR ("sessionRevision"=2 AND "releaseIntentAt" IS NOT NULL)),
  CHECK (("state" IN ('restored','rejected','cancelled'))=("terminalAt" IS NOT NULL)),
  CHECK ((NOT "detailsRedacted" AND "brightness" IS NOT NULL) OR
    ("detailsRedacted" AND "brightness" IS NULL AND "terminalAt" IS NOT NULL))
);
CREATE INDEX "TemporaryControlSession_siteId_startedAt_id_idx" ON "TemporaryControlSession"("siteId","startedAt","id");
CREATE INDEX "TemporaryControlSession_state_endsAt_idx" ON "TemporaryControlSession"("state","endsAt");

CREATE TABLE "TemporaryControlLease" (
  "fixtureId" TEXT PRIMARY KEY, "liveFixtureId" TEXT UNIQUE, "siteId" TEXT NOT NULL, "gatewayId" TEXT NOT NULL,
  "meshNodeId" TEXT NOT NULL, "nativeUuid" TEXT NOT NULL CHECK ("nativeUuid" ~ '^[0-9a-f]{12}$'),
  "logicalAddress" TEXT NOT NULL CHECK ("logicalAddress" ~ '^0x[0-7][0-9a-f]{3}$' AND "logicalAddress"<>'0x0000'),
  "lastGeneration" BIGINT NOT NULL DEFAULT 0 CHECK ("lastGeneration">=0 AND "lastGeneration"%2=0),
  "releaseTombstoneGeneration" BIGINT NOT NULL DEFAULT 0 CHECK ("releaseTombstoneGeneration">=0 AND "releaseTombstoneGeneration"<="lastGeneration" AND "releaseTombstoneGeneration"%2=0),
  "ownerSessionId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  UNIQUE ("fixtureId","siteId","gatewayId"),
  CHECK ("liveFixtureId" IS NULL OR "liveFixtureId"="fixtureId"),
  CHECK ("ownerSessionId" IS NULL OR "liveFixtureId" IS NOT NULL),
  FOREIGN KEY ("liveFixtureId") REFERENCES "Fixture"("id") ON DELETE SET NULL ON UPDATE RESTRICT,
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("gatewayId","siteId") REFERENCES "Gateway"("id","siteId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("ownerSessionId","siteId","gatewayId") REFERENCES "TemporaryControlSession"("id","siteId","gatewayId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "TemporaryControlLease_ownerSessionId_idx" ON "TemporaryControlLease"("ownerSessionId");

CREATE TABLE "TemporaryControlTarget" (
  "sessionId" TEXT NOT NULL, "fixtureId" TEXT NOT NULL, "siteId" TEXT NOT NULL, "gatewayId" TEXT NOT NULL,
  "meshNodeId" TEXT NOT NULL, "nativeUuid" TEXT NOT NULL, "logicalAddress" TEXT NOT NULL,
  "applyGeneration" BIGINT NOT NULL CHECK ("applyGeneration">0 AND "applyGeneration"%2=1),
  "releaseGeneration" BIGINT NOT NULL CHECK ("releaseGeneration"="applyGeneration"+1),
  "applyConfirmed" BOOLEAN NOT NULL DEFAULT false, "releaseConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "configurationMayHaveChanged" BOOLEAN NOT NULL DEFAULT false, "unchangedConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "partialMutation" TEXT NOT NULL DEFAULT 'none' CHECK ("partialMutation" IN ('none','high_brightness','mode','unverified')),
  "rfWriteEvidence" TEXT NOT NULL DEFAULT 'not_started' CHECK ("rfWriteEvidence" IN ('not_started','may_have_written','observed')),
  "configurationReadback" JSONB, "restorationRevision" INTEGER, "restorationPayloadHash" TEXT,
  "reason" TEXT, "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  PRIMARY KEY ("sessionId","fixtureId"),
  UNIQUE ("sessionId","meshNodeId"), UNIQUE ("sessionId","nativeUuid"), UNIQUE ("sessionId","logicalAddress"),
  FOREIGN KEY ("sessionId","siteId","gatewayId") REFERENCES "TemporaryControlSession"("id","siteId","gatewayId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("fixtureId","siteId","gatewayId") REFERENCES "TemporaryControlLease"("fixtureId","siteId","gatewayId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (("restorationRevision" IS NULL AND "restorationPayloadHash" IS NULL) OR
    ("restorationRevision" IS NOT NULL AND "restorationPayloadHash" IS NOT NULL AND "restorationRevision">=0 AND "restorationPayloadHash" ~ '^sha256:[a-f0-9]{64}$')),
  CHECK ("partialMutation"='none' OR "configurationMayHaveChanged"),
  CHECK (NOT "unchangedConfirmed" OR (NOT "configurationMayHaveChanged" AND "partialMutation"='none' AND "rfWriteEvidence"='not_started')),
  CHECK (NOT "releaseConfirmed" OR ("restorationRevision" IS NOT NULL AND ("configurationReadback" IS NOT NULL OR "resolvedAt" IS NOT NULL) AND "rfWriteEvidence"='observed' AND "partialMutation"='none')),
  CHECK ("resolvedAt" IS NULL OR "releaseConfirmed" OR "unchangedConfirmed")
);
CREATE INDEX "TemporaryControlTarget_fixtureId_idx" ON "TemporaryControlTarget"("fixtureId");

CREATE TABLE "TemporaryControlOperationReceipt" (
  "siteId" TEXT NOT NULL, "actorId" TEXT NOT NULL, "operation" TEXT NOT NULL CHECK ("operation" IN ('start','end')),
  "clientRequestId" TEXT NOT NULL, "fingerprint" TEXT NOT NULL CHECK ("fingerprint" ~ '^sha256:[a-f0-9]{64}$'),
  "sessionId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  PRIMARY KEY ("siteId","actorId","operation","clientRequestId"),
  FOREIGN KEY ("sessionId","siteId") REFERENCES "TemporaryControlSession"("id","siteId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "TemporaryControlOperationReceipt_sessionId_idx" ON "TemporaryControlOperationReceipt"("sessionId");

CREATE TABLE "TemporaryControlOutbox" (
  "id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "siteId" TEXT NOT NULL, "gatewayId" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('start','end','ingested')), "sessionRevision" INTEGER NOT NULL CHECK ("sessionRevision" IN (1,2)),
  "deduplicationKey" TEXT NOT NULL UNIQUE, "payload" JSONB, "payloadHash" TEXT NOT NULL CHECK ("payloadHash" ~ '^sha256:[a-f0-9]{64}$'),
  "deliveryGeneration" TEXT, "deliveryPayloadHash" TEXT,
  "deliveryGeneratedAt" TIMESTAMP(3), "deliveryWindowMs" INTEGER, "expiresAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts">=0), "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3), "publishedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  FOREIGN KEY ("sessionId","siteId","gatewayId") REFERENCES "TemporaryControlSession"("id","siteId","gatewayId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (("kind"='start' AND "sessionRevision"=1) OR ("kind"='end' AND "sessionRevision"=2) OR "kind"='ingested'),
  CHECK ("payload" IS NOT NULL OR "completedAt" IS NOT NULL),
  CHECK (("leaseToken" IS NULL)=("leaseUntil" IS NULL)),
  CHECK (("deliveryGeneration" IS NULL AND "deliveryPayloadHash" IS NULL AND "deliveryGeneratedAt" IS NULL AND "deliveryWindowMs" IS NULL AND "expiresAt" IS NULL) OR
    ("deliveryGeneration" IS NOT NULL AND length("deliveryGeneration")>0 AND "deliveryPayloadHash" IS NOT NULL AND "deliveryPayloadHash" ~ '^sha256:[a-f0-9]{64}$'
      AND "deliveryGeneratedAt" IS NOT NULL AND "deliveryWindowMs" IS NOT NULL AND "deliveryWindowMs">0 AND "expiresAt" IS NOT NULL
      AND "expiresAt"="deliveryGeneratedAt"+"deliveryWindowMs"*interval '1 millisecond'))
);
CREATE INDEX "TemporaryControlOutbox_completedAt_nextAttemptAt_idx" ON "TemporaryControlOutbox"("completedAt","nextAttemptAt");
CREATE INDEX "TemporaryControlOutbox_sessionId_idx" ON "TemporaryControlOutbox"("sessionId");

CREATE TABLE "TemporaryControlResultReceipt" (
  "eventId" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "siteId" TEXT NOT NULL, "gatewayId" TEXT NOT NULL, "fixtureId" TEXT NOT NULL,
  "sessionRevision" INTEGER NOT NULL CHECK ("sessionRevision" IN (1,2)), "targetGeneration" BIGINT NOT NULL CHECK ("targetGeneration">0),
  "resultHash" TEXT NOT NULL CHECK ("resultHash" ~ '^sha256:[a-f0-9]{64}$'),
  "status" TEXT NOT NULL CHECK ("status" IN ('applied','rejected')), "reason" TEXT, "result" JSONB,
  "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  FOREIGN KEY ("sessionId","siteId","gatewayId") REFERENCES "TemporaryControlSession"("id","siteId","gatewayId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("sessionId","fixtureId") REFERENCES "TemporaryControlTarget"("sessionId","fixtureId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (("status"='applied' AND "reason" IS NULL) OR ("status"='rejected' AND "reason" IS NOT NULL AND length(trim("reason"))>0))
);
CREATE INDEX "TemporaryControlResultReceipt_sessionId_fixtureId_idx" ON "TemporaryControlResultReceipt"("sessionId","fixtureId");

-- A complete dataset is immutable. The year pointer is the only replaceable row.
CREATE TABLE "HolidayDataset" (
  "id" TEXT PRIMARY KEY, "country" TEXT NOT NULL CHECK ("country"='KR'), "source" TEXT NOT NULL CHECK ("source"='kasi'),
  "year" INTEGER NOT NULL CHECK ("year" BETWEEN 1 AND 9999), "revision" TEXT NOT NULL CHECK (length("revision")>0),
  "fetchedAt" TIMESTAMP(3) NOT NULL, "coverageFrom" DATE NOT NULL, "coverageUntil" DATE NOT NULL,
  "payloadHash" TEXT NOT NULL CHECK ("payloadHash" ~ '^sha256:[a-f0-9]{64}$'), "dates" JSONB NOT NULL,
  "completenessProof" JSONB NOT NULL, "complete" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  UNIQUE ("country","year","revision"), UNIQUE ("id","country","year","complete"),
  CHECK ("coverageFrom"=make_date("year",1,1) AND "coverageUntil"=make_date("year",12,31)),
  CHECK (jsonb_typeof("dates")='array' AND jsonb_typeof("completenessProof")='array')
);
CREATE TABLE "HolidayYearCoverage" (
  "country" TEXT NOT NULL, "year" INTEGER NOT NULL, "datasetId" TEXT NOT NULL,
  "complete" BOOLEAN NOT NULL DEFAULT true CHECK ("complete"), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  PRIMARY KEY ("country","year"),
  FOREIGN KEY ("datasetId","country","year","complete") REFERENCES "HolidayDataset"("id","country","year","complete") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION temporary_control_no_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'minimum temporary control replay fence cannot be deleted' USING ERRCODE='23514'; END $$;
CREATE FUNCTION temporary_control_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable receipt or complete dataset' USING ERRCODE='23514'; END $$;

CREATE FUNCTION temporary_control_session_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW."state"<>'pending' OR NEW."sessionRevision"<>1 OR NOT EXISTS (
      SELECT 1 FROM "Gateway" WHERE id=NEW."gatewayId" AND "siteId"=NEW."siteId" AND "assignmentVersion"=NEW."assignmentVersion") THEN
      RAISE EXCEPTION 'session admission must match current assignment' USING ERRCODE='23514';
    END IF;
  ELSE
    IF ROW(NEW.id,NEW."siteId",NEW."gatewayId",NEW."actorId",NEW."assignmentVersion",NEW."admissionRevision",NEW."originSequence",NEW."originCommandHash",NEW."startedAt",NEW."endsAt",NEW."durationMinutes")
      IS DISTINCT FROM ROW(OLD.id,OLD."siteId",OLD."gatewayId",OLD."actorId",OLD."assignmentVersion",OLD."admissionRevision",OLD."originSequence",OLD."originCommandHash",OLD."startedAt",OLD."endsAt",OLD."durationMinutes")
      OR NEW."sessionRevision"<OLD."sessionRevision" OR (OLD."releaseIntentAt" IS NOT NULL AND NEW."releaseIntentAt" IS DISTINCT FROM OLD."releaseIntentAt")
      OR (OLD."terminalAt" IS NOT NULL AND ROW(NEW.state,NEW."terminalAt") IS DISTINCT FROM ROW(OLD.state,OLD."terminalAt"))
      OR (OLD."detailsRedacted" AND NOT NEW."detailsRedacted")
      OR (NEW.brightness IS DISTINCT FROM OLD.brightness AND NOT (NEW."detailsRedacted" AND NEW.brightness IS NULL)) THEN
      RAISE EXCEPTION 'immutable session admission or terminal fence' USING ERRCODE='23514';
    END IF;
    IF NEW."terminalAt" IS NOT NULL AND (EXISTS(SELECT 1 FROM "TemporaryControlTarget" WHERE "sessionId"=NEW.id AND "resolvedAt" IS NULL)
      OR EXISTS(SELECT 1 FROM "TemporaryControlLease" WHERE "ownerSessionId"=NEW.id)) THEN
      RAISE EXCEPTION 'unresolved session cannot become terminal' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION temporary_control_lease_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW."lastGeneration"<>0 OR NEW."releaseTombstoneGeneration"<>0 OR NEW."ownerSessionId" IS NOT NULL
      OR NEW."liveFixtureId" IS DISTINCT FROM NEW."fixtureId" OR NOT EXISTS (
        SELECT 1 FROM "Fixture" f JOIN "MeshNode" n ON n.id=f."meshNodeId" WHERE f.id=NEW."fixtureId"
          AND f."siteId"=NEW."siteId" AND f."gatewayId"=NEW."gatewayId" AND n.id=NEW."meshNodeId"
          AND n."gatewayId"=NEW."gatewayId" AND n."deviceUuid"='bio:'||NEW."nativeUuid"
          AND n."meshAddress"=NEW."logicalAddress" AND n."vehicleSensorProtocol"='bio_usb_pulse') THEN
      RAISE EXCEPTION 'new lease requires fresh exact BIO fixture identity and zero counter' USING ERRCODE='23514';
    END IF;
  ELSE
    IF ROW(NEW."fixtureId",NEW."siteId",NEW."gatewayId",NEW."meshNodeId",NEW."nativeUuid",NEW."logicalAddress") IS DISTINCT FROM
      ROW(OLD."fixtureId",OLD."siteId",OLD."gatewayId",OLD."meshNodeId",OLD."nativeUuid",OLD."logicalAddress")
      OR (NEW."liveFixtureId" IS DISTINCT FROM OLD."liveFixtureId" AND NOT (NEW."liveFixtureId" IS NULL AND OLD."ownerSessionId" IS NULL)) THEN
      RAISE EXCEPTION 'lease identity cannot be replaced or revived' USING ERRCODE='23514';
    END IF;
    IF OLD."ownerSessionId" IS NULL AND NEW."ownerSessionId" IS NOT NULL THEN
      IF NEW."lastGeneration"<>OLD."lastGeneration"+2 OR NEW."releaseTombstoneGeneration"<>OLD."releaseTombstoneGeneration" OR NOT EXISTS (
        SELECT 1 FROM "TemporaryControlTarget" WHERE "sessionId"=NEW."ownerSessionId" AND "fixtureId"=NEW."fixtureId"
          AND "applyGeneration"=OLD."lastGeneration"+1 AND "releaseGeneration"=NEW."lastGeneration" AND "resolvedAt" IS NULL) THEN
        RAISE EXCEPTION 'owner acquisition requires the next reserved target pair' USING ERRCODE='23514';
      END IF;
    ELSIF OLD."ownerSessionId" IS NOT NULL AND NEW."ownerSessionId" IS NULL THEN
      IF NEW."lastGeneration"<>OLD."lastGeneration" OR NOT EXISTS (
        SELECT 1 FROM "TemporaryControlTarget" t JOIN "TemporaryControlSession" s ON s.id=t."sessionId"
        WHERE t."sessionId"=OLD."ownerSessionId" AND t."fixtureId"=OLD."fixtureId" AND t."releaseGeneration"=OLD."lastGeneration"
          AND t."resolvedAt" IS NOT NULL AND (t."unchangedConfirmed" OR (t."releaseConfirmed" AND s."releaseIntentAt" IS NOT NULL))) THEN
        RAISE EXCEPTION 'unresolved owner cannot be released' USING ERRCODE='23514';
      END IF;
      NEW."releaseTombstoneGeneration":=OLD."lastGeneration";
    ELSIF ROW(NEW."ownerSessionId",NEW."lastGeneration",NEW."releaseTombstoneGeneration") IS DISTINCT FROM
      ROW(OLD."ownerSessionId",OLD."lastGeneration",OLD."releaseTombstoneGeneration") THEN
      RAISE EXCEPTION 'owner/counter cannot be stolen, skipped or rolled back' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION temporary_control_reserve_target() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE l "TemporaryControlLease"; s "TemporaryControlSession";
BEGIN
  SELECT * INTO s FROM "TemporaryControlSession" WHERE id=NEW."sessionId" FOR UPDATE;
  SELECT * INTO l FROM "TemporaryControlLease" WHERE "fixtureId"=NEW."fixtureId" FOR UPDATE;
  IF s.id IS NULL OR l."fixtureId" IS NULL OR l."ownerSessionId" IS NOT NULL OR l."liveFixtureId" IS NULL
    OR s.state<>'pending' OR s."sessionRevision"<>1 OR s."siteId"<>NEW."siteId" OR s."gatewayId"<>NEW."gatewayId"
    OR ROW(l."siteId",l."gatewayId",l."meshNodeId",l."nativeUuid",l."logicalAddress") IS DISTINCT FROM
      ROW(NEW."siteId",NEW."gatewayId",NEW."meshNodeId",NEW."nativeUuid",NEW."logicalAddress")
    OR NEW."applyGeneration"<>l."lastGeneration"+1 OR NEW."releaseGeneration"<>l."lastGeneration"+2
    OR NOT EXISTS(SELECT 1 FROM "Gateway" WHERE id=s."gatewayId" AND "siteId"=s."siteId" AND "assignmentVersion"=s."assignmentVersion")
    OR (SELECT count(*) FROM "TemporaryControlTarget" WHERE "sessionId"=s.id)>1000 THEN
    RAISE EXCEPTION 'target requires exact live identity, assignment and free next generation pair' USING ERRCODE='23514';
  END IF;
  UPDATE "TemporaryControlLease" SET "ownerSessionId"=s.id,"lastGeneration"=NEW."releaseGeneration","updatedAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "fixtureId"=NEW."fixtureId";
  RETURN NEW;
END $$;

CREATE FUNCTION temporary_control_target_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- An uncertain write can only settle through restoration. A later RF0
  -- observation cannot rewrite the historical possibility of mutation.
  IF OLD."configurationMayHaveChanged" AND (NOT NEW."configurationMayHaveChanged" OR NEW."unchangedConfirmed") THEN
    RAISE EXCEPTION 'historical mutation uncertainty must be retained' USING ERRCODE='23514';
  END IF;
  IF NEW."releaseConfirmed" AND NEW."configurationReadback" IS NULL AND NOT (
    OLD."releaseConfirmed" AND OLD."resolvedAt" IS NOT NULL AND EXISTS(
      SELECT 1 FROM "TemporaryControlSession" WHERE id=NEW."sessionId" AND "detailsRedacted")) THEN
    RAISE EXCEPTION 'release confirmation requires observed readback before terminal redaction' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW."sessionId",NEW."fixtureId",NEW."siteId",NEW."gatewayId",NEW."meshNodeId",NEW."nativeUuid",NEW."logicalAddress",NEW."applyGeneration",NEW."releaseGeneration") IS DISTINCT FROM
    ROW(OLD."sessionId",OLD."fixtureId",OLD."siteId",OLD."gatewayId",OLD."meshNodeId",OLD."nativeUuid",OLD."logicalAddress",OLD."applyGeneration",OLD."releaseGeneration")
    OR (OLD."resolvedAt" IS NOT NULL AND NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt") THEN
    RAISE EXCEPTION 'immutable target snapshot and resolution' USING ERRCODE='23514';
  END IF;
  -- Once settled, only detail redaction is permitted; stale observations cannot reopen ownership.
  IF OLD."resolvedAt" IS NOT NULL AND (to_jsonb(NEW)-ARRAY['configurationReadback','reason','updatedAt']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['configurationReadback','reason','updatedAt']) THEN
    RAISE EXCEPTION 'settled evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION temporary_control_binding_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='Fixture' THEN
    IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM "TemporaryControlLease" WHERE "fixtureId"=NEW.id) THEN
      RAISE EXCEPTION 'retained fixture primary key cannot be reused' USING ERRCODE='23514';
    ELSIF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM "TemporaryControlLease" WHERE "liveFixtureId"=OLD.id)
      AND ROW(NEW.id,NEW."meshNodeId",NEW."gatewayId",NEW."siteId") IS DISTINCT FROM ROW(OLD.id,OLD."meshNodeId",OLD."gatewayId",OLD."siteId") THEN
      RAISE EXCEPTION 'retained fixture identity requires a new fixture id' USING ERRCODE='23514';
    ELSIF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM "TemporaryControlLease" WHERE "liveFixtureId"=OLD.id AND "ownerSessionId" IS NOT NULL) THEN
      RAISE EXCEPTION 'unresolved fixture cannot be deleted' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='MeshNode' AND EXISTS(SELECT 1 FROM "TemporaryControlLease" WHERE "meshNodeId"=OLD.id AND "liveFixtureId" IS NOT NULL) THEN
    IF TG_OP='DELETE' OR ROW(NEW.id,NEW."deviceUuid",NEW."meshAddress",NEW."gatewayId",NEW."vehicleSensorProtocol") IS DISTINCT FROM
      ROW(OLD.id,OLD."deviceUuid",OLD."meshAddress",OLD."gatewayId",OLD."vehicleSensorProtocol") THEN
      RAISE EXCEPTION 'retained live fixture identity cannot be rebound' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='Gateway' THEN
    IF EXISTS(SELECT 1 FROM "TemporaryControlLease" WHERE "gatewayId"=OLD.id AND "ownerSessionId" IS NOT NULL)
      AND NEW."assignmentVersion" IS DISTINCT FROM OLD."assignmentVersion" THEN
      RAISE EXCEPTION 'unresolved lease prevents reassignment' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION temporary_control_result_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE t "TemporaryControlTarget";
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'result') IS DISTINCT FROM (to_jsonb(OLD)-'result') OR NEW.result IS NOT NULL OR NOT EXISTS(
      SELECT 1 FROM "TemporaryControlSession" WHERE id=OLD."sessionId" AND "terminalAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'immutable first result receipt; terminal payload may be redacted' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO t FROM "TemporaryControlTarget" WHERE "sessionId"=NEW."sessionId" AND "fixtureId"=NEW."fixtureId";
    IF NEW.status='applied' AND (t."sessionId" IS NULL OR NEW."targetGeneration" IS DISTINCT FROM
      CASE NEW."sessionRevision" WHEN 1 THEN t."applyGeneration" ELSE t."releaseGeneration" END OR NOT EXISTS (
        SELECT 1 FROM "TemporaryControlLease" WHERE "fixtureId"=t."fixtureId" AND "ownerSessionId"=t."sessionId"
          AND "lastGeneration"=t."releaseGeneration" AND "liveFixtureId" IS NOT NULL)) THEN
      RAISE EXCEPTION 'applied result requires current exact owner and reserved generation' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION holiday_dataset_proof_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE months INTEGER; total INTEGER; holiday JSONB; label JSONB;
BEGIN
  FOR holiday IN SELECT value FROM jsonb_array_elements(NEW.dates) LOOP
    IF jsonb_typeof(holiday) IS DISTINCT FROM 'object' OR holiday->>'date' IS NULL
      OR NOT (holiday->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      OR (holiday->>'date')::DATE NOT BETWEEN NEW."coverageFrom" AND NEW."coverageUntil"
      OR jsonb_typeof(holiday->'names') IS DISTINCT FROM 'array' OR jsonb_array_length(holiday->'names')=0 THEN
      RAISE EXCEPTION 'holiday must have a valid covered date and names' USING ERRCODE='23514';
    END IF;
    FOR label IN SELECT value FROM jsonb_array_elements(holiday->'names') LOOP
      IF jsonb_typeof(label)<>'string' OR length(trim(label #>> '{}'))=0 THEN
        RAISE EXCEPTION 'holiday names must be nonempty strings' USING ERRCODE='23514';
      END IF;
    END LOOP;
    IF (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(holiday->'names')) THEN
      RAISE EXCEPTION 'holiday names must be unique' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF (SELECT count(*)<>count(DISTINCT value->>'date') FROM jsonb_array_elements(NEW.dates)) THEN
    RAISE EXCEPTION 'holiday dates must be unique' USING ERRCODE='23514';
  END IF;
  IF NEW.complete THEN
    SELECT count(DISTINCT (p->>'month')::INTEGER),count(*) INTO months,total FROM jsonb_array_elements(NEW."completenessProof") p
      WHERE (p->>'month')::INTEGER BETWEEN 1 AND 12 AND (p->>'totalCount')::INTEGER>=0 AND (p->>'pageCount')::INTEGER>=1;
    IF months<>12 OR total<>12 OR jsonb_array_length(NEW."completenessProof")<>12 THEN
      RAISE EXCEPTION 'complete holiday dataset requires twelve validated month proofs' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION temporary_control_outbox_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE s "TemporaryControlSession";
BEGIN
  SELECT * INTO s FROM "TemporaryControlSession" WHERE id=NEW."sessionId";
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW."sessionId",NEW."siteId",NEW."gatewayId",NEW.kind,NEW."sessionRevision",NEW."deduplicationKey",NEW."payloadHash") IS DISTINCT FROM
      ROW(OLD.id,OLD."sessionId",OLD."siteId",OLD."gatewayId",OLD.kind,OLD."sessionRevision",OLD."deduplicationKey",OLD."payloadHash")
      OR (NEW.payload IS DISTINCT FROM OLD.payload AND NOT (NEW.payload IS NULL AND NEW."completedAt" IS NOT NULL AND s."detailsRedacted")) THEN
      RAISE EXCEPTION 'immutable logical outbox command; only terminal details may be redacted' USING ERRCODE='23514';
    END IF;
  END IF;
  IF (NEW.kind='start' AND NEW."expiresAt">s."endsAt") OR
    (NEW.kind='end' AND (s."releaseIntentAt" IS NULL OR s."sessionRevision"<>2)) THEN
    RAISE EXCEPTION 'outbox must honor absolute deadline and persisted release intent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "TemporaryControlSession_guard" BEFORE INSERT OR UPDATE ON "TemporaryControlSession" FOR EACH ROW EXECUTE FUNCTION temporary_control_session_guard();
CREATE TRIGGER "TemporaryControlLease_guard" BEFORE INSERT OR UPDATE ON "TemporaryControlLease" FOR EACH ROW EXECUTE FUNCTION temporary_control_lease_guard();
CREATE TRIGGER "TemporaryControlTarget_reserve" AFTER INSERT ON "TemporaryControlTarget" FOR EACH ROW EXECUTE FUNCTION temporary_control_reserve_target();
CREATE TRIGGER "TemporaryControlTarget_guard" BEFORE UPDATE ON "TemporaryControlTarget" FOR EACH ROW EXECUTE FUNCTION temporary_control_target_guard();
CREATE TRIGGER "TemporaryControlResultReceipt_guard" BEFORE INSERT OR UPDATE ON "TemporaryControlResultReceipt" FOR EACH ROW EXECUTE FUNCTION temporary_control_result_guard();
CREATE TRIGGER "TemporaryControlOperationReceipt_immutable" BEFORE UPDATE ON "TemporaryControlOperationReceipt" FOR EACH ROW EXECUTE FUNCTION temporary_control_immutable();
CREATE TRIGGER "TemporaryControlOutbox_guard" BEFORE INSERT OR UPDATE ON "TemporaryControlOutbox" FOR EACH ROW EXECUTE FUNCTION temporary_control_outbox_guard();
CREATE TRIGGER "HolidayDataset_proof" BEFORE INSERT ON "HolidayDataset" FOR EACH ROW EXECUTE FUNCTION holiday_dataset_proof_guard();
CREATE TRIGGER "HolidayDataset_immutable" BEFORE UPDATE ON "HolidayDataset" FOR EACH ROW EXECUTE FUNCTION temporary_control_immutable();
CREATE TRIGGER "Fixture_temporary_control_identity" BEFORE INSERT OR UPDATE OR DELETE ON "Fixture" FOR EACH ROW EXECUTE FUNCTION temporary_control_binding_guard();
CREATE TRIGGER "MeshNode_temporary_control_identity" BEFORE UPDATE OR DELETE ON "MeshNode" FOR EACH ROW EXECUTE FUNCTION temporary_control_binding_guard();
CREATE TRIGGER "Gateway_temporary_control_assignment" BEFORE UPDATE ON "Gateway" FOR EACH ROW EXECUTE FUNCTION temporary_control_binding_guard();

-- The existing automation membership lock precedes session/fixture/lease row locks.
-- It also serializes direct SQL deletes with target reservation and binding changes.
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['TemporaryControlSession','TemporaryControlLease','TemporaryControlTarget','TemporaryControlResultReceipt','TemporaryControlOutbox'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"()',name||'_statement_lock',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['Fixture','MeshNode'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"()',name||'_temporary_control_statement_lock',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['TemporaryControlSession','TemporaryControlLease','TemporaryControlTarget','TemporaryControlOperationReceipt','TemporaryControlResultReceipt','TemporaryControlOutbox'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION temporary_control_no_delete()',name||'_no_delete',name);
  END LOOP;
END $$;

-- The commission-mode migration renamed the six-argument base function.
-- Replace that base and retain its seven-argument wrapper/commission check.
-- Existing V2 capability-event wire stays V2.
CREATE OR REPLACE FUNCTION bio_sensor_base_blocked_reasons(fixture_id TEXT, as_of TIMESTAMP DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
  proposed_readiness TEXT DEFAULT NULL, proposed_profile TEXT DEFAULT NULL,
  proposed_verified TIMESTAMP DEFAULT NULL, proposed_revision BIGINT DEFAULT NULL)
RETURNS TEXT[] LANGUAGE plpgsql STABLE AS $function$
DECLARE
  f "Fixture"; n "MeshNode"; g "Gateway"; p "BioSensorPreparationOperation";
  profile "BioSensorProfileRevision"; policy "BioSensorSitePolicy"; delivery "BioSensorCatalogDelivery";
  reasons TEXT[] := '{}'; current_catalog_revision BIGINT; matches INTEGER; binding_ok BOOLEAN; checkpoint_ok BOOLEAN;
BEGIN
  SELECT * INTO f FROM "Fixture" WHERE "id"=fixture_id;
  SELECT * INTO n FROM "MeshNode" WHERE "id"=f."meshNodeId";
  SELECT * INTO g FROM "Gateway" WHERE "id"=f."gatewayId";
  SELECT "revision" INTO current_catalog_revision FROM "BioSensorCatalogState" WHERE "id"=1;
  SELECT * INTO p FROM "BioSensorPreparationOperation" WHERE "fixtureId"=fixture_id
    ORDER BY "requestedAt" DESC, "commandId" DESC LIMIT 1;
  binding_ok := COALESCE(n."vehicleSensorProtocol"='bio_usb_pulse'
    AND n."deviceUuid" ~ '^bio:[0-9a-f]{12}$' AND n."meshAddress" ~ '^0x[0-7][0-9a-f]{3}$' AND n."meshAddress"<>'0x0000'
    AND n."gatewayId"=g."id" AND g."siteId"=f."siteId" AND g."assignmentVersion">0
    AND EXISTS(SELECT 1 FROM "Floor" WHERE "id"=f."floorId" AND "siteId"=f."siteId" AND "status"='active')
    AND p."siteId"=f."siteId" AND p."gatewayId"=g."id" AND p."nodeId"=n."id"
    AND p."assignmentVersion"=g."assignmentVersion" AND p."meshAddress"=n."meshAddress"
    AND p."deviceIdentityHash"=encode(sha256(convert_to(n."deviceUuid",'UTF8')),'hex')
    AND p."payload"->>'commandId'=p."commandId" AND p."payload"->>'fixtureId'=f."id"
    AND p."payload"->>'nodeId'=n."id" AND p."payload"->>'siteId'=f."siteId" AND p."payload"->>'gatewayId'=g."id"
    AND p."payload"->>'deviceIdentityHash'=p."deviceIdentityHash" AND p."payload"->>'meshAddress'=n."meshAddress"
    AND p."payload"->>'assignmentVersion'=g."assignmentVersion"::TEXT
    AND p."payload"->>'operation'=p."operation" AND p."payload"->>'catalogRevision'=current_catalog_revision::TEXT
    AND p."supersededAt" IS NULL AND p."catalogRevision"=current_catalog_revision, false);
  IF NOT binding_ok THEN reasons := array_append(reasons,'binding_changed'); END IF;
  checkpoint_ok := COALESCE(binding_ok AND p."status"='ready' AND p."resultHash" IS NOT NULL AND p."ackHash" IS NOT NULL
    AND p."ackPayload"->>'status'='applied' AND p."ackPayload"->>'commandId'=p."commandId"
    AND p."ackPayload"->>'reportPayloadHash'=p."resultHash" AND p."ackPayload"->>'eventId'=p."resultEventId"
    AND p."ackPayload"->>'fixtureId'=f."id" AND p."ackPayload"->>'nodeId'=n."id"
    AND p."ackPayload"->>'siteId'=f."siteId" AND p."ackPayload"->>'gatewayId'=g."id"
    AND p."ackPayload"->>'assignmentVersion'=g."assignmentVersion"::TEXT
    AND p."result"->>'commandId'=p."commandId" AND p."result"->>'commandPayloadHash'=p."payloadHash"
    AND p."result"->>'eventId'=p."resultEventId" AND p."result"->>'fixtureId'=f."id"
    AND p."result"->>'operation'=p."operation"
    AND p."result"->>'siteId'=f."siteId" AND p."result"->>'gatewayId'=g."id" AND p."result"->>'nodeId'=n."id"
    AND p."result"->>'assignmentVersion'=g."assignmentVersion"::TEXT
    AND p."result"->>'deviceIdentityHash'=p."deviceIdentityHash" AND p."result"->>'meshAddress'=n."meshAddress"
    AND p."result"->>'catalogRevision'=current_catalog_revision::TEXT AND p."result"->>'status'='ready'
    AND EXISTS (SELECT 1 FROM "Site" s JOIN "User" u ON u."id"=s."adminUserId"
      JOIN "Organization" o ON o."id"=u."organizationId" WHERE s."id"=f."siteId" AND u."id"=p."actorId"
        AND u."status"='active' AND u."role"='admin' AND u."organizationId"=s."organizationId" AND o."type"='customer'),false);
  IF NOT checkpoint_ok OR p."result"->>'modeVerified' IS DISTINCT FROM 'true' THEN reasons := array_append(reasons,'mode_unverified'); END IF;
  WITH latest AS (SELECT DISTINCT ON ("profileId") * FROM "BioSensorProfileRevision" ORDER BY "profileId","revision" DESC)
    SELECT count(*) INTO matches FROM latest WHERE "status"='approved' AND "fingerprint"=p."result"->'fingerprint';
  IF matches<>1 THEN
    reasons := array_append(reasons,'fingerprint_unverified'); reasons := array_append(reasons,'profile_unverified');
  ELSE
    WITH latest AS (SELECT DISTINCT ON ("profileId") * FROM "BioSensorProfileRevision" ORDER BY "profileId","revision" DESC)
      SELECT * INTO profile FROM latest WHERE "status"='approved' AND "fingerprint"=p."result"->'fingerprint';
    IF p."result"->>'profileKey' IS DISTINCT FROM (profile."profileId"||'@'||profile."revision"::TEXT) THEN
      reasons := array_append(reasons,'profile_unverified');
    END IF;
  END IF;
  SELECT * INTO policy FROM "BioSensorSitePolicy" WHERE "siteId"=f."siteId";
  IF NOT COALESCE(policy."enabled" AND EXISTS (SELECT 1 FROM "Site" s JOIN "User" u ON u."id"=s."adminUserId"
      JOIN "Organization" o ON o."id"=u."organizationId" WHERE s."id"=f."siteId" AND u."id"=policy."ownerUserId"
        AND u."status"='active' AND u."role"='admin' AND u."organizationId"=s."organizationId" AND o."type"='customer'),false)
    THEN reasons := array_append(reasons,'operating_policy_required'); END IF;
  SELECT * INTO delivery FROM "BioSensorCatalogDelivery" WHERE "siteId"=f."siteId" AND "gatewayId"=g."id"
    AND "assignmentVersion"=g."assignmentVersion" AND "catalogRevision"=current_catalog_revision;
  IF NOT COALESCE(delivery."supersededAt" IS NULL AND delivery."appliedAt" IS NOT NULL AND delivery."status" IN ('applied','duplicate')
    AND delivery."ackHash" IS NOT NULL AND delivery."ackPayload"->>'deliveryPayloadHash'=delivery."payloadHash"
    AND delivery."ackPayload"->>'eventId'=delivery."deliveryId"
    AND delivery."ackPayload"->>'siteId'=f."siteId" AND delivery."ackPayload"->>'gatewayId'=g."id"
    AND delivery."ackPayload"->>'assignmentVersion'=g."assignmentVersion"::TEXT
    AND delivery."ackPayload"->>'catalogRevision'=current_catalog_revision::TEXT AND delivery."ackPayload"->>'status' IN ('applied','duplicate')
    AND delivery."payload"->'executionPolicy'->>'enabled'='true'
    AND delivery."payload"->'executionPolicy'->>'ownerUserId'=policy."ownerUserId"
    AND delivery."payload"->'executionPolicy'->>'maximumResponseSeconds'=policy."maximumResponseSeconds"::TEXT
    AND delivery."payload"->'executionPolicy'->>'escalationAction'=policy."escalationAction",false)
    THEN reasons := array_append(reasons,'catalog_pending'); END IF;
  IF NOT COALESCE((SELECT ("maxSnapshotVersion"=2 OR ("maxSnapshotVersion"=3 AND "temporaryControlVersion"=1
      AND "bioConfigurationReadback" AND "durableFixtureLease")) FROM "GatewayAutomationProtocolSupport"
    WHERE "gatewayId"=g."id" AND "siteId"=f."siteId" AND "assignmentVersion"=g."assignmentVersion"
    ORDER BY "declarationRevision" DESC LIMIT 1),false) OR NOT EXISTS (
      SELECT 1 FROM "GatewayInventory" i JOIN "GatewayCertificate" c ON c."inventoryId"=i."id"
      WHERE i."claimedGatewayId"=g."id" AND i."claimedAt" IS NOT NULL AND i."disabledAt" IS NULL
        AND g."claimedAt" IS NOT NULL AND c."gatewayId"=g."id" AND c."purpose"='mqtt' AND c."status"='active'
        AND c."revokedAt" IS NULL AND c."notBefore"<=as_of AND c."notAfter">as_of)
    THEN reasons := array_append(reasons,'gateway_protocol_unverified'); END IF;
  IF NOT COALESCE(checkpoint_ok AND p."result"->>'linkVerified'='true'
    -- A proposed revision selects the complete NEW observation. NULL proposed
    -- metadata must fail closed, not inherit fields from the previous node.
    AND CASE WHEN proposed_revision IS NOT NULL THEN proposed_readiness ELSE n."bioPulseReadiness"::TEXT END='ready'
    AND COALESCE(proposed_revision,n."bioPulseCapabilityRevision")>0
    AND CASE WHEN proposed_revision IS NOT NULL THEN proposed_profile ELSE n."bioPulseProfileId" END=profile."profileId"||'@'||profile."revision"::TEXT
    AND CASE WHEN proposed_revision IS NOT NULL THEN proposed_verified ELSE n."bioPulseVerifiedAt" END<=as_of+interval '1 second'
    AND CASE WHEN proposed_revision IS NOT NULL THEN proposed_verified ELSE n."bioPulseVerifiedAt" END>=date_trunc('milliseconds',(p."result"->>'observedAt')::timestamptz AT TIME ZONE 'UTC')
    AND CASE WHEN proposed_revision IS NOT NULL THEN proposed_verified ELSE n."bioPulseVerifiedAt" END>=as_of-(profile."linkPolicy"->>'maxAgeMs')::BIGINT*interval '1 millisecond'
    AND (proposed_revision IS NOT NULL OR EXISTS (SELECT 1 FROM "ProcessedGatewayEvent" e
      WHERE e."gatewayId"=g."id" AND e."meshNodeId"=n."id" AND e."scopeKey"=n."id" AND e."eventType"='bio_pulse_capability'
        AND e."sequence"=n."bioPulseCapabilityRevision" AND e."occurredAt"=n."bioPulseVerifiedAt"
        AND e."ingestionStatus"='accepted' AND e."payloadHash" IS NOT NULL
        AND EXISTS(SELECT 1 FROM "MqttOutbox" receipt WHERE receipt."gatewayId"=g."id" AND receipt."revision" IS NULL
          AND receipt."automationAssignmentVersion"=g."assignmentVersion" AND receipt."applicationAckKey" IS NOT NULL
          AND receipt."payload"->>'schemaVersion'='2' AND receipt."payload"->>'eventId'=e."eventId"
          AND receipt."payload"->>'meshNodeId'=n."id" AND receipt."payload"->>'capabilityRevision'=n."bioPulseCapabilityRevision"::TEXT
          AND receipt."payload"->>'deliveryPayloadHash'=e."payloadHash" AND receipt."payload"->>'status' IN ('applied','duplicate')))),false)
    THEN reasons := array_append(reasons,'link_unverified'); END IF;
  IF p."status"='unsupported' OR n."vehicleSensorCapabilityStatus"='unsupported' THEN reasons := array_append(reasons,'unsupported'); END IF;
  RETURN reasons;
END;
$function$;

CREATE OR REPLACE FUNCTION "vehicle_event_source_is_ready"(node "MeshNode", protocol "VehicleSensorProtocol")
RETURNS BOOLEAN LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(node."vehicleSensorProtocol"=protocol AND CASE protocol
    WHEN 'bluez_stateful' THEN node."vehicleSensorCapabilityStatus"='supported' AND node."vehicleSensorCapabilityVerifiedAt" IS NOT NULL
      AND node."vehicleSensorCapabilityRevision">0 AND node."vehicleSensorServerBound" AND node."vehicleVendorEventModelBound"
    WHEN 'bio_usb_pulse' THEN EXISTS(SELECT 1 FROM "Fixture" f WHERE f."meshNodeId"=node."id"
      AND cardinality(bio_sensor_blocked_reasons(f."id"))=0) END,false);
$function$;

-- Disabled historical source membership is editable after live qualification
-- loss. Enabled admission still passes the exact common predicate/MVCC fence.
CREATE OR REPLACE FUNCTION "validate_vehicle_event_source_capability"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE rule "VehicleEventRule";
BEGIN
  SELECT * INTO rule FROM "VehicleEventRule" WHERE "id"=NEW."ruleId";
  IF rule."status"='enabled' OR rule."sensorProtocol"='bluez_stateful' THEN
    PERFORM "assert_vehicle_event_source_ready"(NEW."fixtureId",rule."sensorProtocol");
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION "guard_mesh_node_vehicle_sensor_capability"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM 1 FROM "VehicleEventRule" WHERE "gatewayId"=NEW."gatewayId" AND "status"='enabled' ORDER BY "id" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "Fixture" f JOIN "VehicleEventSource" s ON s."fixtureId"=f."id"
    JOIN "VehicleEventRule" r ON r."id"=s."ruleId" WHERE f."meshNodeId"=OLD."id" AND r."status"='enabled'
      AND CASE WHEN r."sensorProtocol"='bio_usb_pulse' THEN NEW."vehicleSensorProtocol"<>'bio_usb_pulse'
        OR cardinality(bio_sensor_blocked_reasons(f."id",clock_timestamp() AT TIME ZONE 'UTC',
          NEW."bioPulseReadiness"::TEXT,NEW."bioPulseProfileId",NEW."bioPulseVerifiedAt",NEW."bioPulseCapabilityRevision",NEW."bioPulseSensorModeVerifiedAt"))<>0
        ELSE NOT "vehicle_event_source_is_ready"(NEW,r."sensorProtocol") END) THEN
    RAISE EXCEPTION 'enabled vehicle event rule requires current verified source evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
COMMIT;

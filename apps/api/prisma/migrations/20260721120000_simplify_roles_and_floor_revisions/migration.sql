-- Preserve existing customer data while separating the service provider from customer tenants.
CREATE TYPE "OrganizationType" AS ENUM ('service_provider', 'customer');

ALTER TABLE "Organization"
  ADD COLUMN "type" "OrganizationType" NOT NULL DEFAULT 'customer';

UPDATE "Organization" o
SET "type" = CASE
  WHEN EXISTS (SELECT 1 FROM "Site" s WHERE s."organizationId" = o.id)
    THEN 'customer'::"OrganizationType"
  ELSE 'service_provider'::"OrganizationType"
END;

-- PostgreSQL enums cannot remove values in place. Convert both role columns before dropping the legacy enum.
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
CREATE TYPE "UserRole" AS ENUM ('operator', 'admin', 'viewer');

ALTER TABLE "User"
  ALTER COLUMN "role" TYPE "UserRole"
  USING (
    CASE
      WHEN "role"::text = 'owner' AND EXISTS (
        SELECT 1
        FROM "Organization" o
        WHERE o.id = "User"."organizationId" AND o."type" = 'service_provider'
      ) THEN 'operator'
      WHEN "role"::text IN ('owner', 'operator') THEN 'admin'
      ELSE 'viewer'
    END
  )::"UserRole";

ALTER TABLE "Invitation"
  ALTER COLUMN "role" TYPE "UserRole"
  USING (
    CASE
      WHEN "role"::text IN ('owner', 'operator') THEN 'admin'
      ELSE 'viewer'
    END
  )::"UserRole";

DROP TYPE "UserRole_old";

CREATE TABLE "SiteMembership" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SiteMembership_pkey" PRIMARY KEY ("id")
);

-- Existing viewers previously inherited every site in their customer organization.
INSERT INTO "SiteMembership" ("id", "userId", "siteId", "createdAt")
SELECT md5(random()::text || clock_timestamp()::text || u.id || s.id), u.id, s.id, CURRENT_TIMESTAMP
FROM "User" u
JOIN "Organization" o ON o.id = u."organizationId"
JOIN "Site" s ON s."organizationId" = o.id
WHERE u."role" = 'viewer' AND o."type" = 'customer';

CREATE UNIQUE INDEX "SiteMembership_userId_siteId_key" ON "SiteMembership"("userId", "siteId");
CREATE INDEX "SiteMembership_siteId_idx" ON "SiteMembership"("siteId");
ALTER TABLE "SiteMembership"
  ADD CONSTRAINT "SiteMembership_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SiteMembership"
  ADD CONSTRAINT "SiteMembership_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Floor" ADD COLUMN "mapRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "FloorMapRevision" (
  "id" TEXT NOT NULL,
  "floorId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "snapshotSha256" TEXT NOT NULL,
  "changeSummary" JSONB NOT NULL,
  "changedBy" TEXT NOT NULL,
  "restoredFromRevision" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FloorMapRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FloorMapRevision_floorId_revision_key" ON "FloorMapRevision"("floorId", "revision");
CREATE INDEX "FloorMapRevision_floorId_createdAt_idx" ON "FloorMapRevision"("floorId", "createdAt");
ALTER TABLE "FloorMapRevision"
  ADD CONSTRAINT "FloorMapRevision_floorId_fkey"
  FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FloorMapRevision"
  ADD CONSTRAINT "FloorMapRevision_changedBy_fkey"
  FOREIGN KEY ("changedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT,
  "siteId" TEXT,
  "actorId" TEXT,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  "outcome" TEXT NOT NULL,
  "metadata" JSONB,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditLog_siteId_createdAt_idx" ON "AuditLog"("siteId", "createdAt");
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

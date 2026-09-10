BEGIN;

CREATE TYPE "SiteAccessLevel" AS ENUM ('read', 'control');

ALTER TABLE "User"
  ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "SiteMembership"
  ADD COLUMN "accessLevel" "SiteAccessLevel" NOT NULL DEFAULT 'read';

ALTER TABLE "ManualOverride" DROP CONSTRAINT "ManualOverride_commandId_siteId_requestedById_fkey";
ALTER TABLE "ManualOverride" DROP CONSTRAINT "ManualOverride_requestedById_fkey";
ALTER TABLE "Command" DROP CONSTRAINT "Command_requestedBy_fkey";
ALTER TABLE "Session" DROP CONSTRAINT "Session_userId_fkey";

DROP INDEX "Command_id_siteId_requestedBy_key";
DROP INDEX "ManualOverride_commandId_siteId_requestedById_key";

ALTER TABLE "Command" ALTER COLUMN "requestedBy" DROP NOT NULL;
ALTER TABLE "ManualOverride" ALTER COLUMN "requestedById" DROP NOT NULL;

ALTER TABLE "Command"
  ADD CONSTRAINT "Command_requestedBy_fkey"
  FOREIGN KEY ("requestedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ManualOverride"
  ADD CONSTRAINT "ManualOverride_commandId_fkey"
  FOREIGN KEY ("commandId") REFERENCES "Command"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "ManualOverride_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

ALTER TABLE "Session"
  ADD CONSTRAINT "Session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;

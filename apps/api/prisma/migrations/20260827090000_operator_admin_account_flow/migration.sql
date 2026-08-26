BEGIN;

-- Keep the compatibility fields nullable for the staged Task 2 contract. A failed
-- guard rolls back these additions as well, without widening existing columns.
ALTER TABLE "User"
  ADD COLUMN "loginId" TEXT;

ALTER TABLE "Site"
  ADD COLUMN "adminUserId" TEXT;

UPDATE "User"
SET "loginId" = lower(btrim("email"));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    WHERE "loginId" IS NULL
      OR "loginId" !~ '^[a-z0-9._@-]{4,100}$'
  ) THEN
    RAISE EXCEPTION 'invalid loginId format after email backfill';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "User"
    GROUP BY "loginId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'loginId collision after normalized email backfill';
  END IF;

  IF (SELECT COUNT(*) FROM "User" WHERE "role" = 'operator') > 1 THEN
    RAISE EXCEPTION 'operator account count must not exceed one';
  END IF;

  -- Legacy admins were scoped only by organization. Connecting any organization
  -- that has multiple admins or sites would silently grant the wrong site.
  IF EXISTS (
    SELECT 1
    FROM "Organization" AS organization
    WHERE organization."type" = 'customer'
      AND EXISTS (
        SELECT 1
        FROM "User" AS admin
        WHERE admin."organizationId" = organization."id"
          AND admin."role" = 'admin'
          AND admin."status" = 'active'
      )
      AND (
        (SELECT COUNT(*) FROM "User" AS admin WHERE admin."organizationId" = organization."id" AND admin."role" = 'admin' AND admin."status" = 'active') <> 1
        OR (SELECT COUNT(*) FROM "Site" AS site WHERE site."organizationId" = organization."id") <> 1
      )
  ) THEN
    RAISE EXCEPTION 'ambiguous customer admin/site ownership';
  END IF;
END $$;

UPDATE "Site" AS site
SET "adminUserId" = admin."id"
FROM "Organization" AS organization
JOIN "User" AS admin
  ON admin."organizationId" = organization."id"
  AND admin."role" = 'admin'
  AND admin."status" = 'active'
WHERE site."organizationId" = organization."id"
  AND organization."type" = 'customer'
  AND (SELECT COUNT(*) FROM "User" AS organization_admin WHERE organization_admin."organizationId" = organization."id" AND organization_admin."role" = 'admin' AND organization_admin."status" = 'active') = 1
  AND (SELECT COUNT(*) FROM "Site" AS organization_site WHERE organization_site."organizationId" = organization."id") = 1;

ALTER TABLE "User"
  ADD CONSTRAINT "User_loginId_format_check" CHECK ("loginId" IS NULL OR "loginId" ~ '^[a-z0-9._@-]{4,100}$');

CREATE UNIQUE INDEX "User_loginId_key" ON "User"("loginId");
CREATE UNIQUE INDEX "User_single_operator_key" ON "User"("role")
  WHERE "role" = 'operator';

CREATE UNIQUE INDEX "Site_adminUserId_key" ON "Site"("adminUserId");

ALTER TABLE "Site"
  ADD CONSTRAINT "Site_adminUserId_fkey"
  FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "validate_site_admin_assignment"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."adminUserId" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "User" AS admin
    JOIN "Organization" AS organization ON organization."id" = NEW."organizationId"
    WHERE admin."id" = NEW."adminUserId"
      AND admin."organizationId" = NEW."organizationId"
      AND admin."role" = 'admin'
      AND admin."status" = 'active'
      AND organization."type" = 'customer'
  ) THEN
    RAISE EXCEPTION 'site admin must be an active admin in the same customer organization';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Site_validate_admin_assignment"
BEFORE INSERT OR UPDATE OF "adminUserId", "organizationId" ON "Site"
FOR EACH ROW EXECUTE FUNCTION "validate_site_admin_assignment"();

COMMIT;

BEGIN;

-- Task 1's expand migration keeps both fields writable. Reapply the legacy
-- backfill so rows created during the staged API deployment are included.
DROP INDEX "User_loginId_key";

UPDATE "User"
SET "loginId" = lower(btrim("email"))
WHERE "loginId" IS NULL AND "email" IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "User" WHERE "loginId" IS NOT NULL AND "loginId" !~ '^[a-z0-9._@-]{4,100}$') THEN
    RAISE EXCEPTION 'invalid loginId format before contract enforcement';
  END IF;
  IF EXISTS (SELECT 1 FROM "User" WHERE "loginId" IS NOT NULL GROUP BY "loginId" HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'loginId collision before contract enforcement';
  END IF;
  IF EXISTS (SELECT 1 FROM "User" WHERE "loginId" IS NULL) THEN
    RAISE EXCEPTION 'loginId remains null before contract enforcement';
  END IF;
END $$;

ALTER TABLE "User"
  ALTER COLUMN "loginId" SET NOT NULL,
  ALTER COLUMN "email" DROP NOT NULL;

CREATE UNIQUE INDEX "User_loginId_key" ON "User"("loginId");

COMMIT;

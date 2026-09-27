-- Future Command originals use the DB server's UTC transaction clock even
-- when a direct writer connects with a non-UTC session TimeZone. No row is rewritten.
ALTER TABLE "Command"
  ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');

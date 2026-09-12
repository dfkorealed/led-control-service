DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "SiteMembership"
    GROUP BY "userId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'SITE_MEMBERSHIP_MULTI_SITE_USER';
  END IF;
END $$;

CREATE UNIQUE INDEX "SiteMembership_userId_key" ON "SiteMembership"("userId");

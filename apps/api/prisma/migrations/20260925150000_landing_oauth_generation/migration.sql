-- A consumed state remains the authorization generation until replaced or expired.
ALTER TABLE "LandingMailOAuthState" ADD COLUMN "consumedAt" TIMESTAMP(3);
-- Existing outstanding callbacks have no generation fence, require a fresh start.
DELETE FROM "LandingMailOAuthState";

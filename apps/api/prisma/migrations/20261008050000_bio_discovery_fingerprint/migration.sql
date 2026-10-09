-- Typed scan observation only. Existing discovery rows remain SQL NULL;
-- firmware text cannot establish a fingerprint or sensor readiness.
ALTER TABLE "DiscoveredMeshNode"
  ADD COLUMN "bioDiscoveryFingerprint" JSONB;

-- Additive only. A resolved recovery case can consume delayed duplicate Set
-- ACKs without retaining the original Command or dispatch UUID. No sweep or
-- Command deletion is enabled by this migration.
CREATE TABLE "LateSetTerminalFence" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "dispatchDigest" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LateSetTerminalFence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LateSetTerminalFence_digest_check" CHECK (
      "dispatchDigest" ~ '^hmac-sha256:[a-f0-9]{64}$' AND "keyVersion" > 0)
);
CREATE UNIQUE INDEX "LateSetTerminalFence_dispatchDigest_key" ON "LateSetTerminalFence"("dispatchDigest");
CREATE INDEX "LateSetTerminalFence_siteId_createdAt_idx" ON "LateSetTerminalFence"("siteId", "createdAt");
ALTER TABLE "LateSetTerminalFence" ADD CONSTRAINT "LateSetTerminalFence_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

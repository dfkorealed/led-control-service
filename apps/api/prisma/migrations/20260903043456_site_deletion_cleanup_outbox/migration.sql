-- CreateTable
CREATE TABLE "SiteDeletionCleanup" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "inventoryIds" JSONB NOT NULL,
    "objectKeys" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteDeletionCleanup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteDeletionCleanup_siteId_key" ON "SiteDeletionCleanup"("siteId");

-- CreateIndex
CREATE INDEX "SiteDeletionCleanup_completedAt_nextAttemptAt_leaseExpiresA_idx" ON "SiteDeletionCleanup"("completedAt", "nextAttemptAt", "leaseExpiresAt");

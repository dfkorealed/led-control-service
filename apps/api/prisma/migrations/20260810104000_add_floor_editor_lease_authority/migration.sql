ALTER TABLE "Floor"
ADD COLUMN "editorLeaseFence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "editorLeaseTokenHash" TEXT,
ADD COLUMN "editorLeaseHolderId" TEXT,
ADD COLUMN "editorLeaseHolderName" TEXT,
ADD COLUMN "editorLeaseAcquiredAt" TIMESTAMP(3),
ADD COLUMN "editorLeaseExpiresAt" TIMESTAMP(3);

ALTER TABLE "Session"
  ADD COLUMN "mfaVerifiedAt" TIMESTAMP(3);

CREATE INDEX "Session_userId_revokedAt_expiresAt_idx"
  ON "Session"("userId", "revokedAt", "expiresAt");

CREATE TABLE "UserMfa" (
  "userId" TEXT NOT NULL,
  "secretCiphertext" TEXT NOT NULL,
  "recoveryCodeHashes" TEXT[] NOT NULL,
  "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserMfa_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "UserMfa_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TYPE "GatewayCertificateStatus" ADD VALUE 'revocation_pending';

-- No FK: CA revocation obligations must survive local certificate/site deletion.
CREATE TABLE "CertificateRevocationReconciliation" (
    "id" TEXT NOT NULL,
    "inventoryId" TEXT NOT NULL,
    "certificateId" TEXT,
    "purpose" "CertificatePurpose" NOT NULL,
    "issuer" TEXT NOT NULL,
    "certificateSerial" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CertificateRevocationReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CertificateRevocationReconciliation_fingerprint_key"
ON "CertificateRevocationReconciliation"("fingerprint");
CREATE UNIQUE INDEX "CertificateRevocationReconciliation_issuer_certificateSeria_key"
ON "CertificateRevocationReconciliation"("issuer", "certificateSerial");
CREATE INDEX "CertificateRevocationReconciliation_completedAt_cancelledAt_idx"
ON "CertificateRevocationReconciliation"("completedAt", "cancelledAt", "nextAttemptAt", "leaseExpiresAt");
CREATE INDEX "CertificateRevocationReconciliation_inventoryId_idx"
ON "CertificateRevocationReconciliation"("inventoryId");

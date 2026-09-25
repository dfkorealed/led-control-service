CREATE TYPE "LandingInquiryDeliveryStatus" AS ENUM ('queued', 'retry_wait', 'provider_accepted', 'delivery_uncertain', 'failed');

CREATE TABLE "LandingInquiry" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "audience" TEXT,
    "message" TEXT NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "deliveryStatus" "LandingInquiryDeliveryStatus" NOT NULL DEFAULT 'queued',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "providerAcceptedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,

    CONSTRAINT "LandingInquiry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LandingInquiry_attemptCount_check" CHECK ("attemptCount" >= 0),
    CONSTRAINT "LandingInquiry_lease_pair_check" CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL)),
    CONSTRAINT "LandingInquiry_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "LandingInquiry_idempotencyKey_key" ON "LandingInquiry"("idempotencyKey");
CREATE UNIQUE INDEX "LandingInquiry_reference_key" ON "LandingInquiry"("reference");
CREATE INDEX "LandingInquiry_deliveryStatus_nextAttemptAt_idx" ON "LandingInquiry"("deliveryStatus", "nextAttemptAt");
CREATE INDEX "LandingInquiry_expiresAt_idx" ON "LandingInquiry"("expiresAt");
CREATE INDEX "LandingInquiry_createdAt_idx" ON "LandingInquiry"("createdAt");

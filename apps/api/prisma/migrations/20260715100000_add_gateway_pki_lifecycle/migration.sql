CREATE TYPE "CertificatePurpose" AS ENUM ('device', 'mqtt');
CREATE TYPE "GatewayCertificateStatus" AS ENUM ('active', 'replaced', 'revoked', 'expired');

ALTER TABLE "GatewayInventory"
ALTER COLUMN "certificateFingerprint" DROP NOT NULL;

CREATE TABLE "GatewayEnrollment" (
    "id" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "stationIdentity" TEXT NOT NULL,
    "outcome" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewayEnrollment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GatewayCertificate" (
    "id" TEXT NOT NULL,
    "inventoryId" TEXT NOT NULL,
    "gatewayId" TEXT,
    "purpose" "CertificatePurpose" NOT NULL,
    "certificateSerial" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "status" "GatewayCertificateStatus" NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayCertificate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GatewayCertificate_not_self_replaced_check" CHECK ("replacedById" IS NULL OR "replacedById" <> "id")
);

CREATE UNIQUE INDEX "GatewayEnrollment_tokenHash_key" ON "GatewayEnrollment"("tokenHash");
CREATE INDEX "GatewayEnrollment_serialNumber_createdAt_idx" ON "GatewayEnrollment"("serialNumber", "createdAt");
CREATE UNIQUE INDEX "GatewayCertificate_fingerprint_key" ON "GatewayCertificate"("fingerprint");
CREATE UNIQUE INDEX "GatewayCertificate_replacedById_key" ON "GatewayCertificate"("replacedById");
CREATE UNIQUE INDEX "GatewayCertificate_issuer_certificateSerial_key" ON "GatewayCertificate"("issuer", "certificateSerial");
CREATE INDEX "GatewayCertificate_inventoryId_purpose_status_idx" ON "GatewayCertificate"("inventoryId", "purpose", "status");
CREATE INDEX "GatewayCertificate_gatewayId_purpose_status_idx" ON "GatewayCertificate"("gatewayId", "purpose", "status");

ALTER TABLE "GatewayCertificate"
ADD CONSTRAINT "GatewayCertificate_inventoryId_fkey"
FOREIGN KEY ("inventoryId") REFERENCES "GatewayInventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GatewayCertificate"
ADD CONSTRAINT "GatewayCertificate_gatewayId_fkey"
FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GatewayCertificate"
ADD CONSTRAINT "GatewayCertificate_replacedById_fkey"
FOREIGN KEY ("replacedById") REFERENCES "GatewayCertificate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

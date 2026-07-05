-- CreateEnum
CREATE TYPE "ProvisioningSessionStatus" AS ENUM ('active', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "DiscoveredNodeStatus" AS ENUM ('discovered', 'identifying', 'provisioning', 'provisioned', 'failed');

-- AlterTable
ALTER TABLE "MeshNode" ADD COLUMN "deviceUuid" TEXT,
ADD COLUMN "serialNumber" TEXT;

-- CreateTable
CREATE TABLE "ProvisioningSession" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "gatewayId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" "ProvisioningSessionStatus" NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProvisioningSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveredMeshNode" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "deviceUuid" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "rssi" INTEGER NOT NULL,
    "oobCapability" TEXT NOT NULL,
    "firmwareVersion" TEXT NOT NULL,
    "status" "DiscoveredNodeStatus" NOT NULL DEFAULT 'discovered',
    "identifyState" TEXT NOT NULL DEFAULT 'idle',
    "meshAddress" TEXT,
    "errorMessage" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredMeshNode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MeshNode_deviceUuid_key" ON "MeshNode"("deviceUuid");

-- CreateIndex
CREATE UNIQUE INDEX "MeshNode_gatewayId_meshAddress_key" ON "MeshNode"("gatewayId", "meshAddress");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredMeshNode_sessionId_deviceUuid_key" ON "DiscoveredMeshNode"("sessionId", "deviceUuid");

-- AddForeignKey
ALTER TABLE "ProvisioningSession" ADD CONSTRAINT "ProvisioningSession_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningSession" ADD CONSTRAINT "ProvisioningSession_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningSession" ADD CONSTRAINT "ProvisioningSession_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningSession" ADD CONSTRAINT "ProvisioningSession_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredMeshNode" ADD CONSTRAINT "DiscoveredMeshNode_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ProvisioningSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

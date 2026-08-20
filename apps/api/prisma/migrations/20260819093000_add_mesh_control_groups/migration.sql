CREATE TYPE "MeshControlTargetType" AS ENUM ('floor', 'fixture_group');

CREATE TYPE "MeshControlGroupStatus" AS ENUM ('configuring', 'ready', 'failed');

CREATE TYPE "MeshControlGroupMemberSubscriptionStatus" AS ENUM ('pending', 'applied', 'failed');

ALTER TABLE "Gateway"
ADD COLUMN "nextMeshGroupAddress" INTEGER NOT NULL DEFAULT 49152;

CREATE TABLE "MeshControlGroup" (
  "id" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "targetType" "MeshControlTargetType" NOT NULL,
  "targetId" TEXT NOT NULL,
  "groupAddress" TEXT NOT NULL,
  "status" "MeshControlGroupStatus" NOT NULL DEFAULT 'configuring',
  "configurationVersion" INTEGER NOT NULL DEFAULT 1,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MeshControlGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MeshControlGroupMember" (
  "groupId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "meshNodeId" TEXT NOT NULL,
  "subscriptionStatus" "MeshControlGroupMemberSubscriptionStatus" NOT NULL DEFAULT 'pending',
  "appliedVersion" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MeshControlGroupMember_pkey" PRIMARY KEY ("groupId","meshNodeId")
);

CREATE UNIQUE INDEX "MeshControlGroup_gatewayId_targetType_targetId_key"
ON "MeshControlGroup"("gatewayId", "targetType", "targetId");

CREATE UNIQUE INDEX "MeshControlGroup_id_gatewayId_key"
ON "MeshControlGroup"("id", "gatewayId");

CREATE UNIQUE INDEX "MeshControlGroup_gatewayId_groupAddress_key"
ON "MeshControlGroup"("gatewayId", "groupAddress");

CREATE INDEX "MeshControlGroup_gatewayId_status_idx"
ON "MeshControlGroup"("gatewayId", "status");

CREATE UNIQUE INDEX "MeshNode_id_gatewayId_key"
ON "MeshNode"("id", "gatewayId");

CREATE UNIQUE INDEX "MeshControlGroupMember_groupId_gatewayId_key"
ON "MeshControlGroupMember"("groupId", "gatewayId");

CREATE UNIQUE INDEX "MeshControlGroupMember_meshNodeId_gatewayId_key"
ON "MeshControlGroupMember"("meshNodeId", "gatewayId");

CREATE INDEX "MeshControlGroupMember_meshNodeId_subscriptionStatus_idx"
ON "MeshControlGroupMember"("meshNodeId", "subscriptionStatus");

ALTER TABLE "MeshControlGroup"
ADD CONSTRAINT "MeshControlGroup_gatewayId_fkey"
FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MeshControlGroupMember"
ADD CONSTRAINT "MeshControlGroupMember_groupId_gatewayId_fkey"
FOREIGN KEY ("groupId", "gatewayId") REFERENCES "MeshControlGroup"("id", "gatewayId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MeshControlGroupMember"
ADD CONSTRAINT "MeshControlGroupMember_meshNodeId_gatewayId_fkey"
FOREIGN KEY ("meshNodeId", "gatewayId") REFERENCES "MeshNode"("id", "gatewayId") ON DELETE CASCADE ON UPDATE CASCADE;

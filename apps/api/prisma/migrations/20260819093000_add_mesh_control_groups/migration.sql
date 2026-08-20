CREATE TYPE "MeshControlTargetType" AS ENUM ('floor', 'fixture_group');

CREATE TYPE "MeshControlGroupStatus" AS ENUM ('configuring', 'ready', 'failed');

ALTER TABLE "Gateway"
ADD COLUMN "nextMeshGroupAddress" INTEGER NOT NULL DEFAULT 49152;

CREATE TABLE "MeshControlGroup" (
  "id" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "targetType" "MeshControlTargetType" NOT NULL,
  "targetId" TEXT NOT NULL,
  "groupAddress" TEXT NOT NULL,
  "status" "MeshControlGroupStatus" NOT NULL DEFAULT 'configuring',
  "version" INTEGER NOT NULL DEFAULT 1,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MeshControlGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MeshControlGroupMember" (
  "groupId" TEXT NOT NULL,
  "meshNodeId" TEXT NOT NULL,
  "status" "MeshControlGroupStatus" NOT NULL DEFAULT 'configuring',
  "version" INTEGER NOT NULL DEFAULT 1,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MeshControlGroupMember_pkey" PRIMARY KEY ("groupId","meshNodeId")
);

CREATE UNIQUE INDEX "MeshControlGroup_gatewayId_targetType_targetId_key"
ON "MeshControlGroup"("gatewayId", "targetType", "targetId");

CREATE UNIQUE INDEX "MeshControlGroup_gatewayId_groupAddress_key"
ON "MeshControlGroup"("gatewayId", "groupAddress");

CREATE INDEX "MeshControlGroup_gatewayId_status_idx"
ON "MeshControlGroup"("gatewayId", "status");

CREATE INDEX "MeshControlGroupMember_meshNodeId_status_idx"
ON "MeshControlGroupMember"("meshNodeId", "status");

ALTER TABLE "MeshControlGroup"
ADD CONSTRAINT "MeshControlGroup_gatewayId_fkey"
FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MeshControlGroupMember"
ADD CONSTRAINT "MeshControlGroupMember_groupId_fkey"
FOREIGN KEY ("groupId") REFERENCES "MeshControlGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MeshControlGroupMember"
ADD CONSTRAINT "MeshControlGroupMember_meshNodeId_fkey"
FOREIGN KEY ("meshNodeId") REFERENCES "MeshNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

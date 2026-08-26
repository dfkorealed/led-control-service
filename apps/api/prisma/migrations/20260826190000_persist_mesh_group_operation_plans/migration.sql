ALTER TABLE "MeshControlGroup"
ADD COLUMN "operationPlanVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "MeshControlGroupExpectedOperation" (
  "operationId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "configurationVersion" INTEGER NOT NULL,
  "action" "MeshControlGroupMemberOperation" NOT NULL,
  "meshNodeId" TEXT NOT NULL,
  "meshAddress" TEXT NOT NULL,
  "status" "MeshControlGroupMemberSubscriptionStatus" NOT NULL DEFAULT 'pending',
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MeshControlGroupExpectedOperation_pkey" PRIMARY KEY ("operationId")
);

CREATE TABLE "MeshControlGroupAppliedMember" (
  "groupId" TEXT NOT NULL,
  "gatewayId" TEXT NOT NULL,
  "meshNodeId" TEXT NOT NULL,
  "meshAddress" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MeshControlGroupAppliedMember_pkey" PRIMARY KEY ("groupId", "meshNodeId", "meshAddress")
);

CREATE UNIQUE INDEX "MeshControlGroupExpectedOperation_groupId_configurationVersion_action_meshNodeId_meshAddress_key"
ON "MeshControlGroupExpectedOperation"("groupId", "configurationVersion", "action", "meshNodeId", "meshAddress");

CREATE INDEX "MeshControlGroupExpectedOperation_groupId_gatewayId_configurationVersion_idx"
ON "MeshControlGroupExpectedOperation"("groupId", "gatewayId", "configurationVersion");

CREATE INDEX "MeshControlGroupAppliedMember_groupId_gatewayId_idx"
ON "MeshControlGroupAppliedMember"("groupId", "gatewayId");

ALTER TABLE "MeshControlGroupExpectedOperation"
ADD CONSTRAINT "MeshControlGroupExpectedOperation_groupId_gatewayId_fkey"
FOREIGN KEY ("groupId", "gatewayId") REFERENCES "MeshControlGroup"("id", "gatewayId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MeshControlGroupAppliedMember"
ADD CONSTRAINT "MeshControlGroupAppliedMember_groupId_gatewayId_fkey"
FOREIGN KEY ("groupId", "gatewayId") REFERENCES "MeshControlGroup"("id", "gatewayId") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "MeshControlGroupAppliedMember" (
  "groupId", "gatewayId", "meshNodeId", "meshAddress", "createdAt", "updatedAt"
)
SELECT member."groupId", member."gatewayId", member."meshNodeId", node."meshAddress", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MeshControlGroupMember" member
INNER JOIN "MeshNode" node
  ON node."id" = member."meshNodeId" AND node."gatewayId" = member."gatewayId"
WHERE member."appliedVersion" > 0
ON CONFLICT DO NOTHING;

CREATE TABLE "GatewayAutomationProtocolSupport" (
  "gatewayId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "assignmentVersion" INTEGER NOT NULL,
  "declarationRevision" BIGINT NOT NULL,
  "declarationId" TEXT NOT NULL,
  "maxSnapshotVersion" INTEGER NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "declaredAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GatewayAutomationProtocolSupport_pkey" PRIMARY KEY ("gatewayId", "assignmentVersion", "declarationRevision"),
  CONSTRAINT "GatewayAutomationProtocolSupport_gateway_scope_fkey" FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "GatewayAutomationProtocolSupport_values_check" CHECK (
    "assignmentVersion" >= 0 AND "declarationRevision" BETWEEN 1 AND 9007199254740991
    AND "maxSnapshotVersion" IN (1, 2)
    AND "payloadHash" ~ '^sha256:[a-f0-9]{64}$'
  )
);
CREATE UNIQUE INDEX "GatewayAutomationProtocolSupport_declarationId_key"
  ON "GatewayAutomationProtocolSupport"("declarationId");

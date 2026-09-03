-- DropForeignKey
ALTER TABLE "AutomationExecution" DROP CONSTRAINT "AutomationExecution_gatewayId_siteId_fkey";

-- DropForeignKey
ALTER TABLE "AutomationExecution" DROP CONSTRAINT "AutomationExecution_siteId_fkey";

-- DropForeignKey
ALTER TABLE "Command" DROP CONSTRAINT "Command_siteId_fkey";

-- DropForeignKey
ALTER TABLE "CommandDispatch" DROP CONSTRAINT "CommandDispatch_commandId_fkey";

-- DropForeignKey
ALTER TABLE "CommandDispatch" DROP CONSTRAINT "CommandDispatch_gatewayId_fkey";

-- DropForeignKey
ALTER TABLE "CommandFixtureResult" DROP CONSTRAINT "CommandFixtureResult_fixtureId_fkey";

-- DropForeignKey
ALTER TABLE "DiscoveredMeshNode" DROP CONSTRAINT "DiscoveredMeshNode_sessionId_fkey";

-- DropForeignKey
ALTER TABLE "EnergyUsage" DROP CONSTRAINT "EnergyUsage_fixtureId_fkey";

-- DropForeignKey
ALTER TABLE "Fixture" DROP CONSTRAINT "Fixture_floorId_siteId_fkey";

-- DropForeignKey
ALTER TABLE "FixtureGroup" DROP CONSTRAINT "FixtureGroup_floorId_fkey";

-- DropForeignKey
ALTER TABLE "FixtureGroup" DROP CONSTRAINT "FixtureGroup_gatewayId_fkey";

-- DropForeignKey
ALTER TABLE "FixtureGroup" DROP CONSTRAINT "FixtureGroup_siteId_fkey";

-- DropForeignKey
ALTER TABLE "Floor" DROP CONSTRAINT "Floor_siteId_fkey";

-- DropForeignKey
ALTER TABLE "FloorMapObject" DROP CONSTRAINT "FloorMapObject_floorId_fkey";

-- DropForeignKey
ALTER TABLE "FloorPlan" DROP CONSTRAINT "FloorPlan_floorId_fkey";

-- DropForeignKey
ALTER TABLE "Gateway" DROP CONSTRAINT "Gateway_siteId_fkey";

-- DropForeignKey
ALTER TABLE "GroupFixture" DROP CONSTRAINT "GroupFixture_fixtureId_fkey";

-- DropForeignKey
ALTER TABLE "GroupFixture" DROP CONSTRAINT "GroupFixture_groupId_fkey";

-- DropForeignKey
ALTER TABLE "Invitation" DROP CONSTRAINT "Invitation_siteId_fkey";

-- DropForeignKey
ALTER TABLE "LightingSchedule" DROP CONSTRAINT "LightingSchedule_gatewayId_siteId_fkey";

-- DropForeignKey
ALTER TABLE "LightingSchedule" DROP CONSTRAINT "LightingSchedule_siteId_fkey";

-- DropForeignKey
ALTER TABLE "LightingScheduleFixture" DROP CONSTRAINT "LightingScheduleFixture_fixtureId_siteId_gatewayId_fkey";

-- DropForeignKey
ALTER TABLE "ManualOverride" DROP CONSTRAINT "ManualOverride_commandId_siteId_requestedById_fkey";

-- DropForeignKey
ALTER TABLE "ManualOverride" DROP CONSTRAINT "ManualOverride_gatewayId_siteId_fkey";

-- DropForeignKey
ALTER TABLE "ManualOverride" DROP CONSTRAINT "ManualOverride_siteId_fkey";

-- DropForeignKey
ALTER TABLE "ManualOverrideFixture" DROP CONSTRAINT "ManualOverrideFixture_fixtureId_siteId_gatewayId_fkey";

-- DropForeignKey
ALTER TABLE "MeshNode" DROP CONSTRAINT "MeshNode_gatewayId_fkey";

-- DropForeignKey
ALTER TABLE "ProcessedGatewayEvent" DROP CONSTRAINT "ProcessedGatewayEvent_meshNodeId_gatewayId_fkey";

-- DropForeignKey
ALTER TABLE "ProvisioningSession" DROP CONSTRAINT "ProvisioningSession_floorId_fkey";

-- DropForeignKey
ALTER TABLE "ProvisioningSession" DROP CONSTRAINT "ProvisioningSession_gatewayId_fkey";

-- DropForeignKey
ALTER TABLE "ProvisioningSession" DROP CONSTRAINT "ProvisioningSession_siteId_fkey";

-- DropForeignKey
ALTER TABLE "VehicleEventRule" DROP CONSTRAINT "VehicleEventRule_gatewayId_siteId_fkey";

-- DropForeignKey
ALTER TABLE "VehicleEventRule" DROP CONSTRAINT "VehicleEventRule_siteId_fkey";

-- DropForeignKey
ALTER TABLE "VehicleEventSource" DROP CONSTRAINT "VehicleEventSource_fixtureId_siteId_gatewayId_fkey";

-- DropForeignKey
ALTER TABLE "VehicleEventTarget" DROP CONSTRAINT "VehicleEventTarget_fixtureId_siteId_gatewayId_fkey";

-- AddForeignKey
ALTER TABLE "Floor" ADD CONSTRAINT "Floor_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorPlan" ADD CONSTRAINT "FloorPlan_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fixture" ADD CONSTRAINT "Fixture_floorId_siteId_fkey" FOREIGN KEY ("floorId", "siteId") REFERENCES "Floor"("id", "siteId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorMapObject" ADD CONSTRAINT "FloorMapObject_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixtureGroup" ADD CONSTRAINT "FixtureGroup_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixtureGroup" ADD CONSTRAINT "FixtureGroup_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixtureGroup" ADD CONSTRAINT "FixtureGroup_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupFixture" ADD CONSTRAINT "GroupFixture_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "FixtureGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupFixture" ADD CONSTRAINT "GroupFixture_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gateway" ADD CONSTRAINT "Gateway_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeshNode" ADD CONSTRAINT "MeshNode_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Command" ADD CONSTRAINT "Command_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandDispatch" ADD CONSTRAINT "CommandDispatch_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "Command"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandDispatch" ADD CONSTRAINT "CommandDispatch_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandFixtureResult" ADD CONSTRAINT "CommandFixtureResult_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LightingSchedule" ADD CONSTRAINT "LightingSchedule_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LightingSchedule" ADD CONSTRAINT "LightingSchedule_gatewayId_siteId_fkey" FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LightingScheduleFixture" ADD CONSTRAINT "LightingScheduleFixture_fixtureId_siteId_gatewayId_fkey" FOREIGN KEY ("fixtureId", "siteId", "gatewayId") REFERENCES "Fixture"("id", "siteId", "gatewayId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "VehicleEventRule" ADD CONSTRAINT "VehicleEventRule_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "VehicleEventRule" ADD CONSTRAINT "VehicleEventRule_gatewayId_siteId_fkey" FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "VehicleEventSource" ADD CONSTRAINT "VehicleEventSource_fixtureId_siteId_gatewayId_fkey" FOREIGN KEY ("fixtureId", "siteId", "gatewayId") REFERENCES "Fixture"("id", "siteId", "gatewayId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "VehicleEventTarget" ADD CONSTRAINT "VehicleEventTarget_fixtureId_siteId_gatewayId_fkey" FOREIGN KEY ("fixtureId", "siteId", "gatewayId") REFERENCES "Fixture"("id", "siteId", "gatewayId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ManualOverride" ADD CONSTRAINT "ManualOverride_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ManualOverride" ADD CONSTRAINT "ManualOverride_gatewayId_siteId_fkey" FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ManualOverride" ADD CONSTRAINT "ManualOverride_commandId_siteId_requestedById_fkey" FOREIGN KEY ("commandId", "siteId", "requestedById") REFERENCES "Command"("id", "siteId", "requestedBy") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ManualOverrideFixture" ADD CONSTRAINT "ManualOverrideFixture_fixtureId_siteId_gatewayId_fkey" FOREIGN KEY ("fixtureId", "siteId", "gatewayId") REFERENCES "Fixture"("id", "siteId", "gatewayId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_gatewayId_siteId_fkey" FOREIGN KEY ("gatewayId", "siteId") REFERENCES "Gateway"("id", "siteId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProcessedGatewayEvent" ADD CONSTRAINT "ProcessedGatewayEvent_meshNodeId_gatewayId_fkey" FOREIGN KEY ("meshNodeId", "gatewayId") REFERENCES "MeshNode"("id", "gatewayId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningSession" ADD CONSTRAINT "ProvisioningSession_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningSession" ADD CONSTRAINT "ProvisioningSession_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningSession" ADD CONSTRAINT "ProvisioningSession_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredMeshNode" ADD CONSTRAINT "DiscoveredMeshNode_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ProvisioningSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnergyUsage" ADD CONSTRAINT "EnergyUsage_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

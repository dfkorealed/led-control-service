import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { authorizeBioRegistrationGateway } from "../registration/bio-registration-revalidation-binding";
import { lockRegistrationDeviceUuids } from "../registration/registration-domain-locks";
import { sensorModeDeviceIdentityHash } from "../commands/sensor-mode-operations.service";
import { canonicalPayloadHash } from "./automation-payload-hash";
import { assertFixtureRegistrationsActive } from "../fixtures/fixture-registration-removal-policy";

/** Existing membership mutation lock serializes reassignment/qualification; the
 * independent singleton protects catalog versions, never automation revisions. */
export async function lockBioSensorCatalog(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
  const rows = await tx.$queryRaw<Array<{ revision: bigint }>>`SELECT "revision" FROM "BioSensorCatalogState" WHERE "id"=1 FOR UPDATE`;
  if (rows.length !== 1) throw new ConflictException("BIO catalog unavailable");
  return rows[0].revision;
}

export async function lockBioSensorGateway(tx: Prisma.TransactionClient, scope: { siteId: string; gatewayId: string }, now: Date) {
  // Site/Floor precede Gateway, matching registration and current classification.
  await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id"=${scope.siteId} FOR UPDATE`;
  const gateway = await tx.gateway.findFirst({ where: { id: scope.gatewayId, siteId: scope.siteId } });
  if (!gateway || gateway.assignmentVersion <= 0) throw new ConflictException("BIO Gateway scope unavailable");
  await authorizeBioRegistrationGateway(tx, { ...scope, expectedAssignmentVersion: gateway.assignmentVersion }, now);
  return gateway.assignmentVersion;
}

export async function loadBioSensorBinding(tx: Prisma.TransactionClient, scope: { siteId: string; fixtureId: string }, now: Date) {
  await assertFixtureRegistrationsActive(tx, [scope.fixtureId]);
  const initial = await tx.fixture.findFirst({ where: { id: scope.fixtureId, siteId: scope.siteId }, include: { meshNode: true } });
  if (!initial?.meshNode?.deviceUuid || !initial.gatewayId) throw new ConflictException("registered BIO fixture required");
  await tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id"=${initial.floorId} FOR UPDATE`;
  const assignmentVersion = await lockBioSensorGateway(tx, { siteId: scope.siteId, gatewayId: initial.gatewayId }, now);
  await lockRegistrationDeviceUuids(tx, [initial.meshNode.deviceUuid]);
  await tx.$queryRaw`SELECT "id" FROM "MeshNode" WHERE "id"=${initial.meshNodeId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Fixture" WHERE "id"=${scope.fixtureId} FOR UPDATE`;
  const current = await tx.fixture.findFirst({ where: { id: scope.fixtureId, siteId: scope.siteId }, include: { meshNode: true, floor: true } });
  const node = current?.meshNode;
  if (!current || !node || current.floor.status !== "active" || current.floorId !== initial.floorId ||
    node.id !== initial.meshNodeId || current.gatewayId !== initial.gatewayId || node.gatewayId !== initial.gatewayId ||
    node.vehicleSensorProtocol !== "bio_usb_pulse" || !/^bio:[0-9a-f]{12}$/.test(node.deviceUuid ?? "") ||
    node.deviceUuid !== initial.meshNode.deviceUuid || !/^0x[0-7][0-9a-f]{3}$/.test(node.meshAddress) || node.meshAddress === "0x0000") {
    throw new ConflictException("BIO fixture binding changed or unconfirmed");
  }
  const binding = { siteId: current.siteId, gatewayId: node.gatewayId, fixtureId: current.id, nodeId: node.id,
    assignmentVersion, deviceIdentityHash: sensorModeDeviceIdentityHash(node.deviceUuid!), meshAddress: node.meshAddress };
  return { ...binding, bindingHash: canonicalPayloadHash(binding) };
}

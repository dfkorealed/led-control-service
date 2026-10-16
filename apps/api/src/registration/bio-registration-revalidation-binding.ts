import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { applicationProvisioningDeviceTerminalIngestedAckV2Schema, bioRegistrationRevalidationCanonicalJson,
  mqttTopicsV2, provisioningDeviceCommandV2Schema } from "@led-control/shared";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { BIO_DEVICE_UUID, PROVISIONING_DEVICE_TERMINAL_EVENT_TYPE } from "../mqtt/provisioning-device-terminal.service";
import { lockRegistrationDeviceUuids, lockRegistrationDomain } from "./registration-domain-locks";
import { assertFixtureRegistrationsActive } from "../fixtures/fixture-registration-removal-policy";

export interface BioRegistrationBinding {
  siteId: string; gatewayId: string; floorId: string; fixtureId: string; nodeId: string;
  sessionId: string; discoveredNodeId: string; originalProvisionCommandId: string;
  originalProvisionPayloadHash: string; assignmentVersion: number; deviceIdentityHash: string; meshAddress: string;
}
export type BioRegistrationScope = { siteId: string; gatewayId: string; fixtureId: string; expectedAssignmentVersion: number };

export function bioRegistrationRevalidationHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(bioRegistrationRevalidationCanonicalJson(value)).digest("hex")}`;
}

/** Caller must hold Floor before entering Gateway/inventory/certificate locks. */
export async function authorizeBioRegistrationGateway(tx: Prisma.TransactionClient,
  scope: { siteId: string; gatewayId: string; expectedAssignmentVersion: number }, now: Date): Promise<void> {
  if (!Number.isFinite(now.getTime())) throw new ConflictException("BIO authorization clock unavailable");
  // Broker mTLS/ACL and current DB metadata are the boundary, not a claim
  // that an HTTP request inspected a hardware peer certificate serial.
  const owned = await tx.$queryRaw<Array<{ assignmentVersion: number }>>(Prisma.sql`
    SELECT gateway."assignmentVersion" FROM "Gateway" gateway
    JOIN "GatewayInventory" inventory ON inventory."claimedGatewayId"=gateway."id"
      AND inventory."claimedAt" IS NOT NULL AND inventory."disabledAt" IS NULL
    JOIN "GatewayCertificate" certificate ON certificate."inventoryId"=inventory."id"
      AND certificate."gatewayId"=gateway."id" AND certificate."purpose"='mqtt'
      AND certificate."status"='active' AND certificate."revokedAt" IS NULL
      AND certificate."notBefore" <= (${now}::timestamptz AT TIME ZONE 'UTC')
      AND certificate."notAfter" > (${now}::timestamptz AT TIME ZONE 'UTC')
    WHERE gateway."id"=${scope.gatewayId} AND gateway."siteId"=${scope.siteId} AND gateway."claimedAt" IS NOT NULL
    FOR UPDATE OF gateway, inventory, certificate
  `);
  if (!owned.length || owned.some(row => row.assignmentVersion !== scope.expectedAssignmentVersion)) {
    throw new ConflictException("BIO current Gateway authority mismatch");
  }
}

/**
 * Only current graph identity is proved here. A discovered/confirmed candidate
 * is intentionally permitted without implying a historical completed terminal.
 * Caller holds membership then Site commission locks before this helper.
 */
export async function loadLockedBioRegistrationBinding(tx: Prisma.TransactionClient, scope: BioRegistrationScope,
  requiredStatus: "discovered" | "provisioned", now: Date): Promise<BioRegistrationBinding> {
  await assertFixtureRegistrationsActive(tx, [scope.fixtureId]);
  const fixtures = () => tx.fixture.findFirst({ where: { id: scope.fixtureId, siteId: scope.siteId, gatewayId: scope.gatewayId },
    include: { meshNode: true, floor: true } });
  const proofs = () => tx.discoveredMeshNode.findUnique({ where: { id: scope.fixtureId },
    include: { session: true, deviceOutbox: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] } } });
  const initial = await fixtures(); const initialProof = await proofs();
  if (!initial?.meshNode?.deviceUuid || !initialProof || initialProof.session.floorId !== initial.floorId ||
      initialProof.session.gatewayId !== scope.gatewayId || initialProof.session.siteId !== scope.siteId) {
    throw new ConflictException("BIO current registration domain mismatch");
  }
  await lockRegistrationDomain(tx, { floorId: initial.floorId, gatewayId: scope.gatewayId, sessionId: initialProof.sessionId,
    nodeIds: [initialProof.id], outboxIds: initialProof.deviceOutbox.map(row => row.id) });
  await authorizeBioRegistrationGateway(tx, scope, now);
  await lockRegistrationDeviceUuids(tx, [initial.meshNode.deviceUuid]);
  await tx.$queryRaw`SELECT "id" FROM "MeshNode" WHERE "id" = ${initial.meshNode.id} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Fixture" WHERE "id" = ${scope.fixtureId} FOR UPDATE`;
  const fixture = await fixtures(); const proof = await proofs(); const node = fixture?.meshNode;
  if (!fixture || !proof || !node?.deviceUuid || !BIO_DEVICE_UUID.test(node.deviceUuid) ||
      fixture.floor.status !== "active" || fixture.floorId !== initial.floorId || fixture.meshNodeId !== initial.meshNodeId ||
      node.gatewayId !== scope.gatewayId || node.deviceUuid !== initial.meshNode.deviceUuid ||
      proof.sessionId !== initialProof.sessionId || proof.status !== requiredStatus || proof.identifyState !== "confirmed" ||
      proof.deviceUuid !== node.deviceUuid || proof.meshAddress !== node.meshAddress ||
      proof.session.siteId !== scope.siteId || proof.session.gatewayId !== scope.gatewayId || proof.session.floorId !== fixture.floorId ||
      !/^0x[0-7][0-9a-f]{3}$/.test(node.meshAddress) || node.meshAddress === "0x0000") {
    throw new ConflictException("BIO current fixture/node registration identity mismatch");
  }
  const conflicting = await tx.discoveredMeshNode.findFirst({ where: { deviceUuid: node.deviceUuid,
    status: { in: ["identifying", "provisioning", "reconcile_required"] }, session: { status: "active" } } });
  const scanning = await tx.provisioningSession.findFirst({ where: { gatewayId: scope.gatewayId,
    status: "active", scanStatus: "scanning" } });
  if (conflicting || scanning) throw new ConflictException("BIO current registration operation conflict");
  const command = proof.deviceOutbox.find(row => {
    const parsed = provisioningDeviceCommandV2Schema.safeParse(row.payload);
    return parsed.success && parsed.data.operation !== "identify";
  });
  const parsed = command && provisioningDeviceCommandV2Schema.safeParse(command.payload);
  if (!command || !parsed?.success || parsed.data.operation === "identify" ||
      command.sessionId !== proof.sessionId || command.nodeId !== proof.id ||
      command.topic !== mqttTopicsV2.gatewayCommand(scope.siteId, scope.gatewayId, "provisioning/provision-device") ||
      parsed.data.commandId !== command.id || parsed.data.sessionId !== proof.sessionId || parsed.data.nodeId !== proof.id ||
      parsed.data.siteId !== scope.siteId || parsed.data.gatewayId !== scope.gatewayId ||
      parsed.data.deviceUuid !== node.deviceUuid || parsed.data.meshAddress !== node.meshAddress) {
    throw new ConflictException("BIO stored provision command mismatch");
  }
  const receipt = await tx.mqttOutbox.findUnique({ where: { applicationAckKey: `provisioning-device-terminal:${scope.gatewayId}:${command.id}` } });
  if (receipt) {
    const ack = applicationProvisioningDeviceTerminalIngestedAckV2Schema.safeParse(receipt.payload);
    if (!ack.success || ack.data.operation === "identify" || receipt.gatewayId !== scope.gatewayId ||
        receipt.topic !== mqttTopicsV2.provisioningDeviceTerminalIngestedAck(scope.siteId, scope.gatewayId) ||
        receipt.payloadHash !== canonicalPayloadHash(receipt.payload) || ack.data.siteId !== scope.siteId ||
        ack.data.gatewayId !== scope.gatewayId || ack.data.commandId !== command.id || ack.data.sessionId !== proof.sessionId ||
        ack.data.nodeId !== proof.id || ack.data.deviceUuid !== node.deviceUuid || ack.data.meshAddress !== node.meshAddress ||
        (ack.data.operation ?? "provision") !== (parsed.data.operation ?? "provision")) {
      throw new ConflictException("BIO terminal receipt identity mismatch");
    }
    const ledger = await tx.processedGatewayEvent.findUnique({ where: { eventId: ack.data.eventId } });
    if (!ledger || ledger.gatewayId !== scope.gatewayId || ledger.eventType !== PROVISIONING_DEVICE_TERMINAL_EVENT_TYPE ||
        ledger.sequence !== BigInt(ack.data.sequence) || !ledger.payloadHash || !/^sha256:[0-9a-f]{64}$/.test(ledger.payloadHash)) {
      throw new ConflictException("BIO terminal ledger identity mismatch");
    }
  }
  return { siteId: scope.siteId, gatewayId: scope.gatewayId, floorId: fixture.floorId, fixtureId: fixture.id, nodeId: node.id,
    sessionId: proof.sessionId, discoveredNodeId: proof.id, originalProvisionCommandId: command.id,
    originalProvisionPayloadHash: bioRegistrationRevalidationHash(command.payload), assignmentVersion: scope.expectedAssignmentVersion,
    deviceIdentityHash: createHash("sha256").update(node.deviceUuid).digest("hex"), meshAddress: node.meshAddress };
}

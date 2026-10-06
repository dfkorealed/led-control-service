import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { Prisma, type MeshNode } from "@prisma/client";
import { z } from "zod";
import { createHash } from "node:crypto";
import { applicationProvisioningDeviceTerminalIngestedAckV2Schema, mqttTopicsV2,
  provisioningDeviceCommandV2Schema } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { AutomationClock } from "../automation/automation-clock";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import type { AuthenticatedUser } from "../auth/auth.types";
import { BIO_DEVICE_UUID, PROVISIONING_DEVICE_TERMINAL_EVENT_TYPE } from "../mqtt/provisioning-device-terminal.service";
import { PrismaService } from "../prisma/prisma.service";
import { lockRegistrationDeviceUuids, lockRegistrationDomain } from "./registration-domain-locks";
import { authorizeBioRegistrationGateway, bioRegistrationRevalidationHash } from "./bio-registration-revalidation-binding";
import { assertBioRegistrationRepairAudit, assertBioRegistrationRevalidationProof } from "./bio-registration-revalidation.service";

export const reconcileBioClassificationInputSchema = z.object({
  siteId: z.string().uuid(), gatewayId: z.string().uuid(),
  expectedAssignmentVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  fixtureIds: z.array(z.string().uuid()).min(1).max(10), requestId: z.string().uuid()
}).strict().refine(value => new Set(value.fixtureIds).size === value.fixtureIds.length,
  { path: ["fixtureIds"], message: "fixtureIds must be unique" });
type Input = z.infer<typeof reconcileBioClassificationInputSchema>;
type Evidence = { evidenceKind: "legacy_completed_graph_command" | "v2_completed_graph_command_receipt" | "current_device_revalidation";
  sessionId: string; discoveredNodeId: string; commandId: string; terminalEventId?: string;
  revalidationCommandId?: string; revalidationResultHash?: string; repairAuditId?: string };

@Injectable()
export class BioClassificationReconciliationService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly audit: AuditService, private readonly clock: AutomationClock) {}

  async reconcile(actor: AuthenticatedUser, rawInput: unknown) {
    const parsed = reconcileBioClassificationInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new BadRequestException("invalid BIO classification request");
    const input = parsed.data;
    return this.prisma.$transaction(async tx => {
      // Match automation writes: membership first, then Site authorization and
      // registration Floor/Gateway locks. Protocol UPDATE triggers keep this lock.
      await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      await this.access.assertCommissionInTransaction(tx, actor, input.siteId);
      const initial = await this.fixtures(tx, input);
      if (initial.length !== input.fixtureIds.length || new Set(initial.map(row => row.floorId)).size !== 1) {
        throw new ConflictException("BIO classification requires owned fixtures on one floor");
      }
      const floorId = initial[0].floorId;
      await tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id" = ${floorId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Gateway" WHERE "id" = ${input.gatewayId} FOR UPDATE`;
      await authorizeBioRegistrationGateway(tx, input, this.clock.now());
      const transitions = initial.filter(row => row.meshNode?.vehicleSensorProtocol !== "bio_usb_pulse");
      // Optimistic proof lookup supplies only lock IDs. Re-read every relation
      // below after the existing registration-domain locks are held.
      const proofs = await tx.discoveredMeshNode.findMany({ where: { id: { in: transitions.map(row => row.id) } },
        include: { session: true, deviceOutbox: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] } } });
      if (proofs.length !== transitions.length) throw new ConflictException("BIO registration completion evidence missing");
      for (const proof of proofs.sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.id.localeCompare(b.id))) {
        if (proof.session.floorId !== floorId || proof.session.gatewayId !== input.gatewayId) {
          throw new ConflictException("BIO registration domain mismatch");
        }
        await lockRegistrationDomain(tx, { floorId, gatewayId: input.gatewayId, sessionId: proof.sessionId,
          nodeIds: [proof.id], outboxIds: proof.deviceOutbox.map(row => row.id) });
      }
      const nodeIds = initial.map(row => row.meshNodeId).filter((id): id is string => id !== null);
      if (nodeIds.length !== initial.length) throw new ConflictException("BIO fixture has no current node");
      await lockRegistrationDeviceUuids(tx, initial.map(row => row.meshNode?.deviceUuid ?? ""));
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MeshNode" WHERE "id" IN (${Prisma.join(nodeIds)}) ORDER BY "id" FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Fixture" WHERE "id" IN (${Prisma.join(input.fixtureIds)}) ORDER BY "id" FOR UPDATE`);
      const current = await this.fixtures(tx, input);
      const changedFixtureIds: string[] = [], unchangedFixtureIds: string[] = [];
      for (const fixtureId of input.fixtureIds) {
        const fixture = current.find(row => row.id === fixtureId);
        const before = initial.find(row => row.id === fixtureId);
        const node = fixture?.meshNode;
        if (!fixture || !before || fixture.floorId !== floorId || fixture.meshNodeId !== before.meshNodeId
          || !node || node.gatewayId !== input.gatewayId || !node.deviceUuid || !BIO_DEVICE_UUID.test(node.deviceUuid)) {
          throw new ConflictException("BIO current fixture/node identity mismatch");
        }
        // Classification is already correct: do not downgrade ready/degraded,
        // rebuild old evidence or duplicate audit merely because a request retries.
        if (node.vehicleSensorProtocol === "bio_usb_pulse") { unchangedFixtureIds.push(fixtureId); continue; }
        const expected = defaultQualification();
        if (Object.entries(expected).some(([key, value]) => node[key as keyof MeshNode] !== value)) {
          throw new ConflictException("BIO classification has nondefault qualification evidence");
        }
        const [ledger, watermark, enabled] = await Promise.all([
          tx.processedGatewayEvent.findFirst({ where: { gatewayId: input.gatewayId, meshNodeId: node.id,
            eventType: { in: ["vehicle_sensor_capability", "bio_pulse_capability"] } } }),
          tx.gatewayEventWatermark.findFirst({ where: { gatewayId: input.gatewayId, scopeKey: node.id,
            eventType: { in: ["vehicle_sensor_capability", "bio_pulse_capability"] } } }),
          tx.vehicleEventRule.findFirst({ where: { status: "enabled", OR: [
            { sources: { some: { fixtureId } } }, { targets: { some: { fixtureId } } } ] } })
        ]);
        if (ledger || watermark || enabled) throw new ConflictException("BIO classification conflicts with retained evidence or enabled rule");
        const evidence = await this.registrationEvidence(tx, input, fixtureId, floorId, node);
        const updated = await tx.meshNode.updateMany({ where: { id: node.id, gatewayId: input.gatewayId,
          deviceUuid: node.deviceUuid, meshAddress: node.meshAddress, ...expected },
          data: { vehicleSensorProtocol: "bio_usb_pulse" } });
        if (updated.count !== 1) throw new ConflictException("BIO classification changed concurrently");
        await this.audit.record({ transaction: tx, siteId: input.siteId, organizationId: actor.organizationId,
          actorId: actor.id, action: "bio_classification_reconciled", targetType: "MeshNode", targetId: node.id,
          outcome: "changed", metadata: { requestId: input.requestId, fixtureId, assignmentVersion: input.expectedAssignmentVersion,
            beforeProtocol: "bluez_stateful", afterProtocol: "bio_usb_pulse", ...evidence } });
        changedFixtureIds.push(fixtureId);
      }
      return { changedFixtureIds, unchangedFixtureIds };
    }, { timeout: 10_000 });
  }

  private fixtures(tx: Prisma.TransactionClient, input: Input) {
    return tx.fixture.findMany({ where: { id: { in: input.fixtureIds }, siteId: input.siteId, gatewayId: input.gatewayId },
      include: { meshNode: true } });
  }

  private async registrationEvidence(tx: Prisma.TransactionClient, input: Input,
    fixtureId: string, floorId: string, node: MeshNode): Promise<Evidence> {
    const proof = await tx.discoveredMeshNode.findUnique({ where: { id: fixtureId },
      include: { session: true, deviceOutbox: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] } } });
    if (!proof || proof.status !== "provisioned" || proof.identifyState !== "confirmed"
      || proof.deviceUuid !== node.deviceUuid || proof.meshAddress !== node.meshAddress
      || proof.session.siteId !== input.siteId || proof.session.gatewayId !== input.gatewayId || proof.session.floorId !== floorId) {
      throw new ConflictException("BIO completed registration graph mismatch");
    }
    const command = proof.deviceOutbox.find(row => {
      const payload = provisioningDeviceCommandV2Schema.safeParse(row.payload);
      return payload.success && payload.data.operation !== "identify";
    });
    const parsed = command && provisioningDeviceCommandV2Schema.safeParse(command.payload);
    if (!command || !parsed?.success || parsed.data.operation === "identify"
      || command.sessionId !== proof.sessionId || command.nodeId !== fixtureId
      || command.topic !== mqttTopicsV2.gatewayCommand(input.siteId, input.gatewayId, "provisioning/provision-device")
      || parsed.data.commandId !== command.id || parsed.data.sessionId !== proof.sessionId
      || parsed.data.nodeId !== fixtureId || parsed.data.siteId !== input.siteId || parsed.data.gatewayId !== input.gatewayId
      || parsed.data.deviceUuid !== node.deviceUuid || parsed.data.meshAddress !== node.meshAddress) {
      throw new ConflictException("BIO stored provision command mismatch");
    }
    let evidence: Evidence = { evidenceKind: "legacy_completed_graph_command", sessionId: proof.sessionId,
      discoveredNodeId: proof.id, commandId: command.id };
    // Any retained applied repair must validate as current-device evidence.
    // A malformed history cannot silently fall back to historical completion.
    const repair = await tx.bioRegistrationRevalidationOperation.findFirst({ where: { fixtureId, appliedAt: { not: null } },
      orderBy: [{ appliedAt: "desc" }, { commandId: "desc" }] });
    if (repair) {
      await tx.$queryRaw`SELECT "commandId" FROM "BioRegistrationRevalidationOperation" WHERE "commandId"=${repair.commandId} FOR UPDATE`;
      const row = await tx.bioRegistrationRevalidationOperation.findUniqueOrThrow({ where: { commandId: repair.commandId } });
      assertBioRegistrationRevalidationProof(row, { siteId: input.siteId, gatewayId: input.gatewayId, floorId, fixtureId,
        nodeId: node.id, sessionId: proof.sessionId, discoveredNodeId: proof.id, originalProvisionCommandId: command.id,
        originalProvisionPayloadHash: bioRegistrationRevalidationHash(command.payload), assignmentVersion: input.expectedAssignmentVersion,
        deviceIdentityHash: createHash("sha256").update(node.deviceUuid!).digest("hex"), meshAddress: node.meshAddress });
      await assertBioRegistrationRepairAudit(tx, row);
      evidence = { ...evidence, evidenceKind: "current_device_revalidation", revalidationCommandId: row.commandId,
        revalidationResultHash: row.resultHash!, repairAuditId: row.auditId! };
    }
    const receipt = await tx.mqttOutbox.findUnique({ where: {
      applicationAckKey: `provisioning-device-terminal:${input.gatewayId}:${command.id}` } });
    if (!receipt) return evidence;
    const ack = applicationProvisioningDeviceTerminalIngestedAckV2Schema.safeParse(receipt.payload);
    if (!ack.success || ack.data.operation === "identify" || receipt.gatewayId !== input.gatewayId
      || receipt.topic !== mqttTopicsV2.provisioningDeviceTerminalIngestedAck(input.siteId, input.gatewayId)
      || receipt.payloadHash !== canonicalPayloadHash(receipt.payload) || ack.data.siteId !== input.siteId
      || ack.data.gatewayId !== input.gatewayId || ack.data.commandId !== command.id || ack.data.sessionId !== proof.sessionId
      || ack.data.nodeId !== fixtureId || ack.data.deviceUuid !== node.deviceUuid || ack.data.meshAddress !== node.meshAddress) {
      throw new ConflictException("BIO terminal receipt identity mismatch");
    }
    const ledger = await tx.processedGatewayEvent.findUnique({ where: { eventId: ack.data.eventId } });
    // Neither ACK nor ledger hash contains completed/failed plaintext. The
    // server-owned provisioned graph above remains the completion evidence.
    if (!ledger || ledger.gatewayId !== input.gatewayId || ledger.eventType !== PROVISIONING_DEVICE_TERMINAL_EVENT_TYPE
      || ledger.sequence !== BigInt(ack.data.sequence) || !ledger.payloadHash || !/^sha256:[0-9a-f]{64}$/.test(ledger.payloadHash)) {
      throw new ConflictException("BIO terminal ledger identity mismatch");
    }
    return evidence.evidenceKind === "current_device_revalidation" ? evidence :
      { ...evidence, evidenceKind: "v2_completed_graph_command_receipt", terminalEventId: ledger.eventId };
  }
}

function defaultQualification() {
  return { vehicleSensorProtocol: "bluez_stateful" as const, vehicleSensorCapabilityStatus: "unknown" as const,
    vehicleSensorCapabilityRevision: 0n, vehicleSensorCapabilityVerifiedAt: null, vehicleSensorServerBound: false,
    vehicleVendorEventModelBound: false, bioPulseReadiness: "off" as const, bioPulseCapabilityRevision: 0n,
    bioPulseProfileId: null, bioPulseVerifiedAt: null };
}

import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type FixtureRegistrationRemovalOperation } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { applicationProvisioningDeviceTerminalIngestedAckV2Schema, fixtureRegistrationRemovalAckSchema,
  fixtureRegistrationRemovalBindingIdentity, fixtureRegistrationRemovalCommandSchema,
  fixtureRegistrationRemovalRequestSchema, fixtureRegistrationRemovalTerminalSchema,
  fixtureRegistrationRemovalTopics, fixtureRegistrationRemovalViewSchema, isGatewayHeartbeatFresh,
  provisioningDeviceCommandV2Schema, mqttTopicsV2,
  type FixtureRegistrationRemovalPreview, type FixtureRegistrationRemovalView } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { CommandDbClockHealth } from "../mqtt/command-db-clock-health.service";
import { PrismaService } from "../prisma/prisma.service";
import { authorizeBioRegistrationGateway } from "../registration/bio-registration-revalidation-binding";
import { lockFixtureRegistrationRemovalDomain, activeFixtureRegistrationWhere } from "./fixture-registration-removal-policy";
import { FixtureRegistrationRemovalCleanupService } from "./fixture-registration-removal-cleanup.service";
import { FixtureRegistrationRetirementService } from "./fixture-registration-retirement.service";

export type RemovalScope = { siteId: string; floorId: string; fixtureId: string };
const uuid = z.string().uuid();
const txOptions = { timeout: 15_000 };

@Injectable()
export class FixtureRegistrationRemovalsService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly clock: CommandDbClockHealth, private readonly cleanup: FixtureRegistrationRemovalCleanupService,
    private readonly retirement: FixtureRegistrationRetirementService) {}

  async preview(user: AuthenticatedUser, scope: RemovalScope): Promise<FixtureRegistrationRemovalPreview> {
    return this.prisma.$transaction(async tx => {
      await this.authorize(tx, user, scope);
      const fixture = await this.fixture(tx, scope);
      const now = await this.clock.assertHealthy(tx);
      const blockedReasons = await this.blockers(tx, fixture, now);
      return { fixtureId: fixture.id, fixtureName: fixture.name, serialNumber: fixture.meshNode?.serialNumber ?? null,
        expectedUpdatedAt: fixture.updatedAt.toISOString(),
        allowed: blockedReasons.length === 0, blockedReasons };
    }, txOptions);
  }

  async create(user: AuthenticatedUser, scope: RemovalScope, input: unknown): Promise<FixtureRegistrationRemovalView> {
    const parsed = fixtureRegistrationRemovalRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("invalid registration removal request");
    const request = parsed.data;
    return this.prisma.$transaction(async tx => {
      await this.authorize(tx, user, scope);
      const requestHash = canonicalPayloadHash({ ...scope, ...request });
      const prior = await tx.fixtureRegistrationRemovalOperation.findUnique({ where: {
        siteId_requestedById_clientRequestId: { siteId: scope.siteId, requestedById: user.id, clientRequestId: request.clientRequestId }
      } });
      // Retained exact retries precede both optimistic concurrency and admission:
      // the original pending operation deliberately makes new work ineligible.
      if (prior) {
        if (prior.requestHash !== requestHash || prior.floorId !== scope.floorId || prior.fixtureId !== scope.fixtureId) {
          throw new ConflictException({ code: "REMOVAL_REQUEST_CONFLICT" });
        }
        return removalView(prior);
      }
      const initial = await this.fixture(tx, scope);
      if (!initial.meshNode?.deviceUuid || !initial.gatewayId) throw new ConflictException({ code: "REGISTRATION_UNAVAILABLE" });
      await lockFixtureRegistrationRemovalDomain(tx, { ...scope, gatewayId: initial.gatewayId,
        meshNodeId: initial.meshNode.id, deviceUuid: initial.meshNode.deviceUuid });
      const fixture = await this.fixture(tx, scope);
      const now = await this.clock.assertHealthy(tx);
      if (fixture.updatedAt.toISOString() !== request.expectedUpdatedAt) throw new ConflictException({ code: "SETTINGS_VERSION_CONFLICT" });
      const blockedReasons = await this.blockers(tx, fixture, now);
      if (blockedReasons.length) throw new ConflictException({ code: "REGISTRATION_REMOVAL_BLOCKED", blockedReasons });
      const node = fixture.meshNode!; const gateway = node.gateway;
      await authorizeBioRegistrationGateway(tx, { siteId: scope.siteId, gatewayId: gateway.id,
        expectedAssignmentVersion: gateway.assignmentVersion }, now);
      const original = await this.originalProvision(tx, fixture);
      const envelope = { version: 1 as const, ...scope, gatewayId: gateway.id, gatewaySerial: gateway.serialNumber,
        assignmentVersion: gateway.assignmentVersion, nodeId: original.nodeId, deviceUuid: node.deviceUuid!,
        meshAddress: node.meshAddress, originalProvisionCommandId: original.commandId };
      const { floorId: _floor, ...wire } = envelope;
      const operationId = randomUUID(), expiresAt = new Date(now.getTime() + 30_000);
      const provisional = { ...wire, operationId, bindingHash: `sha256:${"0".repeat(64)}`,
        requestedAt: now.toISOString(), expiresAt: expiresAt.toISOString() };
      const bindingSnapshot = fixtureRegistrationRemovalBindingIdentity(provisional);
      const bindingHash = canonicalPayloadHash(bindingSnapshot);
      const payload = fixtureRegistrationRemovalCommandSchema.parse({ ...provisional, bindingHash });
      const row = await tx.fixtureRegistrationRemovalOperation.create({ data: {
        ...scope, operationId, gatewayId: gateway.id, gatewaySerial: gateway.serialNumber,
        assignmentVersion: gateway.assignmentVersion, nodeId: original.nodeId, meshNodeId: node.id,
        deviceUuid: node.deviceUuid!, meshAddress: node.meshAddress, originalProvisionCommandId: original.commandId,
        fixtureName: fixture.name, serialNumber: node.serialNumber, requestedById: user.id,
        clientRequestId: request.clientRequestId, expectedUpdatedAt: fixture.updatedAt, requestHash,
        bindingSnapshot, bindingHash, payload, commandHash: canonicalPayloadHash(payload), requestedAt: now, expiresAt, nextAttemptAt: now
      } });
      return removalView(row);
    }, txOptions);
  }

  async byRequest(user: AuthenticatedUser, scope: RemovalScope, clientRequestId: string) {
    if (!uuid.safeParse(clientRequestId).success) throw new BadRequestException("invalid client request ID");
    return this.prisma.$transaction(async tx => {
      await this.authorize(tx, user, scope);
      const row = await tx.fixtureRegistrationRemovalOperation.findFirst({ where: { ...scope, requestedById: user.id, clientRequestId } });
      return row ? removalView(row) : null;
    }, txOptions);
  }

  async get(user: AuthenticatedUser, scope: RemovalScope, operationId: string) {
    if (!uuid.safeParse(operationId).success) throw new BadRequestException("invalid operation ID");
    return this.prisma.$transaction(async tx => {
      await this.authorize(tx, user, scope);
      const row = await tx.fixtureRegistrationRemovalOperation.findFirst({ where: { ...scope, operationId, requestedById: user.id } });
      if (!row) throw new NotFoundException("registration removal not found");
      return removalView(row);
    }, txOptions);
  }

  async lockCurrent(tx: Prisma.TransactionClient, row: FixtureRegistrationRemovalOperation, now: Date) {
    await lockFixtureRegistrationRemovalDomain(tx, row);
    const actor = await tx.user.findUnique({ where: { id: row.requestedById }, include: { organization: true } });
    if (!actor) throw new NotFoundException("removal requester not found");
    await this.access.assertManageInTransaction(tx, { ...actor, organizationType: actor.organization.type }, row.siteId);
    await authorizeBioRegistrationGateway(tx, { siteId: row.siteId, gatewayId: row.gatewayId,
      expectedAssignmentVersion: row.assignmentVersion }, now);
    const fixture = await this.fixture(tx, row);
    const node = fixture.meshNode;
    if (!node || fixture.meshNodeId !== row.meshNodeId || node.gateway.serialNumber !== row.gatewaySerial ||
      (!fixture.retiredAt && (node.deviceUuid !== row.deviceUuid || node.meshAddress !== row.meshAddress)) ||
      fixture.floor.status !== "active") throw new ConflictException("removal binding changed");
    return fixture;
  }

  async ingest(topic: string, value: unknown, receivedAt: Date) {
    const parsed = fixtureRegistrationRemovalTerminalSchema.safeParse(value);
    if (!parsed.success || !Number.isFinite(receivedAt.getTime())) throw new BadRequestException("invalid removal terminal");
    const terminal = parsed.data;
    if (topic !== fixtureRegistrationRemovalTopics.terminal(terminal.siteId, terminal.gatewayId)) throw new BadRequestException("removal topic mismatch");
    return this.prisma.$transaction(async tx => {
      const initial = await tx.fixtureRegistrationRemovalOperation.findUnique({ where: { operationId: terminal.operationId } });
      if (!initial) throw new BadRequestException("unknown removal operation");
      const now = await this.clock.assertHealthy(tx);
      await this.lockCurrent(tx, initial, now);
      await tx.$queryRaw`SELECT "operationId" FROM "FixtureRegistrationRemovalOperation" WHERE "operationId"=${initial.operationId} FOR UPDATE`;
      const row = await tx.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId: initial.operationId } });
      const command = fixtureRegistrationRemovalCommandSchema.parse(row.payload);
      if (row.commandHash !== canonicalPayloadHash(command) || terminal.commandHash !== row.commandHash ||
        row.bindingHash !== canonicalPayloadHash(fixtureRegistrationRemovalBindingIdentity(command)) ||
        Object.keys(command).some(key => command[key as keyof typeof command] !== terminal[key as keyof typeof terminal]) ||
        Date.parse(terminal.occurredAt) > receivedAt.getTime() + 1_000) throw new ConflictException("removal terminal identity mismatch");
      const resultHash = canonicalPayloadHash(terminal);
      const priorEvidence = await tx.fixtureRegistrationRemovalResultEvidence.findUnique({ where: { eventId: terminal.eventId } });
      if (priorEvidence) {
        if (priorEvidence.operationId !== row.operationId || priorEvidence.terminalHash !== resultHash ||
          canonicalPayloadHash(priorEvidence.terminal) !== resultHash) throw new ConflictException("removal terminal event conflict");
        const oldAck = fixtureRegistrationRemovalAckSchema.parse(priorEvidence.applicationAck);
        if (priorEvidence.applicationAckHash !== canonicalPayloadHash(oldAck) || oldAck.eventId !== terminal.eventId ||
          oldAck.resultHash !== resultHash || oldAck.commandHash !== row.commandHash) throw new ConflictException("removal retained ACK conflict");
        // An old unknown replay gets its own ACK, never the latest definitive ACK
        // and never a write to the current result or its delivery state.
        return oldAck;
      }
      if (row.resultHash) {
        const previous = fixtureRegistrationRemovalTerminalSchema.parse(row.result);
        if (row.status !== "reconcile_required" || previous.status !== "reconcile_required" || terminal.status === "reconcile_required") {
          throw new ConflictException("removal definitive terminal conflict");
        }
      }
      if (terminal.status === "removed" && !await this.cleanup.isApplied(tx, row)) throw new ConflictException("removal cleanup not applied");
      const { requestedAt: _r, expiresAt: _e, ...identity } = command;
      const ack = fixtureRegistrationRemovalAckSchema.parse({ ...identity, commandHash: row.commandHash,
        eventId: terminal.eventId, resultHash, ingestedAt: receivedAt.toISOString(), status: "ingested" });
      await tx.fixtureRegistrationRemovalResultEvidence.create({ data: { operationId: row.operationId, siteId: row.siteId,
        eventId: terminal.eventId, terminal, terminalHash: resultHash, applicationAck: ack,
        applicationAckHash: canonicalPayloadHash(ack), receivedAt } });
      await tx.fixtureRegistrationRemovalOperation.update({ where: { operationId: row.operationId }, data: {
        status: terminal.status === "removed" ? "gateway_confirmed"
          : terminal.status === "rejected" && row.cleanupSnapshot ? "reconcile_required" : terminal.status,
        errorCode: terminal.errorCode, result: terminal, resultHash, resultEventId: terminal.eventId,
        ...(terminal.status === "removed" ? { gatewayConfirmedAt: now } : {}), lockedBy: null, leaseExpiresAt: null,
        applicationAck: ack, applicationAckHash: canonicalPayloadHash(ack), ackPublishedAt: null,
        ackNextAttemptAt: now, ackLockedBy: null, ackLeaseExpiresAt: null
      } });
      return ack;
    }, txOptions);
  }

  async finalize(operationId: string) {
    return this.prisma.$transaction(async tx => {
      const initial = await tx.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } });
      const now = await this.clock.assertHealthy(tx);
      await this.lockCurrent(tx, initial, now);
      await tx.$queryRaw`SELECT "operationId" FROM "FixtureRegistrationRemovalOperation" WHERE "operationId"=${operationId} FOR UPDATE`;
      const row = await tx.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } });
      if (row.status === "completed") return;
      if (row.status !== "gateway_confirmed" || !await this.cleanup.isApplied(tx, row)) return;
      await this.retirement.retire(tx, row, now);
      await tx.fixtureRegistrationRemovalOperation.update({ where: { operationId }, data: { status: "completed", completedAt: now } });
    }, txOptions);
  }

  private async authorize(tx: Prisma.TransactionClient, user: AuthenticatedUser, scope: RemovalScope) {
    if (Object.values(scope).some(id => !uuid.safeParse(id).success)) throw new BadRequestException("invalid removal scope");
    await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
    await this.access.assertManageInTransaction(tx, user, scope.siteId);
  }

  private async fixture(tx: Prisma.TransactionClient, scope: RemovalScope) {
    const fixture = await tx.fixture.findFirst({ where: { id: scope.fixtureId, siteId: scope.siteId, floorId: scope.floorId }, include: { floor: true, meshNode: { include: { gateway: true } } } });
    if (!fixture || fixture.floor.status !== "active") throw new NotFoundException("fixture not found");
    return fixture;
  }

  private async originalProvision(tx: Prisma.TransactionClient, fixture: Awaited<ReturnType<FixtureRegistrationRemovalsService["fixture"]>>) {
    const node = fixture.meshNode!;
    const commands = await tx.provisioningDeviceOutbox.findMany({ where: { session: { siteId: fixture.siteId,
      floorId: fixture.floorId, gatewayId: fixture.gatewayId! }, node: { deviceUuid: node.deviceUuid!, meshAddress: node.meshAddress } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    for (const stored of commands) {
      const parsed = provisioningDeviceCommandV2Schema.safeParse(stored.payload);
      if (!parsed.success || parsed.data.operation === "identify") continue;
      const command = parsed.data;
      const receipt = await tx.mqttOutbox.findUnique({ where: { applicationAckKey: `provisioning-device-terminal:${node.gatewayId}:${stored.id}` } });
      const ack = receipt && applicationProvisioningDeviceTerminalIngestedAckV2Schema.safeParse(receipt.payload);
      if (!receipt || !ack?.success || ack.data.operation === "identify" || receipt.payloadHash !== canonicalPayloadHash(receipt.payload) ||
        receipt.topic !== mqttTopicsV2.provisioningDeviceTerminalIngestedAck(fixture.siteId, node.gatewayId) ||
        command.commandId !== stored.id || command.nodeId !== stored.nodeId || command.sessionId !== stored.sessionId ||
        command.siteId !== fixture.siteId || command.gatewayId !== node.gatewayId || command.deviceUuid !== node.deviceUuid ||
        command.meshAddress !== node.meshAddress || ack.data.commandId !== stored.id || ack.data.nodeId !== command.nodeId ||
        ack.data.sessionId !== command.sessionId || ack.data.deviceUuid !== command.deviceUuid || ack.data.meshAddress !== command.meshAddress ||
        ack.data.siteId !== fixture.siteId || ack.data.gatewayId !== node.gatewayId) continue;
      const ledger = await tx.processedGatewayEvent.findUnique({ where: { eventId: ack.data.eventId } });
      if (ledger?.gatewayId === node.gatewayId && ledger.eventType === "provisioning_device_terminal" &&
        ledger.ingestionStatus === "accepted" && ledger.sequence === BigInt(ack.data.sequence)) return command;
    }
    throw new ConflictException({ code: "ACCEPTED_PROVISION_LEDGER_REQUIRED" });
  }

  private async blockers(tx: Prisma.TransactionClient, fixture: Awaited<ReturnType<FixtureRegistrationRemovalsService["fixture"]>>, now: Date) {
    const reasons: Array<{ code: string; message: string }> = [];
    const add = (code: string, message: string) => reasons.push({ code, message });
    const node = fixture.meshNode, gateway = node?.gateway;
    if (!node || node.vehicleSensorProtocol !== "bio_usb_pulse" || !node.deviceUuid || !/^bio:[0-9a-f]{12}$/.test(node.deviceUuid)) add("BIO_ONLY", "BIO 조명 등록만 삭제할 수 있습니다.");
    if (!gateway || !isGatewayHeartbeatFresh(gateway.lastHeartbeatAt, now)) add("GATEWAY_OFFLINE", "Gateway 연결을 확인해 주세요.");
    if (gateway?.fixtureRegistrationRemovalVersion !== 1) add("GATEWAY_UNSUPPORTED", "Gateway 업데이트가 필요합니다.");
    if (!await tx.fixture.findFirst({ where: { id: fixture.id, ...activeFixtureRegistrationWhere }, select: { id: true } })) add("REGISTRATION_UNAVAILABLE", "삭제 진행 중이거나 퇴역한 등록입니다.");
    if (fixture.floor.editorLeaseExpiresAt && fixture.floor.editorLeaseExpiresAt > now) add("MAP_EDITOR_BUSY", "맵 편집을 종료해 주세요.");
    const rows = await tx.$queryRaw<Array<{ code: string }>>(Prisma.sql`
      SELECT 'GROUP_LINKED' AS code WHERE EXISTS(SELECT 1 FROM "GroupFixture" WHERE "fixtureId"=${fixture.id})
      UNION ALL SELECT 'REMOVAL_CONVERGENCE_BUSY' WHERE EXISTS(SELECT 1 FROM "FixtureRegistrationRemovalOperation" WHERE "fixtureId"<>${fixture.id} AND status NOT IN ('completed','rejected'))
      UNION ALL SELECT 'SCHEDULE_LINKED' WHERE EXISTS(SELECT 1 FROM "LightingScheduleFixture" WHERE "fixtureId"=${fixture.id})
      UNION ALL SELECT 'EVENT_LINKED' WHERE EXISTS(SELECT 1 FROM "VehicleEventSource" WHERE "fixtureId"=${fixture.id}) OR EXISTS(SELECT 1 FROM "VehicleEventTarget" WHERE "fixtureId"=${fixture.id})
      UNION ALL SELECT 'CONTROL_UNSETTLED' WHERE EXISTS(SELECT 1 FROM "CommandFixtureResult" r JOIN "CommandDispatch" d ON d.id=r."dispatchId" WHERE r."fixtureId"=${fixture.id} AND (d.status IN ('pending','published','accepted','timed_out') OR r.status IN ('pending','timed_out'))) OR EXISTS(SELECT 1 FROM "UnresolvedCommandHoldTarget" WHERE "fixtureId"=${fixture.id})
      UNION ALL SELECT 'TEMPORARY_CONTROL_UNSETTLED' WHERE EXISTS(SELECT 1 FROM "TemporaryControlLease" WHERE "fixtureId"=${fixture.id} AND "ownerSessionId" IS NOT NULL)
      UNION ALL SELECT 'SENSOR_WORK_UNSETTLED' WHERE EXISTS(SELECT 1 FROM "BioSensorPreparationOperation" WHERE "fixtureId"=${fixture.id} AND "supersededAt" IS NULL AND status IN ('pending','unknown','timed_out')) OR EXISTS(SELECT 1 FROM "SensorModeOperation" WHERE "fixtureId"=${fixture.id} AND "supersededAt" IS NULL AND status IN ('pending','unknown','timed_out')) OR EXISTS(SELECT 1 FROM "BioRegistrationRevalidationOperation" WHERE "fixtureId"=${fixture.id} AND "supersededAt" IS NULL AND "appliedAt" IS NULL AND status IN ('pending','unknown','timed_out'))
      UNION ALL SELECT 'MAP_SAVE_BUSY' WHERE EXISTS(SELECT 1 FROM "FloorMapStage" WHERE "floorId"=${fixture.floorId} AND status::text IN ('preparing','ready','queued','processing')) OR EXISTS(SELECT 1 FROM "FloorImportJob" WHERE "floorId"=${fixture.floorId} AND status::text IN ('queued','processing'))
      UNION ALL SELECT 'GROUP_SYNC_BUSY' WHERE EXISTS(SELECT 1 FROM "MeshControlGroupMember" m JOIN "MeshControlGroup" g ON g.id=m."groupId" WHERE m."meshNodeId"=${fixture.meshNodeId} AND g.status<>'ready')
      UNION ALL SELECT 'AUTOMATION_SYNC_BUSY' WHERE EXISTS(SELECT 1 FROM "GatewayAutomationConfiguration" WHERE "gatewayId"=${fixture.gatewayId} AND "syncStatus"<>'APPLIED')
      UNION ALL SELECT 'PROVISIONING_BUSY' WHERE EXISTS(SELECT 1 FROM "ProvisioningSession" WHERE "gatewayId"=${fixture.gatewayId} AND status='active' AND "scanStatus" IN ('pending','scanning')) OR EXISTS(SELECT 1 FROM "DiscoveredMeshNode" WHERE "deviceUuid"=${node?.deviceUuid ?? null} AND status IN ('identifying','provisioning','reconcile_required'))
    `);
    for (const row of rows) add(row.code, "연결된 설정 또는 진행 중인 작업을 먼저 해제해 주세요.");
    return reasons;
  }
}

export function removalView(row: FixtureRegistrationRemovalOperation): FixtureRegistrationRemovalView {
  return fixtureRegistrationRemovalViewSchema.parse({ operationId: row.operationId, siteId: row.siteId,
    floorId: row.floorId, fixtureId: row.fixtureId, status: row.status, errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null });
}

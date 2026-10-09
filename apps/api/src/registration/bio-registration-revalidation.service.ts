import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type BioRegistrationRevalidationOperation } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { bioRegistrationRevalidationRequestSchema, bioRegistrationRevalidationCommandSchema,
  bioRegistrationRevalidationResultSchema, bioRegistrationRevalidationAckSchema, bioRegistrationRevalidationTopics,
  provisioningDeviceCommandV2Schema, type BioRegistrationRevalidationAck } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CommandDbClockHealth } from "../mqtt/command-db-clock-health.service";
import { PrismaService } from "../prisma/prisma.service";
import { authorizeBioRegistrationGateway, bioRegistrationRevalidationHash, loadLockedBioRegistrationBinding,
  type BioRegistrationBinding } from "./bio-registration-revalidation-binding";
import { lockRegistrationDeviceUuids, lockRegistrationDomain } from "./registration-domain-locks";

export interface BioRegistrationRevalidationView {
  commandId: string; siteId: string; gatewayId: string; fixtureId: string;
  status: "pending" | "observed" | "unknown" | "timed_out";
  observedMode: "sensor" | "force-on" | "force-off" | null;
  requestedAt: string; expiresAt: string; applyDeadlineAt: string; supersededAt: string | null; appliedAt: string | null;
}

@Injectable()
export class BioRegistrationRevalidationService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly clock: CommandDbClockHealth) {}

  async create(user: AuthenticatedUser, input: unknown): Promise<BioRegistrationRevalidationView> {
    const parsed = bioRegistrationRevalidationRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("invalid BIO registration revalidation request");
    const request = parsed.data;
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      await this.access.assertCommissionInTransaction(tx, user, request.siteId);
      const now = await this.clock.assertHealthy(tx);
      const prior = await tx.bioRegistrationRevalidationOperation.findUnique({ where: {
        siteId_requestedById_clientRequestId: { siteId: request.siteId, requestedById: user.id, clientRequestId: request.clientRequestId }
      } });
      if (prior && (prior.fixtureId !== request.fixtureId || prior.gatewayId !== request.gatewayId ||
          prior.assignmentVersion !== request.expectedAssignmentVersion)) throw new ConflictException("BIO request identity conflict");
      const binding = await loadLockedBioRegistrationBinding(tx, request, prior?.appliedAt ? "provisioned" : "discovered", now);
      // The operation lock always follows the full registration/native/canonical chain.
      if (prior) {
        await tx.$queryRaw`SELECT "commandId" FROM "BioRegistrationRevalidationOperation" WHERE "commandId"=${prior.commandId} FOR UPDATE`;
        const current = await tx.bioRegistrationRevalidationOperation.findUniqueOrThrow({ where: { commandId: prior.commandId } });
        if (current.bindingHash !== bioRegistrationRevalidationHash(binding)) throw new ConflictException("BIO current binding changed");
        return view(current);
      }
      const commandId = randomUUID(); const expiresAt = new Date(now.getTime() + 30_000);
      const payload = bioRegistrationRevalidationCommandSchema.parse({ version: 2, purpose: "bio_registration_revalidation",
        operation: "query", commandId, siteId: binding.siteId, gatewayId: binding.gatewayId, fixtureId: binding.fixtureId,
        nodeId: binding.nodeId, assignmentVersion: binding.assignmentVersion, deviceIdentityHash: binding.deviceIdentityHash,
        meshAddress: binding.meshAddress, requestedAt: now.toISOString(), expiresAt: expiresAt.toISOString() });
      await tx.$queryRaw`SELECT "commandId" FROM "BioRegistrationRevalidationOperation" WHERE "fixtureId"=${binding.fixtureId}
        AND "supersededAt" IS NULL AND "appliedAt" IS NULL ORDER BY "commandId" FOR UPDATE`;
      await tx.bioRegistrationRevalidationOperation.updateMany({ where: { fixtureId: binding.fixtureId, supersededAt: null, appliedAt: null },
        data: { supersededAt: now } });
      const row = await tx.bioRegistrationRevalidationOperation.create({ data: { ...binding, commandId,
        requestedById: user.id, clientRequestId: request.clientRequestId, bindingSnapshot: binding as unknown as Prisma.InputJsonValue,
        bindingHash: bioRegistrationRevalidationHash(binding), payload, payloadHash: bioRegistrationRevalidationHash(payload),
        requestedAt: now, expiresAt, applyDeadlineAt: new Date(now.getTime() + 120_000), nextAttemptAt: now } });
      return view(row);
    }, { timeout: 10_000 });
  }

  async get(user: AuthenticatedUser, commandId: string): Promise<BioRegistrationRevalidationView> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(commandId)) {
      throw new BadRequestException("invalid BIO revalidation command ID");
    }
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      const initial = await tx.bioRegistrationRevalidationOperation.findUnique({ where: { commandId } });
      if (!initial || initial.requestedById !== user.id) throw new NotFoundException("BIO revalidation request not found");
      await this.access.assertCommissionInTransaction(tx, user, initial.siteId);
      const now = await this.clock.assertHealthy(tx);
      const binding = await loadLockedBioRegistrationBinding(tx, { siteId: initial.siteId, gatewayId: initial.gatewayId,
        fixtureId: initial.fixtureId, expectedAssignmentVersion: initial.assignmentVersion }, initial.appliedAt ? "provisioned" : "discovered", now);
      await tx.$queryRaw`SELECT "commandId" FROM "BioRegistrationRevalidationOperation" WHERE "commandId"=${commandId} FOR UPDATE`;
      const row = await tx.bioRegistrationRevalidationOperation.findUniqueOrThrow({ where: { commandId } });
      if (row.bindingHash !== bioRegistrationRevalidationHash(binding)) throw new ConflictException("BIO current binding changed");
      return view(row);
    }, { timeout: 10_000 });
  }

  async expire(now?: Date): Promise<void> {
    if (now && !Number.isFinite(now.getTime())) throw new BadRequestException("invalid BIO expiry time");
    await this.prisma.$transaction(async tx => {
      const at = now ?? (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now;
      // Expiration is a terminal lifecycle change, never a synthetic device result.
      await tx.bioRegistrationRevalidationOperation.updateMany({ where: { status: "pending", expiresAt: { lte: at } },
        data: { status: "timed_out", lockedBy: null, leaseExpiresAt: null } });
    });
  }

  async apply(user: AuthenticatedUser, commandId: string): Promise<BioRegistrationRevalidationView> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(commandId)) {
      throw new BadRequestException("invalid BIO revalidation command ID");
    }
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      const initial = await tx.bioRegistrationRevalidationOperation.findUnique({ where: { commandId } });
      if (!initial || initial.requestedById !== user.id) throw new NotFoundException("BIO revalidation request not found");
      await this.access.assertCommissionInTransaction(tx, user, initial.siteId);
      const scope = { siteId: initial.siteId, gatewayId: initial.gatewayId, fixtureId: initial.fixtureId,
        expectedAssignmentVersion: initial.assignmentVersion };
      // Certificate authority precedes Session/candidate/outbox locks. The
      // reviewed binding helper then reacquires Floor/Gateway reentrantly.
      await tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id"=${initial.floorId} FOR UPDATE`;
      await authorizeBioRegistrationGateway(tx, scope, await this.clock.assertHealthy(tx));
      // A competing apply may have completed while we waited for the domain.
      const serialized = await tx.bioRegistrationRevalidationOperation.findUniqueOrThrow({ where: { commandId } });
      const binding = await loadLockedBioRegistrationBinding(tx, scope, serialized.appliedAt ? "provisioned" : "discovered",
        await this.clock.assertHealthy(tx));
      await tx.$queryRaw`SELECT "commandId" FROM "BioRegistrationRevalidationOperation" WHERE "commandId"=${commandId} FOR UPDATE`;
      const row = await tx.bioRegistrationRevalidationOperation.findUniqueOrThrow({ where: { commandId } });
      assertBioRegistrationRevalidationProof(row, binding);
      const now = await this.clock.assertHealthy(tx);
      await authorizeBioRegistrationGateway(tx, scope, now);
      if (row.appliedAt) {
        await assertBioRegistrationRepairAudit(tx, row);
        // Consumption time is immutable: an authorized exact retry remains
        // readable after its original two-minute deadline, with no new writes.
        return view(row);
      }
      if (now >= row.applyDeadlineAt || now < row.proofAcceptedAt!) throw new ConflictException("BIO repair proof expired");
      const pendingScan = await tx.provisioningSession.findFirst({ where: { gatewayId: row.gatewayId, status: "active",
        scanStatus: { in: ["pending", "scanning"] } } });
      const pending = await tx.discoveredMeshNode.findUniqueOrThrow({ where: { id: row.discoveredNodeId } });
      const otherQueued = await tx.provisioningDeviceOutbox.findMany({ where: { nodeId: row.discoveredNodeId,
        id: { not: row.originalProvisionCommandId }, publishedAt: null, deadLetteredAt: null } });
      // Completed registration deliberately retains pendingFixture* metadata.
      // Neither those values nor the original command's PUBACK timestamp prove
      // an active registration; separate queued provision work remains a conflict.
      if (pendingScan || otherQueued.some(command => {
        const parsed = provisioningDeviceCommandV2Schema.safeParse(command.payload);
        return !parsed.success || parsed.data.operation !== "identify";
      })) {
        throw new ConflictException("BIO current registration operation conflict");
      }
      const updated = await tx.discoveredMeshNode.updateMany({ where: { id: row.discoveredNodeId, sessionId: row.sessionId,
        status: "discovered", identifyState: "confirmed", deviceUuid: pending.deviceUuid, meshAddress: row.meshAddress },
        data: { status: "provisioned" } });
      if (updated.count !== 1) throw new ConflictException("BIO registration changed concurrently");
      // Mandatory audit and consumption share this transaction; insert failure
      // must roll back the candidate UPDATE rather than leave an unaudited repair.
      const audit = await tx.auditLog.create({ data: { siteId: row.siteId, organizationId: user.organizationId,
        actorId: user.id, action: "bio_registration_current_revalidated", targetType: "DiscoveredMeshNode",
        targetId: row.discoveredNodeId, outcome: "changed", metadata: repairAuditMetadata(row, now) } });
      return view(await tx.bioRegistrationRevalidationOperation.update({ where: { commandId },
        data: { appliedAt: now, auditId: audit.id } }));
    }, { timeout: 10_000 });
  }

  /** Shared canonical recheck for result ingestion and the query publisher.
   * Unattested DB time may reject current certificate authority or retain audit;
   * it never permits publication or accepts a device proof. */
  async lockCurrentContext(tx: Prisma.TransactionClient, initial: BioRegistrationRevalidationOperation): Promise<boolean> {
    await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
    const actor = await tx.user.findUnique({ where: { id: initial.requestedById }, include: { organization: true } });
    if (!actor) throw new NotFoundException("BIO requester not found");
    await this.access.assertCommissionInTransaction(tx, { ...actor, organizationType: actor.organization.type } as AuthenticatedUser, initial.siteId);
    await tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id"=${initial.floorId} FOR UPDATE`;
    const authorizationAt = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now;
    await authorizeBioRegistrationGateway(tx, { siteId: initial.siteId, gatewayId: initial.gatewayId,
      expectedAssignmentVersion: initial.assignmentVersion }, authorizationAt);
    // Lock the retained domain even if its present graph no longer satisfies the
    // binding validator. Authority loss above is a rejection, not a stale ACK.
    const candidate = await tx.discoveredMeshNode.findUnique({ where: { id: initial.discoveredNodeId }, include: { deviceOutbox: true } });
    await lockRegistrationDomain(tx, { floorId: initial.floorId, gatewayId: initial.gatewayId, sessionId: initial.sessionId,
      nodeIds: [initial.discoveredNodeId], outboxIds: [...new Set([initial.originalProvisionCommandId, ...(candidate?.deviceOutbox.map(row => row.id) ?? [])])] });
    const fixture = await tx.fixture.findUnique({ where: { id: initial.fixtureId }, include: { meshNode: true } });
    const node = await tx.meshNode.findUnique({ where: { id: initial.nodeId } });
    await lockRegistrationDeviceUuids(tx, [node?.deviceUuid, fixture?.meshNode?.deviceUuid].filter((id): id is string => Boolean(id)));
    const nodeIds = [...new Set([initial.nodeId, fixture?.meshNodeId].filter((id): id is string => Boolean(id)))].sort();
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MeshNode" WHERE "id" IN (${Prisma.join(nodeIds)}) ORDER BY "id" FOR UPDATE`);
    await tx.$queryRaw`SELECT "id" FROM "Fixture" WHERE "id"=${initial.fixtureId} FOR UPDATE`;
    const current = await tx.fixture.findUnique({ where: { id: initial.fixtureId } });
    const currentCandidate = await tx.discoveredMeshNode.findUnique({ where: { id: initial.discoveredNodeId } });
    const recheckedAt = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now;
    await authorizeBioRegistrationGateway(tx, { siteId: initial.siteId, gatewayId: initial.gatewayId,
      expectedAssignmentVersion: initial.assignmentVersion }, recheckedAt);
    if (!currentCandidate || currentCandidate.sessionId !== initial.sessionId || !current || current.siteId !== initial.siteId || current.gatewayId !== initial.gatewayId || current.floorId !== initial.floorId ||
      current.meshNodeId !== initial.nodeId) return false;
    try {
      const binding = await loadLockedBioRegistrationBinding(tx, { siteId: initial.siteId, gatewayId: initial.gatewayId,
        fixtureId: initial.fixtureId, expectedAssignmentVersion: initial.assignmentVersion }, initial.appliedAt ? "provisioned" : "discovered", recheckedAt);
      return initial.bindingHash === bioRegistrationRevalidationHash(binding) &&
        initial.bindingHash === bioRegistrationRevalidationHash(initial.bindingSnapshot);
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      // A same-scope authenticated changed graph is retained only as immutable audit.
      return false;
    }
  }

  async ingest(topic: string, rawResult: unknown, receivedAt: Date): Promise<BioRegistrationRevalidationAck> {
    const parsed = bioRegistrationRevalidationResultSchema.safeParse(rawResult);
    if (!parsed.success || !Number.isFinite(receivedAt.getTime())) throw new BadRequestException("invalid BIO registration result");
    const result = parsed.data;
    if (topic !== bioRegistrationRevalidationTopics.result(result.siteId, result.gatewayId)) throw new BadRequestException("BIO result topic mismatch");
    const resultHash = bioRegistrationRevalidationHash(result);
    return this.prisma.$transaction(async tx => {
      const initial = await tx.bioRegistrationRevalidationOperation.findUnique({ where: { commandId: result.commandId } });
      if (!initial) throw new BadRequestException("unknown BIO registration operation");
      const command = bioRegistrationRevalidationCommandSchema.parse(initial.payload);
      if (initial.payloadHash !== bioRegistrationRevalidationHash(command) ||
        (["version", "purpose", "operation", "commandId", "siteId", "gatewayId", "fixtureId", "nodeId", "assignmentVersion", "deviceIdentityHash", "meshAddress"] as const)
          .some(key => command[key] !== result[key])) throw new ConflictException("BIO result identity mismatch");
      let trustedNow: Date | null = null;
      try { trustedNow = await this.clock.assertHealthy(tx); } catch { /* Missing clock evidence permits audit only. */ }
      const currentBinding = await this.lockCurrentContext(tx, initial);
      await tx.$queryRaw`SELECT "commandId" FROM "BioRegistrationRevalidationOperation" WHERE "commandId"=${result.commandId} FOR UPDATE`;
      const row = await tx.bioRegistrationRevalidationOperation.findUniqueOrThrow({ where: { commandId: result.commandId } });
      // Lock waits must not allow an old clock sample to qualify a result after TTL.
      try { trustedNow = await this.clock.assertHealthy(tx); } catch { trustedNow = null; }
      const authorizationAt = trustedNow ?? (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now;
      await authorizeBioRegistrationGateway(tx, { siteId: row.siteId, gatewayId: row.gatewayId,
        expectedAssignmentVersion: row.assignmentVersion }, authorizationAt);
      if (row.resultHash && (row.resultHash !== resultHash || row.resultEventId !== result.eventId)) throw new ConflictException("BIO result full hash/event conflict");
      const occurredAt = Date.parse(result.occurredAt);
      const fresh = row.status === "pending" && !row.supersededAt && currentBinding && trustedNow !== null &&
        trustedNow < row.expiresAt && receivedAt < row.expiresAt && receivedAt >= row.requestedAt &&
        occurredAt >= row.requestedAt.getTime() && occurredAt <= row.expiresAt.getTime() && occurredAt <= receivedAt.getTime() + 1_000;
      const duplicate = row.resultHash !== null;
      if (!duplicate) await tx.bioRegistrationRevalidationOperation.update({ where: { commandId: row.commandId }, data: {
        status: row.status !== "pending" ? row.status : fresh ? result.status : receivedAt >= row.expiresAt ? "timed_out" : "unknown",
        result: result as Prisma.InputJsonValue, resultHash, resultEventId: result.eventId,
        proofAcceptedAt: fresh && result.status === "observed" ? receivedAt : null, lockedBy: null, leaseExpiresAt: null
      } });
      const { occurredAt: _occurredAt, status: _status, ...envelope } = result;
      // ACK schema takes identity only; observed evidence/failure details remain solely in the immutable result.
      const { evidence: _evidence, observedMode: _mode, errorCode: _error, ...identity } = envelope as typeof envelope &
        { evidence?: unknown; observedMode?: unknown; errorCode?: unknown };
      const ack = bioRegistrationRevalidationAckSchema.parse({ ...identity, payloadHash: resultHash,
        ingestedAt: receivedAt.toISOString(), status: duplicate ? "duplicate" : fresh ? "ingested" : "stale_checkpoint" });
      const applicationAckKey = `bio-registration-revalidation:${result.gatewayId}:${result.commandId}:${result.eventId}`;
      const existing = await tx.mqttOutbox.findUnique({ where: { applicationAckKey } });
      if (existing) {
        const retained = bioRegistrationRevalidationAckSchema.safeParse(existing.payload);
        if (!retained.success || existing.topic !== bioRegistrationRevalidationTopics.ack(result.siteId, result.gatewayId) ||
          existing.gatewayId !== result.gatewayId || existing.payloadHash !== bioRegistrationRevalidationHash(existing.payload) ||
          retained.data.payloadHash !== resultHash || Object.keys(identity).some(key => retained.data[key as keyof typeof retained.data] !== identity[key as keyof typeof identity])) {
          throw new ConflictException("BIO durable ACK identity conflict");
        }
        // Preserve the original ACK payload and its hash while reviving delivery.
        await tx.mqttOutbox.update({ where: { applicationAckKey }, data: { publishedAt: null, deadLetteredAt: null,
          attempts: 0, nextAttemptAt: receivedAt, lockedBy: null, lockedAt: null, leaseExpiresAt: null, lastError: null } });
      } else await tx.mqttOutbox.create({ data: { applicationAckKey, gatewayId: result.gatewayId,
        topic: bioRegistrationRevalidationTopics.ack(result.siteId, result.gatewayId), payload: ack,
        payloadHash: bioRegistrationRevalidationHash(ack), nextAttemptAt: receivedAt } });
      return ack;
    }, { timeout: 10_000 });
  }
}

/** Current repair evidence never stands in for a historical completed terminal. */
export function assertBioRegistrationRevalidationProof(row: BioRegistrationRevalidationOperation, binding: BioRegistrationBinding): void {
  const command = bioRegistrationRevalidationCommandSchema.safeParse(row.payload);
  const result = bioRegistrationRevalidationResultSchema.safeParse(row.result);
  if (!command.success || !result.success || result.data.status !== "observed" || row.status !== "observed" ||
      !row.proofAcceptedAt || row.supersededAt || row.bindingHash !== bioRegistrationRevalidationHash(binding) ||
      row.bindingHash !== bioRegistrationRevalidationHash(row.bindingSnapshot) ||
      Object.entries(binding).some(([key, value]) => row[key as keyof typeof row] !== value) ||
      row.payloadHash !== bioRegistrationRevalidationHash(command.data) || row.resultHash !== bioRegistrationRevalidationHash(result.data) ||
      row.resultEventId !== result.data.eventId || row.applyDeadlineAt.getTime() !== row.requestedAt.getTime() + 120_000 ||
      row.expiresAt.getTime() !== row.requestedAt.getTime() + 30_000 ||
      row.proofAcceptedAt < row.requestedAt || row.proofAcceptedAt >= row.expiresAt ||
      Date.parse(result.data.occurredAt) < row.requestedAt.getTime() || Date.parse(result.data.occurredAt) > row.expiresAt.getTime() ||
      Date.parse(result.data.occurredAt) > row.proofAcceptedAt.getTime() + 1_000 ||
      (["commandId", "siteId", "gatewayId", "fixtureId", "nodeId", "assignmentVersion", "deviceIdentityHash", "meshAddress"] as const)
        .some(key => command.data[key] !== row[key] || result.data[key] !== row[key]) ||
      command.data.requestedAt !== row.requestedAt.toISOString() || command.data.expiresAt !== row.expiresAt.toISOString()) {
    throw new ConflictException("BIO current revalidation proof mismatch");
  }
}

function repairAuditMetadata(row: BioRegistrationRevalidationOperation, appliedAt: Date): Prisma.InputJsonObject {
  return { evidenceKind: "current_device_revalidation", beforeStatus: "discovered", afterStatus: "provisioned",
    bindingHash: row.bindingHash, bindingSnapshot: row.bindingSnapshot as Prisma.InputJsonValue,
    originalProvisionCommandId: row.originalProvisionCommandId, originalProvisionPayloadHash: row.originalProvisionPayloadHash,
    revalidationCommandId: row.commandId, revalidationPayloadHash: row.payloadHash,
    revalidationResultHash: row.resultHash, resultEventId: row.resultEventId,
    proofAcceptedAt: row.proofAcceptedAt!.toISOString(), appliedAt: appliedAt.toISOString() };
}

export async function assertBioRegistrationRepairAudit(tx: Prisma.TransactionClient, row: BioRegistrationRevalidationOperation): Promise<void> {
  const audit = row.auditId && await tx.auditLog.findUnique({ where: { id: row.auditId } });
  if (!row.appliedAt || !audit || row.appliedAt < row.proofAcceptedAt! || row.appliedAt >= row.applyDeadlineAt ||
      audit.siteId !== row.siteId || audit.actorId !== row.requestedById || audit.targetId !== row.discoveredNodeId ||
      audit.action !== "bio_registration_current_revalidated" || audit.targetType !== "DiscoveredMeshNode" || audit.outcome !== "changed" ||
      bioRegistrationRevalidationHash(audit.metadata) !== bioRegistrationRevalidationHash(repairAuditMetadata(row, row.appliedAt))) {
    throw new ConflictException("BIO current repair audit mismatch");
  }
}

function view(row: BioRegistrationRevalidationOperation): BioRegistrationRevalidationView {
  const parsed = row.status === "observed" && !row.supersededAt && row.proofAcceptedAt && bioRegistrationRevalidationResultSchema.safeParse(row.result);
  return { commandId: row.commandId, siteId: row.siteId, gatewayId: row.gatewayId, fixtureId: row.fixtureId,
    status: row.status as BioRegistrationRevalidationView["status"],
    observedMode: parsed && parsed.success && parsed.data.status === "observed" ? parsed.data.observedMode : null,
    requestedAt: row.requestedAt.toISOString(), expiresAt: row.expiresAt.toISOString(), applyDeadlineAt: row.applyDeadlineAt.toISOString(),
    supersededAt: row.supersededAt?.toISOString() ?? null, appliedAt: row.appliedAt?.toISOString() ?? null };
}

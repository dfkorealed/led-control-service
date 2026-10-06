import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type BioRegistrationRevalidationOperation } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { bioRegistrationRevalidationRequestSchema, bioRegistrationRevalidationCommandSchema,
  bioRegistrationRevalidationResultSchema, bioRegistrationRevalidationAckSchema, bioRegistrationRevalidationTopics,
  type BioRegistrationRevalidationAck } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CommandDbClockHealth } from "../mqtt/command-db-clock-health.service";
import { PrismaService } from "../prisma/prisma.service";
import { authorizeBioRegistrationGateway, bioRegistrationRevalidationHash, loadLockedBioRegistrationBinding } from "./bio-registration-revalidation-binding";
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

function view(row: BioRegistrationRevalidationOperation): BioRegistrationRevalidationView {
  const parsed = row.status === "observed" && !row.supersededAt && row.proofAcceptedAt && bioRegistrationRevalidationResultSchema.safeParse(row.result);
  return { commandId: row.commandId, siteId: row.siteId, gatewayId: row.gatewayId, fixtureId: row.fixtureId,
    status: row.status as BioRegistrationRevalidationView["status"],
    observedMode: parsed && parsed.success && parsed.data.status === "observed" ? parsed.data.observedMode : null,
    requestedAt: row.requestedAt.toISOString(), expiresAt: row.expiresAt.toISOString(), applyDeadlineAt: row.applyDeadlineAt.toISOString(),
    supersededAt: row.supersededAt?.toISOString() ?? null, appliedAt: row.appliedAt?.toISOString() ?? null };
}

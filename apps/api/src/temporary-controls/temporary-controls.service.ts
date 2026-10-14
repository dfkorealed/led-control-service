import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { temporaryControlCreateSchema, temporaryControlEndSchema, temporaryControlListQuerySchema, temporaryControlCommandSchema,
  automationSnapshotSchema, automationConfigAppliedReceiptSchema, mqttTopics,
  temporaryControlResultSchema, temporaryControlViewSchema, type CreateTemporaryControlInput, type EndTemporaryControlInput,
  type TemporaryControlView, type TemporaryControlListQuery, type TemporaryControlListResponse, type TemporaryFixtureSnapshot } from "@led-control/shared";
import { Prisma, type TemporaryControlSession, type TemporaryControlTarget } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SiteAccessService } from "../access/site-access.service";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { TargetSnapshotService } from "../automation/target-snapshot.service";
import { loadAutomationProtocolSupport } from "../automation/automation-protocol-support";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { assertNoActiveBioSourceTarget } from "../automation/bio-source-target-policy";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { CommandDbClockHealth } from "../mqtt/command-db-clock-health.service";

@Injectable()
export class TemporaryControlsService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly snapshots: AutomationSnapshotService, private readonly targets: TargetSnapshotService,
    private readonly clockHealth: CommandDbClockHealth = new CommandDbClockHealth()) {}

  async start(siteId: string, actor: AuthenticatedUser, input: CreateTemporaryControlInput): Promise<TemporaryControlView> {
    const parsed = temporaryControlCreateSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("invalid temporary control");
    input = parsed.data;
    const target = input.target.type === "fixtures" ? { ...input.target, fixtureIds: [...input.target.fixtureIds].sort() } : input.target;
    const fingerprint = canonicalPayloadHash({ target, brightness: input.brightness, durationMinutes: input.durationMinutes });
    return this.transaction(async tx => {
      await this.snapshots.lockMutation(tx);
      await this.access.assertControlInTransaction(tx, actor, siteId);
      const previous = await replay(tx, siteId, actor.id, "start", input.clientRequestId, fingerprint);
      if (previous) return temporaryControlView(tx, previous, await temporaryControlNow(tx));
      const fixtureIds = await this.targets.resolve(tx, siteId, input.target);
      if (fixtureIds.length > 1000) throw new BadRequestException("temporary target limit exceeded");
      const gatewayId = await this.targets.assertSingleGateway(tx, fixtureIds);
      if (await loadAutomationProtocolSupport(tx, { siteId, gatewayId }) !== 3) throw conflict("temporary_control_unsupported");
      await loadTemporaryAdmission(tx, { siteId, gatewayId });
      await assertNoActiveBioSourceTarget(tx, siteId, fixtureIds, "manual");
      await assertNoTemporaryLease(tx, fixtureIds);
      const overlapping = await tx.command.findFirst({ where: { siteId, outcome: { in: ["pending", "unknown"] },
        OR: fixtureIds.map(id => ({ targetFixtureIds: { array_contains: [id] } })) }, select: { id: true } });
      if (overlapping) throw conflict("uncertain_command_requires_status_check");
      let now: Date;
      try { now = await this.clockHealth.assertHealthy(tx); }
      catch { throw new ServiceUnavailableException("temporary control clock unavailable"); }
      const fixtures = await tx.fixture.findMany({ where: { id: { in: fixtureIds }, siteId, gatewayId }, include: { meshNode: true }, orderBy: { id: "asc" } });
      if (fixtures.length !== fixtureIds.length || fixtures.some(f => !f.meshNode || f.meshNode.gatewayId !== gatewayId
        || f.meshNode.vehicleSensorProtocol !== "bio_usb_pulse" || !/^bio:[0-9a-f]{12}$/.test(f.meshNode.deviceUuid ?? "")
        || !/^0x[0-7][0-9a-f]{3}$/.test(f.meshNode.meshAddress) || f.meshNode.meshAddress === "0x0000")) throw conflict("temporary_control_bio_identity_required");
      const certificate = await tx.gatewayCertificate.findFirst({ where: { gatewayId, purpose: "mqtt", status: "active", revokedAt: null,
        notBefore: { lte: now }, notAfter: { gt: now }, inventory: { claimedGatewayId: gatewayId, disabledAt: null, claimedAt: { not: null } } } });
      if (!certificate) throw conflict("temporary_control_gateway_unavailable");
      const reserved: TemporaryFixtureSnapshot[] = [];
      for (const fixture of fixtures) {
        const identity = { fixtureId: fixture.id, meshNodeId: fixture.meshNodeId!, nativeUuid: fixture.meshNode!.deviceUuid!.slice(4), logicalAddress: fixture.meshNode!.meshAddress };
        const lease = await tx.temporaryControlLease.upsert({ where: { fixtureId: fixture.id }, update: {},
          create: { ...identity, liveFixtureId: fixture.id, siteId, gatewayId } });
        if (lease.ownerSessionId || lease.liveFixtureId !== fixture.id || lease.meshNodeId !== identity.meshNodeId
          || lease.nativeUuid !== identity.nativeUuid || lease.logicalAddress !== identity.logicalAddress) throw conflict("temporary_control_identity_conflict");
        reserved.push({ ...identity, applyGeneration: (lease.lastGeneration + 1n).toString(), releaseGeneration: (lease.lastGeneration + 2n).toString() });
      }
      const gateway = await tx.gateway.update({ where: { id: gatewayId }, data: { nextCommandSequence: { increment: 1 } },
        include: { automationConfiguration: true } });
      const sequence = Number(gateway.nextCommandSequence);
      if (!Number.isSafeInteger(sequence)) throw new ServiceUnavailableException("temporary sequence unavailable");
      const id = randomUUID(); const endsAt = new Date(now.getTime() + input.durationMinutes * 60_000);
      const body = { schemaVersion: 1 as const, kind: "start" as const, sessionId: id, sessionRevision: 1 as const,
        siteId, gatewayId, assignmentVersion: gateway.assignmentVersion, admissionRevision: gateway.automationConfiguration?.desiredRevision ?? 0,
        sequence, targets: reserved, brightness: input.brightness, startedAt: now.toISOString(), endsAt: endsAt.toISOString() };
      const payloadHash = canonicalPayloadHash(body);
      const command = temporaryControlCommandSchema.parse({ ...body, payloadHash });
      const session = await tx.temporaryControlSession.create({ data: { id, siteId, gatewayId, actorId: actor.id,
        assignmentVersion: gateway.assignmentVersion, admissionRevision: body.admissionRevision, originSequence: BigInt(sequence),
        originCommandHash: payloadHash, startedAt: now, endsAt, durationMinutes: input.durationMinutes, brightness: input.brightness } });
      await tx.temporaryControlTarget.createMany({ data: reserved.map(t => ({ ...t, sessionId: id, siteId, gatewayId,
        applyGeneration: BigInt(t.applyGeneration), releaseGeneration: BigInt(t.releaseGeneration) })) });
      await tx.temporaryControlOperationReceipt.create({ data: { siteId, actorId: actor.id, operation: "start", clientRequestId: input.clientRequestId, fingerprint, sessionId: id } });
      await tx.temporaryControlOutbox.create({ data: { sessionId: id, siteId, gatewayId, kind: "start", sessionRevision: 1,
        deduplicationKey: `start:${id}`, payload: command, payloadHash } });
      return temporaryControlView(tx, session, now);
    });
  }

  async end(siteId: string, id: string, actor: AuthenticatedUser, input: EndTemporaryControlInput): Promise<TemporaryControlView> {
    if (!temporaryControlEndSchema.safeParse(input).success) throw new BadRequestException("invalid temporary end");
    return this.transaction(async tx => {
      await this.snapshots.lockMutation(tx);
      await this.access.assertControlInTransaction(tx, actor, siteId);
      const fingerprint = canonicalPayloadHash({ sessionId: id });
      const previous = await replay(tx, siteId, actor.id, "end", input.clientRequestId, fingerprint);
      if (previous) return temporaryControlView(tx, previous, await temporaryControlNow(tx));
      const session = await tx.temporaryControlSession.findFirst({ where: { id, siteId } });
      if (!session) throw new NotFoundException("temporary control not found");
      const now = await temporaryControlNow(tx);
      const updated = await ensureTemporaryRelease(tx, session, now);
      await tx.temporaryControlOperationReceipt.create({ data: { siteId, actorId: actor.id, operation: "end", clientRequestId: input.clientRequestId, fingerprint, sessionId: id } });
      return temporaryControlView(tx, updated, now);
    });
  }

  async get(siteId: string, id: string, actor: AuthenticatedUser): Promise<TemporaryControlView> {
    return this.transaction(async tx => {
      await this.authorizeRead(tx, actor, siteId);
      const session = await tx.temporaryControlSession.findFirst({ where: { id, siteId } });
      if (!session) throw new NotFoundException("temporary control not found");
      return temporaryControlView(tx, session, await temporaryControlNow(tx));
    });
  }

  async list(siteId: string, actor: AuthenticatedUser, query: TemporaryControlListQuery): Promise<TemporaryControlListResponse> {
    const parsed = temporaryControlListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("invalid temporary list query");
    let cursor: { at: string; id: string } | undefined;
    if (parsed.data.cursor) {
      try { cursor = z.object({ at: z.string().datetime(), id: z.string().uuid() }).strict().parse(JSON.parse(Buffer.from(parsed.data.cursor, "base64url").toString("utf8"))); }
      catch { throw new BadRequestException("invalid temporary cursor"); }
    }
    return this.transaction(async tx => {
      await this.authorizeRead(tx, actor, siteId);
      const sessions = await tx.temporaryControlSession.findMany({ where: { siteId, ...(parsed.data.state ? { state: parsed.data.state } : {}),
        ...(cursor ? { OR: [{ startedAt: { lt: new Date(cursor.at) } }, { startedAt: new Date(cursor.at), id: { lt: cursor.id } }] } : {}) },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: parsed.data.limit + 1 });
      const page = sessions.slice(0, parsed.data.limit); const last = page.at(-1); const now = await temporaryControlNow(tx);
      return { items: await Promise.all(page.map(s => temporaryControlView(tx, s, now))),
        nextCursor: sessions.length > parsed.data.limit && last ? Buffer.from(JSON.stringify({ at: last.startedAt.toISOString(), id: last.id })).toString("base64url") : null };
    });
  }

  private async authorizeRead(tx: Prisma.TransactionClient, actor: AuthenticatedUser, siteId: string) {
    await this.snapshots.lockMutation(tx);
    const persisted = await tx.user.findUnique({ where: { id: actor.id }, include: { organization: true } });
    if (!persisted || persisted.status !== "active" || persisted.role !== actor.role || persisted.organizationId !== actor.organizationId) throw new NotFoundException("site not found");
    await this.access.assertReadInTransaction(tx, { ...actor, status: persisted.status, organizationType: persisted.organization.type }, siteId);
  }

  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.prisma.$transaction(work, { timeout: 30_000 }); }
    catch (error) { if (error instanceof HttpException) throw error; throw new ServiceUnavailableException("temporary control storage unavailable"); }
  }
}

export async function assertNoTemporaryLease(tx: Prisma.TransactionClient, fixtureIds: string[]): Promise<void> {
  if (fixtureIds.length && await tx.temporaryControlLease.findFirst({ where: { fixtureId: { in: fixtureIds }, ownerSessionId: { not: null } }, select: { fixtureId: true } })) throw conflict("temporary_control_lease_conflict");
}

/** Configuration APPLIED is accompanied by its exact durable V3 ACK and the
 * canonical snapshot captured under the current assignment. A numeric version
 * or an old applied revision cannot qualify a new operation. */
export async function loadTemporaryAdmission(tx: Prisma.TransactionClient, scope: { siteId: string; gatewayId: string }) {
  const gateway = await tx.gateway.findFirst({ where: { id: scope.gatewayId, siteId: scope.siteId }, include: { automationConfiguration: true } });
  const config = gateway?.automationConfiguration;
  if (!gateway || !config || config.syncStatus !== "APPLIED" || config.appliedRevision !== config.desiredRevision || !config.payloadHash) throw conflict("temporary_control_configuration_pending");
  const stored = await tx.mqttOutbox.findFirst({ where: { gatewayId: scope.gatewayId, revision: config.desiredRevision,
    payloadHash: config.payloadHash, applicationAckKey: null, automationAssignmentVersion: gateway.assignmentVersion } });
  const snapshot = automationSnapshotSchema.safeParse(stored?.payload);
  if (!snapshot.success || snapshot.data.schemaVersion !== 3 || snapshot.data.siteId !== scope.siteId || snapshot.data.gatewayId !== scope.gatewayId
    || snapshot.data.revision !== config.desiredRevision || snapshot.data.payloadHash !== config.payloadHash) throw conflict("temporary_control_configuration_pending");
  const { payloadHash, ...body } = snapshot.data;
  if (canonicalPayloadHash(body) !== payloadHash) throw conflict("temporary_control_configuration_pending");
  const receiptRow = await tx.mqttOutbox.findFirst({ where: { gatewayId: scope.gatewayId, applicationAckKey: { not: null },
    topic: mqttTopics.automationConfigAppliedReceipt(scope.siteId, scope.gatewayId),
    AND: [{ payload: { path: ["acknowledgement", "payloadHash"], equals: payloadHash } },
      { payload: { path: ["acknowledgement", "status"], equals: "applied" } }] } });
  const receipt = automationConfigAppliedReceiptSchema.safeParse(receiptRow?.payload);
  if (!receipt.success || receipt.data.schemaVersion !== 3 || receipt.data.siteId !== scope.siteId || receipt.data.gatewayId !== scope.gatewayId
    || receipt.data.acknowledgement.revision !== config.desiredRevision || receipt.data.acknowledgement.status !== "applied"
    || receipt.data.acknowledgement.payloadHash !== payloadHash || receiptRow?.payloadHash !== canonicalPayloadHash(receipt.data)) throw conflict("temporary_control_configuration_pending");
  return config;
}

export async function temporaryControlNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "now"`;
  if (!row || !Number.isFinite(row.now.getTime())) throw new ServiceUnavailableException("temporary control clock unavailable");
  return row.now;
}

export function temporaryFixture(target: TemporaryControlTarget): TemporaryFixtureSnapshot {
  return { fixtureId: target.fixtureId, meshNodeId: target.meshNodeId, nativeUuid: target.nativeUuid, logicalAddress: target.logicalAddress,
    applyGeneration: target.applyGeneration.toString(), releaseGeneration: target.releaseGeneration.toString() };
}

export async function ensureTemporaryRelease(tx: Prisma.TransactionClient, session: TemporaryControlSession, now: Date) {
  if (session.terminalAt) return session;
  const updated = session.releaseIntentAt ? session : await tx.temporaryControlSession.update({ where: { id: session.id },
    data: { sessionRevision: 2, releaseIntentAt: now, state: "releasing" } });
  const targets = await tx.temporaryControlTarget.findMany({ where: { sessionId: session.id }, orderBy: { fixtureId: "asc" } });
  const body = { schemaVersion: 1 as const, kind: "end" as const, sessionId: session.id, sessionRevision: 2 as const,
    siteId: session.siteId, gatewayId: session.gatewayId, assignmentVersion: session.assignmentVersion, admissionRevision: session.admissionRevision,
    sequence: Number(session.originSequence), originSequence: Number(session.originSequence), originCommandHash: session.originCommandHash,
    endsAt: session.endsAt.toISOString(), targets: targets.map(temporaryFixture) };
  const payloadHash = canonicalPayloadHash(body);
  await tx.temporaryControlOutbox.upsert({ where: { deduplicationKey: `end:${session.id}` }, update: {},
    create: { sessionId: session.id, siteId: session.siteId, gatewayId: session.gatewayId, kind: "end", sessionRevision: 2,
      // Use the same sample as the claiming batch. The TIMESTAMP(3) default can
      // round up beyond its millisecond-truncated now and miss that first claim.
      deduplicationKey: `end:${session.id}`, payload: temporaryControlCommandSchema.parse({ ...body, payloadHash }), payloadHash, nextAttemptAt: now } });
  return updated;
}

async function replay(tx: Prisma.TransactionClient, siteId: string, actorId: string, operation: string, clientRequestId: string, fingerprint: string) {
  const receipt = await tx.temporaryControlOperationReceipt.findUnique({ where: { siteId_actorId_operation_clientRequestId: { siteId, actorId, operation, clientRequestId } } });
  if (!receipt) return null;
  if (receipt.fingerprint !== fingerprint) throw conflict("temporary_control_idempotency_conflict");
  return tx.temporaryControlSession.findUniqueOrThrow({ where: { id: receipt.sessionId } });
}

export async function temporaryControlView(tx: Prisma.TransactionClient, session: TemporaryControlSession, now: Date): Promise<TemporaryControlView> {
  const targets = session.detailsRedacted ? [] : await tx.temporaryControlTarget.findMany({ where: { sessionId: session.id }, orderBy: { fixtureId: "asc" } });
  const results = session.detailsRedacted ? [] : await tx.temporaryControlResultReceipt.findMany({ where: { sessionId: session.id, status: "applied", result: { not: Prisma.DbNull } }, orderBy: [{ ingestedAt: "asc" }, { eventId: "asc" }] });
  return temporaryControlViewSchema.parse({ id: session.id, siteId: session.siteId, gatewayId: session.gatewayId, state: session.state,
    sessionRevision: session.sessionRevision, now: now.toISOString(), startedAt: session.startedAt.toISOString(), endsAt: session.endsAt.toISOString(),
    brightness: session.detailsRedacted ? null : session.brightness, targets: targets.map(temporaryFixture), results: results.map(r => temporaryControlResultSchema.parse(r.result)),
    reason: session.detailsRedacted ? null : session.reason, detailsRedacted: session.detailsRedacted });
}

function conflict(code: string) { return new ConflictException({ code }); }

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { temporaryControlIngestedReceiptSchema, temporaryControlResultSchema, type TemporaryControlIngestedReceipt, type TemporaryControlResult } from "@led-control/shared";
import { Prisma, type TemporaryControlSession, type TemporaryControlTarget } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { lockAutomationProtocolIdentity } from "../automation/automation-protocol-support";
import { ensureTemporaryRelease, loadTemporaryAdmission, temporaryControlNow } from "./temporary-controls.service";

@Injectable()
export class TemporaryControlResults {
  constructor(private readonly prisma: PrismaService) {}

  async ingestTemporaryControlResult(scope: { siteId: string; gatewayId: string }, input: TemporaryControlResult): Promise<TemporaryControlIngestedReceipt> {
    // MQTT scope objects also carry channel at runtime; never spread transport
    // metadata into Prisma identities despite the narrower TypeScript type.
    scope = { siteId: scope.siteId, gatewayId: scope.gatewayId };
    const parsed = temporaryControlResultSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("invalid temporary result");
    const result = parsed.data; const { resultHash, ...body } = result;
    if (canonicalPayloadHash(body) !== resultHash || result.siteId !== scope.siteId || result.gatewayId !== scope.gatewayId) throw new BadRequestException("temporary result scope/hash mismatch");
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      const identity = await lockAutomationProtocolIdentity(tx, scope);
      if (!identity) throw new BadRequestException("temporary result identity unavailable");
      const now = await temporaryControlNow(tx);
      const session = await tx.temporaryControlSession.findFirst({ where: { id: result.sessionId, siteId: scope.siteId, gatewayId: scope.gatewayId } });
      const target = await tx.temporaryControlTarget.findUnique({ where: { sessionId_fixtureId: { sessionId: result.sessionId, fixtureId: result.fixtureId } } });
      if (!session || !target) throw new NotFoundException("temporary result target not found");
      const existing = await tx.temporaryControlResultReceipt.findUnique({ where: { eventId: result.eventId } });
      if (existing) {
        if (existing.resultHash !== resultHash || existing.sessionId !== session.id || existing.fixtureId !== result.fixtureId) throw new BadRequestException("temporary result identity conflict");
        return persistAck(tx, result, existing.status as "applied" | "rejected", existing.reason, existing.ingestedAt, now);
      }
      let current = session;
      if (!session.terminalAt && !session.releaseIntentAt && now >= session.endsAt) current = await ensureTemporaryRelease(tx, session, now);
      const lease = await tx.temporaryControlLease.findUnique({ where: { fixtureId: result.fixtureId } });
      const fixture = await tx.fixture.findUnique({ where: { id: result.fixtureId }, include: { meshNode: true } });
      let reason: string | null = null;
      if (identity.assignmentVersion !== session.assignmentVersion || result.assignmentVersion !== session.assignmentVersion
        || result.admissionRevision !== session.admissionRevision || result.originCommandHash !== session.originCommandHash
        || BigInt(result.originSequence) !== session.originSequence) reason = "stale_admission";
      else if (session.terminalAt || target.resolvedAt || lease?.ownerSessionId !== session.id || lease.lastGeneration !== target.releaseGeneration
        || lease.liveFixtureId !== target.fixtureId) reason = "stale_owner";
      else if (result.targetGeneration !== (result.sessionRevision === 1 ? target.applyGeneration : target.releaseGeneration).toString()
        || result.sessionRevision > current.sessionRevision) reason = "stale_generation";
      else if (!fixture || fixture.siteId !== scope.siteId || fixture.gatewayId !== scope.gatewayId || fixture.meshNodeId !== target.meshNodeId
        || fixture.meshNode?.deviceUuid !== `bio:${target.nativeUuid}` || fixture.meshNode.meshAddress !== target.logicalAddress) reason = "stale_target";
      else if (Date.parse(result.observedAt) < session.startedAt.getTime() || Date.parse(result.observedAt) > now.getTime() + 2000) reason = "untrusted_time";
      else if (result.applyConfirmed && result.sessionRevision === 1 && (result.configurationReadback?.bioMode !== (session.brightness === 0 ? "force-off" : "force-on")
        || (session.brightness !== 0 && result.configurationReadback?.configuredHighBrightnessPercent !== session.brightness))) reason = "apply_readback_mismatch";
      if (!reason && result.releaseConfirmed) {
        try {
          const config = await loadTemporaryAdmission(tx, scope);
          if (result.restorationRevision !== config.desiredRevision || result.restorationPayloadHash !== config.payloadHash) reason = "stale_restoration";
        } catch { reason = "restoration_configuration_pending"; }
      }
      const historyRows = await tx.temporaryControlResultReceipt.findMany({ where: { sessionId: session.id, fixtureId: target.fixtureId, status: "applied" } });
      const history = historyRows.flatMap(row => { const value = temporaryControlResultSchema.safeParse(row.result); return value.success ? [value.data] : []; });
      if (!reason && history.some(event => event.sessionRevision > result.sessionRevision ||
        (event.sessionRevision === result.sessionRevision && Date.parse(event.observedAt) > Date.parse(result.observedAt)))) reason = "stale_observation";
      const status = reason ? "rejected" : "applied";
      // SQL requires an applied receipt while this exact owner still exists.
      // Receipt, evidence, owner resolution and durable ACK share one commit.
      await tx.temporaryControlResultReceipt.create({ data: { eventId: result.eventId, sessionId: session.id, ...scope,
        fixtureId: result.fixtureId, sessionRevision: result.sessionRevision, targetGeneration: BigInt(result.targetGeneration),
        resultHash, status, reason, result, ingestedAt: now } });
      if (!reason) {
        await projectResult(tx, current, target, result, history, now);
        await aggregateSession(tx, current, now);
      }
      return persistAck(tx, result, status, reason, now, now);
    }, { timeout: 30_000 });
  }
}

async function projectResult(tx: Prisma.TransactionClient, session: TemporaryControlSession, target: TemporaryControlTarget,
  result: TemporaryControlResult, history: TemporaryControlResult[], now: Date) {
  const mutation = target.configurationMayHaveChanged || result.configurationMayHaveChanged || result.rfWriteEvidence !== "not_started";
  const unchanged = !mutation && history.every(r => !r.configurationMayHaveChanged && r.rfWriteEvidence === "not_started" && r.partialMutation === "none");
  // Equal-time contradictory reports remain unresolved; timestamp ties never
  // let iteration order erase an uncertain write or claim a confirmed hold.
  const ties = [...history.filter(r => r.sessionRevision === result.sessionRevision && r.observedAt === result.observedAt), result];
  const releaseConfirmed = result.releaseConfirmed && ties.every(r => r.releaseConfirmed);
  // A mixed start keeps RF0 targets reserved until the session's release
  // revision is observed. Releasing them early would prevent durable revision2
  // receipts and could let a new owner appear inside the old session snapshot.
  const settled = (unchanged && result.sessionRevision === 2) || releaseConfirmed;
  await tx.temporaryControlTarget.update({ where: { sessionId_fixtureId: { sessionId: session.id, fixtureId: target.fixtureId } }, data: {
    applyConfirmed: result.sessionRevision === 1 ? ties.every(r => r.applyConfirmed) : target.applyConfirmed,
    releaseConfirmed, configurationMayHaveChanged: mutation, unchangedConfirmed: unchanged,
    partialMutation: result.partialMutation, rfWriteEvidence: mutation && result.rfWriteEvidence === "not_started" ? target.rfWriteEvidence : result.rfWriteEvidence,
    configurationReadback: result.configurationReadback ?? Prisma.DbNull,
    restorationRevision: result.restorationRevision, restorationPayloadHash: result.restorationPayloadHash,
    reason: result.reason, ...(settled ? { resolvedAt: now } : {})
  } });
  if (settled) await tx.temporaryControlLease.updateMany({ where: { fixtureId: target.fixtureId, ownerSessionId: session.id, lastGeneration: target.releaseGeneration }, data: { ownerSessionId: null } });
}

async function aggregateSession(tx: Prisma.TransactionClient, session: TemporaryControlSession, now: Date) {
  const targets = await tx.temporaryControlTarget.findMany({ where: { sessionId: session.id } });
  const allUnchanged = session.sessionRevision === 1 && targets.every(t => t.unchangedConfirmed);
  if (allUnchanged) {
    await tx.temporaryControlTarget.updateMany({ where: { sessionId: session.id, resolvedAt: null }, data: { resolvedAt: now } });
    await tx.temporaryControlLease.updateMany({ where: { ownerSessionId: session.id }, data: { ownerSessionId: null } });
  }
  const settled = allUnchanged || targets.every(t => t.resolvedAt !== null);
  const state = settled ? targets.some(t => t.releaseConfirmed) ? "restored" : session.releaseIntentAt ? "cancelled" : "rejected"
    : session.releaseIntentAt ? "recovery_pending"
    : targets.every(t => t.applyConfirmed) ? "holding" : targets.some(t => t.applyConfirmed || t.partialMutation !== "none") ? "partial" : "unknown";
  await tx.temporaryControlSession.update({ where: { id: session.id }, data: { state, ...(settled ? { terminalAt: now } : {}) } });
  if (settled) await tx.temporaryControlOutbox.updateMany({ where: { sessionId: session.id, kind: { in: ["start", "end"] }, completedAt: null },
    data: { completedAt: now, leaseToken: null, leaseUntil: null } });
}

async function persistAck(tx: Prisma.TransactionClient, result: TemporaryControlResult, status: "applied" | "rejected", reason: string | null, ingestedAt: Date, now: Date) {
  const receipt = temporaryControlIngestedReceiptSchema.parse({ schemaVersion: 1, sessionId: result.sessionId, siteId: result.siteId,
    gatewayId: result.gatewayId, assignmentVersion: result.assignmentVersion, admissionRevision: result.admissionRevision,
    originCommandHash: result.originCommandHash, originSequence: result.originSequence, eventId: result.eventId,
    sessionRevision: result.sessionRevision, targetGeneration: result.targetGeneration, resultHash: result.resultHash, status, reason, ingestedAt: ingestedAt.toISOString() });
  const key = `ingested:${result.eventId}`;
  const existing = await tx.temporaryControlOutbox.findUnique({ where: { deduplicationKey: key } });
  // A redacted ACK payload cannot be rewritten. Persist an exact replay batch,
  // keeping the immutable first receipt and its original ingestion instant.
  const deduplicationKey = existing?.payload === null ? `${key}:replay:${now.toISOString()}` : key;
  await tx.temporaryControlOutbox.upsert({ where: { deduplicationKey },
    create: { sessionId: result.sessionId, siteId: result.siteId, gatewayId: result.gatewayId, kind: "ingested", sessionRevision: result.sessionRevision,
      deduplicationKey, payload: receipt, payloadHash: canonicalPayloadHash(receipt) },
    update: { completedAt: null, nextAttemptAt: now, publishedAt: null, leaseToken: null, leaseUntil: null, attempts: 0 } });
  return receipt;
}

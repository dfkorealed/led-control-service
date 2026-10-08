import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { bioSensorPreparationRequestV1Schema, bioSensorPreparationCommandV1Schema, bioSensorPreparationReportV1Schema,
  bioSensorPreparationAckV1Schema, matchesBioSensorPreparationReportV1 } from "@led-control/shared";
import { Prisma, type BioSensorPreparationOperation } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { canonicalPayloadHash } from "./automation-payload-hash";
import { lockBioSensorCatalog, loadBioSensorBinding } from "./bio-sensor-catalog-locks";
import { hasCurrentBioPreparationEvidence } from "./bio-sensor-preparation-evidence";
import { BioSensorProfilesService } from "./bio-sensor-profiles.service";

@Injectable()
export class BioSensorPreparationService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly profiles: BioSensorProfilesService) {}

  async create(actor: AuthenticatedUser, value: unknown) {
    const parsed = bioSensorPreparationRequestV1Schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException("invalid BIO preparation request");
    const request = parsed.data;
    return this.prisma.$transaction(async tx => {
      const revision = await lockBioSensorCatalog(tx);
      await this.access.assertCommissionInTransaction(tx, actor, request.siteId);
      const now = new Date(); const binding = await loadBioSensorBinding(tx, request, now);
      const prior = await tx.bioSensorPreparationOperation.findUnique({ where: {
        siteId_actorId_clientRequestId: { siteId: request.siteId, actorId: actor.id, clientRequestId: request.clientRequestId } } });
      if (prior) {
        if (prior.fixtureId !== request.fixtureId || prior.operation !== request.operation || prior.bindingHash !== binding.bindingHash) {
          throw new ConflictException("BIO preparation request identity conflict");
        }
        return this.viewInTransaction(tx, prior, revision, binding.bindingHash);
      }
      const { bindingHash, ...identity } = binding;
      const command = bioSensorPreparationCommandV1Schema.parse({ schemaVersion: 1, ...identity, commandId: randomUUID(),
        operation: request.operation, catalogRevision: Number(revision), requestedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 120_000).toISOString() });
      // Neither query nor ensure inherits a previous checkpoint. A new failure
      // must not leave an earlier ready result visible as current preparation.
      await tx.bioSensorPreparationOperation.updateMany({ where: { fixtureId: request.fixtureId, supersededAt: null }, data: { supersededAt: now } });
      await this.profiles.catalogInTransaction(tx, binding, revision, now);
      const row = await tx.bioSensorPreparationOperation.create({ data: { ...binding, commandId: command.commandId,
        actorId: actor.id, clientRequestId: request.clientRequestId, operation: request.operation, catalogRevision: revision,
        payload: command, payloadHash: canonicalPayloadHash(command), requestedAt: now, expiresAt: new Date(command.expiresAt), nextAttemptAt: now } });
      return preparationView(row, true);
    }, { timeout: 10_000 });
  }

  async get(actor: AuthenticatedUser, commandId: string) {
    if (!z.string().uuid().safeParse(commandId).success) throw new BadRequestException("invalid BIO preparation command ID");
    return this.prisma.$transaction(async tx => {
      const revision = await lockBioSensorCatalog(tx);
      const row = await tx.bioSensorPreparationOperation.findUnique({ where: { commandId } });
      if (!row) throw new NotFoundException("BIO preparation not found");
      await this.access.assertCommissionInTransaction(tx, actor, row.siteId);
      let hash: string | null = null;
      try { hash = (await loadBioSensorBinding(tx, row, new Date())).bindingHash; } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
      }
      return this.viewInTransaction(tx, row, revision, hash);
    });
  }

  /** MQTT subscriber has broker mTLS/topic identity, not a peer serial. Current
   * claim/certificate and binding are rechecked before any replay is revived. */
  async ingestAuthenticated(value: unknown, scope: { siteId: string; gatewayId: string; requireActiveClaim: true }, receivedAt = new Date()) {
    const parsed = bioSensorPreparationReportV1Schema.safeParse(value);
    if (!parsed.success || scope?.requireActiveClaim !== true || parsed.data.siteId !== scope.siteId || parsed.data.gatewayId !== scope.gatewayId) {
      throw new BadRequestException("BIO preparation authenticated scope rejected");
    }
    const report = parsed.data; const hash = canonicalPayloadHash(report);
    return this.prisma.$transaction(async tx => {
      const revision = await lockBioSensorCatalog(tx);
      const binding = await loadBioSensorBinding(tx, report, receivedAt);
      if (binding.gatewayId !== scope.gatewayId || binding.assignmentVersion !== report.assignmentVersion) throw new BadRequestException("BIO preparation current assignment rejected");
      await tx.$queryRaw`SELECT "commandId" FROM "BioSensorPreparationOperation" WHERE "commandId"=${report.commandId} FOR UPDATE`;
      const row = await tx.bioSensorPreparationOperation.findUnique({ where: { commandId: report.commandId } });
      if (!row || !matchesBioSensorPreparationReportV1(row.payload, report, row.payloadHash) || canonicalPayloadHash(row.payload) !== row.payloadHash) {
        throw new BadRequestException("BIO preparation command attribution rejected");
      }
      if (row.resultHash) {
        if (row.resultHash !== hash) throw new ConflictException("BIO preparation immutable result conflict");
        await tx.bioSensorPreparationOperation.update({ where: { commandId: row.commandId }, data: { ackNextAttemptAt: receivedAt, ackPublishedAt: null } });
        return bioSensorPreparationAckV1Schema.parse(row.ackPayload);
      }
      const observedAt = Date.parse(report.observedAt);
      const fresh = !row.supersededAt && row.bindingHash === binding.bindingHash && row.catalogRevision === revision &&
        report.catalogRevision === Number(revision) && receivedAt < row.expiresAt && observedAt >= row.requestedAt.getTime() &&
        observedAt <= row.expiresAt.getTime() && observedAt <= receivedAt.getTime() + 1_000;
      const evidence = hasCurrentBioPreparationEvidence(report, await this.profiles.currentProfiles(tx));
      const accepted = fresh && evidence;
      const ack = bioSensorPreparationAckV1Schema.parse({ schemaVersion: 1, commandId: report.commandId, siteId: report.siteId,
        gatewayId: report.gatewayId, fixtureId: report.fixtureId, nodeId: report.nodeId, assignmentVersion: report.assignmentVersion,
        eventId: report.eventId, reportPayloadHash: hash, status: accepted ? "applied" : fresh ? "rejected" : "stale", occurredAt: receivedAt.toISOString() });
      await tx.bioSensorPreparationOperation.update({ where: { commandId: row.commandId }, data: {
        result: report, resultHash: hash, resultEventId: report.eventId, status: accepted ? report.status : "unverified",
        ackPayload: ack, ackHash: canonicalPayloadHash(ack), ackNextAttemptAt: receivedAt, lockedBy: null, leaseExpiresAt: null } });
      return ack;
    }, { timeout: 10_000 });
  }

  private async viewInTransaction(tx: Prisma.TransactionClient, row: BioSensorPreparationOperation, revision: bigint, bindingHash: string | null) {
    const report = bioSensorPreparationReportV1Schema.safeParse(row.result);
    const current = row.bindingHash === bindingHash && !row.supersededAt && row.catalogRevision === revision &&
      (!report.success || hasCurrentBioPreparationEvidence(report.data, await this.profiles.currentProfiles(tx)));
    return preparationView(row, current);
  }
}

function preparationView(row: BioSensorPreparationOperation, current: boolean) {
  const result = bioSensorPreparationReportV1Schema.safeParse(row.result);
  const pendingExpired = row.status === "pending" && row.expiresAt <= new Date();
  const status = !current ? "unverified" : pendingExpired ? "timed_out" : row.status;
  const ready = status === "ready" && result.success;
  return { commandId: row.commandId, siteId: row.siteId, fixtureId: row.fixtureId, operation: row.operation,
    catalogRevision: Number(row.catalogRevision), status, requestedAt: row.requestedAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    supersededAt: row.supersededAt?.toISOString() ?? null, observedAt: result.success ? result.data.observedAt : null,
    profileKey: result.success ? result.data.profileKey : null, modeVerified: ready && result.data.modeVerified,
    linkVerified: ready && result.data.linkVerified,
    blockReason: !current ? row.supersededAt ? "superseded" : "current_evidence_changed" : pendingExpired ? "request_expired"
      : status === "pending" ? "preparation_pending" : status === "ready" ? null : "preparation_not_ready",
    // Gateway error strings are untrusted. Return bounded symbolic codes only,
    // never arbitrary adapter diagnostics or native payloads in a user response.
    errorCode: result.success && result.data.errorCode !== null ? /^[A-Z][A-Z0-9_]{0,63}$/.test(result.data.errorCode)
      ? result.data.errorCode : "BIO_PREPARATION_FAILED" : null };
}

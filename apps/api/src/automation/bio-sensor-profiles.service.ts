import { BadRequestException, ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { bioSensorCatalogAckV1Schema, bioSensorCatalogV1Schema, bioSensorProfileV1Schema, matchesBioSensorCatalogAckV1,
  type BioSensorProfileV1, type BioSensorCatalogV1 } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { canonicalPayloadHash } from "./automation-payload-hash";
import { lockBioSensorCatalog, lockBioSensorGateway } from "./bio-sensor-catalog-locks";
import { AutomationSnapshotService } from "./automation-snapshot.service";
import { AutomationClock } from "./automation-clock";
import { loadCurrentBioSensorProfiles } from "./bio-sensor-preparation-evidence";

const policySchema = bioSensorCatalogV1Schema.shape.executionPolicy;

@Injectable()
export class BioSensorProfilesService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly snapshots: AutomationSnapshotService = new AutomationSnapshotService(new AutomationClock())) {}

  async list(actor: AuthenticatedUser) {
    return this.prisma.$transaction(async tx => {
      await lockBioSensorCatalog(tx); await this.assertOperator(tx, actor);
      const rows = await tx.bioSensorProfileRevision.findMany({ orderBy: [{ profileId: "asc" }, { revision: "desc" }] });
      // Management summaries never return raw sensor bodies or native identities.
      return rows.map(row => ({ profileId: row.profileId, revision: Number(row.revision), status: row.status,
        evidenceDigest: row.evidenceDigest, reuseScope: row.reuseScope, actorId: row.actorId, createdAt: row.createdAt.toISOString() }));
    });
  }

  async createRevision(actor: AuthenticatedUser, value: unknown) {
    const parsed = bioSensorProfileV1Schema.safeParse(value);
    if (!parsed.success || parsed.data.status !== "approved") throw new BadRequestException("invalid BIO profile revision");
    return this.prisma.$transaction(async tx => {
      await lockBioSensorCatalog(tx); await this.assertOperator(tx, actor);
      await this.appendProfile(tx, parsed.data, actor.id);
      return { profileId: parsed.data.profileId, revision: parsed.data.revision, status: parsed.data.status };
    });
  }

  async revoke(actor: AuthenticatedUser, profileId: string) {
    if (!z.string().uuid().safeParse(profileId).success) throw new BadRequestException("invalid profile ID");
    return this.prisma.$transaction(async tx => {
      await lockBioSensorCatalog(tx); await this.assertOperator(tx, actor);
      const row = await tx.bioSensorProfileRevision.findFirst({ where: { profileId }, orderBy: { revision: "desc" } });
      if (!row) throw new BadRequestException("unknown BIO profile");
      if (row.status === "revoked") return { profileId, revision: Number(row.revision), status: "revoked" };
      const { actorId: _actor, createdAt: _created, ...stored } = row;
      const profile = bioSensorProfileV1Schema.parse({ ...stored, revision: Number(row.revision) });
      // Persist a new revision; never mutate the evidence of a published approval.
      await this.appendProfile(tx, { ...profile, revision: profile.revision + 1, status: "revoked" }, actor.id);
      return { profileId, revision: profile.revision + 1, status: "revoked" };
    });
  }

  async getSitePolicy(actor: AuthenticatedUser, siteId: string) {
    return this.prisma.$transaction(async tx => {
      await lockBioSensorCatalog(tx); await this.access.assertManageInTransaction(tx, actor, siteId);
      const policy = await this.currentPolicy(tx, siteId);
      return { ...policyView(policy), revision: Number(policy?.revision ?? 1n) };
    });
  }

  async setSitePolicy(actor: AuthenticatedUser, siteId: string, value: unknown) {
    const parsed = policySchema.safeParse(value);
    if (!parsed.success || parsed.data.maximumResponseSeconds !== null && parsed.data.maximumResponseSeconds > 2147483647) {
      throw new BadRequestException("invalid BIO site policy");
    }
    return this.prisma.$transaction(async tx => {
      await lockBioSensorCatalog(tx); const site = await this.access.assertManageInTransaction(tx, actor, siteId);
      const policy = parsed.data;
      if (policy.enabled && policy.ownerUserId !== site.adminUserId) throw new BadRequestException("BIO policy owner must be current assigned administrator");
      const state = await this.advance(tx);
      await tx.bioSensorSitePolicy.upsert({ where: { siteId }, create: { siteId, ...policy, revision: state.revision }, update: { ...policy, revision: state.revision } });
      await this.settleOwnedChanges(tx, siteId);
      return { ...policy, revision: Number(state.revision) };
    });
  }

  async currentProfiles(tx: Prisma.TransactionClient): Promise<BioSensorProfileV1[]> {
    return loadCurrentBioSensorProfiles(tx);
  }

  async buildCurrentCatalog(siteId: string, gatewayId: string): Promise<BioSensorCatalogV1> {
    return this.prisma.$transaction(async tx => {
      const revision = await lockBioSensorCatalog(tx); const now = new Date();
      const assignmentVersion = await lockBioSensorGateway(tx, { siteId, gatewayId }, now);
      const scope = { siteId, gatewayId, assignmentVersion };
      const catalog = await this.catalogInTransaction(tx, scope, revision, now);
      await this.materializeConvergence(tx, scope, revision, now);
      return catalog;
    });
  }

  async catalogInTransaction(tx: Prisma.TransactionClient, scope: { siteId: string; gatewayId: string; assignmentVersion: number }, revision: bigint, now: Date) {
    // A narrowed TypeScript type does not strip runtime fixture/topic fields.
    const owner = { siteId: scope.siteId, gatewayId: scope.gatewayId, assignmentVersion: scope.assignmentVersion };
    const identity = { ...owner, catalogRevision: revision };
    const prior = await tx.bioSensorCatalogDelivery.findUnique({ where: { siteId_gatewayId_assignmentVersion_catalogRevision: identity } });
    if (prior) return bioSensorCatalogV1Schema.parse(prior.payload);
    const policy = await this.currentPolicy(tx, scope.siteId);
    const catalog = bioSensorCatalogV1Schema.parse({ schemaVersion: 1, ...owner, eventId: randomUUID(), catalogRevision: Number(revision),
      issuedAt: now.toISOString(), profiles: await this.currentProfiles(tx), executionPolicy: policyView(policy) });
    await tx.bioSensorCatalogDelivery.updateMany({ where: { siteId: scope.siteId, gatewayId: scope.gatewayId, supersededAt: null }, data: { supersededAt: now } });
    await tx.bioSensorCatalogDelivery.create({ data: { ...identity, deliveryId: catalog.eventId, payload: catalog,
      payloadHash: canonicalPayloadHash(catalog), nextAttemptAt: now } });
    return catalog;
  }

  async ingestCatalogAck(value: unknown, scope: { siteId: string; gatewayId: string }) {
    const parsed = bioSensorCatalogAckV1Schema.safeParse(value);
    if (!parsed.success || parsed.data.siteId !== scope.siteId || parsed.data.gatewayId !== scope.gatewayId) throw new BadRequestException("BIO catalog ACK scope rejected");
    const ack = parsed.data;
    return this.prisma.$transaction(async tx => {
      const revision = await lockBioSensorCatalog(tx); const now = new Date();
      const assignment = await lockBioSensorGateway(tx, scope, now);
      const row = await tx.bioSensorCatalogDelivery.findUnique({ where: { deliveryId: ack.eventId } });
      if (!row || row.assignmentVersion !== assignment || row.catalogRevision !== revision || row.supersededAt ||
        !matchesBioSensorCatalogAckV1(row.payload, ack, row.payloadHash) || canonicalPayloadHash(row.payload) !== row.payloadHash) {
        throw new BadRequestException("BIO catalog ACK attribution rejected");
      }
      const hash = canonicalPayloadHash(ack);
      if (row.ackHash) {
        if (row.ackHash !== hash) throw new ConflictException("BIO catalog ACK replay conflict");
        return ack;
      }
      await tx.bioSensorCatalogDelivery.update({ where: { deliveryId: row.deliveryId }, data: { status: ack.status,
        appliedAt: ["applied", "duplicate"].includes(ack.status) ? now : null, ackPayload: ack, ackHash: hash, lockedBy: null, leaseExpiresAt: null } });
      return ack;
    });
  }

  private async assertOperator(tx: Prisma.TransactionClient, actor: AuthenticatedUser) {
    if (actor.role !== "operator" || actor.status !== "active" || actor.organizationType !== "service_provider") throw new ForbiddenException("BIO profile management denied");
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${actor.id} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: actor.id }, include: { organization: true } });
    if (!user || user.organizationId !== actor.organizationId || user.role !== "operator" || user.status !== "active" || user.organization.type !== "service_provider") throw new ForbiddenException("BIO profile management denied");
  }

  private async appendProfile(tx: Prisma.TransactionClient, profile: BioSensorProfileV1, actorId: string) {
    const previous = await tx.bioSensorProfileRevision.findFirst({ where: { profileId: profile.profileId }, orderBy: { revision: "desc" } });
    if (profile.revision !== Number(previous?.revision ?? 0n) + 1) throw new ConflictException("BIO profile revision must append sequentially");
    await tx.bioSensorProfileRevision.create({ data: { ...profile, revision: BigInt(profile.revision), actorId } });
    await this.advance(tx);
    await this.settleOwnedChanges(tx);
  }

  private async currentPolicy(tx: Prisma.TransactionClient, siteId: string) {
    const policy = await tx.bioSensorSitePolicy.findUnique({ where: { siteId } });
    if (!policy?.enabled) return policy;
    const site = await tx.site.findUnique({ where: { id: siteId }, include: { admin: { include: { organization: true } } } });
    const owner = site?.admin;
    return owner?.id === policy.ownerUserId && owner.status === "active" && owner.role === "admin"
      && owner.organizationId === site?.organizationId && owner.organization.type === "customer" ? policy : { ...policy, enabled: false };
  }

  /** Bounded synchronous settlement for owned mutations. Remaining global work
   * is durable and completed by the existing catalog worker, never memory-only. */
  private async settleOwnedChanges(tx: Prisma.TransactionClient, siteId?: string) {
    const revision = (await tx.bioSensorCatalogState.findUniqueOrThrow({ where: { id: 1 } })).revision;
    const gateways = await tx.gateway.findMany({ where: { ...(siteId ? { siteId } : {}), claimedAt: { not: null }, assignmentVersion: { gt: 0 } }, orderBy: { id: "asc" }, take: 10 });
    for (const gateway of gateways) {
      const scope = { siteId: gateway.siteId, gatewayId: gateway.id, assignmentVersion: gateway.assignmentVersion };
      try { await lockBioSensorGateway(tx, scope, new Date()); } catch (error) { if (error instanceof ConflictException) continue; throw error; }
      await this.catalogInTransaction(tx, scope, revision, new Date());
      await this.materializeConvergence(tx, scope, revision, new Date());
    }
  }

  async materializeConvergence(tx: Prisma.TransactionClient, scope: { siteId: string; gatewayId: string; assignmentVersion: number }, revision: bigint, now: Date) {
    const pending = await tx.bioSensorConvergenceWork.findMany({ where: { siteId: scope.siteId, gatewayId: scope.gatewayId,
      assignmentVersion: scope.assignmentVersion, completedAt: null, retiredAt: null } });
    const invalid = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT r."id" FROM "VehicleEventRule" r
      WHERE r."gatewayId"=${scope.gatewayId} AND r."status"='enabled' AND r."sensorProtocol"='bio_usb_pulse'
        AND EXISTS(SELECT 1 FROM "VehicleEventSource" s WHERE s."ruleId"=r."id" AND cardinality(bio_sensor_blocked_reasons(s."fixtureId",(${now}::timestamptz AT TIME ZONE 'UTC')))<>0)`);
    if (invalid.length) await tx.vehicleEventRule.updateMany({ where: { id: { in: invalid.map(row => row.id) } }, data: { status: "disabled" } });
    const current = pending.filter(work => work.catalogRevision === revision);
    if (current.length || invalid.length) await this.snapshots.incrementDesiredRevision(tx, scope.gatewayId);
    // Serializer/outbox and settlement commit together. Old revisions are
    // explicitly retired, not mislabeled completed, with attribution retained.
    for (const work of pending) await tx.bioSensorConvergenceWork.update({ where: { siteId_gatewayId_assignmentVersion_catalogRevision: {
      siteId: work.siteId, gatewayId: work.gatewayId, assignmentVersion: work.assignmentVersion, catalogRevision: work.catalogRevision } },
      data: work.catalogRevision === revision ? { completedAt: now } : { retiredAt: now } });
  }

  async processConvergenceWork(work: { siteId: string; gatewayId: string; assignmentVersion: number; catalogRevision: bigint }) {
    await this.prisma.$transaction(async tx => {
      const revision = await lockBioSensorCatalog(tx); const now = new Date();
      const key = { siteId_gatewayId_assignmentVersion_catalogRevision: work };
      await tx.$queryRaw`SELECT "gatewayId" FROM "BioSensorConvergenceWork" WHERE "siteId"=${work.siteId}
        AND "gatewayId"=${work.gatewayId} AND "assignmentVersion"=${work.assignmentVersion} AND "catalogRevision"=${work.catalogRevision} FOR UPDATE`;
      const row = await tx.bioSensorConvergenceWork.findUnique({ where: key });
      if (!row || row.completedAt || row.retiredAt || row.nextAttemptAt>now) return;
      const gateway = await tx.gateway.findUnique({ where: { id: work.gatewayId } });
      if (!gateway || gateway.siteId!==work.siteId || gateway.assignmentVersion!==work.assignmentVersion || revision!==work.catalogRevision) {
        await tx.bioSensorConvergenceWork.update({ where: key, data: { retiredAt: now } }); return;
      }
      try { await lockBioSensorGateway(tx, work, now); } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
        // A temporary certificate failure is retriable, never successful or
        // obsolete. Defer this row so a bad prefix cannot starve healthy work.
        await tx.bioSensorConvergenceWork.update({ where: key, data: { nextAttemptAt: new Date(now.getTime()+1_000) } }); return;
      }
      await this.catalogInTransaction(tx, work, revision, now);
      await this.materializeConvergence(tx, work, revision, now);
    }, { timeout: 10_000 });
  }

  async sweepUnavailableRules() {
    await this.prisma.$transaction(async tx => {
      const revision = await lockBioSensorCatalog(tx); const now = new Date();
      const invalid = await tx.$queryRaw<Array<{ id: string; gatewayId: string }>>(Prisma.sql`
        SELECT r."id",r."gatewayId" FROM "VehicleEventRule" r WHERE r."status"='enabled' AND r."sensorProtocol"='bio_usb_pulse'
          AND EXISTS(SELECT 1 FROM "VehicleEventSource" s WHERE s."ruleId"=r."id"
            AND cardinality(bio_sensor_blocked_reasons(s."fixtureId",(${now}::timestamptz AT TIME ZONE 'UTC')))<>0)
        ORDER BY r."id" LIMIT 10 FOR UPDATE OF r`);
      if (!invalid.length) return;
      await tx.vehicleEventRule.updateMany({ where: { id: { in: invalid.map(row => row.id) } }, data: { status: "disabled" } });
      for (const gatewayId of new Set(invalid.map(row => row.gatewayId))) {
        const gateway = await tx.gateway.findUniqueOrThrow({ where: { id: gatewayId } });
        const key = { siteId: gateway.siteId, gatewayId, assignmentVersion: gateway.assignmentVersion, catalogRevision: revision };
        // The row is current work state for this scope/revision, not an event
        // history. Natural live expiry can reopen it without changing policy or
        // inventing a new catalog approval. Old scope/revision rows stay intact.
        await tx.bioSensorConvergenceWork.upsert({ where: { siteId_gatewayId_assignmentVersion_catalogRevision: key },
          create: { ...key, requestedAt: now, nextAttemptAt: now }, update: { requestedAt: now, nextAttemptAt: now, completedAt: null, retiredAt: null } });
      }
    });
  }

  private async advance(tx: Prisma.TransactionClient) {
    // Catalog revisions are global. Do not invalidate an immutable cleanup ACK
    // target while a removal or its rollback still owns the registration.
    if (await tx.fixtureRegistrationRemovalOperation.findFirst({ where: { status: { notIn: ["completed", "rejected"] } }, select: { operationId: true } })) {
      throw new ConflictException("registration removal owns catalog convergence");
    }
    return tx.bioSensorCatalogState.update({ where: { id: 1 }, data: { revision: { increment: 1 } } });
  }
}

function policyView(policy: { enabled: boolean; ownerUserId: string | null; maximumResponseSeconds: number | null; escalationAction: string | null } | null) {
  return { enabled: policy?.enabled ?? false, ownerUserId: policy?.ownerUserId ?? null,
    maximumResponseSeconds: policy?.maximumResponseSeconds ?? null, escalationAction: policy?.escalationAction ?? null };
}

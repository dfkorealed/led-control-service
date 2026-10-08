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

const policySchema = bioSensorCatalogV1Schema.shape.executionPolicy;

@Injectable()
export class BioSensorProfilesService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService) {}

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
      const policy = await tx.bioSensorSitePolicy.findUnique({ where: { siteId } });
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
      return { ...policy, revision: Number(state.revision) };
    });
  }

  async currentProfiles(tx: Prisma.TransactionClient): Promise<BioSensorProfileV1[]> {
    const rows = await tx.bioSensorProfileRevision.findMany({ orderBy: [{ profileId: "asc" }, { revision: "desc" }] });
    const selected = new Set<string>();
    return rows.filter(row => { if (selected.has(row.profileId)) return false; selected.add(row.profileId); return true; })
      .map(({ actorId: _a, createdAt: _c, ...row }) => bioSensorProfileV1Schema.parse({ ...row, revision: Number(row.revision) }));
  }

  async buildCurrentCatalog(siteId: string, gatewayId: string): Promise<BioSensorCatalogV1> {
    return this.prisma.$transaction(async tx => {
      const revision = await lockBioSensorCatalog(tx); const now = new Date();
      const assignmentVersion = await lockBioSensorGateway(tx, { siteId, gatewayId }, now);
      return this.catalogInTransaction(tx, { siteId, gatewayId, assignmentVersion }, revision, now);
    });
  }

  async catalogInTransaction(tx: Prisma.TransactionClient, scope: { siteId: string; gatewayId: string; assignmentVersion: number }, revision: bigint, now: Date) {
    // A narrowed TypeScript type does not strip runtime fixture/topic fields.
    const owner = { siteId: scope.siteId, gatewayId: scope.gatewayId, assignmentVersion: scope.assignmentVersion };
    const identity = { ...owner, catalogRevision: revision };
    const prior = await tx.bioSensorCatalogDelivery.findUnique({ where: { siteId_gatewayId_assignmentVersion_catalogRevision: identity } });
    if (prior) return bioSensorCatalogV1Schema.parse(prior.payload);
    const policy = await tx.bioSensorSitePolicy.findUnique({ where: { siteId: scope.siteId } });
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
  }

  private advance(tx: Prisma.TransactionClient) {
    return tx.bioSensorCatalogState.update({ where: { id: 1 }, data: { revision: { increment: 1 } } });
  }
}

function policyView(policy: { enabled: boolean; ownerUserId: string | null; maximumResponseSeconds: number | null; escalationAction: string | null } | null) {
  return { enabled: policy?.enabled ?? false, ownerUserId: policy?.ownerUserId ?? null,
    maximumResponseSeconds: policy?.maximumResponseSeconds ?? null, escalationAction: policy?.escalationAction ?? null };
}

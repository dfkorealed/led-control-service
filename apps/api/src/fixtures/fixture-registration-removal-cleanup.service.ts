import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma, type FixtureRegistrationRemovalOperation } from "@prisma/client";
import { z } from "zod";
import { matchesBioSensorCatalogAckV1 } from "@led-control/shared";
import { BioSensorProfilesService } from "../automation/bio-sensor-profiles.service";
import { lockBioSensorCatalog } from "../automation/bio-sensor-catalog-locks";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import type { FixtureRegistrationRemovalCleanupSnapshot } from "./fixture-registration-removal-policy";

const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const snapshotSchema = z.object({ catalog: z.object({ assignmentVersion: z.number().int().positive(),
  revision: z.number().int().positive().safe(), payloadHash: hash }).strict().nullable(),
  groups: z.array(z.object({ id: z.string().uuid(), configurationVersion: z.number().int().positive(), desiredHash: hash }).strict()) }).strict();

@Injectable()
export class FixtureRegistrationRemovalCleanupService {
  constructor(private readonly profiles: BioSensorProfilesService) {}

  /** Caller holds the membership serializer and canonical removal locks. The
   * immutable snapshot is created once; a later config is never adopted silently. */
  async prepare(tx: Prisma.TransactionClient, row: FixtureRegistrationRemovalOperation, now: Date) {
    if (row.cleanupSnapshot) return snapshotSchema.parse(row.cleanupSnapshot);
    await lockBioSensorCatalog(tx);
    const state = await tx.bioSensorCatalogState.update({ where: { id: 1 }, data: { revision: { increment: 1 } } });
    if (state.revision > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConflictException("catalog revision exhausted");
    await this.profiles.catalogInTransaction(tx, row, state.revision, now);
    const catalog = await tx.bioSensorCatalogDelivery.findUniqueOrThrow({ where: { siteId_gatewayId_assignmentVersion_catalogRevision: {
      siteId: row.siteId, gatewayId: row.gatewayId, assignmentVersion: row.assignmentVersion, catalogRevision: state.revision } } });
    const memberships = await tx.meshControlGroupMember.findMany({ where: { meshNodeId: row.meshNodeId, gatewayId: row.gatewayId },
      include: { group: true }, orderBy: { groupId: "asc" } });
    const groups: FixtureRegistrationRemovalCleanupSnapshot["groups"] = [];
    for (const member of memberships) {
      await tx.meshControlGroupMember.update({ where: { groupId_meshNodeId: { groupId: member.groupId, meshNodeId: row.meshNodeId } },
        data: { desired: false, subscriptionStatus: "pending", statusVersion: 0 } });
      const group = await tx.meshControlGroup.update({ where: { id: member.groupId }, data: {
        configurationVersion: { increment: 1 }, operationPlanVersion: 0, status: "configuring", lastError: null } });
      groups.push({ id: group.id, configurationVersion: group.configurationVersion,
        desiredHash: canonicalPayloadHash(await this.desired(tx, group.id)) });
    }
    const snapshot = snapshotSchema.parse({ catalog: { assignmentVersion: row.assignmentVersion,
      revision: Number(state.revision), payloadHash: catalog.payloadHash }, groups });
    await tx.fixtureRegistrationRemovalOperation.update({ where: { operationId: row.operationId }, data: { cleanupSnapshot: snapshot } });
    return snapshot;
  }

  async isApplied(tx: Prisma.TransactionClient, row: FixtureRegistrationRemovalOperation): Promise<boolean> {
    const parsed = snapshotSchema.safeParse(row.cleanupSnapshot);
    if (!parsed.success) return false;
    const snapshot = parsed.data;
    if (snapshot.catalog) {
      const state = await tx.bioSensorCatalogState.findUniqueOrThrow({ where: { id: 1 } });
      const catalog = await tx.bioSensorCatalogDelivery.findUnique({ where: { siteId_gatewayId_assignmentVersion_catalogRevision: {
        siteId: row.siteId, gatewayId: row.gatewayId, assignmentVersion: snapshot.catalog.assignmentVersion,
        catalogRevision: BigInt(snapshot.catalog.revision) } } });
      if (state.revision !== BigInt(snapshot.catalog.revision) || !catalog || catalog.supersededAt || !catalog.appliedAt ||
        !["applied", "duplicate"].includes(catalog.status) || catalog.payloadHash !== snapshot.catalog.payloadHash ||
        canonicalPayloadHash(catalog.payload) !== snapshot.catalog.payloadHash || !catalog.ackHash || !catalog.ackPayload ||
        canonicalPayloadHash(catalog.ackPayload) !== catalog.ackHash ||
        !matchesBioSensorCatalogAckV1(catalog.payload, catalog.ackPayload, snapshot.catalog.payloadHash)) return false;
    }
    for (const expected of snapshot.groups) {
      const group = await tx.meshControlGroup.findUnique({ where: { id: expected.id } });
      if (!group || group.gatewayId !== row.gatewayId || group.configurationVersion !== expected.configurationVersion ||
        group.operationPlanVersion !== expected.configurationVersion || group.status !== "ready" ||
        canonicalPayloadHash(await this.desired(tx, group.id)) !== expected.desiredHash) return false;
      const pending = await tx.meshControlGroupExpectedOperation.count({ where: { groupId: group.id,
        configurationVersion: expected.configurationVersion, status: { not: "applied" } } });
      if (pending) return false;
      const applied = await tx.meshControlGroupAppliedMember.findMany({ where: { groupId: group.id },
        orderBy: [{ meshNodeId: "asc" }, { meshAddress: "asc" }], select: { meshNodeId: true, meshAddress: true } });
      if (canonicalPayloadHash(applied) !== expected.desiredHash) return false;
    }
    return true;
  }

  private async desired(tx: Prisma.TransactionClient, groupId: string) {
    const members = await tx.meshControlGroupMember.findMany({ where: { groupId, desired: true }, orderBy: { meshNodeId: "asc" },
      select: { meshNodeId: true, meshNode: { select: { meshAddress: true } } } });
    return members.map(member => ({ meshNodeId: member.meshNodeId, meshAddress: member.meshNode.meshAddress.toLowerCase() }));
  }
}

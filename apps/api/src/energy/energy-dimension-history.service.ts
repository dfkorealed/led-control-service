import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

type Transaction = Prisma.TransactionClient;

export interface FixtureDimensionInput {
  fixtureId: string;
  siteId: string;
  name: string;
  floorId: string;
  floorName: string;
  ratedWatt: Prisma.Decimal;
  trackingStartedAt: Date;
  effectiveAt: Date;
}

@Injectable()
export class EnergyDimensionHistoryService {
  async recordFixtureDimensions(tx: Transaction, input: FixtureDimensionInput): Promise<string> {
    await advisoryLock(tx, `energy-fixture:${input.fixtureId}`);
    let identity = await tx.energyFixtureIdentity.findUnique({ where: { fixtureId: input.fixtureId } });
    if (!identity) {
      identity = await tx.energyFixtureIdentity.create({
        data: {
          fixtureId: input.fixtureId,
          siteId: input.siteId,
          trackingStartedAt: input.trackingStartedAt
        }
      });
    }

    const current = await tx.energyFixtureDimensionVersion.findFirst({
      where: { energyFixtureId: identity.id, effectiveTo: null },
      orderBy: { effectiveFrom: "desc" }
    });
    if (current && sameFixtureDimension(current, input)) return identity.id;
    if (current) {
      await tx.energyFixtureDimensionVersion.update({ where: { id: current.id }, data: { effectiveTo: input.effectiveAt } });
    }
    await tx.energyFixtureDimensionVersion.create({
      data: {
        energyFixtureId: identity.id,
        name: input.name,
        floorId: input.floorId,
        floorName: input.floorName,
        ratedWatt: input.ratedWatt,
        effectiveFrom: input.effectiveAt
      }
    });
    return identity.id;
  }

  async recordGroupDimensions(tx: Transaction, input: {
    groupId: string;
    siteId: string;
    name: string;
    fixtureIds: string[];
    effectiveAt: Date;
  }): Promise<string> {
    await advisoryLock(tx, `energy-group:${input.groupId}`);
    let identity = await tx.energyGroupIdentity.findUnique({ where: { groupId: input.groupId } });
    if (!identity) {
      identity = await tx.energyGroupIdentity.create({
        data: { groupId: input.groupId, siteId: input.siteId, trackingStartedAt: input.effectiveAt }
      });
    }
    const current = await tx.energyGroupDimensionVersion.findFirst({
      where: { energyGroupId: identity.id, effectiveTo: null }, orderBy: { effectiveFrom: "desc" }
    });
    if (!current || current.name !== input.name) {
      if (current) {
        await tx.energyGroupDimensionVersion.update({ where: { id: current.id }, data: { effectiveTo: input.effectiveAt } });
      }
      await tx.energyGroupDimensionVersion.create({
        data: { energyGroupId: identity.id, name: input.name, effectiveFrom: input.effectiveAt }
      });
    }
    await this.replaceGroupMemberships(tx, {
      groupId: input.groupId,
      fixtureIds: input.fixtureIds,
      effectiveAt: input.effectiveAt,
      energyGroupId: identity.id
    });
    return identity.id;
  }

  async replaceGroupMemberships(tx: Transaction, input: {
    groupId: string;
    fixtureIds: string[];
    effectiveAt: Date;
    energyGroupId?: string;
  }) {
    const identity = input.energyGroupId
      ? { id: input.energyGroupId }
      : await tx.energyGroupIdentity.findUnique({ where: { groupId: input.groupId } });
    if (!identity) throw new Error("energy group identity is missing");

    const fixtureIdentities = await tx.energyFixtureIdentity.findMany({
      where: { fixtureId: { in: input.fixtureIds } }, select: { id: true, fixtureId: true }
    });
    const identityByFixtureId = new Map(fixtureIdentities.map((item) => [item.fixtureId, item.id]));
    if (input.fixtureIds.some((fixtureId) => !identityByFixtureId.has(fixtureId))) {
      throw new Error("energy fixture identity is missing");
    }
    const wantedIds = new Set(input.fixtureIds.map((fixtureId) => identityByFixtureId.get(fixtureId)!));
    const open = await tx.energyGroupMembershipVersion.findMany({
      where: { energyGroupId: identity.id, effectiveTo: null }
    });
    const openIds = new Set(open.map((item) => item.energyFixtureId));
    for (const membership of open) {
      if (!wantedIds.has(membership.energyFixtureId)) {
        await tx.energyGroupMembershipVersion.update({
          where: { id: membership.id }, data: { effectiveTo: input.effectiveAt }
        });
      }
    }
    for (const energyFixtureId of [...wantedIds].sort()) {
      if (!openIds.has(energyFixtureId)) {
        await tx.energyGroupMembershipVersion.create({
          data: { energyGroupId: identity.id, energyFixtureId, effectiveFrom: input.effectiveAt }
        });
      }
    }
  }

  async retireGroup(tx: Transaction, groupId: string, retiredAt: Date) {
    const identity = await tx.energyGroupIdentity.findUnique({ where: { groupId } });
    if (!identity) return;
    await tx.energyGroupMembershipVersion.updateMany({
      where: { energyGroupId: identity.id, effectiveTo: null }, data: { effectiveTo: retiredAt }
    });
    await tx.energyGroupDimensionVersion.updateMany({
      where: { energyGroupId: identity.id, effectiveTo: null }, data: { effectiveTo: retiredAt }
    });
    await tx.energyGroupIdentity.update({ where: { id: identity.id }, data: { retiredAt } });
  }

  async retireFixture(tx: Transaction, fixtureId: string, retiredAt: Date) {
    const identity = await tx.energyFixtureIdentity.findUnique({ where: { fixtureId } });
    if (!identity) return;
    await tx.energyFixtureDimensionVersion.updateMany({
      where: { energyFixtureId: identity.id, effectiveTo: null }, data: { effectiveTo: retiredAt }
    });
    await tx.energyGroupMembershipVersion.updateMany({
      where: { energyFixtureId: identity.id, effectiveTo: null }, data: { effectiveTo: retiredAt }
    });
    await tx.energyFixtureIdentity.update({ where: { id: identity.id }, data: { retiredAt } });
  }
}

function sameFixtureDimension(
  current: { name: string; floorId: string; floorName: string; ratedWatt: Prisma.Decimal },
  input: FixtureDimensionInput
) {
  return current.name === input.name && current.floorId === input.floorId && current.floorName === input.floorName &&
    new Prisma.Decimal(current.ratedWatt).equals(input.ratedWatt);
}

function advisoryLock(tx: Transaction, key: string) {
  return tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

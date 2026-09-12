import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  energyHeatmapQuerySchema,
  energyHeatmapResponseSchema,
  type EnergyHeatmapMetric,
  type EnergyHeatmapResponse,
  type EnergyScope
} from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

type HourlyAggregate = {
  bucketStartUtc: Date;
  localDate: Date;
  localHour: number;
  estimatedKwh: Prisma.Decimal;
  knownSeconds: number;
  brightnessWeightedSeconds: Prisma.Decimal;
};

type EffectiveRange = {
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

type FixtureIdentity = {
  id: string;
  trackingStartedAt: Date;
  retiredAt: Date | null;
  hourlyAggregates: HourlyAggregate[];
  dimensionVersions: Array<EffectiveRange & { floorId: string }>;
  groupMemberships: Array<EffectiveRange & {
    energyGroupId: string;
    energyGroup: { trackingStartedAt: Date; retiredAt: Date | null; dimensionVersions: EffectiveRange[] };
  }>;
};

type HeatmapTotals = {
  estimatedKwh: Prisma.Decimal;
  knownSeconds: number;
  brightnessWeightedSeconds: Prisma.Decimal;
};

@Injectable()
export class EnergyHeatmapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService
  ) {}

  async getHeatmap(user: AuthenticatedUser, siteId: string, rawQuery: unknown): Promise<EnergyHeatmapResponse> {
    const parsed = energyHeatmapQuerySchema.safeParse(rawQuery);
    if (!parsed.success) throw new BadRequestException("invalid energy heatmap query");
    const query = parsed.data;

    await this.siteAccess.assert(user, siteId, "read");
    const site = await this.prisma.site.findUniqueOrThrow({
      where: { id: siteId }, select: { id: true, timeZone: true }
    });
    await this.assertScopeExists(siteId, query.scope, query.identityId);
    const identities = await this.loadIdentities(siteId, query.from, query.to);
    const cells = aggregateHeatmapCells(identities, query.scope, query.identityId, query.metric, site.timeZone);

    return energyHeatmapResponseSchema.parse({
      siteId,
      timeZone: site.timeZone,
      generatedAt: new Date().toISOString(),
      metric: query.metric,
      scope: query.scope,
      identityId: query.identityId,
      range: { from: query.from, to: query.to },
      cells
    });
  }

  private async assertScopeExists(siteId: string, scope: EnergyScope, identityId: string) {
    if (scope === "site") {
      if (identityId !== siteId) throw new NotFoundException("energy scope not found");
      return;
    }
    if (scope === "fixture") {
      const identity = await this.prisma.energyFixtureIdentity.findFirst({
        where: { id: identityId, siteId }, select: { id: true }
      });
      if (!identity) throw new NotFoundException("energy scope not found");
      return;
    }
    if (scope === "floor") {
      const floor = await this.prisma.floor.findFirst({ where: { id: identityId, siteId }, select: { id: true } });
      if (!floor) throw new NotFoundException("energy scope not found");
      return;
    }
    const group = await this.prisma.energyGroupIdentity.findFirst({
      where: { id: identityId, siteId }, select: { id: true }
    });
    if (!group) throw new NotFoundException("energy scope not found");
  }

  private async loadIdentities(siteId: string, from: string, to: string): Promise<FixtureIdentity[]> {
    return this.prisma.energyFixtureIdentity.findMany({
      where: { siteId },
      select: {
        id: true,
        trackingStartedAt: true,
        retiredAt: true,
        hourlyAggregates: {
          where: {
            localDate: {
              gte: new Date(`${from}T00:00:00.000Z`),
              lte: new Date(`${to}T00:00:00.000Z`)
            }
          },
          select: {
            bucketStartUtc: true,
            localDate: true,
            localHour: true,
            estimatedKwh: true,
            knownSeconds: true,
            brightnessWeightedSeconds: true
          }
        },
        dimensionVersions: { select: { floorId: true, effectiveFrom: true, effectiveTo: true } },
        groupMemberships: {
          select: {
            energyGroupId: true,
            effectiveFrom: true,
            effectiveTo: true,
            energyGroup: {
              select: {
                trackingStartedAt: true,
                retiredAt: true,
                dimensionVersions: { select: { effectiveFrom: true, effectiveTo: true } }
              }
            }
          }
        }
      }
    }) as unknown as Promise<FixtureIdentity[]>;
  }
}

export function aggregateHeatmapCells(
  identities: FixtureIdentity[],
  scope: EnergyScope,
  identityId: string,
  metric: EnergyHeatmapMetric,
  _timeZone: string
) {
  const totals = Array.from({ length: 168 }, (): HeatmapTotals => ({
    estimatedKwh: new Prisma.Decimal(0), knownSeconds: 0, brightnessWeightedSeconds: new Prisma.Decimal(0)
  }));

  for (const identity of identities) {
    for (const aggregate of identity.hourlyAggregates) {
      if (!belongsToScope(identity, aggregate.bucketStartUtc, scope, identityId)) continue;
      const index = aggregate.localDate.getUTCDay() * 24 + aggregate.localHour;
      const cell = totals[index];
      cell.estimatedKwh = cell.estimatedKwh.add(aggregate.estimatedKwh);
      cell.knownSeconds += aggregate.knownSeconds;
      cell.brightnessWeightedSeconds = cell.brightnessWeightedSeconds.add(aggregate.brightnessWeightedSeconds);
    }
  }

  return totals.map((total, index) => ({
    weekday: Math.floor(index / 24),
    hour: index % 24,
    value: heatmapValue(total, metric)
  }));
}

function belongsToScope(
  identity: FixtureIdentity,
  bucketStartUtc: Date,
  scope: EnergyScope,
  identityId: string
) {
  if (scope === "site") return true;
  if (scope === "fixture") return identity.id === identityId;
  const end = new Date(bucketStartUtc.getTime() + 3_600_000);
  if (!coversInterval({ effectiveFrom: identity.trackingStartedAt, effectiveTo: identity.retiredAt }, bucketStartUtc, end)) return false;
  if (scope === "floor") {
    const versions = identity.dimensionVersions.filter(version => overlapsInterval(version, bucketStartUtc, end));
    return versions.length === 1 && versions[0].floorId === identityId && coversInterval(versions[0], bucketStartUtc, end);
  }
  return identity.groupMemberships.some((membership) =>
    membership.energyGroupId === identityId &&
    coversInterval(membership, bucketStartUtc, end) &&
    coversInterval({ effectiveFrom: membership.energyGroup.trackingStartedAt, effectiveTo: membership.energyGroup.retiredAt }, bucketStartUtc, end) &&
    membership.energyGroup.dimensionVersions.some((version) => coversInterval(version, bucketStartUtc, end))
  );
}

/** Totals have no sub-interval provenance: never divide a bucket across a history boundary. */
export function coversInterval(value: EffectiveRange, from: Date, to: Date) {
  return value.effectiveFrom <= from && (value.effectiveTo === null || value.effectiveTo >= to);
}
export function overlapsInterval(value: EffectiveRange, from: Date, to: Date) {
  return value.effectiveFrom < to && (value.effectiveTo === null || value.effectiveTo > from);
}

function heatmapValue(total: HeatmapTotals, metric: EnergyHeatmapMetric) {
  if (total.knownSeconds === 0) return null;
  const value = metric === "energy"
    ? total.estimatedKwh.toNumber()
    : total.brightnessWeightedSeconds.div(total.knownSeconds).toNumber();
  return round(value, metric === "energy" ? 4 : 2);
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

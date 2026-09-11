import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  energyRankingQuerySchema,
  energyRankingResponseSchema,
  type EnergyRankingDimension,
  type EnergyRankingMetric,
  type EnergyRankingQuery,
  type EnergyRankingResponse
} from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

const MIN_COVERAGE = 0.8;
const SOURCE = "state_based_estimate" as const;
const DAY_MS = 86_400_000;

type Aggregate = {
  localDate: Date;
  estimatedKwh: Prisma.Decimal;
  estimatedCost: Prisma.Decimal;
  knownSeconds: number;
  unknownSeconds: number;
};

type FixtureIdentity = {
  id: string;
  fixtureId: string | null;
  trackingStartedAt: Date;
  retiredAt: Date | null;
  dimensionVersions: Array<{
    name: string;
    floorId: string;
    floorName: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  }>;
  dailyAggregates: Aggregate[];
};

type Entity = {
  identityId: string;
  operationalId: string | null;
  name: string;
  fixtureIds: Set<string>;
  fixtureNames: Map<string, string>;
  current: Totals;
  previous: Totals;
  daily: Map<string, Totals>;
  historyQuality: "observed" | "legacy_structure_unknown";
};

type Totals = {
  kwh: Prisma.Decimal;
  cost: Prisma.Decimal;
  known: number;
  unknown: number;
  fixtures: Map<string, Prisma.Decimal>;
};

@Injectable()
export class EnergyRankingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService
  ) {}

  async getRankings(user: AuthenticatedUser, siteId: string, rawQuery: unknown): Promise<EnergyRankingResponse> {
    const parsed = energyRankingQuerySchema.safeParse(rawQuery);
    if (!parsed.success) throw new BadRequestException("invalid energy ranking query");
    const query = parsed.data;
    await this.siteAccess.assert(user, siteId, "read");
    const site = await this.prisma.site.findUniqueOrThrow({
      where: { id: siteId }, select: { timeZone: true, tariffKwhRate: true }
    });

    const range = dateRange(query.from, query.to);
    const identities = await this.prisma.energyFixtureIdentity.findMany({
      where: { siteId },
      include: {
        dimensionVersions: { orderBy: { effectiveFrom: "asc" } },
        dailyAggregates: {
          where: { localDate: { gte: range.previousFrom, lte: range.to } },
          orderBy: { localDate: "asc" }
        }
      },
      orderBy: { id: "asc" }
    }) as FixtureIdentity[];
    const groups = query.dimension === "group"
      ? await this.prisma.energyGroupIdentity.findMany({
          where: { siteId },
          include: {
            dimensionVersions: { orderBy: { effectiveFrom: "asc" } },
            memberships: { orderBy: { effectiveFrom: "asc" } }
          },
          orderBy: { id: "asc" }
        })
      : [];

    const entities = buildEntities(query.dimension, identities, groups, range, site.timeZone);
    const siteTotals = sumSiteTotals(identities, range.from, range.to);
    const previousSiteTotals = sumSiteTotals(identities, range.previousFrom, range.previousTo);
    const rankedCandidates = [...entities.values()].filter((entity) => rankable(entity.current, entity.historyQuality));
    const previousRank = rankMap(rankedCandidates, query.metric, previousSiteTotals.kwh, "previous", query.sort);
    const sorted = sortEntities(rankedCandidates, query.metric, siteTotals.kwh, "current", query.sort);
    const ranked = sorted.slice(0, query.limit).map((entity, index) =>
      serializeEntity(entity, query, siteTotals.kwh, previousSiteTotals.kwh, index + 1, previousRank, range)
    );
    const unranked = [...entities.values()]
      .filter((entity) => !rankable(entity.current, entity.historyQuality))
      .sort((left, right) => left.name.localeCompare(right.name) || left.identityId.localeCompare(right.identityId))
      .slice(0, 1_000)
      .map((entity) => serializeEntity(entity, query, siteTotals.kwh, previousSiteTotals.kwh, null, previousRank, range));
    const legacyCutoffs = identities
      .filter((identity) => hasPreHistoryAggregate(identity, range.from, range.to, site.timeZone))
      .map((identity) => localDateKey(identity.trackingStartedAt, site.timeZone))
      .sort();
    const legacyExcludedBefore = legacyCutoffs[0] ?? null;

    return energyRankingResponseSchema.parse({
      siteId,
      timeZone: site.timeZone,
      source: SOURCE,
      generatedAt: new Date().toISOString(),
      dimension: query.dimension,
      metric: query.metric,
      sort: query.sort,
      range: { from: query.from, to: query.to },
      siteTotalKwh: round(siteTotals.kwh, 4),
      siteTotalCost: round(siteTotals.cost, 2),
      overlappingMemberships: query.dimension === "group",
      legacyExcludedBefore,
      ranked,
      unranked
    });
  }
}

function buildEntities(
  dimension: EnergyRankingDimension,
  identities: FixtureIdentity[],
  groups: any[],
  range: ReturnType<typeof dateRange>,
  timeZone: string
) {
  const entities = new Map<string, Entity>();
  if (dimension === "group") {
    for (const group of groups) {
      const latest = group.dimensionVersions.at(-1);
      if (!latest) continue;
      const target = entity(group.id, group.groupId, latest.name);
      const trackingKey = localDateKey(group.trackingStartedAt ?? latest.effectiveFrom, timeZone);
      if (identities.some((identity) => identity.dailyAggregates.some((aggregate) =>
        aggregate.localDate >= range.from && aggregate.localDate <= range.to && formatDate(aggregate.localDate) < trackingKey
      ))) target.historyQuality = "legacy_structure_unknown";
      entities.set(group.id, target);
    }
  }

  for (const identity of identities) {
    const latest = identity.dimensionVersions.at(-1);
    if (!latest) continue;
    const fixtureName = latest.name;
    const legacy = hasPreHistoryAggregate(identity, range.from, range.to, timeZone);
    if (dimension === "fixture") {
      const target = getEntity(entities, identity.id, identity.fixtureId, fixtureName);
      addIdentity(target, identity, fixtureName, range, legacy);
      continue;
    }
    if (dimension === "floor") {
      for (const aggregate of identity.dailyAggregates) {
        const version = versionAt(identity.dimensionVersions, aggregate.localDate, timeZone) ?? latest;
        const target = getEntity(entities, version.floorId, version.floorId, version.floorName);
        addAggregateToRange(target, identity, fixtureName, aggregate, range, legacy);
      }
      if (identity.dailyAggregates.length === 0) {
        getEntity(entities, latest.floorId, latest.floorId, latest.floorName).fixtureIds.add(identity.id);
      }
      continue;
    }
    for (const group of groups) {
      const target = entities.get(group.id);
      if (!target) continue;
      const memberships = group.memberships.filter((membership: any) => membership.energyFixtureId === identity.id);
      for (const aggregate of identity.dailyAggregates) {
        if (memberships.some((membership: any) => activeOn(membership, aggregate.localDate, timeZone))) {
          addAggregateToRange(target, identity, fixtureName, aggregate, range, legacy);
        }
      }
    }
  }
  return entities;
}

function addIdentity(target: Entity, identity: FixtureIdentity, fixtureName: string, range: ReturnType<typeof dateRange>, legacy: boolean) {
  target.fixtureIds.add(identity.id);
  target.fixtureNames.set(identity.id, fixtureName);
  if (legacy) target.historyQuality = "legacy_structure_unknown";
  for (const aggregate of identity.dailyAggregates) addAggregate(target, identity.id, aggregate, range);
}

function addAggregateToRange(
  target: Entity,
  identity: FixtureIdentity,
  fixtureName: string,
  aggregate: Aggregate,
  range: ReturnType<typeof dateRange>,
  legacy: boolean
) {
  target.fixtureIds.add(identity.id);
  target.fixtureNames.set(identity.id, fixtureName);
  if (legacy) target.historyQuality = "legacy_structure_unknown";
  addAggregate(target, identity.id, aggregate, range);
}

function addAggregate(target: Entity, fixtureIdentityId: string, aggregate: Aggregate, range: ReturnType<typeof dateRange>) {
  const key = formatDate(aggregate.localDate);
  const bucket = aggregate.localDate >= range.from && aggregate.localDate <= range.to
    ? target.current
    : aggregate.localDate >= range.previousFrom && aggregate.localDate <= range.previousTo
      ? target.previous
      : null;
  if (!bucket) return;
  addTotals(bucket, aggregate, fixtureIdentityId);
  if (bucket === target.current) {
    const day = target.daily.get(key) ?? totals();
    addTotals(day, aggregate, fixtureIdentityId);
    target.daily.set(key, day);
  }
}

function serializeEntity(
  entity: Entity,
  query: EnergyRankingQuery,
  siteKwh: Prisma.Decimal,
  previousSiteKwh: Prisma.Decimal,
  rank: number | null,
  previousRanks: Map<string, number>,
  range: ReturnType<typeof dateRange>
) {
  const eligible = rank !== null;
  const currentMetric = metricValue(entity, query.metric, siteKwh, "current");
  const previousMetric = metricValue(entity, query.metric, previousSiteKwh, "previous");
  const previousKwh = hasKnown(entity.previous) ? round(entity.previous.kwh, 4) : null;
  const currentKwh = hasKnown(entity.current) ? round(entity.current.kwh, 4) : null;
  return {
    identityId: entity.identityId,
    operationalId: entity.operationalId,
    name: entity.name,
    rank,
    fixtureCount: entity.fixtureIds.size,
    estimatedKwh: currentKwh,
    estimatedCost: hasKnown(entity.current) ? round(entity.current.cost, 2) : null,
    contributionRate: hasKnown(entity.current) && !siteKwh.isZero() ? round(entity.current.kwh.div(siteKwh), 4) : null,
    perFixtureAverageKwh: hasKnown(entity.current) && entity.fixtureIds.size > 0
      ? round(entity.current.kwh.div(entity.fixtureIds.size), 4) : null,
    metricValue: eligible ? roundNumber(currentMetric, query.metric === "contribution" ? 4 : query.metric === "cost" ? 2 : 4) : null,
    knownSeconds: entity.current.known,
    unknownSeconds: entity.current.unknown,
    coverageRate: coverage(entity.current),
    dataStatus: dataStatus(entity.current),
    historyQuality: entity.historyQuality,
    unrankedReason: eligible ? null : entity.historyQuality === "legacy_structure_unknown"
      ? "legacy_structure_unknown" : "insufficient_coverage",
    previousPeriod: hasKnown(entity.previous) ? {
      estimatedKwh: previousKwh,
      changeRatePercent: previousKwh && previousKwh !== 0 && currentKwh !== null
        ? roundNumber(((currentKwh - previousKwh) / previousKwh) * 100, 2) : null,
      rank: previousMetric === null ? null : previousRanks.get(entity.identityId) ?? null
    } : null,
    dailyPoints: days(range.from, range.to).map((period) => {
      const value = entity.daily.get(period);
      return { period, estimatedKwh: value && hasKnown(value) ? round(value.kwh, 4) : null, dataStatus: value ? dataStatus(value) : "no_data" };
    }),
    fixtures: [...entity.fixtureIds].sort().map((identityId) => ({
      identityId,
      name: entity.fixtureNames.get(identityId) ?? entity.name,
      estimatedKwh: entity.current.fixtures.has(identityId) ? round(entity.current.fixtures.get(identityId)!, 4) : null
    }))
  };
}

function dateRange(from: string, to: string) {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  return {
    from: start,
    to: end,
    previousFrom: new Date(start.getTime() - days * DAY_MS),
    previousTo: new Date(start.getTime() - DAY_MS)
  };
}

function entity(identityId: string, operationalId: string | null, name: string): Entity {
  return {
    identityId, operationalId, name, fixtureIds: new Set(), fixtureNames: new Map(),
    current: totals(), previous: totals(), daily: new Map(), historyQuality: "observed"
  };
}

function getEntity(map: Map<string, Entity>, id: string, operationalId: string | null, name: string) {
  const current = map.get(id);
  if (current) return current;
  const created = entity(id, operationalId, name);
  map.set(id, created);
  return created;
}

function totals(): Totals {
  return { kwh: new Prisma.Decimal(0), cost: new Prisma.Decimal(0), known: 0, unknown: 0, fixtures: new Map() };
}

function addTotals(target: Totals, aggregate: Aggregate, fixtureIdentityId: string) {
  target.kwh = target.kwh.add(aggregate.estimatedKwh);
  target.cost = target.cost.add(aggregate.estimatedCost);
  target.known += aggregate.knownSeconds;
  target.unknown += aggregate.unknownSeconds;
  target.fixtures.set(
    fixtureIdentityId,
    (target.fixtures.get(fixtureIdentityId) ?? new Prisma.Decimal(0)).add(aggregate.estimatedKwh)
  );
}

function sumSiteTotals(identities: FixtureIdentity[], from: Date, to: Date) {
  const result = totals();
  for (const identity of identities) {
    for (const aggregate of identity.dailyAggregates) {
      if (aggregate.localDate >= from && aggregate.localDate <= to) addTotals(result, aggregate, identity.id);
    }
  }
  return result;
}

function rankable(value: Totals, history: Entity["historyQuality"]) {
  return history === "observed" && hasKnown(value) && (coverage(value) ?? 0) >= MIN_COVERAGE;
}

function hasKnown(value: Totals) { return value.known > 0; }

function coverage(value: Totals) {
  const total = value.known + value.unknown;
  return total === 0 ? null : roundNumber(value.known / total, 4);
}

function dataStatus(value: Totals) {
  if (value.known === 0 && value.unknown === 0) return "no_data" as const;
  if (value.unknown > 0) return "partial" as const;
  return "available" as const;
}

function metricValue(
  entity: Entity,
  metric: EnergyRankingMetric,
  siteKwh: Prisma.Decimal,
  period: "current" | "previous"
): number | null {
  const value = entity[period];
  if (!hasKnown(value)) return null;
  if (metric === "usage") return value.kwh.toNumber();
  if (metric === "cost") return value.cost.toNumber();
  if (metric === "contribution") return siteKwh.isZero() ? null : value.kwh.div(siteKwh).toNumber();
  return entity.fixtureIds.size === 0 ? null : value.kwh.div(entity.fixtureIds.size).toNumber();
}

function sortEntities(entities: Entity[], metric: EnergyRankingMetric, siteKwh: Prisma.Decimal, period: "current" | "previous", sort: "asc" | "desc") {
  const direction = sort === "desc" ? -1 : 1;
  return [...entities].sort((left, right) => {
    const a = metricValue(left, metric, siteKwh, period) ?? 0;
    const b = metricValue(right, metric, siteKwh, period) ?? 0;
    return a === b ? left.identityId.localeCompare(right.identityId) : (a - b) * direction;
  });
}

function rankMap(entities: Entity[], metric: EnergyRankingMetric, siteKwh: Prisma.Decimal, period: "previous", sort: "asc" | "desc") {
  return new Map(sortEntities(entities.filter((entity) => rankable(entity.previous, entity.historyQuality)), metric, siteKwh, period, sort)
    .map((entity, index) => [entity.identityId, index + 1]));
}

function versionAt(versions: FixtureIdentity["dimensionVersions"], localDate: Date, timeZone: string) {
  const key = formatDate(localDate);
  return versions.find((version) => {
    const from = localDateKey(version.effectiveFrom, timeZone);
    const to = version.effectiveTo ? localDateKey(version.effectiveTo, timeZone) : null;
    return key >= from && (to === null || key < to);
  });
}

function activeOn(version: { effectiveFrom: Date; effectiveTo: Date | null }, localDate: Date, timeZone: string) {
  const key = formatDate(localDate);
  const from = localDateKey(version.effectiveFrom, timeZone);
  const to = version.effectiveTo ? localDateKey(version.effectiveTo, timeZone) : null;
  return key >= from && (to === null || key < to);
}

function hasPreHistoryAggregate(identity: FixtureIdentity, from: Date, to: Date, timeZone: string) {
  const trackingKey = localDateKey(identity.trackingStartedAt, timeZone);
  return identity.dailyAggregates.some((aggregate) =>
    aggregate.localDate >= from && aggregate.localDate <= to && formatDate(aggregate.localDate) < trackingKey
  );
}

function localDateKey(value: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(value).filter((part) => ["year", "month", "day"].includes(part.type)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatDate(value: Date) { return value.toISOString().slice(0, 10); }

function days(from: Date, to: Date) {
  const result: string[] = [];
  for (let cursor = from.getTime(); cursor <= to.getTime(); cursor += DAY_MS) result.push(formatDate(new Date(cursor)));
  return result;
}

function round(value: Prisma.Decimal, digits: number) { return roundNumber(value.toNumber(), digits); }
function roundNumber(value: number | null, digits: number) {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

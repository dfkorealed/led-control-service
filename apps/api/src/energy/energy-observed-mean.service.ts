import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  energyObservedMeanQuerySchema,
  energyObservedMeanResponseSchema,
  type EnergyObservedMeanResponse,
  type EnergyScope
} from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { addCalendarDays, formatCalendarDate, listDaysInclusive, localDateAt, parseCalendarDate, startOfLocalDate } from "./energy-periods";

interface ObservedMeanRow {
  weekday: number;
  hour: number;
  estimatedKwh: Prisma.Decimal;
  brightnessWeightedSeconds: Prisma.Decimal;
  knownSeconds: bigint;
  unknownSeconds: bigint;
  expectedSeconds: bigint;
  observedLocalDays: bigint;
  eligibleLocalDays: bigint;
  fullyObserved: boolean;
}

@Injectable()
export class EnergyObservedMeanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService
  ) {}

  async getObservedMean(user: AuthenticatedUser, siteId: string, rawQuery: unknown): Promise<EnergyObservedMeanResponse> {
    await this.siteAccess.assert(user, siteId, "read");
    const parsed = energyObservedMeanQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new BadRequestException("invalid energy observed mean query");
    }
    const query = parsed.data;
    const site = await this.prisma.site.findUniqueOrThrow({
      where: { id: siteId }, select: { id: true, timeZone: true }
    });
    try {
      parseCalendarDate(query.from);
      parseCalendarDate(query.to);
    } catch {
      throw new BadRequestException("invalid energy observed mean date");
    }
    const generatedAt = new Date();
    if (query.to >= formatCalendarDate(localDateAt(generatedAt, site.timeZone))) {
      throw new BadRequestException("energy observed mean requires completed local dates");
    }
    await this.assertScopeExists(siteId, query.scope, query.identityId);

    const days = listDaysInclusive(parseCalendarDate(query.from), parseCalendarDate(query.to), 400);
    const boundaries = [...days, addCalendarDays(days[days.length - 1], 1)]
      .map((day) => startOfLocalDate(day, site.timeZone));
    // Stored hourly facts cannot be split at a local midnight falling inside a
    // UTC hour. Until sub-hour provenance exists, reject the whole range rather
    // than report misleading completion or assign energy to the wrong date.
    if (boundaries.some((boundary) => boundary.getTime() % 3_600_000 !== 0)) {
      throw new UnprocessableEntityException({ code: "energy_observed_mean_unavailable",
        message: "observed mean is unavailable for this site time range" });
    }
    const start = boundaries[0];
    const end = boundaries[boundaries.length - 1];
    const firstBucket = new Date(Math.floor(start.getTime() / 3_600_000) * 3_600_000);
    const lastBucket = new Date(Math.floor((end.getTime() - 1) / 3_600_000) * 3_600_000);
    const rows = await this.prisma.$queryRaw<ObservedMeanRow[]>(buildObservedMeanQuery({
      siteId, scope: query.scope, identityId: query.identityId, timeZone: site.timeZone,
      from: query.from, to: query.to, firstBucket, lastBucket
    }));
    const byCell = new Map(rows.map((row) => [row.weekday * 24 + row.hour, row]));
    const cells = Array.from({ length: 168 }, (_, index) => {
      const row = byCell.get(index);
      const knownSeconds = row ? Number(row.knownSeconds) : 0;
      const expectedSeconds = row ? Number(row.expectedSeconds) : 0;
      const eligibleLocalDays = row ? Number(row.eligibleLocalDays) : 0;
      const complete = row?.fullyObserved === true && knownSeconds === expectedSeconds &&
        Number(row.unknownSeconds) === 0 && expectedSeconds > 0 && eligibleLocalDays > 0;
      const value = complete
        ? round(row!.estimatedKwh.div(eligibleLocalDays).toNumber(), 4)
        : null;
      const brightness = complete
        ? round(row!.brightnessWeightedSeconds.div(knownSeconds).toNumber(), 2)
        : null;
      return {
        weekday: Math.floor(index / 24),
        hour: index % 24,
        value: query.metric === "energy" ? value : brightness,
        knownSeconds: Math.min(knownSeconds, expectedSeconds),
        expectedSeconds,
        observedLocalDays: row ? Number(row.observedLocalDays) : 0,
        eligibleLocalDays,
        coverageRate: expectedSeconds > 0 ? Math.min(knownSeconds, expectedSeconds) / expectedSeconds : null
      };
    });

    return energyObservedMeanResponseSchema.parse({
      siteId, timeZone: site.timeZone, generatedAt: generatedAt.toISOString(), metric: query.metric,
      scope: query.scope, identityId: query.identityId, range: { from: query.from, to: query.to }, cells
    });
  }

  private async assertScopeExists(siteId: string, scope: EnergyScope, identityId: string) {
    if (scope === "site") {
      if (identityId !== siteId) throw new NotFoundException("energy scope not found");
      return;
    }
    const exists = scope === "fixture"
      ? await this.prisma.energyFixtureIdentity.findFirst({ where: { id: identityId, siteId }, select: { id: true } })
      : scope === "floor"
        ? await this.prisma.floor.findFirst({ where: { id: identityId, siteId }, select: { id: true } })
        : await this.prisma.energyGroupIdentity.findFirst({ where: { id: identityId, siteId }, select: { id: true } });
    if (!exists) throw new NotFoundException("energy scope not found");
  }
}

function buildObservedMeanQuery(input: {
  siteId: string;
  scope: EnergyScope;
  identityId: string;
  timeZone: string;
  from: string;
  to: string;
  firstBucket: Date;
  lastBucket: Date;
}): Prisma.Sql {
  const scopeIdentity = input.scope === "fixture" ? Prisma.sql`AND e.id = ${input.identityId}` : Prisma.empty;
  const expectedScope = scopeAtBucket(input, Prisma.sql`slot.utc`);
  const observedScope = scopeAtBucket(input, Prisma.sql`h."bucketStartUtc"`);

  // Aggregate the expectation and observed numerator separately. A left join before aggregation
  // would probe the hourly index once for every missing fixture×hour (up to 9.6M probes here).
  return Prisma.sql`
    WITH hour_slots AS MATERIALIZED (
      SELECT bucket.utc,
        ((bucket.utc AT TIME ZONE 'UTC') AT TIME ZONE ${input.timeZone})::date AS local_date,
        EXTRACT(HOUR FROM (bucket.utc AT TIME ZONE 'UTC') AT TIME ZONE ${input.timeZone})::int AS local_hour
      FROM generate_series(
        (${input.firstBucket}::timestamptz AT TIME ZONE 'UTC'),
        (${input.lastBucket}::timestamptz AT TIME ZONE 'UTC'),
        interval '1 hour') AS bucket(utc)
    ), expected_hours AS (
      SELECT slot.local_date, slot.local_hour,
        SUM(EXTRACT(EPOCH FROM LEAST(slot.utc + interval '1 hour', COALESCE(e."retiredAt", 'infinity'::timestamp))
          - GREATEST(slot.utc, e."trackingStartedAt")))::bigint AS expected_seconds
      FROM "EnergyFixtureIdentity" e
      CROSS JOIN hour_slots slot
      WHERE e."siteId" = ${input.siteId} ${scopeIdentity}
        AND e."trackingStartedAt" < slot.utc + interval '1 hour'
        AND (e."retiredAt" IS NULL OR e."retiredAt" > slot.utc)
        AND slot.local_date BETWEEN ${input.from}::date AND ${input.to}::date
        ${expectedScope}
      GROUP BY local_date, local_hour
    ), observed_hours AS (
      SELECT h."localDate" AS local_date, h."localHour" AS local_hour,
        SUM(h."knownSeconds")::bigint AS known_seconds,
        SUM(h."unknownSeconds")::bigint AS unknown_seconds,
        SUM(h."estimatedKwh")::numeric AS estimated_kwh,
        SUM(h."brightnessWeightedSeconds")::numeric AS brightness_weighted_seconds
      FROM "FixtureEnergyHourlyAggregate" h
      JOIN "EnergyFixtureIdentity" e ON e.id = h."energyFixtureId"
      WHERE e."siteId" = ${input.siteId} ${scopeIdentity}
        AND h."localDate" BETWEEN ${input.from}::date AND ${input.to}::date
        AND e."trackingStartedAt" < h."bucketStartUtc" + interval '1 hour'
        AND (e."retiredAt" IS NULL OR e."retiredAt" > h."bucketStartUtc")
        ${observedScope}
      GROUP BY h."localDate", h."localHour"
    ), local_hours AS (
      SELECT x.local_date, x.local_hour, x.expected_seconds,
        COALESCE(o.known_seconds, 0)::bigint AS known_seconds,
        COALESCE(o.unknown_seconds, 0)::bigint AS unknown_seconds,
        COALESCE(o.estimated_kwh, 0)::numeric AS estimated_kwh,
        COALESCE(o.brightness_weighted_seconds, 0)::numeric AS brightness_weighted_seconds
      FROM expected_hours x
      LEFT JOIN observed_hours o ON o.local_date = x.local_date AND o.local_hour = x.local_hour
    )
    SELECT EXTRACT(DOW FROM local_date)::int AS weekday, local_hour AS hour,
      SUM(expected_seconds)::bigint AS "expectedSeconds",
      SUM(known_seconds)::bigint AS "knownSeconds",
      SUM(unknown_seconds)::bigint AS "unknownSeconds",
      SUM(estimated_kwh)::numeric AS "estimatedKwh",
      SUM(brightness_weighted_seconds)::numeric AS "brightnessWeightedSeconds",
      COUNT(*)::bigint AS "eligibleLocalDays",
      COUNT(*) FILTER (WHERE expected_seconds > 0 AND known_seconds = expected_seconds AND unknown_seconds = 0)::bigint AS "observedLocalDays",
      BOOL_AND(expected_seconds > 0 AND known_seconds = expected_seconds AND unknown_seconds = 0) AS "fullyObserved"
    FROM local_hours
    WHERE expected_seconds > 0
    GROUP BY EXTRACT(DOW FROM local_date), local_hour
  `;
}

function scopeAtBucket(input: { scope: EnergyScope; identityId: string; siteId: string }, bucket: Prisma.Sql): Prisma.Sql {
  // Legacy floor heatmaps reject an hour with overlapping dimension versions, even when
  // both versions name the same floor. Keep the new mean's denominator equally strict.
  return input.scope === "floor"
    ? Prisma.sql`AND (
        SELECT COUNT(*) FROM "EnergyFixtureDimensionVersion" v
        WHERE v."energyFixtureId" = e.id
          AND v."effectiveFrom" < ${bucket} + interval '1 hour'
          AND (v."effectiveTo" IS NULL OR v."effectiveTo" > ${bucket})
      ) = 1 AND EXISTS (
        SELECT 1 FROM "EnergyFixtureDimensionVersion" v
        WHERE v."energyFixtureId" = e.id AND v."floorId" = ${input.identityId}
          AND v."effectiveFrom" <= ${bucket}
          AND (v."effectiveTo" IS NULL OR v."effectiveTo" >= ${bucket} + interval '1 hour')
      )`
    : input.scope === "group"
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM "EnergyGroupMembershipVersion" m
          JOIN "EnergyGroupIdentity" g ON g.id = m."energyGroupId"
          WHERE m."energyFixtureId" = e.id AND m."energyGroupId" = ${input.identityId}
            AND g."siteId" = ${input.siteId}
            AND m."effectiveFrom" <= ${bucket}
            AND (m."effectiveTo" IS NULL OR m."effectiveTo" >= ${bucket} + interval '1 hour')
            AND g."trackingStartedAt" <= ${bucket}
            AND (g."retiredAt" IS NULL OR g."retiredAt" >= ${bucket} + interval '1 hour')
            AND EXISTS (
              SELECT 1 FROM "EnergyGroupDimensionVersion" gd
              WHERE gd."energyGroupId" = g.id AND gd."effectiveFrom" <= ${bucket}
                AND (gd."effectiveTo" IS NULL OR gd."effectiveTo" >= ${bucket} + interval '1 hour')
            )
        )`
      : Prisma.empty;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

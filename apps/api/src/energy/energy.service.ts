import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { EnergySeriesResponse, EnergySummary } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import {
  createInitialFixtureEnergyCheckpoint,
  projectOpenFixtureEnergy,
  type FixtureEnergyCheckpoint,
  type FixtureEnergySnapshot
} from "./energy-aggregation";
import {
  addCalendarDays,
  addCalendarMonths,
  formatCalendarDate,
  listDaysInclusive,
  listMonthsInclusive,
  localDateAt,
  monthKey,
  parseCalendarDate,
  startOfLocalDate,
  type CalendarDate
} from "./energy-periods";

interface EstimateInput {
  ratedWatt: number;
  brightness: number;
  hours: number;
  tariffKwhRate: number;
}

interface SeriesQuery {
  granularity: "day" | "month";
  from: string;
  to: string;
}

interface EnergyAggregateRow {
  localDate: Date;
  estimatedKwh: Prisma.Decimal;
  estimatedCost: Prisma.Decimal;
  knownSeconds: number;
  unknownSeconds: number;
  updatedAt: Date;
}

interface EnergyCursorRow {
  aggregatedThrough: Date;
  observedStateOccurredAt: Date | null;
  brightness: number;
  powerOn: boolean | null;
  ratedWatt: Prisma.Decimal;
  durationRemainders: unknown;
  updatedAt: Date;
}

interface EnergyFixtureRow {
  id: string;
  ratedWatt: Prisma.Decimal;
  energyTrackingStartedAt: Date;
  firstStateOccurredAt: Date | null;
  lastStateEventId: string | null;
  lastStateSequence: bigint | null;
  lastStateOccurredAt: Date | null;
  brightness: number;
  powerOn: boolean | null;
  energyStateCursor: EnergyCursorRow | null;
  energyDailyAggregates: EnergyAggregateRow[];
}

interface DailyValue {
  estimatedKwh: Prisma.Decimal;
  estimatedCost: Prisma.Decimal;
  knownSeconds: number;
  unknownSeconds: number;
  hasData: boolean;
}

const SOURCE = "state_based_estimate" as const;
const MIN_FORECAST_FIXTURE_KNOWN_SECONDS = 3_600;
const MIN_FORECAST_SITE_COVERAGE = 0.8;

@Injectable()
export class EnergyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService
  ) {}

  calculateEstimatedUsage(input: EstimateInput) {
    const kwh = Number(((input.ratedWatt * (input.brightness / 100) * input.hours) / 1000).toFixed(4));
    const cost = Number((kwh * input.tariffKwhRate).toFixed(2));
    return { kwh, cost };
  }

  async getDefaultSiteEstimate(user: AuthenticatedUser) {
    const siteIds = await this.siteAccess.listAccessibleSiteIds(user);
    const siteId = [...siteIds].sort()[0];
    if (!siteId) throw new NotFoundException("site not found");
    return this.getSiteEstimate(user, siteId);
  }

  async getSiteEstimate(user: AuthenticatedUser, siteId: string) {
    await this.siteAccess.assert(user, siteId, "read");
    const site = await this.prisma.site.findFirstOrThrow({
      where: { id: siteId },
      include: { floors: { include: { fixtures: true } } }
    });
    this.assertTariffAvailable(site.tariffKwhRate);
    const fixtures = site.floors.flatMap((floor) => floor.fixtures);
    const tariffKwhRate = Number(site.tariffKwhRate);
    const daily = fixtures.reduce((sum, fixture) => {
      const estimate = this.calculateEstimatedUsage({
        ratedWatt: Number(fixture.ratedWatt),
        brightness: fixture.brightness,
        hours: 12,
        tariffKwhRate
      });
      return sum + estimate.kwh;
    }, 0);

    return {
      day: { kwh: Number(daily.toFixed(4)), cost: Number((daily * tariffKwhRate).toFixed(2)) },
      month: { kwh: Number((daily * 30).toFixed(4)), cost: Number((daily * 30 * tariffKwhRate).toFixed(2)) },
      year: { kwh: Number((daily * 365).toFixed(4)), cost: Number((daily * 365 * tariffKwhRate).toFixed(2)) }
    };
  }

  async getSiteSummary(user: AuthenticatedUser, siteId: string): Promise<EnergySummary> {
    const generatedAt = new Date();
    await this.siteAccess.assert(user, siteId, "read");
    const site = await this.loadSite(siteId);
    this.assertTariffAvailable(site.tariffKwhRate);
    const localNow = localDateAt(generatedAt, site.timeZone);
    const yearStart = { year: localNow.year, month: 1, day: 1 };
    const monthStart = { year: localNow.year, month: localNow.month, day: 1 };
    const monthEnd = addCalendarMonths(monthStart, 1);
    const fixtures = await this.loadFixtures(siteId, yearStart, addCalendarDays(localNow, 1));
    const values = this.buildFixtureValues(fixtures, yearStart, generatedAt, site.timeZone, site.tariffKwhRate);

    const today = summarizeValues(values, (key) => key === formatCalendarDate(localNow));
    const monthToDate = summarizeValues(values, (key) => key >= formatCalendarDate(monthStart));
    const yearToDate = summarizeValues(values, () => true);
    const monthStartUtc = startOfLocalDate(monthStart, site.timeZone);
    const monthEndUtc = startOfLocalDate(monthEnd, site.timeZone);
    const monthTotalSeconds = (monthEndUtc.getTime() - monthStartUtc.getTime()) / 1_000;
    const remainingSeconds = Math.max(0, (monthEndUtc.getTime() - generatedAt.getTime()) / 1_000);
    const tariff = new Prisma.Decimal(site.tariffKwhRate);
    const baselineKwh = fixtures.reduce(
      (sum, fixture) => sum.add(new Prisma.Decimal(fixture.ratedWatt).mul(monthTotalSeconds).div(3_600_000)),
      new Prisma.Decimal(0)
    );
    const forecast = calculateForecast(fixtures, values, monthStart, monthStartUtc, generatedAt, remainingSeconds, tariff);
    const forecastAvailable = forecast.reason === "available";

    return {
      siteId,
      timeZone: site.timeZone,
      source: SOURCE,
      generatedAt: generatedAt.toISOString(),
      today: serializePeriod(today),
      monthToDate: serializePeriod(monthToDate),
      yearToDate: serializePeriod(yearToDate),
      monthForecast: {
        estimatedKwh: forecastAvailable ? roundKwh(forecast.estimatedKwh) : null,
        estimatedCost: forecastAvailable ? roundCost(forecast.estimatedKwh.mul(tariff)) : null,
        observedKnownSeconds: forecast.observedKnownSeconds,
        reason: forecast.reason
      },
      baseline24Hours: {
        estimatedKwh: roundKwh(baselineKwh),
        estimatedCost: roundCost(baselineKwh.mul(tariff)),
        fixtureCount: fixtures.length,
        daysInMonth: new Date(Date.UTC(monthStart.year, monthStart.month, 0)).getUTCDate()
      },
      estimatedSavings: {
        kwh: forecastAvailable ? roundKwh(baselineKwh.sub(forecast.estimatedKwh)) : null,
        cost: forecastAvailable ? roundCost(baselineKwh.sub(forecast.estimatedKwh).mul(tariff)) : null
      },
      lastAggregatedAt: latestAggregationAt(fixtures)?.toISOString() ?? null
    };
  }

  async getSiteSeries(
    user: AuthenticatedUser,
    siteId: string,
    rawQuery: SeriesQuery
  ): Promise<EnergySeriesResponse> {
    await this.siteAccess.assert(user, siteId, "read");
    const query = parseSeriesQuery(rawQuery);
    const site = await this.loadSite(siteId);
    this.assertTariffAvailable(site.tariffKwhRate);
    const generatedAt = new Date();
    const periods = query.granularity === "day"
      ? listDaysInclusive(query.fromDate, query.toDate)
      : listMonthsInclusive(query.fromDate, query.toDate);
    const queryStart = periods[0];
    const endExclusive = query.granularity === "day"
      ? addCalendarDays(periods[periods.length - 1], 1)
      : addCalendarMonths(periods[periods.length - 1], 1);
    const fixtures = await this.loadFixtures(siteId, queryStart, endExclusive);
    const projectionThrough = new Date(Math.min(generatedAt.getTime(), startOfLocalDate(endExclusive, site.timeZone).getTime()));
    const values = this.buildFixtureValues(fixtures, queryStart, projectionThrough, site.timeZone, site.tariffKwhRate);

    return {
      siteId,
      timeZone: site.timeZone,
      source: SOURCE,
      generatedAt: generatedAt.toISOString(),
      granularity: query.granularity,
      from: rawQuery.from,
      to: rawQuery.to,
      points: periods.map((period) => {
        const key = query.granularity === "day" ? formatCalendarDate(period) : monthKey(period);
        const value = summarizeValues(values, (date) => query.granularity === "day" ? date === key : date.startsWith(key));
        return {
          source: SOURCE,
          period: key,
          estimatedKwh: value.hasData && value.knownSeconds > 0 ? roundKwh(value.estimatedKwh) : null,
          estimatedCost: value.hasData && value.knownSeconds > 0 ? roundCost(value.estimatedCost) : null,
          knownSeconds: value.knownSeconds,
          unknownSeconds: value.unknownSeconds,
          dataStatus: dataStatus(value)
        };
      })
    };
  }

  private async loadSite(siteId: string) {
    return this.prisma.site.findUniqueOrThrow({
      where: { id: siteId },
      select: { id: true, timeZone: true, tariffKwhRate: true }
    });
  }

  private assertTariffAvailable(tariffKwhRate: Prisma.Decimal | null): asserts tariffKwhRate is Prisma.Decimal {
    if (tariffKwhRate === null) {
      throw new ConflictException("site tariff is unavailable until installation is complete");
    }
  }

  private async loadFixtures(siteId: string, from: CalendarDate, toExclusive: CalendarDate) {
    return this.prisma.fixture.findMany({
      where: { floor: { siteId } },
      select: {
        id: true,
        ratedWatt: true,
        energyTrackingStartedAt: true,
        firstStateOccurredAt: true,
        lastStateEventId: true,
        lastStateSequence: true,
        lastStateOccurredAt: true,
        brightness: true,
        powerOn: true,
        energyStateCursor: true,
        energyDailyAggregates: {
          where: {
            localDate: {
              gte: new Date(`${formatCalendarDate(from)}T00:00:00.000Z`),
              lt: new Date(`${formatCalendarDate(toExclusive)}T00:00:00.000Z`)
            }
          },
          orderBy: { localDate: "asc" }
        }
      }
    }) as unknown as Promise<EnergyFixtureRow[]>;
  }

  private buildFixtureValues(
    fixtures: EnergyFixtureRow[],
    queryStart: CalendarDate,
    generatedAt: Date,
    timeZone: string,
    tariffKwhRate: Prisma.Decimal
  ) {
    const queryStartedAt = startOfLocalDate(queryStart, timeZone);
    const values = new Map<string, Map<string, DailyValue>>();
    for (const fixture of fixtures) {
      const daily = new Map<string, DailyValue>();
      for (const aggregate of fixture.energyDailyAggregates) {
        mergeDaily(daily, aggregate.localDate.toISOString().slice(0, 10), aggregate);
      }
      const snapshot = toSnapshot(fixture);
      const checkpoint = fixture.energyStateCursor ? toCheckpoint(fixture.energyStateCursor) : createInitialFixtureEnergyCheckpoint(snapshot);
      const projection = projectOpenFixtureEnergy({
        snapshot,
        checkpoint,
        queryStartedAt,
        generatedAt,
        timeZone,
        tariffKwhRate: new Prisma.Decimal(tariffKwhRate)
      });
      for (const delta of projection.dailyDeltas) {
        mergeDaily(daily, delta.localDate.toISOString().slice(0, 10), delta);
      }
      values.set(fixture.id, daily);
    }
    return values;
  }
}

function parseSeriesQuery(query: SeriesQuery) {
  try {
    if (query.granularity !== "day" && query.granularity !== "month") throw new RangeError("invalid granularity");
    const fromDate = parseCalendarDate(query.from);
    const toDate = parseCalendarDate(query.to);
    if (formatCalendarDate(fromDate) > formatCalendarDate(toDate)) throw new RangeError("from must not be after to");
    if (query.granularity === "day") listDaysInclusive(fromDate, toDate);
    else listMonthsInclusive(fromDate, toDate);
    return { ...query, fromDate, toDate };
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : "invalid series query");
  }
}

function emptyDaily(): DailyValue {
  return { estimatedKwh: new Prisma.Decimal(0), estimatedCost: new Prisma.Decimal(0), knownSeconds: 0, unknownSeconds: 0, hasData: false };
}

function mergeDaily(target: Map<string, DailyValue>, key: string, value: Pick<DailyValue, "estimatedKwh" | "estimatedCost" | "knownSeconds" | "unknownSeconds">) {
  const current = target.get(key) ?? emptyDaily();
  current.estimatedKwh = current.estimatedKwh.add(value.estimatedKwh);
  current.estimatedCost = current.estimatedCost.add(value.estimatedCost);
  current.knownSeconds += value.knownSeconds;
  current.unknownSeconds += value.unknownSeconds;
  current.hasData = true;
  target.set(key, current);
}

function summarizeValues(values: Map<string, Map<string, DailyValue>>, includes: (key: string) => boolean) {
  const total = emptyDaily();
  for (const daily of values.values()) {
    for (const [key, value] of daily) {
      if (!includes(key)) continue;
      total.estimatedKwh = total.estimatedKwh.add(value.estimatedKwh);
      total.estimatedCost = total.estimatedCost.add(value.estimatedCost);
      total.knownSeconds += value.knownSeconds;
      total.unknownSeconds += value.unknownSeconds;
      total.hasData ||= value.hasData;
    }
  }
  return total;
}

function serializePeriod(value: DailyValue) {
  return {
    estimatedKwh: roundKwh(value.estimatedKwh),
    estimatedCost: roundCost(value.estimatedCost),
    knownSeconds: value.knownSeconds,
    unknownSeconds: value.unknownSeconds,
    dataStatus: dataStatus(value)
  };
}

function dataStatus(value: DailyValue): "no_data" | "partial" | "available" {
  if (!value.hasData || (value.knownSeconds === 0 && value.unknownSeconds === 0)) return "no_data";
  return value.unknownSeconds > 0 ? "partial" : "available";
}

function calculateForecast(
  fixtures: EnergyFixtureRow[],
  values: Map<string, Map<string, DailyValue>>,
  monthStart: CalendarDate,
  monthStartUtc: Date,
  generatedAt: Date,
  remainingSeconds: number,
  _tariff: Prisma.Decimal
) {
  if (fixtures.length === 0) {
    return { estimatedKwh: new Prisma.Decimal(0), observedKnownSeconds: 0, reason: "no_registered_fixture" as const };
  }
  let estimatedKwh = new Prisma.Decimal(0);
  let observedKnownSeconds = 0;
  let eligibleSeconds = 0;
  let eachFixtureReady = true;
  for (const fixture of fixtures) {
    const month = summarizeValues(new Map([[fixture.id, values.get(fixture.id) ?? new Map()]]), (key) => key >= formatCalendarDate(monthStart));
    observedKnownSeconds += month.knownSeconds;
    eligibleSeconds += Math.max(0, (generatedAt.getTime() - Math.max(monthStartUtc.getTime(), fixture.energyTrackingStartedAt.getTime())) / 1_000);
    eachFixtureReady &&= month.knownSeconds >= MIN_FORECAST_FIXTURE_KNOWN_SECONDS;
    if (month.knownSeconds > 0) {
      estimatedKwh = estimatedKwh.add(month.estimatedKwh).add(month.estimatedKwh.div(month.knownSeconds).mul(remainingSeconds));
    }
  }
  const coverage = eligibleSeconds > 0 ? observedKnownSeconds / eligibleSeconds : 0;
  if (!eachFixtureReady || coverage < MIN_FORECAST_SITE_COVERAGE) {
    return { estimatedKwh: new Prisma.Decimal(0), observedKnownSeconds, reason: "insufficient_state" as const };
  }
  return { estimatedKwh, observedKnownSeconds, reason: "available" as const };
}

function toSnapshot(fixture: EnergyFixtureRow): FixtureEnergySnapshot {
  return {
    energyTrackingStartedAt: fixture.energyTrackingStartedAt,
    firstStateOccurredAt: fixture.firstStateOccurredAt,
    lastStateEventId: fixture.lastStateEventId,
    lastStateSequence: fixture.lastStateSequence,
    lastStateOccurredAt: fixture.lastStateOccurredAt,
    brightness: fixture.brightness,
    powerOn: fixture.powerOn,
    ratedWatt: new Prisma.Decimal(fixture.ratedWatt)
  };
}

function toCheckpoint(cursor: EnergyCursorRow): FixtureEnergyCheckpoint {
  const remainders = Array.isArray(cursor.durationRemainders) ? cursor.durationRemainders : [];
  return {
    aggregatedThrough: cursor.aggregatedThrough,
    observedStateOccurredAt: cursor.observedStateOccurredAt,
    brightness: cursor.brightness,
    powerOn: cursor.powerOn,
    ratedWatt: new Prisma.Decimal(cursor.ratedWatt),
    durationRemainders: remainders as FixtureEnergyCheckpoint["durationRemainders"]
  };
}

function latestAggregationAt(fixtures: EnergyFixtureRow[]) {
  const candidates = fixtures.flatMap((fixture) => [
    ...(fixture.energyStateCursor ? [fixture.energyStateCursor.updatedAt] : []),
    ...fixture.energyDailyAggregates.map((aggregate) => aggregate.updatedAt)
  ]);
  return candidates.sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
}

function roundKwh(value: Prisma.Decimal) {
  return Number(value.toDecimalPlaces(4).toString());
}

function roundCost(value: Prisma.Decimal) {
  return Number(value.toDecimalPlaces(2).toString());
}

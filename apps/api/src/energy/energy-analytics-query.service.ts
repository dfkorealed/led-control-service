import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  EnergyComparisonPoint,
  EnergyComparisonPreset,
  EnergyComparisonResponse,
  EnergySeriesResponse,
  EnergySummary
} from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import {
  createInitialFixtureEnergyCheckpoint,
  projectOpenFixtureEnergy,
  type FixtureEnergyCheckpoint,
  type FixtureEnergySnapshot
} from "./energy-aggregation";
import {
  comparisonRanges,
  type ComparisonDateRange
} from "./energy-comparison-query";
import {
  addCalendarDays,
  addCalendarMonths,
  endOfCalendarMonth,
  formatCalendarDate,
  listDaysInclusive,
  listMonthsInclusive,
  localDateAt,
  monthKey,
  parseCalendarDate,
  startOfLocalDate,
  type CalendarDate
} from "./energy-periods";

export interface EnergySeriesQuery {
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

interface ForecastResult {
  estimatedKwh: Prisma.Decimal;
  observedKnownSeconds: number;
  observedUnknownSeconds: number;
  coverageRate: number | null;
  reason: "available" | "insufficient_state" | "no_registered_fixture";
  fixtureRates: Map<string, Prisma.Decimal>;
}

const SOURCE = "state_based_estimate" as const;
const MIN_FORECAST_FIXTURE_KNOWN_SECONDS = 3_600;
const MIN_FORECAST_SITE_COVERAGE = 0.8;

@Injectable()
export class EnergyAnalyticsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService
  ) {}

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
    const baselineKwh = totalRatedWatt(fixtures).mul(monthTotalSeconds).div(3_600_000);
    const forecast = calculateForecast(fixtures, values, monthStart, monthStartUtc, generatedAt, remainingSeconds);
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
    rawQuery: EnergySeriesQuery
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
          estimatedKwh: energyOrNull(value),
          estimatedCost: value.hasData && value.knownSeconds > 0 ? roundCost(value.estimatedCost) : null,
          knownSeconds: value.knownSeconds,
          unknownSeconds: value.unknownSeconds,
          dataStatus: dataStatus(value)
        };
      })
    };
  }

  async getComparison(
    user: AuthenticatedUser,
    siteId: string,
    preset: EnergyComparisonPreset
  ): Promise<EnergyComparisonResponse> {
    await this.siteAccess.assert(user, siteId, "read");
    const site = await this.loadSite(siteId);
    this.assertTariffAvailable(site.tariffKwhRate);
    const generatedAt = new Date();
    const ranges = comparisonRanges(preset, generatedAt, site.timeZone);
    const loadRanges = [ranges.display, ranges.previousPeriod, ranges.previousYear]
      .filter((range): range is ComparisonDateRange => range !== null);
    const queryStart = parseCalendarDate(loadRanges.map((range) => range.from).sort()[0]);
    const displayEnd = parseCalendarDate(ranges.display.to);
    const endExclusive = addCalendarDays(displayEnd, 1);
    const fixtures = await this.loadFixtures(siteId, queryStart, endExclusive);
    const projectionThrough = new Date(Math.min(
      generatedAt.getTime(),
      startOfLocalDate(endExclusive, site.timeZone).getTime()
    ));
    const values = this.buildFixtureValues(fixtures, queryStart, projectionThrough, site.timeZone, site.tariffKwhRate);
    const tariff = new Prisma.Decimal(site.tariffKwhRate);
    const baselineKwh = baselineForRange(fixtures, ranges.display, site.timeZone);
    const monthStart = parseCalendarDate(ranges.display.from);
    const monthEndExclusive = addCalendarMonths(monthStart, 1);
    const forecast = preset === "current_month"
      ? calculateForecast(
        fixtures,
        values,
        monthStart,
        startOfLocalDate(monthStart, site.timeZone),
        generatedAt,
        Math.max(0, (startOfLocalDate(monthEndExclusive, site.timeZone).getTime() - generatedAt.getTime()) / 1_000)
      )
      : null;
    const completedValue = summarizeRange(values, ranges.completed);
    const estimatedKwh = preset === "current_month"
      ? forecast?.reason === "available" ? forecast.estimatedKwh : null
      : decimalEnergyOrNull(completedValue);
    const forecastReason = preset === "current_month" ? forecast!.reason : "not_applicable";
    const summary = comparisonSummary(baselineKwh, estimatedKwh, tariff, forecastReason);

    return {
      siteId,
      timeZone: site.timeZone,
      source: SOURCE,
      generatedAt: generatedAt.toISOString(),
      preset,
      range: {
        from: ranges.display.from,
        to: ranges.display.to,
        completedThrough: ranges.completedThrough
      },
      summary,
      priorComparisons: buildPriorComparisons(values, ranges.completed, ranges.previousPeriod, ranges.previousYear, preset),
      points: buildComparisonPoints({
        preset,
        ranges,
        fixtures,
        values,
        forecast,
        generatedAt,
        timeZone: site.timeZone
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
      const checkpoint = fixture.energyStateCursor
        ? toCheckpoint(fixture.energyStateCursor)
        : createInitialFixtureEnergyCheckpoint(snapshot);
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

function buildComparisonPoints(input: {
  preset: EnergyComparisonPreset;
  ranges: ReturnType<typeof comparisonRanges>;
  fixtures: EnergyFixtureRow[];
  values: Map<string, Map<string, DailyValue>>;
  forecast: ForecastResult | null;
  generatedAt: Date;
  timeZone: string;
}): EnergyComparisonPoint[] {
  if (input.preset === "current_year") {
    const periods = listMonthsInclusive(
      parseCalendarDate(input.ranges.display.from),
      parseCalendarDate(input.ranges.display.to)
    );
    const completedThrough = parseCalendarDate(input.ranges.completedThrough);
    return periods.map((period) => {
      const periodEnd = formatCalendarDate(endOfCalendarMonth(period)) <= input.ranges.completedThrough
        ? endOfCalendarMonth(period)
        : completedThrough;
      const value = summarizeRange(input.values, {
        from: formatCalendarDate(period),
        to: formatCalendarDate(periodEnd)
      });
      return observedPoint(
        monthKey(period),
        baselineForCalendarDates(input.fixtures, period, periodEnd, input.timeZone),
        value
      );
    });
  }

  const periods = listDaysInclusive(
    parseCalendarDate(input.ranges.display.from),
    parseCalendarDate(input.ranges.display.to)
  );
  return periods.map((period) => {
    const key = formatCalendarDate(period);
    const baseline = baselineForCalendarDates(input.fixtures, period, period, input.timeZone);
    if (input.preset !== "current_month" || key <= input.ranges.completedThrough) {
      return observedPoint(key, baseline, summarizeRange(input.values, { from: key, to: key }));
    }
    return forecastPoint(key, period, baseline, input);
  });
}

function observedPoint(period: string, baseline: Prisma.Decimal, value: DailyValue): EnergyComparisonPoint {
  const estimatedKwh = energyOrNull(value);
  return {
    period,
    baselineKwh: roundKwh(baseline),
    estimatedKwh,
    phase: estimatedKwh === null ? "unavailable" : "observed",
    knownSeconds: value.knownSeconds,
    unknownSeconds: value.unknownSeconds,
    coverageRate: coverageRate(value.knownSeconds, value.unknownSeconds),
    dataStatus: dataStatus(value)
  };
}

function forecastPoint(
  key: string,
  period: CalendarDate,
  baseline: Prisma.Decimal,
  input: {
    forecast: ForecastResult | null;
    generatedAt: Date;
    timeZone: string;
    values: Map<string, Map<string, DailyValue>>;
  }
): EnergyComparisonPoint {
  const forecast = input.forecast;
  if (!forecast || forecast.reason !== "available") {
    return {
      period: key,
      baselineKwh: roundKwh(baseline),
      estimatedKwh: null,
      phase: "unavailable",
      knownSeconds: forecast?.observedKnownSeconds ?? 0,
      unknownSeconds: forecast?.observedUnknownSeconds ?? 0,
      coverageRate: forecast?.coverageRate ?? null,
      dataStatus: forecast ? statusFromDurations(forecast.observedKnownSeconds, forecast.observedUnknownSeconds) : "no_data"
    };
  }

  const dayStart = startOfLocalDate(period, input.timeZone);
  const dayEnd = startOfLocalDate(addCalendarDays(period, 1), input.timeZone);
  const totalRate = [...forecast.fixtureRates.values()].reduce((sum, rate) => sum.add(rate), new Prisma.Decimal(0));
  let estimated = new Prisma.Decimal(0);
  if (input.generatedAt >= dayStart && input.generatedAt < dayEnd) {
    estimated = summarizeRange(input.values, { from: key, to: key }).estimatedKwh;
    estimated = estimated.add(totalRate.mul((dayEnd.getTime() - input.generatedAt.getTime()) / 1_000));
  } else {
    estimated = totalRate.mul((dayEnd.getTime() - dayStart.getTime()) / 1_000);
  }
  return {
    period: key,
    baselineKwh: roundKwh(baseline),
    estimatedKwh: roundKwh(estimated),
    phase: "forecast",
    knownSeconds: forecast.observedKnownSeconds,
    unknownSeconds: forecast.observedUnknownSeconds,
    coverageRate: forecast.coverageRate,
    dataStatus: statusFromDurations(forecast.observedKnownSeconds, forecast.observedUnknownSeconds)
  };
}

function buildPriorComparisons(
  values: Map<string, Map<string, DailyValue>>,
  currentRange: ComparisonDateRange | null,
  previousPeriod: ComparisonDateRange | null,
  previousYear: ComparisonDateRange | null,
  preset: EnergyComparisonPreset
): EnergyComparisonResponse["priorComparisons"] {
  if (!currentRange) return [];
  const current = summarizeRange(values, currentRange);
  const candidates = [
    ...(preset !== "current_year" && previousPeriod ? [{ kind: "previous_period" as const, range: previousPeriod }] : []),
    ...(previousYear ? [{ kind: "previous_year" as const, range: previousYear }] : [])
  ];
  return candidates.map((candidate) => {
    const comparison = summarizeRange(values, candidate.range);
    const currentKwh = decimalEnergyOrNull(current);
    const comparisonKwh = decimalEnergyOrNull(comparison);
    return {
      kind: candidate.kind,
      currentRange,
      comparisonRange: candidate.range,
      currentKwh: currentKwh === null ? null : roundKwh(currentKwh),
      comparisonKwh: comparisonKwh === null ? null : roundKwh(comparisonKwh),
      changeRatePercent: currentKwh !== null && comparisonKwh !== null && !comparisonKwh.isZero()
        ? roundPercent(currentKwh.sub(comparisonKwh).div(comparisonKwh).mul(100))
        : null,
      currentCoverageRate: coverageRate(current.knownSeconds, current.unknownSeconds),
      comparisonCoverageRate: coverageRate(comparison.knownSeconds, comparison.unknownSeconds),
      historyQuality: "legacy_structure_unknown" as const
    };
  });
}

function comparisonSummary(
  baselineKwh: Prisma.Decimal,
  estimatedKwh: Prisma.Decimal | null,
  tariff: Prisma.Decimal,
  forecastReason: EnergyComparisonResponse["summary"]["forecastReason"]
): EnergyComparisonResponse["summary"] {
  if (estimatedKwh === null || baselineKwh.isZero()) {
    return {
      baselineKwh: roundKwh(baselineKwh),
      estimatedKwh: null,
      savingsKwh: null,
      savingsCost: null,
      savingsRatePercent: null,
      outcome: "unavailable",
      forecastReason
    };
  }
  const savings = baselineKwh.sub(estimatedKwh);
  return {
    baselineKwh: roundKwh(baselineKwh),
    estimatedKwh: roundKwh(estimatedKwh),
    savingsKwh: roundKwh(savings),
    savingsCost: roundCost(savings.mul(tariff)),
    savingsRatePercent: roundPercent(savings.div(baselineKwh).mul(100)),
    outcome: savings.isNegative() ? "overuse" : "saving",
    forecastReason
  };
}

function baselineForRange(fixtures: EnergyFixtureRow[], range: ComparisonDateRange, timeZone: string) {
  return baselineForCalendarDates(fixtures, parseCalendarDate(range.from), parseCalendarDate(range.to), timeZone);
}

function baselineForCalendarDates(
  fixtures: EnergyFixtureRow[],
  from: CalendarDate,
  to: CalendarDate,
  timeZone: string
) {
  const seconds = (startOfLocalDate(addCalendarDays(to, 1), timeZone).getTime() - startOfLocalDate(from, timeZone).getTime()) / 1_000;
  return totalRatedWatt(fixtures).mul(seconds).div(3_600_000);
}

function totalRatedWatt(fixtures: EnergyFixtureRow[]) {
  return fixtures.reduce(
    (sum, fixture) => sum.add(new Prisma.Decimal(fixture.ratedWatt)),
    new Prisma.Decimal(0)
  );
}

function calculateForecast(
  fixtures: EnergyFixtureRow[],
  values: Map<string, Map<string, DailyValue>>,
  monthStart: CalendarDate,
  monthStartUtc: Date,
  generatedAt: Date,
  remainingSeconds: number
): ForecastResult {
  if (fixtures.length === 0) {
    return {
      estimatedKwh: new Prisma.Decimal(0),
      observedKnownSeconds: 0,
      observedUnknownSeconds: 0,
      coverageRate: null,
      reason: "no_registered_fixture",
      fixtureRates: new Map()
    };
  }
  let estimatedKwh = new Prisma.Decimal(0);
  let observedKnownSeconds = 0;
  let observedUnknownSeconds = 0;
  let eligibleSeconds = 0;
  let eachFixtureReady = true;
  const fixtureRates = new Map<string, Prisma.Decimal>();
  for (const fixture of fixtures) {
    const month = summarizeValues(
      new Map([[fixture.id, values.get(fixture.id) ?? new Map()]]),
      (key) => key >= formatCalendarDate(monthStart)
    );
    observedKnownSeconds += month.knownSeconds;
    observedUnknownSeconds += month.unknownSeconds;
    eligibleSeconds += Math.max(
      0,
      (generatedAt.getTime() - Math.max(monthStartUtc.getTime(), fixture.energyTrackingStartedAt.getTime())) / 1_000
    );
    eachFixtureReady &&= month.knownSeconds >= MIN_FORECAST_FIXTURE_KNOWN_SECONDS;
    if (month.knownSeconds > 0) {
      const rate = month.estimatedKwh.div(month.knownSeconds);
      fixtureRates.set(fixture.id, rate);
      estimatedKwh = estimatedKwh.add(month.estimatedKwh).add(rate.mul(remainingSeconds));
    }
  }
  const observedCoverageRate = eligibleSeconds > 0 ? observedKnownSeconds / eligibleSeconds : 0;
  if (!eachFixtureReady || observedCoverageRate < MIN_FORECAST_SITE_COVERAGE) {
    return {
      estimatedKwh: new Prisma.Decimal(0),
      observedKnownSeconds,
      observedUnknownSeconds,
      coverageRate: observedCoverageRate,
      reason: "insufficient_state",
      fixtureRates
    };
  }
  return {
    estimatedKwh,
    observedKnownSeconds,
    observedUnknownSeconds,
    coverageRate: observedCoverageRate,
    reason: "available",
    fixtureRates
  };
}

function parseSeriesQuery(query: EnergySeriesQuery) {
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
  return {
    estimatedKwh: new Prisma.Decimal(0),
    estimatedCost: new Prisma.Decimal(0),
    knownSeconds: 0,
    unknownSeconds: 0,
    hasData: false
  };
}

function mergeDaily(
  target: Map<string, DailyValue>,
  key: string,
  value: Pick<DailyValue, "estimatedKwh" | "estimatedCost" | "knownSeconds" | "unknownSeconds">
) {
  const current = target.get(key) ?? emptyDaily();
  current.estimatedKwh = current.estimatedKwh.add(value.estimatedKwh);
  current.estimatedCost = current.estimatedCost.add(value.estimatedCost);
  current.knownSeconds += value.knownSeconds;
  current.unknownSeconds += value.unknownSeconds;
  current.hasData = true;
  target.set(key, current);
}

function summarizeRange(values: Map<string, Map<string, DailyValue>>, range: ComparisonDateRange | null) {
  if (!range) return emptyDaily();
  return summarizeValues(values, (key) => key >= range.from && key <= range.to);
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

function statusFromDurations(knownSeconds: number, unknownSeconds: number): "no_data" | "partial" | "available" {
  if (knownSeconds === 0 && unknownSeconds === 0) return "no_data";
  return unknownSeconds > 0 ? "partial" : "available";
}

function coverageRate(knownSeconds: number, unknownSeconds: number) {
  const total = knownSeconds + unknownSeconds;
  return total > 0 ? knownSeconds / total : null;
}

function decimalEnergyOrNull(value: DailyValue) {
  return value.hasData && value.knownSeconds > 0 ? value.estimatedKwh : null;
}

function energyOrNull(value: DailyValue) {
  const energy = decimalEnergyOrNull(value);
  return energy === null ? null : roundKwh(energy);
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

function roundPercent(value: Prisma.Decimal) {
  return Number(value.toDecimalPlaces(2).toString());
}

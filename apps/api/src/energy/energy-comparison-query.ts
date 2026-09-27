import { BadRequestException } from "@nestjs/common";
import {
  energyComparisonPresetSchema,
  energyRangeComparisonQuerySchema,
  type EnergyComparisonPreset
} from "@led-control/shared";
import {
  addCalendarDays,
  addCalendarMonths,
  daysInCalendarMonth,
  endOfCalendarMonth,
  formatCalendarDate,
  localDateAt,
  listDaysInclusive,
  parseCalendarDate,
  replaceCalendarYear,
  type CalendarDate
} from "./energy-periods";

export interface ComparisonDateRange {
  from: string;
  to: string;
}

export interface ComparisonRanges {
  display: ComparisonDateRange;
  completed: ComparisonDateRange | null;
  completedThrough: string;
  previousPeriod: ComparisonDateRange | null;
  previousYear: ComparisonDateRange | null;
  pointGranularity: "day" | "month";
}

export function parseComparisonPreset(raw: unknown): EnergyComparisonPreset {
  const parsed = energyComparisonPresetSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException("invalid energy comparison preset");
  return parsed.data;
}

export function comparisonRanges(
  preset: EnergyComparisonPreset,
  generatedAt: Date,
  timeZone: string
): ComparisonRanges {
  const today = localDateAt(generatedAt, timeZone);
  const yesterday = addCalendarDays(today, -1);
  if (preset === "last_7_days") return lastSevenDaysRanges(yesterday);
  if (preset === "current_month") return currentMonthRanges(today, yesterday);
  return currentYearRanges(today, yesterday);
}

export function customComparisonRanges(raw: unknown, generatedAt: Date, timeZone: string): ComparisonRanges {
  const parsed = energyRangeComparisonQuerySchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException("invalid energy comparison range");
  try {
    const from = parseCalendarDate(parsed.data.from);
    const to = parseCalendarDate(parsed.data.to);
    const length = listDaysInclusive(from, to, 400).length;
    if (parsed.data.to >= formatCalendarDate(localDateAt(generatedAt, timeZone))) {
      throw new RangeError("comparison range must contain completed days only");
    }
    const previousYearEnd = replaceCalendarYear(to, to.year - 1);
    return {
      display: range(from, to),
      completed: range(from, to),
      completedThrough: parsed.data.to,
      previousPeriod: range(addCalendarDays(from, -length), addCalendarDays(from, -1)),
      previousYear: range(addCalendarDays(previousYearEnd, 1 - length), previousYearEnd),
      pointGranularity: "day"
    };
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : "invalid energy comparison range");
  }
}

function lastSevenDaysRanges(yesterday: CalendarDate): ComparisonRanges {
  const from = addCalendarDays(yesterday, -6);
  return {
    display: range(from, yesterday),
    completed: range(from, yesterday),
    completedThrough: formatCalendarDate(yesterday),
    previousPeriod: range(addCalendarDays(from, -7), addCalendarDays(yesterday, -7)),
    previousYear: range(
      replaceCalendarYear(from, from.year - 1),
      replaceCalendarYear(yesterday, yesterday.year - 1)
    ),
    pointGranularity: "day"
  };
}

function currentMonthRanges(today: CalendarDate, yesterday: CalendarDate): ComparisonRanges {
  const monthStart = { year: today.year, month: today.month, day: 1 };
  const completed = isBefore(monthStart, today) ? range(monthStart, yesterday) : null;
  if (!completed) {
    return {
      display: range(monthStart, endOfCalendarMonth(monthStart)),
      completed: null,
      completedThrough: formatCalendarDate(yesterday),
      previousPeriod: null,
      previousYear: null,
      pointGranularity: "day"
    };
  }

  const previousMonthStart = addCalendarMonths(monthStart, -1);
  const previousMonthEnd = {
    ...previousMonthStart,
    day: Math.min(yesterday.day, daysInCalendarMonth(previousMonthStart))
  };
  return {
    display: range(monthStart, endOfCalendarMonth(monthStart)),
    completed,
    completedThrough: formatCalendarDate(yesterday),
    previousPeriod: range(previousMonthStart, previousMonthEnd),
    previousYear: range(
      replaceCalendarYear(monthStart, monthStart.year - 1),
      replaceCalendarYear(yesterday, yesterday.year - 1)
    ),
    pointGranularity: "day"
  };
}

function currentYearRanges(today: CalendarDate, yesterday: CalendarDate): ComparisonRanges {
  const yearStart = { year: today.year, month: 1, day: 1 };
  const hasCompletedDay = isBefore(yearStart, today);
  return {
    display: range(yearStart, hasCompletedDay ? yesterday : yearStart),
    completed: hasCompletedDay ? range(yearStart, yesterday) : null,
    completedThrough: formatCalendarDate(yesterday),
    previousPeriod: null,
    previousYear: hasCompletedDay
      ? range(replaceCalendarYear(yearStart, yearStart.year - 1), replaceCalendarYear(yesterday, yesterday.year - 1))
      : null,
    pointGranularity: "month"
  };
}

function range(from: CalendarDate, to: CalendarDate): ComparisonDateRange {
  return { from: formatCalendarDate(from), to: formatCalendarDate(to) };
}

function isBefore(left: CalendarDate, right: CalendarDate) {
  return formatCalendarDate(left) < formatCalendarDate(right);
}

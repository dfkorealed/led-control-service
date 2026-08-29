import { Temporal } from "@js-temporal/polyfill";
import type { LightingScheduleSnapshotV1 } from "@led-control/shared";

export interface ScheduleOccurrence {
  key: string;
  startsAtEpochMs: number;
  endsAtEpochMs: number;
  localDate: string;
}

export interface OccurrenceRange {
  startsAtEpochMs: number;
  endsAtEpochMs: number;
}

function instantDate(instant: string, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDate();
}

function epochDate(epochMs: number, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone).toPlainDate();
}

function laterDate(left: Temporal.PlainDate, right: Temporal.PlainDate): Temporal.PlainDate {
  return Temporal.PlainDate.compare(left, right) >= 0 ? left : right;
}

function earlierDate(left: Temporal.PlainDate, right: Temporal.PlainDate): Temporal.PlainDate {
  return Temporal.PlainDate.compare(left, right) <= 0 ? left : right;
}

function occurrenceOnDate(
  rule: LightingScheduleSnapshotV1,
  date: Temporal.PlainDate,
  timeZone: string
): ScheduleOccurrence | null {
  const localStart = Temporal.PlainTime.from(rule.localStartTime);
  const localEnd = Temporal.PlainTime.from(rule.localEndTime);
  const endDate = Temporal.PlainTime.compare(localEnd, localStart) <= 0 ? date.add({ days: 1 }) : date;
  const start = date.toPlainDateTime(localStart).toZonedDateTime(timeZone, { disambiguation: "compatible" });
  const end = endDate.toPlainDateTime(localEnd).toZonedDateTime(timeZone, { disambiguation: "compatible" });

  // A DST gap can move the start beyond an otherwise later wall-clock end.
  // Such a local interval has no positive real-time duration and is skipped.
  if (Temporal.ZonedDateTime.compare(end, start) <= 0) {
    return null;
  }

  const localDate = date.toString();
  return {
    key: `${rule.id}:${localDate}`,
    startsAtEpochMs: start.epochMilliseconds,
    endsAtEpochMs: end.epochMilliseconds,
    localDate
  };
}

function isDateInRange(
  date: Temporal.PlainDate,
  firstDate: Temporal.PlainDate,
  lastDate: Temporal.PlainDate
): boolean {
  return Temporal.PlainDate.compare(firstDate, date) <= 0
    && Temporal.PlainDate.compare(date, lastDate) <= 0;
}

function* candidateDates(
  rule: LightingScheduleSnapshotV1,
  firstDate: Temporal.PlainDate,
  lastDate: Temporal.PlainDate,
  activeFrom: Temporal.PlainDate
): Generator<Temporal.PlainDate> {
  switch (rule.recurrence.kind) {
    case "once": {
      if (isDateInRange(activeFrom, firstDate, lastDate)) {
        yield activeFrom;
      }
      return;
    }
    case "daily": {
      for (let date = firstDate; Temporal.PlainDate.compare(date, lastDate) <= 0; date = date.add({ days: 1 })) {
        yield date;
      }
      return;
    }
    case "weekly": {
      const weekdays = [...rule.recurrence.weeklyDays].sort((left, right) => left - right);
      let weekStart = firstDate.subtract({ days: firstDate.dayOfWeek - 1 });

      while (Temporal.PlainDate.compare(weekStart, lastDate) <= 0) {
        for (const weekday of weekdays) {
          const date = weekStart.add({ days: weekday - 1 });
          if (isDateInRange(date, firstDate, lastDate)) {
            yield date;
          }
        }
        weekStart = weekStart.add({ weeks: 1 });
      }
      return;
    }
    case "monthly": {
      if (rule.recurrence.monthlyDay === null) {
        return;
      }

      let month = firstDate.toPlainYearMonth();
      const lastMonth = lastDate.toPlainYearMonth();
      while (Temporal.PlainYearMonth.compare(month, lastMonth) <= 0) {
        if (rule.recurrence.monthlyDay <= month.daysInMonth) {
          const date = month.toPlainDate({ day: rule.recurrence.monthlyDay });
          if (isDateInRange(date, firstDate, lastDate)) {
            yield date;
          }
        }
        month = month.add({ months: 1 });
      }
      return;
    }
    case "yearly": {
      if (rule.recurrence.yearlyMonth === null || rule.recurrence.yearlyDay === null) {
        return;
      }

      let month = Temporal.PlainYearMonth.from({ year: firstDate.year, month: rule.recurrence.yearlyMonth });
      while (month.year <= lastDate.year) {
        if (rule.recurrence.yearlyDay <= month.daysInMonth) {
          const date = month.toPlainDate({ day: rule.recurrence.yearlyDay });
          if (isDateInRange(date, firstDate, lastDate)) {
            yield date;
          }
        }
        month = month.add({ years: 1 });
      }
    }
  }
}

export function* iterateScheduleOccurrences(
  rule: LightingScheduleSnapshotV1,
  firstDate: Temporal.PlainDate,
  lastDate: Temporal.PlainDate,
  timeZone: string
): Generator<ScheduleOccurrence> {
  if (rule.status !== "enabled" || Temporal.PlainDate.compare(firstDate, lastDate) > 0) {
    return;
  }

  const activeFrom = instantDate(rule.activeFrom, timeZone);
  const activeUntil = instantDate(rule.activeUntil, timeZone);
  const start = laterDate(firstDate, activeFrom);
  const end = earlierDate(lastDate, activeUntil);

  for (const date of candidateDates(rule, start, end, activeFrom)) {
    const occurrence = occurrenceOnDate(rule, date, timeZone);
    if (occurrence !== null) {
      yield occurrence;
    }
  }
}

export function getOccurrences(
  rule: LightingScheduleSnapshotV1,
  range: OccurrenceRange,
  timeZone: string
): ScheduleOccurrence[] {
  if (range.endsAtEpochMs <= range.startsAtEpochMs) {
    return [];
  }

  const firstDate = epochDate(range.startsAtEpochMs, timeZone).subtract({ days: 1 });
  const lastDate = epochDate(range.endsAtEpochMs, timeZone).add({ days: 1 });

  const occurrences: ScheduleOccurrence[] = [];
  for (const occurrence of iterateScheduleOccurrences(rule, firstDate, lastDate, timeZone)) {
    if (
      occurrence.startsAtEpochMs < range.endsAtEpochMs
      && range.startsAtEpochMs < occurrence.endsAtEpochMs
    ) {
      occurrences.push(occurrence);
    }
  }
  return occurrences;
}

export function getActiveOccurrence(
  rule: LightingScheduleSnapshotV1,
  epochMs: number,
  timeZone: string
): ScheduleOccurrence | null {
  const localDate = epochDate(epochMs, timeZone);
  for (const occurrence of iterateScheduleOccurrences(rule, localDate.subtract({ days: 1 }), localDate, timeZone)) {
    if (occurrence.startsAtEpochMs <= epochMs && epochMs < occurrence.endsAtEpochMs) {
      return occurrence;
    }
  }
  return null;
}

export function getNextOccurrence(
  rule: LightingScheduleSnapshotV1,
  epochMs: number,
  timeZone: string
): ScheduleOccurrence | null {
  if (rule.status !== "enabled") {
    return null;
  }

  const activeFrom = instantDate(rule.activeFrom, timeZone);
  const activeUntil = instantDate(rule.activeUntil, timeZone);
  const firstDate = laterDate(epochDate(epochMs, timeZone), activeFrom);
  for (const occurrence of iterateScheduleOccurrences(rule, firstDate, activeUntil, timeZone)) {
    if (occurrence.startsAtEpochMs > epochMs) {
      return occurrence;
    }
  }
  return null;
}

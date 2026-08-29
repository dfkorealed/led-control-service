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

function occursOnDate(rule: LightingScheduleSnapshotV1, date: Temporal.PlainDate, activeFrom: Temporal.PlainDate): boolean {
  switch (rule.recurrence.kind) {
    case "once":
      return date.equals(activeFrom);
    case "daily":
      return true;
    case "weekly":
      return rule.recurrence.weeklyDays.includes(date.dayOfWeek);
    case "monthly":
      return rule.recurrence.monthlyDay !== null
        && rule.recurrence.monthlyDay <= date.daysInMonth
        && date.day === rule.recurrence.monthlyDay;
    case "yearly":
      return rule.recurrence.yearlyMonth !== null
        && rule.recurrence.yearlyDay !== null
        && date.month === rule.recurrence.yearlyMonth
        && rule.recurrence.yearlyDay <= date.daysInMonth
        && date.day === rule.recurrence.yearlyDay;
  }
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

function occurrencesBetweenDates(
  rule: LightingScheduleSnapshotV1,
  firstDate: Temporal.PlainDate,
  lastDate: Temporal.PlainDate,
  timeZone: string
): ScheduleOccurrence[] {
  if (rule.status !== "enabled" || Temporal.PlainDate.compare(firstDate, lastDate) > 0) {
    return [];
  }

  const activeFrom = instantDate(rule.activeFrom, timeZone);
  const activeUntil = instantDate(rule.activeUntil, timeZone);
  const start = laterDate(firstDate, activeFrom);
  const end = earlierDate(lastDate, activeUntil);
  const occurrences: ScheduleOccurrence[] = [];

  for (let date = start; Temporal.PlainDate.compare(date, end) <= 0; date = date.add({ days: 1 })) {
    if (!occursOnDate(rule, date, activeFrom)) {
      continue;
    }

    const occurrence = occurrenceOnDate(rule, date, timeZone);
    if (occurrence !== null) {
      occurrences.push(occurrence);
    }
  }

  return occurrences;
}

export function getOccurrences(
  rule: LightingScheduleSnapshotV1,
  range: OccurrenceRange,
  timeZone: string
): ScheduleOccurrence[] {
  if (range.endsAtEpochMs <= range.startsAtEpochMs) {
    return [];
  }

  const firstDate = epochDate(range.startsAtEpochMs, timeZone).subtract({ days: 2 });
  const lastDate = epochDate(range.endsAtEpochMs, timeZone).add({ days: 1 });

  return occurrencesBetweenDates(rule, firstDate, lastDate, timeZone).filter((occurrence) => (
    occurrence.startsAtEpochMs < range.endsAtEpochMs
    && range.startsAtEpochMs < occurrence.endsAtEpochMs
  ));
}

export function getActiveOccurrence(
  rule: LightingScheduleSnapshotV1,
  epochMs: number,
  timeZone: string
): ScheduleOccurrence | null {
  const localDate = epochDate(epochMs, timeZone);
  const occurrences = occurrencesBetweenDates(rule, localDate.subtract({ days: 2 }), localDate, timeZone);

  return occurrences.find((occurrence) => (
    occurrence.startsAtEpochMs <= epochMs && epochMs < occurrence.endsAtEpochMs
  )) ?? null;
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
  const occurrences = occurrencesBetweenDates(rule, firstDate, activeUntil, timeZone);

  return occurrences.find((occurrence) => occurrence.startsAtEpochMs > epochMs) ?? null;
}

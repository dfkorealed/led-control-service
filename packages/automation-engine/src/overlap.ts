import { Temporal } from "@js-temporal/polyfill";
import type { LightingScheduleSnapshotV1 } from "@led-control/shared";
import { getOccurrences, type ScheduleOccurrence } from "./recurrence";

function activeDate(instant: string, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDate();
}

function laterDate(left: Temporal.PlainDate, right: Temporal.PlainDate): Temporal.PlainDate {
  return Temporal.PlainDate.compare(left, right) >= 0 ? left : right;
}

function earlierDate(left: Temporal.PlainDate, right: Temporal.PlainDate): Temporal.PlainDate {
  return Temporal.PlainDate.compare(left, right) <= 0 ? left : right;
}

function startsAtEpochMs(date: Temporal.PlainDate, timeZone: string): number {
  return date
    .toPlainDateTime(Temporal.PlainTime.from("00:00"))
    .toZonedDateTime(timeZone, { disambiguation: "compatible" })
    .epochMilliseconds;
}

function hasCommonFixture(left: LightingScheduleSnapshotV1, right: LightingScheduleSnapshotV1): boolean {
  const leftFixtures = new Set(left.fixtureIds);
  return right.fixtureIds.some((fixtureId) => leftFixtures.has(fixtureId));
}

function intervalsOverlap(left: ScheduleOccurrence[], right: ScheduleOccurrence[]): boolean {
  const leftSorted = [...left].sort((a, b) => a.startsAtEpochMs - b.startsAtEpochMs);
  const rightSorted = [...right].sort((a, b) => a.startsAtEpochMs - b.startsAtEpochMs);
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftSorted.length && rightIndex < rightSorted.length) {
    const leftOccurrence = leftSorted[leftIndex];
    const rightOccurrence = rightSorted[rightIndex];

    if (
      leftOccurrence.startsAtEpochMs < rightOccurrence.endsAtEpochMs
      && rightOccurrence.startsAtEpochMs < leftOccurrence.endsAtEpochMs
    ) {
      return true;
    }

    if (leftOccurrence.endsAtEpochMs <= rightOccurrence.endsAtEpochMs) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }

  return false;
}

export function schedulesOverlap(
  left: LightingScheduleSnapshotV1,
  right: LightingScheduleSnapshotV1,
  timeZone: string
): boolean {
  if (left.status !== "enabled" || right.status !== "enabled" || !hasCommonFixture(left, right)) {
    return false;
  }

  const leftFrom = activeDate(left.activeFrom, timeZone);
  const leftUntil = activeDate(left.activeUntil, timeZone);
  const rightFrom = activeDate(right.activeFrom, timeZone);
  const rightUntil = activeDate(right.activeUntil, timeZone);

  // A local interval can end only on its start date or the following date.
  // Expanding by one day preserves overlaps between adjacent active ranges.
  const comparisonStart = laterDate(leftFrom, rightFrom).subtract({ days: 1 });
  const comparisonEnd = earlierDate(leftUntil, rightUntil).add({ days: 1 });
  if (Temporal.PlainDate.compare(comparisonStart, comparisonEnd) > 0) {
    return false;
  }

  const needsGregorianCycle = [left.recurrence.kind, right.recurrence.kind]
    .some((kind) => kind === "monthly" || kind === "yearly");
  const periodicEnd = needsGregorianCycle
    ? comparisonStart.add({ years: 400 })
    : comparisonStart.add({ months: 14 });
  const horizonEnd = earlierDate(comparisonEnd, periodicEnd);
  const range = {
    startsAtEpochMs: startsAtEpochMs(comparisonStart, timeZone),
    endsAtEpochMs: startsAtEpochMs(horizonEnd.add({ days: 2 }), timeZone)
  };

  return intervalsOverlap(
    getOccurrences(left, range, timeZone),
    getOccurrences(right, range, timeZone)
  );
}
